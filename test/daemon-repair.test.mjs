// The pill's repair of a missing background daemon (src/daemon-repair.js).
//
// Field case, Shane 2026-09-19: an OS reinstall kept ~/.relay but dropped every
// Relay logon task. The installer called the machine set up, the pill ran with
// no daemon behind it, and a group chat showed the person's own messages and
// read receipts while every reply was missing. These tests pin what the pill
// does about it: register only what is absent, start through the verified
// platform restart, and believe nothing until a fresh heartbeat appears.
import test from "node:test";
import assert from "node:assert/strict";
import { repairDaemonService } from "../src/daemon-repair.js";

function harness({ platform = "win32", missing = [], restartOutcome = "restarted", heartbeatAfter = 1 } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const log = [];
  let heartbeat = { at: clock - 10 * 60_000, pid: 11 };
  let reads = 0;
  const options = {
    platform,
    homeDir: "/home/test",
    bin: "/home/test/.relay/runtime/releases/r/node_modules/relay-companion/bin/relay.js",
    node: "/usr/bin/node",
    env: {},
    log: (line) => log.push(line),
    now: () => clock,
    runCommand: () => ({ ok: true, out: "" }),
    taskStatus: () => { calls.push("query"); return { missing, unavailable: [] }; },
    installDaemon: (_bin, _node, { reload }) => { calls.push(`daemon:${reload ? "load" : "register"}`); return { ok: true, started: reload }; },
    installPill: () => { calls.push("pill:register"); return { ok: true }; },
    installRecoveryImpl: ({ reload }) => { calls.push(`recovery:${reload ? "load" : "register"}`); return { ok: true }; },
    restart: async ({ services }) => { calls.push(`restart:${services.join(",")}`); return { daemon: restartOutcome, pill: "skipped", detail: {} }; },
    readHeartbeat: () => { reads += 1; if (reads >= heartbeatAfter) heartbeat = { at: clock, pid: 22 }; return heartbeat; },
    pause: async (ms) => { clock += ms; },
    waitMs: 5000,
    pollMs: 500,
  };
  return { options, calls, log, tick: (ms) => { clock += ms; } };
}

test("Windows: only the absent tasks are re-registered, the recovery launcher always is, and the daemon is restarted through the verified path", async () => {
  const h = harness({ missing: ["Relay Companion Daemon", "Relay Companion Pill"], heartbeatAfter: 2 });
  const result = await repairDaemonService(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "daemon-heartbeat");
  assert.deepEqual(h.calls, ["query", "daemon:register", "pill:register", "recovery:register", "restart:daemon"]);
  assert.match(h.log.at(-1), /background service is back \(pid 22\)/);

  const present = harness({ missing: [] });
  await repairDaemonService(present.options);
  assert.deepEqual(present.calls, ["query", "recovery:register", "restart:daemon"], "a present task is never rewritten from the pill");
});

test("macOS and Linux rewrite the daemon registration without a reload, then load it when the supervisor does not know it", async () => {
  for (const platform of ["darwin", "linux"]) {
    const h = harness({ platform, restartOutcome: "not_installed" });
    const result = await repairDaemonService(h.options);
    assert.equal(result.ok, true, platform);
    assert.deepEqual(h.calls, ["daemon:register", "recovery:register", "restart:daemon", "daemon:load"], platform);
  }
});

test("a daemon that never heartbeats after starting is reported, not believed", async () => {
  const h = harness({ heartbeatAfter: Number.POSITIVE_INFINITY });
  const result = await repairDaemonService(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-heartbeat-after-start");
  assert.match(h.log.at(-1), /never reported a heartbeat/);
  const failed = harness({ restartOutcome: "failed" });
  failed.options.restart = async () => ({ daemon: "failed", pill: "skipped", detail: { daemon: "task exists but its process never appeared" } });
  const outcome = await repairDaemonService(failed.options);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "daemon-start-failed");
  assert.match(outcome.detail, /never appeared/);
});

test("registration and restart failures are contained and still leave a verdict", async () => {
  const h = harness({ missing: ["Relay Companion Daemon"] });
  h.options.installDaemon = () => { throw new Error("schtasks exploded"); };
  h.options.installRecoveryImpl = () => { throw new Error("no launcher"); };
  h.options.restart = async () => { throw new Error("powershell missing"); };
  const result = await repairDaemonService(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "daemon-start-failed");
  assert.equal(result.registered.daemon.reason, "daemon-registration-threw");
  assert.equal(result.registered.recovery.reason, "recovery-registration-threw");
  assert.match(result.detail, /powershell missing/);
});
