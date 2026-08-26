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

test("Tasks puts live work first and uses the breathing circular activity mark", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  const workingAt = board.indexOf('section("Working"');
  const waitingAt = board.indexOf('section("Waiting on you"');
  assert.ok(workingAt > -1 && waitingAt > workingAt);
  assert.match(board, /class="tb-working"/);
  assert.match(board, /class="tb-working-orb"/);
  assert.doesNotMatch(board, /class="ksq"/);
  assert.match(inbox, /\.tb-working-orb \{[^}]*border-radius:50%/s);
  assert.match(inbox, /@keyframes taskWorkingBreathe/);
  assert.match(inbox, /prefers-reduced-motion:reduce[^}]*\.tb-working-orb/s);
});

test("waiting Tasks start directly from the board with warm action typography", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  assert.match(board, /data-approve=.*?>Start task<\/button>/);
  assert.doesNotMatch(board, /data-request-later/);
  assert.match(inbox, /\.tb-go \{[^}]*font-family:var\(--sans\)/s);
  assert.match(inbox, /\.tb-go \{[^}]*font-weight:600/s);
  assert.match(board, /wireRequestControls\(tasksListEl/);
});

test("Tasks can move to Recently Deleted from the board and reader", () => {
  const board = between(inbox, "function renderTasksBoard()", "// Grow the window");
  const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board");
  assert.match(board, /data-task-delete/);
  assert.match(board, /window\.relay\.deleteRelay\(id\)/);
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
