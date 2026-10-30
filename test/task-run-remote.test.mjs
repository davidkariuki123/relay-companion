import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOperation, TASK_RUN_OFF_MESSAGE, CLAUDE_UNTRUSTED_MESSAGE, REMOTE_APP_WAIT_MS, workspaceKey } from "../src/task-run-remote.js";
import { runSessionDirectoryOnce } from "../src/session-controller.js";

function harness({ enabled = true, providers = [{ provider: "claude", label: "Claude Code" }, { provider: "codex", label: "Codex", binary: "codex" }], result = { ok: true }, choices,
  remoteControl = false, trusted = true, phase = "prepared", observe = async () => ({ ok: true, waiting: true }), turnStarted = false,
  retire = { retired: true }, owner = "native_gui" } = {}) {
  const evidence = [];
  const remembered = [];
  const calls = { choose: null, consent: 0, background: [], observed: 0, stoppedWaiting: 0 };
  const state = { phase };
  const load = async () => ({
    executeNativeTask: async (args) => {
      if (args.observeOnly) { calls.observed += 1; return observe(state, calls.observed); }
      calls.consentResult = await args.consent();
      calls.args = args;
      const chosen = await args.choose(providers, { provider: "codex" });
      calls.choose = chosen;
      if (typeof result === "function") return result(state);
      return result;
    },
    executionRecord: () => ({ phase: state.phase, session: { provider: "claude", nativeId: "native_gui" }, messageId: "msg_1", taskRunOwner: { provider: "claude", nativeSessionId: owner } }),
    markMovedToBackground: () => { calls.moved = (calls.moved || 0) + 1; },
    stopWaitingForNativeApp: () => { calls.stoppedWaiting += 1; if (state.phase === "awaiting_app") state.phase = "prepared"; return { ok: true }; },
    remoteExecutionPrompt: (packet, id, session) => `background prompt for ${id} in ${session.cwd}`,
    startHeadlessTaskRun: async (input) => { calls.background.push(input); return { nativeId: "native_1" }; },
    launch: {
      executionEnabled: () => enabled,
      setExecutionPreferences: (_config, patch) => remembered.push(patch),
      claudeLaunchPreflight: async () => ({ remoteControlDefault: remoteControl }),
      claudeWorkspaceTrusted: () => trusted,
      nativeTurnStarted: async () => turnStarted,
      retireUnstartedClaudeConversation: async (session, options) => { calls.retired = { session, options }; return retire; },
    },
    workspace: {
      workspaceChoices: choices || (({ providers: offered }) => ({
        auto: { provider: offered[0].provider, cwd: "C:/work/relay" },
        suggested: null,
        options: [],
      })),
      rememberWorkspaceChoice: (_preferences, chosen) => ({ provider: chosen.provider, cwd: chosen.cwd }),
      workspaceName: (cwd) => cwd.split("/").pop(),
    },
  });
  const recordEvidence = async (_client, id, token, state, result = {}, error) => { evidence.push({ id, token, state, result, error }); };
  const client = { fetchRelay: async () => ({ packet: { id: "relay_task", title: "Fix it", sender: { name: "David Kariuki" } } }) };
  return { evidence, remembered, calls, load, recordEvidence, client, state };
}
// A clock the wait loop moves forward one poll at a time.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const operation = (input = {}) => ({ id: "sop_1", kind: "start", input: { provider: "claude", taskRelayId: "relay_task", ...input } });

test("only a start operation that names a Task is a remote Task run", async () => {
  const h = harness();
  assert.equal(await runTaskOperation(h.client, { id: "sop_x", kind: "start", input: { relayMessageId: "relay_1" } }, "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} }), false);
  assert.equal(await runTaskOperation(h.client, { id: "sop_x", kind: "send", input: { taskRelayId: "relay_1" } }, "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} }), false);
  assert.deepEqual(h.evidence, []);
});

test("a remote Task run takes the Execute path in the folder Execute would use without asking, and never asks for consent", async () => {
  const h = harness();
  assert.equal(await runTaskOperation(h.client, operation(), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} }), true);
  assert.equal(h.calls.consentResult, false, "nobody is at this computer to consent");
  assert.deepEqual(h.calls.choose, { provider: "claude", cwd: "C:/work/relay" }, "with no app chosen, the computer's order decides");
  assert.equal(h.calls.args.id, "relay_task");
  assert.equal(await h.calls.args.confirmDraftRetry(), false);
  assert.deepEqual(h.remembered, [{ provider: "claude", cwd: "C:/work/relay" }], "the choice is remembered as an Execute choice");
  assert.equal(h.evidence.length, 1);
  assert.equal(h.evidence[0].state, "completed");
  assert.equal(h.evidence[0].result.output.message, "Started in Claude Code in relay.");
});

test("an app the person picked on the phone is the app that runs it", async () => {
  const h = harness();
  await runTaskOperation(h.client, operation({ provider: "codex", taskAppChosen: true }), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} });
  assert.equal(h.calls.choose.provider, "codex");
  assert.equal(h.evidence[0].result.output.message, "Started in Codex in relay.");
});

