import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentHarness,
  agentIdentity,
  claudeAppFromEntrypoint,
  codexAppFromOriginator,
  codexRolloutFacts,
  lastClaudeModel,
} from "../src/agent-identity.js";
import { createMcpSessionContext, handleCall, rememberCallingClient } from "../src/mcp.js";

test("host app words map to the app a person sees", () => {
  assert.equal(claudeAppFromEntrypoint("claude-desktop"), "desktop");
  assert.equal(claudeAppFromEntrypoint("cli"), "cli");
  assert.equal(claudeAppFromEntrypoint("claude-vscode"), "ide");
  assert.equal(claudeAppFromEntrypoint("remote"), "web");
  assert.equal(claudeAppFromEntrypoint("sdk-ts"), "sdk");
  assert.equal(claudeAppFromEntrypoint(""), "");
  assert.equal(codexAppFromOriginator("Codex Desktop"), "desktop");
  assert.equal(codexAppFromOriginator("codex_exec"), "exec");
  assert.equal(codexAppFromOriginator("codex_cli_rs"), "cli");
  assert.equal(codexAppFromOriginator("codex_vscode"), "ide");
  assert.equal(codexAppFromOriginator("granular_relay_companion"), "relay");
});

test("Conductor and Cursor are named as the app around the agent", () => {
  assert.equal(agentHarness({ env: { CONDUCTOR_WORKSPACE_NAME: "lisbon" } }), "conductor");
  assert.equal(agentHarness({ cwd: "/Users/jane/conductor/workspaces/relay/lisbon" }), "conductor");
  assert.equal(agentHarness({ hostName: "codex-local" }), "conductor");
  assert.equal(agentHarness({ hostName: "cursor-vscode" }), "cursor");
  assert.equal(agentHarness({ hostName: "claude-code", env: { CURSOR_TRACE_ID: "abc" } }), "cursor");
  assert.equal(agentHarness({ hostName: "windsurf" }), "windsurf");
  assert.equal(agentHarness({ hostName: "claude-code", cwd: "/Users/jane/code/relay" }), "");
  assert.equal(agentHarness({ hostName: "codex-mcp-client" }), "");
});

test("an agent inside Conductor or Cursor reports where the person sits", async () => {
  const conductor = createMcpSessionContext({ env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CONDUCTOR_WORKSPACE_PATH: "/w" }, cwd: "/w" });
  rememberCallingClient({ name: "claude-code", version: "2.1" }, conductor);
  assert.deepEqual(
    await agentIdentity(conductor, { sourceProvider: "claude", sourceNativeId: "s" }, { findClaudeTranscript: async () => "" }),
    { host: "claude-code/2.1", app: "desktop", harness: "conductor" },
  );
  const cursor = createMcpSessionContext({ env: {} });
  rememberCallingClient({ name: "cursor-vscode", version: "1.0.0" }, cursor);
  assert.deepEqual(await agentIdentity(cursor, {}), { host: "cursor-vscode/1.0.0", app: "ide", harness: "cursor" });
});

test("the newest assistant model is read from a transcript slice, skipping synthetic turns", () => {
  const text = [
    '{"type":"user","message":{"role":"user"}}',
    '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5"}}',
    '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5"}}',
    '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>"}}',
    '{"type":"attachment"}',
  ].join("\n");
  assert.equal(lastClaudeModel(text), "claude-opus-5-5");
  // A slice can begin mid-line; that fragment never breaks the read.
  assert.equal(lastClaudeModel(`odel":"broken"}}\n${text}`), "claude-opus-5-5");
  assert.equal(lastClaudeModel(""), "");
  const facts = codexRolloutFacts(
    '{"type":"session_meta","payload":{"originator":"Codex Desktop","source":"vscode"}}',
    '{"type":"turn_context","payload":{"model":"gpt-6"}}\n{"type":"event_msg"}\n{"type":"turn_context","payload":{"model":"gpt-6-luna"}}',
  );
  assert.deepEqual(facts, { originator: "Codex Desktop", model: "gpt-6-luna" });
});

