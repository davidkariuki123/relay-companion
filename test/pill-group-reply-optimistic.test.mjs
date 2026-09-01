// A reply into a group room fans out to one sibling relay per member, and the
// send response names fanout[0] — the first-sorted, first-inserted, OLDEST
// sibling — while the newest-first transcript collapse keeps the newest one.
// The optimistic "You" bubble was retired only on an exact relay-id match, so
// for any room with two or more other people it could never retire: the
// sender's own reply rendered twice, and optimisticChatReplies grew until the
// pill restarted (Sven, Granular room, 2026-08-18). These pin the
// groupSendId-aware retirement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function pillFunction(name) {
  const start = html.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `inbox.html defines ${name}`);
  let depth = 0;
  let i = html.indexOf("{", start);
  for (let end = i; end < html.length; end += 1) {
    if (html[end] === "{") depth += 1;
    else if (html[end] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, end + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Run the real threadMessages against a minimal payload. Every collaborator it
// reaches for is stubbed to its plain-correspondence behavior; the collapse
// and reconciliation under test are the extracted code itself.
function runThreadMessages(payload, optimisticChatReplies, { realDelivery = false, realClassifier = false } = {}) {
  // The delivery fold is the code under test in its own case, so that case runs
  // the REAL sentIsRead/sentIsDelivered pair (the declarations shadow the
  // stub parameters of the same name) instead of a stub that would beg it.
  const selfAuthored = pillFunction("relayIsSelfAuthored");
  const source = [
    realDelivery ? pillFunction("sentIsRead") : "",
    realDelivery ? pillFunction("sentIsDelivered") : "",
    realClassifier ? pillFunction("relayTextLike") : "",
    selfAuthored,
    pillFunction("threadMessages"),
    "return threadMessages();",
  ].filter(Boolean).join("\n");
  return new Function(
    "payload", "optimisticChatReplies", "canonicalChatDetails", "contactChatAnchors",
    "requestThreadIds", "isTaskRow", "isRelayListKind", "onRequestThread",
    "relaySubject", "relayTextLike", "isCompletionRelay", "relaySender",
    "bodyPreview", "sentRecipient", "sentIsRead", "sentIsDelivered", "sentSubject",
    `"use strict"; ${source}`,
  )(
    payload, optimisticChatReplies, new Map(), new Map(),
    () => new Set(), () => false, () => true, () => false,
    (r) => String(r.title || ""), () => true, () => false,
    (r) => String(r.senderName || "Sender"),
    () => "", (s) => (s.recipient && s.recipient.name) || "member",
    () => false, () => false, (s) => String(s.title || ""),
  );
}

// The Granular shape: two receiving members, siblings 66ms apart, the Sent
// projection newest-first, the response naming the OLDEST sibling.
function groupReplyPayload() {
  return {
    relays: [],
    sent: [
      { relayId: "relay_B", groupSendId: "gsend_1", threadId: "thread_1", title: "hey room",
        forHuman: "hey room", createdAt: "2026-08-18T11:28:38.319Z",
        recipientGroupName: "Granular", recipient: { name: "Shane", email: "shane@x.com" } },
      { relayId: "relay_A", groupSendId: "gsend_1", threadId: "thread_1", title: "hey room",
        forHuman: "hey room", createdAt: "2026-08-18T11:28:38.253Z",
        recipientGroupName: "Granular", recipient: { name: "David", email: "david@x.com" } },
    ],
  };
}

test("a group reply's optimistic bubble retires even though the surviving sibling is not the response relayId", () => {
  const optimistic = new Map();
  optimistic.set("k1", {
    id: "relay_A", relayId: "relay_A", groupSendId: "gsend_1", threadId: "thread_1",
    direction: "out", title: "hey room", body: "hey room", pending: false,
  });
  const msgs = runThreadMessages(groupReplyPayload(), optimistic);
  const outbound = msgs.filter((m) => m.direction === "out");
  assert.equal(outbound.length, 1, "exactly one outbound bubble for one logical group reply");
  assert.equal(optimistic.size, 0, "the optimistic store drains instead of growing until restart");
});

test("an unconfirmed group reply stays visible until a canonical sibling lands", () => {
  const optimistic = new Map();
  optimistic.set("k1", {
    id: "optimistic:k1", relayId: "", groupSendId: "", threadId: "thread_1",
    direction: "out", title: "hey room", body: "hey room", pending: true,
  });
  const msgs = runThreadMessages({ relays: [], sent: [] }, optimistic);
  assert.equal(msgs.filter((m) => m.direction === "out").length, 1, "the in-flight bubble renders");
  assert.equal(optimistic.size, 1, "nothing retires before the send is confirmed and projected");
});

test("a direct reply still retires on its exact relay id", () => {
  const optimistic = new Map();
  optimistic.set("k1", {
    id: "relay_D", relayId: "relay_D", groupSendId: "", threadId: "thread_d",
    direction: "out", title: "hi", body: "hi", pending: false,
  });
  const msgs = runThreadMessages({
    relays: [],
    sent: [{ relayId: "relay_D", threadId: "thread_d", title: "hi", forHuman: "hi",
      createdAt: "2026-08-18T11:00:00.000Z", recipient: { name: "Sven", email: "sven@x.com" } }],
  }, optimistic);
  assert.equal(msgs.filter((m) => m.direction === "out").length, 1);
  assert.equal(optimistic.size, 0);
});

test("an inbound file-only chat message stays an ordinary message and owns its attachment", () => {
  const image = { id: "att_in", name: "photo.jpeg", bytes: 23165, contentType: "image/jpeg" };
  const msgs = runThreadMessages({
    relays: [{
      id: "relay_in", threadId: "thread_in", title: "photo.jpeg", forHuman: " ", forAgent: "",
      senderName: "Jordan", senderEmail: "jordan@example.com", createdAt: "2026-09-01T08:00:00.000Z",
      attachments: [image],
    }],
    sent: [],
  }, new Map(), { realClassifier: true });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].textLike, true, "a file does not turn a chat message into a Relay");
  assert.deepEqual(msgs[0].attachments, [image], "the renderer receives attachment data on the message itself");
  assert.equal(msgs[0].body, " ", "the transport placeholder never becomes a fake filename body");
});

