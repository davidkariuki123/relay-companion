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
  assert.deepEqual(calls, ["bootout", "bootstrap", "bootstrap", "remove"], "a failed handover still retires its KeepAlive job");
  assert.equal(fs.readFileSync(plist, "utf8"), "old");
  assert.equal(fs.existsSync(path.join(homeDir, ".relay", "runtime", "transaction.lock")), false);
});
test("macOS handover does not unload a controller holding the launcher lock", async t => {
  const homeDir = fixture(t), root = path.join(homeDir, ".relay", "recovery");
  const release = io.acquireLauncherLock(root);
  try {
    const calls = [];
    const result = await schedule.handover({ homeDir, userId: 123, attempts: 1, sleep: async () => {}, report: () => {},
      run: (_file, args) => { calls.push(args.join(" ")); assert.equal(args[0], "remove", "controller is active"); return { status: 0 }; } });
    assert.deepEqual(calls, ["remove work.relay.recovery.schedule-handover"]);
    assert.equal(result.reason, "recovery-schedule-handover-deadline");
  } finally { release(); }
});

test("a successful macOS handover reports, then removes its own KeepAlive job", async t => {
  const homeDir = fixture(t), root = path.join(homeDir, ".relay", "recovery");
  const plist = path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.recovery.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(plist, "new");
  const order = [];
  const result = await schedule.handover({ homeDir, userId: 123, attempts: 1,
    report: value => order.push(`report:${value.ok}`),
    run: (_file, args) => { order.push(args[0] === "remove" ? `remove:${args[1]}` : args[0]); return { status: 0 }; } });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["bootout", "bootstrap", "report:true", "remove:work.relay.recovery.schedule-handover"]);
  assert.equal(io.read(path.join(root, "scheduler.json")).intervalSeconds, 60);
});
test("a finished handover left by an older build is retired only when idle and the 60 s job is loaded", t => {
  const homeDir = fixture(t);
  const launchd = ({ interval = 60, pid = null, listed = true } = {}) => {
    const calls = [];
    const run = (_file, args) => {
      calls.push(args[0]);
      if (args[0] === "print") return { status: 0, stdout: `\trun interval = ${interval} seconds\n` };
      if (args[0] === "list") return listed ? { status: 0, stdout: `{\n\t"Label" = "x";${pid ? `\n\t"PID" = ${pid};` : ""}\n};` } : { status: 113 };
      return { status: 0 };
    };
    return { run, calls };
  };
  let probe = launchd();
  assert.deepEqual(schedule.retireFinishedHandover({ homeDir, userId: 1, run: probe.run }), { removed: false, reason: "handover-pending" });
  assert.deepEqual(probe.calls, [], "no recorded handover: nothing is asked of launchd");
  io.write(path.join(homeDir, ".relay", "recovery", "scheduler.json"), { schema: 1, intervalSeconds: 60 });
  probe = launchd({ interval: 300 });
  assert.equal(schedule.retireFinishedHandover({ homeDir, userId: 1, run: probe.run }).reason, "handover-pending", "a stale loaded cadence still needs its handover");
  probe = launchd({ pid: 42 });
  assert.equal(schedule.retireFinishedHandover({ homeDir, userId: 1, run: probe.run }).reason, "running");
  assert.ok(!probe.calls.includes("remove"));
  probe = launchd({ listed: false });
  assert.equal(schedule.retireFinishedHandover({ homeDir, userId: 1, run: probe.run }).reason, "absent");
  probe = launchd();
  assert.deepEqual(schedule.retireFinishedHandover({ homeDir, userId: 1, run: probe.run }), { removed: true, reason: "idle" });
  assert.deepEqual(probe.calls, ["print", "list", "remove"]);
});
