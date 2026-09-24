import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeNativeTask, executionRecord, pendingNativeDrafts, nativeExecutionStatus } from "../src/native-task-execute.js";
import { prepareClaudeDraft } from "../src/claude-task-fallback.js";
import { claudeWorkspaceTrusted, executionEnabled, executionPreferences, setExecutionPreferences, nativeProgress, nativeSessionReady, selectCodexModel, submitNativeTurn } from "../src/native-task-launch.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-test-"));
  const previous = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.RELAY_CONFIG_DIR; else process.env.RELAY_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [], config = { apiUrl: "https://dev-api.example.test", user: { id: "user-test", accountKind: "human", isDeveloper: true } };
  let optedIn = false;
  const session = { provider: "claude", cwd: root, nativeId: "dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16", url: "claude://resume?session=dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16" };
  const args = {
    id: "relay-test", config, env: { RELAY_ENV: "dev" },
    client: {
      async taskExecute(_id, input) { calls.push(input ? "reserve" : "gate"); return { taskRunOwner: { provider: session.provider, nativeSessionId: session.nativeId }, startedAt: new Date().toISOString() }; },
      async fetchRelay() { calls.push("fetch"); return { packet: { title: "Test", forHuman: "Do the authorized task.", forAgent: "Context." } }; },
    },
    consent: async () => { calls.push("consent"); return true; },
    choose: async () => ({ provider: "claude", cwd: root }),
    open: async () => { calls.push("open"); },
    nativeApi: {
      executionEnabled: () => optedIn,
      setExecutionPreferences: (_config, patch) => { if (patch.enabled !== undefined) optedIn = patch.enabled; },
      executionPreferences: () => ({}),
      nativeProviders: () => [{ provider: "claude" }],
      prepareNativeSession: async ({ persist }) => { calls.push("prepare"); persist(session); return session; },
      nativeSessionReady: async () => { calls.push("ready"); return {}; },
      submitNativeTurn: async () => { calls.push("submit"); },
    },
  };
  return { root, config, args, calls, session };
}

function draftFixture(t) {
  const f = fixture(t);
  let bound = null;
  Object.assign(f.args.nativeApi, {
    claudeLaunchPreflight: async () => ({ manual: true, reason: "capacity" }),
    claudeWorkspaceTrusted: () => true,
    prepareClaudeDraft,
    findClaudeDraftSession: () => bound,
  });
  return { ...f, bind: () => { bound = { ...executionRecord(f.config, f.args.id).session, ...f.session, fromDraft: true }; } };
}

test("capacity opens one draft without claiming or submitting; after Send, observer claims exact owner and submits once", async (t) => {
  const f = draftFixture(t), { args, calls, config } = f;
  const result = await executeNativeTask(args);
  assert.equal(result.awaitingSend, true);
  assert.deepEqual(calls, ["gate", "consent", "fetch", "open"]);
  assert.equal(executionRecord(config, args.id).startedAt, undefined);
  assert.match(nativeExecutionStatus(executionRecord(config, args.id)), /press Send/);
  assert.deepEqual(pendingNativeDrafts(config), [args.id]);
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, ["gate", "consent", "fetch", "open"], "waiting makes no network or native calls");
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "open").length, 1, "repeat click cannot duplicate draft without confirmation");
  f.bind();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, ["gate", "ready", "reserve", "fetch", "submit"]);
  assert.equal(executionRecord(config, args.id).phase, "accepted");
  assert.deepEqual(pendingNativeDrafts(config), []);
  await executeNativeTask({ ...args, observeOnly: true });
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("a closed draft can be explicitly replaced; old token is retired, no Task work has started", async (t) => {
  const { args, config, calls } = draftFixture(t);
  await executeNativeTask(args);
  const previous = executionRecord(config, args.id).session.draftId;
  await executeNativeTask({ ...args, confirmDraftRetry: async () => true });
  assert.notEqual(executionRecord(config, args.id).session.draftId, previous);
  assert.equal(calls.filter((c) => c === "open").length, 2);
  assert.equal(calls.includes("reserve"), false);
});

