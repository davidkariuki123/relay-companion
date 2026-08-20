import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexAppServerActivity, readCodexAppServerEvents } from "../src/codex-app-server-activity.js";

function writeLog(filePath, messages) {
  fs.writeFileSync(filePath, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

function item(method, turnId, value, at) {
  const timeKey = method === "item/started" ? "startedAtMs" : "completedAtMs";
  return { method, params: { item: value, turnId, [timeKey]: at }, emittedAtMs: at };
}

test("Codex app-server activity keeps native command and MCP semantics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-native-activity-"));
  const logPath = path.join(root, "app-server.log");
  const turnId = "turn-current";
  try {
    writeLog(logPath, [
      { method: "turn/started", params: { turn: { id: turnId } }, emittedAtMs: 1_000 },
      item("item/started", turnId, {
        type: "commandExecution", id: "read-1", command: "sed -n 1,10p brief.md", status: "inProgress",
        commandActions: [{ type: "read", name: "brief.md", path: "/tmp/brief.md" }],
      }, 2_000),
      item("item/completed", turnId, {
        type: "commandExecution", id: "read-1", command: "sed -n 1,10p brief.md", status: "completed",
        commandActions: [{ type: "read", name: "brief.md", path: "/tmp/brief.md" }],
      }, 3_000),
      item("item/started", turnId, {
        type: "commandExecution", id: "list-1", command: "find inbox", status: "inProgress",
        commandActions: [{ type: "listFiles", path: "inbox" }],
      }, 4_000),
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "list-1", turnId, delta: "Scanning...\nTOKEN=do-not-leak\nFound 12 files\n" },
        emittedAtMs: 4_500,
      },
      item("item/completed", turnId, {
        type: "commandExecution", id: "list-1", command: "find inbox", status: "completed",
        commandActions: [{ type: "listFiles", path: "inbox" }],
      }, 5_000),
      item("item/started", turnId, {
        type: "mcpToolCall", id: "mcp-1", server: "relay", tool: "relay_send", status: "inProgress",
        arguments: { title: "Done", apiKey: "do-not-leak" },
      }, 6_000),
      item("item/completed", turnId, {
        type: "mcpToolCall", id: "mcp-1", server: "relay", tool: "relay_send", status: "completed",
        arguments: { title: "Done", apiKey: "do-not-leak" },
      }, 7_000),
      // A different turn in the same persisted log must not bleed into the current turn.
      item("item/completed", "turn-old", {
        type: "commandExecution", id: "old-1", command: "should not appear", status: "completed",
        commandActions: [{ type: "unknown", command: "should not appear" }],
      }, 8_000),
      { method: "turn/completed", params: { turn: { id: turnId, status: "completed" } }, emittedAtMs: 9_000 },
    ]);

    const result = codexAppServerActivity(logPath, { turnId });
    const calls = result.records.filter((record) => record.type === "tool_call");
    assert.deepEqual(calls.map((record) => record.tool), ["mcp__relay__relay_send", "ListFiles", "Read"]);
    assert.match(calls[0].input, /\[redacted\]/);
    assert.equal(calls[1].outputPreview, "Found 12 files");
    assert.equal(calls[1].outputAt, "1970-01-01T00:00:04.500Z");
    assert.doesNotMatch(JSON.stringify(result), /do-not-leak|should not appear/);
    assert.equal(result.records.filter((record) => record.type === "tool_result").length, 3);
    assert.equal(result.startedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(result.terminalAt, "1970-01-01T00:00:09.000Z");
    assert.equal(result.terminalStatus, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main-process hydration reads every turn from one bounded native log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-native-hydration-"));
  const logPath = path.join(root, "app-server.log");
  try {
    writeLog(logPath, [
      { method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 1_000 },
      { id: 9, result: { private: "response rows are not notifications" } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } }, emittedAtMs: 2_000 },
      { method: "turn/started", params: { turn: { id: "turn-2" } }, emittedAtMs: 3_000 },
    ]);
    const events = readCodexAppServerEvents(logPath);
    assert.deepEqual(events.map((event) => event.params.turn.id), ["turn-1", "turn-1", "turn-2"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only a native completed terminal is eligible to mark a run done", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-native-terminal-"));
  const logPath = path.join(root, "app-server.log");
  try {
    writeLog(logPath, [
      { method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 1_000 },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } }, emittedAtMs: 2_000 },
    ]);
    const result = codexAppServerActivity(logPath, { turnId: "turn-1" });
    assert.equal(result.terminalStatus, "interrupted");
    assert.equal(result.terminalAt, "1970-01-01T00:00:02.000Z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an in-progress command carries its latest safe output delta", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-live-output-"));
  const logPath = path.join(root, "app-server.log");
  try {
    writeLog(logPath, [
      { method: "turn/started", params: { turn: { id: "turn-live" } }, emittedAtMs: 1_000 },
      item("item/started", "turn-live", {
        type: "commandExecution", id: "deploy-1", command: "deploy", status: "inProgress",
        commandActions: [{ type: "unknown", command: "deploy" }],
      }, 2_000),
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "deploy-1", turnId: "turn-live", delta: "{\n  \"Status\": \"UPDATE_IN_PROGRESS\"\n}\n" },
        emittedAtMs: 3_000,
      },
    ]);
    const result = codexAppServerActivity(logPath, { turnId: "turn-live" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].type, "tool_call");
    assert.equal(result.records[0].outputPreview, '"Status": "UPDATE_IN_PROGRESS"');
    assert.equal(result.terminalStatus, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the app-server reader exposes the full canonical presentation beside legacy activity records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-native-presentation-"));
  const logPath = path.join(root, "app-server.log");
  try {
    writeLog(logPath, [
      { method: "turn/started", params: { turn: { id: "turn-1" } }, emittedAtMs: 1_000 },
      item("item/completed", "turn-1", { id: "u", type: "userMessage", text: "Please check", status: "completed" }, 1_100),
      item("item/completed", "turn-1", { id: "why", type: "reasoning", summary: ["Finding it"], rawContent: "private", status: "completed" }, 1_200),
      item("item/completed", "turn-1", { id: "plan", type: "plan", text: "Inspect and test", status: "completed" }, 1_300),
      item("item/completed", "turn-1", { id: "note", type: "agentMessage", phase: "commentary", text: "I found it.", status: "completed" }, 1_400),
      item("item/completed", "turn-1", { id: "final", type: "agentMessage", phase: "final_answer", text: "Fixed.", status: "completed" }, 1_500),
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } }, emittedAtMs: 1_600 },
    ]);
    const result = codexAppServerActivity(logPath, { turnId: "turn-1" });
    assert.deepEqual(result.presentation.units.map((unit) => unit.type), ["message", "exploration", "plan", "message", "message"]);
    assert.equal(result.presentation.final.text, "Fixed.");
    assert.equal(result.presentation.final.phase, "final_answer");
    assert.doesNotMatch(JSON.stringify(result.presentation), /private/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