test("a remote run reports why it could not start", async () => {
  const off = harness({ enabled: false });
  await runTaskOperation(off.client, operation(), "tok", { load: off.load, recordEvidence: off.recordEvidence, config: {} });
  assert.deepEqual(off.evidence.map((entry) => [entry.state, entry.error]), [["failed", TASK_RUN_OFF_MESSAGE]]);

  const missing = harness({ providers: [{ provider: "claude", label: "Claude Code" }] });
  await runTaskOperation(missing.client, operation({ provider: "codex", taskAppChosen: true }), "tok", { load: missing.load, recordEvidence: missing.recordEvidence, config: {} });
  assert.equal(missing.evidence[0].state, "failed");
  assert.match(missing.evidence[0].error, /Codex is not installed/);

  const nowhere = harness({ choices: () => ({ auto: null, suggested: null, options: [] }) });
  await runTaskOperation(nowhere.client, operation(), "tok", { load: nowhere.load, recordEvidence: nowhere.recordEvidence, config: {} });
  assert.equal(nowhere.evidence[0].state, "failed");
  assert.match(nowhere.evidence[0].error, /no folder to offer for this Task/);
});

// Where Execute would ask on this computer, the phone is asked instead.
const offer = ({ providers: offered }) => ({
  auto: null,
  suggested: null,
  options: offered.flatMap((app) => [
    { provider: app.provider, cwd: "C:/work/relay", name: "relay", why: "Last used for David's Tasks" },
    { provider: app.provider, cwd: "C:/work/site", name: "site", why: "" },
  ]),
});

test("a Task that does not settle the folder runs nothing and offers Execute's list, without paths", async () => {
  const h = harness({ choices: offer });
  await runTaskOperation(h.client, operation(), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} });
  assert.equal(h.calls.choose, null, "nothing was chosen, so nothing ran");
  assert.deepEqual(h.remembered, []);
  assert.equal(h.evidence.length, 1);
  assert.equal(h.evidence[0].state, "completed");
  const output = h.evidence[0].result.output;
  assert.equal(output.needsFolder, true);
  assert.deepEqual(output.options.map((option) => [option.provider, option.app, option.name]), [
    ["claude", "Claude Code", "relay"], ["claude", "Claude Code", "site"], ["codex", "Codex", "relay"], ["codex", "Codex", "site"],
  ]);
  assert.equal(output.options[0].why, "Last used for David's Tasks");
  assert.match(output.options[0].key, /^[a-f0-9]{24}$/);
  assert.equal(new Set(output.options.map((option) => option.key)).size, 4, "each app-and-folder pair has its own key");
  assert.equal(JSON.stringify(output).includes("C:/work"), false, "no path leaves this computer");
});

test("the folder picked on the phone runs the Task, and only if this computer still offers it", async () => {
  const key = workspaceKey({ provider: "codex", cwd: "C:/work/site" });
  const h = harness({ choices: offer });
  await runTaskOperation(h.client, operation({ provider: "codex", taskAppChosen: true, taskWorkspaceKey: key }), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} });
  assert.deepEqual(h.calls.choose, { provider: "codex", cwd: "C:/work/site" });
  assert.deepEqual(h.remembered, [{ provider: "codex", cwd: "C:/work/site" }]);
  assert.equal(h.evidence[0].result.output.message, "Started in Codex in site.");

  const stale = harness({ choices: offer });
  await runTaskOperation(stale.client, operation({ taskWorkspaceKey: workspaceKey({ provider: "claude", cwd: "C:/elsewhere" }) }), "tok", { load: stale.load, recordEvidence: stale.recordEvidence, config: {} });
  assert.equal(stale.calls.choose, null, "a pick that is not on offer runs nothing");
  assert.equal(stale.evidence[0].result.output.needsFolder, true, "and the phone is asked again");

  const settled = harness();
  await runTaskOperation(settled.client, operation({ taskWorkspaceKey: workspaceKey({ provider: "claude", cwd: "C:/elsewhere" }) }), "tok", { load: settled.load, recordEvidence: settled.recordEvidence, config: {} });
  assert.equal(settled.calls.choose, null, "a key is never swapped for the folder Execute would use");
  assert.equal(settled.evidence[0].state, "failed");
});

