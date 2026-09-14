import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { runClaudeHook } from "../src/claude-hook.js";
import { runCodexHook } from "../src/codex-hook.js";
import retired from "../src/retired-hook.cjs";

for (const [host, run] of [["Claude", runClaudeHook], ["Codex", runCodexHook]]) {
  test(`${host} ignores every hook event without consulting Relay or host state`, async (t) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-retired-hook-"));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop", "Notification"]) {
      await run({ input: Readable.from([JSON.stringify({ hook_event_name, session_id: "session", prompt: "send a private file", transcript_path: "/missing/host/transcript" })]),
        homeDir, accountScope: "account", output: { write() { assert.fail("hook emitted output"); } },
        readRolloutMetaImpl() { assert.fail("hook consulted host metadata"); } });
    }
    assert.deepEqual(fs.readdirSync(homeDir), []);
  });
}

test("retired stdin is discarded in chunks, including malformed and oversized payloads", async () => {
  let chunks = 0;
  const input = Readable.from((function* () { for (let i = 0; i < 64; i++) { chunks++; yield Buffer.alloc(65536, 120); } })());
  await retired.drainRetiredHookInput(input);
  assert.equal(chunks, 64);
  assert.equal(input.destroyed, true);
});

test("a never-ending input cannot keep the retired hook alive", async () => {
  const input = new PassThrough();
  const start = Date.now();
  input.write("{");
  await retired.drainRetiredHookInput(input, { timeoutMs: 25 });
  assert.ok(Date.now() - start < 1000);
  assert.equal(input.destroyed, true);
});

test("an input error is silent and resolves", async () => {
  const input = new PassThrough();
  const done = retired.drainRetiredHookInput(input);
  input.destroy(new Error("broken pipe"));
  await done;
});
