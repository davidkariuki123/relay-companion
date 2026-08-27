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

test("completed Tasks are collapsed behind one disclosure by default", () => {
  assert.match(inbox, /let completedTasksExpanded = false;/);
  assert.match(board, /data-completed-toggle aria-expanded="\$\{completedTasksExpanded\}"/);
  assert.match(board, /id="completedTasksList" aria-hidden="\$\{!completedTasksExpanded\}"/);
  assert.doesNotMatch(board, /section\("Done"/);
  assert.match(board, /rowsHtml\(groups\.done, \(\) => ""\)/);
});

test("inbox zero appears only after every unfinished Task category is clear", () => {
  assert.match(board, /groups\.running\.length \+ groups\.unclaimed\.length \+ groups\.waiting\.length \+ groups\.claimed\.length \+ groups\.scheduled\.length/);
  assert.match(board, /groups\.review\.length \+ groups\.stopped\.length \+ groups\.parked\.length/);
  assert.match(board, /const inboxZeroNow = groups\.done\.length > 0 && unfinishedCount === 0;/);
  assert.match(board, /Nicely done\./);
  assert.match(board, /Your task list is clear\./);
});

test("the Completed disclosure expands rows and condenses the celebration in place", () => {
  assert.match(board, /completedTasksExpanded = completedToggle\.getAttribute\("aria-expanded"\) !== "true"/);
  assert.match(board, /classList\.toggle\("compact", completedTasksExpanded\)/);
  assert.match(board, /classList\.contains\("preexpanded"\)[\s\S]*?classList\.remove\("preexpanded"\)[\s\S]*?void reveal\.offsetHeight/);
  assert.match(board, /reveal\.classList\.toggle\("open", completedTasksExpanded\)/);
  assert.match(board, /reveal\.setAttribute\("aria-hidden", String\(!completedTasksExpanded\)\)/);
  assert.match(board, /reveal\.removeAttribute\("inert"\)/);
});
