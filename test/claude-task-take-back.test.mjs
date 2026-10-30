import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CLAUDE_MOVED_NOTICE, claudeTurnStartedAfter, nativeProgress, nativeTranscriptRows, retireUnstartedClaudeConversation } from "../src/native-task-launch.js";
import { BACKGROUND_STATUS, executeNativeTask, executionRecordPath, markMovedToBackground, nativeExecutionStatus } from "../src/native-task-execute.js";

function claudeFixture(t, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-take-back-"));
  const previous = { home: process.env.CLAUDE_HOME, config: process.env.RELAY_CONFIG_DIR };
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.RELAY_CONFIG_DIR = path.join(root, "relay");
  const children = [];
  t.after(() => {
    for (const child of children) { try { child.kill(); } catch {} }
    if (previous.home === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = previous.home;
    if (previous.config === undefined) delete process.env.RELAY_CONFIG_DIR; else process.env.RELAY_CONFIG_DIR = previous.config;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeId = randomUUID();
  const transcript = path.join(root, "claude", "projects", "work", `${nativeId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, rows.map((row) => JSON.stringify({ sessionId: nativeId, ...row })).join("\n") + "\n");
  // The Claude process Desktop runs for this conversation.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  fs.mkdirSync(path.join(root, "claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "claude", "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: nativeId, entrypoint: "claude-desktop", kind: "interactive" }));
  return { session: { provider: "claude", nativeId, cwd: root, transcript }, child };
}
const seed = { type: "assistant", uuid: "seed", entrypoint: "relay-execute", message: { role: "assistant", content: [{ type: "text", text: "[Relay created this conversation.]" }] } };
const task = { type: "user", uuid: "msg_1", parentUuid: "seed", message: { role: "user", content: "the Task" } };

test("a Task Claude holds is taken back: its process is stopped and the conversation says where the Task went", async (t) => {
  const { session, child } = claudeFixture(t, [seed, task]);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  assert.deepEqual(await retireUnstartedClaudeConversation(session, { messageId: "msg_1" }), { retired: true });
  await exited;
  const rows = nativeTranscriptRows(session);
  const notice = rows.at(-1);
  assert.equal(notice.type, "assistant");
  assert.equal(notice.parentUuid, "msg_1");
  assert.equal(notice.entrypoint, "relay-execute");
  assert.equal(notice.message.content[0].text, CLAUDE_MOVED_NOTICE);
  assert.equal(claudeTurnStartedAfter(rows, "msg_1"), false, "Relay's notice is not the model starting the Task");
  assert.notEqual(nativeProgress(session, { messageId: "msg_1" }), "Claude finished a turn · continue in Claude Code");
});

test("a Task the model answered while Relay stopped it counts as started, with no notice", async (t) => {
  const answer = { type: "assistant", uuid: "a1", parentUuid: "msg_1", message: { role: "assistant", content: [{ type: "text", text: "On it" }] } };
  const { session } = claudeFixture(t, [seed, task, answer]);
  assert.deepEqual(await retireUnstartedClaudeConversation(session, { messageId: "msg_1" }), { started: true });
  assert.equal(nativeTranscriptRows(session).some((row) => row.message?.content?.[0]?.text === CLAUDE_MOVED_NOTICE), false);
});

test("a process that will not stop leaves the Task where it is", async (t) => {
  const { session } = claudeFixture(t, [seed, task]);
  assert.deepEqual(await retireUnstartedClaudeConversation(session, { messageId: "msg_1", timeoutMs: 300, kill: () => {} }), {});
  assert.equal(nativeTranscriptRows(session).length, 2, "nothing was written");
});

test("Execute on this computer only reports a Task moved to the background, and never sends it anywhere", async (t) => {
  claudeFixture(t, [seed]);
  const config = { apiUrl: "https://dev-api.example.test", user: { id: "user-test" } };
  const file = executionRecordPath(config, "relay-test");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ relayId: "relay-test", phase: "accepted", session: { provider: "claude", nativeId: "x", url: "claude://resume?session=x" } }));
  markMovedToBackground(config, "relay-test");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.phase, "background");
  assert.equal(nativeExecutionStatus(record), BACKGROUND_STATUS);
  const touched = [];
  const nativeApi = new Proxy({}, { get: (_target, name) => (...args) => { touched.push(name); return undefined; } });
  const client = new Proxy({}, { get: (_target, name) => async () => { touched.push(`client.${String(name)}`); return {}; } });
  const result = await executeNativeTask({ id: "relay-test", config, client, nativeApi, open: async () => touched.push("open"), choose: async () => null, consent: async () => true });
  assert.deepEqual(result, { ok: true, message: BACKGROUND_STATUS });
  assert.deepEqual(touched, []);
});
