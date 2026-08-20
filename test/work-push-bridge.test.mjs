import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalAttachmentReference,
  createCanonicalWorkPushBridge,
  createWorkPushBridge,
  rendererSafeClone,
} from "../src/work-push-bridge.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const listeners = new Set();
  let nativeSubscriptions = 0;
  let nativeUnsubscriptions = 0;
  const bridge = createWorkPushBridge({
    createState: () => ({ events: [] }),
    reduceEvent: (state, event) => { state.events.push(event); return state; },
    present: (state) => ({ turns: [{ key: "turn", units: state.events.map((event) => ({ id: event.id, text: event.text })) }] }),
    hydrate: async () => ({ events: [] }),
    subscribeNative: (_identity, listener) => {
      nativeSubscriptions += 1;
      listeners.add(listener);
      return () => { nativeUnsubscriptions += 1; listeners.delete(listener); };
    },
    ...overrides,
  });
  return {
    bridge,
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    listeners,
    nativeSubscriptions: () => nativeSubscriptions,
    nativeUnsubscriptions: () => nativeUnsubscriptions,
  };
}

test("native subscription closes the async hydration gap and preserves event order", async () => {
  const pending = deferred();
  const h = harness({ hydrate: () => pending.promise });
  const snapshots = [];
  const subscribing = h.bridge.subscribe({
    relayId: "relay-1", sessionId: "session-1", subscriberId: "pill", send: (value) => snapshots.push(value),
  });
  assert.equal(h.listeners.size, 1, "native listener attaches before hydration resolves");
  h.emit({ id: "live-2", text: "second" });
  pending.resolve({ events: [{ id: "history-1", text: "first" }] });
  await subscribing;
  assert.deepEqual(snapshots.at(-1).presentation.turns[0].units.map((unit) => unit.id), ["history-1", "live-2"]);
});

test("canonical hydration retains the provider selected by the native adapter", async () => {
  const snapshots = [];
  const bridge = createCanonicalWorkPushBridge({
    hydrate: async () => ({ provider: "claude", events: [] }),
    subscribeNative: () => () => {},
  });
  await bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: (value) => snapshots.push(value) });
  assert.equal(snapshots.at(-1).presentation.provider, "claude");
  bridge.close();
});

test("one feed fans the same monotonic snapshot out to Request Work and AI Preview", async () => {
  const h = harness();
  const request = [];
  const preview = [];
  await h.bridge.subscribe({ relayId: "relay-1", sessionId: "session-1", subscriberId: "request", send: (value) => request.push(value) });
  await h.bridge.subscribe({ relayId: "relay-1", sessionId: "session-1", subscriberId: "preview", send: (value) => preview.push(value) });
  assert.equal(h.nativeSubscriptions(), 1, "surfaces share one native listener");
  h.emit({ id: "event-1", text: "live" });
  assert.equal(request.at(-1).revision, preview.at(-1).revision);
  assert.deepEqual(request.at(-1).presentation, preview.at(-1).presentation);
  assert.ok(request.at(-1).revision > request[0].revision);
});

test("the shared envelope retains provider identity without changing per-provider semantics", async () => {
  const h = harness({
    createState: () => ({ provider: "cowork", events: [] }),
  });
  const snapshots = [];
  await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "view", send: (value) => snapshots.push(value) });
  assert.equal(snapshots.at(-1).provider, "cowork");
});

test("stale hydration cannot overwrite a reconnect generation", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({ hydrate: () => (++calls === 1 ? first.promise : second.promise) });
  const snapshots = [];
  const initial = h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: (value) => snapshots.push(value) });
  const reconnect = h.bridge.reconnect({ relayId: "r", sessionId: "s" });
  second.resolve({ events: [{ id: "new", text: "new generation" }] });
  await reconnect;
  first.resolve({ events: [{ id: "stale", text: "stale generation" }] });
  await initial;
  assert.deepEqual(snapshots.at(-1).presentation.turns[0].units.map((unit) => unit.id), ["new"]);
});

test("destroyed subscribers are dropped and the native listener is released", async () => {
  const h = harness();
  let alive = true;
  const sent = [];
  await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "window", send: (value) => sent.push(value), isAlive: () => alive });
  alive = false;
  h.emit({ id: "event", text: "must not send" });
  assert.equal(sent.length, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.nativeUnsubscriptions(), 1);
});

