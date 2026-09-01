import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `source contains ${start}`);
  assert.ok(to > from, `source contains ${end} after ${start}`);
  return source.slice(from, to);
}

const board = between(inbox, "function renderTasksBoard()", "// Grow the window as the user scrolls");

test("All is an attention stack, not a completed accordion", () => {
  assert.match(inbox, /const TODO_ACTIVE_ORDER = \["triage", "in_progress", "todo", "backlog"\]/);
  assert.doesNotMatch(inbox, /completedTasksExpanded/);
  assert.match(board, /TODO_ACTIVE_ORDER\.map/);
  assert.match(board, /TODO_TERMINAL_ORDER\.filter/);
});

test("empty copy follows the exact visible status selection", () => {
  assert.match(board, /const visibleCount = selected\.length/);
  assert.match(board, /`Nothing in \$\{selected\.map/);
  assert.match(board, /Choose another status or All\./);
});

test("large single-status lists use cursor batches without page numbers", () => {
  assert.match(board, /todoState\.nextCursor/);
  assert.match(board, /Load next 25/);
  assert.match(inbox, /loadTodo\(\{ append:true \}\)/);
  assert.doesNotMatch(board, /pageNumber|totalPages/);
});
