// One logical group send must render as ONE Sent row. The server writes one
// sibling relay per roster member (shared groupSendId) and SentRelayItem says
// "aggregate rows by it" — the web Sent page does; the pill didn't, so a reply
// into a two-person chat showed as two duplicated sends (field report
// 2026-08-12, Sven + Shane). These pin the pill-side collapse.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("Sent collapses fan-out siblings by groupSendId into one row", () => {
  assert.match(html, /function sentListRows\(rows\)/);
  assert.match(html, /const gid = r && r\.groupSendId/);
  // Siblings append to the FIRST row's member list instead of adding a row.
  assert.match(html, /if \(members\) \{ members\.push\(r\); continue; \}/);
  // renderSent iterates the collapsed rows, never the raw sibling list.
  assert.match(html, /sentListEl\.innerHTML = sentListRows\(rows\)\.map\(\(members\) => \{/);
});

test("a group row is labelled by roster, not by one sibling's recipient", () => {
  assert.match(html, /function sentGroupLabel\(members\)/);
  assert.match(html, /m\.recipientGroupName/);
  assert.match(html, /members\.map\(sentRecipient\)\.join\(", "\)/);
});

test("a group row carries per-member receipts, not one member's state", () => {
  // Partial reads show as a fraction; the row settles only when ALL read.
  assert.match(html, /`Read \$\{readCount\}\/\$\{members\.length\}`/);
  assert.match(html, /const read = isGroup \? readCount === members\.length : sentIsRead\(r\)/);
  // Small rosters spell out who read and who hasn't.
  assert.match(html, /function sentGroupDetail\(members, readCount\)/);
});

test("the thread transcript keeps a single outbound copy per group send", () => {
  assert.match(html, /const seenGroupSends = new Set\(\)/);
  assert.match(html, /if \(seenGroupSends\.has\(s\.groupSendId\)\) continue/);
});

// The reader is the fourth surface a group send reaches, and it was the one
// that still named a sibling: opening your own message to "Bugs and Features"
// headed the page "You → Shane Acton" — one member of the room, picked by
// whichever fan-out copy the list happened to hand over (David, 2026-08-18).
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

function readerFor(payload, id, canonicalChatDetails = new Map()) {
  const source = `${pillFunction("readerRow")}\n${pillFunction("sentGroupLabel")}\nreturn readerRow(id);`;
  // Only the naming path is under test; the row's other fields come straight
  // off the sent item, so the neighbours it calls are stubbed to their answer.
  return new Function(
    "payload",
    "id",
    "canonicalChatDetails",
    "directContactAnchorForChatId",
    "sentRecipient",
    "sentSubject",
    source,
  )(
    payload,
    id,
    canonicalChatDetails,
    () => null,
    (r) => (r.recipient && r.recipient.name) || "Recipient",
    (r) => r.title || "Relay",
  );
}

const HTML_ATTACHMENT = {
  id: "att_design", fileId: "att_design", name: "settings-and-other.html",
  contentType: "text/html", bytes: 2417885, sha256: "fixture-checksum",
};

function attachmentShelfFor(row) {
  return new Function("relay", "esc", "fmtBytes", "fileFamilyOf", "fileIconSvg",
    `${pillFunction("relaySharedShelf")}\nreturn relaySharedShelf(relay);`)(
    row, (value) => String(value), (value) => `${value} bytes`, () => "code", () => "<svg></svg>",
  );
}

test("sent attachments survive the reader projection and render an actionable shared shelf", () => {
  const sent = {relayId:"relay_sent_file", title:"Design", recipient:{name:"Sven"}, attachments:[HTML_ATTACHMENT]};
  const row = readerFor({relays:[], sent:[sent]}, sent.relayId);
  assert.deepEqual(row.attachments, sent.attachments, "the reader must not drop the file the conversation already shows");
  const shelf = attachmentShelfFor(row);
  assert.match(shelf, /Attached to this Relay/);
  assert.match(shelf, /settings-and-other\.html/);
  assert.match(shelf, /2417885 bytes/);
  assert.match(shelf, /data-att-relay="relay_sent_file" data-att-id="att_design" data-att-preview="1"/,
    "opening the attachment uses the exact sent Relay and file identity");
});

test("a group sent reader retains only the opened sibling's attachment identities", () => {
  const sent = [
    {relayId:"relay_a", groupSendId:"group_send", recipientGroupName:"Designs", attachments:[HTML_ATTACHMENT]},
    {relayId:"relay_b", groupSendId:"group_send", recipientGroupName:"Designs", attachments:[{...HTML_ATTACHMENT, id:"att_b",fileId:"att_b"}]},
  ];
  const row = readerFor({relays:[],sent}, "relay_b");
  assert.equal(row.senderName,"You → Designs");
  assert.deepEqual(row.attachments, sent[1].attachments);
  assert.match(attachmentShelfFor(row), /data-att-relay="relay_b" data-att-id="att_b"/);
});

