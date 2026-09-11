import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rememberConfig, loadRecoveryConfig, backupFile, configLock } from "../bootstrap/recovery-config.cjs";
import { recover, write, read } from "../bootstrap/recovery-runner.cjs";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-proof-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const file = path.join(homeDir, ".relay", "config.json");
  write(file, { updateChannel: "dev", apiUrl: "https://dev-api.sendrelays.com", webUrl: "https://sendrelays.com" });
  return { homeDir, file };
}

test("damaged and missing main configuration restore routing without restoring account credentials", t => {
  const { file } = fixture(t), original = { ...read(file), deviceToken: "secret", credentialAccount: "old-account", userId: "old-user" };
  rememberConfig(file, original);
  assert.equal(fs.readFileSync(backupFile(file), "utf8").includes("secret"), false);
  for (const damage of ["{broken", "null", "[]", '{"updateChannel":"unknown"}', null]) {
    if (damage === null) fs.rmSync(file); else fs.writeFileSync(file, damage);
    const result = loadRecoveryConfig(file);
    assert.equal(result.restored, true);
    assert.deepEqual(result.config, { updateChannel: "dev", apiUrl: original.apiUrl, webUrl: original.webUrl });
    assert.equal(read(file).credentialAccount, undefined);
  }
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.includes(".damaged-")).length, 4);
});

test("valid changed configuration wins and a custom path cannot borrow another config's backup", t => {
  const { file } = fixture(t); rememberConfig(file, read(file));
  write(file, { updateChannel: "staging", apiUrl: "https://example.test" });
  assert.equal(loadRecoveryConfig(file).restored, false);
  fs.rmSync(file);
  assert.equal(loadRecoveryConfig(file).config.updateChannel, "staging");
  const other = path.join(path.dirname(file), "other.json");
  fs.copyFileSync(backupFile(file), backupFile(other));
  assert.equal(loadRecoveryConfig(other).config, null);
  assert.equal(fs.existsSync(other), false);
});

test("missing or corrupt backups never guess a channel and live config writers retain ownership", t => {
  const { file } = fixture(t); fs.writeFileSync(file, "{damaged");
  assert.equal(loadRecoveryConfig(file).config, null);
  write(backupFile(file), { schema: 1, source: file, settings: { updateChannel: "other" } });
  assert.equal(loadRecoveryConfig(file).config, null);
  rememberConfig(file, { updateChannel: "dev" });
  const lock = configLock(file);
  try { assert.equal(loadRecoveryConfig(file).config, null); assert.equal(fs.readFileSync(file, "utf8"), "{damaged"); }
  finally { lock.release(); }
  assert.equal(loadRecoveryConfig(file).config.updateChannel, "dev");
});

test("normal config writes seed recovery and sign-out cannot restore an old account", async t => {
  const { file } = fixture(t), old = process.env.RELAY_CONFIG;
  process.env.RELAY_CONFIG = file;
  try {
    const { writeConfigObject } = await import("../src/config.js");
    writeConfigObject({ updateChannel: "dev", credentialAccount: "old-account", credentialStore: "local-v2" });
    writeConfigObject({ updateChannel: "dev" });
    fs.writeFileSync(file, "{damaged");
    assert.deepEqual(loadRecoveryConfig(file).config, { updateChannel: "dev" });
  } finally { if (old === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = old; }
});

test("recovery restores its settings then reaches local fallback offline after minimal repair fails", async t => {
  const { homeDir, file } = fixture(t); rememberConfig(file, read(file)); fs.writeFileSync(file, "{broken");
  const current = { active: true, version: "1.0.0", packageRoot: path.join(homeDir, "old") };
  const pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  write(pointer, { active: false, previous: current });
  let activations = 0;
  const options = { homeDir, platform: "darwin", env: {},
    repairServices: async () => ({ ok: false, status: "service-repair-failed", lastError: "missing-service-target" }),
    discoverImpl: async channel => { assert.equal(channel, "dev"); throw Error("offline"); },
    memory: () => ({ pressured: true }), validateLocal: target => target.packageRoot === current.packageRoot,
    verifyReady: async () => activations ? { ok: true, current, identity: "daemon:pill" } : { ok: false },
    run: async (_node, _entry, args) => { assert.deepEqual(args, ["1.0.0", "dev"]); activations++; write(pointer, current); },
    stage: () => assert.fail("offline repair uses the recorded local release"),
  };
  assert.equal((await recover(options)).status, "service-repair-unhealthy");
  assert.equal((await recover(options)).repair, "local");
  assert.equal(activations, 1);
  assert.equal(read(file).updateChannel, "dev");
});
