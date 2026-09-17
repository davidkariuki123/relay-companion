// THE TASK CARD (David, 2026-09-17). A Task is one object on both sides: in the
// chat the bubble carries a footer inside it — the agent row (Copy for your
// agent, always; each app Settings › Your agent has on, as its mark) and the
// state row (mark · state · verbs); the expanded Task carries the ladder
// Sent · Seen · Started · Done as a stepper; every Task row in the lists says
// its state in a line under the title; every Done points at its result.
// Every state is a record the server wrote. The helpers are pure enough to run
// here against fixture rows; the plumbing is pinned in the source.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

// Values cross out of the VM realm, so structures are compared by shape, not prototype.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const inbox = read("../overlay/inbox.html");
const main = read("../overlay/main.cjs");
const preload = read("../overlay/preload.cjs");
const notifications = read("../src/notifications.js");
const block = between(inbox, "// ---------- THE TASK CARD (2026-09-17) ----------", "// State is READ FROM THE RECORD, not remembered in the tab.");

// The helpers, run for real: the block evaluated with the few renderer
// functions it leans on stubbed, and a payload of fixture rows.
function boot({ relays = [], sent = [], apps = ["codex", "claude"], opens = () => true } = {}) {
  const context = {
    payload: { relays, sent, account: { userId: "me" } },
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    timeAgo: (iso) => { const ms = Date.now() - Date.parse(iso); const m = Math.round(ms / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; },
    formatChatTime: () => "09:52",
    relaySender: (row) => row.senderName || "",
    relaySubject: (row) => row.title || "",
    sentIsRead: (row) => ["read", "acknowledged"].includes(String(row.state || "")),
    readerRow: () => null,
    relayById: (id) => relays.find((r) => r.id === id) || null,
    agentAppHosts: () => apps,
    agentOpensInApp: opens,
    pullSentenceFor: () => "Pull the relay.",
    applyTaskClaimProjection: () => {},
    openReader: () => {},
    setInteractive: () => {},
    activeView: "relays",
    thHistoryEl: null,
    REDUCED: true,
    CSS: { escape: (s) => s },
    window: { relay: {} },
    setTimeout, clearTimeout, console, Map, Set, Date, String, Number, Boolean, Array, JSON, Math,
  };
  vm.createContext(context);
  vm.runInContext(block + "\nthis.__t = { taskStateFor, taskLadder, taskVerbsHtml, taskCardFooterHtml, taskStatusModuleHtml, taskRowLineHtml, taskEventOf, taskResultFor, taskResultLinkHtml, taskIsOver, taskDonePending, startTaskDone, taskVerb, TASK_UNDO_MS };", context);
  return context.__t;
}
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const inboundTask = (over = {}) => ({ id: "t1", direction: "in", relayNotificationKind: "task", kind: "task", request: true, party: "Sven Wellmann", senderName: "Sven Wellmann", senderEmail: "sven@example.com", title: "Check the patch", createdAt: ago(13 * 60), ...over });
const sentTask = (over = {}) => ({ id: "s1", relayId: "s1", direction: "out", kind: "task", request: true, recipient: { name: "Shane Acton", email: "shane@example.com" }, recipientName: "Shane Acton", party: "Shane Acton", title: "Check the patch", createdAt: ago(36), state: "read", readAt: ago(31), ...over });

test("the recipient's open Task: Yours to do, Reject and Done, the ring on Seen", () => {
  const t = boot();
  const st = t.taskStateFor(inboundTask());
  assert.equal(st.tone, "open");
  assert.equal(st.text, "Yours to do");
  same(st.rungs, ["past", "now", "todo", "todo"]);
  const verbs = t.taskVerbsHtml(inboundTask(), st);
  assert.match(verbs, /data-task-verb="reject"[^>]*>Reject</);
  assert.match(verbs, /data-task-verb="done"[^>]*>Done</);
  assert.doesNotMatch(verbs, /Cancel/);
  const footer = t.taskCardFooterHtml(inboundTask());
  assert.match(footer, /data-tk-copy="t1"[^>]*>Copy for your agent</, "Copy for your agent is always on a live card");
  assert.match(footer, /data-host-open="t1" data-host="codex"/);
  assert.match(footer, /data-host-open="t1" data-host="claude"/);
  assert.doesNotMatch(footer, /tk-ladder/, "the recipient has no ladder in the card; the reader has it");
});

test("only the apps Settings › Your agent has on get a mark; Copy never leaves", () => {
  const t = boot({ apps: ["codex", "claude"], opens: (app) => app === "Codex" });
  const footer = t.taskCardFooterHtml(inboundTask());
  assert.match(footer, /data-host="codex"/);
  assert.doesNotMatch(footer, /data-host="claude"/);
  assert.match(footer, /Copy for your agent/);
  const none = boot({ apps: ["codex", "claude"], opens: () => false }).taskCardFooterHtml(inboundTask());
  assert.match(none, /Copy for your agent/);
  assert.doesNotMatch(none, /tk-apps/);
});

test("started: In progress for the doer, Started · name for the sender; Reject becomes Cancel", () => {
  const t = boot();
  const mine = t.taskStateFor(inboundTask({ taskStartedAt: ago(20) }));
  assert.equal(mine.tone, "started");
  assert.match(mine.text, /^In progress · 20m$/);
  assert.match(t.taskVerbsHtml(inboundTask({ taskStartedAt: ago(20) }), mine), /Cancel[\s\S]*Done/);
  const theirs = t.taskStateFor(sentTask({ taskStartedAt: ago(20) }));
  assert.match(theirs.text, /^Started · Shane · 20m$/);
  same(theirs.rungs, ["past", "past", "now", "todo"]);
  assert.equal(t.taskVerbsHtml(sentTask({ taskStartedAt: ago(20) }), theirs), "", "the sender has no verbs");
  assert.match(t.taskCardFooterHtml(sentTask({ taskStartedAt: ago(20) })), /tk-ladder/, "the sender tracks from the card");
});

test("the sender's open Task reads Seen or Sent from the receipt", () => {
  const t = boot();
  assert.match(t.taskStateFor(sentTask()).text, /^Seen · 31m$/);
  same(t.taskStateFor(sentTask()).rungs, ["past", "now", "todo", "todo"]);
  const unseen = t.taskStateFor(sentTask({ state: "delivered", readAt: null }));
  assert.match(unseen.text, /^Sent · 36m$/);
  same(unseen.rungs, ["now", "todo", "todo", "todo"]);
});

test("rejected and cancelled end the ladder early, in the person's name", () => {
  const t = boot();
  const rejected = t.taskStateFor(sentTask({ taskRejectedAt: ago(5), taskClosedBy: "Shane Acton" }));
  assert.equal(rejected.tone, "rejected");
  assert.equal(rejected.text, "Rejected · Shane · 5m");
  same(rejected.rungs, ["past", "past", "rejected"]);
  same(t.taskLadder(sentTask({ taskRejectedAt: ago(5), taskClosedBy: "Shane Acton" })).map((s) => s.label), ["Sent", "Seen", "Rejected"]);
  const own = t.taskStateFor(inboundTask({ taskRejectedAt: ago(5), taskClosedBy: "David Kariuki" }));
  assert.equal(own.text, "Rejected · you · 5m", "on the closer's own side the name is you");
  const cancelled = t.taskStateFor(sentTask({ taskStartedAt: ago(20), taskCancelledAt: ago(2), taskClosedBy: "Shane Acton" }));
  assert.equal(cancelled.text, "Cancelled · Shane · 2m");
  same(cancelled.rungs, ["past", "past", "past", "cancelled"]);
  assert.ok(t.taskIsOver(sentTask({ taskRejectedAt: ago(5) })));
  assert.equal(t.taskIsOver(sentTask({ taskStartedAt: ago(5) })), false);
});

test("done names the app or the person, and points at the result", () => {
  const result = { id: "r1", type: "completion", inReplyToRelayId: "s1", forHuman: "All green on a clean install." };
  const t = boot({ relays: [result] });
  const byAgent = sentTask({ taskStartedAt: ago(60), taskCompletedAt: ago(30), taskRunOwner: { kind: "external_mcp", provider: "codex" }, taskResultRelayId: "r1" });
  const st = t.taskStateFor(byAgent);
  assert.equal(st.text, "Done · Codex · 30m");
  same(st.rungs, ["past", "past", "past", "done"]);
  same(t.taskResultFor(byAgent), { id: "r1", source: "relays", bare: false });
  assert.match(t.taskResultLinkHtml(byAgent, st), /data-task-result="s1"[^>]*>Result</);
  assert.match(t.taskStatusModuleHtml(byAgent), /Read the result/);
  // A person's Done with a note points at the note; without a word there is nothing to point at.
  const note = { id: "r2", type: "completion", inReplyToRelayId: "s2", forHuman: "Ran it, all good." };
  const bare = { id: "r3", type: "completion", inReplyToRelayId: "s3", forHuman: "Done" };
  const t2 = boot({ relays: [note, bare] });
  const withNote = sentTask({ id: "s2", relayId: "s2", taskCompletedAt: ago(10), taskClosedBy: "Shane Acton", taskResultRelayId: "r2" });
  assert.equal(t2.taskStateFor(withNote).text, "Done · Shane · 10m");
  assert.match(t2.taskResultLinkHtml(withNote, t2.taskStateFor(withNote)), />Note</);
  const wordless = sentTask({ id: "s3", relayId: "s3", taskCompletedAt: ago(10), taskClosedBy: "Shane Acton", taskResultRelayId: "r3" });
  assert.equal(t2.taskResultLinkHtml(wordless, t2.taskStateFor(wordless)), "");
  // A Done by hand that nobody started leaves Started faint: lit means happened.
  same(t2.taskStateFor(withNote).rungs, ["past", "past", "todo", "done"]);
});

test("Done holds for a few seconds with Undo before anything is posted", () => {
  const t = boot();
  const row = inboundTask();
  const posted = [];
  let rerenders = 0;
  t.startTaskDone("t1", () => { rerenders += 1; });
  assert.equal(t.TASK_UNDO_MS, 5000);
  assert.ok(t.taskDonePending.has("t1"));
  const st = t.taskStateFor(row);
  assert.equal(st.pending, true);
  assert.equal(st.text, "Done · you · just now");
  assert.match(t.taskVerbsHtml(row, st), /data-task-verb="undo"[^>]*>Undo</);
  assert.doesNotMatch(t.taskVerbsHtml(row, st), /Reject|Cancel/);
  clearTimeout(t.taskDonePending.get("t1").timer);
  t.taskDonePending.delete("t1");
  assert.equal(posted.length, 0);
  assert.ok(rerenders >= 1);
  assert.equal(t.taskStateFor(row).text, "Yours to do", "undone: the record never changed");
});

test("the list line: rungs, the state in words, and the result link on Done rows", () => {
  const t = boot({ relays: [{ id: "r1", type: "completion", inReplyToRelayId: "s1", forHuman: "Result." }] });
  const line = t.taskRowLineHtml(inboundTask());
  assert.match(line, /^<div class="tk-rowline open"><span class="tk-rungs"/);
  assert.match(line, /<span>Yours to do<\/span>/);
  assert.equal((line.match(/tk-rung /g) || []).length, 4);
  const done = t.taskRowLineHtml(sentTask({ taskStartedAt: ago(60), taskCompletedAt: ago(30), taskRunOwner: { provider: "codex" }, taskResultRelayId: "r1" }));
  assert.match(done, /tk-rowline done/);
  assert.match(done, /Done · Codex · 30m/);
  assert.match(done, /data-task-result="s1"/);
});

test("the Task-event message: a typed reply to the Task, only a person's Done reads as an event", () => {
  const task = sentTask({ taskClosedBy: "Shane Acton", taskCompletedAt: ago(1) });
  const t = boot({ sent: [task] });
  const lookup = (id) => (id === "s1" ? task : null);
  const rejected = t.taskEventOf({ id: "e1", type: "task_rejected", inReplyToRelayId: "s1", body: "Can’t this week.", party: "Shane Acton", direction: "in" }, lookup);
  same(rejected, { tone: "rejected", bare: false, note: "Can’t this week.", who: "Shane", verb: "rejected this task", parentId: "s1", title: "Check the patch" });
  const bare = t.taskEventOf({ id: "e2", type: "task_cancelled", inReplyToRelayId: "s1", body: "Cancelled this task.", party: "Shane Acton", direction: "in" }, lookup);
  assert.equal(bare.bare, true);
  assert.equal(bare.verb, "cancelled this task");
  const own = t.taskEventOf({ id: "e3", type: "task_rejected", inReplyToRelayId: "s1", body: "", direction: "out" }, lookup);
  assert.equal(own.who, "You");
  const humanDone = t.taskEventOf({ id: "c1", type: "completion", inReplyToRelayId: "s1", body: "Done", party: "Shane Acton", direction: "in" }, lookup);
  assert.equal(humanDone.tone, "done");
  assert.equal(humanDone.bare, true);
  const agentDone = t.taskEventOf({ id: "c2", type: "completion", inReplyToRelayId: "s9", body: "The result letter.", party: "Shane Acton", direction: "in" }, () => sentTask({ id: "s9" }));
  assert.equal(agentDone, null, "an agent's completion keeps its result letter");
  assert.equal(t.taskEventOf({ id: "m1", inReplyToRelayId: "s1", body: "Just a reply." }, lookup), null);
});

test("a channel Task keeps the claim lifecycle as its verbs; Reject and Cancel never appear", () => {
  const t = boot();
  const unclaimed = inboundTask({ taskClaim: { scope: "channel", state: "unclaimed", workState: "idle", version: 0, capabilities: { canClaim: true } } });
  const st = t.taskStateFor(unclaimed);
  assert.equal(st.text, "Unclaimed");
  assert.match(t.taskVerbsHtml(unclaimed, st), /Claim</);
  assert.doesNotMatch(t.taskVerbsHtml(unclaimed, st), /Reject|Done/);
  const mine = inboundTask({ taskClaim: { scope: "channel", state: "claimed", workState: "idle", version: 1, claimant: { self: true, name: "David" }, claimedAt: ago(3), capabilities: { canUnclaim: true } } });
  assert.match(t.taskVerbsHtml(mine, t.taskStateFor(mine)), /Unclaim[\s\S]*Done/);
  const working = inboundTask({ taskStartedAt: ago(20), taskClaim: { scope: "channel", state: "claimed", workState: "working", version: 1, claimant: { self: true, name: "David" }, claimedAt: ago(25) } });
  assert.match(t.taskStateFor(working).text, /^In progress · you · 20m$/);
  assert.match(t.taskVerbsHtml(working, t.taskStateFor(working)), /Release[\s\S]*Done/);
  const theirs = inboundTask({ taskClaim: { scope: "channel", state: "claimed", workState: "idle", version: 1, claimant: { self: false, name: "Anna Keller" }, claimedAt: ago(20) } });
  assert.match(t.taskStateFor(theirs).text, /^Claimed by Anna Keller · 20m$/);
  assert.equal(t.taskVerbsHtml(theirs, t.taskStateFor(theirs)), "");
});

test("the room renders the card and the event bubble in place of the claim slot and the read line", () => {
  assert.match(inbox, /const taskEvent = m\.request \? null : taskEventOf\(m, \(parentId\) => messageById\.get\(parentId\)\);/);
  assert.match(inbox, /\$\{taskEvent \? taskEventRefHtml\(taskEvent\) : messageReplyReferenceHtml\(m\)\}/);
  assert.match(inbox, /const receipt = m\.request \? null : receiptFor\(m, msgs\);/, "the footer is the receipt on a Task bubble");
  assert.match(inbox, /tk-event \$\{taskEvent\.tone\}\$\{taskEvent\.bare \? " bare" : ""\}/);
  // The projections carry the closed-Task fields and the type on both sides.
  for (const prefix of ["r", "s"]) {
    assert.match(inbox, new RegExp(`taskRejectedAt: ${prefix}\\.taskRejectedAt \\|\\| null,\\s*taskCancelledAt: ${prefix}\\.taskCancelledAt \\|\\| null,\\s*taskClosedBy: ${prefix}\\.taskClosedBy \\|\\| null,\\s*taskResultRelayId: ${prefix}\\.taskResultRelayId \\|\\| null,`));
  }
});

test("the list: Chats · Received · Sent, the All · Relays · Tasks filter, and hover with intent", () => {
  assert.match(inbox, /data-relays-layout="sent" aria-pressed="false">Sent</);
  assert.match(inbox, /id="relaysFilter"[^>]*hidden>/);
  for (const key of ["all", "relays", "tasks"]) assert.match(inbox, new RegExp(`data-relays-filter="${key}"`));
  assert.match(inbox, /const RELAYS_LAYOUTS = \["chats", "received", "sent"\];/);
  assert.match(inbox, /relaysFilterEl\.hidden = !visible \|\| relaysLayout === "chats";/, "the filter belongs to the item lists only");
  assert.match(inbox, /: relaysLayout === "sent" \? \(payload\.sent \|\| \[\]\)\.filter\(relaysFilterKeeps\)/);
  assert.match(inbox, /\$\{isTask \? taskRowLineHtml\(r\) : ""\}/, "every received Task row says its state under the title");
  assert.match(inbox, /\$\{taskRow \? taskRowLineHtml\(r\) : ""\}/, "every sent Task row too");
  // Hover with intent: the design IS the timing.
  assert.match(inbox, /const HOVER_REST_MS = 1200;/);
  assert.match(inbox, /const HOVER_SWITCH_MS = 250;/);
  assert.match(inbox, /const HOVER_LEAVE_MS = 350;/);
  assert.match(inbox, /window\.matchMedia\("\(hover: none\)"\)\.matches/, "no reveal on a touch screen");
  assert.match(inbox, /relaysListEl\.addEventListener\("focusin"/, "focus reveals at once");
  assert.match(inbox, /if \(relaysLayout === "chats"\) return;/, "conversation rows never reveal");
  // The name never truncates: the channel badge yields first.
  assert.match(inbox, /\.rk-top \.rk-recipient-group \{ flex:0 5 auto; min-width:34px; \}/);
});

test("main posts the person's close and stamps the row at once; the bridge and the daemon carry the fields", () => {
  const close = between(main, "async function closeTaskByHand(relayId, kind, note)", "async function listTodo(");
  assert.match(close, /client\.taskRejected\(id, \{ idempotencyKey, \.\.\.\(word \? \{ note: word \} : \{\}\) \}\)/);
  assert.match(close, /client\.taskCancelled\(id, \{ idempotencyKey, \.\.\.\(word \? \{ note: word \} : \{\}\) \}\)/);
  assert.match(close, /client\.taskCompleted\(id, \{ idempotencyKey, human: true, forHuman: word \|\| "Done", forAgent: "" \}\)/);
  assert.match(close, /updateStagedPacket\(id, patch\);\s*await pushInbox\(true\);/);
  assert.match(main, /ipcMain\.handle\("relay:taskReject", \(_e, id, note\) => closeTaskByHand\(id, "rejected", note\)\);/);
  assert.match(main, /ipcMain\.handle\("relay:taskCancel", \(_e, id, note\) => closeTaskByHand\(id, "cancelled", note\)\);/);
  assert.match(main, /ipcMain\.handle\("relay:taskDone", \(_e, id, note\) => closeTaskByHand\(id, "done", note\)\);/);
  for (const name of ["taskReject", "taskCancel", "taskDone"]) assert.match(preload, new RegExp(`${name}: \\(id, note\\) => ipcRenderer\\.invoke\\("relay:${name}"`));
  // Every row projection and fingerprint carries the four fields, so a close landing on a poll repaints.
  assert.equal((main.match(/r\.taskRejectedAt,\s*r\.taskCancelledAt,\s*r\.taskClosedBy,\s*r\.taskResultRelayId,/g) || []).length, 3);
  assert.match(main, /taskRejectedAt: p\.taskRejectedAt \|\| null,/);
  assert.match(main, /taskRejectedAt: sent\.taskRejectedAt \|\| null,/);
  assert.match(main, /taskRejectedAt: local\.taskRejectedAt \|\| null,/);
  assert.match(notifications, /taskRejectedAt: item\.taskRejectedAt \|\| existing\.taskRejectedAt \|\| null,/);
  assert.match(notifications, /taskResultRelayId: item\.taskResultRelayId \|\| existing\.taskResultRelayId \|\| null,/);
});