test("a feed rehydrates after an unwatched interval instead of hiding missed events", async () => {
  let history = [{ id: "before", text: "before" }];
  const h = harness({ hydrate: async () => ({ events: history }) });
  const first = [];
  const unsubscribe = await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "first", send: (value) => first.push(value) });
  unsubscribe();
  history = [...history, { id: "while-unwatched", text: "authoritative history" }];
  const second = [];
  await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "second", send: (value) => second.push(value) });
  assert.equal(h.nativeSubscriptions(), 2);
  assert.equal(h.nativeUnsubscriptions(), 1);
  assert.deepEqual(second.at(-1).presentation.turns[0].units.map((unit) => unit.id), ["before", "while-unwatched"]);
});

test("failed initial hydration retires the provisional subscriber and native listener", async () => {
  const h = harness({ hydrate: async () => { throw new Error("broken history"); } });
  await assert.rejects(
    h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "window", send: () => {} }),
    /broken history/,
  );
  assert.equal(h.listeners.size, 0);
  assert.equal(h.nativeUnsubscriptions(), 1);
  assert.equal(h.bridge.stats()[0].subscribers, 0);
});

test("failed native attachment retires its provisional subscriber", async () => {
  const h = harness({ subscribeNative: () => { throw new Error("broken listener"); } });
  await assert.rejects(
    h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "window", send: () => {} }),
    /broken listener/,
  );
  assert.equal(h.bridge.stats()[0].subscribers, 0);
  assert.equal(h.bridge.stats()[0].nativeAttached, false);
});

test("detached history stays readable while an orphaned active turn fails honestly", async () => {
  const detachedNative = () => {
    const unsubscribe = () => {};
    unsubscribe.detached = true;
    return unsubscribe;
  };
  const make = (active) => createWorkPushBridge({
    createState: () => ({ turns: [] }),
    reduceEvent: (state, event) => {
      if (event.method === "relay/connectionClosed") {
        const turn = state.turns[0];
        turn.active = false;
        turn.status = "failed";
        turn.units.push({ id: event.eventId, type: "error", text: event.params.message });
      }
      return state;
    },
    present: (state) => ({ turns: state.turns }),
    hydrate: async () => ({ state: { turns: [{ id: "t1", active, status: active ? "inProgress" : "completed", units: [{ id: "final" }] }] } }),
    subscribeNative: detachedNative,
  });

  const terminal = make(false);
  const terminalSnapshots = [];
  await terminal.subscribe({ relayId: "done", sessionId: "s", subscriberId: "view", send: (value) => terminalSnapshots.push(value) });
  assert.equal(terminalSnapshots.at(-1).presentation.turns[0].status, "completed");
  assert.deepEqual(terminalSnapshots.at(-1).presentation.turns[0].units, [{ id: "final" }]);

  const orphan = make(true);
  const orphanSnapshots = [];
  await orphan.subscribe({ relayId: "orphan", sessionId: "s", subscriberId: "view", send: (value) => orphanSnapshots.push(value) });
  assert.equal(orphanSnapshots.at(-1).presentation.turns[0].status, "failed");
  assert.equal(orphanSnapshots.at(-1).presentation.turns[0].units.at(-1).type, "error");
});

test("active Work feeds enforce the hard capacity boundary", async () => {
  const h = harness({ maxFeeds: 1 });
  await h.bridge.subscribe({ relayId: "r1", sessionId: "s1", subscriberId: "one", send: () => {} });
  await assert.rejects(
    h.bridge.subscribe({ relayId: "r2", sessionId: "s2", subscriberId: "two", send: () => {} }),
    (error) => error?.code === "WORK_TOO_MANY_FEEDS",
  );
  assert.equal(h.bridge.stats().length, 1);
  assert.equal(h.bridge.stats()[0].relayId, "r1");
});

test("pending overflow rehydrates rather than silently losing native truth", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({
    maxPendingEvents: 2,
    hydrate: () => (++calls === 1 ? first.promise : second.promise),
  });
  const snapshots = [];
  const subscription = h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: (value) => snapshots.push(value) });
  h.emit({ id: "a", text: "a" });
  h.emit({ id: "b", text: "b" });
  h.emit({ id: "c", text: "overflow" });
  first.resolve({ events: [{ id: "old", text: "old snapshot" }] });
  await Promise.resolve();
  second.resolve({ events: [{ id: "authoritative", text: "rehydrated" }] });
  await subscription;
  assert.equal(calls, 2);
  assert.ok(snapshots.at(-1).presentation.turns[0].units.some((unit) => unit.id === "authoritative"));
});

