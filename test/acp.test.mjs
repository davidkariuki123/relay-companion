import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpClient, acpMcpServers, acpModelOption } from "../src/acp-client.js";
import { startAcpRun, acpWorker, acpPermissionMode } from "../src/acp-session.js";
import { createAcpHostAdapters } from "../src/acp-host-adapters.js";
import { requestAcpPermission, pendingAcpPermissions, answerAcpPermission } from "../src/acp-permissions.js";
import { relayCompletion } from "../src/relay-completion.js";
import { createWorkConversation, replayWorkEvents, workPresentationSnapshot } from "../src/work-conversation.js";
import { canonicalProviderCompletionCandidate } from "../src/provider-completion.js";
import { createHostAdapters, ensureRuntimeSession } from "../src/runtime.js";
import { claimAcpSession, acpSessionOwner } from "../src/acp-session-owner.js";
import { spawnSync } from "node:child_process";

function fakeAgent({ onPrompt, onPermissionAnswer, exitOnPrompt = false, models = [{ value: "test-model" }] } = {}) {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { if (child.exitCode == null) { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0)); } };
  const send = value => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  const reply = (id, result) => send({ id, result });
  const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
  let promptId;
  const sessionId = `native-${Math.random()}`;
  const state = { sessionId, modes: { availableModes: [{ id: "agent" }, { id: "auto" }] }, configOptions: [
    { id: "model", category: "model", options: models },
    { id: "effort", category: "thought_level", options: [{ value: "high" }] },
  ] };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); messages.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      else if (message.method === "session/new") reply(message.id, state);
      else if (message.method === "session/load") {
        update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD ANSWER" } });
        reply(message.id, { ...state, sessionId: message.params.sessionId });
      } else if (message.method === "session/set_config_option" || message.method === "session/set_mode") reply(message.id, { configOptions: state.configOptions });
      else if (message.method === "session/prompt") {
        promptId = message.id;
        if (exitOnPrompt) child.kill();
        else if (onPrompt) onPrompt({ message, update, send, finish: reason => reply(message.id, { stopReason: reason || "end_turn" }) });
        else { update(message.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } }); reply(message.id, { stopReason: "end_turn" }); }
      } else if (message.method === "session/cancel") reply(promptId, { stopReason: "cancelled" });
      else if (message.id === "permission") onPermissionAnswer?.(message.result);
    });
    done();
  } });
  const spawnProcess = () => child;
  const factory = options => new AcpClient({ ...options, launch: { command: "test-agent", args: [], env: {} }, spawnProcess, timeoutMs: 500 });
  return { factory, child, messages, send, sessionId };
}
function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-acp-test-"));
  const previous = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.RELAY_CONFIG_DIR; else process.env.RELAY_CONFIG_DIR = previous;
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("ACP initializes, configures, preserves native identity and closes after a turn", async t => {
  temporaryHome(t);
  const agent = fakeAgent();
  const worker = await startAcpRun({ provider: "codex", prompt: "Hello", model: "test-model", effort: "high", mode: "agent", clientFactory: agent.factory });
  assert.equal(worker.sessionId, agent.sessionId);
  assert.equal((await worker.done).text, "DONE");
  assert.equal(worker.closed, true);
  assert.equal(acpSessionOwner("codex", worker.sessionId), null);
  assert.deepEqual(agent.messages.filter(m => m.method).map(m => m.method), ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/set_config_option", "session/prompt"]);
  assert.equal(agent.messages[0].params.clientCapabilities.fs.readTextFile, false);
});

test("ACP session ownership excludes a second process and releases after cancellation", async t => {
  const root = temporaryHome(t);
  const ownership = claimAcpSession("claude", "shared-native", process.cwd());
  t.after(() => ownership.release());
  ownership.setState("needs_input");
  assert.equal(acpSessionOwner("claude", "shared-native").state, "needs_input");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { claimAcpSession } from ${JSON.stringify(new URL("../src/acp-session-owner.js", import.meta.url).href)};
    claimAcpSession("claude", "shared-native", process.cwd());
  `], { encoding: "utf8", windowsHide: true });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /already has a Relay ACP owner/);
  ownership.setAdapterPid(process.pid);
  const file = path.join(root, "acp-sessions", fs.readdirSync(path.join(root, "acp-sessions"))[0]);
  const row = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...row, pid: 0 }));
  assert.equal(acpSessionOwner("claude", "shared-native").adapterPid, process.pid, "A surviving adapter still owns the transcript after its controller exits");
  assert.throws(() => claimAcpSession("claude", "shared-native", process.cwd()), /already has a Relay ACP owner/);
  ownership.release();
  const next = claimAcpSession("claude", "shared-native", process.cwd());
  next.release();
  assert.equal(acpSessionOwner("claude", "shared-native"), null);
});

test("Claude app metadata is published only after its ACP writer closes", async t => {
  temporaryHome(t);
  const agent = fakeAgent();
  let metadata;
  const worker = await startAcpRun({ provider: "claude", title: "A visible native task", prompt: "Hello", clientFactory: agent.factory,
    materializeSession: async options => {
      assert.equal(agent.child.exitCode, 0);
      assert.ok(acpSessionOwner("claude", options.sessionId), "Keep ownership during metadata publication");
      metadata = options;
      return { materialized: true };
    },
  });
  await worker.done;
  assert.equal(metadata.sessionId, worker.sessionId);
  assert.equal(metadata.title, "A visible native task");
  assert.equal(metadata.importIntoDesktop, false, "Do not launch another app writer automatically");
  let opened;
  const hosts = createHostAdapters({ openExternal: target => { opened = target; return { ok: true }; } });
  hosts.openUi({ sessionRef: { mode: "acp", host: "claude_code", hostSessionId: worker.sessionId } });
  assert.equal(opened, `claude://resume?session=${encodeURIComponent(worker.sessionId)}`);
});

test("resume replay never becomes the new answer, and tool progress is not the final answer", async t => {
  const root = temporaryHome(t);
  const agent = fakeAgent({ onPrompt: ({ message, update, finish }) => {
    const id = message.params.sessionId;
    update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking…" } });
    update(id, { sessionUpdate: "tool_call", toolCallId: "tool1", title: "Read file", status: "in_progress" });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "tool1", status: "completed" });
    update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final answer" } });
    finish();
  } });
  const worker = await startAcpRun({ provider: "claude", sessionId: "existing-native", cwd: root, prompt: "Continue", logPath: path.join(root, "events.jsonl"), clientFactory: agent.factory });
  assert.equal((await worker.done).text, "Final answer");
  assert.equal(JSON.stringify(worker.events).includes("OLD ANSWER"), false);
  assert.equal(worker.events.at(-1).params.turn.status, "completed");
  const presentation = workPresentationSnapshot(replayWorkEvents(worker.events, createWorkConversation()));
  assert.equal(canonicalProviderCompletionCandidate({ provider: "claude", presentation, expectedTurnId: worker.turnId })?.body, "Final answer");
});

