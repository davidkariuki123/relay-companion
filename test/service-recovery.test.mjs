import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import io from "../bootstrap/recovery-launcher.cjs";
import services from "../bootstrap/service-recovery.cjs";
import schedule from "../bootstrap/recovery-schedule-handover.cjs";
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-restore-"));
  t.after(() => { assert.equal(path.dirname(homeDir), os.tmpdir()); fs.rmSync(homeDir, { recursive: true, force: true }); });
  return homeDir;
}
test("missing Windows tasks are reconstructed from a verified retained runtime under ownership and drain", async t => {
  const homeDir = fixture(t), calls = [];
  io.write(path.join(homeDir, ".relay", "runtime", "current.json"), { active: true, version: "1.2.3", packageRoot: path.join(homeDir, "verified"), node: "/node" });
  const result = await services.repairServiceRegistrations({ homeDir, platform: "win32",
    run: (_file, args) => args[0] === "-p" ? { status: 0, stdout: "22.14.0" } : { status: 1, stderr: "The system cannot find the file specified" },
    validate: () => true, own: () => { calls.push("own"); return { env: {}, assert: () => calls.push("assert"), release: () => calls.push("release") }; },
    drain: async () => { calls.push("drain"); return () => calls.push("undrain"); },
    execute: async (_node, _entry, args) => { assert.deepEqual(args, ["repair-runtime", "--no-restart"]); calls.push("register"); },
    activate: async () => { calls.push("activate"); return { ok: true }; } });
  assert.equal(result.status, "services-restored");
  assert.deepEqual(calls, ["own", "drain", "assert", "register", "assert", "activate", "undrain", "release"]);
});
test("uncertain task queries never authorize rebuilding registrations", async t => {
  const result = await services.repairServiceRegistrations({ homeDir: fixture(t), platform: "win32",
    run: () => ({ error: Error("timeout") }), own: () => assert.fail("uncertainty is not absence") });
  assert.equal(result.blocked, true);
});
test("macOS scheduler handover restores the old file when new bootstrap fails", async t => {
  const homeDir = fixture(t), root = path.join(homeDir, ".relay", "recovery");
  const plist = path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.recovery.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(plist, "new"); fs.writeFileSync(path.join(root, "scheduler-previous.plist"), "old");
  const calls = [];
  const result = await schedule.handover({ homeDir, userId: 123, attempts: 1,
    run: (_file, args) => { calls.push(args[0]); return { status: calls.length === 2 ? 1 : 0 }; } });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["bootout", "bootstrap", "bootstrap"]);
  assert.equal(fs.readFileSync(plist, "utf8"), "old");
  assert.equal(fs.existsSync(path.join(homeDir, ".relay", "runtime", "transaction.lock")), false);
});
test("macOS handover does not unload a controller holding the launcher lock", async t => {
  const homeDir = fixture(t), root = path.join(homeDir, ".relay", "recovery");
  const release = io.acquireLauncherLock(root);
  try {
    const result = await schedule.handover({ homeDir, userId: 123, attempts: 1, sleep: async () => {}, run: () => assert.fail("controller is active") });
    assert.equal(result.reason, "recovery-schedule-handover-deadline");
  } finally { release(); }
});