const run = (h, input, extra = {}) => runTaskOperation(h.client, operation(input), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {}, ...extra });

test("a remote run never leaves the Task in Claude's message box for someone to send", async () => {
  const h = harness();
  await run(h);
  assert.equal(h.calls.args.nativeApi.prepareClaudeDraft, undefined);
  assert.equal(h.calls.args.nativeApi.prepareClaudeTaskLink, undefined);
});

test("Claude with Remote Control on for all sessions runs in the background at once, in the chosen folder", async () => {
  const h = harness({ remoteControl: true });
  await run(h);
  assert.equal(h.calls.choose, null, "the app was never opened");
  assert.equal(h.calls.background.length, 1);
  assert.deepEqual([h.calls.background[0].provider, h.calls.background[0].cwd, h.calls.background[0].taskId], ["claude", "C:/work/relay", "relay_task"]);
  assert.equal(h.calls.background[0].prompt, "background prompt for relay_task in C:/work/relay");
  const output = h.evidence[0].result.output;
  assert.equal(h.evidence[0].state, "completed");
  assert.equal(output.background, true);
  assert.equal(output.waiting, false);
  assert.match(output.message, /Remote Control is on for all sessions, so it is running in the background in relay\. Claude Code will have the conversation when it finishes\./);
});

test("Remote Control decides nothing for Codex", async () => {
  const h = harness({ remoteControl: true });
  await run(h, { provider: "codex", taskAppChosen: true });
  assert.equal(h.calls.background.length, 0);
  assert.equal(h.evidence[0].result.output.message, "Started in Codex in relay.");
});

test("a background run never steps around Claude's folder trust", async () => {
  const h = harness({ remoteControl: true, trusted: false });
  await run(h);
  assert.equal(h.calls.background.length, 0);
  assert.deepEqual(h.evidence.map((entry) => [entry.state, entry.error]), [["failed", CLAUDE_UNTRUSTED_MESSAGE]]);
});

test("an app that fails before the Task reached it hands the Task to a background run", async () => {
  const h = harness({ result: () => { throw Object.assign(new Error("Claude has not made this conversation ready"), { code: "CLAUDE_NOT_READY" }); } });
  await run(h);
  assert.equal(h.calls.background.length, 1);
  assert.match(h.evidence[0].result.output.message, /^Claude Code did not start it in time, so it is running in the background in relay\./);
});

test("a Task that may already be in an app conversation, or was started elsewhere, is never run twice", async () => {
  const unacknowledged = (state) => { state.phase = "uncertain"; throw new Error("Claude did not acknowledge the launch."); };
  const sent = harness({ result: unacknowledged, retire: {} });
  await run(sent);
  assert.equal(sent.calls.background.length, 0, "Claude's process would not stop, so the Task stays there");
  assert.deepEqual(sent.evidence.map((entry) => [entry.state, entry.error]), [["failed", "Claude did not acknowledge the launch."]]);

  const taken = harness({ result: unacknowledged });
  await run(taken);
  assert.equal(taken.calls.background.length, 1, "taken back from Claude's conversation, it runs in the background");
  assert.equal(taken.calls.background[0].reserve, false);

  const codex = harness({ result: (state) => { state.phase = "uncertain"; throw new Error("Codex did not confirm the launch."); } });
  await run(codex, { provider: "codex", taskAppChosen: true });
  assert.equal(codex.calls.retired, undefined);
  assert.equal(codex.calls.background.length, 0, "a Task that may have reached Codex is never run again");

  const foreign = harness({ result: unacknowledged, owner: "someone_else" });
  await run(foreign);
  assert.equal(foreign.calls.retired, undefined, "a Task reserved for another conversation is never taken back");
  assert.equal(foreign.calls.background.length, 0);

  const elsewhere = harness({ result: () => { throw Object.assign(new Error("started"), { status: 409 }); } });
  await run(elsewhere);
  assert.equal(elsewhere.calls.background.length, 0);
  assert.equal(elsewhere.evidence[0].state, "failed");

  const notChosen = harness({ providers: [{ provider: "claude", label: "Claude Code" }] });
  await run(notChosen, { provider: "codex", taskAppChosen: true });
  assert.equal(notChosen.calls.background.length, 0, "nothing runs in an app that was never chosen");
});

