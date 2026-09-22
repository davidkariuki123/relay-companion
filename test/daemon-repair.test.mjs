import test from "node:test";
import assert from "node:assert/strict";
import { repairDaemonService } from "../src/daemon-repair.js";

test("the pill only requests independent recovery and verifies a new heartbeat", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    let clock = 100000, reads = 0;
    const requests = [];
    const result = await repairDaemonService({ platform, homeDir: "/test", now: () => clock,
      request: async value => { requests.push(value); return { ok: true }; },
      readHeartbeat: () => ({ pid: 12, at: ++reads > 1 ? clock : 1 }),
      pause: async ms => { clock += ms; } });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reason, "daemon-unresponsive");
  }
});
test("accepted recovery stays pending until a new heartbeat, including clock rollback", async () => {
  let polls = 0;
  const result = await repairDaemonService({ now: () => 100000 - polls * 1000,
    request: async () => ({ ok: true }), readHeartbeat: () => ({ at: 1, pid: 12 }),
    pause: async () => { polls++; }, waitMs: 1000, pollMs: 250 });
  assert.equal(result.pending, true);
  assert.equal(result.ok, false);
  assert.equal(polls, 4);
});
test("controller errors remain visible without an alternative service writer", async () => {
  const result = await repairDaemonService({ request: async () => { throw Error("controller missing"); },
    pause: () => assert.fail("must not poll after refusal") });
  assert.equal(result.reason, "recovery-request-failed");
  assert.equal(result.detail, "controller missing");
});
