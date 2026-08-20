import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProviderCompletionCandidate,
  providerCompletionCandidate,
  providerCompletionIdempotencyKey,
} from "../src/provider-completion.js";

test("canonical completion requires the exact Relay-owned native start", () => {
  const presentation = {
    turns: [{ key: "old", nativeStarted: true, settled: true, startedAtMs: 1_000, completedAtMs: 1_100, finalEligible: true, final: { text: "old" } }],
  };
  assert.equal(canonicalProviderCompletionCandidate({
    provider: "codex", presentation, expectedTurnId: "current", startedAfter: new Date(2_000).toISOString(),
  }), null);
  assert.equal(canonicalProviderCompletionCandidate({
    provider: "codex", presentation: { turns: [{ ...presentation.turns[0], key: "current", nativeStarted: false, startedAtMs: 2_000 }] },
    expectedTurnId: "current", startedAfter: new Date(2_000).toISOString(),
  }), null);
});

test("canonical completion returns provider-neutral terminal truth", () => {
  const candidate = canonicalProviderCompletionCandidate({
    provider: "claude",
    startedAfter: new Date(2_000).toISOString(),
    presentation: { turns: [{
      key: "native-turn", nativeStarted: true, settled: true, status: "completed",
      startedAtMs: 2_001, completedAtMs: 3_000,
      finalEligible: true, final: { text: "Done natively." },
    }] },
  });
  assert.deepEqual(candidate, {
    body: "Done natively.", outcome: "completed", completedAt: new Date(3_000).toISOString(), turnId: "native-turn",
  });
});

test("a canonical failed terminal stays Didn't finish instead of forging Done", () => {
  assert.equal(canonicalProviderCompletionCandidate({
    provider: "codex",
    startedAfter: new Date(2_000).toISOString(),
    presentation: { turns: [{
      key: "failed-turn", nativeStarted: true, settled: true, status: "failed",
      startedAtMs: 2_000, completedAtMs: 3_000, finalEligible: false,
      error: { message: "worker disconnected" }, final: null,
    }] },
  }), null);
});

test("a settled provider turn returns its newest current-turn final answer", () => {
  const candidate = providerCompletionCandidate({
    provider: "codex",
    liveState: "idle",
    records: [
      { type: "message", role: "assistant", text: "RUN_MODE_PROOF_OK", at: "2026-08-13T14:00:03Z" },
      { type: "message", role: "user", text: "run proof", at: "2026-08-13T14:00:00Z" },
      { type: "message", role: "assistant", text: "an older answer", at: "2026-08-13T13:00:03Z" },
    ],
  });
  assert.equal(candidate.body, "RUN_MODE_PROOF_OK");
  assert.equal(candidate.outcome, "completed");
});

test("an active native worker never produces a premature completion", () => {
  assert.equal(providerCompletionCandidate({
    provider: "claude",
    liveState: "offline",
    runActive: true,
    records: [{ type: "message", role: "assistant", text: "partial", at: "2026-08-13T14:00:01Z" }],
  }), null);
});

test("a terminal provider failure is attached truthfully even without an assistant answer", () => {
  const candidate = providerCompletionCandidate({
    provider: "codex",
    liveState: "idle",
    records: [
      { type: "turn_aborted", reason: "worker exited", at: "2026-08-13T14:00:03Z" },
      { type: "message", role: "user", text: "run proof", at: "2026-08-13T14:00:00Z" },
    ],
  });
  assert.equal(candidate.outcome, "failed");
  assert.match(candidate.body, /Codex ended without a final answer: worker exited/);
});

test("ambiguous provider state does not manufacture a terminal result", () => {
  assert.equal(providerCompletionCandidate({ provider: "codex", liveState: "unknown", records: [] }), null);
});

test("completion idempotency is stable and provider/session scoped", () => {
  assert.equal(
    providerCompletionIdempotencyKey({ relayId: "relay_1", provider: "codex", sessionId: "thread/2" }),
    "provider-completion-relay_1-codex-thread-2",
  );
});
