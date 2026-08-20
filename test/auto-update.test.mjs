import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the companion store BEFORE importing auto-update: createAutoUpdater
// resolves its default updateStatePath from storeDir() at call time, and the
// updater now PERSISTS failed-attempt state there (so the retry backoff survives
// the daemon restarts a failing update causes). Without this, running the unit
// suite would write real failure records into the developer's own
// ~/.relay-companion and back off their machine's genuine updates.
process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auto-update-test-"));
// Same hermeticity for the release channel: fetchLatestVersion's default channel
// comes from ~/.relay/config.json, and a developer machine opted into the dev
// channel must not change what this suite exercises.
process.env.RELAY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auto-update-config-"));
delete process.env.RELAY_UPDATE_CHANNEL;

const {
  parseVersion,
  isNewerVersion,
  latestFromRegistryDoc,
  distTagForChannel,
  isManagedInstall,
  managedInstallInfo,
  autoUpdateEnabled,
  fetchLatestVersion,
  versionFromSignedRuntimeManifest,
  createAutoUpdater,
  DEFAULT_RESTART_COOLDOWN_MS,
  CANONICAL_TRANSACTION_IN_FLIGHT_MS,
  readUpdateFailure,
  recordUpdateFailure,
  updateRetryCooldownMs,
} = await import("../src/auto-update.js");
const autoUpdateModule = await import("../src/auto-update.js");
const { startAutoUpdateLoop } = await import("../src/task-daemon.js");
const currentVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const releaseTrust = JSON.parse(fs.readFileSync(new URL("../src/release-trust.json", import.meta.url), "utf8"));
const hasReleaseTrust = Array.isArray(releaseTrust.keys) && releaseTrust.keys.length > 0;
const currentParts = parseVersion(currentVersion);
if (!currentParts) throw new Error(`test package version is not exact: ${currentVersion}`);
const newerVersion = (offset) => `${currentParts[0]}.${currentParts[1]}.${currentParts[2] + offset}`;

const MANAGED_ROOT = "/opt/homebrew/lib/node_modules/relay-companion";
const DEV_ROOT = "/Users/dev/src/relay/packages/companion";
const WIN_GLOBAL_ROOT = "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\relay-companion";
const WIN_GLOBAL_PREFIX = "C:\\Users\\x\\AppData\\Roaming\\npm";
const WIN_LOCAL_ROOT = "C:\\Users\\x\\.relay\\lib\\node_modules\\relay-companion";

test("parseVersion accepts x.y.z (with optional v / suffix), rejects junk", () => {
  assert.deepEqual(parseVersion("0.1.21"), [0, 1, 21]);
  assert.deepEqual(parseVersion("v2.3.4"), [2, 3, 4]);
  assert.deepEqual(parseVersion("1.2.3-beta.1"), [1, 2, 3]);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(null), null);
});

