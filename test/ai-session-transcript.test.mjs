import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectAiSession } from "../src/ai-session-transcript.js";

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

test("Claude transcript inspection returns visible content, tools and opaque child agents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-transcript-"));
  const main = path.join(root, "session.jsonl");
  const child = path.join(root, "session", "subagents", "agent-secret-native-id.jsonl");
  writeJsonl(main, [
    { type: "system", message: { content: "hidden system prompt" }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "user", message: { role: "user", content: "Please inspect it" }, timestamp: "2026-01-01T00:00:01Z" },
    { type: "assistant", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private chain of thought", signature: "signed-secret" },
      { type: "text", text: "I am checking." },
      { type: "tool_use", name: "Bash", input: { command: "npm test", apiKey: "must-not-leak" } },
    ] }, timestamp: "2026-01-01T00:00:02Z" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tests passed" }] }, timestamp: "2026-01-01T00:00:03Z" },
  ]);
  writeJsonl(child, [{ type: "assistant", message: { role: "assistant", content: "child result" } }]);
  fs.writeFileSync(child.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore", spawnDepth: 1 }));
  try {
    const target = { id: "rsess_claude", provider: "claude", nativeId: "native-main", state: "idle", nativeRef: { transcriptPath: main } };
    const result = await inspectAiSession(target, { action: "read", limit: 20 });
    const serialized = JSON.stringify(result);
    assert.match(serialized, /Please inspect it/);
    assert.match(serialized, /tests passed/);
    assert.match(serialized, /\[redacted\]/);
    assert.doesNotMatch(serialized, /private chain of thought|signed-secret|hidden system prompt|must-not-leak/);
    const agents = await inspectAiSession(target, { action: "agents" });
    assert.equal(agents.agents.length, 2);
    assert.match(agents.agents[1].id, /^aiagent_[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(agents), /secret-native-id|\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex transcript inspection paginates newest-first and excludes system/encrypted reasoning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-transcript-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  const main = path.join(root, "sessions", "2026", "01", "01", "rollout-main.jsonl");
  writeJsonl(main, [
    { type: "session_meta", payload: { id: "main-native", thread_source: "user", base_instructions: { text: "hidden system" } } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first marker" }, { type: "input_image", image_url: "data:image/png;base64,secret-bytes" }] }, timestamp: "2026-01-01T00:00:01Z" },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "ciphertext", summary: [{ text: "private reasoning" }] } },
    { type: "event_msg", payload: { type: "agent_reasoning", text: "Checking files" }, timestamp: "2026-01-01T00:00:02Z" },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "second marker" }] }, timestamp: "2026-01-01T00:00:03Z" },
  ]);
  try {
    const target = { id: "rsess_codex", provider: "codex", nativeId: "main-native", state: "active", nativeRef: { sessionPath: main } };
    const first = await inspectAiSession(target, { action: "read", limit: 1 });
    assert.match(JSON.stringify(first.records), /second marker/);
    assert.ok(first.nextCursor);
    const second = await inspectAiSession(target, { action: "read", limit: 10, cursor: first.nextCursor });
    assert.match(JSON.stringify(second.records), /first marker|Checking files/);
    assert.match(JSON.stringify(second.records), /"attachments":\[\{"name":"Image","image":true\}\]/);
    const serialized = JSON.stringify([first, second]);
    assert.doesNotMatch(serialized, /ciphertext|private reasoning|hidden system/);
    assert.doesNotMatch(serialized, /secret-bytes/);
    const search = await inspectAiSession(target, { action: "search", query: "first marker" });
    assert.equal(search.records.length, 1);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspection sees records appended after an earlier page was read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-active-transcript-"));
  const main = path.join(root, "active.jsonl");
  writeJsonl(main, [{ type: "assistant", message: { role: "assistant", content: "before" } }]);
  const target = { id: "rsess_active", provider: "claude", nativeId: "active", state: "active", nativeRef: { transcriptPath: main } };
  try {
    assert.match(JSON.stringify(await inspectAiSession(target, { action: "read" })), /before/);
    fs.appendFileSync(main, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "after" } })}\n`);
    assert.match(JSON.stringify(await inspectAiSession(target, { action: "read" })), /after/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
