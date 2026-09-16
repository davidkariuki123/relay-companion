// A reply into a group names the sibling row the REPLIER received. The room
// keeps one bubble per fan-out I sent, under one sibling's id, so a reply from
// any other member found no parent and rendered with no quote card — the
// reply read as a bare text (Shane, Granular, 2026-09-16: "the reply didnt
// come through"). These pin the sibling aliases that make every id resolve.
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

// The real threadMessages against a minimal payload, collaborators stubbed to
// plain-correspondence behavior (same harness as pill-group-reply-optimistic).
function runThreadMessages(payload) {
  const source = [
    "const activeMentionVisit = null;",
    pillFunction("relayIsSelfAuthored"),
    pillFunction("threadMessages"),
    "return threadMessages();",
  ].join("\n");
  return new Function(
    "payload", "optimisticChatReplies", "canonicalChatDetails", "contactChatAnchors", "localChatSendTimes",
    "requestThreadIds", "isTaskRow", "isRelayListKind", "onRequestThread",
    "relaySubject", "relayTextLike", "isCompletionRelay", "relaySender",
    "bodyPreview", "sentRecipient", "sentIsRead", "sentIsDelivered", "sentIsAcknowledged", "sentSubject",
    `"use strict"; ${source}`,
  )(
    payload, new Map(), new Map(), new Map(), new Map(),
    () => new Set(), () => false, () => true, () => false,
    (r) => String(r.title || ""), () => true, () => false,
    (r) => String(r.senderName || "Sender"),
    () => "", (s) => (s.recipient && s.recipient.name) || "member",
    () => false, () => false, () => false, (s) => String(s.title || ""),
  );
}

// Shane's shape: his Sep 12 Relay fanned out to Sven and David; the Sent
// projection lists Sven's sibling first, so the room keeps that one. David's
// reply names David's sibling.
const SVEN_ROW = "relay_20260912165719040_svenrow0001";
const DAVID_ROW = "relay_20260912165719040_davidrow001";
function shanePayload() {
  const sibling = (relayId, name) => ({
    relayId, groupSendId: "gsend_1", threadId: SVEN_ROW, title: "Mid-session Relay reminders", forHuman: "Staging has a new behaviour…",
    forAgent: "# facts", createdAt: "2026-09-12T16:57:19.041Z", recipientGroupName: "Granular",
    recipient: { name, email: `${name.toLowerCase()}@x.com` },
  });
  return {
    account: { email: "shane@x.com" },
    relays: [{
      id: "relay_reply", direction: "inbound", state: "delivered", kind: "message", senderName: "David Kariuki", senderEmail: "david@x.com",
      forHuman: "hey sorry i missed this", createdAt: "2026-09-15T23:12:01.632Z", inReplyToRelayId: DAVID_ROW, threadId: SVEN_ROW,
      recipientGroupName: "Granular", source: { host: "relay-preview", clientVersion: "0.1.529" },
    }],
    sent: [sibling(SVEN_ROW, "Sven"), sibling(DAVID_ROW, "David")],
  };
}

test("the one bubble kept for a fan-out I sent answers to every sibling id", () => {
  const msgs = runThreadMessages(shanePayload());
  const outbound = msgs.filter((m) => m.direction === "out");
  assert.equal(outbound.length, 1, "one bubble per logical group message");
  assert.equal(outbound[0].id, SVEN_ROW, "the collapse still keeps the first-listed sibling");
  assert.deepEqual(outbound[0].siblingIds, [SVEN_ROW, DAVID_ROW], "and carries every id a member may reply to");
  const reply = msgs.find((m) => m.id === "relay_reply");
  assert.equal(reply.inReplyToRelayId, DAVID_ROW, "the reply keeps naming the sibling David held");
  assert.deepEqual(reply.siblingIds, [], "an inbound message from someone else has no siblings of mine");
});

test("a self-copy of my own fan-out carries the same sibling ids as its sent twins", () => {
  const payload = shanePayload();
  payload.relays.push({
    id: "relay_20260912165719040_ownercopy01", direction: "inbound", state: "read", kind: "message", senderName: "Shane Acton", senderEmail: "shane@x.com",
    title: "Mid-session Relay reminders", forHuman: "Staging has a new behaviour…", forAgent: "# facts", createdAt: "2026-09-12T16:57:19.041Z",
    groupSendId: "gsend_1", threadId: SVEN_ROW, recipientGroupName: "Granular",
  });
  payload.sent.push({ ...payload.sent[0], relayId: "relay_20260912165719040_ownercopy01", recipient: { name: "Shane", email: "shane@x.com" } });
  const own = runThreadMessages(payload).find((m) => m.id === "relay_20260912165719040_ownercopy01");
  assert.equal(own.direction, "out");
  assert.deepEqual(own.siblingIds, [SVEN_ROW, DAVID_ROW, "relay_20260912165719040_ownercopy01"]);
});

test("the room index resolves a reply's parent through sibling ids and jumps to the kept bubble", () => {
  const render = html.slice(html.indexOf("const messageById = new Map(thread.msgs.map("), html.indexOf("const composerReplyTargetHtml"));
  assert.match(render, /for \(const sibling of message\.siblingIds \|\| \[\]\)/, "every sibling id is registered as an alias of its bubble");
  assert.match(render, /if \(siblingId && !messageById\.has\(siblingId\)\) messageById\.set\(siblingId, message\)/, "an alias never shadows a real message id");
  assert.match(render, /const parent = messageById\.get\(parentId\);/, "the reply-ref still resolves through the one index");
  assert.match(render, /data-reply-ref="\$\{esc\(String\(parent\.id \|\| parentId\)\)\}"/, "the jump targets the bubble the room kept, not the id the reply named");
});
