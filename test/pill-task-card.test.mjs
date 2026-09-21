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
    avatarHue: () => 24,
    avatarInitials: (name) => String(name || "?").slice(0, 2).toUpperCase(),
    Object,
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
  vm.runInContext(block + "\nthis.__t = { taskStateFor, taskLadder, taskVerbsHtml, taskCardFooterHtml, taskStatusModuleHtml, taskRowLineHtml, taskEventOf, taskResultFor, taskResultLinkHtml, taskIsOver, taskAsking, taskAskRowHtml, taskStateRowHtml, taskVerb, TASK_ASK_GUARD_MS, taskIsEveryone, taskRosterCardHtml, taskRosterGroupedHtml, taskRosterYouStripHtml, taskRosterSumText, taskRosterTone, taskRosterCountsOf, taskRosterHelperText };", context);
  context.__t.__context = context;
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

// Done asks the way Reject and Cancel do (David's candidate A, 2026-09-17):
// nothing is stamped on the first press, the second seals it with the word.
function stubClose(t, context, result = { ok: true }) {
  const calls = [];
  for (const name of ["taskDone", "taskReject", "taskCancel"]) context.window.relay[name] = async (id, note) => { calls.push([name, id, note]); return typeof result === "function" ? result() : result; };
  return calls;
}
function bootWith(relays) {
  const t = boot({ relays });
  return t;
}
const passGuard = (t, id) => { t.taskAsking.get(id).openedAt = Date.now() - t.TASK_ASK_GUARD_MS - 1; };

test("Done asks before anything is posted", async () => {
  const row = inboundTask();
  const t = bootWith([row]);
  const calls = stubClose(t, t.__context);
  let rerenders = 0;
  const rerender = () => { rerenders += 1; };
  await t.taskVerb("done", "t1", rerender);
  assert.equal(calls.length, 0, "the first press posts nothing");
  const st = t.taskStateFor(row);
  assert.equal(st.text, "Yours to do", "nothing is stamped while it asks");
  const verbs = t.taskVerbsHtml(row, st);
  assert.match(verbs, /data-task-verb="keep"[^>]*>Keep</);
  assert.match(verbs, /class="tk-btn primary" data-task-verb="done"[^>]*>Done</, "the seal is primary, never danger");
  assert.doesNotMatch(verbs, /Reject|Undo/);
  assert.match(t.taskVerbsHtml(row, st, { surface: "reader" }), /data-task-verb="done"[^>]*>Mark done</);
  assert.match(t.taskAskRowHtml(row), /placeholder="Tell Sven how it went \(optional\)"/);
  assert.match(t.taskAskRowHtml(row), /aria-label="Tell Sven how it went"/);
  assert.match(t.taskStateRowHtml(row, st), /tk-foot open asking[\s\S]*Marking done/);
  assert.match(t.taskStatusModuleHtml(row), /Marking done\. A word for them is optional\./);
  // The same spot pressed twice is a double-click, not a decision.
  await t.taskVerb("done", "t1", rerender);
  assert.equal(calls.length, 0, "a second press inside the guard is ignored");
  passGuard(t, "t1");
  await t.taskVerb("done", "t1", rerender);
  same(calls, [["taskDone", "t1", ""]]);
  assert.equal(t.taskAsking.has("t1"), false);
  const after = t.taskStateFor(row);
  assert.equal(after.pending, true, "posted, not yet stamped by main");
  assert.equal(after.text, "Done · you · just now");
  assert.equal(t.taskVerbsHtml(row, after), "", "no Undo: the Task is closed");
  assert.doesNotMatch(t.taskStatusModuleHtml(row), /Undo/);
  assert.ok(rerenders >= 3);
});

