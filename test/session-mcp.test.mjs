import test from "node:test";
import assert from "node:assert/strict";
import { createMcpSessionContext, handleCall, toolsForAccount } from "../src/mcp.js";

const DEVELOPER_FEATURES = { requests: true, aiSessions: true, connectors: true };

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("session directory tools ship only for developer accounts", () => {
  const names = toolsForAccount(DEVELOPER_FEATURES).map((tool) => tool.name);
  assert.ok(names.includes("relay_ai_sessions"));
  assert.ok(names.includes("relay_ai_session"));
  assert.ok(!names.includes("relay_sessions"), "legacy aliases are callable but not advertised");
  assert.ok(!names.includes("relay_session"), "legacy aliases are callable but not advertised");
});

test("relay_ai_sessions lists local and cloud together and labels ids as AI sessions", async () => {
  let filters;
  const client = {
    async listSessions(value) {
      filters = value;
      return { sessions: [{ id: "rsess_one", provider: "claude" }] };
    },
  };
  const result = await handleCall(client, "relay_ai_sessions", { action: "list", provider: "claude" }, { features: DEVELOPER_FEATURES });
  assert.deepEqual(filters, { provider: "claude", placement: undefined, state: undefined, limit: undefined });
  assert.deepEqual(payload(result), { aiSessions: [{ aiSessionId: "rsess_one", provider: "claude" }] });
});

test("relay_ai_session binds the calling Codex task without exposing a native target id", async () => {
  let request;
  const client = {
    async createSessionOperation(value) {
      request = value;
      return { operation: { id: "rsop_1", state: "accepted" } };
    },
  };
  const sessionContext = createMcpSessionContext({ env: { CODEX_THREAD_ID: "native-calling-thread" } });
  const result = await handleCall(client, "relay_ai_session", {
    action: "send",
    aiSessionId: "rsess_target",
    message: "Please inspect the failure.",
    idempotencyKey: "idem-1",
  }, { features: DEVELOPER_FEATURES, sessionContext });
  assert.equal(payload(result).operation.id, "rsop_1");
  assert.equal(request.sourceProvider, "codex");
  assert.equal(request.sourceNativeId, "native-calling-thread");
  assert.equal(request.sessionId, "rsess_target");
  assert.ok(!("nativeId" in request));
});

test("relay_ai_sessions routes transcript search to the computer holding the AI session", async () => {
  let request;
  const client = {
    async createSessionOperation(value) {
      request = value;
      return { operation: { id: "rsop_search", state: "accepted" } };
    },
    async getSessionOperation() {
      return { operation: { state: "completed", result: { output: { records: [{ type: "message", text: "found" }] } } } };
    },
  };
  const result = await handleCall(client, "relay_ai_sessions", {
    action: "search",
    aiSessionId: "rsess_claude",
    query: "needle",
    limit: 10,
  }, { features: DEVELOPER_FEATURES });
  assert.equal(request.action, "transcript_search");
  assert.equal(request.sessionId, "rsess_claude");
  assert.equal(request.query, "needle");
  assert.match(request.idempotencyKey, /^inspect:/);
  assert.deepEqual(payload(result).records, [{ type: "message", text: "found" }]);
});

test("relay_ai_sessions exposes durable operation state without transcript polling", async () => {
  let received;
  const client = {
    async getSessionOperation(operationId) {
      received = operationId;
      return {
        operation: {
          id: operationId,
          state: "handed_off",
          sourceSessionId: "rsess_source",
          targetSessionId: "rsess_target",
          result: { sessionId: "rsess_target" },
        },
      };
    },
  };
  const result = await handleCall(client, "relay_ai_sessions", {
    action: "operation",
    operationId: "rsop_visible",
  }, { features: DEVELOPER_FEATURES });
  assert.equal(received, "rsop_visible");
  assert.deepEqual(payload(result).operation, {
    id: "rsop_visible",
    state: "handed_off",
    sourceAiSessionId: "rsess_source",
    targetAiSessionId: "rsess_target",
    result: { aiSessionId: "rsess_target" },
  });
});

test("previous MCP names remain callable for clients that cached them", async () => {
  const client = { async listSessions() { return { sessions: [] }; } };
  const result = await handleCall(client, "relay_sessions", { action: "list" }, { features: DEVELOPER_FEATURES });
  assert.deepEqual(payload(result), { aiSessions: [] });
});
