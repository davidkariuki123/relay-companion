// A NEW SENDER IN THE BANNER (Shane, 2026-10-28). The Requests page is gone:
// a stranger's first message arrives like any relay, in the list, the count and
// the banner, but LOCKED. The banner draws the same locked row the list does:
// name, address, what kind of thing arrived, Add contact and a ⋯ for Delete and
// Block. Nothing of their words reaches the banner, the composer or an agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const inbox = read("../overlay/inbox.html");
const peek = between(inbox, "if (peeking) {\n      // A notification wears the SAME species as the list", "sizePeek();\n      return;\n    }");
const row = between(inbox, "function relayIdentityRowHtml(identity, show = null)", "// ---------- the reader");
const locked = between(inbox, "function requestRowHtml(identity, show = null)", "let requestRowsAccount");

test("a new sender arrives in the banner from the same rooms as the list, locked", () => {
  // One source: the identity rows already carry the request room; no second list.
  assert.match(peek, /const unread = bannerIdentityRows\(identityRows, allRows\)\n/);
  assert.doesNotMatch(peek, /requestRooms\(\)|concat\(requests\)/);
  assert.match(row, /if \(identity\.requestRoom\) return requestRowHtml\(identity, show\);/);
  // The banner tap and verbs: the row's own open never fires for a locked row.
  assert.match(peek, /querySelectorAll\("\.relay-arrival:not\(\.request-row\)"\)/);
  assert.match(peek, /wireMessageSideMenus\(relaysListEl\);\n\s+wireRequestRows\(relaysListEl\);/);
  // No reply box for a stranger from the banner.
  assert.match(inbox, /if \(!peeking \|\| !identity \|\| identity\.requestRoom \|\| identity\.provider === "slack"\) return "";/);
});

test("the locked row shows who and what kind, never the words", () => {
  assert.match(locked, /class="relay-row relay-arrival request-row/);
  assert.match(locked, /not in your contacts/);
  assert.match(locked, /requestRowSentLine\(identity\)/);
  assert.match(locked, />Add contact<\/button>/);
  assert.match(locked, /data-request-delete=/);
  assert.match(locked, /data-request-block="\$\{key\}">Block sender…/);
  assert.doesNotMatch(locked, /th-title|relayListGist|messageListGist|\.title|\.body|forHuman|data-banner-copy/);
  const sent = between(inbox, "function requestRowSentLine(room)", "const LOCK_ICON");
  assert.match(sent, /Sent you a task/);
  assert.match(sent, /Sent you a message/);
  assert.match(sent, /Sent you a relay/);
});

test("nothing else opens a locked sender's words", () => {
  const open = between(inbox, "function openThreadDetail(threadId", "const returningFromReader");
  assert.match(open, /if \(lockedRoom && isRequestRoom\(lockedRoom\) && requestRoomMessages\(lockedRoom\)\.length\) \{ showLockedRequest\(lockedRoom\); return; \}/);
  const reader = between(inbox, "function openReader(id, source, picker = null)", "// A notification banner remains");
  assert.match(reader, /requestAddresses\(\)\.has\(lockedSender\)/);
  const search = between(inbox, "function chatSearchModel(query)", "function chatSearchHtml(");
  assert.match(search, /if \(room\.requestRoom\) continue;/);
  assert.match(inbox, /receivedRelayRows\(allRows, identityRows\.filter\(\(room\) => !room\.requestRoom\)\)/);
  const pages = read("../overlay/inbox-pages.js");
  assert.match(pages, /!locked\.has\(String\(r\.senderEmail \|\| ""\)\.trim\(\)\.toLowerCase\(\)\)/);
});

test("a new sender counts as unread; only a blocked one stays out of the number", () => {
  assert.match(inbox, /const quiet = new Set\(\[\.\.\.requestAddresses\(\)\]\.filter\(\(address\) => blocked\.has\(address\)\)\);/);
});

test("a guest's initials are the person's, not the marker's", () => {
  const source = between(inbox, "function avatarInitials(name) {", "\n  }\n");
  const avatarInitials = vm.runInNewContext(`(${source}\n  })`, {});
  assert.equal(avatarInitials("DK (unverified)"), "DK");
  assert.equal(avatarInitials("Priya (unverified)"), "Pr", "one word keeps the function's own two-letter rule");
  assert.equal(avatarInitials("Shane Acton"), "SA");
  assert.equal(avatarInitials("Someone with the link"), "?");
});