test("a missing model fails before prompting; there is no execution fallback", async t => {
  temporaryHome(t); const agent = fakeAgent();
  await assert.rejects(startAcpRun({ provider: "codex", prompt: "Do work", model: "missing", clientFactory: agent.factory }), /does not support model/);
  assert.equal(agent.messages.some(m => m.method === "session/prompt"), false);
  assert.equal(agent.child.exitCode, 0);
});

// Model choices returned by the stock Claude ACP 0.77.0 adapter. In
// particular, neither the default `opus` nor the saved `fable` is a value.
const claudeModels = [
  { value: "default", name: "Default (recommended)" },
  { value: "opus[1m]", name: "Opus 5" },
  { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
  { value: "sonnet", name: "Sonnet 5" },
  { value: "haiku", name: "Haiku 4.5" },
];

test("Claude chat defaults and saved family selections configure ACP before prompting", async t => {
  temporaryHome(t);
  for (const [model, expected] of [["opus", "opus[1m]"], ["fable", "claude-fable-5-1[1m]"], ["sonnet", "sonnet"], ["haiku", "haiku"]]) {
    const agent = fakeAgent({ models: claudeModels });
    const worker = await startAcpRun({ provider: "claude", model, effort: "high", mode: "auto", prompt: "Say hello", clientFactory: agent.factory });
    assert.equal((await worker.done).text, "DONE");
    const config = agent.messages.filter(message => message.method === "session/set_config_option");
    assert.deepEqual(config.map(message => [message.params.configId, message.params.value]), [["model", expected], ["effort", "high"]]);
    assert.equal(agent.messages.filter(message => message.method === "session/prompt").length, 1);
    assert.equal(agent.child.exitCode, 0);
  }
});

test("Claude alias resolution preserves exact versions and rejects ambiguous or absent choices", async t => {
  temporaryHome(t);
  assert.equal(acpModelOption(claudeModels, "claude-opus-5", "claude"), "opus[1m]");
  assert.equal(acpModelOption(claudeModels, "claude-fable-5-1", "claude"), "claude-fable-5-1[1m]");
  assert.equal(acpModelOption(claudeModels, "opus", "codex"), null);
  assert.equal(acpModelOption(claudeModels, "opus", "claude_code"), "opus[1m]");
  assert.equal(acpModelOption([{ value: "opus", name: "Opus 5" }, ...claudeModels], "opus", "claude"), "opus", "An exact native alias wins");
  const ambiguous = [...claudeModels, { value: "claude-opus-4", name: "Opus 4" }];
  for (const [model, models] of [["opus", ambiguous], ["claude-opus-4", claudeModels], ["claude-fable-5", claudeModels], ["fable", claudeModels.filter(option => !option.name.startsWith("Fable"))]]) {
    const agent = fakeAgent({ models });
    await assert.rejects(startAcpRun({ provider: "claude", model, prompt: "Say hello", clientFactory: agent.factory }), /does not support model/);
    assert.equal(agent.messages.some(message => message.method === "session/prompt"), false);
    assert.equal(agent.child.exitCode, 0);
  }
});

test("provider exit rejects the run and records failure without replaying it", async t => {
  temporaryHome(t); const agent = fakeAgent({ exitOnPrompt: true });
  const worker = await startAcpRun({ provider: "codex", prompt: "Do work", clientFactory: agent.factory });
  await assert.rejects(worker.done, /exited/);
  assert.equal(worker.events.at(-1).params.turn.status, "failed");
  assert.equal(agent.messages.filter(m => m.method === "session/prompt").length, 1);
});

test("cancellation releases a pending approval and preserves the native session", async t => {
  temporaryHome(t);
  let permissionAnswer;
  let requested;
  const requestSeen = new Promise(resolve => { requested = resolve; });
  const agent = fakeAgent({ onPrompt: ({ message, send }) => {
    send({ id: "permission", method: "session/request_permission", params: { sessionId: message.params.sessionId, options: [{ optionId: "allow", kind: "allow_once" }] } });
  }, onPermissionAnswer: answer => { permissionAnswer = answer; } });
  const worker = await startAcpRun({ provider: "claude", prompt: "Write", clientFactory: agent.factory,
    onPermission: () => { requested(); return new Promise(() => {}); } });
  await requestSeen;
  await assert.rejects(startAcpRun({ provider: "claude", sessionId: worker.sessionId, prompt: "Duplicate", clientFactory: agent.factory }), /already has/);
  worker.client.cancel(worker.sessionId);
  const result = await worker.done;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(acpWorker(result.sessionId).closed, true);
  assert.deepEqual(permissionAnswer, { outcome: { outcome: "cancelled" } });
});

test("permission answers are bound to the exact live request and may be cancelled", async t => {
  temporaryHome(t);
  const params = { sessionId: "native-permission", toolCall: { title: "Write a file" }, options: [{ optionId: "yes", kind: "allow_once", name: "Allow once" }] };
  const answer = requestAcpPermission(params, { provider: "codex", cwd: os.tmpdir(), timeoutMs: 1000 });
  const request = pendingAcpPermissions()[0];
  assert.equal(answerAcpPermission(request.id, "invented"), false);
  assert.equal(answerAcpPermission(request.id, "yes"), true);
  assert.equal(await answer, "yes");
  assert.equal(answerAcpPermission(request.id, "yes"), false);
  const cancelled = requestAcpPermission(params, { timeoutMs: 1000 });
  assert.equal(answerAcpPermission(pendingAcpPermissions()[0].id, null), true);
  assert.equal(await cancelled, null);
});

test("host selection uses bundled ACP, keeps an explicitly requested unavailable provider, and never falls back", async () => {
  let starts = 0;
  const adapters = createAcpHostAdapters({ available: kind => kind === "claude_code", startRun: async () => { starts++; throw new Error("ACP failed"); },
    relayMcpLaunchSpec: () => ({ command: "relay", args: [] }), renderAgentBriefing: () => "Brief" });
  assert.equal(adapters.selectHost("codex").installed, false);
  assert.equal(adapters.selectHost().adapter, "acp");
  await assert.rejects(adapters.launchTurn({ host: { kind: "codex" }, session: { id: "test" }, previousRef: { mode: "codex_app_server" } }), /retired runner/);
  assert.equal(starts, 0);
});

test("MCP transport and provider permission choices retain their meaning", () => {
  assert.deepEqual(acpMcpServers({ relay: { command: "node", args: ["bridge"], env: { A: "B" } } }), [{ name: "relay", command: "node", args: ["bridge"], env: [{ name: "A", value: "B" }] }]);
  assert.equal(acpPermissionMode("codex", { approvalsReviewer: "user", approvalPolicy: "on-request" }), "read-only");
  assert.equal(acpPermissionMode("codex", { approvalPolicy: "never" }), "agent-full-access");
  assert.equal(acpPermissionMode("claude", { permissionMode: "auto" }), "auto");
  assert.deepEqual(relayCompletion('{"forHuman":"Hi","forAgent":"Evidence"}'), { forHuman: "Hi", forAgent: "Evidence" });
  assert.equal(acpModelOption([{ value: "opus[1m]", name: "Opus 5" }], "claude-opus-5"), "opus[1m]");
  assert.equal(acpModelOption([{ value: "opus[1m]", name: "Opus 5" }], "claude-opus-4"), null);
});

test("Task input queues behind a live ACP turn and survives a failed resume", async t => {
  temporaryHome(t);
  let finish;
  const agent = fakeAgent({ onPrompt: input => { finish = input.finish; } });
  let failNext = false;
  const adapters = createHostAdapters({ available: () => true, startRun: options => {
    if (failNext) throw new Error("Resume failed");
    return startAcpRun({ ...options, mode: "agent", clientFactory: agent.factory });
  } });
  const session = { id: "queue-test", taskId: "task-test", host: "codex" };
  const ledger = { sessions: {}, processedMessages: {} };
  const initial = await ensureRuntimeSession({ session, ledger, adapters, messages: [{ id: "first", forHuman: "First" }] });
  await new Promise(resolve => setImmediate(resolve));
  const queued = await ensureRuntimeSession({ session, ledger, adapters, messages: [{ id: "next", forHuman: "Next" }] });
  const queuePath = queued.sessionRef.queuedInputPath;
  assert.equal(fs.existsSync(queuePath), true);
  assert.equal(agent.messages.filter(m => m.method === "session/prompt").length, 1);
  finish();
  await acpWorker(initial.sessionRef.hostSessionId).done;
  failNext = true;
  await assert.rejects(ensureRuntimeSession({ session, ledger, adapters }), /Resume failed/);
  assert.equal(fs.existsSync(queuePath), true);
  assert.deepEqual(ledger.sessions[session.id].sessionRef.queuedMessageIds, ["next"]);
});
