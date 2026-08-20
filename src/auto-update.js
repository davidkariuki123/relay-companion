// Canonical signed-runtime update discovery and orchestration. Legacy installed
// clients use their already-shipped npm updater once to reach the migration
// bridge; every new bridge/runtime uses only the signed canonical transaction.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  UPDATE_CHANNEL_STABLE,
  UPDATE_CHANNEL_DEV,
  UPDATE_CHANNEL_STAGING,
  normalizeUpdateChannel,
  updateChannel,
} from "./config.js";
import { storeDir } from "./host-paths.js";
import { readAutostartDaemonRoot } from "./autostart-registration.js";
import {
  isCanonicalPackageRoot,
  readCanonicalRuntime,
  readCanonicalRuntimeState,
} from "./canonical-runtime.js";
import {
  exactRuntimeHealth,
  reconcileUpdateWorkerJobs,
  spawnCanonicalUpdate,
  waitForUpdateRequestTerminal,
} from "./canonical-updater.js";

export const PACKAGE_NAME = "relay-companion";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const STABLE_RUNTIME_MANIFEST = "https://api.sendrelays.com/v1/companion-releases/stable/manifest.json";
const releaseTrust = createRequire(import.meta.url)("./release-trust.json");
const { RELEASE_ALGORITHM, verifyReleaseEnvelope } = createRequire(import.meta.url)("../bootstrap/release-signature.cjs");
// A production publish should reach an idle machine promptly. The registry request is
// a tiny dist-tags document and the daemon is the only checker, so one minute gives us
// fast fleet convergence without meaningful registry load.
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_CHECK_FAILURE_RETRY_MS = 15 * 1000;
const MAX_CHECK_FAILURE_RETRY_MS = 5 * 60 * 1000;
// A normal npm + Electron install takes seconds. If this old daemon is still alive two
// minutes after launch, the detached install/restart did not finish successfully; retry.
const RETRY_COOLDOWN_MS = 2 * 60 * 1000;
// Candidate npm/Electron staging is allowed to run for 15 minutes. An old daemon
// remains alive throughout immutable staging, so its ordinary two-minute failed-
// update heuristic must not launch duplicate workers while the first is healthy.
export const CANONICAL_TRANSACTION_IN_FLIGHT_MS = 20 * 60 * 1000;
// ...but do not retry at that rate forever. A machine whose update can never complete
// (field report: Scheduled Tasks registered by hand under different names) used to
// re-download and re-install every two minutes indefinitely — ~2,679 attempts for a
// single version, three identical log lines each time, growing daemon.log to 40 MB.
// Back off exponentially from RETRY_COOLDOWN_MS up to this ceiling, so a permanently
// stuck machine still checks hourly (it self-heals the moment the cause is fixed)
// without burning bandwidth, disk, and battery in a hot loop.
const MAX_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
// Consecutive failed attempts at the SAME version before we stop treating this as a
// transient hiccup and start saying so where a human will actually see it.
export const UPDATE_FAILURE_ESCALATION_THRESHOLD = 3;
// Fleet-restart politeness: every update RESTARTS the pill in the user's face, and a
// publish spree (12 versions went out on 2026-08-05 alone) once restarted every user's
// pill every few minutes. The original one-hour cooldown over-corrected: a user could
// report a production bug, watch its fix publish, and remain on the broken build for
// nearly an hour (Sven, 2026-08-13). Ten minutes still collapses a release burst into
// one hop to @latest without making an urgent shipped fix look undeployed.
// Manual `relay update` bypasses it (explicit user intent).
export const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60 * 1000;
const UPDATE_STATE_FILE = "update-state.json";

// ---- pure, unit-tested helpers ------------------------------------------

// Parse "x.y.z" (tolerating a leading v and any build/prerelease suffix) into
// numeric parts, or null if it doesn't look like a release version.
export function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True iff `candidate` is a strictly higher release than `current`. Conservative:
// any unparseable input returns false, so a garbage registry reply never triggers
// an update. Numeric-per-component so 0.1.10 correctly beats 0.1.9.
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// Map a release channel to the npm dist-tag it follows. Stable is `latest`;
// dev and staging follow their matching deliberately promoted tags.
export function distTagForChannel(channel) {
  const normalized = normalizeUpdateChannel(channel);
  if (normalized === UPDATE_CHANNEL_DEV) return "dev";
  if (normalized === UPDATE_CHANNEL_STAGING) return "staging";
  return "latest";
}

export function latestFromRegistryDoc(doc, channel = UPDATE_CHANNEL_STABLE) {
  // The targeted /-/package/<name>/dist-tags endpoint returns the tags at the top
  // level, while the full packument nests them under "dist-tags". Accept both.
  const tags = doc && typeof doc === "object" ? { ...(doc["dist-tags"] || {}), ...doc } : {};
  const tag = distTagForChannel(channel);
  // A non-stable machine falls back to `latest` when its tag does not exist yet
  // (for example before staging's first promotion): stable beats frozen.
  const version = tags[tag] || tags.latest;
  return typeof version === "string" && version ? version : null;
}

export function versionFromSignedRuntimeManifest(envelope, trustStore = releaseTrust) {
  try {
    if (typeof trustStore === "string") {
      trustStore = {
        schema: 2,
        activeKeyId: envelope?.keyId,
        keys: [{ keyId: envelope?.keyId, algorithm: RELEASE_ALGORITHM, publicKeyPem: trustStore }],
      };
    }
    const payloadBytes = verifyReleaseEnvelope(envelope, trustStore);
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    return payload?.product === "Relay" && parseVersion(payload?.version) ? payload.version : null;
  } catch {
    return null;
  }
}

// Only ever self-update an npm-managed copy. A dev checkout lives at
// .../packages/companion (NOT under node_modules), so an npm install would update a
// separate tree the launch agents don't own and confuse the developer.
export function isManagedInstall(packageRoot) {
  return /[\\/]node_modules[\\/]relay-companion[\\/]?$/.test(String(packageRoot || ""));
}