test("agent identity combines the MCP host, the app and the transcript's model, briefly cached", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-agent-identity-"));
  const transcript = path.join(dir, "s1.jsonl");
  await fs.writeFile(transcript, '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5"}}\n');
  const context = createMcpSessionContext({ env: { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, cwd: dir });
  rememberCallingClient({ name: "claude-code", version: "2.1.289" }, context);
  let lookups = 0;
  const findClaudeTranscript = async (cwd, id) => { lookups += 1; assert.equal(cwd, dir); assert.equal(id, "s1"); return transcript; };
  const identity = await agentIdentity(context, { sourceProvider: "claude", sourceNativeId: "s1" }, { findClaudeTranscript, nowMs: 1000 });
  assert.deepEqual(identity, { host: "claude-code/2.1.289", app: "desktop", model: "claude-opus-5-5" });
  await agentIdentity(context, { sourceProvider: "claude", sourceNativeId: "s1" }, { findClaudeTranscript, nowMs: 2000 });
  assert.equal(lookups, 1, "cached within the session");

  const rollout = path.join(dir, "rollout.jsonl");
  await fs.writeFile(rollout, '{"type":"session_meta","payload":{"originator":"codex_exec"}}\n{"type":"turn_context","payload":{"model":"gpt-6-luna"}}\n');
  const codexContext = createMcpSessionContext({ env: {}, cwd: dir });
  const codex = await agentIdentity(codexContext, { sourceProvider: "codex", sourceNativeId: "t1" }, { findCodexRollout: async () => rollout });
  assert.deepEqual(codex, { app: "exec", model: "gpt-6-luna" });

  // A missing transcript leaves the identity smaller, never broken.
  const bare = await agentIdentity(createMcpSessionContext({ env: {} }), { sourceProvider: "claude", sourceNativeId: "gone" }, {
    findClaudeTranscript: async () => { throw new Error("no projects dir"); },
  });
  assert.deepEqual(bare, {});
  await fs.rm(dir, { recursive: true, force: true });
});

test("agent reads carry the agent's identity, and the check-in reports what it showed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-agent-reads-"));
  const context = createMcpSessionContext({ env: { CODEX_THREAD_ID: "thread-1", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, cwd: dir });
  rememberCallingClient({ name: "codex-mcp-client", version: "0.9" }, context);
  const seen = [];
  const presented = [];
  const client = {
    async fetchRelayPackets(ids, provenance) { seen.push(["packets", provenance]); return { packets: {} }; },
    async thread(threadId, provenance) { seen.push(["thread", provenance]); return { threadId, items: [] }; },
    async chat(chatId, page, provenance) { seen.push(["chat", provenance]); return { chatId, items: [] }; },
    async reportAgentPresented(body, provenance) { presented.push({ body, provenance }); return { ok: true }; },
  };
  const options = { sessionContext: context, features: { requests: true, topics: false } };
  await handleCall(client, "relay_inbox_list", { relayIds: ["relay_a"] }, options);
  await handleCall(client, "relay_thread_fetch", { threadId: "relay_a" }, options);
  await handleCall(client, "relay_chat_fetch", { chatId: "chat_1" }, options);
  assert.deepEqual(seen.map(([kind]) => kind), ["packets", "thread", "chat"]);
  for (const [, provenance] of seen) {
    assert.equal(provenance.clientName, "relay-local-mcp");
    assert.equal(provenance.sourceProvider, "codex");
    assert.equal(provenance.nativeSessionId, "thread-1");
    assert.equal(provenance.agent.host, "codex-mcp-client/0.9");
    assert.equal(provenance.agent.app, "desktop");
  }

  context.sessionDigest = {
    take: () => ({ relays: [{ relayId: "relay_new" }, { relayId: "not-a-relay" }], topics: [] }),
    subscribedTopics: () => [],
  };
  const checkIn = JSON.parse((await handleCall(client, "relay_session_updates", {}, options)).content[0].text);
  assert.equal(checkIn.readStateChanged, false);
  for (let i = 0; i < 20 && !presented.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presented.length, 1);
  assert.deepEqual(presented[0].body, { via: "session_updates", relayIds: ["relay_new"] });
  assert.equal(presented[0].provenance.clientName, "relay-local-mcp");

  // A failed report never reaches the agent.
  context.sessionDigest = { take: () => ({ relays: [{ relayId: "relay_next" }], topics: [] }), subscribedTopics: () => [] };
  const failing = { ...client, async reportAgentPresented() { throw new Error("offline"); } };
  const quiet = await handleCall(failing, "relay_session_updates", {}, options);
  assert.equal(quiet.isError, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});
