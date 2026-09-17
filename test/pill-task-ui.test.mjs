import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

// Tasks-as-relays in the pill: one chip, two verbs, a receipt ladder. These are
// source-shape assertions in the style of pill-sent-delivery-ui.test.mjs — the
// behavioral halves live in notifications.test.mjs / relay-briefing.test.mjs.

test("a request row carries the Task chip and the chip recipe exists once", () => {
  assert.match(html, /const isTask = isTaskRow\(r\)/);
  assert.match(html, /\$\{isTask \? `<span class="kchip">Task<\/span>` : ""\}/);
  assert.match(html, /\.kchip \{/);
});

test("a Task's open actions are a Relay's: no Start verb, no task-only tray", () => {
  // David, 2026-09-13: a Task opens like any Relay. The row menu no longer
  // forks on `task`, so a Task row gets Preview / Current chat / New chat and
  // its reader carries the Open in Codex / Claude Code rows. The agent stamps
  // Started and Done itself with relay_task_start / relay_task_complete.
  assert.match(html, /task = false, shareLinkUrl = "" \} = \{\}/);
  assert.equal(html.includes("A task's verbs are Preview and Start"), false, "the task tray fork is gone");
  assert.equal(html.includes("data-task-start"), false, "no Start verb on the row");
  assert.equal(html.includes("window.relay.taskStart"), false, "no Start IPC from the pill");
});

test("a Task row opens the Task on click; the open-actions menu is for Relays only", () => {
  // David, 2026-09-17: clicking a Task row does what Preview did — opens the
  // Task itself — on both the Relays list and the Sent list. No three-row
  // Preview / Choose chat / New chat menu grows under a Task.
  assert.match(html, /const expanded = !isTask && r\.id === expandedRelayId;/);
  assert.match(html, /const expanded = !taskRow && id === expandedSentId;/);
  assert.match(html, /if \(el\.getAttribute\("data-task"\) === "1"\) \{\s*el\.addEventListener\("click", \(\) => openReader\(id, "relays"\)\);/);
  assert.match(html, /if \(el\.getAttribute\("data-task"\) === "1"\) \{\s*el\.addEventListener\("click", \(\) => openReader\(id, "sent"\)\);/);
});

test("task rows are deletable only once the Task is over", () => {
  // David (2026-09-17): while a Task is open, Reject and Cancel are the acts;
  // the dustbin (a per-user tombstone) is for tidying what has ended.
  assert.match(html, /kind === "plain_relay" \|\| kind === "human_question"/);
  assert.match(html, /\|\| \(kind === "task" && taskIsOver\(r\)\)/);
  assert.match(html, /\$\{request && taskIsOver\(r\) \? `<button class="reader-delete"/);
});

test("the Sent tab renders the task receipt ladder", () => {
  assert.match(html, /function taskReceipt\(r\)/);
  assert.match(html, /\{ label: "Done", at: r\.taskCompletedAt, cls: "done" \}/);
  assert.match(html, /\{ label: "Started", at: r\.taskStartedAt, cls: "read" \}/);
  assert.match(html, /label: "Seen"/);
  assert.match(html, /\.st\.done \{ color:var\(--ok\)/);
});

test("messages-only mode lets task relays through and the projection carries receipts", () => {
  assert.match(main, /p\.relayNotificationKind === "plain_relay" \|\| p\.relayNotificationKind === "task"/);
  assert.match(main, /taskStartedAt: p\.taskStartedAt \|\| null/);
  assert.match(main, /taskCompletedAt: p\.taskCompletedAt \|\| null/);
});

test("the sent fingerprint moves when a task receipt advances", () => {
  assert.match(main, /r\.taskStartedAt,\s*\n\s*r\.taskRunOwner,\s*\n\s*r\.taskCompletedAt,/);
});
