import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `source contains ${start}`);
  assert.ok(to > from, `source contains ${end} after ${start}`);
  return source.slice(from, to);
}

test("Triage is shown to the person as Needs attention; the wire value never changes", () => {
  assert.match(inbox, /triage:"Needs attention", backlog:"Backlog", todo:"Todo", in_progress:"In Progress"/);
  assert.match(inbox, /const TODO_STATUS_ORDER = \["triage", "backlog", "todo", "in_progress", "done", "canceled", "duplicate"\]/);
  assert.doesNotMatch(inbox, /triage:"Triage"/);
});

test("a read item is not bold: Todo rows wear the Relays list's unread words", () => {
  assert.match(inbox, /\.todo-row-title \{ overflow:hidden; color:var\(--muted\); font:400 15px/);
  assert.match(inbox, /\.todo-row\.unread \.todo-row-title \{ color:var\(--ink\); font-weight:500; \}/);
  const row = between(inbox, "function todoRowHtml(item, status)", "function stewardAgentLabel");
  assert.match(row, /const unread = item\.state === "delivered";/);
  assert.match(row, /class="todo-row\$\{unread \? " unread" : ""\}"/);
});

test("the steward's reason replaces the preview on a row and reads in full in the reader", () => {
  const row = between(inbox, "function todoRowHtml(item, status)", "function stewardAgentLabel");
  assert.match(row, /const why = String\(item\.assessment \|\| ""\)\.trim\(\);/);
  assert.match(row, /why \? `<div class="todo-row-why" title="\$\{esc\(why\)\}">\$\{esc\(why\)\}<\/div>` : showPreview/);
  assert.match(inbox, /\.todo-row-why::before \{ content:""; display:inline-block; width:5px; height:5px/);
  assert.match(inbox, /\.todo-row-why \{[^}]*-webkit-line-clamp:4;/, "the note finishes (up to four lines) instead of truncating at two");
  const why = between(inbox, "function todoWhyHtml(row)", "function todoReaderStatusHtml(row)");
  assert.match(why, /row\.assessedBy === "human" \? "You" : stewardAgentLabel\(row\.assessedBy\)/);
  assert.match(why, /Based on \$\{esc\(evidence\.join\(", "\)\)\}/);
  assert.match(inbox, /\$\{todoWhyHtml\(r\)\}\n\s+\$\{scheduleContractHtml\(r\)\}/);
  // The summary→reader projection carries the note so the reader can show it without another request.
  const summaryRow = between(inbox, "function todoSummaryAsReaderRow(item)", "function mergeTodoProjection(item)");
  assert.match(summaryRow, /assessment:item\.assessment \|\| ""/);
  assert.match(summaryRow, /assessmentEvidence:Array\.isArray\(item\.assessmentEvidence\)/);
});

test("the Todo tab carries no steward report: the agent's words live on the items, not above them", () => {
  assert.doesNotMatch(inbox, /id="todoSteward"/);
  assert.doesNotMatch(inbox, /is checking your list/);
  assert.doesNotMatch(inbox, /Check now/);
  assert.doesNotMatch(inbox, /todoStewardRun/);
  // A finished run still reloads the board even though no row version moved.
  assert.match(inbox, /const todoProjectionChanged = nextTodoProjectionSignature !== todoProjectionSignature \|\| stewardFinished;/);
  assert.match(inbox, /todoSteward: next\.todoSteward && typeof next\.todoSteward === "object" \? next\.todoSteward : null,/);
});

test("a settled list says so once, above the recent Done", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window as the user scrolls");
  assert.match(board, /attentionTotal === 0 && total > 0/);
  assert.match(board, /Nothing needs you right now\./);
  assert.match(board, /tasksListEl\.innerHTML = clear \+ groups\.map\(todoGroupHtml\)\.join\(""\) \+ terminals;/);
});

test("Settings carries the assistant as one switch and one choice in the value-row species", () => {
  const section = between(inbox, "function todoStewardSettingsHtml()", "async function saveTodoStewardPrefs(input)");
  assert.match(section, /<div class="sv-open-title">Todo assistant<\/div>/);
  assert.doesNotMatch(section, /sv-open-intro/, "no leading paragraph; the explanation sits under the switch it explains");
  assert.match(section, /svSwitchHtml\("todoSteward", s\.enabled/);
  assert.match(section, /option\("auto", "Automatic"\)\}\$\{option\("codex", "Codex"\)\}\$\{option\("claude", "Claude Code"\)/);
  assert.match(section, /Automatic uses Codex when both are installed, otherwise Claude Code\./);
  assert.match(inbox, /if \(payload\.features\?\.todo === true\) html \+= todoStewardSettingsHtml\(\);/);
  assert.match(inbox, /if \(key === "todoSteward"\) \{/);
});

test("main hands the renderer a bounded steward view and forwards preferences to the daemon's file", () => {
  assert.match(main, /todoSteward: PRODUCT_FEATURES\.todo === true \? readTodoStewardState\(\) : null,/);
  assert.doesNotMatch(main, /relay:todoStewardRun/);
  assert.match(main, /ipcMain\.handle\("relay:todoStewardPrefs"/);
  assert.match(main, /steward\.saveStewardPreferences\(RELAY_HOME/);
  assert.match(main, /else if \(String\(file\) === "todo-steward\.json"\) pushInboxQuiet\(\{ stateChange: false \}\);/);
  // The reader row and the push signature carry the note so a re-noted item repaints.
  assert.match(main, /assessment: p\.assessment \|\| null,/);
  assert.match(main, /r\.assessment,\n\s+r\.attentionRank,/);
  assert.match(preload, /todoStewardPrefs: \(input = \{\}\) => ipcRenderer\.invoke\("relay:todoStewardPrefs", input \|\| \{\}\)/);
});
