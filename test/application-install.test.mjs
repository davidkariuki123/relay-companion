import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import bootstrap from "../bootstrap/relay-setup.cjs";
import installer from "../bootstrap/application-install.cjs";
import ownership from "../bootstrap/application-owner.cjs";
import removal from "../bootstrap/application-uninstall.cjs";
import recovery from "../bootstrap/application-recovery.cjs";
import { installRelayMacApp, installWindowsStartMenuShortcut } from "../src/install.js";

function fixture(t, existing = true) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-install-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const applicationRoot = path.join(homeDir, "Relay.app");
  const resourcesDir = path.join(applicationRoot, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  const executable = path.join(applicationRoot, "Relay");
  fs.writeFileSync(executable, "test executable");
  const receipt = { schema: 1, appId: ownership.APPLICATION_ID, distribution: "application", activationEnabled: true,
    packagingSourceSha: "a".repeat(40), version: "0.2.0", platform: `${process.platform}-${process.arch}` };
  fs.writeFileSync(path.join(resourcesDir, "candidate.json"), JSON.stringify(receipt));
  const runtimeRoot = path.join(homeDir, ".relay", "runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const pointer = path.join(runtimeRoot, "current.json");
  const previous = { schema: 1, active: true, state: "active", version: "0.1.550", releaseId: "old",
    packageRoot: path.join(runtimeRoot, "releases", "old", "node_modules", "relay-companion") };
  if (existing) {
    fs.writeFileSync(pointer, JSON.stringify(previous));
    fs.writeFileSync(path.join(homeDir, ".relay", "config.json"), '{"privateData":"stays byte-identical"}');
  }
  const events = [];
  const options = { homeDir, applicationRoot, resourcesDir, executable, activationEnabled: true,
    verify: async () => { events.push("verified"); return { receipt, platformKey: receipt.platform }; },
    acquireLock: () => { events.push("lock"); return { release: () => events.push("unlock") }; },
    health: async () => { events.push("health"); return { ok: true }; },
    recover: async () => { throw new Error("Unexpected recovery on a healthy installation"); },
    drain: async () => { events.push("drain"); return () => events.push("undrain"); },
    extract: (_bundle, root) => { events.push("extract"); return { packageRoot: path.join(root, "node_modules", "relay-companion"), bin: path.join(root, "relay.js") }; },
    activate: async (layout, runtime, version) => {
      events.push("activate");
      assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "application-migration.json"))).state, "activating");
      assert.ok(ownership.applicationOwner({ homeDir }));
      // The pill activation starts reads this on its first paint: it opens
      // centred with Continue with Google in place of the setup window.
      const intent = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "setup-intent.json"), "utf8"));
      assert.deepEqual({ ...intent, at: typeof intent.at }, { agentInstalled: true, application: true, at: "string", version: "0.2.0" });
      const candidate = { schema: 1, state: "active", active: true, version, ...runtime, releaseId: layout.releaseId };
      fs.writeFileSync(pointer, JSON.stringify(candidate));
      return { candidate };
    } };
  return { options, events, pointer, previous, receipt };
}

test("Dev installers select Dev on fresh setup and never silently retarget an existing stable installation", async t => {
  const fresh = fixture(t, false); fresh.receipt.channel = "dev";
  await installer.installFromApplication(fresh.options);
  const config = JSON.parse(fs.readFileSync(path.join(fresh.options.homeDir, ".relay", "config.json")));
  assert.equal(config.updateChannel, "dev"); assert.equal(config.apiUrl, "https://dev-api.sendrelays.com");
  const existing = fixture(t); existing.receipt.channel = "dev";
  await assert.rejects(installer.installFromApplication(existing.options), /Switch Relay to dev/);
  assert.deepEqual(JSON.parse(fs.readFileSync(existing.pointer)), existing.previous);
});

