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
    probe: async () => ({ ok: true, daemon: { pid: 12 }, pill: { pid: 13 }, identity: "daemon:renderer" }),
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
  ["a live pill whose renderer cannot answer", () => ({ probe: async () => ({ ok: false }) })],
  ["a response from an unrelated daemon PID", () => ({ probe: async () => ({ ok: true, daemon: { pid: 99 }, pill: { pid: 13 }, identity: "other" }) })],
]) test(`readiness rejects ${name}`, async () => assert.equal((await probe(change)).ok, false));

test("an interruption resets the healthy window instead of counting disconnected good samples", async () => {
  const result = await probe(({ now }) => ({ health: () => ({ ok: now() !== 105000 }) }));
  assert.equal(result.ok, true); assert.equal(result.heartbeatAt, 115000);
});

test("readiness tolerates a daemon that stalls for twenty seconds at a time", async () => {
  // The heartbeat lands only every 25 s and the probe times out for 15 of
  // those seconds: slow, but alive. The proof must not call this dead.
  const result = await probe(({ now }) => ({
    readHeartbeat: () => ({ version: "1.0.0", pid: 12, at: now() - now() % 25000 }),
    probe: async () => (now() % 25000 >= 5000 && now() % 25000 < 20000)
      ? { ok: false, reason: "daemon-probe-timeout" }
      : { ok: true, daemon: { pid: 12 }, pill: { pid: 13 }, identity: "daemon:renderer" },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.heartbeatAt, 125000);
});

test("readiness asks the probe to wait through a stall instead of giving up in two seconds", async () => {
  let timeoutMs = null;
  await probe(() => ({ probe: async (_current, options) => { timeoutMs = options.timeoutMs; return { ok: true, daemon: { pid: 12 }, pill: { pid: 13 }, identity: "daemon:renderer" }; } }));
  assert.equal(timeoutMs, 10_000);
});

test("readiness rejects a heartbeat older than a minute even while the process exists", async () => {
  const result = await probe(({ now }) => ({ readHeartbeat: () => ({ version: "1.0.0", pid: 12, at: now() - 70_000 }) }));
  assert.equal(result.ok, false);
});

test("readiness still requires the probe to answer at least once", async () => {
  let calls = 0;
  const result = await probe(() => ({ probe: async () => { calls++; return { ok: false, reason: "daemon-probe-timeout" }; } }));
  assert.equal(result.ok, false);
  assert.ok(calls > 10);
});

test("legacy liveness never receives a probation identity", async () => {
  const result = await probe(() => ({ probe: async () => ({ ok: true, legacy: true }) }));
  assert.equal(result.ok, true); assert.equal(result.legacy, true); assert.equal(result.identity, null);
});

test("activation rejects a ticking heartbeat and answering socket when the working loop is frozen", async () => {
  const result = await probe(({ now }) => ({ requireProgress: true,
    probe: async () => ({ ok: true, daemon: { pid: 12, progress: { sequence: 1, at: now(), phase: "running" } }, pill: { pid: 13 }, identity: "daemon:renderer" }),
  }));
  assert.equal(result.ok, false); assert.match(result.detail, /daemon-loop-not-advancing/);
});

test("activation accepts sustained local loop progress while network or sign-in is unavailable", async () => {
  for (const phase of ["offline", "signed-out", "running"]) {
    const result = await probe(({ now }) => ({ requireProgress: true,
      probe: async () => ({ ok: true, daemon: { pid: 12, progress: { sequence: now(), at: now(), phase } }, pill: { pid: 13 }, identity: "daemon:renderer" }),
    }));
    assert.equal(result.ok, true, phase);
  }
});

test("new activation cannot pass with a legacy socket lacking loop progress", async () => {
  assert.equal((await probe(() => ({ requireProgress: true }))).ok, false);
});

test("one quick progress increment followed by a frozen loop does not satisfy the observation window", async () => {
  const result = await probe(({ now }) => ({ requireProgress: true,
    probe: async () => ({ ok: true, daemon: { pid: 12, progress: { sequence: now() === 100000 ? 1 : 2, at: Math.min(now(), 101000), phase: "running" } }, pill: { pid: 13 }, identity: "daemon:renderer" }),
  }));
  assert.equal(result.ok, false);
});

// One Windows process-health sample is a PowerShell query that takes seconds;
// the time spent taking a sample is not a gap in watching the runtime.
test("slow health sampling does not reset the healthy window", async () => {
  let sampled = 0;
  const result = await probe(({ advance }) => ({ health: () => { sampled++; advance(6000); return { ok: true }; } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(sampled <= 3, `ten seconds of liveness should need few slow samples, took ${sampled}`);
});

test("a probe that times out for ten seconds does not reset the healthy window either", async () => {
  let calls = 0;
  const result = await probe(({ advance }) => ({ probe: async () => {
    calls++;
    if (calls === 2) { advance(10_000); return { ok: false, reason: "daemon-probe-timeout" }; }
    return { ok: true, daemon: { pid: 12 }, pill: { pid: 13 }, identity: "daemon:renderer" };
  } }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("a machine suspended in the middle of a sample is still rejected", async () => {
  const result = await probe(({ advance }) => ({ health: () => { advance(40_000); return { ok: true }; } }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /^not-watched-continuously:/);
});

test("a failed proof says which condition blocked it", async () => {
  const stale = await probe(({ now }) => ({ readHeartbeat: () => ({ version: "1.0.0", pid: 12, at: now() - 70_000 }) }));
  assert.match(stale.detail, /^heartbeat-stale:/);
  const unanswered = await probe(() => ({ probe: async () => ({ ok: false, reason: "pill-probe-timeout" }) }));
  assert.match(unanswered.detail, /^probe:pill-probe-timeout; samples=\d+ slowestSampleMs=\d+ probeSeen=false$/);
  const sick = await probe(() => ({ health: () => ({ ok: false, daemon: true, pill: false, daemonCount: 1, pillCount: 0 }) }));
  assert.match(sick.detail, /^health:\{"daemon":true,"pill":false/);
  const gap = await probe(({ advance }) => ({ sleep: async () => advance(6000) }));
  assert.match(gap.detail, /^not-watched-continuously:gap=6000ms/);
});

test("activation reports a missing probe instead of blaming daemon loop progress", async () => {
  const result = await probe(() => ({ requireProgress: true,
    probe: async () => ({ ok: false, daemon: { ok: true, pid: 12 }, pill: { ok: false, reason: "pill-probe-unavailable" } }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /^probe:pill-probe-unavailable;/);
});

test("Mac readiness distinguishes missing heartbeat evidence from launchd process IDs", async () => {
  const result = await probe(() => ({ readHeartbeat: () => null }));
  assert.equal(result.ok, false);
  assert.match(result.detail, /launchd-jobs-not-matching-heartbeat:daemon=12,pill=13,heartbeat=missing/);
});

// Between the enumeration that opens the healthy window and the one that
// closes it, liveness is checked by pid. On Windows a full sample is a
// PowerShell/WMI listing of every process; one every second, every minute,
// was most of what the recovery task cost a laptop.
test("the healthy window enumerates processes at its start and end and checks pids in between", async () => {
  const samples = [];
  const result = await probe(() => ({ health: (_current, options) => {
    samples.push(options.full ? "full" : `pids:${options.watched.daemon}/${options.watched.pill}`);
    return { ok: true };
  } }));
  assert.equal(result.ok, true);
  assert.equal(samples[0], "full");
  assert.equal(samples.at(-1), "full");
  assert.equal(samples.filter((sample) => sample === "full").length, 2);
  assert.deepEqual([...new Set(samples.slice(1, -1))], ["pids:12/13"]);
});

test("a watched process that dies between enumerations resets the window", async () => {
  const result = await probe(({ now }) => ({ health: (_current, options) => ({ ok: options.full || now() !== 105000 }) }));
  assert.equal(result.ok, true); assert.equal(result.heartbeatAt, 115000);
});

test("a legacy runtime, whose probe names no pids, is enumerated on every sample", async () => {
  let full = 0;
  const result = await probe(() => ({ probe: async () => ({ ok: true, legacy: true }), health: (_current, options) => { if (options.full) full++; return { ok: true }; } }));
  assert.equal(result.ok, true); assert.equal(full, 11);
});

// A runtime the previous check proved, still the same identity, that has
// beaten and progressed since then, needs one full sample, not a new window.
const IDENTITY = "/relay/node_modules/relay-companion:12:13:daemon:renderer";
test("continuity from the previous check lets a live, advancing runtime pass on one enumeration", async () => {
  let sampled = 0;
  const result = await probe(() => ({ continuity: { identity: IDENTITY, heartbeatAt: 95000, progressSequence: null }, health: () => { sampled++; return { ok: true }; } }));
  assert.equal(result.ok, true); assert.equal(result.continued, true); assert.equal(sampled, 1); assert.equal(result.identity, IDENTITY);
});

for (const [name, continuity] of [
  ["a different runtime identity", { identity: "/relay/node_modules/relay-companion:12:13:other", heartbeatAt: 95000 }],
  ["a heartbeat that has not advanced since", { identity: IDENTITY, heartbeatAt: 100000 }],
]) test(`continuity with ${name} does not shorten the proof`, async () => {
  let sampled = 0;
  const result = await probe(() => ({ continuity, health: () => { sampled++; return { ok: true }; } }));
  assert.equal(result.ok, true); assert.notEqual(result.continued, true); assert.equal(sampled, 11);
});

test("continuity cannot vouch for loop progress it never recorded", async () => {
  const progressing = (now) => ({ ok: true, daemon: { pid: 12, progress: { sequence: Math.floor(now() / 1000), at: now(), phase: "running" } }, pill: { pid: 13 }, identity: "daemon:renderer" });
  const without = await probe(({ now }) => ({ requireProgress: true, continuity: { identity: IDENTITY, heartbeatAt: 95000, progressSequence: null }, probe: async () => progressing(now) }));
  assert.equal(without.ok, true); assert.notEqual(without.continued, true);
  const withSequence = await probe(({ now }) => ({ requireProgress: true, continuity: { identity: IDENTITY, heartbeatAt: 95000, progressSequence: 50 }, probe: async () => progressing(now) }));
  assert.equal(withSequence.ok, true); assert.equal(withSequence.continued, true); assert.equal(withSequence.progressSequence, 100);
  const stalled = await probe(({ now }) => ({ requireProgress: true, continuity: { identity: IDENTITY, heartbeatAt: 95000, progressSequence: 100 }, probe: async () => progressing(now) }));
  assert.notEqual(stalled.continued, true);
});
