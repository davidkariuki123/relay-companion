import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createOutbox } from "../src/outbox.cjs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function queue(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-text-lifecycle-"));
  const file = path.join(dir, "outbox.json");
  const outbox = createOutbox({ file, scheduleTimer: () => null, ...options });
  t.after(() => { outbox.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { outbox, file };
}
const entry = (id) => ({ idempotencyKey: id, text: "hello", recipient: { email: "friend@example.test" } });

test("delivery persists and the next text sends while contact refresh is still pending", async (t) => {
  const refresh = deferred();
  const sent = [];
  const { outbox, file } = queue(t, {
    send: async (row) => { sent.push(row.id); return { relayId: `relay_${row.id}` }; },
    onSent: (row) => {
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.find((e) => e.id === row.id).state, "sent");
      return refresh.promise;
    },
  });
  outbox.enqueue(entry("first"));
  outbox.enqueue(entry("second"));
  await outbox.flush();
  assert.deepEqual(sent, ["first", "second"]);
  assert.ok(outbox.list().every((row) => row.state === "sent"));
  refresh.reject(new Error("contacts offline"));
  await Promise.resolve();
  await outbox.flush();
  assert.equal(sent.length, 2, "a failed background read never resends a text");
});

test("a queued follower does not schedule zero-delay retries ahead of its backing-off head", async (t) => {
  const waits = [];
  let sends = 0;
  const { outbox } = queue(t, {
    now: () => 10_000,
    scheduleTimer: (_callback, delay) => { waits.push(delay); return null; },
    send: async () => { sends++; throw new TypeError("fetch failed"); },
  });
  outbox.enqueue(entry("first"));
  outbox.enqueue(entry("second"));
  await outbox.flush();
  assert.equal(sends, 1);
  assert.deepEqual(waits, [1000]);
});

test("queue revisions cover enqueue, acceptance and retirement; send identity survives restart", async (t) => {
  const { outbox, file } = queue(t, { send: async () => ({ relayId: "canonical" }) });
  assert.equal(outbox.revision(), 0);
  outbox.enqueue({ ...entry("stable"), clientMessageId: "stable" });
  assert.equal(outbox.revision(), 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries[0].clientMessageId, "stable");
  await outbox.flush();
  assert.equal(outbox.revision(), 2);
  outbox.retireConfirmed({ relayIds: ["canonical"] });
  assert.equal(outbox.revision(), 3);
  assert.deepEqual(outbox.list(), []);
});

test("an upgrade never adds new request metadata to a previously queued retry", async (t) => {
  const requests = [];
  const { outbox, file } = queue(t, { send: async (row) => { requests.push(row); return { relayId: "canonical" }; } });
  outbox.enqueue(entry("legacy"));
  outbox.reload();
  const retry = outbox.enqueue({ ...entry("legacy"), clientMessageId: "legacy" });
  assert.equal(retry.clientMessageId, undefined, "a retry keeps the original request hash across an upgrade");
  await outbox.flush();
  assert.equal(requests[0].clientMessageId, undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 1);
});

function renderer() {
  // onPayload also settles Task state that the record has since confirmed. That
  // is a different surface from this race, so it is stubbed rather than run.
  const context = vm.createContext({
    latestOutboxRevision: 0,
    cardViewTransition: null,
    optimisticChatReplies: new Map(),
    payload: {},
    settleTaskLocalState: () => {},
  });
  vm.runInContext(section("  function acceptOutboxReceipt(", "  function activeSlackRoomRecoveryMatches("), context);
  vm.runInContext(section("  function syncOutboxProjection()", "  // The room composer is wired ONCE"), context);
  // Run the real payload admission guard, then the real queue projection. The
  // remainder of onPayload draws unrelated surfaces and is outside this race.
  vm.runInContext(`${section("  function onPayload(next)", "    if (readerMorphSnapshot)")}
    payload = next; syncOutboxProjection(); return true; }`, context);
  return context;
}

test("a refresh predating enqueue cannot erase the bubble accepted by IPC", () => {
  const r = renderer();
  r.optimisticChatReplies.set("one", { body: "hello" });
  r.acceptOutboxReceipt({ outboxRevision: 1, entry: { id: "one", state: "queued" } }, "one");
  assert.equal(r.onPayload({ outboxRevision: 0, outbox: [], sent: [] }), undefined);
  assert.equal(r.optimisticChatReplies.get("one").body, "hello");
  r.onPayload({ outboxRevision: 1, outbox: [{ id: "one", state: "queued", text: "hello" }] });
  assert.equal(r.optimisticChatReplies.size, 1);
  r.onPayload({ outboxRevision: 2, outbox: [{ id: "one", state: "sent", relayId: "canonical", text: "hello" }] });
  r.acceptOutboxReceipt({ outboxRevision: 1, entry: { id: "one", state: "queued" } }, "one");
  assert.equal(r.optimisticChatReplies.get("one").outboxState, "sent", "late IPC cannot regress delivery");
  r.onPayload({ outboxRevision: 3, outbox: [], sent: [{ relayId: "canonical" }] });
  r.onPayload({ outboxRevision: 1, outbox: [], sent: [] });
  assert.equal(r.payload.sent[0].relayId, "canonical", "an old full snapshot cannot retract history after retirement");
});