test("preview and missing activation permission cannot write to an installation", async (t) => {
  const { options } = fixture(t);
  await assert.rejects(installer.verifyBundle({ resourcesDir: options.resourcesDir }), /disabled/);
  fs.writeFileSync(path.join(options.resourcesDir, "candidate.json"), JSON.stringify({ distribution: "application-preview" }));
  await assert.rejects(installer.verifyBundle({ resourcesDir: options.resourcesDir, activationEnabled: true }), /preview/);
  assert.equal(fs.existsSync(path.join(options.homeDir, ".relay", "application-owner.json")), false);
});

test("online setup downloads before extraction, reports progress and cleans its staging files", async t => {
  for (const outcome of ["success", "network-failure", "cancelled"]) {
    const f = fixture(t);
    f.receipt.runtimeDelivery = "download";
    const artifact = { url: "https://api.sendrelays.com/exact-runtime", bytes: 4, sha512: "signed-digest" };
    f.options.verify = async () => ({ receipt: f.receipt, artifact, platformKey: f.receipt.platform });
    const progress = [], controller = new AbortController();
    const abandoned = path.join(f.options.homeDir, ".relay/runtime/releases/.relay-download-application-interrupted");
    fs.mkdirSync(abandoned, { recursive: true });
    fs.writeFileSync(path.join(abandoned, "runtime.tar.gz"), "partial");
    let downloaded;
    f.options.onProgress = value => progress.push(value);
    f.options.signal = controller.signal;
    f.options.download = async (url, file, identity, options) => {
      assert.equal(url, artifact.url); assert.deepEqual(identity, artifact);
      downloaded = file; fs.writeFileSync(file, "test");
      assert.equal(fs.existsSync(abandoned), false);
      assert.ok(!f.events.includes("extract")); assert.ok(!f.events.includes("drain"));
      options.onProgress({ receivedBytes: 4, totalBytes: 4 });
      if (outcome === "network-failure") throw new Error("offline");
      if (outcome === "cancelled") controller.abort();
    };
    if (outcome === "success") {
      const extract = f.options.extract;
      f.options.extract = (bundle, destination) => { assert.equal(bundle.archive, downloaded); return extract(bundle, destination); };
      assert.equal((await installer.installFromApplication(f.options)).ok, true);
      assert.deepEqual(progress.map(item => item.phase), ["verifying", "downloading", "downloading", "extracting", "installing", "ready"]);
    } else {
      await assert.rejects(installer.installFromApplication(f.options), /offline|abort/i);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.pointer)), f.previous);
      assert.ok(!f.events.includes("extract")); assert.ok(!f.events.includes("activate"));
    }
    assert.equal(fs.existsSync(path.dirname(downloaded)), false);
    assert.equal(f.events.at(-1), "unlock");
  }
});