test("Done carries the word to the sender; Keep backs out; a failed post keeps the ask", async () => {
  const row = inboundTask({ taskStartedAt: ago(20) });
  const t = bootWith([row]);
  const calls = stubClose(t, t.__context);
  await t.taskVerb("done", "t1", () => {});
  assert.match(t.taskStateRowHtml(row, t.taskStateFor(row)), /tk-foot started asking[\s\S]*Marking done/, "the started mark stays while it asks");
  await t.taskVerb("keep", "t1", () => {});
  assert.equal(t.taskAsking.has("t1"), false);
  assert.match(t.taskVerbsHtml(row, t.taskStateFor(row)), /Cancel[\s\S]*Done/);
  await t.taskVerb("done", "t1", () => {});
  t.taskAsking.get("t1").draft = "  Patched and shipped.  ";
  passGuard(t, "t1");
  await t.taskVerb("done", "t1", () => {});
  same(calls, [["taskDone", "t1", "Patched and shipped."]]);

  const row2 = inboundTask({ id: "t2" });
  const t2 = bootWith([row2]);
  stubClose(t2, t2.__context, { ok: false, error: "Relay is offline." });
  await t2.taskVerb("done", "t2", () => {});
  passGuard(t2, "t2");
  await t2.taskVerb("done", "t2", () => {});
  assert.ok(t2.taskAsking.has("t2"), "the ask stays open to try again");
  assert.equal(t2.taskStateFor(row2).text, "Yours to do", "nothing stamped on failure");
  assert.match(t2.taskStatusModuleHtml(row2), /Relay is offline\./);
});

test("Reject and Cancel get the same double-click guard", async () => {
  const row = inboundTask();
  const t = bootWith([row]);
  const calls = stubClose(t, t.__context);
  await t.taskVerb("reject", "t1", () => {});
  await t.taskVerb("reject", "t1", () => {});
  assert.equal(calls.length, 0);
  assert.match(t.taskAskRowHtml(row), /placeholder="Tell Sven why \(optional\)"/);
  passGuard(t, "t1");
  await t.taskVerb("reject", "t1", () => {});
  same(calls, [["taskReject", "t1", ""]]);
});

test("a channel Task's Done asks too", async () => {
  const row = inboundTask({ taskClaim: { scope: "channel", state: "claimed", workState: "idle", version: 1, claimant: { self: true, name: "David" }, claimedAt: ago(3), capabilities: { canUnclaim: true } } });
  const t = bootWith([row]);
  await t.taskVerb("done", "t1", () => {});
  const verbs = t.taskVerbsHtml(row, t.taskStateFor(row));
  assert.match(verbs, /Keep[\s\S]*data-task-verb="done"[^>]*>Done</);
  assert.doesNotMatch(verbs, /Unclaim/);
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
  const receiptExpression = inbox.match(/const receipt = ([^;]+receiptFor\(m, msgs\));/);
  assert.ok(receiptExpression, "the room chooses a receipt beneath each message");
  const receiptForMessage = new Function("m", "attachments", "msgs", "receiptFor", `return ${receiptExpression[1]};`);
  const receipt = { label: "Read" };
  const renderReceipt = (message, attachments) => receiptForMessage(message, attachments, [], () => receipt);
  assert.equal(renderReceipt({ request: {} }, []), null, "a task without attachments uses its card footer");
  assert.equal(renderReceipt({ request: {} }, [{}]), receipt, "a task with attachments repeats the receipt beneath them");
  assert.equal(renderReceipt({}, []), receipt, "an ordinary message keeps its receipt");
  assert.equal(renderReceipt({ deletedAt: "today" }, [{}]), null, "a deleted message has no receipt");
  assert.equal(renderReceipt({ request: {}, deletedAt: "today" }, [{}]), null, "a deleted task has no receipt");
  assert.match(inbox, /tk-event \$\{taskEvent\.tone\}\$\{taskEvent\.bare \? " bare" : ""\}/);
  // The projections carry the closed-Task fields and the type on both sides.
  for (const prefix of ["r", "s"]) {
    assert.match(inbox, new RegExp(`taskRejectedAt: ${prefix}\\.taskRejectedAt \\|\\| null,\\s*taskCancelledAt: ${prefix}\\.taskCancelledAt \\|\\| null,\\s*taskClosedBy: ${prefix}\\.taskClosedBy \\|\\| null,\\s*taskResultRelayId: ${prefix}\\.taskResultRelayId \\|\\| null,`));
  }
});