test("isNewerVersion compares numerically per component and is conservative on junk", () => {
  assert.equal(isNewerVersion("0.1.21", "0.1.20"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.99"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true); // numeric, not lexical
  assert.equal(isNewerVersion("0.1.20", "0.1.20"), false);
  assert.equal(isNewerVersion("0.1.19", "0.1.20"), false);
  // Downgrades across the minor/major component must NOT trigger an update.
  assert.equal(isNewerVersion("0.1.20", "0.2.0"), false);
  assert.equal(isNewerVersion("1.9.9", "2.0.0"), false);
  // A prerelease is not newer than the release it precedes (both parse to [1,2,3]).
  assert.equal(isNewerVersion("1.2.3-beta.1", "1.2.3"), false);
  assert.equal(isNewerVersion("garbage", "0.1.20"), false);
  assert.equal(isNewerVersion("0.1.21", "garbage"), false);
  assert.equal(isNewerVersion(null, "0.1.20"), false);
});

test("latestFromRegistryDoc reads dist-tags.latest, else null", () => {
  assert.equal(latestFromRegistryDoc({ "dist-tags": { latest: "0.1.21" } }), "0.1.21");
  assert.equal(latestFromRegistryDoc({ latest: "0.1.22" }), "0.1.22");
  assert.equal(latestFromRegistryDoc({ "dist-tags": {} }), null);
  assert.equal(latestFromRegistryDoc({}), null);
  assert.equal(latestFromRegistryDoc(null), null);
});

test("distTagForChannel maps channels to dist-tags, defaulting unknowns to stable", () => {
  assert.equal(distTagForChannel("stable"), "latest");
  assert.equal(distTagForChannel("dev"), "dev");
  assert.equal(distTagForChannel("DEV "), "dev");
  assert.equal(distTagForChannel("staging"), "staging");
  assert.equal(distTagForChannel(" STAGING "), "staging");
  assert.equal(distTagForChannel("beta"), "latest");
  assert.equal(distTagForChannel(undefined), "latest");
});

test("latestFromRegistryDoc (dev channel) reads the dev tag, falling back to latest", () => {
  const doc = { latest: "0.1.183", dev: "0.1.184" };
  assert.equal(latestFromRegistryDoc(doc, "dev"), "0.1.184");
  assert.equal(latestFromRegistryDoc(doc, "stable"), "0.1.183");
  // No dev tag published yet (channel's first rollout): dev machines must not
  // freeze — they follow latest until a dev build exists.
  assert.equal(latestFromRegistryDoc({ latest: "0.1.183" }, "dev"), "0.1.183");
  assert.equal(latestFromRegistryDoc({ "dist-tags": { latest: "0.1.183", dev: "0.1.185" } }, "dev"), "0.1.185");
  assert.equal(latestFromRegistryDoc({}, "dev"), null);
});

test("latestFromRegistryDoc (staging channel) reads staging, falling back safely to latest", () => {
  const doc = { latest: "0.1.183", dev: "0.1.184", staging: "0.1.182" };
  assert.equal(latestFromRegistryDoc(doc, "staging"), "0.1.182");
  assert.equal(latestFromRegistryDoc({ latest: "0.1.183" }, "staging"), "0.1.183");
  assert.equal(latestFromRegistryDoc({ "dist-tags": { latest: "0.1.183", staging: "0.1.186" } }, "staging"), "0.1.186");
});

test("isManagedInstall is true only for a global node_modules install", () => {
  assert.equal(isManagedInstall(MANAGED_ROOT), true);
  assert.equal(isManagedInstall("/Users/x/.npm-global/lib/node_modules/relay-companion"), true);
  assert.equal(isManagedInstall(DEV_ROOT), false);
  assert.equal(isManagedInstall(""), false);
});

test("managedInstallInfo derives the owning prefix for global and Relay-local installs", () => {
  // Explicit platform, like the win32 case below: these are POSIX layouts, and the
  // Windows gate has to be able to assert them too.
  const posix = { platform: "darwin" };
  assert.deepEqual(managedInstallInfo(MANAGED_ROOT, posix), {
    packageRoot: MANAGED_ROOT,
    prefix: "/opt/homebrew",
    global: true,
  });
  assert.deepEqual(managedInstallInfo("/Users/x/.relay/lib/node_modules/relay-companion", { ...posix, home: "/Users/x" }), {
    packageRoot: "/Users/x/.relay/lib/node_modules/relay-companion",
    prefix: "/Users/x/.relay/lib",
    global: false,
  });
  assert.equal(
    managedInstallInfo("/Users/x/project/node_modules/relay-companion", { ...posix, home: "/Users/x" }),
    null,
    "the updater must not take ownership of an arbitrary project's hoisted dependencies",
  );
  assert.equal(managedInstallInfo(DEV_ROOT, posix), null);
});

test("managedInstallInfo (win32) adopts a global prefix only when npm's bin shims prove ownership", () => {
  const probed = [];
  const withShims = managedInstallInfo(WIN_GLOBAL_ROOT, {
    platform: "win32",
    exists: (p) => {
      probed.push(p);
      return true;
    },
  });
  assert.deepEqual(withShims, { packageRoot: WIN_GLOBAL_ROOT, prefix: WIN_GLOBAL_PREFIX, global: true });
  assert.ok(
    probed.some((p) => p.toLowerCase() === `${WIN_GLOBAL_PREFIX}\\relay.cmd`.toLowerCase()),
    `probes the prefix for npm's relay.cmd shim: ${probed.join(", ")}`,
  );
  // A project checkout has the exact same <dir>\node_modules\<pkg> shape but no
  // prefix-level shims — it is not a safe rollback unit and must be refused.
  assert.equal(
    managedInstallInfo("C:\\src\\someapp\\node_modules\\relay-companion", { platform: "win32", exists: () => false }),
    null,
  );
  assert.equal(managedInstallInfo("C:\\src\\relay\\packages\\companion", { platform: "win32", exists: () => true }), null);
});

test("managedInstallInfo (win32) recognizes Relay's no-sudo local prefix without any fs probe", () => {
  assert.deepEqual(managedInstallInfo(WIN_LOCAL_ROOT, { platform: "win32", exists: () => false }), {
    packageRoot: WIN_LOCAL_ROOT,
    prefix: "C:\\Users\\x\\.relay\\lib",
    global: false,
  });
});

test("autoUpdateEnabled defaults on, honors explicit off switches", () => {
  assert.equal(autoUpdateEnabled({}), true);
  assert.equal(autoUpdateEnabled({ RELAY_AUTO_UPDATE: "1" }), true);
  assert.equal(autoUpdateEnabled({ RELAY_AUTO_UPDATE: "0" }), false);
  assert.equal(autoUpdateEnabled({ RELAY_AUTO_UPDATE: "false" }), false);
  assert.equal(autoUpdateEnabled({ RELAY_AUTO_UPDATE: "off" }), false);
  assert.equal(autoUpdateEnabled({ RELAY_AUTO_UPDATE: "no" }), false);
});

test("fetchLatestVersion cache-busts the targeted dist-tags request", async () => {
  let request = null;
  const candidate = newerVersion(1);
  const ok = await fetchLatestVersion({
    now: () => 12345,
    channel: "dev",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ dev: candidate }) };
    },
  });
  assert.equal(ok, candidate);
  assert.match(request.url, /\/-\/package\/relay-companion\/dist-tags\?relay_update=12345$/);
  assert.equal(request.options.cache, "no-store");
  assert.match(request.options.headers["Cache-Control"], /no-cache/);
});

