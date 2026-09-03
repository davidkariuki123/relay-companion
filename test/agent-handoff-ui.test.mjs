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
const controls = between(inbox, "function wireRequestControls", "// Todo's amber number is narrowly Triage");
const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board");

test("Send on the agent document is a hand-off: one verb, one IPC, no runner", () => {
  // The agent face's composer is the shared route-selecting capsule with Send
  // as its verb, and Start on a Task is the same capsule with a Task verb.
  assert.match(docks, /function relayWorkDockHtml\(r, \{ inline = false \} = \{\}\)/);
  assert.match(docks, /return idleRunDockHtml\(r, \{ inline, draft, failed, label: failed \? "Retry" : "Send" \}\);/);
  assert.match(docks, /label: failed \? "Retry" : state === "stopped" \? "Start again" : "Start task"/);
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
  // The card: starting breathes the app's mark; running is a button that
  // opens the exact session; the words stay above it as the one bubble.
  assert.match(docks, /Starting a session in \$\{esc\(app\)\}…/);
  assert.match(docks, /`Running in \$\{esc\(app\)\}`/);
  assert.match(docks, /`Finished in \$\{esc\(app\)\}`/);
  assert.match(docks, /<button type="button" class="ho-card \$\{provider\}\$\{done \? " done" : ""\}" data-handoff-open="\$\{esc\(r\.id\)\}">/);
  assert.match(docks, /\$\{esc\(app\)\} replies there, not here/);
  assert.match(docks, /function handoffBubbleHtml\(h\)/);
  assert.match(inbox, /\.ho-card\.starting \.ho-logo \{ animation:hostOpenBreathe/);
  assert.match(controls, /window\.relay\.continueSession\(id, row\.outbound \? "sent" : "relay"\)/, "Open preserves the durable inbound/sent route key");
  assert.match(preload, /continueSession: \(id, source\) => ipcRenderer\.invoke\("relay:continueSession"/);
});

test("the hand-off orders its steps: sign-in, open, first turn, then Started", () => {
  const authAt = handoff.indexOf("assertProviderReady(host)");
  const openAt = handoff.indexOf("deliverPacketToSession(requestedId, {");
  const turnAt = handoff.indexOf("deliverTurnToSession(binding, firstTurn");
  const stampAt = handoff.indexOf("taskStarted(id)");
  assert.ok(authAt > -1 && openAt > authAt && turnAt > openAt && stampAt > turnAt, "sign-in, open, first turn, Started stay ordered");
  // The words are a turn, never a "Draft (not sent)" section of the letter.
  assert.match(handoff, /fs\.rmSync\(path\.join\(RELAY_HOME, "task-notes"/);
  assert.match(handoff, /const firstTurn = isRequest \? taskKickPrompt\(\{ note \}\) : note;/);
  assert.match(handoff, /if \(firstTurn\) \{/, "an empty Send on a plain Relay is a plain open");
  // The route rides into the forge and into the turn.
  assert.match(main, /model: String\(selection\.model \|\| ""\),\s*effort: String\(selection\.effort \|\| ""\),/);
  assert.match(handoff, /host === "codex" && \/\^claude-\/i\.test\(requestedModel\)/);
  // Receipts: Started only after the words are in; the row carries the state.
  assert.match(handoff, /agentHandoffPatch\(id, \{ state: "running", error: "", deliveredAt: firstTurn \? stamped : "" \}\)/);
  assert.match(handoff, /isRequest\s*\? \{[^]*taskState: "started",[^]*taskStartedAt: startedReceipt\?\.startedAt \|\| stamped,/);
  assert.match(handoff, /workStartedAt: stamped,[^]*workCompletedAt: firstTurn \? null : stamped/);
  assert.match(main, /agentHandoff: p\.agentHandoff && typeof p\.agentHandoff === "object" \? p\.agentHandoff : null,/);
  // Task completion still settles from the transcript the app writes.
  assert.match(handoff, /ensureCanonicalCompletionMonitor\(id\)[^]*ensurePlainHandoffCompletionMonitor\(id\)/);
  assert.match(handoff, /deferPresentation: Boolean\(firstTurn\)/, "the provider is not exposed before its user turn exists");
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
  assert.match(main, /async function stampHandoffFailed\(id, isRequest, host\)/);
  assert.match(docks, /const draft = String\(requestWorkDrafts\.get\(String\(r\.id\)\) \|\| \(failed \? failed\.note \|\| "" : ""\)\);/, "the words come back into the composer");
  assert.match(docks, /data-handoff-other="\$\{esc\(r\.id\)\}" data-handoff-other-app="\$\{esc\(otherApp\)\}">\$\{esc\(otherApp\)\} instead<\/button>/);
  assert.match(controls, /setRoute\(id, \{ app, model:spec\.model, effort:spec\.effort \}\);\s*other\.closest\("\.ta-dock"\)\?\.querySelector\("\[data-handoff\]"\)\?\.click\(\);/);
  assert.match(controls, /else if \(note\) requestWorkDrafts\.set\(String\(id\), note\);/);
  // A pill that died mid-hand-off leaves no phantom "starting" behind.
  assert.match(main, /function reconcileStaleHandoffs\(\)/);
  assert.match(main, /if \(reconcileStaleHandoffs\(\)\) pushInbox\(false\);/);
  assert.match(main, /Relay restarted before your message reached \$\{appName\}\./);
  // A failed Task goes back to waiting; its status line defers to the card.
  assert.match(inbox, /if \(handoffFor\(r\)\?\.state === "failed"\) return "";/);
});

test("the reader keeps two faces; the agent row whispers where the Relay went", () => {
  assert.match(reader, /if \(readerTab === "work"\) readerTab = "agent";/);
  assert.doesNotMatch(reader, /relay-contents-name">Work</);
  assert.match(reader, /`in \$\{handoffAppName\(handoff\)\} ›`/);
  assert.match(reader, /`opening \$\{handoffAppName\(handoff\)\}…`/);
  // Host rows live on Message for you only; the agent face's rail names the app.
  assert.match(reader, /const documentHostActions = !request && onHuman \?/);
  assert.match(reader, /const bothNote = onAgent && workOn && !handoff \?/);
  assert.match(reader, /if \(onAgent\) return relayWorkDockHtml\(r, \{ inline: true \}\);/);
  // Opening a Relay that already went to an app lands on its receipt.
  const open = between(inbox, "function openReader", "function closeReader");
  assert.match(open, /readerTab = openedHandoff && \["starting", "running", "failed"\]\.includes\(openedHandoff\.state\) \? "agent" : "you"/);
  // The Task board reads the receipt too.
  const state = between(inbox, "function taskBoardState", "function relayWorkState");
  assert.match(state, /if \(h\?\.state === "starting"\) return "running";/);
  assert.match(state, /if \(h\?\.state === "running"\) return "running";/);
  assert.match(state, /if \(h\?\.state === "failed"\) return "stopped";/);
});

test("Start on a Task is the same hand-off, from the pill and the preview window", () => {
  const taskIpc = between(main, 'ipcMain.handle("relay:taskStart"', 'ipcMain.handle("relay:taskClaim"');
  assert.match(taskIpc, /handOffToAgent\(\{/);
  const previewIpc = between(main, 'ipcMain.handle("relay:preview:startTask"', "});");
  assert.match(previewIpc, /return handOffToAgent\(input\);/);
  const kick = between(main, "function taskKickPrompt", "// Matches src/materializer.js");
  assert.match(kick, /note \|\| "Begin the task as briefed\."/);
  assert.match(inbox, /data-task-start="\$\{esc\(id\)\}"/);
});

test("the first turn runs in Relay's own worker for Claude and Desktop's submit for Codex", async () => {
  const turn = between(delivery, "export async function deliverTurnToSession", "throw new Error(`Unsupported provider");
  // Claude: Relay's own governor-free CLI worker (never Desktop's warm slot).
  assert.match(turn, /continueClaudeDesktopCodeSession/);
  assert.match(turn, /adapter: "claude_desktop_code_worker"/);
  assert.doesNotMatch(turn, /messagingSocketPath/, "Claude delivery no longer depends on Desktop's inbox socket");
  // Codex: Desktop's own submit, with the route forwarded.
  assert.match(turn, /return deliverCodex\(\{ \.\.\.exact, surface: "desktop" \}, prompt, \{/);
  assert.match(delivery, /\.\.\.\(options\.model \? \{ model: options\.model \} : \{\}\),/, "the hand-off's route reaches Desktop's submit");

  const mod = await import("../src/session-delivery.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handoff-"));
  try {
    // Claude: the words run in Relay's own resume worker, carrying the route.
    const claudeSeen = [];
    const claudePath = path.join(dir, "claude.jsonl");
    fs.writeFileSync(claudePath, "");
    const claudeResult = await mod.deliverTurnToSession({ provider: "claude", nativeId: "abc", title: "Exact title" }, "testing", {
      discover: () => [{ provider: "claude", nativeId: "abc", cwd: dir, title: "Relay", state: "idle", nativeRef: { transcriptPath: claudePath } }],
      continueClaude: async (input) => {
        claudeSeen.push(input);
        fs.appendFileSync(claudePath, `${JSON.stringify({ type:"user", message:{ role:"user", content:input.content } })}\n`);
        return { sessionId: input.sessionId, resumed: true, live: true, sessionPath:claudePath };
      },
      model: "claude-opus-5",
      effort: "high",
      permissionMode: "acceptEdits",
    });
    assert.equal(claudeResult.adapter, "claude_desktop_code_worker");
    assert.equal(claudeSeen.length, 1);
    assert.equal(claudeSeen[0].sessionId, "abc");
    assert.equal(claudeSeen[0].content, "testing");
    assert.equal(claudeSeen[0].title, "Exact title");
    assert.equal(claudeSeen[0].model, "claude-opus-5");
    assert.equal(claudeSeen[0].permissionMode, "acceptEdits");

    // Codex: Desktop's own submit, with the route forwarded.
    const seen = [];
    const codexPath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(codexPath, "");
    const codexResult = await mod.deliverTurnToSession({ provider: "codex", nativeId: "thread-1" }, "testing", {
      discover: () => [{ provider: "codex", nativeId: "thread-1", cwd: dir, state: "idle", nativeRef: { sessionPath: codexPath } }],
      waitForCodexIdle: async () => ({ idle: true }),
      submitCodex: async (input) => { seen.push(input); return { ran: true, submitted: true, clientUserMessageId: input.clientUserMessageId }; },
      model: "gpt-5.6-sol",
      effort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.equal(codexResult.adapter, "codex_desktop_owner");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, "testing");
    assert.equal(seen[0].model, "gpt-5.6-sol");
    assert.equal(seen[0].approvalPolicy, "never");
    assert.deepEqual(seen[0].sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