test("item filters distinguish agent documents from chat texts on both Sent and Received", () => {
  const source = between(inbox, "function relaysFilterKeeps(row)", "// HOVER WITH INTENT");
  const taskSource = between(inbox, "function isTaskRow(r)", "function taskRows()");
  const keeps = (filter, row) => Function("relaysFilter", "row", `${taskSource}\n${source}\nreturn relaysFilterKeeps(row);`)(filter, row);
  const texts = [
    { kind:"message", forHuman:"cool", forAgent:"" },
    { kind:"message", forHuman:"@SvenWellmann" },
    { title:"A titled text", forHuman:"@Shane_Acton", forAgent:"  \n" },
    { forHuman:"", attachments:[{ id:"image" }], forAgent:"" },
    { source:{ host:"relay-agent-run" }, forHuman:"Agent output", forAgent:"Run context" },
  ];
  const relay = { kind:"message", title:"Plan", forHuman:"Here is the plan", forAgent:"Complete agent context" };
  const tasks = [{ kind:"task", forAgent:"" }, { relayNotificationKind:"task_request" }, { relayNotificationKind:"task" }, { request:true }];
  for (const filter of ["all", "relays", "tasks"]) {
    for (const row of texts) assert.equal(keeps(filter, row), false, `${filter} excludes ${JSON.stringify(row)}`);
    assert.equal(keeps(filter, relay), filter !== "tasks");
    for (const row of tasks) assert.equal(keeps(filter, row), filter !== "relays");
  }
});

