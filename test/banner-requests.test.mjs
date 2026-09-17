// A REQUEST IN THE BANNER (David, 2026-09-17). A stranger's first message
// waits in Relays › Requests, but it arrived, and the banner is the arrival:
// without its row the banner was a dark card with the lockup and an ✕ and
// nothing else. The row is the same species as any arrival, wears a Request
// chip, and its verbs are what the request row offers under ⋯ in the pane
// (Add to Contacts, Delete relay, Block sender…) on ONE line, so the banner
// never changes size. A share-link guest gets no Copy for your agent and no
// Add to Contacts: their words are not handed to the agent from here, and
// there is no address to save.
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
const row = between(inbox, "function relayIdentityRowHtml(identity)", "// ---------- the reader");
const verbs = between(inbox, "function bannerVerbsHtml(row)", "function relayIdentityRowHtml(identity)");

test("a Request arrives in the banner like any relay, newest first, wearing its chip", () => {
  assert.match(peek, /const requests = requestRooms\(\)/);
  assert.match(peek, /room\.unreadCount > 0/);
  assert.match(peek, /requestRoom: true/);
  assert.match(peek, /identityRows\.filter\(\(row\) => row\.unreadCount > 0\)\.concat\(requests\)/);
  // Its own class: "Request" is the pane's word for a stranger's message, and
  // the product-language test retires the bare kchip that once meant a Task.
  assert.match(row, /\$\{peeking && identity\.requestRoom \? `<span class="kchip request">Request<\/span>` : ""\}/);
  // The chip sits in the top line, before the time, like the Task chip.
  assert.ok(row.indexOf('<span class="kchip request">Request</span>') < row.indexOf('<span class="th-time">'));
  // Nothing grows the row: no extra line under the words.
  assert.doesNotMatch(row, /todo-row-why/);
});

test("the verbs are the pane's ⋯ options, on one line, and a guest gets neither Copy nor Add to Contacts", () => {
  assert.match(verbs, /const request = requestRoomOf\(row\);\n    if \(request\) return requestBannerVerbsHtml\(row, request\);/);
  const request = between(inbox, "function requestBannerVerbsHtml(row, room)", "// The identity row's message is a room projection");
  assert.match(request, /isShareGuestRoom\(room\)/);
  // The guest branch: Delete relay and Block sender…, nothing else.
  const guest = between(request, "if (isShareGuestRoom(room)) {", "</span>`;");
  assert.match(guest, /Delete relay/);
  assert.match(guest, /Block sender…/);
  assert.doesNotMatch(guest, /Copy for your agent|Add to Contacts/);
  // The stranger-with-an-address branch: Copy, Add to Contacts, and the rest
  // under ⋯ — for a relay. A text has nothing for an agent, so Add to Contacts
  // leads and Copy is gone (David, 2026-09-17).
  const stranger = request.slice(request.indexOf("const lead = row.textLike"));
  assert.match(stranger, /const lead = row\.textLike\n\s+\? item\("accept", "Add to Contacts", "act-btn accept"\)\n\s+: `<button class="act-btn accept" type="button" data-banner-copy=/);
  assert.match(stranger, /data-banner-copy=/);
  assert.match(stranger, /Add to Contacts/);
  assert.match(stranger, /data-message-more/);
  assert.match(stranger, /class="th-message-menu"[^>]*popover="auto" role="menu"/);
  assert.match(stranger, /data-banner-request="delete"[^>]*>Delete relay/);
  assert.match(stranger, /data-banner-request="block"[^>]*>Block sender…/);
  // The pane's own actions answer the banner's verbs.
  const wired = between(peek, 'querySelectorAll("[data-banner-request]")', 'querySelectorAll("[data-banner-open]")');
  assert.match(wired, /e\.stopPropagation\(\)/);
  assert.match(wired, /deleteRequestEntries\(\[entry\]\)/);
  assert.match(wired, /confirmRequestAction\("block", \[entry\], b\)/);
  assert.match(wired, /acceptRequestEntry\(entry\)/);
  assert.match(peek, /wireMessageSideMenus\(relaysListEl\);/);
});

test("a guest's initials are the person's, not the marker's", () => {
  const source = between(inbox, "function avatarInitials(name) {", "\n  }\n");
  const avatarInitials = vm.runInNewContext(`(${source}\n  })`, {});
  assert.equal(avatarInitials("DK (unverified)"), "DK");
  assert.equal(avatarInitials("Priya (unverified)"), "Pr", "one word keeps the function's own two-letter rule");
  assert.equal(avatarInitials("Shane Acton"), "SA");
  assert.equal(avatarInitials("Someone with the link"), "?");
});