test("fetchLatestVersion follows the requested channel's dist-tag", async () => {
  const doc = { latest: newerVersion(1), staging: newerVersion(2), dev: newerVersion(3) };
  const fetchImpl = async () => ({ ok: true, json: async () => doc });
  assert.equal(await fetchLatestVersion({ fetchImpl, channel: "dev" }), doc.dev);
  assert.equal(await fetchLatestVersion({ fetchImpl, channel: "staging" }), doc.staging);
  const stableExpected = hasReleaseTrust ? null : doc.latest;
  assert.equal(await fetchLatestVersion({ fetchImpl, channel: "stable", publicKeyPem: "" }), stableExpected);
  // Default channel resolves from config; this suite's isolated config dir has
  // no channel set, so it must behave as stable.
  assert.equal(await fetchLatestVersion({ fetchImpl, publicKeyPem: "" }), stableExpected);
});

test("fetchLatestVersion returns null on non-ok / throw / no-fetch", async () => {

  const notOk = await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(notOk, null);

  const threw = await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(threw, null);

  assert.equal(await fetchLatestVersion({ fetchImpl: null }), null);
});

test("stable bridge follows only a correctly signed branded runtime manifest", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({ product: "Relay", version: "0.1.999", artifacts: {} }));
  const envelope = {
    schema: 1,
    algorithm: "ED25519_SHA_512",
    keyId: "relay-runtime-release-v2",
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, privateKey).toString("base64"),
  };
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  assert.equal(versionFromSignedRuntimeManifest(envelope, publicKeyPem), "0.1.999");
  assert.equal(versionFromSignedRuntimeManifest({ ...envelope, signature: Buffer.alloc(64).toString("base64") }, publicKeyPem), null);
  let requested = "";
  const version = await fetchLatestVersion({
    channel: "stable",
    publicKeyPem,
    now: () => 42,
    fetchImpl: async (url) => { requested = url; return { ok: true, json: async () => envelope }; },
  });
  assert.equal(version, "0.1.999");
  assert.match(requested, /^https:\/\/api\.sendrelays\.com\/v1\/companion-releases\/stable\/manifest\.json\?relay_update=42$/);
});