test("download mode still verifies signed identity and bundled Node before touching the network", async t => {
  const f = fixture(t, false), platformKey = f.receipt.platform;
  const key = crypto.generateKeyPairSync("ed25519"), keyId = "relay-runtime-release-v1";
  const trustStore = { schema: 2, activeKeyId: keyId, keys: [{ keyId, algorithm: "ED25519_SHA_512", publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  const digest = `sha512-${crypto.createHash("sha512").update("runtime").digest("base64")}`;
  const artifact = { bytes: 7, sha512: digest, dependencyLockSha512: digest, url: `https://api.sendrelays.com/v1/companion-releases/v0.2.0/relay-runtime-0.2.0-${platformKey}.tar.gz` };
  const sourceSha = "b".repeat(40);
  const payload = Buffer.from(JSON.stringify({ product: "Relay", version: "0.2.0", sourceSha, artifacts: { [platformKey]: artifact } }));
  const envelope = { schema: 1, algorithm: "ED25519_SHA_512", keyId, payload: payload.toString("base64"), signature: crypto.sign(null, payload, key.privateKey).toString("base64") };
  fs.writeFileSync(path.join(f.options.resourcesDir, "runtime-manifest.json"), JSON.stringify(envelope));
  const node = path.join(f.options.resourcesDir, process.platform === "win32" ? "node.exe" : "node");
  fs.writeFileSync(node, "test node");
  Object.assign(f.receipt, { packagingSourceDirty: false, runtimeDelivery: "download", runtimeSourceSha: sourceSha,
    nodeSha256: crypto.createHash("sha256").update("test node").digest("hex") });
  fs.writeFileSync(path.join(f.options.resourcesDir, "candidate.json"), JSON.stringify(f.receipt));
  const options = { resourcesDir: f.options.resourcesDir, activationEnabled: true, platformKey, trustStore };
  assert.equal(bootstrap.parseSignedManifest(Buffer.from(JSON.stringify(envelope)), { version: "0.2.0", platformKey, trustStore }).artifact.url, artifact.url);
  const result = await installer.verifyBundle(options);
  assert.equal(result.archive, null); assert.deepEqual(result.artifact, artifact);
  fs.appendFileSync(node, "tampered");
  await assert.rejects(installer.verifyBundle(options), /Node digest/);
  envelope.signature = Buffer.alloc(64).toString("base64");
  fs.writeFileSync(path.join(f.options.resourcesDir, "runtime-manifest.json"), JSON.stringify(envelope));
  await assert.rejects(installer.verifyBundle(options), /signature/);
});

test("fresh and bridge installation share existing transaction engine and preserve account data", async (t) => {
  for (const existing of [false, true]) {
    const { options, events } = fixture(t, existing);
    const result = await installer.installFromApplication(options);
    assert.equal(result.ok, true);
    assert.equal(result.updateOwner, "canonical-runtime");
    assert.ok(events.indexOf("verified") < events.indexOf("lock"));
    assert.ok(events.indexOf("drain") < events.indexOf("activate"));
    assert.deepEqual(events.slice(-2), ["undrain", "unlock"]);
    if (existing) assert.equal(fs.readFileSync(path.join(options.homeDir, ".relay", "config.json"), "utf8"), '{"privateData":"stays byte-identical"}');
    assert.equal((await installer.installFromApplication(options)).alreadyInstalled, true);
    assert.equal(events.filter((event) => event === "activate").length, 1);
  }
});

test("unhealthy installations recover with the staged candidate; newer versions stay untouched", async t => {
  const f = fixture(t);
  f.options.health = async () => ({ ok: false });
  f.options.recover = async ({ releaseRoot, homeDir }) => {
    assert.ok(f.events.includes("extract"));
    f.events.push("recover");
    recovery.resetState({ homeDir, releaseRoot });
  };
  assert.equal((await installer.installFromApplication(f.options)).recovered, true);
  assert.ok(f.events.indexOf("recover") < f.events.indexOf("activate"));
  assert.equal(fs.existsSync(path.join(f.options.homeDir, ".relay/config.json")), false);
  const newer = fixture(t);
  fs.writeFileSync(newer.pointer, JSON.stringify({ ...newer.previous, version: "1.0.0", active: false }));
  const before = fs.readFileSync(newer.pointer);
  await assert.rejects(installer.installFromApplication(newer.options), /downgrade/);
  assert.deepEqual(fs.readFileSync(newer.pointer), before);
  assert.ok(!newer.events.includes("extract"));
});

test("legacy versions and broken journals recover without invoking their old CLI", async t => {
  for (const mode of ["legacy", "0.1.267", "0.1.326", "0.1.413", "0.1.440", "0.1.454", "0.1.490", "corrupt-pointer", "corrupt-config", "interrupted"]) {
    const f = fixture(t);
    if (mode === "legacy") fs.rmSync(f.pointer);
    else if (mode === "corrupt-pointer") fs.writeFileSync(f.pointer, "{");
    else if (mode === "corrupt-config") fs.writeFileSync(path.join(f.options.homeDir, ".relay/config.json"), "{");
    else if (mode === "interrupted") fs.writeFileSync(path.join(f.options.homeDir, ".relay/application-migration.json"), '{"state":"activating"}');
    else fs.writeFileSync(f.pointer, JSON.stringify({ ...f.previous, version: mode }));
    f.options.recover = async ({ homeDir, releaseRoot }) => {
      assert.ok(f.events.includes("extract"));
      recovery.resetState({ homeDir, releaseRoot });
    };
    assert.equal((await installer.installFromApplication(f.options)).recovered, true, mode);
    assert.equal(recovery.marker(recovery.journalPath(f.options.homeDir)).state, "complete");
    assert.equal((await installer.installFromApplication(f.options)).alreadyInstalled, true);
  }
});

test("cleanup interruption retains a retry journal and never reports ready", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.pointer, "{");
  const phases = [];
  f.options.onProgress = event => phases.push(event.phase);
  f.options.recover = async () => { throw Error("locked file"); };
  await assert.rejects(installer.installFromApplication(f.options), /locked file/);
  assert.equal(recovery.marker(recovery.journalPath(f.options.homeDir)).state, "cleaning");
  assert.ok(!phases.includes("ready"));
  f.options.recover = async ({ homeDir, releaseRoot }) => recovery.resetState({ homeDir, releaseRoot });
  assert.equal((await installer.installFromApplication(f.options)).recovered, true);
});

test("an ordinary application reopen cannot reset data after a transient health failure", async t => {
  const f = fixture(t);
  f.options.health = async () => ({ ok: false });
  f.options.allowRecovery = false;
  const before = fs.readFileSync(f.pointer);
  await assert.rejects(installer.installFromApplication(f.options), /Run setup again/);
  assert.deepEqual(fs.readFileSync(f.pointer), before);
  assert.ok(!f.events.includes("extract"));
  assert.equal(fs.existsSync(recovery.journalPath(f.options.homeDir)), false);
});

test("retry survives interruption after reset and during activation", async t => {
  for (const phase of ["after-reset", "activation"]) {
    const f = fixture(t);
    fs.writeFileSync(f.pointer, "{");
    const activate = f.options.activate;
    f.options.recover = async ({ homeDir, releaseRoot }) => {
      recovery.resetState({ homeDir, releaseRoot });
      if (phase === "after-reset") throw Error("interrupted after cleanup");
    };
    if (phase === "activation") f.options.activate = async () => { throw Error("interrupted activation"); };
    await assert.rejects(installer.installFromApplication(f.options), /interrupted/);
    assert.notEqual(recovery.marker(recovery.journalPath(f.options.homeDir)).state, "complete");
    f.options.recover = async ({ homeDir, releaseRoot }) => recovery.resetState({ homeDir, releaseRoot });
    f.options.activate = activate;
    assert.equal((await installer.installFromApplication(f.options)).recovered, true);
    assert.equal((await installer.installFromApplication(f.options)).alreadyInstalled, true);
  }
});

test("a newer interrupted candidate cannot be reset by an older installer", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.pointer, JSON.stringify({ state: "activating", candidate: { version: "1.0.0" } }));
  await assert.rejects(installer.installFromApplication(f.options), /downgrade/);
  assert.ok(!f.events.includes("extract"));
});