test("full Task content is delivered only after binding; the link never truncates a large Task", async (t) => {
  const f = draftFixture(t), { args, config } = f;
  const context = "long task context ".repeat(3000);
  args.client.fetchRelay = async () => ({ packet: { title: "Large task", forAgent: context, attachments: [{ id: "file-test" }] } });
  let delivered;
  args.nativeApi.submitNativeTurn = async (_session, _ready, prompt) => { delivered = prompt; };
  await executeNativeTask(args);
  const draft = executionRecord(config, args.id).session;
  assert.ok(draft.url.length < 2000);
  assert.equal(draft.url.includes("long+task"), false);
  assert.equal(delivered, undefined);
  f.bind();
  await executeNativeTask({ ...args, observeOnly: true });
  assert.ok(delivered.includes(context));
  assert.ok(delivered.includes('"id":"file-test"'));
});

test("unknown open acknowledgement is watched after restart and is never blindly reopened", async (t) => {
  const f = draftFixture(t);
  await assert.rejects(executeNativeTask({ ...f.args, open: async () => { throw new Error("lost open acknowledgement"); } }), /lost open/);
  assert.equal(executionRecord(f.config, f.args.id).phase, "draft_opening");
  f.bind();
  await executeNativeTask({ ...f.args, observeOnly: true });
  assert.equal(f.calls.filter((c) => c === "submit").length, 1);
});

test("draft waits through slow inbox startup; disabling during startup prevents even a reservation", async (t) => {
  const f = draftFixture(t), { args, calls, config } = f;
  await executeNativeTask(args);
  f.bind();
  args.nativeApi.nativeSessionReady = async () => { throw Object.assign(new Error("warming"), { code: "CLAUDE_NOT_READY" }); };
  assert.equal((await executeNativeTask({ ...args, observeOnly: true })).waiting, true);
  assert.deepEqual(pendingNativeDrafts(config), [args.id]);
  assert.equal(calls.includes("reserve"), false);
  args.nativeApi.nativeSessionReady = async () => { args.nativeApi.setExecutionPreferences(config, { enabled: false }); return {}; };
  await assert.rejects(executeNativeTask({ ...args, observeOnly: true }), /disabled/);
  assert.equal(calls.includes("reserve"), false);
});

test("a chosen untrusted folder goes through native folder confirmation instead of an import error", async (t) => {
  const { args, calls } = draftFixture(t);
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: false, reason: "headroom" });
  args.nativeApi.claudeWorkspaceTrusted = () => false;
  assert.equal((await executeNativeTask(args)).awaitingSend, true);
  assert.equal(calls.includes("prepare"), false);
  assert.equal(calls.includes("reserve"), false);
});

test("an earlier unsent prepared conversation is preflighted before reopening", async (t) => {
  const { args, calls } = draftFixture(t);
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: false });
  args.nativeApi.nativeSessionReady = async () => { throw new Error("old-version failure"); };
  await assert.rejects(executeNativeTask(args), /old-version failure/);
  calls.length = 0;
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: true, reason: "capacity" });
  assert.equal((await executeNativeTask(args)).awaitingSend, true);
  assert.deepEqual(calls, ["gate", "open"]);
});

test("readiness timeout offers a draft, but submission ambiguity never does", async (t) => {
  const { args, calls, config } = draftFixture(t);
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: false });
  args.nativeApi.nativeSessionReady = async () => { throw Object.assign(new Error("not ready"), { code: "CLAUDE_NOT_READY" }); };
  assert.equal((await executeNativeTask(args)).awaitingSend, true);
  assert.equal(calls.includes("reserve"), false);
  assert.equal(executionRecord(config, args.id).session.unusedPreparedNativeId, "dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16");
});

