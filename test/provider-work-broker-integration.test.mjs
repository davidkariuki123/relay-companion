import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { claudeNativeEventsToWorkEvents } from "../src/claude-native-work-feed.js";
import { coworkNativeEventsToWorkEvents } from "../src/provider-work-feed.js";
import { createCanonicalWorkPushBridge } from "../src/work-push-bridge.js";
import { canonicalProviderCompletionCandidate } from "../src/provider-completion.js";

const claude = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-native-work.json", import.meta.url), "utf8"));
const cowork = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-parity/cowork-native-families.json", import.meta.url), "utf8"));

const codexEvents = [
  { eventId: "codex-start", method: "turn/started", emittedAtMs: 1_000, params: { turn: { id: "codex-turn" } } },
  { eventId: "codex-user", method: "item/completed", emittedAtMs: 1_010, params: { turnId: "codex-turn", item: { id: "codex-user", type: "userMessage", text: "Run it." } } },
  { eventId: "codex-final", method: "item/completed", emittedAtMs: 1_020, params: { turnId: "codex-turn", item: { id: "codex-final", type: "agentMessage", phase: "final_answer", text: "Done." } } },
  { eventId: "codex-end", method: "turn/completed", emittedAtMs: 1_030, params: { turn: { id: "codex-turn", status: "completed" } } },
];

function fixtures(provider) {
  if (provider === "claude") return claudeNativeEventsToWorkEvents(claude.rows, {
    sessionId: claude.sessionId,
    ownerAlive: false,
    expectedActive: false,
  });
  if (provider === "cowork") return coworkNativeEventsToWorkEvents(cowork.events, {
    sessionId: cowork.sessionId,
    session: cowork.session,
  });
  return codexEvents;
}

function stablePresentation(value) {
  return JSON.parse(JSON.stringify(value), (key, entry) => key === "durationMs" ? 0 : entry);
}

for (const provider of ["codex", "claude", "cowork"]) {
  test(`${provider} fans one provider-native monotonic feed to Request and Preview`, async () => {
    const listeners = new Set();
    const bridge = createCanonicalWorkPushBridge({
      hydrate: async () => ({ provider, events: fixtures(provider) }),
      subscribeNative: (_identity, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const request = [];
    const preview = [];
    await bridge.subscribe({ relayId: `${provider}-relay`, sessionId: `${provider}-session`, subscriberId: "request", send: (value) => request.push(value) });
    await bridge.subscribe({ relayId: `${provider}-relay`, sessionId: `${provider}-session`, subscriberId: "preview", send: (value) => preview.push(value) });

    assert.equal(listeners.size, 1, "both surfaces share exactly one native owner");
    assert.equal(request.at(-1).provider, provider);
    assert.equal(request.at(-1).presentation.provider, provider);
    assert.deepEqual(stablePresentation(request.at(-1)), stablePresentation(preview.at(-1)));
    const lastTurn = request.at(-1).presentation.turns.at(-1)?.key || `${provider}-turn`;
    for (const listener of listeners) {
      listener({ eventId: `${provider}-settlement-final`, method: "item/completed", emittedAtMs: 1_900, params: { turnId: lastTurn, item: { id: `${provider}-settlement-final`, type: "agentMessage", phase: "final_answer", text: `${provider} done`, status: "completed" } } });
      listener({ eventId: `${provider}-settlement-end`, method: "turn/completed", emittedAtMs: 1_950, params: { turn: { id: lastTurn, status: "completed" } } });
    }
    const terminal = canonicalProviderCompletionCandidate({
      provider,
      presentation: request.at(-1).presentation,
      startedAfter: new Date(0).toISOString(),
    });
    assert.ok(terminal, `${provider} canonical terminal settles without a provider-specific poller`);
    assert.ok(terminal.completedAt);

    const previousRevision = request.at(-1).revision;
    for (const listener of listeners) listener({
      eventId: `${provider}-incremental-error`,
      method: "error",
      emittedAtMs: 2_000,
      params: { turnId: lastTurn, error: { code: "PROOF", message: "Visible incremental proof", willRetry: true }, willRetry: true },
    });
    assert.ok(request.at(-1).revision > previousRevision);
    assert.equal(request.at(-1).revision, preview.at(-1).revision);
    assert.deepEqual(request.at(-1).presentation, preview.at(-1).presentation);
    assert.match(JSON.stringify(request.at(-1).presentation), /Visible incremental proof/);

    bridge.unsubscribe({ relayId: `${provider}-relay`, sessionId: `${provider}-session`, subscriberId: "request" });
    assert.equal(listeners.size, 1, "one remaining surface keeps the exact native owner alive");
    bridge.unsubscribe({ relayId: `${provider}-relay`, sessionId: `${provider}-session`, subscriberId: "preview" });
    assert.equal(listeners.size, 0, "last surface releases the native owner exactly");
  });
}