test("failed download or extraction never clears a broken installation", async t => {
  for (const failure of ["download", "extract"]) {
    const f = fixture(t);
    fs.writeFileSync(f.pointer, "{");
    if (failure === "download") {
      f.receipt.runtimeDelivery = "download";
      f.options.verify = async () => ({ receipt: f.receipt, platformKey: f.receipt.platform, artifact: { bytes: 12, url: "unused" } });
      f.options.download = async () => { throw Error("offline"); };
    } else f.options.extract = () => { throw Error("bad archive"); };
    await assert.rejects(installer.installFromApplication(f.options), /offline|bad archive/);
    assert.equal(fs.readFileSync(f.pointer, "utf8"), "{");
    assert.equal(fs.existsSync(recovery.journalPath(f.options.homeDir)), false);
  }
});

test("outer-package versions advance independently and cannot downgrade the recorded application", async t => {
  const { options, receipt, events } = fixture(t);
  receipt.applicationVersion = "1.0.0";
  const receiptFile = path.join(options.resourcesDir, "candidate.json");
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await installer.installFromApplication(options);
  receipt.applicationVersion = "1.0.1";
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const updated = await installer.installFromApplication(options);
  assert.equal(updated.owner.applicationVersion, "1.0.1");
  assert.equal(events.filter(event => event === "activate").length, 2);
  receipt.applicationVersion = "1.0.0";
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await assert.rejects(installer.installFromApplication(options), /downgrade the Relay application/);
  assert.equal(events.filter(event => event === "activate").length, 2);
});

