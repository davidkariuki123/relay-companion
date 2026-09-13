import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

// Tasks-as-relays in the pill: one chip, two verbs, a receipt ladder. These are
// source-shape assertions in the style of pill-sent-delivery-ui.test.mjs — the
// behavioral halves live in notifications.test.mjs / relay-briefing.test.mjs.

test("a request row carries the Task chip and the chip recipe exists once", () => {
  assert.match(html, /const isTask = kind === "task"/);
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

test("task rows are deletable like plain relays", () => {
  assert.match(html, /kind === "plain_relay" \|\| kind === "task" \|\|/);
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