test("daemon updater loop checks immediately and independently of task polling/startup", async () => {
  let ticks = 0;
  let scheduled = null;
  let cleared = null;
  let unrefed = false;
  const logs = [];
  const timer = { unref: () => { unrefed = true; } };
  const loop = startAutoUpdateLoop({
    autoUpdater: {
      async tick() {
        ticks += 1;
        return ticks === 1
          ? { status: "up-to-date", current: "0.1.40", latest: "0.1.40" }
          : { status: "updating", current: "0.1.40", latest: "0.1.41" };
      },
    },
    intervalMs: 5000,
    log: (line) => logs.push(line),
    setIntervalImpl: (fn, ms) => {
      assert.equal(ms, 5000);
      scheduled = fn;
      return timer;
    },
    clearIntervalImpl: (value) => { cleared = value; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1, "checks before API startup finishes");
  assert.equal(unrefed, true);
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 2);
  assert.match(logs[0], /self-update launched \(0\.1\.40 -> 0\.1\.41\)/);
  loop.stop();
  assert.equal(cleared, timer);
});

// ---- 0.1.77: fleet-restart politeness (cooldown) --------------------------

import { readUpdateState, recordBootVersion } from "../src/auto-update.js";
import fsCooldown from "node:fs";
import osCooldown from "node:os";
import pathCooldown from "node:path";

function cooldownStatePath() {
  const dir = fsCooldown.mkdtempSync(pathCooldown.join(osCooldown.tmpdir(), "relay-update-state-"));
  return pathCooldown.join(dir, "update-state.json");
}

function freshMigrationStatePath() {
  return cooldownStatePath();
}

test("recordBootVersion: first sighting is not 'an update just landed'; a version change is", () => {
  const file = cooldownStatePath();
  const t0 = 5_000_000;
  assert.equal(recordBootVersion(file, "0.1.20", { now: () => t0 }), 0, "fresh install never delays its first update");
  assert.equal(readUpdateState(file).version, "0.1.20");
  assert.equal(recordBootVersion(file, "0.1.20", { now: () => t0 + 1000 }), 0, "same-version reboot keeps the old stamp");
  const landed = recordBootVersion(file, "0.1.21", { now: () => t0 + 2000 });
  assert.equal(landed, t0 + 2000, "a version change stamps 'update landed now'");
  assert.equal(readUpdateState(file).version, "0.1.21");
});

test("updateRetryCooldownMs backs off exponentially and is capped", () => {
  assert.equal(updateRetryCooldownMs(0, { baseMs: 100, maxMs: 1600 }), 100, "no failures keeps the base cadence");
  assert.equal(updateRetryCooldownMs(1, { baseMs: 100, maxMs: 1600 }), 100, "the first retry stays prompt");
  assert.equal(updateRetryCooldownMs(2, { baseMs: 100, maxMs: 1600 }), 200);
  assert.equal(updateRetryCooldownMs(3, { baseMs: 100, maxMs: 1600 }), 400);
  assert.equal(updateRetryCooldownMs(99, { baseMs: 100, maxMs: 1600 }), 1600, "capped, never unbounded");
});

test("canonical updater migrates the exact running version before checking the registry", async () => {
  const launched = [];
  let registryCalls = 0;
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: "/opt/homebrew/lib/node_modules/relay-companion",
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => null,
    getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => { registryCalls += 1; return "0.1.241"; },
    spawnUpdate: (options) => launched.push(options),
    now: () => 100,
    restartCooldownMs: 0,
    updateStatePath: freshMigrationStatePath(),
  });
  const result = await updater.tick();
  assert.equal(result.status, "migrating-runtime");
  assert.equal(registryCalls, 0);
  assert.equal(launched[0].targetVersion, "0.1.240");
  assert.equal(launched[0].canonicalMigration, true);
});

test("a rejected canonical spawn is never reported as updating or persisted as an attempt", async () => {
  const canonicalRoot = "/Users/test/.relay/runtime/releases/current/node_modules/relay-companion";
  const statePath = freshMigrationStatePath();
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: canonicalRoot,
    getCurrentVersion: () => "0.1.286",
    getCanonicalRuntime: () => ({ version: "0.1.286", packageRoot: canonicalRoot }),
    getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => "0.1.287",
    spawnUpdate: () => null,
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: { pid: 123 } }),
    restartCooldownMs: 0,
    updateStatePath: statePath,
  });
  const result = await updater.tick();
  assert.equal(result.status, "worker-not-admitted");
  assert.equal(readUpdateFailure(statePath), null, "submission without lock ownership is not an attempt");
});

test("a newer global install rescues an older canonical runtime through the canonical transaction", async () => {
  const launched = [];
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: MANAGED_ROOT,
    getCurrentVersion: () => "0.1.287",
    getCanonicalRuntime: () => ({
      version: "0.1.284",
      packageRoot: "/Users/test/.relay/runtime/releases/old/node_modules/relay-companion",
    }),
    getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => assert.fail("rescue precedes registry work"),
    spawnUpdate: (options) => { launched.push(options); return { status: "admitted", requestPath: "/tmp/request" }; },
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: null }),
    restartCooldownMs: 0,
    updateStatePath: freshMigrationStatePath(),
  });
  const result = await updater.tick();
  assert.equal(result.status, "rescuing-runtime");
  assert.equal(launched[0].targetVersion, "0.1.287");
  assert.equal(launched[0].canonicalRescue, true);
});

