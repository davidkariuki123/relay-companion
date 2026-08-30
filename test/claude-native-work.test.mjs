import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeNativeEventsToWorkEvents,
  readClaudeNativeTranscriptRows,
} from "../src/claude-native-work-feed.js";
import {
  createWorkConversation,
  replayWorkEvents,
  workPresentationSnapshot,
} from "../src/work-conversation.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-native-work.json", import.meta.url), "utf8"));

function view(rows, options = {}) {
  const events = claudeNativeEventsToWorkEvents(rows, {
    sessionId: options.sessionId || fixture.sessionId,
    ownerAlive: options.ownerAlive ?? false,
    expectedActive: options.expectedActive ?? false,
  });
  const state = replayWorkEvents(events, createWorkConversation({ provider: "claude", sessionId: options.sessionId || fixture.sessionId }));
  return { events, state, view: workPresentationSnapshot(state, Date.parse("2026-08-15T13:00:00.000Z")) };
}

function units(presentation) {
  return presentation.turns.flatMap((turn) => turn.units || []);
}

test("Claude native golden transcript preserves public semantics and rejects private protocol", () => {
  const result = view(fixture.rows);
  const all = units(result.view);
  const serialized = JSON.stringify(result.view);
  assert.deepEqual(all.filter((unit) => unit.placement === "user").map((unit) => unit.text), ["Please verify it too."]);
  assert.deepEqual(all.filter((unit) => unit.placement === "final").map((unit) => unit.text), ["Verified."]);
  assert.ok(all.some((unit) => unit.phase === "commentary" && /checking/i.test(unit.text)));
  assert.ok(all.some((unit) => unit.type === "activity" && unit.activity?.kind === "read" && unit.activity?.status === "completed"));
  assert.ok(all.some((unit) => unit.type === "activity" && /README\.md/.test(unit.activity?.object || "")), "safe Read detail is preserved");
  assert.ok(all.some((unit) => unit.type === "retry"));
  assert.equal(all.filter((unit) => unit.type === "compaction").length, 1);
  for (const hidden of ["relay-documents", "relay-runtime-contract", "private chain", "private-signature", "secret output", "compact summary", "STALE SIDECHAIN", "Bearer private"] ) {
    assert.equal(serialized.includes(hidden), false, `${hidden} leaked`);
  }
});

test("latest last-prompt leaf selects the canonical parentUuid branch", () => {
  const rows = [
    { type: "user", uuid: "root", parentUuid: null, origin: { kind: "human" }, message: { role: "user", content: "Choose the real branch." }, timestamp: "2026-08-15T10:00:00.000Z" },
    { type: "assistant", uuid: "canonical", parentUuid: "root", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Canonical answer." }] }, timestamp: "2026-08-15T10:00:01.000Z" },
    { type: "assistant", uuid: "stale", parentUuid: "root", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "STALE LATER ANSWER." }] }, timestamp: "2026-08-15T10:00:02.000Z" },
    { type: "last-prompt", lastPrompt: "Choose the real branch.", leafUuid: "canonical", sessionId: "dag" },
    { type: "result", subtype: "success", result: "Canonical answer.", stop_reason: "end_turn", timestamp: "2026-08-15T10:00:03.000Z" },
  ];
  const result = view(rows, { sessionId: "dag" });
  const serialized = JSON.stringify(result.view);
  assert.match(serialized, /Canonical answer/);
  assert.doesNotMatch(serialized, /STALE LATER ANSWER/);
});

test("overlapping stream pages dedupe by native coordinate while identical real deltas survive", () => {
  const human = { type: "user", uuid: "human", origin: { kind: "human" }, message: { role: "user", content: "Stream." }, timestamp: "2026-08-15T10:00:00.000Z" };
  const first = { type: "stream_event", requestId: "req", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } }, timestamp: "2026-08-15T10:00:01.000Z" };
  const second = { type: "stream_event", requestId: "req", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } }, timestamp: "2026-08-15T10:00:02.000Z" };
  const result = view([human, first, second, { ...first }], { sessionId: "overlap", ownerAlive: true, expectedActive: true });
  assert.ok(units(result.view).some((unit) => unit.text === "AA"));
  assert.equal(units(result.view).some((unit) => unit.text === "AAA"), false);
});

test("tool_result user records resolve the exact tool_use and never become human turns", () => {
  const result = view(fixture.rows);
  const toolStarts = result.events.filter((event) => event.method === "item/started" && event.params?.item?.type === "claudeToolUse");
  const toolEnds = result.events.filter((event) => event.method === "item/completed" && event.params?.item?.type === "claudeToolUse");
  assert.equal(toolStarts.length, 1);
  assert.equal(toolEnds.length, 1);
  assert.equal(toolStarts[0].params.item.toolUseId, "read-1");
  assert.equal(toolEnds[0].params.item.nativeResult.toolUseId, "read-1");
  assert.equal(units(result.view).some((unit) => /secret output/.test(unit.text || "")), false);
});