test("an IPC retry returning an already accepted entry immediately carries its canonical identity", () => {
  const r = renderer();
  r.optimisticChatReplies.set("one", { id: "optimistic:one", body: "hello", pending: true });
  r.acceptOutboxReceipt({ outboxRevision: 2, entry: {
    id: "one", state: "sent", relayId: "canonical", groupSendId: "fanout", threadId: "room",
  } }, "one");
  const message = r.optimisticChatReplies.get("one");
  assert.equal(message.id, "canonical");
  assert.equal(message.relayId, "canonical");
  assert.equal(message.groupSendId, "fanout");
  assert.equal(message.pending, false);
});

function composer({ files = [], prepare = async () => ({ files: [], attachments: [] }), send } = {}) {
  const calls = [];
  const input = { value: "hello", setSelectionRange() {}, focus() {} };
  const edits = [];
  const address = { threadId: "room", party: "Friend", addressRecipient: { email: "friend@example.test" } };
  const c = vm.createContext({
    latestOutboxRevision: 0, optimisticChatReplies: new Map(), chatReplySending: new Set(),
    threadReplyAttemptKeys: new Map(), threadReplyTargets: new Map(), threadComposerDrafts: new Map(),
    threadEditTargets: new Map(), edits, doThEditSave: () => { edits.push(input.value); },
    threadStateKey: "room", thReplySending: false, thQrInput: input, thQrSend: {},
    thread: { ...address, msgs: [] }, chatRoom: null, addressAnchor: address,
    messageById: new Map(), focusedSlackParent: null, threadDetailFollowSendFor: null,
    payload: { features: {} }, crypto: { randomUUID: () => `uuid-${calls.length}` },
    peekStagedFiles: () => files, takeStagedFiles() {}, stageFileList() {},
    composerFilePayloads: prepare, setRowNote() {}, renderThreadDetail() {},
    chatTypingController: { stop() {} }, document: { getElementById: () => input },
    window: { relay: { sendReply: (request) => {
      calls.push(request);
      return send ? send(request) : Promise.resolve({ ok: true, outboxRevision: calls.length, entry: { id: request.idempotencyKey } });
    } } },
  });
  vm.runInContext(section("  function acceptOutboxReceipt(", "  function activeSlackRoomRecoveryMatches("), c);
  vm.runInContext(`${section("      const doThReply = async () => {", "      threadComposerSend = doThReply;")}
    globalThis.send = doThReply;`, c);
  return { c, calls, input };
}

test("plain text paints and enters IPC synchronously, while the next identical text gets a new identity", async () => {
  const { c, calls, input } = composer();
  const sending = c.send();
  assert.equal(c.optimisticChatReplies.size, 1, "paint happens before the first await");
  assert.equal(calls.length, 1);
  assert.equal(input.value, "");
  await sending;
  input.value = "hello";
  await c.send();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test("rapid send gestures during attachment preparation enqueue once, including after a rerender", async () => {
  const prepared = deferred();
  let prepares = 0;
  const { c, calls } = composer({ files: [{ name: "photo" }], prepare: () => { prepares++; return prepared.promise; } });
  const sending = c.send();
  c.thReplySending = false; // a newly rendered closure has a fresh local guard
  await c.send();
  assert.equal(prepares, 1, "the room-scoped guard was set before file work yielded");
  prepared.resolve({ files: [{ name: "photo" }], attachments: [] });
  await sending;
  assert.equal(calls.length, 1);
});

test("Send while editing saves the edit and never sends a new message", async () => {
  const { c, calls, input } = composer();
  c.threadEditTargets.set("room", "sent-1");
  await c.send();
  assert.equal(calls.length, 0);
  assert.equal(c.optimisticChatReplies.size, 0);
  assert.deepEqual([...c.edits], ["hello"]);
  assert.equal(input.value, "hello");
});

test("file preparation failure releases the send guard and retains the draft", async () => {
  const { c, calls, input } = composer({ files: [{ name: "photo" }], prepare: async () => { throw new Error("unreadable"); } });
  await c.send();
  assert.equal(calls.length, 0);
  assert.equal(c.chatReplySending.size, 0);
  assert.equal(c.thQrSend.disabled, false);
  assert.equal(input.value, "hello");
});
