import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  codexExecEventStatus,
  codexOneShotAppServerArgs,
  codexOneShotArgs,
  codexRelayCompletion,
  partialCodexRelayHuman,
  runCodexAppServerOneShot,
  runCodexOneShot,
} from "../src/codex-one-shot.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("anonymous Codex runs use the real non-interactive CLI without discarding user setup", () => {
  const args = codexOneShotArgs({
    model: "gpt-5.6-sol",
    effort: "high",
    fullAccess: false,
    schemaPath: "C:\\relay\\response.schema.json",
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--ephemeral", "--skip-git-repo-check"]);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("--ignore-rules"), false);
  assert.equal(args.includes("--sandbox"), false, "approve-for-me owns the reviewed workspace-write policy");
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("--approve-for-me"), true, "configured tools get automatic approval review instead of blocking headless work");
  assert.equal(args.includes("gpt-5.6-sol"), true);
  assert.equal(args.includes('model_reasoning_effort="high"'), true);
  assert.equal(args.some((arg) => String(arg).startsWith("mcp_servers.")), false,
    "Relay does not invent an incomplete MCP server table when the user has not configured that server");
  assert.equal(args.at(-1), "-", "the large chat prompt is piped over stdin");
});

test("ephemeral app-server defaults never invent an MCP transport", () => {
  assert.deepEqual(codexOneShotAppServerArgs(), ["app-server"]);
});

test("one-shot MCP timeouts are bounded config layers, not server exclusions", () => {
  const args = codexOneShotArgs({ mcpToolTimeouts: { agentos: 30, "bad.name": 10, relay: 0 } });
  assert.equal(args.includes("mcp_servers.agentos.tool_timeout_sec=30"), true);
  assert.equal(args.some((arg) => String(arg).includes("bad.name")), false);
  assert.equal(args.some((arg) => String(arg).includes("mcp_servers.relay")), false);
  assert.equal(args.includes("--ignore-user-config"), false);
});

test("ephemeral app-server runs keep user setup and bound only configured MCP timeouts", () => {
  const args = codexOneShotAppServerArgs({ mcpToolTimeouts:{ agentos:30, "bad.name":10, relay:0 } });
  assert.deepEqual(args, ["app-server", "--config", "mcp_servers.agentos.tool_timeout_sec=30"]);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("--ignore-rules"), false);
});

test("full-access Codex runs select the danger sandbox without the approval reviewer", () => {
  const args = codexOneShotArgs({ fullAccess: true });
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
  assert.equal(args.includes("--approve-for-me"), false);
});

test("Codex JSONL events become visible chat progress", () => {
  assert.equal(codexExecEventStatus({ type: "turn.started" }), "Codex has started working on your laptop.");
  assert.equal(codexExecEventStatus({
    type: "item.started",
    item: { type: "mcp_tool_call", tool: "mcp__agentos__list_agents" },
  }), "Codex is using agentos · list_agents.");
  assert.equal(codexExecEventStatus({
    type: "item.completed",
    item: { type: "agent_message", text: "I checked the configuration and found the mismatch." },
  }), "I checked the configuration and found the mismatch.");
});

test("the final Codex answer populates both Relay payloads with a plain-text fallback", () => {
  assert.deepEqual(codexRelayCompletion('{"forHuman":"Fixed it.","forAgent":"Changed the timeout and passed tests."}'), {
    forHuman: "Fixed it.",
    forAgent: "Changed the timeout and passed tests.",
  });
  assert.deepEqual(codexRelayCompletion("A normal final answer."), {
    forHuman: "A normal final answer.",
    forAgent: "A normal final answer.",
  });
  assert.equal(codexRelayCompletion(""), null);
});

test("structured answer deltas expose only the already-authored human payload", () => {
  assert.equal(partialCodexRelayHuman('{"forHuman":"Hello\\nShane\\u0021'), "Hello\nShane!");
  assert.equal(partialCodexRelayHuman('{"forAgent":"private"'), "");
});