test("stream-only result reconciles partial deltas into one strict final", () => {
  const rows = [
    { type: "user", uuid: "human", origin: { kind: "human" }, message: { role: "user", content: "Run it." }, timestamp: "2026-08-15T10:00:00.000Z" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "Do" } }, timestamp: "2026-08-15T10:00:01.000Z" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ne." } }, timestamp: "2026-08-15T10:00:02.000Z" },
    { type: "result", subtype: "success", is_error: false, result: "Done.", stop_reason: "end_turn", timestamp: "2026-08-15T10:00:03.000Z" },
  ];
  const result = view(rows, { sessionId: "stream-only" });
  assert.deepEqual(units(result.view).filter((unit) => unit.placement === "final").map((unit) => unit.text), ["Done."]);
});

test("result does not settle a turn while native background work remains pending", () => {
  const rows = [
    { type: "user", uuid: "human", origin: { kind: "human" }, message: { role: "user", content: "Delegate it." }, timestamp: "2026-08-15T10:00:00.000Z" },
    { type: "assistant", uuid: "tool", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "Check" } }] }, timestamp: "2026-08-15T10:00:01.000Z" },
    { type: "user", uuid: "started", sourceToolAssistantUUID: "tool", toolUseResult: { backgroundTaskId: "bg-1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "agent-1", content: "running", is_error: false }] }, timestamp: "2026-08-15T10:00:02.000Z" },
    { type: "result", subtype: "success", is_error: false, result: "Started.", stop_reason: "end_turn", timestamp: "2026-08-15T10:00:03.000Z" },
  ];
  const result = view(rows, { sessionId: "background", ownerAlive: true, expectedActive: true });
  assert.equal(result.view.turns.at(-1).active, true);
  assert.deepEqual(units(result.view).filter((unit) => unit.placement === "final"), []);
});

test("detached active ownership is a terminal failure, not synthetic completion", () => {
  const rows = fixture.rows.filter((row) => row.type !== "result" && row.uuid !== "final" && row.uuid !== "sidechain");
  const result = view(rows, { sessionId: "detached", ownerAlive: false, expectedActive: true });
  assert.equal(result.view.turns.at(-1).active, false);
  assert.ok(units(result.view).some((unit) => unit.type === "error" && /no longer|restart/i.test(unit.text)));
  assert.deepEqual(units(result.view).filter((unit) => unit.placement === "final"), []);
});

test("a successful provider end_turn stays complete when the Task remains open", () => {
  const rows = [
    { type:"user", uuid:"human", origin:{ kind:"human" }, message:{ role:"user", content:"Explain it." }, timestamp:"2026-08-15T10:00:00.000Z" },
    { type:"assistant", uuid:"answer", parentUuid:"human", message:{ role:"assistant", stop_reason:"end_turn", content:[{ type:"text", text:"It is complete." }] }, timestamp:"2026-08-15T10:00:01.000Z" },
    { type:"result", subtype:"success", is_error:false, result:"It is complete.", stop_reason:"end_turn", timestamp:"2026-08-15T10:00:02.000Z" },
  ];
  const result = view(rows, { sessionId:"task-still-open", ownerAlive:false, expectedActive:true });
  assert.equal(result.view.turns.at(-1).status, "completed");
  assert.equal(result.view.turns.at(-1).final.text, "It is complete.");
  assert.equal(units(result.view).some((unit) => /no longer connected/i.test(unit.text || "")), false);
});

test("assistant-shaped provider failures render once as errors", () => {
  const result = view([{
    type: "assistant",
    uuid: "assistant-auth-failure",
    timestamp: "2026-08-15T20:40:03.314Z",
    error: "authentication_failed",
    message: {
      id: "msg-auth-failure",
      stop_reason: "stop_sequence",
      content: [{
        type: "text",
        text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      }],
    },
  }], { sessionId: "auth-failure-session", ownerAlive: false, expectedActive: false });
  const all = units(result.view);
  const matching = all.filter((unit) => /Failed to authenticate/.test(unit.text || ""));

  assert.equal(matching.length, 1);
  assert.equal(matching[0].type, "error");
  assert.equal(all.some((unit) => unit.type === "message" && unit.role === "assistant"), false);
  assert.equal(result.view.turns.some((turn) => turn.finalEligible), false);
});

test("bounded transcript reader preserves chronological valid JSONL tail", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-claude-native-"));
  const file = path.join(dir, "session.jsonl");
  try {
    await fsp.writeFile(file, [1, 2, 3, 4].map((value) => JSON.stringify({ type: "system", value })).join("\n"));
    assert.deepEqual(readClaudeNativeTranscriptRows(file, { maxRows: 2 }).map((row) => row.value), [3, 4]);
    assert.deepEqual(readClaudeNativeTranscriptRows(path.join(dir, "missing.jsonl")), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
