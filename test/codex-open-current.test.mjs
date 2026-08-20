// Fallback-ordering tests for the Codex "Open in current chat" orchestrator
// (overlay/codex-open-current.cjs): bridge submit -> near-now heartbeat
// automation -> fresh open, with every seam stubbed. No Electron, no ~/.codex.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BRIDGE_SUBMIT_DEFAULT,
  bridgeSubmitEnabled,
  openCodexInCurrent,
} = require("../overlay/codex-open-current.cjs");

const THREAD = {
  threadId: "t-current",
  sessionPath: "/tmp/fake-rollout.jsonl",
  cwd: "/w",
  threadName: "Current",
  lastActiveAt: Date.now(),
  busy: false,
  openTurnId: null,
};

function harness({
  thread = { ...THREAD },
  submit = { attempted: true, submitted: true },
  growth = { grew: true, waitedMs: 10 },
  idle = { idle: true, waitedMs: 5 },
  automationThrows = null,
  resolveThrows = null,
  codexRunning = true,
  env = { RELAY_CODEX_BRIDGE_SUBMIT: "1" },
} = {}) {
  const calls = [];
  const deps = {
    inject: {
      cleanupStaleOpenAutomations: () => {
        calls.push("cleanup");
        return [];
      },
      resolveCurrentCodexThread: () => {
        calls.push("resolve");
        if (resolveThrows) throw resolveThrows;
        return thread;
      },
      buildInjectionInstruction: ({ relayId }) => `instruction for ${relayId}`,
      waitForCodexIdle: async () => {
        calls.push("wait-idle");
        return idle;
      },
      rolloutSize: () => {
        calls.push("baseline");
        return 100;
      },
      waitForRolloutGrowth: async () => {
        calls.push("verify-growth");
        return growth;
      },
      writeOpenAutomation: ({ relayId, threadId, instruction }) => {
        calls.push("write-automation");
        if (automationThrows) throw automationThrows;
        return { id: `relay-open-${relayId}`, dir: "/tmp/a", path: "/tmp/a/automation.toml", fireAtMs: Date.now() + 90_000, threadId, instruction };
      },
    },
    desktop: {
      submitTurnToCodexDesktopThread: async ({ threadId, text }) => {
        calls.push(`submit:${threadId}`);
        assert.match(text, /instruction for/);
        return submit;
      },
    },
    codexRunning,
    activateHost: () => calls.push("activate"),
    finish: () => calls.push("finish"),
    fallbackFresh: () => calls.push("fresh"),
    env,
    log: () => {},
    idleWaitMs: 50,
    verifyGrowthMs: 50,
  };
  return { calls, deps };
}

const packet = { packetId: "r_1", senderName: "Ada", title: "Ship it" };

test("bridge tier: idle thread -> submit -> verified growth -> activate + finish, no automation, no fresh", async () => {
  const { calls, deps } = harness();
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "bridge");
  assert.deepEqual(calls, ["cleanup", "resolve", "baseline", "submit:t-current", "verify-growth", "activate", "finish"]);
});

test("busy thread queues behind idle, then submits", async () => {
  const { calls, deps } = harness({ thread: { ...THREAD, busy: true, openTurnId: "turn-1" } });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "bridge");
  assert.ok(calls.indexOf("wait-idle") >= 0 && calls.indexOf("wait-idle") < calls.indexOf("submit:t-current"));
});

test("busy thread that never idles skips the submit and stages the automation", async () => {
  const { calls, deps } = harness({
    thread: { ...THREAD, busy: true, openTurnId: "turn-1" },
    idle: { idle: false, waitedMs: 50 },
  });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "automation");
  assert.ok(!calls.some((c) => c.startsWith("submit:")), "no submit into a stuck-busy thread");
  assert.deepEqual(calls.slice(-3), ["write-automation", "activate", "finish"]);
});

test("failed bridge submit falls back to the automation tier", async () => {
  const { calls, deps } = harness({ submit: { attempted: true, submitted: false, reason: "inspector-unavailable" } });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "automation");
  assert.ok(calls.includes("write-automation"));
  assert.equal(calls.filter((c) => c === "finish").length, 1, "finish fires exactly once");
});

test("an UNVERIFIED bridge submit (no rollout growth) falls back to the automation tier", async () => {
  const { calls, deps } = harness({ growth: { grew: false, waitedMs: 50 } });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "automation");
  assert.ok(calls.includes("verify-growth"));
  assert.ok(calls.includes("write-automation"));
});

test("bridge tier disabled by env goes straight to the automation tier", async () => {
  const { calls, deps } = harness({ env: { RELAY_CODEX_BRIDGE_SUBMIT: "0" } });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "automation");
  assert.ok(!calls.some((c) => c.startsWith("submit:")));
  assert.deepEqual(calls.slice(-3), ["write-automation", "activate", "finish"]);
});

test("no current thread -> fresh tier (openPacket owns ack/spinner, so no finish here)", async () => {
  const { calls, deps } = harness({ thread: null });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "fresh");
  assert.deepEqual(calls, ["cleanup", "resolve", "fresh"]);
});

test("thread resolution failure -> fresh tier", async () => {
  const { calls, deps } = harness({ resolveThrows: new Error("boom") });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "fresh");
  assert.ok(calls.includes("fresh"));
  assert.ok(!calls.includes("finish"));
});

test("codex not running: an automation would never fire, so fall to fresh", async () => {
  const { calls, deps } = harness({
    codexRunning: false,
    submit: { attempted: true, submitted: false, reason: "codex-not-running" },
  });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "fresh");
  assert.ok(!calls.includes("write-automation"));
});

test("automation staging failure -> fresh tier", async () => {
  const { calls, deps } = harness({
    submit: { attempted: true, submitted: false, reason: "inspector-unavailable" },
    automationThrows: new Error("EACCES"),
  });
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "fresh");
  assert.ok(calls.includes("fresh"));
  assert.ok(!calls.includes("finish"));
});

test("a bridge-layer exception degrades to the automation tier, not a crash", async () => {
  const { calls, deps } = harness();
  deps.desktop.submitTurnToCodexDesktopThread = async () => {
    calls.push("submit:throw");
    throw new Error("inspector exploded");
  };
  const result = await openCodexInCurrent(packet, deps);
  assert.equal(result.tier, "automation");
  assert.ok(calls.includes("write-automation"));
});

test("stale-automation cleanup runs on every pass, whichever tier wins", async () => {
  for (const options of [
    {},
    { submit: { attempted: true, submitted: false } },
    { thread: null },
  ]) {
    const { calls, deps } = harness(options);
    await openCodexInCurrent(packet, deps);
    assert.equal(calls[0], "cleanup");
  }
});

test("bridge gating: =0 off, =1 on, unset follows the shipped default", () => {
  assert.equal(bridgeSubmitEnabled({ RELAY_CODEX_BRIDGE_SUBMIT: "0" }), false);
  assert.equal(bridgeSubmitEnabled({ RELAY_CODEX_BRIDGE_SUBMIT: "1" }), true);
  assert.equal(bridgeSubmitEnabled({}), BRIDGE_SUBMIT_DEFAULT);
  assert.equal(bridgeSubmitEnabled(), BRIDGE_SUBMIT_DEFAULT);
});
