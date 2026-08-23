import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  codexExecEventStatus,
  codexOneShotArgs,
  codexRelayCompletion,
  runCodexOneShot,
} from "../src/codex-one-shot.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("anonymous Codex runs use the real non-interactive CLI without discarding user setup", () => {
  const args = codexOneShotArgs({
    model: "gpt-5.6-sol",
    effort: "high",
    fullAccess: false,
    schemaPath: "C:\\relay\\response.schema.json",
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--ephemeral", "--skip-git-repo-check"]);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("--ignore-rules"), false);
  assert.equal(args.includes("--sandbox"), false, "approve-for-me owns the reviewed workspace-write policy");
  assert.equal(args.includes("workspace-write"), false);
  assert.equal(args.includes("--approve-for-me"), true, "configured tools get automatic approval review instead of blocking headless work");
  assert.equal(args.includes("gpt-5.6-sol"), true);
  assert.equal(args.includes('model_reasoning_effort="high"'), true);
  assert.equal(args.at(-1), "-", "the large chat prompt is piped over stdin");
});

test("full-access Codex runs select the danger sandbox without the approval reviewer", () => {
  const args = codexOneShotArgs({ fullAccess: true });
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
  assert.equal(args.includes("--approve-for-me"), false);
});

test("Codex JSONL events become visible chat progress", () => {
  assert.equal(codexExecEventStatus({ type: "turn.started" }), "Codex has started working on your laptop.");
  assert.equal(codexExecEventStatus({
    type: "item.started",
    item: { type: "mcp_tool_call", tool: "mcp__agentos__list_agents" },
  }), "Codex is using agentos · list_agents.");
  assert.equal(codexExecEventStatus({
    type: "item.completed",
    item: { type: "agent_message", text: "I checked the configuration and found the mismatch." },
  }), "I checked the configuration and found the mismatch.");
});

test("the final Codex answer populates both Relay payloads with a plain-text fallback", () => {
  assert.deepEqual(codexRelayCompletion('{"forHuman":"Fixed it.","forAgent":"Changed the timeout and passed tests."}'), {
    forHuman: "Fixed it.",
    forAgent: "Changed the timeout and passed tests.",
  });
  assert.deepEqual(codexRelayCompletion("A normal final answer."), {
    forHuman: "A normal final answer.",
    forAgent: "A normal final answer.",
  });
  assert.equal(codexRelayCompletion(""), null);
});

test("a silent configured tool cannot leave the Relay response stuck forever", async () => {
  const child = fakeChild();
  await assert.rejects(runCodexOneShot({
    prompt: "work",
    schemaPath: "response.schema.json",
    stallTimeoutMs: 30,
    runTimeoutMs: 1_000,
    heartbeatIntervalMs: 10,
    spawnProcess: () => child,
  }), /stopped producing activity/);
  assert.equal(child.killed, true);
});