test("service rollback restores launcher ownership, failed rollback retains recovery journal", async (t) => {
  for (const restore of [true, false]) {
    const { options, pointer } = fixture(t);
    options.activate = async () => {
      if (!restore) fs.writeFileSync(pointer, JSON.stringify({ state: "recovery-required", active: false }));
      throw new Error("activation failure");
    };
    await assert.rejects(installer.installFromApplication(options), /activation failure/);
    const journal = JSON.parse(fs.readFileSync(path.join(options.homeDir, ".relay", "application-migration.json")));
    assert.equal(journal.state, restore ? "rolled-back" : "recovery-required");
    assert.equal(fs.existsSync(path.join(options.homeDir, ".relay", "application-owner.json")), !restore);
  }
});

test("interrupted commit reconciles only with exact running target proof", async (t) => {
  const { options, pointer, previous } = fixture(t);
  await installer.installFromApplication(options);
  const journalPath = path.join(options.homeDir, ".relay", "application-migration.json");
  const journal = JSON.parse(fs.readFileSync(journalPath));
  fs.writeFileSync(journalPath, JSON.stringify({ ...journal, state: "activating" }));

  assert.equal((await installer.reconcileApplication({ ...options, health: async () => ({ ok: false }) })).ok, false);
  assert.equal((await installer.reconcileApplication(options)).state, "complete");
  fs.writeFileSync(journalPath, JSON.stringify({ ...journal, state: "recovery-required" }));
  fs.writeFileSync(pointer, JSON.stringify(previous));
  assert.equal((await installer.reconcileApplication(options)).state, "rolled-back");
  assert.equal(fs.existsSync(path.join(options.homeDir, ".relay", "application-owner.json")), false);
});

test("valid native ownership protects installers' launchers; missing and preview receipts do not", (t) => {
  const { options, receipt } = fixture(t);
  const marker = { schema: 1, appId: ownership.APPLICATION_ID, root: options.applicationRoot, executable: options.executable,
    receipt: path.join(options.resourcesDir, "candidate.json"), updateOwner: "canonical-runtime", installationId: crypto.randomUUID(),
    version: receipt.version, packagingSourceSha: receipt.packagingSourceSha };
  for (const platform of ["darwin", "win32"]) {
    fs.writeFileSync(marker.receipt, JSON.stringify({ ...receipt, platform: `${platform}-${process.arch}` }));
    fs.writeFileSync(path.join(options.homeDir, ".relay", "application-owner.json"), JSON.stringify({ ...marker, platform }));
    assert.ok(ownership.applicationOwner({ homeDir: options.homeDir, platform }));
    const result = platform === "darwin" ? installRelayMacApp({ homeDir: options.homeDir })
      : installWindowsStartMenuShortcut({ homeDir: options.homeDir, platform });
    assert.equal(result.nativeApplication, true);
    fs.writeFileSync(marker.receipt, JSON.stringify({ ...receipt, platform: `${platform}-${process.arch}`,
      version: "99.0.0", packagingSourceSha: "e".repeat(40) }));
    const upgraded = ownership.applicationOwner({ homeDir: options.homeDir, platform });
    assert.equal(upgraded.installedPackageVersion, "99.0.0");
    assert.equal(upgraded.version, marker.version);
    fs.writeFileSync(marker.receipt, JSON.stringify({ ...receipt, platform: `${platform}-${process.arch}`,
      version: "0.0.1" }));
    assert.equal(ownership.applicationOwner({ homeDir: options.homeDir, platform }), null);
    fs.writeFileSync(marker.receipt, JSON.stringify({ ...receipt, platform: `${platform}-${process.arch}`,
      packagingSourceSha: "f".repeat(40) }));
    assert.equal(ownership.applicationOwner({ homeDir: options.homeDir, platform }), null);
    fs.writeFileSync(marker.receipt, JSON.stringify({ ...receipt, distribution: "application-preview" }));
    assert.equal(ownership.applicationOwner({ homeDir: options.homeDir, platform }), null);
  }
});

