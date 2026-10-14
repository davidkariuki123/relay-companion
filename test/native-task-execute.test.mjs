import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeNativeTask, executionPrompt, executionRecord, executionRecordPath, pendingNativeDrafts, nativeExecutionStatus, stopWaitingForNativeApp } from "../src/native-task-execute.js";
import { prepareClaudeDraft, prepareClaudeTaskLink } from "../src/claude-task-fallback.js";
import { CLAUDE_DELIVERED_NOT_STARTED, claudeTurnStartedAfter, claudeWorkspaceTrusted, EXECUTION_MODES, executionEnabled, executionMode, executionPreferences, setExecutionPreferences, nativeConversationUsed, nativeProgress, nativeSessionReady, prepareNativeSession, selectCodexModel, submitNativeTurn } from "../src/native-task-launch.js";

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
      nativeTurnStarted: async () => true,
    },
  };
  return { root, config, args, calls, session };
}

function draftFixture(t) {
  const f = fixture(t);
  let bound = null;
  Object.assign(f.args.nativeApi, {
    // The capacity estimate never gates; an untrusted folder is what opens a draft.
    claudeLaunchPreflight: async () => ({ manual: true, reason: "capacity" }),
    claudeWorkspaceTrusted: () => false,
    prepareClaudeDraft,
    findClaudeDraftSession: () => bound,
  });
  return { ...f, bind: () => { bound = { ...executionRecord(f.config, f.args.id).session, ...f.session, fromDraft: true }; } };
}

test("a draft opens without claiming or submitting; after Send, observer claims exact owner and submits once", async (t) => {
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

test("automatic launch is tried on any version or capacity estimate, and succeeds without a draft", async (t) => {
  const { args, calls, config } = draftFixture(t);
  args.nativeApi.claudeWorkspaceTrusted = () => true;
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: true, reason: "unknown_version" });
  const result = await executeNativeTask(args);
  assert.equal(result.awaitingSend, undefined);
  assert.deepEqual(calls, ["gate", "consent", "fetch", "prepare", "open", "ready", "reserve", "fetch", "submit"]);
  assert.equal(executionRecord(config, args.id).phase, "accepted");
});

test("any failure before reservation falls back to one draft in the same folder; nothing is reserved or sent", async (t) => {
  const { args, calls, config, root } = draftFixture(t);
  args.nativeApi.claudeWorkspaceTrusted = () => true;
  args.nativeApi.nativeSessionReady = async () => { calls.push("ready"); throw new Error("unexpected Mac failure"); };
  const result = await executeNativeTask(args);
  assert.equal(result.awaitingSend, true);
  assert.match(result.message, new RegExp(`choose the ${path.basename(root)} folder`));
  assert.deepEqual(calls, ["gate", "consent", "fetch", "prepare", "open", "ready", "open"]);
  const session = executionRecord(config, args.id).session;
  assert.equal(session.cwd, root);
  assert.equal(session.preflight.reason, "launch_failed");
  assert.match(session.preflight.error, /unexpected Mac failure/);
  assert.equal(session.unusedPreparedNativeId, "dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16");
});

test("a failure preparing the Claude conversation also falls back; a Codex failure does not", async (t) => {
  const f = draftFixture(t);
  f.args.nativeApi.claudeWorkspaceTrusted = () => true;
  f.args.nativeApi.prepareNativeSession = async () => { f.calls.push("prepare"); throw new Error("could not write"); };
  assert.equal((await executeNativeTask(f.args)).awaitingSend, true);
  assert.equal(f.calls.includes("reserve"), false);
  const g = fixture(t);
  g.args.choose = async () => ({ provider: "codex", cwd: g.root });
  g.args.nativeApi.nativeProviders = () => [{ provider: "codex" }];
  g.args.nativeApi.prepareClaudeDraft = prepareClaudeDraft;
  g.args.nativeApi.prepareNativeSession = async ({ cwd, persist }) => { persist({ provider: "codex", cwd, nativeId: "codex-thread", url: "codex://threads/codex-thread" }); };
  g.args.nativeApi.nativeSessionReady = async () => { throw new Error("codex not ready"); };
  await assert.rejects(executeNativeTask({ ...g.args, id: "relay-codex" }), /codex not ready/);
});