test("app-server one-shots are ephemeral, auto-reviewed, structured, and stream human text", async () => {
  const requests = [];
  const statuses = [];
  let clientOptions;
  const result = await runCodexAppServerOneShot({
    prompt:"Say hello",
    model:"gpt-5.6-sol",
    effort:"high",
    stallTimeoutMs:1_000,
    runTimeoutMs:2_000,
    heartbeatIntervalMs:1_000,
    onEvent:(_event, status) => { if (status) statuses.push(status); },
    appServerFactory:(options) => {
      clientOptions = options;
      return {
        async start() {},
        async stop() {},
        async request(method, params) {
          requests.push({ method, params });
          if (method === "thread/start") return { thread:{ id:"thread_ephemeral" } };
          if (method === "turn/start") {
            queueMicrotask(() => {
              options.onNotification({
                method:"item/agentMessage/delta",
                params:{ threadId:"thread_ephemeral", turnId:"turn_1", delta:'{"forHuman":"Hello from Codex' },
              });
              options.onNotification({
                method:"item/agentMessage/delta",
                params:{ threadId:"thread_ephemeral", turnId:"turn_1", delta:'!","forAgent":"Useful evidence."}' },
              });
              options.onNotification({
                method:"item/completed",
                params:{
                  threadId:"thread_ephemeral",
                  turnId:"turn_1",
                  item:{ type:"agentMessage", text:'{"forHuman":"Hello from Codex!","forAgent":"Useful evidence."}' },
                },
              });
              options.onNotification({
                method:"turn/completed",
                params:{ threadId:"thread_ephemeral", turn:{ id:"turn_1", status:"completed" } },
              });
            });
            return { turn:{ id:"turn_1" } };
          }
          throw new Error(`Unexpected request: ${method}`);
        },
      };
    },
  });
  const threadStart = requests.find((entry) => entry.method === "thread/start")?.params;
  const turnStart = requests.find((entry) => entry.method === "turn/start")?.params;
  assert.equal(threadStart.ephemeral, true);
  assert.equal(threadStart.approvalsReviewer, "auto_review");
  assert.equal(threadStart.sandbox, "workspace-write");
  assert.equal(threadStart.model, "gpt-5.6-sol");
  assert.equal(turnStart.effort, "high");
  assert.deepEqual(turnStart.outputSchema.required, ["forHuman", "forAgent"]);
  assert.equal(clientOptions.notificationOptOutMethods.includes("item/agentMessage/delta"), false);
  assert.equal(statuses.some((status) => status.startsWith("Codex is answering: Hello from Codex")), true);
  assert.equal(result.threadId, "thread_ephemeral");
  assert.equal(result.finalMessage, '{"forHuman":"Hello from Codex!","forAgent":"Useful evidence."}');
});

test("visible app-server runs keep the native thread and retain the live event lifecycle", async () => {
  const requests = [];
  const callbacks = [];
  const statuses = [];
  const result = await runCodexAppServerOneShot({
    prompt:"Inspect the Relay chat",
    model:"gpt-5.6-terra",
    effort:"medium",
    ephemeral:false,
    title:"Relay @Codex",
    stallTimeoutMs:1_000,
    runTimeoutMs:2_000,
    heartbeatIntervalMs:1_000,
    onThreadStarted:async ({ threadId }) => { callbacks.push(["thread", threadId]); },
    onTurnStarted:async ({ threadId, turnId }) => { callbacks.push(["turn", threadId, turnId]); },
    onEvent:(_event, status) => { if (status) statuses.push(status); },
    appServerFactory:(options) => ({
      async start() {},
      async stop() {},
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread:{ id:"thread_visible" } };
        if (method === "thread/name/set") return {};
        if (method === "turn/start") {
          queueMicrotask(() => {
            options.onNotification({
              method:"item/started",
              params:{ threadId:"thread_visible", turnId:"turn_visible", item:{ type:"commandExecution" } },
            });
            options.onNotification({
              method:"item/completed",
              params:{
                threadId:"thread_visible",
                turnId:"turn_visible",
                item:{ type:"agentMessage", text:'{"forHuman":"It works.","forAgent":"Native session retained."}' },
              },
            });
            options.onNotification({
              method:"turn/completed",
              params:{ threadId:"thread_visible", turn:{ id:"turn_visible", status:"completed" } },
            });
          });
          return { turn:{ id:"turn_visible" } };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    }),
  });
  const threadStart = requests.find((entry) => entry.method === "thread/start")?.params;
  assert.equal(Object.hasOwn(threadStart, "ephemeral"), false);
  assert.equal(threadStart.threadSource, "user");
  assert.deepEqual(requests.find((entry) => entry.method === "thread/name/set")?.params, {
    threadId:"thread_visible",
    name:"Relay @Codex",
  });
  assert.deepEqual(callbacks, [
    ["thread", "thread_visible"],
    ["turn", "thread_visible", "turn_visible"],
  ]);
  assert.equal(statuses.includes("Codex is running a command."), true);
  assert.equal(result.threadId, "thread_visible");
  assert.equal(result.finalMessage, '{"forHuman":"It works.","forAgent":"Native session retained."}');
});

test("an unsupported app-server can fall back before a turn, but an ambiguous turn timeout cannot", async () => {
  await assert.rejects(runCodexAppServerOneShot({
    prompt:"work",
    appServerFactory:() => ({
      async start() {},
      async stop() {},
      async request(method) {
        if (method === "thread/start") throw new Error("unknown field ephemeral");
      },
    }),
  }), (error) => error.relayExecFallbackSafe === true);

  await assert.rejects(runCodexAppServerOneShot({
    prompt:"work",
    appServerFactory:() => ({
      async start() {},
      async stop() {},
      async request(method) {
        if (method === "thread/start") return { thread:{ id:"thread_1" } };
        throw new Error("Timed out waiting for turn/start");
      },
    }),
  }), (error) => error.relayExecFallbackSafe !== true);
});

test("a silent configured tool cannot leave the Relay response stuck forever", async () => {
  const child = fakeChild();
  await assert.rejects(runCodexOneShot({
    prompt: "work",
    schemaPath: "response.schema.json",
    stallTimeoutMs: 30,
    runTimeoutMs: 1_000,
    heartbeatIntervalMs: 10,
    spawnProcess: () => child,
  }), /stopped producing activity/);
  assert.equal(child.killed, true);
});
