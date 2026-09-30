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
  assert.match(reader, /const documentHostActions = onHuman \? `<div class="rd-host-actions"/);
  assert.match(reader, /<textarea id="qrInput" rows="1" placeholder="\$\{replyThread \? "Reply in thread…" : "Reply…"\}">/);
});
