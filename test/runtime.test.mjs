import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const COMPANION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_BRIDGE_ENTRYPOINT = path.join(COMPANION_ROOT, "src", "mcp-bridge.js");

test("task runtime ledger persists sessions and processed messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");

  const ledger = runtime.readTaskLedger();
  assert.deepEqual(ledger.sessions, {});
  assert.deepEqual(ledger.processedMessages, {});

  ledger.sessions.tsess_1 = {
    relaySessionId: "tsess_1",
    taskId: "task_1",
    host: "codex",
    state: "queued",
    sessionRef: { mode: "queued_for_host" },
  };
  runtime.markMessagesProcessed(ledger, [{ id: "tmsg_1", taskId: "task_1" }]);
  runtime.writeTaskLedger(ledger);

  const reread = runtime.readTaskLedger();
  assert.equal(reread.sessions.tsess_1.taskId, "task_1");
  assert.equal(reread.processedMessages.tmsg_1.taskId, "task_1");
});

test("freshMessages filters already processed task messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ledger = { sessions: {}, processedMessages: { tmsg_1: { taskId: "task_1" } } };
  const fresh = runtime.freshMessages(ledger, [
    { id: "tmsg_1", taskId: "task_1" },
    { id: "tmsg_2", taskId: "task_1" },
  ]);
  assert.deepEqual(fresh.map((m) => m.id), ["tmsg_2"]);
});

test("freshMessages reprocesses a relay when a human answer updates it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ledger = {
    sessions: {},
    processedMessages: { tmsg_1: { taskId: "task_1", updatedAt: "2026-06-29T10:00:00.000Z" } },
  };
  const fresh = runtime.freshMessages(ledger, [
    { id: "tmsg_1", taskId: "task_1", updatedAt: "2026-06-29T10:05:00.000Z" },
  ]);
  assert.deepEqual(fresh.map((m) => m.id), ["tmsg_1"]);
});

test("orderTaskMessages delivers task input in chronological order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ordered = runtime.orderTaskMessages([
    { id: "tmsg_3", taskId: "task_1", createdAt: "2026-06-29T10:03:00.000Z" },
    { id: "tmsg_1", taskId: "task_1", createdAt: "2026-06-29T10:01:00.000Z" },
    { id: "tmsg_2", taskId: "task_1", createdAt: "2026-06-29T10:02:00.000Z" },
  ]);
  assert.deepEqual(ordered.map((message) => message.id), ["tmsg_1", "tmsg_2", "tmsg_3"]);
});

test("renderAgentBriefing includes answered human questions as run input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_1",
        taskId: "task_1",
        kind: "relay_to_human",
        senderLabel: "David's agent",
        forHuman: "Which slot?",
        humanResponse: {
          mode: "required_before_resume",
          question: "Which slot?",
          status: "answered",
          answerMarkdown: "Thursday at 15:00.",
        },
      },
    ],
  });
  assert.match(briefing, /Human answered Relay question tmsg_1/);
  assert.match(briefing, /Thursday at 15:00/);
  assert.match(briefing, /Relay task agent session id: tsess_1/);
  assert.doesNotMatch(briefing, /senderAgentSessionId|relay_to_human|relay_answer_human_question/);
});

test("renderAgentBriefing marks human_message as human-typed words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_hm_1",
        taskId: "task_1",
        kind: "human_message",
        senderLabel: "David Kahuha",
        senderUserId: "usr_kahuha",
        forHuman: "Vegetarian options please, Kloof Street side.",
      },
    ],
  });
  assert.match(briefing, /Message from David Kahuha \(typed by them directly\)/);
  assert.match(briefing, /Vegetarian options please/);
  assert.match(briefing, /human words, not agent output/);
});

test("messagesForSession never echoes the owner's own human_message into their run", async () => {
  const daemon = await import("../src/task-daemon.js");
  const ownSession = { id: "tsess_1", taskId: "task_1", ownerUserId: "usr_sender" };
  const otherSession = { id: "tsess_2", taskId: "task_1", ownerUserId: "usr_recipient" };
  const messages = [
    { id: "tmsg_hm", taskId: "task_1", kind: "human_message", senderUserId: "usr_sender", forHuman: "hi" },
    { id: "tmsg_agent", taskId: "task_1", kind: "relay_to_agent", senderUserId: "usr_sender", forHuman: "data" },
    { id: "tmsg_other_task", taskId: "task_2", kind: "human_message", senderUserId: "usr_sender", forHuman: "x" },
  ];
  assert.deepEqual(daemon.messagesForSession(ownSession, messages).map((m) => m.id), ["tmsg_agent"]);
  assert.deepEqual(daemon.messagesForSession(otherSession, messages).map((m) => m.id), ["tmsg_hm", "tmsg_agent"]);
});

test("renderAgentBriefing keeps legacy scoped results readable without retired MCP calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_result_1",
        taskId: "task_1",
        kind: "result_notice",
        senderLabel: "David's agent",
        forHuman: "## Coffee coordinated\n\nDavid will send two options.",
      },
    ],
  });
  assert.match(briefing, /Scoped final task result tmsg_result_1/);
  assert.match(briefing, /Present it directly in your normal answer/);
  assert.match(briefing, /scoped to your human only/);
  assert.doesNotMatch(briefing, /share_results_with_human|relay_to_agent|relay_to_human|relay_end_task/);
});

test("Electron provider sessions run Relay MCP as Node without rewriting the persistent launcher", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const spec = runtime.relayMcpLaunchSpec({
    execPath: "/Applications/Relay.app/Contents/MacOS/Relay",
    bridgePath: "/Applications/Relay.app/Contents/Resources/app/src/mcp-bridge.js",
    electron: true,
    env: {
      RELAY_API_URL: "https://api.example.test",
      RELAY_DEVICE_TOKEN: "test-token",
    },
  });

  assert.deepEqual(spec, {
    command: "/Applications/Relay.app/Contents/MacOS/Relay",
    args: ["--max-old-space-size=32", "/Applications/Relay.app/Contents/Resources/app/src/mcp-bridge.js"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      RELAY_API_URL: "https://api.example.test",
      RELAY_DEVICE_TOKEN: "test-token",
    },
  });
  assert.doesNotMatch(spec.args[0], /mcp-launcher\.cjs$/);
});


function session(overrides = {}) { return { id: "tsess_1", taskId: "task_1", host: "codex", state: "queued", sessionRef: {}, ...overrides }; }