test("global reconciliation is monotonic: older never replaces canonical, equal repairs only when explicit and unhealthy", async () => {
  const canonical = {
    version: "0.1.287",
    packageRoot: "/Users/test/.relay/runtime/releases/current/node_modules/relay-companion",
  };
  const older = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: MANAGED_ROOT,
    getCurrentVersion: () => "0.1.286",
    getCanonicalRuntime: () => canonical,
    getCanonicalRuntimeState: () => canonical,
    spawnUpdate: () => assert.fail("an older global tree must never launch"),
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: null }),
    // This tree is NOT what autostart names, so it really is a leftover. Injected
    // rather than left to default, which would read the host's real launchd plist
    // and make the assertion depend on the machine running the suite.
    readAutostart: () => ({ root: "/Users/test/.relay/runtime/releases/current/node_modules/relay-companion", source: "test" }),
  });
  assert.equal((await older.tick()).status, "stale-process");

  const launched = [];
  const equalRepair = createAutoUpdater({
    useCanonicalRuntime: true,
    explicitRepair: true,
    platform: "darwin",
    packageRoot: canonical.packageRoot,
    getCurrentVersion: () => canonical.version,
    getCanonicalRuntime: () => canonical,
    getCanonicalRuntimeState: () => canonical,
    getCanonicalRuntimeHealth: () => ({ ok: false, daemon: false, pill: true }),
    spawnUpdate: (options) => { launched.push(options); return { status: "admitted", requestPath: "/tmp/request" }; },
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: null }),
    restartCooldownMs: 0,
  });
  assert.equal((await equalRepair.tick()).status, "repairing-runtime");
  assert.equal(launched[0].targetVersion, canonical.version);
  assert.equal(launched[0].canonicalRepair, true);
});

test("an up-to-date canonical daemon still removes every legacy updater label", async () => {
  const canonicalRoot = "/Users/test/.relay/runtime/releases/current/node_modules/relay-companion";
  let reconciliations = 0;
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: canonicalRoot,
    getCurrentVersion: () => "0.1.287",
    getCanonicalRuntime: () => ({ version: "0.1.287", packageRoot: canonicalRoot }),
    getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => "0.1.287",
    reconcileCanonicalWorkers: () => { reconciliations += 1; return { removedLegacy: 20, fixed: null }; },
    restartCooldownMs: 0,
  });
  assert.equal((await updater.tick()).status, "up-to-date");
  assert.equal(reconciliations, 1);
});

test("fresh daemon launches bounded journal recovery before migration or registry work", async () => {
  const launched = [];
  const journal = {
    schema: 1,
    state: "activating",
    active: false,
    preparedAt: 100,
    candidate: { version: "0.1.241", packageRoot: "/Users/test/.relay/runtime/releases/candidate/node_modules/relay-companion" },
    previous: { kind: "legacy", packageRoot: "/opt/homebrew/lib/node_modules/relay-companion" },
  };
  let now = 100;
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: "/opt/homebrew/lib/node_modules/relay-companion",
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => null,
    getCanonicalRuntimeState: () => journal,
    getLatestVersion: async () => assert.fail("registry must wait for recovery"),
    spawnUpdate: (options) => launched.push(options),
    now: () => now,
    retryCooldownMs: 1_000,
    restartCooldownMs: 0,
  });
  assert.equal((await updater.tick()).status, "activation-in-flight");
  assert.equal(launched.length, 0, "normal activation receives the full grace period");
  now = 1_101;
  assert.equal((await updater.tick()).status, "recovering-runtime");
  assert.equal(launched[0].canonicalRecovery, true);
  assert.equal(launched[0].targetVersion, "0.1.241");
  now = 1_200;
  assert.equal((await updater.tick()).status, "recovery-in-flight");
  assert.equal(launched.length, 1);
});

test("slow canonical staging never launches a duplicate worker inside its full transaction horizon", async () => {
  const launched = [];
  let now = 10;
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: "/opt/homebrew/lib/node_modules/relay-companion",
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => null,
    getCanonicalRuntimeState: () => null,
    spawnUpdate: (options) => launched.push(options),
    now: () => now,
    restartCooldownMs: 0,
    updateStatePath: freshMigrationStatePath(),
  });
  assert.equal((await updater.tick()).status, "migrating-runtime");
  now += CANONICAL_TRANSACTION_IN_FLIGHT_MS - 1;
  assert.equal((await updater.tick()).status, "migration-in-flight");
  assert.equal(launched.length, 1);
});

import { readMigrationFailure } from "../src/auto-update.js";

// ---- the canonical migration must back off across daemon restarts -----------
// Launching a migration quiesces and exits the daemon, launchd restarts it, and the
// in-memory `state.updating` guard comes back empty — so a migration that never
// lands retried every few seconds forever. David's Mac: 35,440 failed installs and
// 11,015 leaked lock directories in a day, pinned at 0.1.265 while the fleet moved.
function migrationUpdater({ statePath, launched, now, canonical = null, packageRoot = "/opt/homebrew/lib/node_modules/relay-companion" }) {
  return createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot,
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => canonical,
    getCanonicalRuntimeState: () => canonical,
    spawnUpdate: (options) => launched.push(options),
    now,
    retryCooldownMs: 1_000,
    restartCooldownMs: 0,
    updateStatePath: statePath,
    log: () => {},
  });
}