test("application uninstall keeps data, can be retried, and can be followed by reinstall", async (t) => {
  const { options, pointer } = fixture(t);
  await installer.installFromApplication(options);
  const current = JSON.parse(fs.readFileSync(pointer));
  fs.mkdirSync(path.dirname(current.bin), { recursive: true });
  fs.writeFileSync(current.bin, "test cli");
  fs.writeFileSync(pointer, JSON.stringify({ ...current, node: process.execPath }));
  const commands = [];
  const removeOptions = { ...options, confirmed: true, run: (command, args) => { commands.push({ command, args }); return { status: 0 }; } };
  await assert.rejects(removal.uninstallFromApplication({ ...removeOptions, confirmed: false }), /confirmation/);
  assert.equal(commands.length, 0);
  assert.equal((await removal.uninstallFromApplication(removeOptions)).accountDataPreserved, true);
  assert.deepEqual(commands[0].args, [current.bin, "uninstall", "--no-trampoline"]);
  assert.equal(ownership.applicationOwner({ homeDir: options.homeDir }), null);
  assert.equal(JSON.parse(fs.readFileSync(pointer)).state, "inactive");
  assert.equal((await removal.uninstallFromApplication(removeOptions)).alreadyRemoved, true);
  const uninstallJournal = path.join(options.homeDir, ".relay", "application-uninstall.json");
  const completed = JSON.parse(fs.readFileSync(uninstallJournal));
  fs.writeFileSync(uninstallJournal, JSON.stringify({ ...completed, state: "removing" }));
  assert.equal((await removal.uninstallFromApplication(removeOptions)).alreadyRemoved, true);
  assert.equal(commands.length, 1);
  assert.equal(fs.readFileSync(path.join(options.homeDir, ".relay", "config.json"), "utf8"), '{"privateData":"stays byte-identical"}');
  assert.equal((await installer.installFromApplication(options)).ok, true);
  assert.ok(ownership.applicationOwner({ homeDir: options.homeDir }));
});

test("failed uninstall does not claim removal or discard ownership", async (t) => {
  const { options, pointer } = fixture(t);
  await installer.installFromApplication(options);
  const current = JSON.parse(fs.readFileSync(pointer));
  fs.mkdirSync(path.dirname(current.bin), { recursive: true });
  fs.writeFileSync(current.bin, "test cli");
  fs.writeFileSync(pointer, JSON.stringify({ ...current, node: process.execPath }));
  await assert.rejects(removal.uninstallFromApplication({ ...options, confirmed: true, run: () => ({ status: 1 }) }), /incomplete/);
  assert.ok(ownership.applicationOwner({ homeDir: options.homeDir }));
  assert.equal(JSON.parse(fs.readFileSync(pointer)).active, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.homeDir, ".relay", "application-uninstall.json"))).state, "removing");
});

test("an unconfigured native package can be removed without touching an existing Relay", async (t) => {
  const { options, pointer } = fixture(t);
  const before = fs.readFileSync(pointer);
  const result = await removal.uninstallFromApplication({ ...options, confirmed: true, allowUnconfigured: true,
    run: () => assert.fail("No existing Relay may be uninstalled") });
  assert.equal(result.unconfigured, true);
  assert.deepEqual(fs.readFileSync(pointer), before);
  assert.equal(fs.existsSync(path.join(options.homeDir, ".relay", "application-uninstall.json")), false);
});

