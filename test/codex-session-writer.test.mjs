import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendVisibleAssistantTurn, ensureCodexThreadIndexMarker } from "../src/codex-session-writer.js";

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
    assert.deepEqual(context.payload.workspace_roots, [dir]);
    assert.doesNotMatch(fs.readFileSync(sessionPath, "utf8"), /gpt-5\.5/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the synthetic visible turn preserves additional Relay file workspace roots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-writer-roots-"));
  const sessionPath = path.join(dir, "rollout.jsonl");
  const projectRoot = String.raw`C:\Users\Shane\Documents\relay`;
  const relayRoot = String.raw`C:\Users\Shane\.relay-companion\codex-inbox\relay_1`;
  const attachmentRoot = String.raw`C:\Users\Shane\.relay-companion\attachments\relay_1`;
  try {
    fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread_roots" } })}\n`);
    appendVisibleAssistantTurn({
      sessionPath,
      text: "Relay from Sven",
      cwd: projectRoot,
      workspaceRoots: [projectRoot, relayRoot, attachmentRoot, relayRoot],
    });

    const context = appendedTurnContext(sessionPath);
    assert.equal(context.payload.cwd, projectRoot);
    assert.deepEqual(context.payload.workspace_roots, [projectRoot, relayRoot, attachmentRoot]);
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

test("appended letter and index marker continue Codex 0.151's ordinal sequence; unnumbered rollouts stay unnumbered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-writer-ordinals-"));
  try {
    const numbered = path.join(dir, "numbered.jsonl");
    fs.writeFileSync(numbered, [
      JSON.stringify({ timestamp: "2026-09-02T13:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id: "t1" } }),
      JSON.stringify({ timestamp: "2026-09-02T13:00:00.100Z", ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "empty" } }),
      JSON.stringify({ timestamp: "2026-09-02T13:00:01.000Z", ordinal: 2, type: "event_msg", payload: { type: "turn_aborted", turn_id: "empty" } }),
    ].join("\n") + "\n");
    appendVisibleAssistantTurn({ sessionPath: numbered, text: "letter", cwd: dir });
    ensureCodexThreadIndexMarker({ sessionPath: numbered, markerId: "relay_1" });
    const rows = fs.readFileSync(numbered, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "every record carries the next ordinal, marker last");
    assert.equal(rows.at(-1).payload.type, "user_message");
    assert.equal(rows.at(-2).payload.type, "task_complete", "the final Codex-visible turn record is numbered");
    const projected = rows.find((row) => row.payload?.type === "item_completed");
    assert.equal(projected.payload.thread_id, "t1", "the projection record names the thread from session_meta");
    assert.equal(projected.payload.item.type, "AgentMessage", "Codex 0.151 projects the letter from a native item_completed record");
    assert.deepEqual(projected.payload.item.content, [{ type: "Text", text: "letter" }]);
    assert.equal(projected.payload.item.id, rows.find((row) => row.payload?.role === "assistant").payload.id);
    assert.equal(rows.every((row) => Object.keys(row)[1] === "ordinal"), true);

    const legacy = path.join(dir, "legacy.jsonl");
    fs.writeFileSync(legacy, `${JSON.stringify({ type: "session_meta", payload: { id: "t2" } })}\n`);
    appendVisibleAssistantTurn({ sessionPath: legacy, text: "letter", cwd: dir });
    ensureCodexThreadIndexMarker({ sessionPath: legacy, markerId: "relay_2" });
    const legacyRows = fs.readFileSync(legacy, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(legacyRows.some((row) => "ordinal" in row), false, "an older Codex rollout is left unnumbered");
    assert.equal(legacyRows.some((row) => row.payload?.type === "item_completed"), false, "and gets no 0.151 projection record");
    assert.equal(legacyRows[1].payload.type, "user_message", "and keeps the marker right after session_meta");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