test("renderer projection strips raw provider and secret-bearing fields", () => {
  const safe = rendererSafeClone({
    turns: [{ key: "t", raw: { private: true }, units: [{ id: "u", text: "visible", args: { token: "no" }, environment: { HOME: "/secret" } }] }],
    apiKey: "no",
  });
  assert.deepEqual(safe, { turns: [{ key: "t", units: [{ id: "u", text: "visible" }] }] });
});

test("lazy item detail requires a live subscription and explicit authorization", async () => {
  let authorized = false;
  const h = harness({
    presentItemDetail: (_state, itemId) => ({ id: itemId, text: "safe", raw: { password: "no" }, token: "no" }),
    authorizeDetail: async () => authorized,
  });
  assert.deepEqual(await h.bridge.itemDetail({ relayId: "r", sessionId: "s", subscriberId: "pill", itemId: "i" }), { ok: false, error: "Not subscribed." });
  await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: () => {} });
  assert.deepEqual(await h.bridge.itemDetail({ relayId: "r", sessionId: "s", subscriberId: "pill", itemId: "i" }), { ok: false, error: "Not authorized." });
  authorized = true;
  const result = await h.bridge.itemDetail({ relayId: "r", sessionId: "s", subscriberId: "pill", itemId: "i" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.detail, { id: "i", text: "safe" });
});

test("canonical bridge hydrates and presents every native turn, not latest-turn compatibility", async () => {
  const events = [
    { eventId: 1, method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 1000 },
    { eventId: 2, method: "item/completed", params: { turnId: "turn-1", item: { id: "user-1", type: "userMessage", text: "first" } }, emittedAtMs: 1001 },
    { eventId: 3, method: "item/completed", params: { turnId: "turn-1", item: { id: "answer-1", type: "agentMessage", text: "one", phase: "final_answer" } }, emittedAtMs: 1002 },
    { eventId: 4, method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } }, emittedAtMs: 1003 },
    { eventId: 5, method: "turn/started", params: { turn: { id: "turn-2" } }, emittedAtMs: 2000 },
    { eventId: 6, method: "item/completed", params: { turnId: "turn-2", item: { id: "user-2", type: "userMessage", text: "second" } }, emittedAtMs: 2001 },
  ];
  const bridge = createCanonicalWorkPushBridge({ hydrate: async () => ({ events }), subscribeNative: () => () => {} });
  const snapshots = [];
  await bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: (value) => snapshots.push(value) });
  assert.deepEqual(snapshots.at(-1).presentation.turns.map((turn) => turn.key), ["turn-1", "turn-2"]);
});

test("canonical lazy detail never discloses private reasoning or raw provider arguments", async () => {
  const events = [
    { method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 1_000 },
    { method: "item/completed", params: { turnId: "turn-1", item: { id: "why", type: "reasoning", summary: ["Checked the boundary"], content: "private chain" } }, emittedAtMs: 1_100 },
    { method: "item/completed", params: { turnId: "turn-1", item: { id: "tool", type: "mcpToolCall", server: "relay", tool: "relay_send", arguments: { authorization: "Bearer hidden", token: "hidden" }, status: "completed" } }, emittedAtMs: 1_200 },
  ];
  const bridge = createCanonicalWorkPushBridge({ hydrate: async () => ({ events }), subscribeNative: () => () => {}, authorizeDetail: async () => true });
  await bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "pill", send: () => {} });
  const reasoning = await bridge.itemDetail({ relayId: "r", sessionId: "s", subscriberId: "pill", turnId: "turn-1", itemId: "why" });
  assert.deepEqual(reasoning.detail, { id: "why", type: "reasoning", available: false });
  const tool = await bridge.itemDetail({ relayId: "r", sessionId: "s", subscriberId: "pill", turnId: "turn-1", itemId: "tool" });
  assert.equal(tool.ok, true);
  assert.doesNotMatch(JSON.stringify(tool), /private chain|Bearer hidden|hidden/);
});

