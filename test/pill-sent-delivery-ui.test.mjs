import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("Sent keeps delivery plumbing invisible for Relay recipients", () => {
  assert.match(html, /if \(r && r\.recipient && r\.recipient\.onRelay\) return "Sent"/);
  assert.match(html, /r\.readAt \|\| dd\.openedAt/);
  assert.match(html, /: \(dd\.sentAt \|\| r\.createdAt\)/);
  assert.match(main, /r\.emailReminder && r\.emailReminder\.sentAt/);
  assert.doesNotMatch(html, /Email reminder|Email fallback|Sent to Relay first|Relay device inactive/);
});

test("Sent reserves Emailed for off-Relay recipients", () => {
  assert.match(html, /if \(channel === "email"\) return "Emailed"/);
});

test("a share link's ladder is channel-scoped and does not touch other channels", () => {
  assert.match(html, /if \(String\(\(\(r && r\.delivery\) \|\| \{\}\)\.channel \|\| ""\)\.toLowerCase\(\) === "link"\)/);
  assert.match(html, /\? "Opened" : "Sent"/);
  assert.doesNotMatch(html, /"Seen" : "Sent"/);
  // The onRelay shortcut must still precede the generic `opened` check.
  const onRelay = html.indexOf('if (r && r.recipient && r.recipient.onRelay) return "Sent"');
  const opened = html.indexOf('if (state === "opened") return "Opened"');
  assert.ok(onRelay > 0 && opened > onRelay, "an on-Relay recipient with no device still reads Sent");
});

test("Opened takes the accent but never settles the row", () => {
  assert.match(html, /read \|\| linkOpened \? " read" : ""/);
  assert.match(html, /const settled = receipt \? Boolean\(receipt\.cls === "done"\) : read;/);
});

test("a guest mailbox never reaches the Sent note", () => {
  assert.match(html, /@guests\\.sendrelays\\.com\$/);
  assert.match(html, /parts\.push\("shared by link"\)/);
});

test("each share link is its own room", () => {
  assert.match(html, /`share:\$\{String\(s\.shareLink\.id\)\}`/);
});

test("an unnamed share recipient gets the unknown-person glyph, not initials", () => {
  assert.match(html, /if \(String\(name \|\| ""\) === "Someone with the link"\) return "\?"/);
});

test("a previous share link never becomes a posting rule for the room", () => {
  assert.match(html, /\? \{ email:`\$\{String\(s\.shareLink\.id\)\}@guests\.sendrelays\.com` \}/,
    "the link identifies the room without exposing its synthetic address in UI copy");
  assert.match(html, /const visibleThreadComposer = groupPostingBlocked[\s\S]*: threadComposer/);
  assert.doesNotMatch(html, /pendingShareLink|pendingLinkStatus|thPendingShareCopy/);
  assert.doesNotMatch(html, /Nobody has opened this link yet/);
  const readDraft = html.indexOf('const text = (thQrInput.value || "").trim();');
  const take = html.indexOf("takeStagedFiles(thQrInput)");
  assert.ok(readDraft > 0 && take > readDraft, "the ordinary send path owns every later message");
});

test("a chat that moved when its link was claimed is followed, never shown as an error", () => {
  assert.match(main, /error\.status === 410 \? String\(\(error\.body && error\.body\.chatId\) \|\| ""\) : ""/);
  assert.match(main, /chat = await client\.chat\(moved\);/);
  assert.match(main, /entry\.payload\.chatId = moved;/);
  // The sentence is the API's, and the sender must never read it as a row error
  // on a conversation that is alive under a new id.
  assert.doesNotMatch(main, /That conversation moved when the recipient claimed the link/);
});

test("a live link can be copied off its own Sent row", () => {
  assert.match(html, /data-sent-copy-link="\$\{esc\(id\)\}"/);
  assert.match(html, /r\.shareLink && r\.shareLink\.state !== "revoked"/);
  assert.match(html, /setRowNote\(id, "Link copied", "ok"\)/);
});