test("Codex still opening gets the late launch Execute's watch makes, within the wait", async () => {
  const h = harness({ phase: "awaiting_app", result: { ok: true, waiting: true },
    observe: async (state, attempt) => { if (attempt < 3) return { ok: true, waiting: true }; state.phase = "accepted"; return { ok: true, message: "Task launched in Codex." }; } });
  await run(h, { provider: "codex", taskAppChosen: true }, clock());
  assert.equal(h.calls.observed, 3);
  assert.equal(h.calls.background.length, 0);
  assert.equal(h.evidence[0].result.output.message, "Started in Codex in relay.");
});

test("Codex that does not start in time stops waiting, then the Task runs in the background", async () => {
  const time = clock();
  const h = harness({ phase: "awaiting_app", result: { ok: true, waiting: true } });
  await run(h, { provider: "codex", taskAppChosen: true }, time);
  assert.ok(time.now() >= REMOTE_APP_WAIT_MS);
  assert.equal(h.calls.stoppedWaiting, 1, "the app conversation no longer takes the Task late");
  assert.equal(h.calls.background.length, 1);
  assert.equal(h.calls.background[0].provider, "codex");
  assert.match(h.evidence[0].result.output.message, /^Codex did not start it in time, so it is running in the background in relay\. Codex will have/);
});

test("a Task Claude holds without starting is taken back from that conversation and run in the background", async () => {
  const idle = harness({ phase: "accepted", result: { ok: true, deliveredIdle: true } });
  await run(idle);
  assert.deepEqual(idle.calls.retired, { session: { provider: "claude", nativeId: "native_gui" }, options: { messageId: "msg_1" } });
  assert.equal(idle.calls.background.length, 1);
  assert.equal(idle.calls.background[0].reserve, false, "the Task is already reserved for this computer's own conversation");
  assert.equal(idle.calls.moved, 1, "Execute here no longer sends it to that conversation");
  assert.equal(idle.evidence[0].result.output.background, true);
  assert.match(idle.evidence[0].result.output.message, /^Claude Code received it but did not start it, so it is running in the background in relay\./);

  const late = harness({ phase: "accepted", result: { ok: true, deliveredIdle: true }, turnStarted: true });
  await run(late);
  assert.equal(late.calls.retired, undefined);
  assert.equal(late.evidence[0].result.output.message, "Started in Claude Code in relay.");

  const answered = harness({ phase: "accepted", result: { ok: true, deliveredIdle: true }, retire: { started: true } });
  await run(answered);
  assert.equal(answered.calls.background.length, 0, "the model answered while Relay stopped it");
  assert.equal(answered.evidence[0].result.output.message, "Started in Claude Code in relay.");

  const stuck = harness({ phase: "accepted", result: { ok: true, deliveredIdle: true }, retire: {} });
  await run(stuck);
  assert.equal(stuck.calls.background.length, 0);
  assert.equal(stuck.evidence[0].result.output.waiting, true);
  assert.match(stuck.evidence[0].result.output.message, /Relay could not take it back/);
});

test("Execute on this computer never runs a Task in the background", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/native-task-execute.js", import.meta.url), "utf8");
  assert.equal(/task-run-headless|startAcpRun|startHeadlessTaskRun/.test(source), false);
});

test("with device execution off, a queued Task run is refused at once with the reason", async () => {
  const recorded = [];
  const client = {
    sessionControllerInbox: async () => ({ operations: [operation()] }),
    claimSessionOperation: async (id) => ({ operation: { id }, claimToken: "tok" }),
    recordSessionOperationEvidence: async (id, body) => { recorded.push({ id, ...body }); return {}; },
    publishSessionObservations: async () => ({ sessions: [] }),
  };
  await runSessionDirectoryOnce({ client, discover: async () => [], controller: () => ({}), executionAllowed: () => false });
  assert.deepEqual(recorded.map((entry) => [entry.id, entry.state, entry.error]), [["sop_1", "failed", TASK_RUN_OFF_MESSAGE]]);
});

test("in tasks-only mode the controller ignores other operations and does not scan sessions", async () => {
  let scanned = false;
  let published = null;
  const claimed = [];
  const client = {
    sessionControllerInbox: async () => ({ operations: [{ id: "sop_agent", kind: "start", input: { agentRunRelayId: "relay_run" } }] }),
    claimSessionOperation: async (id) => { claimed.push(id); return { terminal: true }; },
    publishSessionObservations: async (observations) => { published = observations; return { sessions: [] }; },
  };
  await runSessionDirectoryOnce({ client, discover: async () => { scanned = true; return [{}]; }, controller: () => ({}), executionAllowed: () => true, tasksOnly: true });
  assert.equal(scanned, false);
  assert.deepEqual(published, []);
  assert.deepEqual(claimed, []);
});