test("a migration that never lands backs off across the daemon restart it causes", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-migration-")), "update-state.json");
  const launched = [];
  let clock = 10;

  // the daemon that launches the migration, then exits
  assert.equal((await migrationUpdater({ statePath, launched, now: () => clock }).tick()).status, "migrating-runtime");
  assert.equal(launched.length, 1);

  // launchd brings it back with empty in-memory state, still not canonical
  clock += 50;
  const relaunched = await migrationUpdater({ statePath, launched, now: () => clock }).tick();
  assert.equal(relaunched.status, "deferred-migration-backoff", "the record on disk is what survives the restart");
  assert.equal(relaunched.failures, 1);
  assert.equal(launched.length, 1, "no second worker inside the backoff");

  // once the cooldown elapses it genuinely retries, and the count compounds
  clock += 1_000;
  assert.equal((await migrationUpdater({ statePath, launched, now: () => clock }).tick()).status, "migrating-runtime");
  assert.equal(launched.length, 2);
  clock += 1_000;
  const third = await migrationUpdater({ statePath, launched, now: () => clock }).tick();
  assert.equal(third.status, "deferred-migration-backoff");
  assert.equal(third.failures, 2, "the second failure waits twice as long");
  assert.equal(launched.length, 2);
});

test("booting from the canonical runtime clears the migration backoff record", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-migration-")), "update-state.json");
  const launched = [];
  let clock = 10;
  await migrationUpdater({ statePath, launched, now: () => clock }).tick();
  assert.ok(readMigrationFailure(statePath), "an attempt was recorded");

  // the migration landed: this daemon now runs from a canonical release
  const releaseRoot = path.join(os.homedir(), ".relay", "runtime", "releases", "r1");
  const packageRoot = path.join(releaseRoot, "node_modules", "relay-companion");
  const canonical = {
    schema: 1, active: true, version: "0.1.240", releaseId: "r1",
    releaseRoot, packageRoot, bin: path.join(packageRoot, "bin", "relay.js"), node: process.execPath, committedAt: 1,
  };
  clock += 10;
  await migrationUpdater({ statePath, launched, now: () => clock, canonical, packageRoot }).tick();
  assert.equal(readMigrationFailure(statePath), null, "success drops the record instead of backing off forever");
});

// ---- recovery and migration must not reset each other's backoff -------------
// Both paths quiesce the daemon and both wrote to ONE durable slot, but each
// carries its own target — and a record whose target changed reads as a fresh
// attempt, count 1. So every time the two alternated they cleared each other:
// the count never left the base cooldown, the exponential ceiling was never
// reached, and a Mac whose activation could not succeed retried for 17.5 hours
// (104 activations, 100 of them the same launchd EIO, 22 GB of leaked release
// trees) with the stored count still reading 3.
function alternatingUpdater({ statePath, launched, now, recovering }) {
  const canonicalState = recovering
    ? { state: "recovery-required", candidate: { version: "0.1.240" } }
    : null;
  return createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: "/opt/homebrew/lib/node_modules/relay-companion",
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => null,
    getCanonicalRuntimeState: () => canonicalState,
    spawnUpdate: (options) => launched.push(options),
    now,
    retryCooldownMs: 1_000,
    restartCooldownMs: 0,
    updateStatePath: statePath,
    log: () => {},
  });
}

test("an alternating recovery does not reset the migration backoff", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-alternating-")), "update-state.json");
  const launched = [];
  let clock = 10;

  const recovery = await alternatingUpdater({ statePath, launched, now: () => clock, recovering: true }).tick();
  assert.equal(recovery.status, "recovering-runtime");
  assert.equal(launched.length, 1);

  // the recovery dies at activation; launchd restarts the daemon and this time the
  // journal is gone, so the SAME failure now presents as a migration
  clock += 10;
  const migration = await alternatingUpdater({ statePath, launched, now: () => clock, recovering: false }).tick();
  assert.equal(migration.status, "migrating-runtime");
  assert.equal(launched.length, 2);

  // back to recovery, still inside its cooldown: the migration write must not have
  // erased the recovery record. Sharing a slot is what let this launch a third worker.
  clock += 10;
  const again = await alternatingUpdater({ statePath, launched, now: () => clock, recovering: true }).tick();
  assert.equal(again.status, "deferred-recovery-backoff", "recovery keeps its own record");
  assert.equal(again.failures, 1);
  assert.equal(launched.length, 2, "no third worker: alternating cannot reset either backoff");

  // and each path compounds independently rather than restarting at the base wait
  clock += 1_000;
  assert.equal((await alternatingUpdater({ statePath, launched, now: () => clock, recovering: true }).tick()).status, "recovering-runtime");
  clock += 10;
  const compounded = await alternatingUpdater({ statePath, launched, now: () => clock, recovering: true }).tick();
  assert.equal(compounded.status, "deferred-recovery-backoff");
  assert.equal(compounded.failures, 2, "the second recovery failure waits twice as long");
});

