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

test("Todo puts attention first, previews recent Done, and gives In Progress a live mark", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  assert.match(inbox, /TODO_ACTIVE_ORDER = \["triage", "in_progress", \.\.\.TODO_LEGACY_ORDER\]/);
  assert.match(inbox, /TODO_ALL_PREVIEW_ORDER = \[\.\.\.TODO_ACTIVE_ORDER, "done"\]/);
  assert.match(board, /TODO_ALL_PREVIEW_ORDER\.map/);
  assert.match(inbox, /\.todo-mark\.in_progress/);
});

test("Todo keeps existing rows during filter fetches and lets the newest choice win", () => {
  const loader = between(inbox, "async function loadTodo", "async function openTodoItem");
  const rail = between(inbox, "function renderTodoRail()", "function todoGroupHtml");
  assert.match(inbox, /#tasksList\.todo-switching/);
  assert.match(loader, /beginTodoTransition\(\)/);
  assert.match(loader, /finishTodoTransition\(\)/);
  assert.match(loader, /\+\+todoState\.generation/);
  assert.match(loader, /append && \(todoState\.loading \|\| todoState\.loadingMore/);
  assert.doesNotMatch(loader, /!window\.relay\.todoList \|\| todoState\.loading/);
  assert.doesNotMatch(rail, /todoState\.(items|groups) = \[\]/);
});

test("Todo filtering is a visible rail, never a dropdown", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  assert.match(inbox, /id="todoFilterRail"/);
  assert.match(inbox, /data-todo-filter/);
  assert.match(board, /renderTodoRail\(\)/);
  assert.doesNotMatch(board, /<select|dropdown/i);
});

test("Canceled is workflow state while Recently Deleted remains a separate reader action", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board");
  assert.match(inbox, /canceled:"Canceled"/);
  assert.doesNotMatch(board, /data-task-delete/);
  assert.match(reader, /data-reader-delete/);
  assert.match(reader, /window\.relay\.deleteRelay\(r\.id\)/);
  assert.match(reader, /Move task to Recently Deleted/);
});

test("both source faces expose Start task while a Task is actionable", () => {
  const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board");
  assert.match(inbox, /label: state === "stopped" \? "Start again" : "Start task"/);
  assert.match(reader, /const requestActionable = request/);
  assert.match(reader, /onAgent \|\| onWork \|\| requestActionable/);
});