test("readiness timeout offers a draft, but submission ambiguity never does", async (t) => {
  const { args, calls, config } = draftFixture(t);
  args.nativeApi.claudeWorkspaceTrusted = () => true;
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

test("a saved role cannot veto a server-approved Execute or bypass a server refusal", async (t) => {
  const { args, calls } = fixture(t);
  const cachedOrdinary = { ...args.config, user: { ...args.config.user, isDeveloper: false } };
  await executeNativeTask({ ...args, config: cachedOrdinary });
  assert.deepEqual(calls, ["gate", "consent", "fetch", "prepare", "open", "ready", "reserve", "fetch", "submit"]);

  const denied = fixture(t);
  denied.args.client.taskExecute = async () => { throw new Error("server refused"); };
  await assert.rejects(executeNativeTask(denied.args), /server refused/);
  assert.deepEqual(denied.calls, [], "the live server gate runs before native work");
  await assert.rejects(executeNativeTask({ ...denied.args, isCurrentAccount: () => false }), /account changed/);
  assert.deepEqual(denied.calls, []);
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

test("Tasks start in Claude Code's one permission from Your AIs; the mode reaches the conversation Relay prepares", async (t) => {
  const { args } = fixture(t);
  // Every Claude mode the person can choose reaches Execute: the list is the
  // settings' own, least freedom first.
  assert.deepEqual(EXECUTION_MODES, ["default", "acceptEdits", "auto", "bypassPermissions"]);
  assert.ok(EXECUTION_MODES.includes(executionMode()));
  let prepared;
  args.nativeApi.executionMode = () => "default";
  const prepare = args.nativeApi.prepareNativeSession;
  args.nativeApi.prepareNativeSession = async (input) => { prepared = input; return prepare(input); };
  await executeNativeTask(args);
  assert.equal(prepared.permissionMode, "default");
});

test("the conversation Relay creates records the mode on a hidden notice that is never progress", async (t) => {
  const { root } = fixture(t), cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  const saved = { CLAUDE_HOME: process.env.CLAUDE_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.CLAUDE_HOME = path.join(root, "claude-home");
  process.env.USERPROFILE = root; process.env.HOME = root;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const rowsOf = (session) => fs.readFileSync(session.transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const auto = await prepareNativeSession({ provider: "claude", cwd, title: "T", permissionMode: "auto", persist: () => {} });
  const [, notice, seed] = rowsOf(auto);
  assert.equal(notice.type, "user");
  assert.equal(notice.isMeta, true);
  assert.equal(notice.permissionMode, "auto");
  assert.equal(seed.parentUuid, notice.uuid, "the seed stays the last row");
  assert.equal(nativeProgress(auto), "Waiting for the native app");
  const plain = await prepareNativeSession({ provider: "claude", cwd, title: "T", persist: () => {} });
  assert.equal(rowsOf(plain).some((row) => row.type === "user"), false, "no choice: Claude's own default");
});

test("the Task names the chosen folder and project, and says where the conversation opened instead", () => {
  const packet = { title: "T", source: { workspace: { kind: "name", key: "relay", label: "relay" } } };
  const inFolder = executionPrompt(packet, "relay-1", { cwd: "/Users/david/relay" });
  assert.ok(inFolder.includes("chose to run this Task in /Users/david/relay, their checkout of the relay project"));
  assert.match(inFolder, /If this conversation is not already in that folder, use its full path and first read its project instructions/);
  const elsewhere = executionPrompt(packet, "relay-1", { cwd: "/Users/david/relay", openedCwd: "/Users/david" });
  assert.ok(elsewhere.includes("This conversation opened in /Users/david instead"));
  assert.doesNotMatch(executionPrompt({ title: "T" }, "relay-1", {}), /Workspace:/);
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

test("delivered is not launched: a Task Claude is holding is reported as not started, never as working", async (t) => {
  const { args, config, session, root } = fixture(t);
  const transcript = path.join(root, "held.jsonl");
  session.transcript = transcript;
  // Claude wrote the pushed message to the conversation and did nothing else.
  args.nativeApi.nativeTurnStarted = async (_session, messageId) => {
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", uuid: messageId, message: { role: "user", content: "the Task" } }) + "\n");
    return false;
  };
  const result = await executeNativeTask(args);
  assert.equal(result.deliveredIdle, true);
  assert.match(result.message, /not started yet/);
  const record = executionRecord(config, args.id);
  assert.equal(record.phase, "accepted", "the Task is in that conversation; Relay never sends it twice");
  assert.ok(record.deliveredIdleAt);
  assert.equal(record.turnStartedAt, undefined);
  assert.equal(nativeExecutionStatus(record), CLAUDE_DELIVERED_NOT_STARTED);
  // The moment the model answers, the same record reads as working.
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", entrypoint: "claude-desktop", message: { stop_reason: "tool_use" } }) + "\n");
  assert.match(nativeExecutionStatus(record), /Working in Claude Code/);
  const rows = fs.readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(claudeTurnStartedAfter(rows, record.messageId), true);
  assert.equal(claudeTurnStartedAfter(rows.slice(0, 1), record.messageId), false);
  assert.equal(claudeTurnStartedAfter(rows, "some-other-message"), false);
  // A launch the model answered records when it started.
  const g = fixture(t);
  await executeNativeTask({ ...g.args, id: "relay-started" });
  assert.ok(executionRecord(g.config, "relay-started").turnStartedAt);
});

test("Remote Control on for all sessions opens one conversation with the Task in the box; nothing is pushed or reserved", async (t) => {
  const { args, calls, config, root } = draftFixture(t);
  args.nativeApi.claudeWorkspaceTrusted = () => true;
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: false, reason: "headroom", remoteControlDefault: true });
  args.nativeApi.prepareClaudeTaskLink = prepareClaudeTaskLink;
  args.client.fetchRelay = async () => { calls.push("fetch"); return { packet: { title: "Fix the login bug", forHuman: "Please fix the login bug today.", forAgent: "Long context.", source: { workspace: { label: "relay" } } } }; };
  const result = await executeNativeTask(args);
  assert.equal(result.awaitingSend, true);
  assert.match(result.message, /press Enter/);
  assert.deepEqual(calls, ["gate", "consent", "fetch", "open"]);
  const record = executionRecord(config, args.id);
  assert.equal(record.phase, "task_link_opened");
  assert.equal(record.session.taskLink, true);
  assert.equal(record.session.preflight.reason, "remote_control");
  const url = new URL(record.session.url);
  assert.equal(url.searchParams.get("folder"), root);
  const q = url.searchParams.get("q");
  assert.match(q, /Relay Task relay-test \(“Fix the login bug”\)/);
  assert.match(q, /relay_task_start/);
  assert.ok(q.includes(`carry it out in ${root}, their checkout of the relay project`));
  assert.match(q, /For the person:\nPlease fix the login bug today\./);
  assert.doesNotMatch(q, /Long context/);
  assert.match(nativeExecutionStatus(record), /press Enter there to start/);
  assert.deepEqual(pendingNativeDrafts(config), [], "nothing to observe: the agent there stamps the Task itself");
  // Execute again asks again and reopens the link; Relay never pushes into a
  // conversation it cannot see.
  calls.length = 0;
  await executeNativeTask(args);
  assert.deepEqual(calls, ["gate", "fetch", "open"]);
  assert.equal(executionRecord(config, args.id).phase, "task_link_opened");
  // With the setting off, the automatic launch runs exactly as before.
  args.nativeApi.claudeLaunchPreflight = async () => ({ manual: false, reason: "headroom", remoteControlDefault: false });
  calls.length = 0;
  await executeNativeTask({ ...args, id: "relay-test-2" });
  assert.deepEqual(calls, ["gate", "fetch", "prepare", "open", "ready", "reserve", "fetch", "submit"]);
  assert.equal(executionRecord(config, "relay-test-2").phase, "accepted");
});

test("Execute has no switch or mode of its own: Claude Code's permission in Your AIs decides", () => {
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  const launch = fs.readFileSync(new URL("../src/native-task-launch.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /Tasks start in|id="executionMode"|executionDisable|nativeExecutionMode/);
  assert.doesNotMatch(preload, /relay:executionMode|relay:executionDisable/);
  assert.doesNotMatch(main, /relay:executionMode|relay:executionDisable|nativeExecutionMode/);
  assert.match(launch, /export function executionMode\(\) \{\s*try \{ return relaySettings\.taskPermission\("claude"\); \} catch \{ return "auto"; \}/);
});

// Codex can show a conversation minutes before it can take a Task (over three
// on a laptop short of memory, 2026-10-13). The click hands the wait to the
// background watch, which sends late only when nothing else has happened.
function codexFixture(t) {
  const f = fixture(t);
  Object.assign(f.session, { provider: "codex", nativeId: "01a13557-4a93-7e90-9794-6bfb5b565f07", url: "codex://threads/01a13557-4a93-7e90-9794-6bfb5b565f07", model: "test-model" });
  f.args.choose = async () => ({ provider: "codex", cwd: f.root });
  f.args.nativeApi.nativeProviders = () => [{ provider: "codex" }];
  let codexReady = false, used = false;
  const reserves = [];
  f.args.nativeApi.nativeSessionReady = async () => {
    f.calls.push("ready");
    if (!codexReady) throw Object.assign(new Error("Codex has not finished opening this conversation."), { code: "CODEX_NOT_READY" });
    return {};
  };
  f.args.nativeApi.nativeConversationUsed = () => used;
  const reserve = f.args.client.taskExecute;
  f.args.client.taskExecute = async (id, input) => { if (input) reserves.push(input); return reserve(id, input); };
  return { ...f, reserves, becomeReady: () => { codexReady = true; }, useConversation: () => { used = true; } };
}

test("a Codex conversation still opening is watched, then sent once with the server told it is late", async (t) => {
  const f = codexFixture(t), { args, calls, config, reserves } = f;
  const result = await executeNativeTask(args);
  assert.equal(result.ok, true);
  assert.equal(result.waiting, true);
  assert.match(result.message, /still opening/);
  const waiting = executionRecord(config, args.id);
  assert.equal(waiting.phase, "awaiting_app");
  assert.equal(Date.parse(waiting.waitUntil) - Date.parse(waiting.waitingSince), 10 * 60 * 1000);
  assert.equal(calls.includes("reserve"), false, "nothing is claimed while Codex is opening");
  assert.match(nativeExecutionStatus(waiting), /Waiting for Codex/);
  assert.deepEqual(pendingNativeDrafts(config), [args.id]);

  calls.length = 0;
  assert.equal((await executeNativeTask({ ...args, observeOnly: true })).waiting, true);
  assert.deepEqual(calls, ["ready"], "while Codex is opening the watch makes no network calls and opens nothing");

  f.becomeReady();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, ["ready", "gate", "reserve", "fetch", "submit"]);
  assert.equal(reserves.at(-1).requireUnstarted, true);
  assert.equal(executionRecord(config, args.id).phase, "accepted");
  assert.deepEqual(pendingNativeDrafts(config), []);
  await executeNativeTask({ ...args, observeOnly: true });
  assert.equal(calls.filter((c) => c === "submit").length, 1);
});

test("a click that finds Codex ready sends at once and never marks the launch late", async (t) => {
  const f = codexFixture(t);
  f.becomeReady();
  await executeNativeTask(f.args);
  assert.equal(executionRecord(f.config, f.args.id).phase, "accepted");
  assert.equal("requireUnstarted" in f.reserves[0], false);
});

test("a conversation someone used while it opened is left alone; the Task stays unsent", async (t) => {
  const f = codexFixture(t), { args, calls, config } = f;
  await executeNativeTask(args);
  f.becomeReady();
  f.useConversation();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, ["ready"]);
  const record = executionRecord(config, args.id);
  assert.equal(record.phase, "prepared");
  assert.match(nativeExecutionStatus(record), /^Task not sent · The Codex conversation already has a message/);
  assert.deepEqual(pendingNativeDrafts(config), []);
});

test("a Task started elsewhere while Codex opened is never sent, and an older server's refusal also stops it", async (t) => {
  for (const [refusal, expected] of [
    [Object.assign(new Error("This Task was already started somewhere else."), { status: 409, body: { error: "task_started_elsewhere" } }), /started somewhere else while Codex was opening/],
    [Object.assign(new Error("invalid_request"), { status: 400, body: { error: "invalid_request" } }), /could not confirm the Task was still waiting/],
  ]) {
    const f = codexFixture(t), { args, calls, config } = f;
    await executeNativeTask(args);
    f.becomeReady();
    args.client.taskExecute = async (_id, input) => { calls.push(input ? "reserve" : "gate"); if (input) throw refusal; return {}; };
    await assert.rejects(executeNativeTask({ ...args, observeOnly: true }));
    assert.equal(calls.includes("submit"), false);
    const record = executionRecord(config, args.id);
    assert.equal(record.phase, "prepared");
    assert.match(nativeExecutionStatus(record), expected);
    assert.deepEqual(pendingNativeDrafts(config), []);
  }
});

test("Stop waiting leaves the Task unsent; Execute later sends it to the same conversation", async (t) => {
  const f = codexFixture(t), { args, calls, config, reserves } = f;
  await executeNativeTask(args);
  const before = executionRecord(config, args.id);
  assert.deepEqual(stopWaitingForNativeApp(config, args.id), { ok: true });
  assert.match(nativeExecutionStatus(executionRecord(config, args.id)), /You stopped waiting/);
  assert.deepEqual(pendingNativeDrafts(config), []);
  f.becomeReady();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, [], "a stopped Task is not watched");
  assert.equal(stopWaitingForNativeApp(config, args.id).ok, false);
  await executeNativeTask(args);
  const after = executionRecord(config, args.id);
  assert.equal(after.phase, "accepted");
  assert.equal(after.session.nativeId, before.session.nativeId);
  assert.equal(calls.filter((c) => c === "prepare").length, 0);
  assert.equal("requireUnstarted" in reserves.at(-1), false, "Execute after stopping is the person's own choice");
});

test("Stop waiting landing after the watch's last check is refused, so the Task is never half-stopped", async (t) => {
  const f = codexFixture(t), { args, config } = f;
  await executeNativeTask(args);
  f.becomeReady();
  let stop;
  args.client.fetchRelay = async () => { stop = stopWaitingForNativeApp(config, args.id); return { packet: { title: "Test", forHuman: "Do it.", forAgent: "" } }; };
  await executeNativeTask({ ...args, observeOnly: true });
  assert.equal(stop.ok, false);
  assert.match(stop.error, /being sent now/);
  assert.equal(executionRecord(config, args.id).phase, "accepted");
});

test("the watch gives up after ten minutes without sending", async (t) => {
  const f = codexFixture(t), { args, calls, config } = f;
  await executeNativeTask(args);
  const file = executionRecordPath(config, args.id);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, waitUntil: new Date(Date.now() - 1000).toISOString() }));
  f.becomeReady();
  calls.length = 0;
  await executeNativeTask({ ...args, observeOnly: true });
  assert.deepEqual(calls, []);
  assert.match(nativeExecutionStatus(executionRecord(config, args.id)), /did not finish opening the conversation within 10 minutes/);
});

test("a Codex conversation counts as used only once a turn or message is in it", (t) => {
  const { root } = fixture(t), transcript = path.join(root, "rollout.jsonl");
  const session = { provider: "codex", transcript };
  const opened = [
    { type: "session_meta", payload: { id: "thread" } },
    { type: "event_msg", payload: { type: "thread_settings_applied" } },
  ];
  fs.writeFileSync(transcript, opened.map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(nativeConversationUsed(session), false);
  fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }) + "\n");
  assert.equal(nativeConversationUsed(session), true);
  assert.equal(nativeConversationUsed({ provider: "claude", transcript }), false);
});

test("the Task card offers Stop waiting while a Task waits for Codex", () => {
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  assert.match(html, /current\?\.phase === "awaiting_app"/);
  assert.match(html, /data-execute-stop-wait="\$\{esc\(st\.id\)\}">Stop waiting<\/button>/);
  assert.match(html, /window\.relay\.taskExecuteStopWaiting\(id\)/);
  assert.match(preload, /taskExecuteStopWaiting: \(id\) => ipcRenderer\.invoke\("relay:taskExecuteStopWaiting"/);
  assert.match(main, /ipcMain\.handle\("relay:taskExecuteStopWaiting", stopWaitingForNativeApp\)/);
});
