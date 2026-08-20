import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activateCodexMcp,
  hasMcpTool,
  liveToolRequirement,
  requiredLiveHosts,
  shouldRequireLiveTools,
  verifyClaudeMcpRegistration,
} from "../src/setup-activation.js";

class FakeRpcClient {
  constructor({ statusResponse, failMethod = null, failError = new Error("boom") } = {}) {
    this.statusResponse = statusResponse;
    this.failMethod = failMethod;
    this.failError = failError;
    this.calls = [];
    this.notifications = [];
    this.stopped = false;
  }

  async start() {
    this.calls.push({ method: "start" });
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === this.failMethod) throw this.failError;
    if (method === "mcpServerStatus/list") return this.statusResponse;
    return {};
  }

  notify(method, params) {
    this.notifications.push({ method, params });
  }

  async stop() {
    this.stopped = true;
  }
}

test("hasMcpTool detects relay_send in app-server status responses", () => {
  assert.equal(hasMcpTool({ data: [{ name: "relay", tools: { relay_send: { name: "relay_send" } } }] }), true);
  assert.equal(hasMcpTool({ data: [{ name: "relay", tools: { relay_task_status: {} } }] }), false);
  assert.equal(hasMcpTool({ data: [{ name: "other", tools: { relay_send: {} } }] }), false);
});

test("activateCodexMcp treats relay_send catalog visibility as Codex tool-search readiness", async () => {
  const client = new FakeRpcClient({
    statusResponse: { data: [{ name: "relay", tools: { relay_send: { name: "relay_send" } } }] },
  });

  const result = await activateCodexMcp({ client, threadId: "thread_1", timeoutMs: 1000 });

  assert.equal(result.ok, true);
  assert.equal(result.serverCatalogHasTool, true);
  assert.equal(result.currentSessionReady, true);
  assert.equal(result.readinessMode, "deferred_tool_search");
  assert.equal(result.reason, "relay_send_available_via_tool_search");
  assert.equal(result.verifiedTool, "relay_send");
  assert.deepEqual(
    client.calls.map((call) => call.method),
    ["start", "initialize", "config/mcpServer/reload", "mcpServerStatus/list"],
  );
  assert.equal(client.calls[2].params, null);
  assert.equal(client.calls[3].params.threadId, "thread_1");
  assert.equal(client.stopped, true);
});

test("activateCodexMcp reports when relay_send is not visible after reload", async () => {
  const client = new FakeRpcClient({
    statusResponse: { data: [{ name: "node_repl", tools: { js: {} } }] },
  });

  const result = await activateCodexMcp({ client, timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.serverCatalogHasTool, false);
  assert.equal(result.currentSessionReady, false);
  assert.equal(result.reason, "relay_send_not_listed");
  assert.deepEqual(result.serverNames, ["node_repl"]);
});

test("activateCodexMcp classifies missing control socket failures", async () => {
  const error = new Error("codex app-server-control socket No such file");
  const client = new FakeRpcClient({ failMethod: "initialize", failError: error });

  const result = await activateCodexMcp({ client, timeoutMs: 1000 });

  assert.equal(result.ok, true);
  assert.equal(result.currentSessionReady, true);
  assert.equal(result.reason, "relay_registered_for_codex_tool_search");
  assert.equal(result.readinessMode, "deferred_tool_search_unverified");
});

test("shouldRequireLiveTools detects agent-shell setup contexts", () => {
  assert.equal(shouldRequireLiveTools({}), false);
  assert.equal(shouldRequireLiveTools({ CODEX_THREAD_ID: "thread_1" }), true);
  assert.equal(shouldRequireLiveTools({ CLAUDECODE: "1" }), true);
  assert.equal(shouldRequireLiveTools({ CLAUDE_CODE_SESSION_ID: "session_1" }), true);
});

test("requiredLiveHosts scopes readiness to the host running setup", () => {
  assert.deepEqual(requiredLiveHosts({}), []);
  assert.deepEqual(requiredLiveHosts({ CODEX_THREAD_ID: "thread_1" }), ["Codex"]);
  assert.deepEqual(requiredLiveHosts({ CLAUDECODE: "1" }), ["Claude Code"]);
  assert.deepEqual(requiredLiveHosts({ CODEX_THREAD_ID: "thread_1", CLAUDE_CODE_SESSION_ID: "session_1" }), [
    "Codex",
    "Claude Code",
  ]);
});

test("liveToolRequirement does not let Codex readiness satisfy an active Claude setup", () => {
  const activations = [
    { host: "Claude Code", currentSessionReady: false },
    { host: "Codex", currentSessionReady: true },
  ];

  assert.deepEqual(liveToolRequirement({ activations, requiredHosts: ["Claude Code"] }), {
    ok: false,
    readyHosts: ["Codex"],
    missingHosts: ["Claude Code"],
  });
  assert.deepEqual(liveToolRequirement({ activations, requiredHosts: ["Codex"] }), {
    ok: true,
    readyHosts: ["Codex"],
    missingHosts: [],
  });
});

test("verifyClaudeMcpRegistration reports registration without current-session readiness", () => {
  const result = verifyClaudeMcpRegistration({
    runCommand(command, args) {
      assert.equal(command, "claude");
      assert.deepEqual(args, ["mcp", "get", "relay"]);
      return { ok: true, out: "relay\n  command: node" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentSessionReady, false);
  assert.equal(result.reason, "registered_for_new_sessions");
});

test("verifyClaudeMcpRegistration trusts direct ~/.claude.json registration when CLI is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-activation-test-"));
  const configPath = path.join(dir, ".claude.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ mcpServers: { relay: { command: "node", args: ["relay.js", "mcp"] } } }, null, 2)}\n`,
  );

  const result = verifyClaudeMcpRegistration({
    configPath,
    runCommand() {
      return { ok: false, out: "spawn claude ENOENT" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentSessionReady, false);
  assert.equal(result.reason, "registered_in_claude_config");
});