test("the list: Inbox types, Received · Sent directions, and unchanged hover with intent", () => {
  assert.match(inbox, /data-inbox-direction="sent" aria-pressed="false">Sent</);
  assert.match(inbox, /id="relaysFilter"[^>]*hidden>/);
  for (const key of ["chats", "tasks", "relays"]) assert.match(inbox, new RegExp(`data-inbox-type="${key}"`));
  assert.doesNotMatch(inbox, /data-relays-filter="all"/);
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

// ---- EVERYONE TASKS: the roster (David, 2026-09-17) ----
// Each member owes it, each holds their own copy, and EVERYONE sees how
// everyone is getting on. The wire carries a few members per state plus exact
// counts; nothing on screen may count rows to say how many there are.
const ROSTER_COUNTS = { total: 100, done: 12, started: 4, rejected: 3, cancelled: 0, seen: 60, sent: 21 };
const rosterMember = (name, state, over = {}) => ({ relayId: `r-${name}`, name, self: false, state, at: ago(20), ...over });
const ROSTER = [
  rosterMember("You", "seen", { self: true, relayId: "t1" }),
  rosterMember("Priya Natarajan", "done", { resultRelayId: "res-priya" }),
  rosterMember("Anna Keller", "done", { resultRelayId: "res-anna" }),
  rosterMember("Ben Okafor", "started"),
  rosterMember("Dana Mori", "rejected"),
  rosterMember("Chen Feng", "seen"),
  rosterMember("Nils Berg", "sent", { at: undefined }),
];
const everyoneTask = (over = {}) => inboundTask({ taskAssignment: "everyone", taskRoster: ROSTER, taskRosterCounts: ROSTER_COUNTS, ...over });
const everyoneSent = (over = {}) => sentTask({ taskAssignment: "everyone", taskRoster: ROSTER.filter((m) => !m.self), taskRosterCounts: ROSTER_COUNTS, ...over });

test("a member's card: You first with their own verbs, then the newest movements, then the rest counted", () => {
  const t = boot();
  const row = everyoneTask();
  assert.equal(t.taskIsEveryone(row), true);
  const card = t.taskRosterCardHtml(row);
  // You is pinned first, and carries the verbs — the sum line keeps none.
  assert.match(card, /^<div class="tk-roster"><div class="tk-roster-row open you"/);
  assert.match(card, /tk-roster-row open you[\s\S]*?>You<\/span>[\s\S]*?data-task-verb="reject"[\s\S]*?data-task-verb="done"/);
  // Three movements, newest first, and never the seen or the unseen.
  const names = [...card.matchAll(/class="tk-roster-name">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 4), ["You", "Priya Natarajan", "Anna Keller", "Ben Okafor"]);
  assert.equal(names.length, 4, "the card never grows past You plus three");
  assert.doesNotMatch(card, /Chen Feng|Nils Berg/, "people who have only seen it are counted, not listed");
  // The counted line is the EXACT counts, not the length of the list on the wire.
  assert.match(card, /<span class="tk-roster-more-n">96 more<\/span>/);
  // The breakdown describes the REMAINDER it sits beside, so the four people
  // already named above it are subtracted: it must never sum past "96 more".
  assert.match(card, /10 done · <i class="tk-mark started"><\/i>3 in progress · <i class="tk-mark rejected"><\/i>3 rejected · <i class="tk-mark open"><\/i>80 waiting/);
  assert.doesNotMatch(card, /0 cancelled/, "a state nobody is in is left out");
  // A Done row is a door to that person's result; an In progress row is not.
  assert.match(card, /data-task-result-of="res-priya"/);
  assert.equal(card.split("data-task-result-of=").length - 1, 2);
});

test("the sender's card carries the same roster, with no You row and no verbs", () => {
  const t = boot();
  const card = t.taskRosterCardHtml(everyoneSent());
  assert.doesNotMatch(card, /tk-roster-row[^"]*you/, "the sender does not owe it");
  assert.doesNotMatch(card, /data-task-verb/, "and has nothing to press");
  assert.match(card, /<span class="tk-roster-more-n">97 more<\/span>/, "with no You row, one more person is in the count");
});

test("the sum reads in words and takes the tone of what is happening", () => {
  const t = boot();
  assert.equal(t.taskRosterSumText(ROSTER_COUNTS), "Everyone · 12 of 100 done");
  assert.equal(t.taskRosterTone(ROSTER_COUNTS), "started");
  const allDone = { total: 4, done: 4, started: 0, rejected: 0, cancelled: 0, seen: 0, sent: 0 };
  assert.equal(t.taskRosterSumText(allDone), "Everyone · all 4 done");
  assert.equal(t.taskRosterTone(allDone), "done");
  const onlyRefused = { total: 4, done: 0, started: 0, rejected: 2, cancelled: 0, seen: 2, sent: 0 };
  assert.equal(t.taskRosterTone(onlyRefused), "rejected");
  assert.equal(t.taskRosterTone({ total: 3, done: 0, started: 0, rejected: 0, cancelled: 0, seen: 1, sent: 2 }), "open");
});

test("an older server without the counts is counted from the members it did send", () => {
  const t = boot();
  const counts = t.taskRosterCountsOf({ taskRoster: ROSTER });
  assert.equal(counts.total, ROSTER.length);
  assert.equal(counts.done, 2);
  assert.equal(counts.rejected, 1);
  assert.equal(t.taskRosterCountsOf({}).total, 0);
});

test("the expanded Task groups by state: the two worth acting on open, the rest are their count", () => {
  const t = boot();
  const grouped = t.taskRosterGroupedHtml(everyoneTask());
  const groups = [...grouped.matchAll(/<div class="tk-group ([a-z]+)( is-open)?">[\s\S]*?<span class="tk-group-label">([^<]*)<\/span><span class="tk-group-count">(\d+)<\/span>/g)]
    .map((m) => ({ tone: m[1], open: Boolean(m[2]), label: m[3], count: Number(m[4]) }));
  assert.deepEqual(groups.map((g) => [g.label, g.count, g.open]), [
    ["In progress", 4, true],
    ["Rejected", 3, true],
    ["Done", 12, false],
    ["Seen, not started", 60, false],
    ["Not yet seen", 21, false],
  ]);
  // The "seen" tone is literally the word `open`, so expansion needs its own
  // class: with one class doing both, every seen group rendered as expanded.
  const seen = groups.find((g) => g.label === "Seen, not started");
  assert.equal(seen.tone, "open");
  assert.equal(seen.open, false);
  assert.match(grouped, /\.tk-group|tk-group open">/, "the tone class survives");
  // A group shows what the wire sent and counts the rest.
  assert.match(grouped, /<div class="tk-group started is-open">[\s\S]*?Ben Okafor/);
  // The wire sends a few members per state, so a remainder is SAID, never offered
  // as a button that could only redraw the same rows.
  assert.match(grouped, /<div class="tk-group-more">and \d+ more<\/div>/);
  assert.doesNotMatch(grouped, /data-task-roster-more/);
  // The viewer is never repeated inside a group: the strip above is where they are.
  assert.doesNotMatch(grouped, /class="tk-roster-name">You</);
});

test("the You strip and the helper say what is theirs and what is the room's", () => {
  const t = boot();
  const row = everyoneTask();
  const strip = t.taskRosterYouStripHtml(row, t.taskStateFor(row));
  assert.match(strip, /<div class="tk-you open">/);
  assert.match(strip, /<span class="tk-you-name">You<\/span>/);
  assert.match(strip, /Yours to do/);
  assert.match(strip, /data-task-verb="done"[^>]*>Mark done</, "the reader's verbs, not the card's");
  assert.equal(t.taskRosterYouStripHtml(everyoneSent(), t.taskStateFor(everyoneSent())), "", "the sender has no strip");
  assert.match(t.taskRosterHelperText(row), /^12 of 100 done · 3 people rejected it\. Your own Reject and Done speak only for you\.$/);
  assert.match(t.taskRosterHelperText(everyoneSent()), /Every Done row opens that person's result\.$/);
});

test("the list line: a member reads their own state first, the sender reads the sum", () => {
  const t = boot();
  const mine = t.taskRowLineHtml(everyoneTask());
  assert.match(mine, /<span>Yours to do · everyone · 12 of 100 done<\/span>/);
  assert.doesNotMatch(mine, /tk-link/, "a member's own row offers no results link");
  const theirs = t.taskRowLineHtml(everyoneSent());
  assert.match(theirs, /<span>Everyone · 12 of 100 done · 3 rejected<\/span>/);
  assert.match(theirs, /data-task-roster-open[^>]*>12 results/);
  // An Everyone Task with nothing done yet offers no results link.
  const early = t.taskRowLineHtml(everyoneSent({ taskRosterCounts: { total: 4, done: 0, started: 1, rejected: 0, cancelled: 0, seen: 3, sent: 0 } }));
  assert.doesNotMatch(early, /results/);
});

test("the card, the reader and the lists all fork on the assignment", () => {
  // The renderer must never fall through to the one-ladder card for an Everyone Task.
  const footer = inbox.slice(inbox.indexOf("function taskCardFooterHtml(row)"), inbox.indexOf("// The expanded Task's module"));
  // Every Everyone verb rides the viewer's own roster row, so a card whose
  // roster never arrived falls back to the ordinary state row that carries them.
  assert.match(footer, /const roster = taskIsEveryone\(row\) \? taskRosterCardHtml\(row\) : "";/);
  assert.match(footer, /if \(taskIsEveryone\(row\) && roster\) \{/);
  assert.match(footer, /live && !mine \? taskAgentRowHtml\(row\) : ""/, "a member may still hand their own copy to an agent");
  const module = inbox.slice(inbox.indexOf("function taskStatusModuleHtml(row)"), inbox.indexOf("function taskRowLineHtml(row)"));
  assert.match(module, /const grouped = taskIsEveryone\(row\) \? taskRosterGroupedHtml\(row\) : "";/);
  assert.match(module, /if \(taskIsEveryone\(row\) && grouped\) \{/);
  // And the server is the one source of the split.
  const relays = fs.readFileSync(new URL("../../../apps/api/src/services/relays.ts", import.meta.url), "utf8");
  const todo = fs.readFileSync(new URL("../../../apps/api/src/services/todo.ts", import.meta.url), "utf8");
  assert.match(todo, /export function isSharedChannelTask\(row: RelayRow\)[\s\S]*?row\.taskAssignment !== "everyone"/);
  assert.match(relays, /const isChannelTask = isSharedChannelTask;/, "one rule, used by claims, receipts and Todo alike");
  assert.match(todo, /const sharedTask = isSharedChannelTask\(row\);/, "an Everyone member's Todo is their own, not the room's");
});

test("Done on an Everyone card asks on the You row, and only the sender's rows are doors", async () => {
  const row = everyoneTask();
  const t = boot({ relays: [row] });
  // The verbs ride the You row, so the ask does too: Keep, Done, and the field.
  await t.taskVerb("done", "t1", () => {});
  const asking = t.taskRosterCardHtml(row);
  assert.match(asking, /data-task-verb="keep"[^>]*>Keep<[\s\S]*data-task-verb="done"[^>]*>Done</);
  assert.doesNotMatch(asking, /data-task-verb="reject"|Undo/);
  assert.match(t.taskCardFooterHtml(row), /Tell Sven how it went \(optional\)/);
  assert.match(t.taskRosterYouStripHtml(row, t.taskStateFor(row)), /Keep[\s\S]*Mark done/);
  t.taskAsking.delete("t1");
  // A member's result Relay is addressed to the sender alone: on anyone else's
  // device that id opens nothing, so only the sender's rows carry the chevron.
  assert.doesNotMatch(t.taskRosterCardHtml(row), /tk-roster-link/, "a member is offered no door");
  assert.match(t.taskRosterCardHtml(everyoneSent()), /tk-roster-link/, "the sender is");
});