test("received and canonically hydrated readers keep their existing attachment behavior", () => {
  const inbound = {id:"relay_received",attachments:[HTML_ATTACHMENT]};
  assert.equal(readerFor({relays:[inbound],sent:[]},inbound.id),inbound);
  assert.match(attachmentShelfFor(inbound), /Attached to this Relay/);
  for (const direction of ["inbound","outbound"]) {
    const item = {relayId:"relay_chat",direction,attachments:[HTML_ATTACHMENT]};
    const chats = new Map([["chat_test",{chatId:"chat_test",title:"Sven",items:[item]}]]);
    const row = readerFor({relays:[],sent:[]},item.relayId,chats);
    assert.deepEqual(row.attachments,item.attachments);
    assert.match(attachmentShelfFor(row), /data-att-relay="relay_chat" data-att-id="att_design"/);
  }
});

test("sent messages without files have an empty attachment list and no empty shelf", () => {
  for (const attachments of [undefined, null, [], {id:"malformed"}]) {
    const row = readerFor({relays:[],sent:[{relayId:"relay_no_files",attachments}]},"relay_no_files");
    assert.deepEqual(row.attachments,[]);
    assert.equal(attachmentShelfFor(row),"");
  }
});

const GROUP_SEND = [
  {
    relayId: "r_sven", groupSendId: "gs_1", recipientGroupName: "Bugs and Features",
    recipient: { name: "Sven Wellmann", email: "sven@example.com" },
    title: "Rewriting how agents write us", forHuman: "Heads up —", createdAt: "2026-08-18T09:00:00.000Z",
  },
  {
    relayId: "r_shane", groupSendId: "gs_1", recipientGroupName: "Bugs and Features",
    recipient: { name: "Shane Acton", email: "shane@example.com" },
    title: "Rewriting how agents write us", forHuman: "Heads up —", createdAt: "2026-08-18T09:00:00.000Z",
  },
];

test("the reader heads a group send with the room, not the sibling it opened", () => {
  const payload = { relays: [], sent: GROUP_SEND };
  assert.equal(readerFor(payload, "r_shane").senderName, "You → Bugs and Features");
  // Either copy of the same send reads identically — the room is the addressee.
  assert.equal(readerFor(payload, "r_sven").senderName, "You → Bugs and Features");
});

test("a group send whose roster is gone is headed by its members", () => {
  const orphaned = GROUP_SEND.map(({ recipientGroupName, ...rest }) => rest);
  const senderName = readerFor({ relays: [], sent: orphaned }, "r_shane").senderName;
  assert.equal(senderName, "You → Sven Wellmann, Shane Acton");
});

test("a one-to-one send still names the person", () => {
  const payload = {
    relays: [],
    sent: [{ relayId: "r_solo", recipient: { name: "Shane Acton", email: "shane@example.com" }, title: "Ping" }],
  };
  assert.equal(readerFor(payload, "r_solo").senderName, "You → Shane Acton");
});

test("canonical chat hydration preserves owned-agent Work identity in the reader", () => {
  const canonical = new Map([["chat_shane", {
    chatId: "chat_shane",
    title: "Shane Acton",
    items: [{
      relayId: "relay_claude_run",
      direction: "outbound",
      title: "Relay",
      forHuman: "Finished on your laptop.",
      forAgent: "",
      createdAt: "2026-08-30T14:00:00.000Z",
      source: { host: "relay-agent-run", surface: "claude_code" },
    }],
  }]]);

  assert.deepEqual(
    readerFor({ relays: [], sent: [] }, "relay_claude_run", canonical).source,
    { host: "relay-agent-run", surface: "claude_code" },
    "an aged-out Claude bubble must still select the Work face when tapped",
  );
});

test("an owned-agent Sent twin outranks a stale generic canonical source", () => {
  const canonical = new Map([["chat_shane", {
    chatId: "chat_shane",
    title: "Shane Acton",
    items: [{
      relayId: "relay_claude_run",
      direction: "outbound",
      title: "Relay",
      forHuman: "Finished on your laptop.",
      forAgent: "",
      createdAt: "2026-08-30T14:00:00.000Z",
      source: { host: "relay-pill" },
    }],
  }]]);
  const sent = [{
    relayId: "relay_claude_run",
    recipient: { name: "Shane Acton", email: "shane@example.com" },
    source: { host: "relay-agent-run", surface: "claude_code" },
  }];

  assert.deepEqual(
    readerFor({ relays: [], sent }, "relay_claude_run", canonical).source,
    { host: "relay-agent-run", surface: "claude_code" },
    "the real chat race must open Work even while canonical hydration is stale",
  );
});
