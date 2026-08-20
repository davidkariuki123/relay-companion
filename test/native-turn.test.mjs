import assert from "node:assert/strict";
import test from "node:test";
import { humanDuration, nativeTurn } from "../src/native-turn.js";

test("native turn timing starts at the newest provider user turn", () => {
  const result = nativeTurn([
    { type: "message", role: "assistant", text: "new final", at: "2026-08-13T09:27:37Z" },
    { type: "tool_result", at: "2026-08-13T09:27:20Z" },
    { type: "tool_call", at: "2026-08-13T09:27:10Z" },
    { type: "message", role: "user", text: "retry", at: "2026-08-13T09:27:00Z" },
    { type: "message", role: "assistant", text: "old final", at: "2026-08-13T02:28:20Z" },
    { type: "message", role: "user", text: "old request", at: "2026-08-13T02:28:13Z" },
  ], { terminalAt: "2026-08-13T09:27:38Z" });
  assert.equal(result.records.length, 4);
  assert.equal(result.startedAt, "2026-08-13T09:27:00Z");
  assert.equal(result.durationMs, 38_000);
});

test("empty or assistant-only legacy transcripts never fabricate timing", () => {
  assert.deepEqual(nativeTurn([]), { records: [], startedAt: null, completedAt: null, durationMs: null });
  const assistantOnly = nativeTurn([{ type: "message", role: "assistant", text: "done", at: "2026-08-13T09:00:00Z" }]);
  assert.equal(assistantOnly.durationMs, null);
});

test("Claude task notifications stay inside the human's current native turn", () => {
  const records = [
    { type: "message", role: "assistant", text: "Reached 30", at: "2026-08-13T18:09:42.000Z" },
    { type: "message", role: "user", text: "<task-notification>count reached 30</task-notification>", at: "2026-08-13T18:09:39.000Z" },
    { type: "tool_call", tool: "Bash", input: "count", at: "2026-08-13T18:09:07.000Z" },
    { type: "message", role: "user", text: "Count to 90", at: "2026-08-13T18:08:48.000Z" },
  ];
  const turn = nativeTurn(records);
  assert.equal(turn.records.length, 4);
  assert.equal(turn.startedAt, "2026-08-13T18:08:48.000Z");
});

test("human durations are compact and never return a fake fallback", () => {
  assert.equal(humanDuration(null), "");
  assert.equal(humanDuration(0), "1 sec");
  assert.equal(humanDuration(53_000), "53 sec");
  assert.equal(humanDuration(68_000), "1 min 8 sec");
  assert.equal(humanDuration(3_720_000), "1 h 2 min");
});