test("draft observer stops on changed account, revoked consent, different owner and ambiguous delivery", async (t) => {
  const f = draftFixture(t), { args, calls, config } = f;
  await executeNativeTask(args);
  f.bind();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true, isCurrentAccount: () => false });
  assert.deepEqual(calls, []);
  args.nativeApi.setExecutionPreferences(config, { enabled: false });
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, []);
  args.nativeApi.setExecutionPreferences(config, { enabled: true });
  const normalReserve = args.client.taskExecute;
  args.client.taskExecute = async (_id, input) => input ? { taskRunOwner: { nativeSessionId: "other", provider: "claude" } } : {};
  await assert.rejects(executeNativeTask({ ...args, observeOnly: true }), /another conversation/);
  assert.equal(calls.includes("submit"), false);
  assert.deepEqual(pendingNativeDrafts(config), [], "failed ownership is not retried in background");
  args.client.taskExecute = normalReserve;
  args.nativeApi.submitNativeTurn = async () => { calls.push("submit"); throw new Error("lost acknowledgement"); };
  await assert.rejects(executeNativeTask(args), /lost acknowledgement/);
  assert.equal(executionRecord(config, args.id).phase, "uncertain");
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("ordinary accounts cannot reach the transport on any deployment; developers can on every one", async (t) => {
  const { args, calls } = fixture(t);
  const ordinary = { ...args.config.user, isDeveloper: false };
  for (const environment of ["production", "staging", "dev"]) {
    await assert.rejects(executeNativeTask({ ...args, env: { RELAY_ENV: environment }, config: { ...args.config, user: ordinary } }), /Relay developer accounts/);
  }
  assert.deepEqual(calls, []);
  // A production Companion learns the role from the raw developerAccount
  // field: isDeveloper is masked there, so a cached profile alone never opens
  // Execute on production, while the live role does.
  const masked = { ...ordinary, developerAccount: true };
  for (const environment of ["production", "staging"]) {
    await assert.rejects(executeNativeTask({ ...args, env: { RELAY_ENV: environment }, config: { ...args.config, user: { ...ordinary, developerAccount: false } } }), /Relay developer accounts/);
    await executeNativeTask({ ...args, env: { RELAY_ENV: environment }, config: { ...args.config, user: masked } });
  }
  assert.equal(calls.filter((c) => c === "gate").length, 2);
});

test("server refusal and declined consent create no provider conversation", async (t) => {
  const { args, calls } = fixture(t);
  const client = { ...args.client, taskExecute: async () => { throw new Error("server refused"); } };
  await assert.rejects(executeNativeTask({ ...args, client }), /server refused/);
  assert.deepEqual(calls, []);
  assert.equal((await executeNativeTask({ ...args, consent: async () => false })).cancelled, true);
  assert.deepEqual(calls, ["gate"]);
});

test("native app is ready and server owner reserved before the only submission", async (t) => {
  const { args, calls, config } = fixture(t);
  await executeNativeTask(args);
  assert.deepEqual(calls, ["gate", "consent", "fetch", "prepare", "open", "ready", "reserve", "fetch", "submit"]);
  assert.equal(executionRecord(config, args.id).phase, "accepted");
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "submit").length, 1);
  assert.equal(calls.filter((c) => c === "consent").length, 1);
  assert.equal(calls.at(-1), "open");
});

test("lost acknowledgement survives restart and is never replayed", async (t) => {
  const { args, config, calls } = fixture(t);
  args.nativeApi.submitNativeTurn = async () => { calls.push("submit"); throw new Error("lost acknowledgement"); };
  await assert.rejects(executeNativeTask(args), /lost acknowledgement/);
  assert.equal(executionRecord(config, args.id).phase, "uncertain");
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "submit").length, 1);
  assert.equal(calls.filter((c) => c === "prepare").length, 1);
});

test("readiness failure can retry the same conversation without a duplicate", async (t) => {
  const { args, calls, config } = fixture(t);
  args.nativeApi.nativeSessionReady = async () => { throw new Error("not ready"); };
  await assert.rejects(executeNativeTask(args), /not ready/);
  assert.equal(calls.includes("submit"), false);
  assert.equal(calls.includes("reserve"), false);
  const prepared = executionRecord(config, args.id);
  assert.equal(prepared.phase, "prepared");
  args.nativeApi.nativeSessionReady = async () => ({});
  await executeNativeTask(args);
  assert.equal(executionRecord(config, args.id).messageId, prepared.messageId);
  assert.deepEqual(executionRecord(config, args.id).session, prepared.session);
  assert.equal(calls.filter((c) => c === "prepare").length, 1);
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("Claude readiness timeout explains capacity and preserves a safe manual recovery", async (t) => {
  const { root } = fixture(t);
  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = previous;
  });
  await assert.rejects(nativeSessionReady({ provider: "claude", nativeId: "unavailable" }, { timeoutMs: 0 }), (error) => {
    assert.match(error.message, /may have reached its session or memory limit/);
    assert.match(error.message, /No task prompt was sent; retrying will reuse this conversation/);
    assert.match(error.message, /Copy for your agent/);
    return true;
  });
});

