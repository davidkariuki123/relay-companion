import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  commandAvailable,
  claudeRelayCompletionFromTranscript,
  claudeSessionNeedsCatalogRestart,
  codexRecoveryWaitMs,
  ensureAgentRunProviderAuthentication,
  materializeRelayOperation,
  publishAndFind,
  resolveClaudeBackgroundAgent,
  runSessionDirectoryOnce,
  waitForClaudeCompletion,
} from "../src/session-controller.js";

test("an owned Claude run pauses for the encrypted mobile sign-in response and then resumes", async () => {
  const appended = [];
  const envelope = { version:1, ephemeralPublicKey:"A".repeat(43), nonce:"B".repeat(16), ciphertext:"C".repeat(23) };
  let submitted;
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });
  const auth = {
    id:"pa_0123456789012345678901",
    challenge:Promise.resolve({
      kind:"provider_auth", authId:"pa_0123456789012345678901", provider:"claude",
      providerLabel:"Anthropic", status:"waiting_for_user",
      authorizeUrl:"https://claude.com/cai/oauth/authorize?state=safe", replyPublicKey:"D".repeat(43),
      expiresAt:"2099-08-30T12:00:00.000Z",
    }),
    completion,
    submit(value) { submitted = value; complete({ ok:true }); },
  };
  let stateVersion = 0;
  const client = {
    async chatAgentSession() { return { attempt:1, stateVersion:++stateVersion }; },
    async appendChatAgentSessionEvents(_sessionId, input) {
      appended.push(input.events[0]);
      return { session:{ lastEventSequence:appended.length } };
    },
    async chatAgentSessionEvents() {
      return { events:[{
        sequence:2, type:"session.provider_auth_submitted",
        payload:{ kind:"provider_auth_submission", authId:auth.id, envelope },
      }] };
    },
  };
  assert.equal(await ensureAgentRunProviderAuthentication({
    client,
    provider:"claude",
    input:{ agentSessionId:"ras_mobile" },
    inspect:async () => ({ connected:false }),
    begin:() => auth,
  }), true);
  assert.deepEqual(submitted, envelope);
  assert.deepEqual(appended.map((event) => event.type), ["session.needs_input", "session.running"]);
  assert.equal(appended[0].visibility, "owner");
});

test("a remote Slack action materializes the exact Relay instead of inventing a second prompt", async () => {
  const staged = [];
  const opened = [];
  const receipts = [];
  const operation = {
    id: "rsop_mobile_handoff",
    kind: "start",
    input: { provider: "codex", relayMessageId: "msg_clicked" },
  };
  const handled = await materializeRelayOperation({
    async fetchRelay(id) {
      assert.equal(id, "msg_clicked");
      return {
        packet: {
          id,
          kind: "message",
          title: "Exact handoff",
          sender: { name: "Sven" },
          forHuman: "For David",
          forAgent: "Complete context",
          createdAt: "2026-08-27T10:00:00.000Z",
        },
        attachmentUrls: { att_1: "https://files.test/att_1" },
      };
    },
  }, operation, "claim_secret", {
    load: async () => ({
      stagePlainRelayItem(value) { staged.push(value); },
      async openRelay(value) {
        opened.push(value);
        return { url: "codex://threads/thread_exact" };
      },
    }),
    async recordEvidence(_client, operationId, claimToken, state, result) {
      receipts.push({ operationId, claimToken, state, result });
    },
  });
  assert.equal(handled, true);
  assert.equal(staged[0].packet.id, "msg_clicked");
  assert.equal(staged[0].packet.forAgent, "Complete context");
  assert.deepEqual(opened, [{ id: "msg_clicked", host: "codex", forceFresh: true, log: opened[0].log }]);
  assert.deepEqual(receipts.map((receipt) => receipt.state), ["handed_off", "applied", "completed"]);
  assert.ok(receipts.every((receipt) => receipt.result.nativeSessionId === "thread_exact"));
});

test("ordinary session starts remain on the ordinary controller path", async () => {
  assert.equal(await materializeRelayOperation({}, {
    id: "rsop_ordinary",
    kind: "start",
    input: { provider: "codex", message: "Start new work" },
  }, "claim_secret", {
    load: async () => { throw new Error("must not load materializer"); },
  }), false);
});

test("recovered Codex turns only wait through their remaining activity window", () => {
  const now = 10 * 60 * 1000;
  assert.equal(codexRecoveryWaitMs(now - 60_000, { now }), 4 * 60 * 1000);
  assert.equal(codexRecoveryWaitMs(now - 6 * 60 * 1000, { now }), 0);
  assert.equal(codexRecoveryWaitMs(0, { now }), 0);
});

