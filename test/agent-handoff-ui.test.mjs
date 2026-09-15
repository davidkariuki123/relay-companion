// THE HAND-OFF (David, 2026-09-03: "hand-off, not runner"). Send on the agent
// document, and Start on a Task, open a real session in the desktop app named
// on the composer rail — the Relay as the assistant's letter, the words as the
// first user turn — and Relay keeps only a receipt in the pill.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

const inbox = read("../overlay/inbox.html");
const preload = read("../overlay/preload.cjs");
const main = read("../overlay/main.cjs");
const delivery = read("../src/session-delivery.js");

const handoff = between(main, "async function handOffToAgent", "// The kick prompt is the task's REAL first user message.");
const docks = between(inbox, "function hostMark(provider)", "function wireRequestControls");
const controls = between(inbox, "function wireRequestControls", "// Todo's amber number counts Needs attention");
const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board");

test("Send on the agent document is a hand-off: one verb, one IPC, no runner", () => {
  // The agent face's composer is the shared route-selecting capsule with Send
  // as its verb, and Start on a Task is the same capsule with a Task verb.
  assert.match(docks, /function relayWorkDockHtml\(r, \{ inline = false \} = \{\}\)/);
  assert.match(docks, /return idleRunDockHtml\(r, \{ inline, draft, failed, label: failed \? "Retry" : "Send" \}\);/);
  assert.match(docks, /data-handoff="\$\{esc\(r\.id\)\}">\$\{esc\(label\)\}<\/button>/);
  assert.match(docks, /placeholder="Tell \$\{esc\(rt\.app\)\} anything…"/);
  assert.match(docks, /data-route-menu="app"/);
  // One click, one IPC, carrying the rail's route and the Settings permission.
  assert.match(controls, /const res = await window\.relay\.agentHandoff\(id, \{\s*host,\s*model: modelIdFor\(rt\.app, rt\.model\),\s*effort: String\(rt\.effort \|\| "high"\)\.toLowerCase\(\),\s*note,/);
  assert.match(controls, /source: row\.outbound \? "sent" : "relay"/);
  assert.match(controls, /permission: permMode\(host === "claude" \? "claude" : "codex"\)/);
  assert.match(preload, /agentHandoff: \(id, route\) => ipcRenderer\.invoke\("relay:agentHandoff"/);
  assert.match(main, /ipcMain\.handle\("relay:agentHandoff", \(_e, id, route\) =>\s*handOffToAgent\(\{/);
  // The runner is gone from the pill: no feed, no steer, no queue, no worker.
  for (const gone of ["runFeed", "runSteer", "relayWorkStart", "data-steer", "data-work-start", "appendOptimisticUserTurn", "RelayWorkUI", "work-ui.js", 'data-rtab="work"']) {
    assert.equal(inbox.includes(gone), false, `${gone} survives in the pill`);
  }
  for (const gone of ["relayWorkStart", "runFeed", "runSteer", "openRunSession"]) {
    assert.equal(preload.includes(gone), false, `${gone} survives in the pill preload`);
  }
  for (const gone of ["spawnBackgroundClaude", "createClaudeDesktopCodeSession", "adapters.launchTurn", "forgeTaskSessionQuietly", "startTaskFromPreview("]) {
    assert.equal(handoff.includes(gone), false, `the hand-off must not ${gone}`);
  }
  assert.equal(main.includes("async function startTaskFromPreview"), false);
});

test("the composer becomes the receipt card in the same click", () => {
  // Optimistic: the local receipt is set BEFORE main is asked, so the capsule
  // is already the card when the app starts opening.
  const localAt = controls.indexOf('handoffLocal.set(String(id), { state:"starting"');
  const ipcAt = controls.indexOf("await window.relay.agentHandoff(id");
  assert.ok(localAt > -1 && ipcAt > localAt, "the card paints before the IPC");
  assert.match(inbox, /const handoffLocal = new Map\(\);/);
  assert.match(inbox, /if \(remoteAt >= local\.at\) \{ handoffLocal\.delete\(key\); return remote; \}/, "main's receipt wins once it is newer");
  // The card: starting breathes the app's mark; its clickable launch receipt
  // says Running briefly, then becomes an honest permanent Open link.
  assert.match(docks, /Starting a session in \$\{esc\(app\)\}…/);
  assert.match(docks, /const HANDOFF_LAUNCH_FEEDBACK_MS = 5000;/);
  assert.match(docks, /text:`Open in \$\{app\}`, crossfade:handoffLabelsCrossfading\.has\(id\)/);
  assert.match(docks, /text:`Running in \$\{app\}`, crossfade:false/);
  assert.match(docks, /text:`Finished in \$\{app\}`, crossfade:false/);
  assert.match(docks, /handoffLabelsCrossfading\.add\(id\);\s*renderAll\(\);/);
  assert.match(docks, /class="ho-label-crossfade"/);
  assert.match(inbox, /@keyframes handoffLabelOut/);
  assert.match(inbox, /@keyframes handoffLabelIn/);
  assert.match(inbox, /prefers-reduced-motion:reduce[^]*\.ho-label-crossfade \.from \{ display:none; \}/);
  assert.match(docks, /<button type="button" class="ho-card \$\{provider\}\$\{done \? " done" : ""\}" data-handoff-open="\$\{esc\(r\.id\)\}">/);
  assert.match(docks, /\$\{esc\(app\)\} replies there, not here/);
  assert.match(docks, /function handoffBubbleHtml\(h\)/);
  assert.match(inbox, /\.ho-card\.starting \.ho-logo \{ animation:hostOpenBreathe/);
  assert.match(controls, /window\.relay\.continueSession\(id, row\.outbound \? "sent" : "relay"\)/, "Open preserves the durable inbound/sent route key");
  assert.match(preload, /continueSession: \(id, source\) => ipcRenderer\.invoke\("relay:continueSession"/);
});

test("the hand-off orders its steps: sign-in, open, then the first turn", () => {
  const authAt = handoff.indexOf("assertProviderReady(host)");
  const openAt = handoff.indexOf("deliverPacketToSession(requestedId, {");
  const turnAt = handoff.indexOf("deliverTurnToSession(binding, firstTurn");
  assert.ok(authAt > -1 && openAt > authAt && turnAt > openAt, "sign-in, open, first turn stay ordered");
  // A Task never reaches the hand-off: it opens like a Relay (David, 2026-09-13).
  assert.match(handoff, /if \(row\?\.relayNotificationKind === "task"\) \{\s*return \{ ok: false, error: "A Task opens like a Relay/);
  assert.equal(handoff.includes("taskKickPrompt("), false, "no kick prompt rides a hand-off");
  assert.equal(handoff.includes("taskStarted(id)"), false, "the pill never stamps Started; relay_task_start does");
  // The words are a turn, never a "Draft (not sent)" section of the letter.
  assert.match(handoff, /fs\.rmSync\(path\.join\(RELAY_HOME, "task-notes"/);
  assert.match(handoff, /const firstTurn = note;/);
  assert.match(handoff, /if \(firstTurn\) \{/, "an empty Send on a plain Relay is a plain open");
  // The route rides into the forge and into the turn.
  assert.match(main, /model: String\(selection\.model \|\| ""\),\s*effort: String\(selection\.effort \|\| ""\),/);
  assert.match(handoff, /host === "codex" && \/\^claude-\/i\.test\(requestedModel\)/);
  // Receipts: Started only after the words are in; the row carries the state.
  assert.match(handoff, /agentHandoffPatch\(id, \{ state: "running", error: "", deliveredAt: firstTurn \? stamped : "", imported: !claudeDeferred \}\)/);
  assert.match(handoff, /workStartedAt: stamped,[^]*workCompletedAt: firstTurn \? null : stamped/);
  assert.match(main, /agentHandoff: p\.agentHandoff && typeof p\.agentHandoff === "object" \? p\.agentHandoff : null,/);
  // Task completion still settles from the transcript the app writes.
  assert.match(handoff, /ensureCanonicalCompletionMonitor\(id\)[^]*ensurePlainHandoffCompletionMonitor\(id\)/);
  assert.match(handoff, /deferPresentation: Boolean\(firstTurn\)/, "the provider is not exposed before its user turn exists");
  assert.match(handoff, /const claudeDeferred = Boolean\(firstTurn && turnDelivery\?\.adapter === "acp"\)/);
  assert.match(handoff, /worker\?\.done\.then/);
  assert.match(delivery, /export async function waitForClaudeUserRow/);
  assert.match(delivery, /if \(row\?\.type !== "user" \|\| row\?\.isMeta\) continue;/, "the queue-operation echo of the prompt is not the user row");
  assert.match(docks, /const pending = !done && h\.imported === false;/);
  assert.match(docks, /opens there when the turn finishes/);
  assert.match(controls, /imported:res\.imported !== false, startedAt:new Date\(\)\.toISOString\(\), at:0 \}/, "the local bridge yields to main's receipt");
  assert.match(handoff, /routeId: id, imported: !claudeDeferred \}/);
  assert.match(main, /handoff\.imported === false && !deliveryRow\.row\?\.workCompletedAt[^]*shows this session as soon as the turn finishes/, "main refuses an early open too");
});

test("a failed hand-off keeps the words and offers the other app", () => {
  assert.match(handoff, /agentHandoffPatch\(id, \{ state: "failed", error: message, opened: false \}\)/);
  assert.match(handoff, /agentHandoffPatch\(id, \{ state: "failed", error: message, opened: true \}\)/);
  assert.match(handoff, /opened, but your message didn't go in/);
  // Claude runs in Relay's own worker, so its permission rides with the turn
  // and there is no Desktop session-cap probe any more.
  assert.match(handoff, /host === "claude" \? \{ permissionMode: permission \|\| "auto" \} : \{\}/);
  assert.equal(main.includes("claudeDesktopSessionCap"), false, "the governor probe is gone");
  assert.match(handoff, /previous\?\.state === "failed" && previous\.opened && bound && bound\.provider === host/, "a retry after the app opened delivers there again instead of forging a second session");
  assert.match(main, /async function stampHandoffFailed\(id\)/);
  assert.match(docks, /const draft = String\(requestWorkDrafts\.get\(String\(r\.id\)\) \|\| \(failed \? failed\.note \|\| "" : ""\)\);/, "the words come back into the composer");
  assert.match(docks, /data-handoff-other="\$\{esc\(r\.id\)\}" data-handoff-other-app="\$\{esc\(otherApp\)\}">\$\{esc\(otherApp\)\} instead<\/button>/);
  assert.match(controls, /setRoute\(id, \{ app, model:spec\.model, effort:spec\.effort \}\);\s*other\.closest\("\.ta-dock"\)\?\.querySelector\("\[data-handoff\]"\)\?\.click\(\);/);
  assert.match(controls, /else if \(note\) requestWorkDrafts\.set\(String\(id\), note\);/);
  // A pill that died mid-hand-off leaves no phantom "starting" behind.
  assert.match(main, /function reconcileStaleHandoffs\(\)/);
  assert.match(main, /if \(reconcileStaleHandoffs\(\)\) pushInbox\(false\);/);
  assert.match(main, /Relay restarted before your message reached \$\{appName\}\./);
  // A failed Task goes back to waiting; its status line defers to the card.
});

test("a Task reads as one page: the agent document folds into Details, not a second tab (bug 1)", () => {
  // Sven, 2026-09-11: a Task should read like an ordinary Relay — no
  // "Message for you / Message for your agent" tab split; the agent part is an
  // attachment-style Details section under the letter.
  assert.match(reader, /const twoFaces = false;/);
  // The Details block (closed until clicked) renders whenever there is agent
  // text, Task or not — it is gated only on !twoFaces, never on the row kind.
  assert.match(reader, /const details = !twoFaces && agentText \?/);
  // Start and the connect-an-agent prompt no longer hide behind the agent tab:
  // they render on the one page (Start via requestActionable, which is true for
  // a fresh "waiting" Task).
  // No Start dock, no connect-an-agent prompt, no status line: a Task gets the
  // plain reply dock and the same host rows as a Relay (David, 2026-09-13).
  for (const gone of ["requestDockHtml", "workProviderPromptHtml", "workProviderPromptDockHtml", "taskStatusLine", "requestActionable"]) {
    assert.equal(inbox.includes(gone), false, `${gone} survives in the pill`);
  }
  assert.match(reader, /const status = "";/);
  assert.match(reader, /const documentHostActions = onHuman \? `<div class="rd-host-actions"/, "the host rows show on a Task too");
  // Opening a Relay that already went to an app lands on its receipt.
  const open = between(inbox, "function openReader(", "function closeReader(");
  assert.match(open, /readerTab = !picker && openedHandoff && \["starting", "running", "failed"\]\.includes\(openedHandoff\.state\) \? "agent" : "you"/);
  // The Task board reads the receipt too.
  const state = between(inbox, "function taskBoardState", "function relayWorkState");
  assert.match(state, /if \(h\?\.state === "starting"\) return "running";/);
  assert.match(state, /if \(h\?\.state === "running"\) return "running";/);
  assert.match(state, /if \(h\?\.state === "failed"\) return "stopped";/);
});

test("a Task has no Start: it opens like a Relay from every surface", () => {
  // The two Start IPCs, the tray's Start verb and the preload bridge are gone;
  // the agent stamps Started / Done with relay_task_start / relay_task_complete.
  for (const gone of ['ipcMain.handle("relay:taskStart"', 'ipcMain.handle("relay:preview:startTask"']) {
    assert.equal(main.includes(gone), false, `${gone} survives in main`);
  }
  assert.equal(inbox.includes("data-task-start"), false, "the tray's Start verb is gone");
  assert.equal(preload.includes("relay:taskStart"), false, "the preload bridge is gone");
  // The row menu no longer forks on task: a Task gets the Relay menu.
  assert.equal(inbox.includes("A task's verbs are Preview and Start"), false);
});

test("new native hand-off turns use ACP and preserve route and session identity", async () => {
  const mod = await import("../src/session-delivery.js");
  for (const provider of ["claude", "codex"]) {
    const seen = [];
    const result = await mod.deliverTurnToSession({ provider, nativeId: "native-1", cwd: os.tmpdir() }, "testing", {
      discover: () => [], model: "test-model", effort: "high", permissionMode: "auto",
      startAcpRun: async input => { seen.push(input); return { sessionId: input.sessionId }; },
    });
    assert.equal(result.adapter, "acp");
    assert.equal(result.nativeId, "native-1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, "testing");
    assert.equal(seen[0].model, "test-model");
    assert.equal(seen[0].effort, "high");
    assert.ok(seen[0].mcpServers.some(server => server.name === "relay"));
  }
});

test("a hand-off moves the titled Relay to In Progress itself, with a note the person reads", () => {
  // The hand-off IS the start of the work (David, 2026-09-08).
  assert.match(handoff, /if \(firstTurn\) void markHandoffInProgress\(row, host\);/);
  const mark = between(main, "async function markHandoffInProgress(row, host)", "async function handOffToAgent(input)");
  assert.match(mark, /if \(\["in_progress", "done"\]\.includes\(String\(row\?\.todoStatus \|\| ""\)\)\) return/);
  assert.match(mark, /status: "in_progress",/);
  assert.match(mark, /note: `You handed this to \$\{app\}; it is working on it\.`/);
  // A stale local version is refreshed once through the packets endpoint, which now carries the Todo state.
  assert.match(mark, /const fresh = await client\.fetchRelayPackets\(\[id\]\);/);
  assert.match(mark, /const todo = fresh\?\.packets\?\.\[id\]\?\.todo;/);
  const update = between(main, "async function updateTodoStatus(relayId, input = {})", "const statusChanged =");
  assert.match(update, /\.\.\.\(String\(input\.note \|\| ""\)\.trim\(\) \? \{ note: String\(input\.note\)\.trim\(\) \} : \{\}\)/);
});
