// Contract tests for the `relay claude-hook` runtime: real CLI process, stdin
// hook-event JSON in, hook JSON (or silence) out. Everything runs against a
// temp RELAY_HOME — the hook never touches the real ~/.claude or
// ~/.relay-companion.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageInjection } from "../src/claude-inject.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "relay.js");

function hookHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-hook-"));
}

function runHook(home, stdinText) {
  const result = spawnSync(process.execPath, [bin, "claude-hook"], {
    encoding: "utf8",
    input: stdinText,
    timeout: 20000,
    env: { ...process.env, RELAY_HOME: home },
  });
  return result;
}

function hookEvent(name, sessionId, extra = {}) {
  return JSON.stringify({
    hook_event_name: name,
    session_id: sessionId,
    cwd: "/tmp/somewhere",
    transcript_path: `/tmp/transcripts/${sessionId}.jsonl`,
    ...extra,
  });
}

test("claude-hook always refreshes the rendezvous file, even with nothing to inject", () => {
  const home = hookHome();
  const result = runHook(home, hookEvent("PostToolUse", "sess-rendezvous"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "no injection -> no output");
  const rendezvous = JSON.parse(
    fs.readFileSync(path.join(home, "claude-sessions", "sess-rendezvous.json"), "utf8"),
  );
  assert.equal(rendezvous.sessionId, "sess-rendezvous");
  assert.equal(rendezvous.cwd, "/tmp/somewhere");
  assert.equal(rendezvous.transcriptPath, "/tmp/transcripts/sess-rendezvous.jsonl");
  assert.equal(rendezvous.eventName, "PostToolUse");
  assert.ok(Number(rendezvous.lastEventAt) > Date.now() - 60000);
});

test("PostToolUse consumes the session's injection exactly once as additionalContext", () => {
  const home = hookHome();
  const { payload } = stageInjection(home, "sess-post", {
    relayId: "relay_abc",
    senderName: "Ada",
    title: "Quarterly numbers",
  });
  const first = runHook(home, hookEvent("PostToolUse", "sess-post"));
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: payload.instruction },
  });
  assert.match(payload.instruction, /relay relay_abc from Ada: 'Quarterly numbers'/);
  assert.match(payload.instruction, /relay_inbox_list/);
  assert.equal(fs.existsSync(path.join(home, "claude-inject", "sess-post.json")), false, "consumed");

  // consume-once: the identical second event stays silent
  const second = runHook(home, hookEvent("PostToolUse", "sess-post"));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
});

test("Stop delivers the injection as a decision:block that wakes a new turn", () => {
  const home = hookHome();
  stageInjection(home, "sess-stop", { relayId: "relay_stop", senderName: "Bo", title: "T" });
  const result = runHook(home, hookEvent("Stop", "sess-stop"));
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /relay relay_stop from Bo/);
});

test("UserPromptSubmit and SessionStart use the additionalContext shape with their own event name", () => {
  for (const eventName of ["UserPromptSubmit", "SessionStart"]) {
    const home = hookHome();
    stageInjection(home, "sess-shape", { relayId: "relay_shape", senderName: "Cy", title: "T" });
    const result = runHook(home, hookEvent(eventName, "sess-shape"));
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, eventName);
    assert.match(out.hookSpecificOutput.additionalContext, /relay relay_shape/);
  }
});

test("a broadcast any.json injection reaches a session with no dedicated file", () => {
  const home = hookHome();
  stageInjection(home, "any", { relayId: "relay_any", senderName: "Di", title: "Broadcast" });
  const result = runHook(home, hookEvent("UserPromptSubmit", "sess-unrelated"));
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /relay relay_any/);
  assert.equal(fs.existsSync(path.join(home, "claude-inject", "any.json")), false);
});

test("unknown hook events stay silent and never consume the pending injection", () => {
  const home = hookHome();
  stageInjection(home, "sess-unknown", { relayId: "relay_keep", senderName: "Em", title: "Keep me" });
  const result = runHook(home, hookEvent("PreToolUse", "sess-unknown"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(
    fs.existsSync(path.join(home, "claude-inject", "sess-unknown.json")),
    "undeliverable event must not burn the injection",
  );
  // the rendezvous still refreshed
  assert.ok(fs.existsSync(path.join(home, "claude-sessions", "sess-unknown.json")));
});

test("broken stdin JSON exits 0 with no output (a broken hook must never break Claude)", () => {
  const home = hookHome();
  const result = runHook(home, "this is { not json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("missing session_id exits 0 silently", () => {
  const home = hookHome();
  const result = runHook(home, JSON.stringify({ hook_event_name: "PostToolUse" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

// ---- 0.1.77: subagent hook events are inert -------------------------------

test("a subagent's hook event neither consumes the injection nor refreshes the rendezvous", () => {
  const home = hookHome();
  stageInjection(home, "sess-parent", { relayId: "relay_sub", senderName: "S", title: "T" });
  const result = runHook(
    home,
    hookEvent("PostToolUse", "sess-parent", {
      transcript_path: "/tmp/transcripts/sess-parent/subagents/workflows/wf_1/agent-abc.jsonl",
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "subagent events must deliver nothing");
  assert.equal(
    fs.existsSync(path.join(home, "claude-sessions", "sess-parent.json")),
    false,
    "subagent activity must not make the parent look like the current session",
  );
  // The injection survives for the REAL main-loop event…
  const main = runHook(home, hookEvent("PostToolUse", "sess-parent"));
  assert.equal(main.status, 0, main.stderr);
  const parsed = JSON.parse(main.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /relay relay_sub/);
});
