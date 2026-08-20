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

function readerFor(payload, id) {
  const source = `${pillFunction("readerRow")}\n${pillFunction("sentGroupLabel")}\nreturn readerRow(id);`;
  // Only the naming path is under test; the row's other fields come straight
  // off the sent item, so the neighbours it calls are stubbed to their answer.
  return new Function(
    "payload",
    "id",
    "sentRecipient",
    "sentSubject",
    source,
  )(payload, id, (r) => (r.recipient && r.recipient.name) || "Recipient", (r) => r.title || "Relay");
}

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