test("Windows controllers discover Codex and Claude through where.exe", () => {
  const calls = [];
  const available = commandAvailable("codex", {
    platform: "win32",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, error: undefined };
    },
  });
  assert.equal(available, true);
  assert.deepEqual(calls, [{
    command: "where.exe",
    args: ["codex"],
    options: { stdio: "ignore", windowsHide: true },
  }]);
});

test("missing controller commands are reported as unavailable", () => {
  assert.equal(commandAvailable("codex", {
    platform: "win32",
    spawn: () => ({ status: null, error: new Error("not found") }),
  }), false);
});

test("Claude transcript completion returns the native final answer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-completion-"));
  const transcript = path.join(root, "complete.jsonl");
  fs.writeFileSync(transcript, [
    { type:"user", uuid:"prompt", origin:{ kind:"human" }, message:{ role:"user", content:"Say hello" }, timestamp:"2026-08-29T10:00:00.000Z" },
    { type:"assistant", uuid:"answer", parentUuid:"prompt", message:{ role:"assistant", stop_reason:"end_turn", content:[{ type:"text", text:"Hello from Claude." }] }, timestamp:"2026-08-29T10:00:01.000Z" },
    { type:"result", subtype:"success", result:"Hello from Claude.", stop_reason:"end_turn", timestamp:"2026-08-29T10:00:02.000Z" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const result = claudeRelayCompletionFromTranscript(transcript, "claude-complete");
  assert.equal(result.completion?.body, "Hello from Claude.");
  assert.equal(result.error, "");
});

test("Claude transcript completion preserves authentication failure truth", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-auth-"));
  const transcript = path.join(root, "failed.jsonl");
  fs.writeFileSync(transcript, [
    { type:"user", uuid:"prompt", origin:{ kind:"human" }, message:{ role:"user", content:"Say hello" }, timestamp:"2026-08-29T10:00:00.000Z" },
    { type:"assistant", uuid:"failure", parentUuid:"prompt", error:"authentication_failed", message:{ role:"assistant", stop_reason:"stop_sequence", content:[{ type:"text", text:"Login expired · Please run /login" }] }, timestamp:"2026-08-29T10:00:01.000Z" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const result = claudeRelayCompletionFromTranscript(transcript, "claude-failed");
  assert.equal(result.completion, null);
  assert.match(result.error, /Login expired/);
});

test("owned-agent controller inbox is checked before the native session inventory", async () => {
  const calls = [];
  const result = await runSessionDirectoryOnce({
    client:{
      async sessionControllerInbox() {
        calls.push("inbox");
        return { operations:[] };
      },
      async publishSessionObservations(observations, controller) {
        calls.push(["publish", observations, controller]);
        return { sessions:[] };
      },
    },
    discover:() => {
      calls.push("discover");
      return [];
    },
    controller:() => ({ deviceId:"device_1" }),
  });
  assert.equal(calls[0], "inbox");
  assert.equal(calls[1], "discover");
  assert.deepEqual(calls[2], ["publish", [], { deviceId:"device_1" }]);
  assert.deepEqual(result, { sessions:[], queuedOperations:0 });
});

test("visible owned-agent sessions are claimed before native session discovery", async () => {
  const calls = [];
  const operation = {
    id:"operation_visible_agent",
    input:{ oneShot:false, agentRunRelayId:"relay_agent_response" },
  };
  await runSessionDirectoryOnce({
    client:{
      async sessionControllerInbox() {
        calls.push("inbox");
        return { operations:[operation] };
      },
      async claimSessionOperation(id) {
        calls.push(["claim", id]);
        return { terminal:true };
      },
      async publishSessionObservations(observations) {
        calls.push(["publish", observations]);
        return { sessions:[] };
      },
    },
    discover:() => {
      calls.push("discover");
      return [];
    },
    controller:() => ({ deviceId:"device_1" }),
  });
  assert.deepEqual(calls.slice(0, 3), [
    "inbox",
    ["claim", "operation_visible_agent"],
    "discover",
  ]);
});

test("Claude permission-mode metadata drift never restarts a catalog-current live task", () => {
  const liveRegistration = { pid: 50_097 };
  assert.equal(claudeSessionNeedsCatalogRestart({
    permissionMode: "manual",
    relayMcpCatalogVersion: 2,
  }, liveRegistration), false);
});

test("a live Claude task restarts only for a one-time stale MCP catalog migration", () => {
  const liveRegistration = { pid: 50_097 };
  assert.equal(claudeSessionNeedsCatalogRestart({ relayMcpCatalogVersion: 1 }, liveRegistration), true);
  assert.equal(claudeSessionNeedsCatalogRestart({ relayMcpCatalogVersion: 1 }, null), false);
});

test("Claude background launch resolves the provider-issued session id rather than the ignored requested id", () => {
  const agents = [
    {
      id: "3c79bc6d",
      sessionId: "3c79bc6d-3b89-4f7f-aef8-64e0c991c542",
      name: "Relay proof",
      cwd: "/work/relay",
      startedAt: 10_000,
    },
  ];
  const resolved = resolveClaudeBackgroundAgent(agents, {
    output: "warning: --bg manages the session id; ignoring --session-id\nbackgrounded · 3c79bc6d · Relay proof",
    title: "Relay proof",
    cwd: "/work/relay",
    resumeSessionId: "9edea3b3-b334-4a59-8161-7c97989e9fe0",
    startedAfter: 9_000,
  });
  assert.equal(resolved?.sessionId, "3c79bc6d-3b89-4f7f-aef8-64e0c991c542");
});

test("Claude recovery can resolve an already-finished background session by title and cwd", () => {
  const resolved = resolveClaudeBackgroundAgent([
    { sessionId: "older", name: "Relay proof", cwd: "/work/relay", startedAt: 5_000 },
    { sessionId: "actual", name: "Relay proof", cwd: "/work/relay", startedAt: 12_000 },
  ], { title: "Relay proof", cwd: "/work/relay", startedAfter: 9_000 });
  assert.equal(resolved?.sessionId, "actual");
});

test("Claude recovery skips a newer stale registration with no durable transcript", () => {
  const durable = new Set(["actual"]);
  const resolved = resolveClaudeBackgroundAgent([
    { sessionId: "actual", name: "Relay proof", cwd: "/work/relay", startedAt: 12_000 },
    { sessionId: "stale", name: "Relay proof", cwd: "/work/relay", startedAt: 13_000 },
  ], {
    title: "Relay proof",
    cwd: "/work/relay",
    startedAfter: 9_000,
    acceptAgent: (agent) => durable.has(agent.sessionId),
  });
  assert.equal(resolved?.sessionId, "actual");
});

test("native session publication sends only the target row and retries a transient timeout", async () => {
  const calls = [];
  const client = {
    async publishSessionObservations(observations) {
      calls.push(observations);
      if (calls.length === 1) throw new DOMException("timed out", "TimeoutError");
      return { sessions: [{ id: "rsess_target", nativeId: "native-target" }] };
    },
  };
  const found = await publishAndFind(client, "native-target", {
    discover: () => [
      { provider: "claude", nativeId: "native-target" },
      { provider: "codex", nativeId: "unrelated" },
    ],
    cache: () => {},
    retryDelayMs: 0,
  });
  assert.equal(found?.id, "rsess_target");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].map((row) => row.nativeId), ["native-target"]);
});

test("a fast background Claude turn completes from direct transcript growth plus idle registry state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-controller-"));
  const registryDir = path.join(root, "sessions");
  const socketPath = path.join(root, "claude.sock");
  const transcriptPath = path.join(root, "session.jsonl");
  const sessionId = "b457c91e-ff65-4333-892e-4908c09b07dd";
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", sessionId })}\n`);
  const server = process.platform === "win32" ? null : net.createServer(() => {});
  if (server) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } else {
    // Windows cannot bind a Unix-domain socket at a filesystem path. This test
    // only needs the registry's socket-exists signal; no client connects.
    fs.writeFileSync(socketPath, "");
  }
  fs.writeFileSync(path.join(registryDir, "claude.json"), JSON.stringify({
    sessionId,
    pid: process.pid,
    status: "idle",
    messagingSocketPath: socketPath,
    updatedAt: Date.now(),
  }));
  const previous = process.env.RELAY_CLAUDE_SESSION_REGISTRY_DIR;
  process.env.RELAY_CLAUDE_SESSION_REGISTRY_DIR = registryDir;
  try {
    await waitForClaudeCompletion(sessionId, {
      transcriptPath,
      timeoutMs: 1_000,
      quietIdleMs: 20,
      pollMs: 10,
    });
  } finally {
    if (previous === undefined) delete process.env.RELAY_CLAUDE_SESSION_REGISTRY_DIR;
    else process.env.RELAY_CLAUDE_SESSION_REGISTRY_DIR = previous;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(true);
});