test("booting canonical clears the recovery record too", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-alternating-")), "update-state.json");
  const launched = [];
  const clock = 10;
  await alternatingUpdater({ statePath, launched, now: () => clock, recovering: true }).tick();
  assert.ok(readMigrationFailure(statePath, { slot: "recoveryFailure" }), "a recovery attempt was recorded");

  const releaseRoot = path.join(os.homedir(), ".relay", "runtime", "releases", "r1");
  const packageRoot = path.join(releaseRoot, "node_modules", "relay-companion");
  const canonical = {
    schema: 1, active: true, version: "0.1.240", releaseId: "r1",
    releaseRoot, packageRoot, bin: path.join(packageRoot, "bin", "relay.js"), node: process.execPath, committedAt: 1,
  };
  await migrationUpdater({ statePath, launched, now: () => clock + 10, canonical, packageRoot }).tick();
  assert.equal(readMigrationFailure(statePath, { slot: "recoveryFailure" }), null, "recovery exists only to reach canonical, which just happened");
});

// A canonical update that fails at ACTIVATION rolls back by restarting the daemon,
// so the process that could count the failure afterwards is dead by the time there
// is a failure to count. The fresh daemon then re-checked the registry immediately
// and relaunched: Sven's Mac, 2026-08-18 13:42→13:47, a new ~650MB attempt every
// ~15 seconds. The record is therefore written BEFORE the launch, honoured by the
// rolled-back boot, and retired by the boot that proves the update landed.
test("an update launch is recorded durably; the rolled-back boot defers, the landed boot clears", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-prerecord-")), "update-state.json");
  const packageRoot = path.join(os.homedir(), ".relay", "runtime", "releases", "r9", "node_modules", "relay-companion");
  const launched = [];
  let clock = 1_000_000;
  const build = ({ runningVersion }) => createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot,
    getCurrentVersion: () => runningVersion,
    getCanonicalRuntime: () => ({ packageRoot, version: runningVersion }),
    getCanonicalRuntimeState: () => null,
    getLatestVersion: async () => "0.1.241",
    spawnUpdate: (options) => launched.push(options),
    now: () => clock,
    checkIntervalMs: 0,
    retryCooldownMs: 1_000,
    restartCooldownMs: 0,
    updateStatePath: statePath,
  });

  assert.equal((await build({ runningVersion: "0.1.240" }).tick()).status, "updating");
  assert.equal(launched.length, 1);
  const recorded = readUpdateFailure(statePath);
  assert.equal(recorded.target, "0.1.241", "the target is on disk before any outcome is known");
  assert.equal(recorded.count, 1);

  // Activation failed; rollback restarted the daemon on the OLD version. The new
  // process must inherit the attempt and back off instead of relaunching at once.
  clock += 500;
  const rolledBack = build({ runningVersion: "0.1.240" });
  assert.equal((await rolledBack.tick()).status, "deferred-backoff");
  assert.equal(launched.length, 1, "no hot relaunch loop after an activation failure");

  // Past the backoff window the retry happens — and compounds the record.
  clock += 1_000;
  assert.equal((await rolledBack.tick()).status, "updating");
  assert.equal(launched.length, 2);
  assert.equal(readUpdateFailure(statePath).count, 2);

  // The boot that runs the recorded target IS the success signal.
  clock += 10;
  build({ runningVersion: "0.1.241" });
  assert.equal(readUpdateFailure(statePath), null, "landing the target retires its record");
});

// The recovery in-flight guard was retryCooldownMs (2 minutes), which an npm
// install of a ~650MB Electron tree routinely exceeds — so a second recovery
// worker was spawned on top of a live one, each building its own release dir
// against the same lock. Recovery now gets the same transaction horizon as
// migration.
test("a live recovery worker is not duplicated inside the full transaction horizon", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-horizon-")), "update-state.json");
  const journal = {
    schema: 1,
    state: "activating",
    active: false,
    preparedAt: 100,
    candidate: { version: "0.1.241", packageRoot: "/u/.relay/runtime/releases/c/node_modules/relay-companion" },
    previous: null,
  };
  const launched = [];
  let clock = 100_000_000;
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: "/opt/homebrew/lib/node_modules/relay-companion",
    getCurrentVersion: () => "0.1.240",
    getCanonicalRuntime: () => null,
    getCanonicalRuntimeState: () => journal,
    getLatestVersion: async () => assert.fail("registry must wait for recovery"),
    spawnUpdate: (options) => launched.push(options),
    now: () => clock,
    retryCooldownMs: 1_000,
    restartCooldownMs: 0,
    updateStatePath: statePath,
  });
  assert.equal((await updater.tick()).status, "recovering-runtime");
  assert.equal(launched.length, 1);
  // Ten minutes in: far beyond the old two-minute window, well inside the horizon.
  clock += 10 * 60 * 1000;
  assert.equal((await updater.tick()).status, "recovery-in-flight");
  assert.equal(launched.length, 1, "one live worker, one release dir");
  // Only past the full horizon may a fresh worker be considered.
  clock += CANONICAL_TRANSACTION_IN_FLIGHT_MS;
  const after = await updater.tick();
  assert.notEqual(after.status, "recovery-in-flight");
});