test("canonical js detail exposes bounded redacted execution context only on demand", async () => {
  const events = [
    { method:"turn/started", params:{ turn:{ id:"turn-1" } }, emittedAtMs:1_000 },
    { method:"item/completed", params:{ turnId:"turn-1", item:{ id:"js-1", type:"dynamicToolCall", name:"js",
      arguments:{ title:"Count UI lines", code:"const token='secret-value'; text(42)" }, result:{ output:"42" }, status:"completed" } }, emittedAtMs:1_100 },
  ];
  const bridge = createCanonicalWorkPushBridge({ hydrate:async () => ({ events }), subscribeNative:() => () => {}, authorizeDetail:async () => true });
  await bridge.subscribe({ relayId:"r", sessionId:"s", subscriberId:"pill", send:() => {} });
  const result = await bridge.itemDetail({ relayId:"r", sessionId:"s", subscriberId:"pill", turnId:"turn-1", itemId:"js-1" });
  assert.equal(result.ok, true);
  assert.equal(result.detail.activity.kind, "command");
  assert.equal(result.detail.execution.title, "Count UI lines");
  assert.match(result.detail.execution.script, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("canonical command detail exposes bounded command output only on demand", async () => {
  const events = [
    { method:"turn/started", params:{ turn:{ id:"turn-1" } }, emittedAtMs:1_000 },
    { method:"item/completed", params:{ turnId:"turn-1", item:{ id:"cmd-1", type:"commandExecution",
      command:`node -e "console.log('ok')"`, aggregatedOutput:"ok\nTOKEN=do-not-leak", status:"completed" } }, emittedAtMs:1_100 },
  ];
  const bridge = createCanonicalWorkPushBridge({ hydrate:async () => ({ events }), subscribeNative:() => () => {}, authorizeDetail:async () => true });
  await bridge.subscribe({ relayId:"r", sessionId:"s", subscriberId:"pill", send:() => {} });
  const result = await bridge.itemDetail({ relayId:"r", sessionId:"s", subscriberId:"pill", turnId:"turn-1", itemId:"cmd-1" });
  assert.equal(result.ok, true);
  assert.equal(result.detail.execution.command, `node -e "console.log('ok')"`);
  assert.match(result.detail.execution.transcript, /^ok/);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
});

test("attachment preview resolves only canonical membership for a live exact subscription", async () => {
  const state = {
    provider: "codex",
    events: [],
    turnOrder: ["turn-1"],
    turns: {
      "turn-1": {
        items: {
          user: {
            raw: {
              attachments: [{ id: "image-1", path: "/canonical/image.png", size: 12, sha256: "a".repeat(64) }],
            },
          },
        },
      },
    },
  };
  const h = harness({
    createState: () => state,
    hydrate: async () => ({ state }),
    presentAttachment: async (current, itemId, selector) => {
      const attachment = canonicalAttachmentReference(current, itemId, selector);
      return attachment ? { name: attachment.name, mimeType: "image/png", size: attachment.size, dataBase64: "AA==" } : null;
    },
  });
  assert.deepEqual(await h.bridge.attachment({
    relayId: "r", sessionId: "s", subscriberId: "view", turnId: "turn-1", itemId: "user", attachmentId: "image-1",
  }), { ok: false, error: "Not subscribed." });
  await h.bridge.subscribe({ relayId: "r", sessionId: "s", subscriberId: "view", send: () => {} });
  const accepted = await h.bridge.attachment({
    relayId: "r", sessionId: "s", subscriberId: "view", turnId: "turn-1", itemId: "user", attachmentId: "image-1",
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.dataBase64, "AA==");
  assert.deepEqual(await h.bridge.attachment({
    relayId: "r", sessionId: "s", subscriberId: "view", turnId: "turn-1", itemId: "user", attachmentId: "not-a-member",
  }), { ok: false, error: "Attachment is not part of this Work item." });
});

test("feed and subscriber bounds are enforced", async () => {
  const h = harness({ maxFeeds: 1, maxSubscribers: 1 });
  await h.bridge.subscribe({ relayId: "r1", sessionId: "s1", subscriberId: "one", send: () => {} });
  await assert.rejects(
    h.bridge.subscribe({ relayId: "r1", sessionId: "s1", subscriberId: "two", send: () => {} }),
    (error) => error?.code === "WORK_TOO_MANY_SUBSCRIBERS",
  );
  h.bridge.unsubscribe({ relayId: "r1", sessionId: "s1", subscriberId: "one" });
  await h.bridge.subscribe({ relayId: "r2", sessionId: "s2", subscriberId: "two", send: () => {} });
  assert.deepEqual(h.bridge.stats().map((entry) => entry.relayId), ["r2"]);
});