test("a different device winning ownership never receives a second prompt", async (t) => {
  const { args, calls } = fixture(t);
  args.client.taskExecute = async () => ({ taskRunOwner: { provider: "claude", nativeSessionId: "other-session" } });
  await assert.rejects(executeNativeTask(args), /already belongs/);
  assert.equal(calls.includes("submit"), false);
});

test("double clicks are serialized before any native side effect", async (t) => {
  const { args, calls } = fixture(t);
  let release;
  args.consent = () => new Promise((resolve) => { release = resolve; });
  const first = executeNativeTask(args);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await executeNativeTask(args)).ok, false);
  release(true);
  await first;
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("consent is off by default, account/deployment scoped and revocable", (t) => {
  const { config } = fixture(t);
  assert.equal(executionEnabled(config), false);
  setExecutionPreferences(config, { enabled: true });
  assert.equal(executionEnabled(config), true);
  assert.equal(executionEnabled({ ...config, apiUrl: "https://prod.example.test" }), false);
  assert.equal(executionEnabled({ ...config, user: { ...config.user, id: "someone-else" } }), false);
  setExecutionPreferences(config, { enabled: false });
  assert.equal(executionPreferences(config).enabled, false);
});

test("Claude import requires existing exact folder trust and never edits it", (t) => {
  const { root } = fixture(t), file = path.join(root, "trust.json"), folder = path.join(root, "project");
  const text = JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(file, text);
  assert.equal(claudeWorkspaceTrusted(folder, file), true);
  assert.equal(claudeWorkspaceTrusted(path.join(folder, "child"), file), false);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("a Claude seed is never reported as actual model completion", (t) => {
  const { root } = fixture(t), transcript = path.join(root, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", entrypoint: "relay-execute", message: { stop_reason: "end_turn" } }) + "\n");
  assert.equal(nativeProgress({ provider: "claude", transcript }), "Waiting for the native app");
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", entrypoint: "claude-desktop", message: { stop_reason: "end_turn" } }) + "\n" +
    JSON.stringify({ type: "system", hookOutput: "x".repeat(300000) }) + "\n");
  assert.match(nativeProgress({ provider: "claude", transcript }), /finished a turn/);
});

test("Codex chooses a catalog model and never sends a blank model", async () => {
  const models = [{ model: "provider-default", isDefault: true }, { model: "configured-model", isDefault: false }];
  assert.equal(selectCodexModel(models, "configured-model"), "configured-model");
  assert.equal(selectCodexModel(models, ""), "provider-default");
  assert.equal(selectCodexModel(models, "retired-model"), "provider-default");
  assert.throws(() => selectCodexModel([{ model: "", isDefault: true }], ""), /available default/);
  let sent, closed = 0;
  const ready = { connection: { request: async (_method, params) => { sent = params; return { resultType: "success", result: { result: { turn: { id: "turn" } } } }; }, close: () => { closed++; } } };
  await assert.rejects(submitNativeTurn({ provider: "codex", model: "" }, ready, "prompt", "message"), /no selected Codex model/);
  assert.equal(sent, undefined);
  await submitNativeTurn({ provider: "codex", nativeId: "session", model: "configured-model" }, ready, "prompt", "message");
  assert.equal(sent.turnStart.request.model, "configured-model");
  assert.equal(sent.turnStart.request.collaborationMode.settings.model, "configured-model");
  assert.equal(closed, 2);
});

test("Codex task_complete with an error is a failed turn, not success", (t) => {
  const { root } = fixture(t), transcript = path.join(root, "codex.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "unsupported model" }, last_agent_message: null } }) + "\n");
  assert.match(nativeProgress({ provider: "codex", transcript }), /could not finish/);
  fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Actual answer" } }) + "\n");
  assert.match(nativeProgress({ provider: "codex", transcript }), /finished a turn/);
});
