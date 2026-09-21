import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeNativeTask, executionRecord } from "../src/native-task-execute.js";
import { claudeWorkspaceTrusted, executionEnabled, executionPreferences, setExecutionPreferences, nativeProgress, selectCodexModel, submitNativeTurn } from "../src/native-task-launch.js";

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
  const session = { provider: "claude", nativeId: "dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16", url: "claude://resume?session=dfed5caa-b1dc-4e87-8e19-2ea0bd49bb16" };
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

test("production, staging and ordinary accounts cannot reach the transport", async (t) => {
  const { args, calls } = fixture(t);
  for (const environment of ["production", "staging"]) await assert.rejects(executeNativeTask({ ...args, env: { RELAY_ENV: environment } }), /developer accounts on dev/);
  await assert.rejects(executeNativeTask({ ...args, config: { ...args.config, user: { ...args.config.user, isDeveloper: false } } }), /developer accounts on dev/);
  assert.deepEqual(calls, []);
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
  const { args, calls } = fixture(t);
  args.nativeApi.nativeSessionReady = async () => { throw new Error("not ready"); };
  await assert.rejects(executeNativeTask(args), /not ready/);
  assert.equal(calls.includes("submit"), false);
  args.nativeApi.nativeSessionReady = async () => ({});
  await executeNativeTask(args);
  assert.equal(calls.filter((c) => c === "prepare").length, 1);
  assert.equal(calls.filter((c) => c === "submit").length, 1);
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