test("readRecoveryFailure exposes the recovery slot for doctor without leaking slot names", () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-read-")), "update-state.json");
  assert.equal(autoUpdateModule.readRecoveryFailure(statePath), null);
  autoUpdateModule.recordMigrationFailure(statePath, "canonical-recovery:0.1.241", { slot: "recoveryFailure" });
  assert.equal(autoUpdateModule.readRecoveryFailure(statePath).target, "canonical-recovery:0.1.241");
  assert.equal(autoUpdateModule.clearUpdateFailure(statePath), false, "no plain update record to clear");
});

// `stale-process` means "some OTHER process is the machine's daemon; this one is a
// leftover and should just die." When the autostart registration names THIS tree,
// that premise is false: this process is the registered daemon, merely pointed at a
// stale release, and no other actor exists to start canonical. Returning the no-op
// there is what left the machine looping with no daemon that could ever recover.
test("a registered daemon on a stale tree repoints autostart instead of reporting a no-op", async () => {
  const canonical = {
    version: "0.1.320",
    packageRoot: "/Users/test/.relay/runtime/releases/0.1.320-b/node_modules/relay-companion",
    bin: "/Users/test/.relay/runtime/releases/0.1.320-b/node_modules/relay-companion/bin/relay.js",
    node: "/opt/homebrew/bin/node",
  };
  const repoints = [];
  const updater = createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: MANAGED_ROOT,
    getCurrentVersion: () => "0.1.318",
    getCanonicalRuntime: () => canonical,
    getCanonicalRuntimeState: () => canonical,
    spawnUpdate: () => assert.fail("a repoint must not go through the normal update path"),
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: null }),
    readAutostart: () => ({ root: MANAGED_ROOT, source: "work.relay.companion.plist" }),
    repointAutostart: (opts) => {
      repoints.push(opts);
      return true;
    },
    updateStatePath: freshMigrationStatePath(),
  });
  const result = await updater.tick();
  assert.equal(result.status, "repointing-autostart");
  assert.equal(result.onDisk, "0.1.320");
  assert.equal(repoints.length, 1);
  assert.equal(repoints[0].canonical.version, "0.1.320", "the repair must target canonical, not this tree");
});

test("a repoint that fails to launch backs off durably instead of hammering every tick", async () => {
  let clock = 5_000_000;
  const canonical = {
    version: "0.1.320",
    packageRoot: "/Users/test/.relay/runtime/releases/0.1.320-b/node_modules/relay-companion",
    bin: "/Users/test/.relay/runtime/releases/0.1.320-b/node_modules/relay-companion/bin/relay.js",
    node: "/opt/homebrew/bin/node",
  };
  let attempts = 0;
  const statePath = freshMigrationStatePath();
  const make = () => createAutoUpdater({
    useCanonicalRuntime: true,
    platform: "darwin",
    packageRoot: MANAGED_ROOT,
    now: () => clock,
    getCurrentVersion: () => "0.1.318",
    getCanonicalRuntime: () => canonical,
    getCanonicalRuntimeState: () => canonical,
    spawnUpdate: () => assert.fail("no normal update path here"),
    reconcileCanonicalWorkers: () => ({ removedLegacy: 0, fixed: null }),
    readAutostart: () => ({ root: MANAGED_ROOT, source: "work.relay.companion.plist" }),
    repointAutostart: () => {
      attempts += 1;
      return false;
    },
    retryCooldownMs: 120_000,
    updateStatePath: statePath,
  });

  assert.equal((await make().tick()).status, "autostart-repoint-failed");
  assert.equal(attempts, 1);

  // A fresh updater models the daemon being restarted by launchd: the in-memory
  // guard is empty, so only the durable record can hold the backoff.
  clock += 1000;
  const second = await make().tick();
  assert.equal(second.status, "deferred-autostart-repoint");
  assert.equal(attempts, 1, "the durable record must survive the restart that clears memory");

  clock += 200_000;
  assert.equal((await make().tick()).status, "autostart-repoint-failed");
  assert.equal(attempts, 2, "after the cooldown it tries again");
});