test("a sent text-and-image chat message stays ordinary after canonical reconciliation", () => {
  const image = { id: "att_out", name: "diagram.png", bytes: 4096, contentType: "image/png" };
  const msgs = runThreadMessages({
    relays: [],
    sent: [{
      relayId: "relay_out", threadId: "thread_out", title: "caption", forHuman: "caption", forAgent: "",
      createdAt: "2026-09-01T08:01:00.000Z", recipient: { name: "Jordan", email: "jordan@example.com" },
      attachments: [image],
    }],
  }, new Map(), { realClassifier: true });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].textLike, true);
  assert.equal(msgs[0].body, "caption");
  assert.deepEqual(msgs[0].attachments, [image]);
});

test("a file-only group fan-out collapses to one ordinary message with its image intact", () => {
  const image = { id: "att_group", name: "group-photo.jpeg", bytes: 23165, contentType: "image/jpeg" };
  const siblings = ["Shane", "Jordan"].map((name, index) => ({
    relayId: `relay_group_${index}`, groupSendId: "gsend_image", threadId: "thread_group",
    title: "group-photo.jpeg", forHuman: " ", forAgent: "", attachments: [image],
    createdAt: `2026-09-01T08:01:0${index}.000Z`, recipientGroupName: "Granular",
    recipient: { name, email:`${name.toLowerCase()}@example.com` },
  }));
  const msgs = runThreadMessages({ relays: [], sent: siblings }, new Map(), { realClassifier: true });

  assert.equal(msgs.length, 1, "one group send remains one chat message");
  assert.equal(msgs[0].textLike, true, "the group image does not grow Relay agent actions");
  assert.deepEqual(msgs[0].attachments, [image]);
});

test("an attached agent document remains a Relay while retaining the same cargo", () => {
  const file = { id: "att_doc", name: "evidence.pdf", bytes: 8192, contentType: "application/pdf" };
  const msgs = runThreadMessages({
    relays: [],
    sent: [{
      relayId: "relay_doc", threadId: "thread_doc", title: "Investigation", forHuman: "Here is the result.",
      forAgent: "Full evidence for the recipient's agent.", createdAt: "2026-09-01T08:02:00.000Z",
      recipient: { name: "Jordan", email: "jordan@example.com" }, attachments: [file],
    }],
  }, new Map(), { realClassifier: true });

  assert.equal(msgs[0].textLike, false, "the agent document, not the file, defines the Relay species");
  assert.deepEqual(msgs[0].attachments, [file]);
});

test("the durable outbox restores attachment cargo without exposing its spool path", () => {
  const optimistic = new Map();
  const source = `${pillFunction("syncOutboxProjection")}\nreturn syncOutboxProjection();`;
  new Function("payload", "optimisticChatReplies", `"use strict"; ${source}`)({
    outbox: [{
      id: "queue_1", state: "queued", text: "", createdAt: "2026-09-01T08:03:00.000Z",
      files: [{ name: "offline.jpg", size: 1234, contentType: "image/jpeg", spoolPath: "/private/outbox/secret" }],
      recipient: { email: "jordan@example.com" }, chat: { party: "Jordan" },
    }],
  }, optimistic);

  const row = optimistic.get("queue_1");
  assert.deepEqual(row.attachments, [{ name: "offline.jpg", bytes: 1234, contentType: "image/jpeg" }]);
  assert.equal(JSON.stringify(row).includes("spoolPath"), false, "renderer state carries metadata, never private file paths");
  assert.equal(row.textLike, true);
});

