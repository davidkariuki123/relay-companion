import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import release from "../bootstrap/application-release.cjs";
import native from "../bootstrap/application-package.cjs";
import bridge from "../bootstrap/application-handoff.cjs";
import updates from "../bootstrap/application-update.cjs";
import { startApplicationMaintenance, submitApplicationWorker } from "../src/application-maintenance.js";
import notices from "../overlay/application-update-notice.cjs";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-handoff-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const data = Buffer.from("verified installer bytes"), version = "0.2.0", sourceSha = "a".repeat(40);
  const payload = { schema: 2, channel: "stable", rollout: { nativeUpdates: true, migrateDeviceIds: ["dev_fixture_device"], expiresAt: Date.now() + 86400000 }, product: "Relay Application", version, sourceSha,
    runtime: { version, sourceSha: "b".repeat(40) },
    artifacts: Object.fromEntries(release.PLATFORMS.map(platform => [platform,
      (platform.startsWith("darwin") ? ["dmg", "zip"] : platform.startsWith("win32") ? ["exe"] : ["deb", "rpm"])
        .map(kind => ({ kind, bytes: data.length, sha512: `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`,
          url: `https://api.sendrelays.com/v1/application-releases/v${version}/Relay-${version}-${platform}.${kind}` }))])) };
  const key = crypto.generateKeyPairSync("ed25519"), bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { schema: 1, algorithm: "ED25519_SHA_512", keyId: "relay-runtime-release-v1",
    payload: bytes.toString("base64"), signature: crypto.sign(null, bytes, key.privateKey).toString("base64") };
  const trustStore = { schema: 2, activeKeyId: envelope.keyId, keys: [{ keyId: envelope.keyId, algorithm: envelope.algorithm,
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  const file = path.join(homeDir, "installer.exe"); fs.writeFileSync(file, data);
  const pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  const packageRoot = path.join(path.dirname(pointer), "releases", "previous", "node_modules", "relay-companion");
  const previous = { schema: 1, active: true, state: "active", version: "0.1.600", packageRoot,
    node: process.execPath, bin: path.join(packageRoot, "bin", "relay.js"), releaseId: "previous" };
  fs.mkdirSync(path.dirname(previous.bin), { recursive: true }); fs.writeFileSync(previous.bin, "fixture");
  fs.writeFileSync(pointer, JSON.stringify(previous));
  fs.writeFileSync(path.join(homeDir, ".relay", "config.json"), JSON.stringify({ deviceId: "dev_fixture_device" }));
  const workDir = path.join(homeDir, "work"); fs.mkdirSync(workDir);
  return { homeDir, data, payload, envelope, trustStore, file, pointer, previous, workDir, version, sourceSha, env: {} };
}
function writePackage(location, f, platform = process.platform) {
  fs.mkdirSync(location.resourcesDir, { recursive: true }); fs.mkdirSync(path.dirname(location.executable), { recursive: true });
  fs.writeFileSync(location.executable, "fixture executable");
  fs.writeFileSync(path.join(location.resourcesDir, "candidate.json"), JSON.stringify({ schema: 1, appId: "work.relay.application",
    distribution: "application", activationEnabled: true, packagingSourceDirty: false, version: f.version,
    packagingSourceSha: f.sourceSha, runtimeSourceSha: f.payload.runtime.sourceSha, platform: `${platform}-${process.arch}` }));
}
function options(f) {
  const calls = [];
  const location = { root: path.join(f.homeDir, "Relay.app"), resourcesDir: path.join(f.homeDir, "Relay.app", "resources"), executable: path.join(f.homeDir, "Relay.app", "relay") };
  const config = { ...f, activationEnabled: true,
    health: async () => ({ ok: true }), ready: async () => ({ ok: true }), verifyRecovery: () => ({ ok: true }),
    drain: async () => { calls.push("drain"); return () => calls.push("undrain"); },
    installPackage: async () => { calls.push("package"); writePackage(location, f); return { ok: true, ...location }; },
    activate: async () => {
      calls.push("activate");
      bridge.write(f.pointer, { ...f.previous, version: f.version, releaseId: "candidate", packageRoot: f.previous.packageRoot.replace("previous", "candidate") });
      bridge.write(path.join(f.homeDir, ".relay", "application-owner.json"), { schema: 1, appId: "work.relay.application", platform: process.platform,
        root: location.root, receipt: path.join(location.resourcesDir, "candidate.json"), executable: location.executable,
        version: f.version, packagingSourceSha: f.sourceSha, installationId: crypto.randomUUID(), updateOwner: "canonical-runtime" });
      return { ok: true };
    },
    run: () => { calls.push("repair"); return { status: 0 }; },
  };
  return { config, calls };
}

test("native handoff and explicitly disabled maintenance are inert", async () => {
  assert.equal((await bridge.handoffApplication()).state, "disabled");
  assert.equal((await native.installNativePackage()).state, "disabled");
  assert.equal((await updates.checkApplicationUpdate({ activationEnabled: false, fetchImpl: () => assert.fail("network") })).state, "disabled");
  assert.equal(startApplicationMaintenance({ enabled: false, setIntervalImpl: () => assert.fail("timer"), spawnImpl: () => assert.fail("spawn") }), null);
  assert.equal(notices.startInstallerNotices({ enabled: false, setIntervalImpl: () => assert.fail("notification timer") }), null);
});

test("invalid native signature or bytes cannot start the bridge", async t => {
  const f = fixture(t), { config, calls } = options(f);
  await assert.rejects(bridge.handoffApplication({ ...config, envelope: { ...f.envelope, signature: Buffer.alloc(64).toString("base64") } }), /signature/);
  fs.writeFileSync(f.file, "tampered");
  await assert.rejects(bridge.handoffApplication(config), /size|digest/);
  assert.deepEqual(calls, []);
  assert.deepEqual(bridge.read(f.pointer), f.previous);
});

test("healthy native handoff shares the canonical lease and retains the previous runtime", async t => {
  const f = fixture(t), { config, calls } = options(f);
  const result = await bridge.handoffApplication(config);
  assert.equal(result.state, "complete");
  assert.deepEqual(calls, ["drain", "package", "activate", "undrain"]);
  assert.ok(fs.existsSync(f.previous.bin));
  assert.equal(bridge.read(path.join(f.homeDir, ".relay", "application-handoff-complete.json")).previousRuntimeRetained, true);
  const count = calls.length;
  assert.equal((await bridge.handoffApplication(config)).state, "complete");
  assert.equal(calls.length, count);
});

test("failed independent recovery restores the working runtime without uninstalling the native package", async t => {
  const f = fixture(t), { config, calls } = options(f);
  const result = await bridge.handoffApplication({ ...config, verifyRecovery: () => ({ ok: false }) });
  assert.equal(result.state, "rolled-back");
  assert.deepEqual(bridge.read(f.pointer), f.previous);
  assert.ok(calls.includes("repair"));
  assert.ok(fs.existsSync(path.join(f.homeDir, "Relay.app")));
  assert.equal(fs.existsSync(path.join(f.homeDir, ".relay", "application-handoff-complete.json")), false);
});

test("unhealthy and newer legacy runtimes never reach native installation", async t => {
  for (const kind of ["unhealthy", "newer"]) {
    const f = fixture(t), { config, calls } = options(f);
    if (kind === "newer") bridge.write(f.pointer, { ...f.previous, version: "9.0.0" });
    else config.health = async () => ({ ok: false });
    assert.equal((await bridge.handoffApplication(config)).state, kind === "newer" ? "deferred" : "preparing");
    assert.deepEqual(calls, []);
  }
});

test("an interrupted older handoff cannot roll back a newer working runtime", async t => {
  const f = fixture(t), { config, calls } = options(f);
  const directory = path.join(f.homeDir, ".relay", "application-packages", `${f.version}-${f.sourceSha}-${process.platform}-${process.arch}`);
  bridge.write(path.join(directory, "bridge.json"), { schema: 1, transactionId: `application_${f.sourceSha}_${process.platform}-${process.arch}`,
    target: { version: f.version, sourceSha: f.sourceSha }, state: "preparing", completed: ["ownership-transferred"], pending: "application-healthy" });
  const newer = { ...f.previous, version: "9.0.0" }; bridge.write(f.pointer, newer);
  assert.equal((await bridge.handoffApplication(config)).state, "deferred");
  assert.deepEqual(bridge.read(f.pointer), newer); assert.deepEqual(calls, []);
});

test("Linux installer notices only reveal a manifest-bound file with verified bytes", async t => {
  const f = fixture(t), platform = "linux", arch = process.arch;
  const directory = path.join(f.homeDir, ".relay", "application-packages", `${f.version}-${f.sourceSha}-${platform}-${arch}`);
  const artifact = path.join(directory, "installer.deb");
  bridge.write(path.join(directory, "manifest.json"), f.envelope); fs.writeFileSync(artifact, f.data);
  const statusFile = path.join(f.homeDir, ".relay", "application-update.json");
  const status = { state: "installer-action-required", version: f.version, sourceSha: f.sourceSha, artifact };
  bridge.write(statusFile, status);
  assert.equal((await notices.pendingInstaller({ ...f, platform, arch })).file, artifact);
  bridge.write(statusFile, { ...status, artifact: f.file });
  assert.equal(await notices.pendingInstaller({ ...f, platform, arch }), null);
  bridge.write(statusFile, status); fs.writeFileSync(artifact, "tampered");
  await assert.rejects(notices.pendingInstaller({ ...f, platform, arch }), /size|digest/);
});

test("Linux background package updates request normal installer action without elevation", async t => {
  const f = fixture(t);
  const result = await native.installNativePackage({ ...f, platform: "linux", arch: process.arch, activationEnabled: true,
    artifact: f.payload.artifacts[`linux-${process.arch}`][0], run: () => assert.fail("must not sudo, pkexec or edit /opt") });
  assert.equal(result.state, "installer-action-required");
  assert.equal(result.changed, false);
});

test("NSIS handoff uses an exact verified per-user package and checks its installed receipt", async t => {
  const f = fixture(t), env = { LOCALAPPDATA: path.join(f.homeDir, "Local With Spaces") };
  const location = native.packageLocation({ homeDir: f.homeDir, platform: "win32", env });
  let invoked = 0;
  const result = await native.installNativePackage({ ...f, env, platform: "win32", arch: process.arch, activationEnabled: true,
    artifact: f.payload.artifacts[`win32-${process.arch}`][0], run: (command, args, opts) => {
      invoked++;
      assert.equal(command, f.file); assert.deepEqual(args, ["/S", `/D=${location.root}`]);
      assert.equal(opts.windowsVerbatimArguments, true); assert.equal(opts.windowsHide, true);
      writePackage(location, f, "win32"); return { status: 0 };
    } });
  assert.equal(result.ok, true); assert.equal(invoked, 1);
});

test("Mac handoff verifies the extracted signed app and can resume after its atomic move", async t => {
  const f = fixture(t); let checked = 0;
  fs.mkdirSync(path.join(f.workDir, "mac-package"));
  fs.writeFileSync(path.join(f.workDir, "mac-package", "partial"), "interrupted extraction");
  const config = { ...f, platform: "darwin", arch: process.arch, activationEnabled: true,
    artifact: f.payload.artifacts[`darwin-${process.arch}`][1], verifyMac: () => checked++, verifyZip: () => {},
    run: (command, args) => {
      if (command.endsWith("unzip")) return { status: 0, stdout: "Relay.app/Contents/Info.plist\n" };
      assert.ok(command.endsWith("ditto"));
      const root = path.join(args.at(-1), "Relay.app");
      writePackage({ root, resourcesDir: path.join(root, "Contents", "Resources"), executable: path.join(root, "Contents", "MacOS", "Relay") }, f, "darwin");
      return { status: 0 };
    } };
  assert.equal((await native.installNativePackage(config)).ok, true);
  assert.ok(fs.readdirSync(f.workDir).some(name => name.startsWith("incomplete-mac-package-")));
  assert.equal((await native.installNativePackage(config)).alreadyInstalled, true);
  assert.equal(checked, 3);
  assert.throws(() => native.validateZipListing("Relay.app/../../escape"), /Unsafe/);
});

test("interrupted native package writes can resume without adopting an unrelated destination", async t => {
  const f = fixture(t), env = { LOCALAPPDATA: path.join(f.homeDir, "Local") };
  const location = native.packageLocation({ homeDir: f.homeDir, platform: "win32", env });
  const config = { ...f, env, platform: "win32", arch: process.arch, activationEnabled: true, artifact: f.payload.artifacts[`win32-${process.arch}`][0] };
  await assert.rejects(native.installNativePackage({ ...config, run: () => { fs.mkdirSync(location.root, { recursive: true }); return { status: 1, stderr: "interrupted" }; } }), /interrupted/);
  assert.equal((await native.installNativePackage({ ...config, run: () => { writePackage(location, f, "win32"); return { status: 0 }; } })).ok, true);
  fs.unlinkSync(path.join(location.resourcesDir, "candidate.json"));
  await assert.rejects(native.installNativePackage({ ...config, run: () => assert.fail("unrelated destination") }), /not an owned/);
});

test("application checks honor opt-out, verify signed offers, download once and back off", async t => {
  const f = fixture(t); let network = 0, handoffs = 0, downloads = 0;
  const config = { ...f, activationEnabled: true, fetchImpl: async () => { network++; return new Response(JSON.stringify(f.envelope)); },
    download: async (_url, file) => { downloads++; fs.writeFileSync(file, f.data); },
    handoff: async () => { handoffs++; return { state: "complete" }; } };
  bridge.write(path.join(f.homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: false });
  assert.equal((await updates.checkApplicationUpdate(config)).state, "updates-disabled");
  assert.equal(network, 0);
  bridge.write(path.join(f.homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: true });
  assert.equal((await updates.checkApplicationUpdate(config)).state, "complete");
  assert.equal((await updates.checkApplicationUpdate(config)).state, "backoff");
  assert.deepEqual([network, downloads, handoffs], [2, 1, 1]);
});

test("stable installer checks preserve developer channels and environment opt-outs", async t => {
  const f = fixture(t);
  for (const env of [{ RELAY_AUTO_UPDATE: "off" }, { RELAY_UPDATE_CHANNEL: "staging" }, { RELAY_CONFIG: "/custom/config.json" }]) {
    const result = await updates.checkApplicationUpdate({ ...f, activationEnabled: true, env, fetchImpl: () => assert.fail("must preserve configuration") });
    assert.equal(result.changed, false);
  }
});

test("migration selection can pause independently of native servicing and cannot outlive its signed policy", () => {
  const now = Date.now(), payload = { schema: 2, rollout: { nativeUpdates: true, migrateDeviceIds: [], expiresAt: now + 86400000 } };
  assert.equal(updates.rolloutDecision(payload, { now, deviceId: "dev_not_selected" }), "migration-not-selected");
  assert.equal(updates.rolloutDecision(payload, { now, owner: {} }), null);
  payload.rollout.migrateDeviceIds = ["dev_selected"];
  assert.equal(updates.rolloutDecision(payload, { now, deviceId: "dev_selected" }), null);
  payload.rollout.nativeUpdates = false;
  assert.equal(updates.rolloutDecision(payload, { now, owner: {} }), "native-updates-paused");
  assert.equal(updates.rolloutDecision(payload, { now: now + 86400001, deviceId: "dev_selected" }), "rollout-policy-expired");
});

test("native workers use independent supervisors and a deadline outside daemon services", async t => {
  const f = fixture(t);
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    assert.equal(await submitApplicationWorker({ ...f, platform, env: { NODE_OPTIONS: "unsafe" },
      run: (file, args, options) => { assert.equal(options.env.NODE_OPTIONS, undefined); calls.push([file, ...args]); return { status: args[0] === "list" ? 1 : 0 }; },
      launchHidden: (parts, options) => { assert.equal(options.env.NODE_OPTIONS, undefined); calls.push(parts); return { ok: true }; } }), true);
    assert.match(calls.at(-1).join(" "), /update-watchdog\.cjs.*application-update\.cjs/);
    if (platform === "linux") assert.equal(calls[0][0], "systemd-run");
    if (platform === "darwin") assert.ok(calls.at(-1).includes("submit"));
  }
});

test("Windows recovery proof follows the task's exact hidden launcher wrapper", t => {
  const f = fixture(t), root = path.join(f.homeDir, ".relay", "recovery"), node = path.join(root, "node", "node.exe");
  bridge.write(path.join(root, "current.json"), { schema: 1, version: f.version, node, bundle: path.join(root, "versions", "a".repeat(64)) });
  bridge.write(path.join(root, "launcher-node.json"), { node });
  const launcher = path.join(root, "launch.cjs"), wrapper = path.join(root, "launch.vbs");
  fs.writeFileSync(wrapper, `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("${`"${node}" "${launcher}"`.replaceAll('"', '""')}", 0, True)\r\n`);
  const run = command => ({ status: 0, stdout: command === "schtasks.exe" ? `<Enabled>true</Enabled><Command>wscript.exe</Command><Arguments>//B &quot;${wrapper}&quot;</Arguments>` : "ok" });
  assert.equal(bridge.recoveryProof({ ...f, platform: "win32", run }).ok, true);
  fs.appendFileSync(wrapper, "changed");
  assert.equal(bridge.recoveryProof({ ...f, platform: "win32", run }).ok, false);
});

test("Mac ZIP inventory rejects escaping links and writes through links before extraction", t => {
  const f = fixture(t);
  function archive(entries) {
    const locals = [], directory = []; let offset = 0;
    for (const { name, data = "", link = false } of entries) {
      const filename = Buffer.from(name), bytes = Buffer.from(data), header = Buffer.alloc(30), central = Buffer.alloc(46);
      header.writeUInt32LE(0x04034b50); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
      central.writeUInt32LE(0x02014b50); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
      central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(((link ? 0xa1ff : 0x81a4) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
      const local = Buffer.concat([header, filename, bytes]); locals.push(local); directory.push(central, filename); offset += local.length;
    }
    const central = Buffer.concat(directory), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeFileSync(f.file, Buffer.concat([...locals, central, end]));
  }
  archive([{ name: "Relay.app/Contents/file", data: "safe" }, { name: "Relay.app/Contents/link", data: "file", link: true }]);
  native.validateZipFile(f.file);
  archive([{ name: "Relay.app/Contents/link", data: "../../../outside", link: true }]);
  assert.throws(() => native.validateZipFile(f.file), /escapes/);
  archive([{ name: "Relay.app/Contents/link", data: "safe", link: true }, { name: "Relay.app/Contents/link/child", data: "bad" }]);
  assert.throws(() => native.validateZipFile(f.file), /through a symlink/);
});
