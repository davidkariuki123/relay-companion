import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inbox = readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("Recently Deleted is a reader action on a finished Task", () => {
  const reader = between(inbox, "function renderReader()", "// Grow the window");
  assert.match(reader, /data-reader-delete/);
  assert.match(reader, /window\.relay\.deleteRelay\(r\.id\)/);
  assert.match(reader, /Move task to Recently Deleted/);
});

test("a Task has no Start dock: its verbs are a Relay's Open rows and the reply dock", () => {
  // David, 2026-09-13: a Task opens like any Relay. No Start label, no
  // actionable-state gate, no task-only composer; the host rows render on the
  // page and the agent stamps Started / Done via relay_task_start / complete.
  const reader = between(inbox, "function renderReader()", "// Grow the window");
  assert.equal(inbox.includes('"Start again" : "Start task"'), false);
  assert.equal(reader.includes("requestActionable"), false);
  assert.equal(reader.includes("requestDockHtml"), false);
  // The host rows go once a received Task is over (Sven, 2026-10-08): there
  // is nothing left to open it in. The sender's copy keeps them.
  assert.match(reader, /const documentHostActions = onHuman && !readerRunsHere && !\(request && !r\.outbound && taskIsOver\(r\)\) \? `<div class="rd-host-actions"/);
  // A received Task that can run here runs from the card's Run block, and the
  // Open in bar steps aside so the apps and the copied prompt appear once.
  assert.match(reader, /const readerRun = request && !\(!r\.outbound && taskIsOver\(r\)\) \? taskReaderRunHtml\(r\) : "";/);
  assert.match(reader, /const readerRunsHere = readerRun\.includes\("tk-reader-run"\);/);
  assert.match(inbox, /function taskReaderRunHtml\(row\) \{[\s\S]*?taskRunBlockHtml\(row\)[\s\S]*?return `\$\{run\}\$\{nativeExecuteHtml\(row\)\}`;/, "Execute stays only where no plan can be read");
  assert.match(reader, /<div id="qrInput"[^>]+contenteditable="true"[^>]+data-placeholder="\$\{replyThread \? "Reply in thread…" : "Reply…"\}">/);
});
