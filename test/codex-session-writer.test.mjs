import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendVisibleAssistantTurn } from "../src/codex-session-writer.js";

function appendedTurnContext(sessionPath) {
  return fs.readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((row) => row.type === "turn_context");
}

test("the synthetic visible turn preserves the selected Codex model and effort", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-writer-"));
  const sessionPath = path.join(dir, "rollout.jsonl");
  try {
    fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread_1" } })}\n`);
    appendVisibleAssistantTurn({
      sessionPath,
      text: "Relay from Sven",
      cwd: dir,
      model: "gpt-5.6-sol",
      effort: "high",
    });

    const context = appendedTurnContext(sessionPath);
    assert.equal(context.payload.model, "gpt-5.6-sol");
    assert.equal(context.payload.effort, "high");
    assert.equal(context.payload.collaboration_mode.settings.model, "gpt-5.6-sol");
    assert.equal(context.payload.collaboration_mode.settings.reasoning_effort, "high");
    assert.doesNotMatch(fs.readFileSync(sessionPath, "utf8"), /gpt-5\.5/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the synthetic visible turn defaults to GPT-5.6 Sol with high effort", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-writer-default-"));
  const sessionPath = path.join(dir, "rollout.jsonl");
  try {
    fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread_2" } })}\n`);
    appendVisibleAssistantTurn({ sessionPath, text: "Relay from Sven", cwd: dir });

    const context = appendedTurnContext(sessionPath);
    assert.equal(context.payload.model, "gpt-5.6-sol");
    assert.equal(context.payload.effort, "high");
    assert.equal(context.payload.collaboration_mode.settings.model, "gpt-5.6-sol");
    assert.equal(context.payload.collaboration_mode.settings.reasoning_effort, "high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
