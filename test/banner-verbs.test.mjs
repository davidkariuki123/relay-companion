// THE BANNER'S VERBS (David, 2026-09-16). A notification is the conversation
// row with one line of verbs under it — Copy for your agent, Open in Codex,
// Open in Claude Code. Copy is always there; an app's Open only when Settings ›
// Your agent has it on. A Task wears the same verbs as a Relay, plus the chip
// the room bubble already wears. No Start. The banner stays 20 s (a Task 30 s);
// nothing latches open for good.
// THE BANNER'S REPLY (David, 2026-09-17). Under the row, from the moment a
// message arrives, sits the room's own composer, so a one-line answer never
// needs the room. The agent verbs are a relay's: a typed text wears none.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
const main = read("../overlay/main.cjs");
const verbs = between(inbox, "function bannerVerbsHtml(row)", "function relayIdentityRowHtml(identity)");
const row = between(inbox, "function relayIdentityRowHtml(identity)", "// ---------- the reader");
const peek = between(inbox, "if (peeking) {\n      // A notification wears the SAME species as the list", "sizePeek();\n      return;\n    }");

test("banner verbs follow Settings › Your agent and keep David's order", () => {
  // Copy is unconditional; each app rides its own switch AND its desktop-app opening.
  assert.match(verbs, /const verbs = \[\{ label:"Copy for your agent"/);
  assert.doesNotMatch(verbs, /otherAgentEnabled/);
  assert.doesNotMatch(inbox, /otherAgentEnabled|svOtherAgent|proto\.otherAgent/, "the Other switch is gone with its preference");
  assert.match(verbs, /for \(const host of agentAppHosts\(\)\)/);
  assert.match(verbs, /if \(!agentOpensInApp\(app\)\) continue;/);
  assert.match(verbs, /label:`Open in \$\{app\}`/);
  // Copy is pushed before the app loop, so the order is Copy, Codex, Claude Code (agentAppHosts is Codex-first).
  assert.ok(verbs.indexOf('label:"Copy for your agent"') < verbs.indexOf("for (const host of agentAppHosts())"));
  // Row recipe: the first verb wears the accent, the rest are muted; the strip never bubbles to the row.
  assert.match(verbs, /class="act-btn \$\{index === 0 \? "accept" : "decline"\}"/);
  assert.match(verbs, /<span class="rk-actions" data-stop="1">/);
  // Outbound rows and non-Relay rooms (Slack) get no verbs.
  assert.match(verbs, /row\.direction === "out" \|\| !String\(row\.id \|\| ""\)\.startsWith\("relay_"\)/);
});

test("the identity row grows the Task chip and the verbs only while peeking", () => {
  assert.match(row, /\$\{peeking && row\.direction !== "out" && bannerIsTask\(row\) \? `<span class="kchip">Task<\/span>` : ""\}/);
  assert.match(row, /\$\{peeking \? bannerVerbsHtml\(row\) : ""\}/);
  // The row's message is a room projection whose Task flag is `request` (the bubble's own predicate).
  assert.match(verbs, /function bannerIsTask\(row\)[\s\S]*?row\.request \|\| isTaskRow\(relayById\(row\.id\)\) \|\| isTaskRow\(row\)/);
  // The chip sits between the name and the time, as it does on the room bubble's top line.
  assert.ok(row.indexOf('bannerIsTask(row) ? `<span class="kchip">Task</span>`') < row.indexOf('<span class="th-time">'));
  // No Start anywhere on a banner (the verb; a caret's selectionStart is not one).
  assert.doesNotMatch(row, />Start<|"Start"|label:"Start/);
  assert.doesNotMatch(verbs, />Start<|"Start"|label:"Start/);
});

test("the verbs are wired: Copy copies the pull sentence in place, an app verb opens the pill, the room, then that app's picker", () => {
  const copy = between(peek, 'querySelectorAll("[data-banner-copy]")', 'querySelectorAll("[data-banner-open]")');
  assert.match(copy, /e\.stopPropagation\(\)/);
  assert.match(copy, /navigator\.clipboard\.writeText\(pullSentenceFor\(message\)\)/);
  assert.match(copy, /b\.textContent = "Copied"/);
  assert.doesNotMatch(copy, /openFull\(\)/);
  const open = between(peek, 'querySelectorAll("[data-banner-open]")', "// The banner is sized to its rows");
  assert.match(open, /e\.stopPropagation\(\)/);
  const order = ["openFull();", "openThreadDetail(rowEl.getAttribute(\"data-thread\")", "loadSessionPicker(id, host, relaySubject(message) || \"Relay\", null, \"relay\")"];
  let last = -1;
  for (const step of order) { const at = open.indexOf(step); assert.ok(at > last, `expected in order: ${step}`); last = at; }
  // openThreadDetail clears sessionPickerState, so the picker must load AFTER it.
  assert.ok(open.indexOf("openThreadDetail(") < open.indexOf("loadSessionPicker("));
});

test("the pull sentence has one builder shared by the reader block and the banner", () => {
  assert.match(inbox, /function pullSentenceFor\(message, row = null\)/);
  const html = between(inbox, "function pullSentenceHtml(message", "function wireHostOpen(scope)");
  assert.match(html, /const sentence = pullSentenceFor\(message, row\);/);
  assert.match(html, /Pull \$\{whose\} relay/.source ? /Copy this prompt for your agent/ : /x/);
  assert.match(between(inbox, "function pullSentenceFor(", "function pullSentenceHtml("), /return `Pull \$\{whose\} relay “\$\{subject\}” from Relay and tell me what’s happening\.`;/);
});

test("a text wears no agent verbs — they belong to a relay", () => {
  // Contacts' rooms: the whole verb line goes for a text.
  assert.match(verbs, /if \(request\) return requestBannerVerbsHtml\(row, request\);\n    if \(row\.textLike\) return "";/);
  // A stranger's text: Add to Contacts leads and Copy is gone; a stranger's relay keeps Copy first.
  const request = between(verbs, "function requestBannerVerbsHtml(row, room)", "function bannerIsTask(row)");
  assert.match(request, /const lead = row\.textLike\n\s+\? item\("accept", "Add to Contacts", "act-btn accept"\)/);
  assert.match(request, /: `<button class="act-btn accept" type="button" data-banner-copy="\$\{id\}">Copy for your agent<\/button>\$\{item\("accept", "Add to Contacts", "act-btn decline"\)\}`/);
  // A share-link guest's two verbs never had Copy; unchanged.
  assert.match(request, /if \(isShareGuestRoom\(room\)\) \{\n\s+return `<span class="rk-actions" data-stop="1">\$\{item\("delete", "Delete relay"\)\}\$\{item\("block", "Block sender…"\)\}<\/span>`;/);
});

test("the room's composer sits under the row from the start, and only while peeking", () => {
  // Right after the verbs, inside the row body, on the same peeking condition.
  assert.match(row, /\$\{peeking \? bannerVerbsHtml\(row\) : ""\}\n\s+\$\{peeking \? bannerComposerHtml\(identity, row\) : ""\}/);
  const composer = between(inbox, "function bannerComposerHtml(identity, row)", "function bannerReplyRecipient(identity, row)");
  assert.match(composer, /if \(!peeking \|\| !identity \|\| identity\.requestRoom \|\| identity\.provider === "slack"\) return "";/);
  // The room composer's own box: .qr.th-qr.col, the rich field, the rail, the Relay verb. No new species.
  assert.match(composer, /<div class="qr th-qr col qr-banner" data-stop="1"><div class="th-rich-composer" contenteditable="true" role="textbox" aria-multiline="true"/);
  assert.match(composer, /<div class="ta-rail"><span class="rt-spacer"><\/span><button type="button" class="qr-banner-send" data-stop="1">Relay<\/button><\/div><\/div>/);
  // The placeholder names where the words go: the channel, or the person's first name.
  assert.match(composer, /\? `Reply in \$\{identity\.name\}…`\n\s+: `Reply to \$\{String\(identity\.name \|\| row\.party \|\| "them"\)\.split\(" "\)\[0\]\}…`/);
  // Its only styling is a home inside the row; the box itself is the room's.
  assert.match(inbox, /\.card\.peek \.qr\.qr-banner \{ margin:12px 0 0; padding:10px 10px 6px 16px; \}/);
  // The field is dressed like the room's (grow, +, paste, Enter sends) and stages its own files.
  const wiring = between(inbox, "function wireBannerComposers(carriedDrafts = new Map())", "function bannerReplyNote(rowEl, message)");
  assert.match(wiring, /prepareMentionComposer\(field, \[\], carried \? carried\.value : ""\);/);
  assert.match(wiring, /dressComposer\(field, submit\);/);
  assert.match(wiring, /if \(e\.key !== "Escape"\) return;/);
  assert.match(inbox, /const banner = field\.closest\("\.relay-arrival"\);\n\s+if \(banner\) return "banner:" \+ \(banner\.getAttribute\("data-thread"\) \|\| ""\);/);
});

test("a reply from the banner goes down the room's path, reads the arrival, and folds the banner", () => {
  const send = between(inbox, "async function sendBannerReply(rowEl, field, send)", "function relayIdentityRowHtml(identity)");
  assert.match(send, /res = await window\.relay\.sendReply\(\{\n\s+text, recipient, files, idempotencyKey, agentMentions,\n\s+chat: \{/);
  assert.match(send, /const idempotencyKey = `pill-reply-\$\{crypto\.randomUUID\(\)\}`;/);
  // A refused send keeps the words in the field and says why under it.
  assert.match(send, /bannerReplyNote\(rowEl, \(res && res\.error\) \|\| "Send failed — try again\."\);/);
  // Replying reads the arrival; the words take the row's own "You:" line; the banner folds a beat later.
  assert.match(send, /if \(arrivalId\) persistReadIds\(\[arrivalId\]\);/);
  assert.match(send, /<span class="gist-who">You:<\/span> \$\{esc\(shown\)\}/);
  assert.match(send, /bannerReplySettling = true;\n\s+sizePeek\(\);/);
  assert.match(send, /if \(ghost\) dismissOverlay\(\);\n\s+else \{ foldToPill\(\); sendAttentionDone\(true\); \}/);
  // While it settles the rows hold; a rebuild carries every live draft over.
  assert.match(peek, /if \(bannerReplySettling\) return;/);
  assert.match(peek, /const carriedDrafts = captureBannerDrafts\(\);\n\s+relaysListEl\.innerHTML = nextNotifHtml;\n\s+peekListHtml = nextNotifHtml;\n\s+wireBannerComposers\(carriedDrafts\);/);
  // The dwell waits for a draft, the caret, or a staged file in the banner's field.
  const active = between(inbox, "function quickReplyIsActive()", "function flushPendingRelaysRender()");
  assert.match(active, /querySelectorAll\("\.qr-banner \.th-rich-composer"\)/);
  assert.match(active, /if \(active === field \|\| String\(field\.value \|\| ""\)\.trim\(\) \|\| peekStagedFiles\(field\)\.length\) return true;/);
});

test("a banner stays 20 s by default, a Task 30 s, and nothing about Tasks latches open", () => {
  assert.match(main, /const DEFAULT_NOTIFICATION_MS = 20000;/);
  assert.match(main, /const TASK_DWELL_FACTOR = 1\.5;/);
  assert.match(main, /const dwellMs = \(\) => Number\(process\.env\.RELAY_OVERLAY_NOTIFICATION_MS\) \|\| DEFAULT_NOTIFICATION_MS;/);
  assert.match(main, /notificationDurationMs: dwellMs\(\),/);
  const show = between(main, "function showDwellMs(rows)", "function idleSecondsSafe()");
  assert.match(show, /relayNotificationKind === "task"/);
  assert.match(show, /Math\.round\(base \* TASK_DWELL_FACTOR\)/);
  // The per-show dwell rides the newRelay meta and bounds the idle sampler.
  assert.match(main, /dwellMs: showDwell,\n    remaining:/);
  assert.match(main, /beginShowSampling\(ids, digestMode, \{ sticky, dwellMs: showDwell \}\)/);
  assert.match(main, /const samplerCapMs = Math\.max\(showDwell \* 4, 30000\);/);
  // Sticky stays what it was: only repeatedly-missed relays latch; a Task does not.
  assert.doesNotMatch(show, /sticky/);
  // The renderer honours the per-show dwell on both the banner and the ghost banner.
  assert.match(inbox, /let notificationDurationMs = 20000;/);
  assert.match(inbox, /function dwellFor\(meta\)/);
  assert.match(inbox, /function ghostArrival\(row, meta\)/);
  assert.equal((inbox.match(/\}, dwellFor\(meta\)\);/g) || []).length, 2);
  assert.match(inbox, /ghostArrival\(row, opts\);/);
  assert.doesNotMatch(inbox, /\}, notificationDurationMs\);/);
});