// Resolve the npm prefix which OWNS this exact package tree. Global npm installs live
// at <prefix>/lib/node_modules (macOS/Linux) or <prefix>\node_modules (Windows);
// Relay's no-sudo fallback lives at <home>/.relay/lib/node_modules. Passing the
// explicit prefix to npm prevents an nvm/fnm/volta daemon from accidentally updating
// Homebrew's copy (or the reverse).
export function managedInstallInfo(
  packageRoot,
  { home = os.homedir(), platform = process.platform, exists = fs.existsSync } = {},
) {
  if (platform === "win32") {
    // Decide with path.win32 so the same logic is exact both on a real Windows
    // daemon and when unit tests exercise it from POSIX. Windows paths are
    // case-insensitive; compare accordingly.
    const win = path.win32;
    const root = win.resolve(String(packageRoot || ""));
    const nmSuffix = win.sep + win.join("node_modules", PACKAGE_NAME);
    if (!root.toLowerCase().endsWith(nmSuffix.toLowerCase())) return null;
    const prefix = root.slice(0, root.length - nmSuffix.length) || win.parse(root).root;
    const relayLocalSuffix = win.sep + win.join(".relay", "lib");
    if (prefix.toLowerCase().endsWith(relayLocalSuffix.toLowerCase())) {
      return { packageRoot: root, prefix, global: false };
    }
    // A Windows global prefix has the same <dir>\node_modules\<pkg> shape as an
    // arbitrary project checkout, which is NOT a safe rollback unit (the project
    // hoists Relay's dependencies beside it). Only adopt a prefix that carries
    // npm's global bin shims: `npm i -g relay-companion` always writes
    // <prefix>\relay.cmd, and custom prefixes that own npm itself carry npm.cmd /
    // node_modules\npm. The darwin branch refuses arbitrary node_modules for the
    // same reason.
    for (const marker of ["relay.cmd", "npm.cmd", win.join("node_modules", "npm")]) {
      try {
        if (exists(win.join(prefix, marker))) return { packageRoot: root, prefix, global: true };
      } catch {}
    }
    return null;
  }
  // Mirror of the win32 branch above: decide with path.posix so the logic is exact
  // both on a real macOS/Linux daemon and when the Windows gate exercises it.
  const posix = path.posix;
  const root = posix.resolve(String(packageRoot || ""));
  const globalSuffix = posix.join("lib", "node_modules", PACKAGE_NAME);
  const localSuffix = posix.join("node_modules", PACKAGE_NAME);
  // install.js's no-sudo fallback deliberately uses `npm install --prefix
  // ~/.relay/lib` (non-global), whose resulting path happens to LOOK like a global
  // <prefix>/lib/node_modules tree. Recognize that one explicit Relay-owned prefix
  // before applying the generic global rule.
  const relayLocalRoot = posix.resolve(home, ".relay", "lib", "node_modules", PACKAGE_NAME);
  if (root === relayLocalRoot) {
    return { packageRoot: root, prefix: posix.resolve(home, ".relay", "lib"), global: false };
  }
  if (root.endsWith(posix.sep + globalSuffix)) {
    return { packageRoot: root, prefix: root.slice(0, -(globalSuffix.length + 1)) || posix.parse(root).root, global: true };
  }
  // Do not take ownership of an arbitrary project's node_modules. Local npm
  // installs hoist Relay's dependencies beside it, so a correct rollback would
  // have to preserve that project's entire dependency tree. Only Relay's dedicated
  // no-sudo prefix above is safe for this updater to manage.
  return null;
}

