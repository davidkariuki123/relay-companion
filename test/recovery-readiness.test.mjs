import test from "node:test";
import assert from "node:assert/strict";
import { waitForRecoveryReady } from "../bootstrap/recovery-readiness.cjs";

function probe(overrides = {}) {
  let clock = 100000;
  return waitForRecoveryReady({ platform: "darwin", now: () => clock,
    sleep: async ms => { clock += ms; },
    readCurrent: () => ({ active: true, version: "1.0.0", packageRoot: "/relay/node_modules/relay-companion" }),
    readHeartbeat: () => ({ version: "1.0.0", pid: 12, at: clock - clock % 5000 }),
    health: () => ({ ok: true }),
    inspect: label => ({ known: true, present: true, pid: label.endsWith("pill") ? 13 : 12 }),
    ...overrides({ now: () => clock, advance: ms => { clock += ms; } }),
  });
}

test("readiness requires ten seconds of service liveness and an advancing daemon heartbeat", async () => {
  let sampled = 0;
  const result = await probe(() => ({ health: () => { sampled++; return { ok: true }; } }));
  assert.equal(result.ok, true); assert.equal(sampled, 11);
});

for (const [name, change] of [
  ["a daemon that started but stopped answering", () => ({ readHeartbeat: () => ({ version: "1.0.0", pid: 12, at: 100000 }) })],
  ["a launchd service without a process", () => ({ inspect: () => ({ known: true, present: true, pid: null }) })],
  ["the heartbeat from a different daemon", () => ({ inspect: () => ({ known: true, present: true, pid: 99 }) })],
  ["a crash loop with repeated new daemon PIDs", ({ now }) => ({
    readHeartbeat: () => ({ version: "1.0.0", pid: now(), at: now() }), inspect: () => ({ known: true, present: true, pid: now() }),
  })],
  ["a pill that crashes every five seconds", ({ now }) => ({ health: () => ({ ok: now() % 5000 !== 0 }) })],
  ["sleep between samples", ({ advance }) => ({ sleep: async () => advance(6000) })],
  ["a healthy but different canonical release", () => ({ target: { version: "2.0.0" } })],
]) test(`readiness rejects ${name}`, async () => assert.equal((await probe(change)).ok, false));

test("an interruption resets the healthy window instead of counting disconnected good samples", async () => {
  const result = await probe(({ now }) => ({ health: () => ({ ok: now() !== 105000 }) }));
  assert.equal(result.ok, true); assert.equal(result.heartbeatAt, 115000);
});
