import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function pillFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `inbox.html defines ${name}`);
  let depth = 0;
  for (let end = html.indexOf("{", start); end < html.length; end += 1) {
    if (html[end] === "{") depth += 1;
    if (html[end] === "}" && --depth === 0) return html.slice(start, end + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Exercise the reader's real composer and click handler, capturing IPC sends
// in memory: no message leaves the test, including on failure.
function readerHarness({ row, sent = [], chats = [], groups = [], canonical = [], fail = false }) {
  const id = row?.id || sent[0]?.relayId || canonical[0]?.items[0]?.relayId;
  const start = html.indexOf("let readerReplySending = false;", html.indexOf("function renderReader()"));
  const end = html.indexOf("dressComposer(input, doSend);", start);
  assert.ok(start >= 0 && end > start, "the reader binds its reply handler");
  const state = {
    id, payload: { relays: row ? [row] : [], sent, chats }, groupsList: groups,
    canonicalChatDetails: new Map(canonical.map((chat) => [chat.chatId, chat])),
    optimisticChatReplies: new Map(), readerHumanDrafts: new Map(),
    input: { value: "Thanks, that makes sense.", isConnected:true, addEventListener() {}, focus() {} },
    send: { disabled: false, addEventListener(_event, handler) { state.click = handler; } },
    notes: [], calls: [],
    window: { relay: { async sendReply(request) {
      state.calls.push(request);
      return fail ? { ok: false, error: "Could not save reply" }
        : { ok: true, entry: { id: request.idempotencyKey, state: "queued" } };
    } } },
  };
  const functions = ["readerRow", "sentGroupLabel", "readerReplyChat", "replyRail", "composerHtml", "syncOutboxProjection"];
  const render = new Function("state", `
    const { id, payload, groupsList, canonicalChatDetails, optimisticChatReplies,
      readerHumanDrafts, input, send, window } = state;
    const request = false, onWork = false, onAgent = false, providerPrompt = null;
    const activeView = "reader", readerId = id;
    const directContactAnchorForChatId = () => null;
    const relaySender = (r) => r.senderName || r.senderEmail || "Someone";
    const sentRecipient = (r) => r.recipient?.name || r.recipient?.email || "Recipient";
    const sentSubject = (r) => r.title || "Relay";
    const avatarHue = () => 100;
    const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const agentMentionSpans = () => [];
    const setRowNote = (...note) => state.notes.push(note);
    const fadeRowNoteLater = () => {};
    const renderReader = () => {};
    const chatTypingController = { stop() {} };
    ${functions.map(pillFunction).join("\n")}
    const r = readerRow(id);
    const sender = relaySender(r);
    const replyChat = readerReplyChat(r);
    input.relayReplyContext = { r, replyChat };
    ${html.slice(start, end)}
    return { r, replyChat, markup: composerHtml(), syncOutboxProjection };
  `);
  return Object.assign(state, render(state));
}

const shaneRelay = {
  id: "relay_shane", threadId: "relay_shane", title: "Transport decision",
  senderName: "Shane Acton", senderEmail: "shane@example.com",
  recipientGroupId: "grp_granular", recipientGroupName: "Granular",
};

test("the expanded reader names Granular and queues a reply to Shane's exact group Relay", async () => {
  const state = readerHarness({ row: shaneRelay });
  assert.match(state.markup, /to Granular<\/span>/);
  assert.doesNotMatch(state.markup, /to Shane Acton/);
  await state.click();
  assert.equal(state.calls.length, 1);
  const [request] = state.calls;
  assert.equal(request.inReplyToRelayId, "relay_shane");
  assert.equal(request.recipient, undefined, "the server resolves the destination from the selected parent");
  assert.equal(request.chat.isGroup, true);
  assert.equal(request.chat.groupId, "grp_granular");
  assert.equal(request.chat.groupName, "Granular");
  assert.equal(request.chat.party, "Granular");
  const [pending] = state.optimisticChatReplies.values();
  assert.equal(pending.isGroup, true);
  assert.equal(pending.groupId, request.chat.groupId);
  assert.equal(pending.partyKey, request.chat.partyKey);
  assert.equal(pending.inReplyToRelayId, "relay_shane");
  assert.deepEqual(state.notes.at(-1), ["relay_shane", "Sent to Granular.", "ok"]);
});

test("a queued reader reply restores in Granular after a renderer restart", async () => {
  const state = readerHarness({ row: shaneRelay });
  await state.click();
  state.payload.outbox = [{ id: "queue_group", ...state.calls[0], state: "queued" }];
  state.optimisticChatReplies.clear();
  state.syncOutboxProjection();
  const restored = state.optimisticChatReplies.get("queue_group");
  assert.equal(restored.isGroup, true);
  assert.equal(restored.groupId, "grp_granular");
  assert.equal(restored.groupName, "Granular");
  assert.equal(restored.party, "Granular");
  assert.equal(restored.explicitReply, true);
  assert.equal(restored.inReplyToRelayId, "relay_shane");
});

test("a missing packet group name is recovered from the exact channel, even when Shane has a direct chat", () => {
  const state = readerHarness({
    row: { ...shaneRelay, recipientGroupName: "" },
    chats: [
      { chatId: "chat_shane", title: "Shane Acton", kind: "direct" },
      { chatId: "grp_granular", title: "Granular", kind: "group", group: { groupId: "grp_granular", name: "Granular" } },
    ],
  });
  assert.match(state.markup, /to Granular<\/span>/);
  assert.equal(state.replyChat.chatId, "grp_granular");
});

test("the current saved channel name wins over an old packet name", () => {
  const state = readerHarness({
    row: { ...shaneRelay, recipientGroupName: "Old name" },
    groups: [{ id: "grp_unrelated", name: "Wrong channel" }, { id: "grp_granular", name: "Granular" }],
  });
  assert.match(state.markup, /to Granular<\/span>/);
});

test("an unloaded channel remains a channel instead of displaying Shane as the destination", () => {
  const state = readerHarness({ row: { ...shaneRelay, recipientGroupName: "" } });
  assert.match(state.markup, /to Channel<\/span>/);
  assert.equal(state.replyChat.isGroup, true);
  assert.equal(state.replyChat.groupId, "grp_granular");
});

test("a direct inbound Relay still replies to Shane", async () => {
  const state = readerHarness({ row: { ...shaneRelay, recipientGroupId: "", recipientGroupName: "" } });
  assert.match(state.markup, /to Shane Acton<\/span>/);
  await state.click();
  assert.equal(state.calls[0].chat.isGroup, false);
  assert.equal(state.calls[0].chat.partyKey, "email:shane@example.com");
  assert.equal(state.calls[0].inReplyToRelayId, shaneRelay.id);
});

test("opening a sent group copy retains the room instead of selecting one member", async () => {
  const state = readerHarness({ sent: [{
    relayId: "relay_sent", threadId: "relay_sent", groupSendId: "gsend_one",
    recipientGroupId: "grp_granular", recipientGroupName: "Granular",
    recipient: { name: "Shane Acton", email: "shane@example.com" },
  }] });
  assert.match(state.markup, /to Granular<\/span>/);
  await state.click();
  assert.equal(state.calls[0].chat.groupId, "grp_granular");
  assert.equal(state.calls[0].inReplyToRelayId, "relay_sent");
});

test("a sent direct Relay addresses its recipient without the reader's You arrow", () => {
  const state = readerHarness({ sent: [{
    relayId: "relay_sent", recipient: { name: "Shane Acton", email: "shane@example.com" },
  }] });
  assert.match(state.markup, /to Shane Acton<\/span>/);
  assert.doesNotMatch(state.markup, /You →/);
  assert.equal(state.replyChat.partyKey, "email:shane@example.com");
});

test("an older group Relay available only in canonical chat history retains Granular", async () => {
  const state = readerHarness({ canonical: [{
    chatId: "grp_granular", title: "Granular", kind: "group",
    group: { groupId: "grp_granular", name: "Granular" },
    items: [{ relayId: "relay_old", threadId: "relay_old", direction: "inbound", sender: { name: "Shane Acton" } }],
  }] });
  assert.match(state.markup, /to Granular<\/span>/);
  await state.click();
  assert.equal(state.calls[0].chat.groupId, "grp_granular");
  assert.equal(state.calls[0].chat.chatId, "grp_granular");
  assert.equal(state.calls[0].inReplyToRelayId, "relay_old");
});

test("a refused outbox write preserves the draft and never claims the reply was sent", async () => {
  const state = readerHarness({ row: shaneRelay, fail: true });
  await state.click();
  assert.equal(state.input.value, "Thanks, that makes sense.");
  assert.equal(state.optimisticChatReplies.size, 0);
  assert.deepEqual(state.notes.at(-1), ["relay_shane", "Could not save reply", "err"]);
});