test("a self-send keeps the richer inbox copy but renders as my outbound message", () => {
  const msgs = runThreadMessages({
    account: { email: "shane@example.com" },
    relays: [{
      id: "relay_self", threadId: "thread_self", title: "hello", forHuman: "hello",
      senderName: "Shane Acton", senderEmail: "shane@example.com", unread: true,
      createdAt: "2026-08-25T10:00:00.000Z",
    }],
    sent: [{
      relayId: "relay_self", threadId: "thread_self", title: "hello", forHuman: "hello",
      state: "delivered", createdAt: "2026-08-25T10:00:00.000Z",
      recipient: { name: "Shane Acton", email: "shane@example.com" },
    }],
  }, new Map());

  assert.equal(msgs.length, 1, "the inbox and sent projections remain one bubble");
  assert.equal(msgs[0].direction, "out", "the author sees their note-to-self as sent");
  assert.equal(msgs[0].unread, false, "my own message cannot make my room unread");
  assert.equal(msgs[0].body, "hello", "the richer inbox body is retained");
  assert.equal(msgs[0].readReceipts[0].name, "Shane Acton");
});

test("a self-send is outbound on first paint before sent history hydrates", () => {
  const msgs = runThreadMessages({
    account: { email: "shane@example.com" },
    relays: [{
      id: "relay_self", threadId: "thread_self", title: "hello", forHuman: "hello",
      senderName: "Shane Acton", senderEmail: "SHANE@example.com", unread: true,
      createdAt: "2026-08-25T10:00:00.000Z",
    }],
    sent: [],
  }, new Map());

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].direction, "out", "the signed-in sender address establishes authorship immediately");
  assert.equal(msgs[0].unread, false);
  assert.deepEqual(msgs[0].readReceipts, [], "receipts can hydrate later without changing ownership");
});

test("the groupSendId that retires a bubble is stamped by the device's queue, not by a send response", () => {
  // The reconciliation can only match what something recorded; a hand-built
  // row in the tests above cannot pin that, so pin the source.
  //
  // Neither composer awaits a send response any more — the send is committed
  // to the outbox and answered immediately — so the fan-out's shared id now
  // arrives on the payload, from the queue entry the main process updated when
  // the attempt eventually succeeded.
  assert.match(html, /groupSendId: String\(entry\.groupSendId \|\| ""\)/);
  assert.match(html, /optimistic\.groupSendId && seenGroupSends\.has\(String\(optimistic\.groupSendId\)\)/);
  assert.doesNotMatch(
    html,
    /optimistic\.groupSendId = String\(\(res\.result && res\.result\.groupSendId\) \|\| ""\);/,
    "no composer reads a groupSendId out of a response it waited for",
  );
  // Both composers hand the message to the queue and hold their bubble under
  // the queue's own key until the projection takes it over.
  const handoffs = html.match(/optimistic\.outboxId = String\(res\.entry\.id \|\| idempotencyKey\);/g) || [];
  assert.equal(handoffs.length, 2, "room composer and reader reply both hand off to the outbox");
});

test("a group is Delivered only when EVERY member's sibling is", () => {
  // The transcript collapses a fan-out to one sibling. Asking that survivor
  // alone would call the room delivered on the strength of whichever member
  // happened to sort first — the same class of bug as the id-only retirement
  // above, and just as invisible in a two-person room.
  const siblings = (states) => ({
    relays: [],
    sent: states.map((state, i) => ({
      relayId: `relay_${i}`, groupSendId: "gsend_1", threadId: "thread_1", state,
      title: "hey room", forHuman: "hey room",
      createdAt: `2026-08-18T11:28:3${i}.000Z`,
      recipientGroupName: "Granular", recipient: { name: `member${i}`, email: `m${i}@x.com` },
    })),
  });

  const partly = runThreadMessages(siblings(["delivered", "pending"]), new Map(), { realDelivery: true });
  assert.equal(partly.filter((m) => m.direction === "out").length, 1);
  assert.equal(partly.find((m) => m.direction === "out").delivered, false, "one member short is not delivered");

  const all = runThreadMessages(siblings(["delivered", "read"]), new Map(), { realDelivery: true });
  assert.equal(all.find((m) => m.direction === "out").delivered, true, "read outranks delivered, and everyone has it");

  const none = runThreadMessages(siblings(["pending", "pending"]), new Map(), { realDelivery: true });
  assert.equal(none.find((m) => m.direction === "out").delivered, false);
});