export function autoUpdateEnabled(env = process.env) {
  const raw = String(env.RELAY_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

// ---- environment probes -------------------------------------------------

function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function companionPackageRoot() {
  return path.resolve(moduleDir(), "..");
}

export function currentCompanionVersion(packageRoot = companionPackageRoot()) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// Ask the npm registry for the current lightweight dist-tags document and pick
// the version this machine's release channel follows (stable -> latest,
// dev -> dev, staging -> staging). Returns the version string, or null on any error
// (offline, timeout, unexpected shape) so the caller simply skips this cycle.
// The channel is re-read from config on every call, so `relay update-channel`
// takes effect on the daemon's next poll without a restart.
export async function fetchLatestVersion({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  registry = DEFAULT_REGISTRY,
  now = () => Date.now(),
  channel = updateChannel(),
  publicKeyPem = "",
  trustStore = releaseTrust,
  stableManifestUrl = STABLE_RUNTIME_MANIFEST,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  try {
    if (normalizeUpdateChannel(channel) === UPDATE_CHANNEL_STABLE && (publicKeyPem || trustStore?.keys?.length)) {
      const response = await fetchImpl(`${stableManifestUrl}?relay_update=${encodeURIComponent(now())}`, {
        cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) return null;
      return versionFromSignedRuntimeManifest(await response.json(), publicKeyPem || trustStore);
    }
    const base = String(registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
    // Query only the mutable dist-tags document. A unique query plus explicit
    // no-cache directives avoids a CDN/proxy/browser cache serving the pre-publish
    // tag for another full polling interval.
    const url = `${base}/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags?relay_update=${encodeURIComponent(now())}`;
    const res = await fetchImpl(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return null;
    return latestFromRegistryDoc(await res.json(), channel);
  } catch {
    return null;
  }
}

// ---- update execution ---------------------------------------------------

// Launch the install + restart in a FULLY DETACHED shell (its own session via
// `detached`), so it survives the daemon being killed when we restart it. The
// script is hardened against the ways an unattended npm install can go
// wrong on a fleet of machines:
//   - Single-writer lock (mkdir, with stale-steal) so a manual `relay update` and
//     the daemon can't run concurrent global installs into the same dir.
//   - Verify the freshly-written tree is loadable (electron binary present + the
//     bin + a valid package.json) BEFORE restarting anything, so a partial install
//     — e.g. electron's postinstall binary download failing mid-way — is never
//     launched. The pill plist hard-points at electron, so a broken tree would
//     otherwise brick the pill on its next relaunch.
//   - On install, verify, or restart failure, atomically restore a local backup of
//     the known-running tree (no registry/network dependency).
//   - Restart the pill first and the daemon LAST — kicking the daemon SIGKILLs this
//     process's parent, but this detached shell has already issued everything before
//     that and launchd relaunches the daemon with the freshly installed code.
// Prefer the npm that belongs to the SAME node runtime the daemon is running under.
// A version-manager user (nvm/fnm/volta) runs the daemon from e.g.
// ~/.nvm/versions/node/vX/bin/node; the matching npm sits beside it and installs to
// its expected CLI/runtime behavior. The install command separately pins the owning
// prefix, so even an unusual npm config cannot redirect the update to another copy.
export function readUpdateState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  return null;
}

function writeUpdateState(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  } catch {}
}

export function recordBootVersion(file, version, { now = () => Date.now() } = {}) {
  const stored = readUpdateState(file);
  if (stored && stored.version === version) {
    return Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0;
  }
  // First-ever record (fresh install/older tree) must not delay a pending fix by
  // a full cooldown: only a VERSION CHANGE counts as "an update just landed".
  const updatedAt = stored ? now() : 0;
  // Booting on a different version means an update actually landed, so whatever was
  // failing is fixed. Drop the failure record rather than carrying a stale escalation.
  writeUpdateState(file, { version, updatedAt });
  return updatedAt;
}

/**
 * The durable "my updates are failing" record, kept beside the boot version so it
 * survives the daemon restarts and logons that the failure loop itself causes. This
 * is what makes a silently pinned machine diagnosable: `relay doctor` reads it, and
 * the daemon escalates from it. Cleared automatically when an update lands, because
 * `recordBootVersion` rewrites the file on any version change.
 */
export function readUpdateFailure(file) {
  const stored = readUpdateState(file);
  const failure = stored && typeof stored.failure === "object" && stored.failure ? stored.failure : null;
  if (!failure || !Number.isFinite(Number(failure.count)) || Number(failure.count) <= 0) return null;
  return {
    target: String(failure.target || ""),
    count: Number(failure.count),
    firstAt: Number(failure.firstAt) || 0,
    lastAt: Number(failure.lastAt) || 0,
  };
}

export function recordUpdateFailure(file, target, { now = () => Date.now() } = {}) {
  const stored = readUpdateState(file) || {};
  const prior = readUpdateFailure(file);
  // Count attempts at THIS version. A newly published version is a fresh problem and
  // deserves a fresh fast retry — the old target's failures say nothing about it.
  const continuing = prior && prior.target === String(target || "");
  const t = now();
  const failure = {
    target: String(target || ""),
    count: continuing ? prior.count + 1 : 1,
    firstAt: continuing ? prior.firstAt || t : t,
    lastAt: t,
  };
  writeUpdateState(file, { ...stored, failure });
  return failure;
}

// The update-path record is written BEFORE the launch (see launchPending), so a
// LANDED update leaves a failure record for its own target behind. The daemon that
// boots running that target is the success signal; it drops the record here.
export function clearUpdateFailure(file) {
  const stored = readUpdateState(file);
  if (!stored || !stored.failure) return false;
  const rest = { ...stored };
  delete rest.failure;
  writeUpdateState(file, rest);
  return true;
}

/**
 * The canonical-runtime MIGRATION needs its own durable attempt record, in its own
 * slot, because it is the one update path whose in-memory guard cannot work:
 * launching a migration quiesces and exits this daemon, launchd restarts it, and
 * `state` comes back empty — so a migration that never lands retries every few
 * seconds forever. On David's Mac that produced 35,440 failed installs and 11,015
 * leaked lock directories in a single day while the machine stayed pinned at
 * 0.1.265. Separate from `failure` above so an upgrade backoff and a migration
 * backoff can never overwrite each other's counts.
 *
 * RECOVERY needs a slot of its own for the same reason it needs a record at all.
 * Both paths quiesce this daemon and both write here, but they carry DIFFERENT
 * targets — `canonical-migration:<v>` and `canonical-recovery:<v>` — and a record
 * whose target changed is a fresh attempt, count 1. Sharing one slot therefore let
 * the two paths reset each other every time they alternated: the count never left
 * the two-minute base, the exponential ceiling was never reached, and a machine
 * whose activation could not succeed retried for 17.5 hours (104 activations, 100
 * of them the same launchd EIO, 22 GB of leaked release trees) while the stored
 * count still read 3. Keyed slots keep each path's backoff its own.
 */
const MIGRATION_FAILURE_SLOT = "migrationFailure";
const RECOVERY_FAILURE_SLOT = "recoveryFailure";
const AUTOSTART_REPOINT_FAILURE_SLOT = "autostartRepointFailure";
const ATTEMPT_FAILURE_SLOTS = [MIGRATION_FAILURE_SLOT, RECOVERY_FAILURE_SLOT, AUTOSTART_REPOINT_FAILURE_SLOT];

export function readMigrationFailure(file, { slot = MIGRATION_FAILURE_SLOT } = {}) {
  const stored = readUpdateState(file);
  const failure = stored && typeof stored[slot] === "object" && stored[slot]
    ? stored[slot]
    : null;
  if (!failure || !Number.isFinite(Number(failure.count)) || Number(failure.count) <= 0) return null;
  return {
    target: String(failure.target || ""),
    count: Number(failure.count),
    firstAt: Number(failure.firstAt) || 0,
    lastAt: Number(failure.lastAt) || 0,
  };
}

export function recordMigrationFailure(file, target, { now = () => Date.now(), slot = MIGRATION_FAILURE_SLOT } = {}) {
  const stored = readUpdateState(file) || {};
  const prior = readMigrationFailure(file, { slot });
  const continuing = prior && prior.target === String(target || "");
  const t = now();
  const record = {
    target: String(target || ""),
    count: continuing ? prior.count + 1 : 1,
    firstAt: continuing ? prior.firstAt || t : t,
    lastAt: t,
  };
  writeUpdateState(file, { ...stored, [slot]: record });
  return record;
}

// Doctor needs the recovery slot without owning the slot names.
export function readRecoveryFailure(file) {
  return readMigrationFailure(file, { slot: RECOVERY_FAILURE_SLOT });
}

// Migration succeeded the moment this process boots from the canonical runtime, so
// the record is dropped there rather than by any explicit success signal. That boot
// retires the recovery record too: recovery exists only to get the runtime onto the
// canonical tree, which is exactly what has just been observed to have happened.
export function clearMigrationFailure(file) {
  const stored = readUpdateState(file);
  if (!stored) return false;
  const present = ATTEMPT_FAILURE_SLOTS.filter((slot) => stored[slot]);
  if (!present.length) return false;
  const rest = { ...stored };
  for (const slot of present) delete rest[slot];
  writeUpdateState(file, rest);
  return true;
}

// Exponential backoff over consecutive failed attempts at the same version, from the
// two-minute base up to the hourly ceiling. `failures` of 0 or 1 keeps the original
// prompt retry, so a genuinely transient failure still recovers within minutes.
export function updateRetryCooldownMs(failures, { baseMs = RETRY_COOLDOWN_MS, maxMs = MAX_RETRY_COOLDOWN_MS } = {}) {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  if (n <= 1) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}

// Build a rate-limited auto-update checker. Call `tick()` freely (e.g. once per
// daemon poll); it no-ops cheaply until a check is due, then fetches the latest
// version and, if newer, launches the detached update-and-restart. Every effectful
// dependency is injectable so the decision logic is unit-testable without network,
// npm, or launchd. `tick()` never throws.
/**
 * Re-point the machine's autostart at the canonical tree, from the canonical bin.
 *
 * `repair-runtime` is trampoline-exempt by design, so it registers whichever tree
 * invokes it; running it from anywhere but canonical would only move the problem.
 * On macOS it goes through `launchctl submit` rather than a plain child, because
 * the repair unloads the daemon's own launchd job and a process descended from
 * that job loses its Mach bootstrap session when the ancestor is booted out
 * (field-observed on the 0.1.68 rollout). A submitted job is parented to the gui
 * domain and survives.
 */
export function submitCanonicalRepoint({
  canonical,
  platform = process.platform,
  log = () => {},
  spawnImpl = spawn,
  label = null,
}) {
  if (!canonical?.bin) return false;
  const node = canonical.node && fs.existsSync(canonical.node) ? canonical.node : process.execPath;
  try {
    if (platform === "darwin") {
      const jobLabel = label || `work.relay.autostart.repoint.${process.pid}`;
      const child = spawnImpl(
        "/bin/launchctl",
        ["submit", "-l", jobLabel, "--", node, canonical.bin, "repair-runtime"],
        { detached: true, stdio: "ignore" },
      );
      child?.unref?.();
      return true;
    }
    const child = spawnImpl(node, [canonical.bin, "repair-runtime"], { detached: true, stdio: "ignore" });
    child?.unref?.();
    return true;
  } catch (err) {
    log(`autostart repoint launch failed: ${err && err.message ? err.message : String(err)}`);
    return false;
  }
}

export function createAutoUpdater({
  now = () => Date.now(),
  env = process.env,
  packageRoot = companionPackageRoot(),
  getCurrentVersion = () => currentCompanionVersion(packageRoot),
  getOnDiskVersion = () => getCurrentVersion(),
  getCurrentChannel = () => updateChannel(),
  getLatestVersion = (opts) => fetchLatestVersion(opts),
  spawnUpdate = (opts) => spawnCanonicalUpdate({
        version: opts.targetVersion,
        runningVersion: opts.currentVersion,
        runningPackageRoot: opts.packageRoot,
        node: process.execPath,
        homeDir: os.homedir(),
        platform: opts.platform,
      }),
  getCanonicalRuntime = () => readCanonicalRuntime({ platform }),
  readAutostart = () => readAutostartDaemonRoot({ platform }),
  repointAutostart = (opts) => submitCanonicalRepoint(opts),
  getCanonicalRuntimeState = () => readCanonicalRuntimeState({ platform }),
  getCanonicalRuntimeHealth = (target) => exactRuntimeHealth(target, { platform }),
  reconcileCanonicalWorkers = () => platform === "darwin" ? reconcileUpdateWorkerJobs() : { removedLegacy: 0, fixed: null },
  checkIntervalMs = Number(env.RELAY_UPDATE_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS,
  checkFailureRetryMs = DEFAULT_CHECK_FAILURE_RETRY_MS,
  maxCheckFailureRetryMs = MAX_CHECK_FAILURE_RETRY_MS,
  retryCooldownMs = RETRY_COOLDOWN_MS,
  platform = process.platform,
  // Idle probe: while any host turn is in flight, defer the restart-bearing update
  // (kickstart -k would kill the running turn). Injected from the daemon; defaults to
  // "always idle" so the pure decision logic stays testable without runtime.
  hasActiveWork = () => false,
  // Fleet-restart politeness (see DEFAULT_RESTART_COOLDOWN_MS). 0 disables the
  // cooldown — used by manual `relay update`, where the user asked right now.
  restartCooldownMs = Number.isFinite(Number(env.RELAY_UPDATE_RESTART_COOLDOWN_MS))
    ? Number(env.RELAY_UPDATE_RESTART_COOLDOWN_MS)
    : DEFAULT_RESTART_COOLDOWN_MS,
  updateStatePath = path.join(storeDir(), UPDATE_STATE_FILE),
  // Honour the persisted failure backoff. false = attempt right now regardless of how
  // many times this version has failed — used by manual `relay update`, where the user
  // is present, asked explicitly, and is very likely retrying because they JUST fixed
  // whatever was broken.
  useFailureBackoff = true,
  log = () => {},
  explicitRepair = false,
} = {}) {
  // This is the version of the code loaded in THIS process, not a fresh read of the
  // package.json on every tick. If npm writes a new tree but launchctl restart fails,
  // the old daemon must keep retrying rather than see the new on-disk version and
  // falsely conclude that it is current.
  let runningVersion = null;
  try {
    runningVersion = getCurrentVersion();
  } catch {}
  let bootChannel = UPDATE_CHANNEL_STABLE;
  try {
    bootChannel = normalizeUpdateChannel(getCurrentChannel());
  } catch {}
  // When this daemon boots on a version different from the recorded one, an
  // update (self- or manual) just landed and already restarted the pill once.
  let lastUpdateLandedAt = 0;
  if (restartCooldownMs > 0 && runningVersion) {
    try {
      lastUpdateLandedAt = recordBootVersion(updateStatePath, runningVersion, { now });
    } catch {}
  }
  // Carried across daemon restarts: the failure loop restarts this process (logon,
  // KeepAlive), so an in-memory counter would reset to zero on every lap and the
  // backoff would never actually engage.
  const priorFailure = (() => {
    if (!useFailureBackoff) return null;
    try {
      const failure = readUpdateFailure(updateStatePath);
      // The record is written BEFORE each launch (see launchPending), because a
      // canonical update that fails at ACTIVATION rolls back by restarting this
      // daemon — the process that could count the failure afterwards is dead by
      // the time there is a failure to count. The flip side: an update that
      // LANDED leaves its own pre-launch record behind, and booting as the
      // recorded target is the success signal that retires it.
      if (failure && runningVersion && failure.target === runningVersion) {
        try { clearUpdateFailure(updateStatePath); } catch {}
        return null;
      }
      return failure;
    } catch {
      return null;
    }
  })();
  const state = {
    lastCheckAt: 0,
    nextCheckAt: 0,
    consecutiveCheckFailures: 0,
    checking: false,
    pendingVersion: priorFailure?.target || null,
    pendingChannel: priorFailure ? bootChannel : null,
    updateStartedAt: 0,
    updating: false,
    cooldownAnnouncedFor: null,
    updateFailures: priorFailure?.count || 0,
    failingTarget: priorFailure?.target || null,
    // Wall-clock gate for the next attempt, so the backoff survives the daemon
    // restart that a failed update tends to cause.
    nextAttemptAt: priorFailure
      ? priorFailure.lastAt + updateRetryCooldownMs(priorFailure.count, { baseMs: retryCooldownMs })
      : 0,
    escalatedFor: null,
    workersReconciled: false,
  };

  function admittedLaunch(result) {
    if (!result) return false;
    return typeof result.status !== "string" || result.status === "admitted";
  }

  function rejectedLaunchStatus(result, fallback = "launch-failed") {
    if (!result) return "worker-not-admitted";
    if (result?.status === "failed") return "worker-failed";
    if (result?.status === "busy") return "worker-busy";
    if (result?.status === "not-admitted") return "worker-not-admitted";
    return fallback;
  }

  function liveChannel() {
    try {
      return normalizeUpdateChannel(getCurrentChannel());
    } catch {
      return UPDATE_CHANNEL_STABLE;
    }
  }

  function onDiskVersion() {
    try {
      return getOnDiskVersion();
    } catch {
      return null;
    }
  }

  function busy() {
    try {
      return Boolean(hasActiveWork());
    } catch {
      return false;
    }
  }

  // Record one failed end-to-end attempt and decide how long to wait before the next.
  // "Failed" here means: we launched an updater and this daemon is still running the
  // old version well after it should have been replaced.
  function noteUpdateFailure(target, t) {
    if (state.failingTarget !== target) {
      state.failingTarget = target;
      state.updateFailures = 0;
      state.escalatedFor = null;
    }
    state.updateFailures += 1;
    let persisted = null;
    try {
      persisted = recordUpdateFailure(updateStatePath, target, { now: () => t });
    } catch {}
    if (persisted) state.updateFailures = persisted.count;
    // Compound from the CONFIGURED base, not the module default, so an injected or
    // env-tuned retry cadence still governs the backoff built on top of it.
    const wait = updateRetryCooldownMs(state.updateFailures, { baseMs: retryCooldownMs });
    // Measure the window from when the attempt STARTED, not from now. The in-flight
    // retry cooldown has already been served by the time we get here, so the first
    // failure retries immediately (unchanged behaviour) and only the second and later
    // failures actually hold the update back.
    state.nextAttemptAt = (state.updateStartedAt || t) + wait;
    const waitLabel = wait >= 60_000 ? `${Math.round(wait / 60_000)}m` : `${Math.round(wait / 1000)}s`;
    if (state.updateFailures >= UPDATE_FAILURE_ESCALATION_THRESHOLD && state.escalatedFor !== target) {
      // Escalate ONCE per stuck version, loudly and actionably. Before this, a stuck
      // machine emitted the same three lines forever and surfaced nothing anywhere a
      // human looks — the only way to notice was diffing package.json against npm.
      state.escalatedFor = target;
      log(
        `auto-update STUCK: ${state.updateFailures} consecutive failed attempts to install ${target} ` +
          `(still running ${runningVersion}). Updates are not reaching this machine. ` +
          `See ${path.join(os.homedir(), ".relay", "update.log")} for the cause, ` +
          `and run \`relay doctor\` for a summary or \`relay repair-desktop\` if autostart is broken.`,
      );
    } else {
      log(`auto-update: attempt ${state.updateFailures} to install ${target} did not land; retrying in ~${waitLabel}`);
    }
  }

  function launchPending(t) {
    const latest = state.pendingVersion;
    if (!latest || !isNewerVersion(latest, runningVersion)) return null;
    const channel = liveChannel();
    // Pending versions are channel-scoped. A daemon may discover @dev or @staging,
    // remain alive through an updater failure, and later see the user switch.
    // Never deliver a pending build after the configured channel changed.
    if (!state.pendingChannel || state.pendingChannel !== channel) {
      state.pendingVersion = null;
      state.pendingChannel = null;
      state.nextCheckAt = 0;
      return { status: "stale-channel", current: runningVersion, channel };
    }
    // This process identity is the code it booted, not whatever package.json says
    // now. A different on-disk version means another updater/manual install won the
    // race; this daemon is retired and must never mutate that tree.
    const diskVersion = onDiskVersion();
    if (diskVersion && runningVersion && diskVersion !== runningVersion) {
      return { status: "stale-process", current: runningVersion, onDisk: diskVersion, channel };
    }
    // Exponential backoff between failed attempts at the same version.
    if (useFailureBackoff && state.nextAttemptAt > 0 && t < state.nextAttemptAt && state.failingTarget === latest) {
      return {
        status: "deferred-backoff",
        current: runningVersion,
        latest,
        failures: state.updateFailures,
        retryAt: state.nextAttemptAt,
      };
    }
    // Never kill an active host turn. Unlike the old hard deadline, this waits as
    // long as necessary, but because pending updates are checked on EVERY daemon
    // loop it launches within seconds of the final turn becoming idle.
    if (busy()) return { status: "deferred-busy", current: runningVersion, latest };
    // Restart politeness: one update restart per cooldown window. The pending
    // version keeps tracking @latest, so waiting never strands users on an
    // intermediate build — it only spaces out the restarts.
    if (restartCooldownMs > 0 && lastUpdateLandedAt > 0) {
      const sinceLanded = t - lastUpdateLandedAt;
      if (sinceLanded >= 0 && sinceLanded < restartCooldownMs) {
        if (state.cooldownAnnouncedFor !== latest) {
          state.cooldownAnnouncedFor = latest;
          const waitMin = Math.ceil((restartCooldownMs - sinceLanded) / 60000);
          log(`auto-update: ${latest} is ready; deferring the restart ~${waitMin}m (an update landed recently)`);
        }
        return { status: "deferred-cooldown", current: runningVersion, latest };
      }
    }
    log(`auto-update: ${runningVersion} -> ${latest}; installing exact version and restarting`);
    state.updating = true;
    state.updateStartedAt = t;
    let launch = null;
    try {
      launch = spawnUpdate({
        log,
        currentVersion: runningVersion,
        currentChannel: channel,
        targetVersion: latest,
        packageRoot,
        platform,
      });
    } catch (err) {
      state.updating = false;
      log(`auto-update launch failed: ${err && err.message ? err.message : String(err)}`);
      return { status: "launch-failed", current: runningVersion, latest };
    }
    if (!admittedLaunch(launch)) {
      state.updating = false;
      const status = rejectedLaunchStatus(launch);
      log(`auto-update worker was not admitted (${status})`);
      return { status, current: runningVersion, latest, channel };
    }
    // Persist only after the worker has acquired the canonical transaction lock.
    // A successful `launchctl submit` is not admission and must never be counted as
    // a running update or a failed end-to-end attempt.
    try { recordUpdateFailure(updateStatePath, latest, { now: () => t }); } catch {}
    return { status: "updating", current: runningVersion, latest, channel, launch };
  }

  async function tick() {
    if (!autoUpdateEnabled(env)) return { status: "disabled" };
    // Only platforms with a real restart path may update: darwin (launchd bootout +
    // bootstrap, handed to an independent submitted job) and win32 (Scheduled Tasks
    // via schtasks /End + /Run, pill first, daemon last). Elsewhere a detached
    // script would falsely report "updating" and never restart — the daemon would
    // run stale code forever while thinking it self-updates. Gate explicitly.
    if (platform !== "darwin" && platform !== "win32") return { status: "unsupported-platform" };
    const t = now();
    let canonical = null;
    let canonicalState = null;
    if (!state.workersReconciled && platform === "darwin") {
      try { reconcileCanonicalWorkers(); } catch {}
      state.workersReconciled = true;
    }
    try {
      canonical = getCanonicalRuntime();
      canonicalState = getCanonicalRuntimeState();
    } catch {}
    const api = platform === "win32" ? path.win32 : path.posix;
    const sameRoot = (left, right) => {
      const a = api.resolve(String(left || ""));
      const b = api.resolve(String(right || ""));
      return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    const runningFromCanonical = Boolean(canonical && sameRoot(canonical.packageRoot, packageRoot));
    // Booting from the canonical runtime IS the migration's success signal; nothing
    // else reports it, and the version never changes across a migration, so the
    // durable attempt record has to be dropped here or it would back off forever.
    if (runningFromCanonical) {
      try { clearMigrationFailure(updateStatePath); } catch {}
    }
    if (canonical && !runningFromCanonical) {
      const newerGlobal = isNewerVersion(runningVersion, canonical.version);
      let equalExplicitRepair = false;
      if (explicitRepair && runningVersion === canonical.version) {
        try { equalExplicitRepair = getCanonicalRuntimeHealth(canonical)?.ok === false; } catch {}
      }
      if ((newerGlobal || equalExplicitRepair) && managedInstallInfo(packageRoot, { platform })) {
        if (busy()) return { status: "deferred-rescue-busy", current: runningVersion, onDisk: canonical.version };
        let launch = null;
        try {
          launch = spawnUpdate({
            log,
            currentVersion: runningVersion,
            currentChannel: liveChannel(),
            targetVersion: runningVersion,
            packageRoot,
            platform,
            canonicalRescue: true,
          });
        } catch (err) {
          log(`canonical runtime rescue launch failed: ${err && err.message ? err.message : String(err)}`);
          return { status: "rescue-launch-failed", current: runningVersion, onDisk: canonical.version };
        }
        if (!admittedLaunch(launch)) {
          return { status: rejectedLaunchStatus(launch, "rescue-launch-failed"), current: runningVersion, onDisk: canonical.version };
        }
        state.updating = true;
        state.updateStartedAt = t;
        return { status: "rescuing-runtime", current: runningVersion, onDisk: canonical.version, launch };
      }
      // `stale-process` describes a LEFTOVER: some other process is the machine's
      // real daemon and this one should simply die. That is not this situation when
      // the autostart registration names THIS tree — then this process IS the
      // machine's registered daemon, merely pointed at a stale release, and no
      // other actor exists to start canonical. Returning the no-op status there
      // leaves the machine with a daemon that can never reach canonical and, paired
      // with the exit-on-stale path, loops forever without delivering anything.
      let registration = null;
      try { registration = readAutostart(); } catch { registration = null; }
      if (registration?.root && sameRoot(registration.root, packageRoot)) {
        const repointTarget = `autostart-repoint:${canonical.version}`;
        const priorRepoint = readMigrationFailure(updateStatePath, { slot: AUTOSTART_REPOINT_FAILURE_SLOT });
        if (priorRepoint && priorRepoint.target === repointTarget) {
          const wait = updateRetryCooldownMs(priorRepoint.count, { baseMs: retryCooldownMs });
          if (t - priorRepoint.lastAt < wait) {
            return {
              status: "deferred-autostart-repoint",
              current: runningVersion,
              onDisk: canonical.version,
              failures: priorRepoint.count,
            };
          }
        }
        if (busy()) return { status: "deferred-repoint-busy", current: runningVersion, onDisk: canonical.version };
        let launched = false;
        try {
          launched = repointAutostart({ canonical, platform, log });
        } catch (err) {
          log(`autostart repoint failed: ${err && err.message ? err.message : String(err)}`);
          launched = false;
        }
        // Record before reporting success: the repair replaces this very process,
        // so there is no later moment in which to write the attempt down. A boot
        // from canonical clears the slot; anything else backs off.
        try { recordMigrationFailure(updateStatePath, repointTarget, { now: () => t, slot: AUTOSTART_REPOINT_FAILURE_SLOT }); } catch {}
        if (launched) {
          log(
            `autostart still names this stale tree (${registration.source}); ` +
              `repointing it at ${canonical.version} from the canonical bin`,
          );
          state.updating = true;
          state.updateStartedAt = t;
          return { status: "repointing-autostart", current: runningVersion, onDisk: canonical.version };
        }
        return { status: "autostart-repoint-failed", current: runningVersion, onDisk: canonical.version };
      }
      return { status: "stale-process", current: runningVersion, onDisk: canonical.version };
    }

    if (runningFromCanonical && explicitRepair) {
      let health = null;
      try { health = getCanonicalRuntimeHealth(canonical); } catch {}
      if (health && !health.ok) {
        if (busy()) return { status: "deferred-repair-busy", current: runningVersion, health };
        let launch = null;
        try {
          launch = spawnUpdate({
            log,
            currentVersion: runningVersion,
            currentChannel: liveChannel(),
            targetVersion: runningVersion,
            packageRoot,
            platform,
            canonicalRepair: true,
          });
        } catch (err) {
          log(`canonical runtime repair launch failed: ${err && err.message ? err.message : String(err)}`);
          return { status: "repair-launch-failed", current: runningVersion, health };
        }
        if (!admittedLaunch(launch)) {
          return { status: rejectedLaunchStatus(launch, "repair-launch-failed"), current: runningVersion, health };
        }
        state.updating = true;
        state.updateStartedAt = t;
        return { status: "repairing-runtime", current: runningVersion, health, launch };
      }
    }
    if (!canonical && ["activating", "recovery-required"].includes(canonicalState?.state)) {
      const preparedAt = Number(canonicalState?.preparedAt) || 0;
      if (canonicalState?.state === "activating" && preparedAt > 0 && t - preparedAt >= 0 && t - preparedAt < retryCooldownMs) {
        return {
          status: "activation-in-flight",
          current: runningVersion,
          recovery: canonicalState,
          recoverAfter: preparedAt + retryCooldownMs,
        };
      }
      if (busy()) return { status: "deferred-recovery-busy", current: runningVersion, recovery: canonicalState };
      // Same in-flight window as migration. This was retryCooldownMs (2 minutes),
      // which an npm install of a ~650MB Electron tree routinely exceeds — so a
      // second recovery worker was spawned on top of a live one, each building its
      // own release dir against the same lock.
      if (state.updating && t - state.updateStartedAt < CANONICAL_TRANSACTION_IN_FLIGHT_MS) {
        return { status: "recovery-in-flight", current: runningVersion, recovery: canonicalState };
      }
      // Recovery quiesces and exits this daemon exactly as migration does, so its
      // in-memory guard is just as empty on the way back. A transaction that dies
      // LATE — activation, not install — leaves a journal that sends every restart
      // straight back here, which is how a fixed install turned into a hot recovery
      // loop instead of a hot migration loop. Same durable record, same backoff.
      const recoveryTarget = `canonical-recovery:${canonicalState.candidate?.version || runningVersion}`;
      const priorRecovery = readMigrationFailure(updateStatePath, { slot: RECOVERY_FAILURE_SLOT });
      if (priorRecovery && priorRecovery.target === recoveryTarget) {
        const wait = updateRetryCooldownMs(priorRecovery.count, { baseMs: retryCooldownMs });
        if (t - priorRecovery.lastAt < wait) {
          return { status: "deferred-recovery-backoff", current: runningVersion, recovery: canonicalState, failures: priorRecovery.count };
        }
      }
      let launch = null;
      try {
        launch = spawnUpdate({
          log,
          currentVersion: runningVersion,
          currentChannel: liveChannel(),
          targetVersion: canonicalState.candidate?.version || runningVersion,
          packageRoot,
          platform,
          canonicalRecovery: true,
        });
      } catch (err) {
        log(`canonical runtime recovery launch failed: ${err && err.message ? err.message : String(err)}`);
        return { status: "recovery-launch-failed", current: runningVersion, recovery: canonicalState };
      }
      if (!admittedLaunch(launch)) {
        return { status: rejectedLaunchStatus(launch, "recovery-launch-failed"), current: runningVersion, recovery: canonicalState };
      }
      try { recordMigrationFailure(updateStatePath, recoveryTarget, { now: () => t, slot: RECOVERY_FAILURE_SLOT }); } catch {}
      state.updating = true;
      state.updateStartedAt = t;
      return { status: "recovering-runtime", current: runningVersion, recovery: canonicalState, launch };
    }
    // First move a healthy npm/global/Hermes-owned install into Relay's immutable
    // runtime at the exact version currently executing. No update is attempted in
    // this transaction, and the external tree remains the explicit rollback target.
    if (!runningFromCanonical && !isCanonicalPackageRoot(packageRoot, { platform })) {
      if (!managedInstallInfo(packageRoot, { platform })) return { status: "unmanaged" };
      if (busy()) return { status: "deferred-migration-busy", current: runningVersion };
      if (state.updating && t - state.updateStartedAt < CANONICAL_TRANSACTION_IN_FLIGHT_MS) {
        return { status: "migration-in-flight", current: runningVersion };
      }
      // The in-memory guard above cannot hold this path: launching quiesces and exits
      // this daemon, launchd restarts it, and `state` comes back empty. Only a record
      // on disk survives the restart the attempt itself causes — see
      // readMigrationFailure. Written BEFORE the launch, and read back only by a
      // daemon that returned still-not-canonical, i.e. only after a failure.
      const migrationTarget = `canonical-migration:${runningVersion}`;
      const priorMigration = readMigrationFailure(updateStatePath);
      if (priorMigration && priorMigration.target === migrationTarget) {
        const wait = updateRetryCooldownMs(priorMigration.count, { baseMs: retryCooldownMs });
        if (t - priorMigration.lastAt < wait) {
          return { status: "deferred-migration-backoff", current: runningVersion, failures: priorMigration.count };
        }
      }
      state.updating = true;
      state.updateStartedAt = t;
      state.pendingVersion = runningVersion;
      state.pendingChannel = liveChannel();
      let launch = null;
      try {
        launch = spawnUpdate({
          log,
          currentVersion: runningVersion,
          currentChannel: state.pendingChannel,
          targetVersion: runningVersion,
          packageRoot,
          platform,
          canonicalMigration: true,
        });
      } catch (err) {
        state.updating = false;
        log(`canonical runtime migration launch failed: ${err && err.message ? err.message : String(err)}`);
        return { status: "migration-launch-failed", current: runningVersion };
      }
      if (!admittedLaunch(launch)) {
        state.updating = false;
        return { status: rejectedLaunchStatus(launch, "migration-launch-failed"), current: runningVersion };
      }
      try { recordMigrationFailure(updateStatePath, migrationTarget, { now: () => t }); } catch {}
      return { status: "migrating-runtime", current: runningVersion, launch };
    }
    // An update was launched but we're still alive (install failed, or restart is
    // pending) — hold off briefly, then retry the exact pending version. A successful
    // daemon restart creates a fresh updater, so reaching the cooldown is itself
    // evidence that this attempt did not complete end-to-end.
    if (state.updating && t - state.updateStartedAt < retryCooldownMs) return { status: "in-flight" };
    if (state.updating) {
      state.updating = false;
      // This daemon outliving the attempt IS the failure signal: a successful update
      // replaces this process. Count it, back off, and escalate once it is chronic —
      // rather than re-attempting at a flat two-minute cadence forever.
      noteUpdateFailure(state.pendingVersion || "update", t);
    }

    // A discovered update is retained across network failures and busy turns. If the
    // host is now idle, install immediately without waiting for another registry poll.
    // Deferred states fall through to the (interval-gated) registry check so the
    // pending version keeps tracking @latest while we wait.
    const pending = launchPending(t);
    if (
      pending &&
      pending.status !== "deferred-busy" &&
      pending.status !== "deferred-cooldown" &&
      pending.status !== "deferred-backoff"
    ) {
      return pending;
    }

    if (state.checking) return { status: "check-in-flight", current: runningVersion };
    if (t < state.nextCheckAt) return pending || { status: "not-due", current: runningVersion };
    state.lastCheckAt = t;
    state.checking = true;

    let latest = null;
    const checkedChannel = liveChannel();
    try {
      latest = await getLatestVersion({ channel: checkedChannel });
    } catch (err) {
      log(`auto-update registry check failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      state.checking = false;
    }
    if (!latest) {
      state.consecutiveCheckFailures += 1;
      const backoff = Math.min(
        maxCheckFailureRetryMs,
        checkFailureRetryMs * 2 ** Math.max(0, state.consecutiveCheckFailures - 1),
      );
      state.nextCheckAt = t + backoff;
      // Keep an already-discovered update pending through a transient check failure.
      if (pending) return { ...pending, checkFailed: true, retryAt: state.nextCheckAt };
      return { status: "check-failed", current: runningVersion, retryAt: state.nextCheckAt };
    }
    state.consecutiveCheckFailures = 0;
    state.nextCheckAt = t + Math.max(0, checkIntervalMs);

    if (!isNewerVersion(latest, runningVersion)) {
      state.pendingVersion = null;
      state.pendingChannel = null;
      return { status: "up-to-date", current: runningVersion, latest };
    }
    state.pendingVersion = latest;
    state.pendingChannel = checkedChannel;
    return launchPending(t);
  }

  return { tick, state, runningVersion, bootChannel };
}

// One-shot for the `relay update` CLI: check once and, if a newer version exists,
// launch the update. Prints a human-readable line. Bypasses the interval gate.
export async function runUpdateOnce({
  log = (m) => console.log(`[relay] ${m}`),
  waitForTerminal = false,
} = {}) {
  // checkIntervalMs 0: bypass the interval gate. restartCooldownMs 0: an explicit
  // `relay update` is user intent — never make the human wait out fleet politeness.
  // useFailureBackoff false: likewise never make them wait out a backoff they are
  // very likely retrying precisely because they just repaired the cause.
  const updater = createAutoUpdater({
    checkIntervalMs: 0,
    restartCooldownMs: 0,
    useFailureBackoff: false,
    explicitRepair: true,
    log,
  });
  const result = await updater.tick();
  switch (result.status) {
    case "updating":
      log(`updating ${result.current} -> ${result.latest}; the pill and daemon will restart shortly.`);
      break;
    case "up-to-date":
      log(`already on the latest version (${result.current}).`);
      break;
    case "unmanaged":
      log("not an npm-managed install (dev checkout?) — skipping self-update.");
      break;
    case "disabled":
      log("auto-update is disabled (RELAY_AUTO_UPDATE).");
      break;
    case "check-failed":
      log("could not reach the npm registry to check for updates.");
      break;
    case "unsupported-platform":
      log("self-update is only supported on macOS and Windows right now — update with `npm i -g relay-companion@latest`.");
      break;
    case "deferred-busy":
      log(`an update to ${result.latest} is ready but deferred while an agent turn is active; it will install once idle.`);
      break;
    case "deferred-cooldown":
      log(`an update to ${result.latest} is ready but a recent update just landed; it will install after the cooldown.`);
      break;
    case "deferred-backoff":
      log(
        `an update to ${result.latest} is ready but the last ${result.failures} attempt(s) failed; ` +
          "backing off. Check ~/.relay/update.log for the cause.",
      );
      break;
    case "migrating-runtime":
      log(`moving the current ${result.current} install into Relay's safe runtime; services will restart shortly.`);
      break;
    case "rescuing-runtime":
      log(`moving the newer ${result.current} install into Relay's safe runtime; services will restart shortly.`);
      break;
    case "repairing-runtime":
      log(`repairing Relay ${result.current}; services will restart shortly.`);
      break;
    case "worker-busy":
      log("an update worker already owns the runtime transaction.");
      break;
    case "worker-not-admitted":
      log("the update worker did not acquire the runtime transaction; no update was started.");
      break;
    case "deferred-recovery-backoff":
      log(
        `recovering the interrupted runtime activation has failed ${result.failures} time(s); backing off. ` +
          `See ${path.join(os.homedir(), ".relay", "update.log")} for the cause.`,
      );
      break;
    case "deferred-migration-backoff":
      log(
        `moving ${result.current} into Relay's safe runtime has failed ${result.failures} time(s); backing off. ` +
          `See ${path.join(os.homedir(), ".relay", "update.log")} for the cause.`,
      );
      break;
    case "recovering-runtime":
      log("recovering an interrupted runtime activation before checking for updates.");
      break;
    case "activation-in-flight":
    case "migration-in-flight":
    case "recovery-in-flight":
      log("a Relay runtime transaction is already in progress.");
      break;
    default:
      log(`update check: ${result.status}`);
  }
  if (waitForTerminal && result.launch?.requestPath) {
    const terminal = await waitForUpdateRequestTerminal(result.launch.requestPath);
    return { ...result, terminal };
  }
  return result;
}
