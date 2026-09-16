// THE BANNER'S VERBS (David, 2026-09-16). A notification is the conversation
// row with one line of verbs under it — Copy for your agent, Open in Codex,
// Open in Claude Code. Copy is always there; an app's Open only when Settings ›
// Your agent has it on. A Task wears the same verbs as a Relay, plus the chip
// the room bubble already wears. No Start. The banner stays 20 s (a Task 30 s);
// nothing latches open for good.
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
  // No Start anywhere on a banner.
  assert.doesNotMatch(row, /Start/);
  assert.doesNotMatch(verbs, /Start/);
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