test("an installed app is replaced over a newer healthy runtime, which keeps running untouched", async t => {
  const f = fixture(t), homeDir = f.options.homeDir;
  const newer = { ...f.previous, version: "0.3.0" };
  fs.writeFileSync(f.pointer, JSON.stringify(newer));
  const ownerFile = path.join(homeDir, ".relay", "application-owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify({ schema: 1, appId: ownership.APPLICATION_ID, platform: process.platform,
    root: path.join(homeDir, "Old.app"), version: "0.1.900", applicationVersion: "0.1.900", packagingSourceSha: "c".repeat(40),
    installationId: "kept-installation", updateOwner: "canonical-runtime" }));
  const result = await installer.installFromApplication(f.options);
  assert.equal(result.applicationOnly, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pointer)), newer);
  assert.ok(!f.events.includes("extract") && !f.events.includes("activate"));
  const owner = JSON.parse(fs.readFileSync(ownerFile));
  assert.equal(owner.packagingSourceSha, f.receipt.packagingSourceSha);
  assert.equal(owner.installationId, "kept-installation");
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "application-migration.json"))).runtimeKept, true);
  // Under a broken newer runtime the older app still refuses: repair belongs to the runtime.
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, installationId: "kept-installation" }));
  await assert.rejects(installer.installFromApplication({ ...f.options, health: async () => ({ ok: false }) }), /cannot downgrade Relay/);
  // Without an installed app, the same newer runtime is refused as before.
  const legacy = fixture(t);
  fs.writeFileSync(legacy.pointer, JSON.stringify({ ...legacy.previous, version: "0.3.0" }));
  await assert.rejects(installer.installFromApplication(legacy.options), /cannot downgrade Relay/);
});

test("setup pauses Relay's own recovery checks, waits out a run in progress, and resumes afterwards", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pause-recovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const intent = path.join(homeDir, ".relay", "recovery", "intent.json");
  fs.mkdirSync(path.dirname(intent), { recursive: true });
  // A recovery run holds its run lock; the pause waits until it finishes.
  const running = bootstrap.acquireCanonicalLock(path.join(homeDir, ".relay", "recovery", "run.lock"));
  let waits = 0;
  const paused = await installer.pauseRecoveryChecks({ homeDir, pollMs: 1, sleep: async () => { waits++; running.release(); } });
  assert.equal(waits, 1);
  assert.equal(JSON.parse(fs.readFileSync(intent, "utf8")).stopped, true);
  paused.resume(true);
  assert.equal(JSON.parse(fs.readFileSync(intent, "utf8")).stopped, false, "a successful setup leaves recovery running");
  // A Relay that was deliberately stopped stays stopped when setup fails.
  fs.writeFileSync(intent, JSON.stringify({ schema: 1, stopped: true }));
  (await installer.pauseRecoveryChecks({ homeDir })).resume(false);
  assert.equal(JSON.parse(fs.readFileSync(intent, "utf8")).stopped, true);
});

test("activation runs with recovery paused, and recovery resumes whether setup succeeds or fails", async t => {
  for (const fails of [false, true]) {
    const f = fixture(t), calls = [];
    const pauseRecovery = async () => { calls.push("pause"); return { repause: () => calls.push("repause"), resume: ok => calls.push(`resume:${ok}`) }; };
    const activate = f.options.activate;
    const options = { ...f.options, pauseRecovery, activate: async (...args) => {
      calls.push("activate");
      if (fails) throw new Error("activation failed");
      return activate(...args);
    } };
    if (fails) await assert.rejects(installer.installFromApplication(options), /activation failed/);
    else assert.equal((await installer.installFromApplication(options)).ok, true);
    assert.deepEqual(calls, ["pause", "repause", "activate", `resume:${!fails}`]);
  }
});
