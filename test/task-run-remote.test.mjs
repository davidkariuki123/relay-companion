import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOperation, TASK_RUN_OFF_MESSAGE, workspaceKey } from "../src/task-run-remote.js";
import { runSessionDirectoryOnce } from "../src/session-controller.js";

function harness({ enabled = true, providers = [{ provider: "claude", label: "Claude Code" }, { provider: "codex", label: "Codex", binary: "codex" }], result = { ok: true }, choices } = {}) {
  const evidence = [];
  const remembered = [];
  const calls = { choose: null, consent: 0 };
  const load = async () => ({
    executeNativeTask: async (args) => {
      calls.consentResult = await args.consent();
      const chosen = await args.choose(providers, { provider: "codex" });
      calls.choose = chosen;
      calls.args = args;
      return result;
    },
    launch: {
      executionEnabled: () => enabled,
      setExecutionPreferences: (_config, patch) => remembered.push(patch),
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
  return { evidence, remembered, calls, load, recordEvidence, client };
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

test("a Claude draft waiting for Send says so instead of claiming the Task started", async () => {
  const h = harness({ result: { ok: true, awaitingSend: true } });
  await runTaskOperation(h.client, operation(), "tok", { load: h.load, recordEvidence: h.recordEvidence, config: {} });
  assert.equal(h.evidence[0].result.output.waiting, true);
  assert.match(h.evidence[0].result.output.message, /press Send there/);
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
