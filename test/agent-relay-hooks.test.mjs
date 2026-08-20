import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import context from "../src/agent-relay-context.cjs";
import { runClaudeHook } from "../src/claude-hook.js";
import { runCodexHook } from "../src/codex-hook.js";

const { recordAgentRelayIndex } = context;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-hooks-"));
}

function item(id, createdAt, title = `Title ${id}`) {
  return { relayId: `relay_${id}`, title, sender: { name: `Sender ${id}` }, createdAt };
}

async function invoke(run, event, options = {}) {
  let text = "";
  const output = options.failWrite
    ? { write(_chunk, callback) { callback(new Error("write failed")); } }
    : { write(chunk, callback) { text += String(chunk); callback(); } };
  await run({
    input: Readable.from([JSON.stringify(event)]),
    output,
    homeDir: options.homeDir,
    accountScope: options.accountScope,
    ...(options.readRolloutMetaImpl ? { readRolloutMetaImpl: options.readRolloutMetaImpl } : {}),
  });
  return text ? JSON.parse(text) : null;
}

test("oversized hook stdin is drained but discarded before JSON processing", async () => {
  const homeDir = tempHome();
  const event = JSON.stringify({
    session_id: "oversized-session",
    hook_event_name: "UserPromptSubmit",
    cwd: "/tmp",
    transcript_path: "/tmp/main.jsonl",
  });
  await runClaudeHook({
    input: Readable.from([event, " ".repeat(1_000_001)]),
    output: { write(_chunk, callback) { callback(); } },
    homeDir,
    accountScope: "oversized-account",
  });
  assert.equal(
    fs.existsSync(path.join(homeDir, "claude-sessions", "oversized-session.json")),
    false,
    "a JSON prefix larger than the cap is not processed",
  );
});

test("Claude delivers RECENT on first prompt and NEW on the next PostToolUse", async () => {
  const homeDir = tempHome();
  const accountScope = "claude-account";
  const now = new Date();
  const old = item("old", now.toISOString());
  recordAgentRelayIndex(homeDir, accountScope, { items: [old] });
  const base = { session_id: "claude-session", cwd: "/tmp", transcript_path: "/tmp/main.jsonl" };
  const first = await invoke(runClaudeHook, { ...base, hook_event_name: "UserPromptSubmit" }, {
    homeDir,
    accountScope,
  });
  assert.match(first.hookSpecificOutput.additionalContext, /RECENT Relay context/);

  const fresh = item("new", new Date(now.getTime() + 1000).toISOString());
  recordAgentRelayIndex(homeDir, accountScope, { items: [fresh, old] }, { nowMs: now.getTime() + 1000 });
  const next = await invoke(runClaudeHook, { ...base, hook_event_name: "PostToolUse" }, {
    homeDir,
    accountScope,
  });
  assert.match(next.hookSpecificOutput.additionalContext, /NEW Relay context/);
  assert.match(next.hookSpecificOutput.additionalContext, /relay_new/);
});

test("Claude rolls a claim back if stdout cannot accept the hook response", async () => {
  const homeDir = tempHome();
  const accountScope = "claude-account";
  recordAgentRelayIndex(homeDir, accountScope, { items: [item("retry", new Date().toISOString())] });
  const event = {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-retry",
    transcript_path: "/tmp/main.jsonl",
  };
  assert.equal(await invoke(runClaudeHook, event, { homeDir, accountScope, failWrite: true }), null);
  const retry = await invoke(runClaudeHook, event, { homeDir, accountScope });
  assert.match(retry.hookSpecificOutput.additionalContext, /relay_retry/);
});

test("Claude subagent events cannot claim the parent session's title context", async () => {
  const homeDir = tempHome();
  const accountScope = "claude-account";
  recordAgentRelayIndex(homeDir, accountScope, { items: [item("protected", new Date().toISOString())] });
  const subagent = await invoke(runClaudeHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: "shared-parent-id",
    transcript_path: "/tmp/shared/subagents/agent-a.jsonl",
  }, { homeDir, accountScope });
  assert.equal(subagent, null);
  const root = await invoke(runClaudeHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: "shared-parent-id",
    transcript_path: "/tmp/shared/main.jsonl",
  }, { homeDir, accountScope });
  assert.match(root.hookSpecificOutput.additionalContext, /relay_protected/);
});

test("Codex protects subagents, emits PostTool additionalContext, and Stop is one-shot", async () => {
  const homeDir = tempHome();
  const accountScope = "codex-account";
  const rootMeta = () => ({ subagent: false, cwd: "/tmp" });
  const now = new Date();
  const old = item("old", now.toISOString());
  recordAgentRelayIndex(homeDir, accountScope, { items: [old] });
  const subagent = await invoke(runCodexHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-session",
    transcript_path: "/tmp/sessions/subagents/agent-a.jsonl",
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta });
  assert.equal(subagent, null);
  const first = await invoke(runCodexHook, {
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-session",
    transcript_path: "/tmp/root.jsonl",
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta });
  assert.match(first.hookSpecificOutput.additionalContext, /RECENT Relay context/);

  const fresh = item("post", new Date(now.getTime() + 1000).toISOString());
  recordAgentRelayIndex(homeDir, accountScope, { items: [fresh, old] }, { nowMs: now.getTime() + 1000 });
  const post = await invoke(runCodexHook, {
    hook_event_name: "PostToolUse",
    session_id: "codex-session",
    transcript_path: "/tmp/root.jsonl",
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta });
  assert.equal(post.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(post.hookSpecificOutput.additionalContext, /relay_post/);

  const stopItem = item("stop", new Date(now.getTime() + 2000).toISOString());
  recordAgentRelayIndex(homeDir, accountScope, { items: [stopItem, fresh, old] }, { nowMs: now.getTime() + 2000 });
  assert.equal(await invoke(runCodexHook, {
    hook_event_name: "Stop",
    session_id: "codex-session",
    transcript_path: "/tmp/root.jsonl",
    stop_hook_active: true,
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta }), null);
  const stop = await invoke(runCodexHook, {
    hook_event_name: "Stop",
    session_id: "codex-session",
    transcript_path: "/tmp/root.jsonl",
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta });
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /relay_stop/);
  assert.equal(await invoke(runCodexHook, {
    hook_event_name: "Stop",
    session_id: "codex-session",
    transcript_path: "/tmp/root.jsonl",
  }, { homeDir, accountScope, readRolloutMetaImpl: rootMeta }), null);
});

test("Codex rolls back failed output and refuses unreadable transcript metadata", async () => {
  const homeDir = tempHome();
  const accountScope = "codex-account";
  recordAgentRelayIndex(homeDir, accountScope, { items: [item("retry", new Date().toISOString())] });
  const event = {
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-retry",
    transcript_path: "/tmp/root.jsonl",
  };
  assert.equal(await invoke(runCodexHook, event, {
    homeDir,
    accountScope,
    readRolloutMetaImpl: () => null,
  }), null);
  assert.equal(await invoke(runCodexHook, event, {
    homeDir,
    accountScope,
    readRolloutMetaImpl: () => ({ subagent: false }),
    failWrite: true,
  }), null);
  const retry = await invoke(runCodexHook, event, {
    homeDir,
    accountScope,
    readRolloutMetaImpl: () => ({ subagent: false }),
  });
  assert.match(retry.hookSpecificOutput.additionalContext, /relay_retry/);
});
