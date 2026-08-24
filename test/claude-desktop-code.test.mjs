import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  claudeDesktopCodeWorkerSnapshot,
  claudeDesktopCodeNativeSnapshot,
  claudeBackgroundTaskUpdate,
  claudePendingBackgroundTasksFromTranscript,
  createClaudeDesktopCodeSession,
  continueClaudeDesktopCodeSession,
  relayTaskMcpConfig,
  subscribeClaudeDesktopCodeWorker,
} from "../src/claude-desktop-code.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fakeChild(onSpawn) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.setEncoding("utf8");
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk; });
  onSpawn?.(child, () => input);
  return child;
}

test("Claude Code launch uses the supported subscription-authenticated CLI without copying credentials", async () => {
  const cwd = "/tmp/Relay";
  const sessionId = "11111111-2222-4333-8444-555555555555";
  let invocation = null;
  let adopted = null;
  let inputText = "";
  const resultPromise = createClaudeDesktopCodeSession({
    cwd,
    title: "Relay Code proof",
    content: "Do the work",
    sessionId,
    command: "/opt/homebrew/bin/claude",
    homedir: "/Users/test",
    spawn(command, args, options) {
      const child = fakeChild((_child, readInput) => {
        setImmediate(() => {
          inputText = readInput();
          _child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
          _child.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: "ok" })}\n`);
          setTimeout(() => _child.emit("close", 0), 80);
        });
      });
      invocation = { command, args, options };
      return child;
    },
    adopt: async (value) => { adopted = value; return { attempted: true }; },
  });
  const result = await resultPromise;
  assert.equal(invocation.command, "/opt/homebrew/bin/claude");
  assert.deepEqual(invocation.args.slice(0, 7), ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--effort", "high"]);
  assert.ok(invocation.args.includes("--session-id"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--name"), invocation.args.indexOf("--name") + 2), ["--name", "Relay Code proof"]);
  assert.equal(invocation.args.includes("--bg"), false);
  assert.equal(invocation.options.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined);
  assert.equal(invocation.options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(invocation.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(invocation.options.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(invocation.options.stdio.length, 3);
  const input = JSON.parse(inputText.trim());
  assert.equal(input.type, "user");
  assert.equal(input.session_id, sessionId);
  assert.match(input.message.content, /^Relay Code proof\n\nDo the work$/);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.desktopSessionId, `local_${sessionId}`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(adopted.sessionId, sessionId);
  assert.equal(adopted.importIntoDesktop, false, "settlement materializes but never opens Desktop");
});

test("native background task records distinguish turn results from task completion", () => {
  assert.deepEqual(claudeBackgroundTaskUpdate({
    type: "user",
    toolUseResult: { backgroundTaskId: "bg_123" },
    message: { content: [{ type: "tool_result", content: "Command running in background with ID: bg_123." }] },
  }), { started: ["bg_123"], finished: [] });
  assert.deepEqual(claudeBackgroundTaskUpdate({
    type: "queue-operation",
    content: "<task-notification>\n<task-id>bg_123</task-id>\n<status>completed</status>\n</task-notification>",
  }), { started: [], finished: ["bg_123"] });
});

test("Desktop Code stays alive across an interim result and closes after the background task's final turn", async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-background-"));
  const cwd = path.join(homedir, "work");
  fs.mkdirSync(cwd);
  const sessionId = "dddddddd-eeee-4fff-8000-111111111111";
  const transcriptDir = path.join(homedir, ".claude", "projects", String(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
  const transcript = path.join(transcriptDir, `${sessionId}.jsonl`);
  fs.mkdirSync(transcriptDir, { recursive: true });
  let child = null;
  let adopted = null;
  await createClaudeDesktopCodeSession({
    sessionId,
    cwd,
    content: "Run a background task and finish it",
    command: "/Applications/Claude.app/bundled/claude",
    homedir,
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn() {
      child = fakeChild((worker) => setImmediate(() => {
        worker.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
        const started = {
          type: "user",
          toolUseResult: { backgroundTaskId: "bg_native" },
          message: { content: [{ type: "tool_result", content: "Command running in background with ID: bg_native." }] },
        };
        fs.writeFileSync(transcript, `${JSON.stringify(started)}\n`);
        worker.stdout.write(`${JSON.stringify(started)}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "result", result: "still running" })}\n`);
      }));
      child.stdin.once("finish", () => child.emit("close", 0));
      return child;
    },
    adopt: async (value) => { adopted = value; },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(child.stdin.writableEnded, false, "the interim result must not kill Claude's background supervisor");
  assert.deepEqual([...claudePendingBackgroundTasksFromTranscript(transcript)], ["bg_native"]);

  const completed = {
    type: "queue-operation",
    content: "<task-notification>\n<task-id>bg_native</task-id>\n<status>completed</status>\n</task-notification>",
  };
  fs.appendFileSync(transcript, `${JSON.stringify(completed)}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "result", result: "done" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual([...claudePendingBackgroundTasksFromTranscript(transcript)], []);
  assert.equal(adopted.sessionId, sessionId);
  assert.equal(adopted.importIntoDesktop, false);
});

test("a Relay Task worker strips legacy capability flags without mutating user settings", () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-mcp-test-"));
  const file = path.join(homedir, ".claude.json");
  const original = JSON.stringify({
    mcpServers: {
      relay: { type: "stdio", command: "/trusted/node", args: ["/trusted/relay.js", "mcp", "--messages-only"], env: {} },
      privateOtherServer: { type: "http", url: "https://private.example/mcp", headers: { Authorization: "secret" } },
    },
  });
  fs.writeFileSync(file, original);
  const config = JSON.parse(relayTaskMcpConfig(homedir));
  assert.deepEqual(config, { mcpServers: {
    relay: { type: "stdio", command: "/trusted/node", args: ["/trusted/relay.js", "mcp"], env: {} },
  } });
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("an Electron-owned Claude worker runs this Relay runtime as Node", () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-electron-mcp-test-"));
  const config = JSON.parse(relayTaskMcpConfig(homedir, {
    execPath: "/Applications/Relay.app/Contents/MacOS/Relay",
    electron: true,
    binPath: "/Applications/Relay.app/Contents/Resources/app/bin/relay.js",
    env: { RELAY_CONFIG_DIR: "/Users/test/.relay" },
  }));
  assert.deepEqual(config, { mcpServers: { relay: {
    type: "stdio",
    command: "/Applications/Relay.app/Contents/MacOS/Relay",
    args: ["/Applications/Relay.app/Contents/Resources/app/bin/relay.js", "mcp"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      RELAY_CONFIG_DIR: "/Users/test/.relay",
    },
  } } });
});

test("Desktop Code receives the account-driven Relay MCP config", async () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-mcp-launch-"));
  fs.writeFileSync(path.join(homedir, ".claude.json"), JSON.stringify({ mcpServers: {
    relay: { command: "/trusted/node", args: ["/trusted/relay.js", "mcp", "--messages-only"] },
  } }));
  let invocation = null;
  await createClaudeDesktopCodeSession({
    cwd: "/tmp/Relay",
    content: "Initialize",
    command: "/Applications/Claude.app/bundled/claude",
    homedir,
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn(command, args) {
      invocation = { command, args };
      return fakeChild((child) => setImmediate(() => child.stdout.write(`${JSON.stringify({ type: "system", session_id: "full-relay" })}\n`)));
    },
    adopt: async () => ({ attempted: true }),
  });
  const flag = invocation.args.indexOf("--mcp-config");
  assert.ok(flag > 0);
  assert.deepEqual(JSON.parse(invocation.args[flag + 1]).mcpServers.relay.args, ["/trusted/relay.js", "mcp"]);
});

test("completed Code sessions resume under the same Desktop-owned id", async () => {
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let argsSeen = [];
  const promise = continueClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "One more thing",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn(_command, args) {
      argsSeen = args;
      return fakeChild((child) => setImmediate(() => child.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`)));
    },
    adopt: async () => ({ attempted: true }),
  });
  const result = await promise;
  assert.equal(result.resumed, true);
  assert.deepEqual(argsSeen.slice(-2), ["--resume", sessionId]);
});

test("the live worker exposes partial assistant text without raw provider state", async () => {
  const sessionId = "dddddddd-eeee-4fff-8000-111111111111";
  let child;
  await continueClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "Visible user follow-up",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn() {
      child = fakeChild((worker) => setImmediate(() => {
        worker.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "message_start" } })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } } })}\n`);
      }));
      return child;
    },
    adopt: async () => ({ attempted: true }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshot = claudeDesktopCodeWorkerSnapshot(sessionId);
  assert.equal(snapshot.userText, "Visible user follow-up");
  assert.equal(snapshot.assistantText, "Hello live");
  assert.equal("child" in snapshot, false);
  assert.equal("stderr" in snapshot, false);
  child.emit("close", 0);
});

test("the native worker feed publishes bounded raw events after lifecycle state is updated", async () => {
  const sessionId = "dddddddd-eeee-4fff-8000-222222222222";
  let child;
  await continueClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "Watch native events",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn() {
      child = fakeChild((worker) => setImmediate(() => worker.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`)));
      return child;
    },
    adopt: async () => ({ attempted: true }),
  });
  const observed = [];
  const unsubscribe = subscribeClaudeDesktopCodeWorker(sessionId, (event) => {
    observed.push({ event, snapshot: claudeDesktopCodeNativeSnapshot(sessionId) });
  });
  child.stdout.write(`${JSON.stringify({ type: "result", result: "done", stop_reason: "end_turn" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observed.at(-1).event.type, "result");
  assert.equal(observed.at(-1).snapshot.settled, true);
  assert.equal(observed.at(-1).snapshot.events.at(-1).result, "done");
  assert.equal("child" in observed.at(-1).snapshot, false);
  unsubscribe();
  child.emit("close", 0);
});

test("a follow-up arriving on result waits for the retiring worker before resume", async () => {
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  let spawnCount = 0;
  let firstClosed = false;
  let secondStartedBeforeClose = false;
  const spawn = () => {
    spawnCount += 1;
    if (spawnCount === 2 && !firstClosed) secondStartedBeforeClose = true;
    return fakeChild((child) => setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: "ok" })}\n`);
      setTimeout(() => {
        if (spawnCount === 1) firstClosed = true;
        child.emit("close", 0);
      }, spawnCount === 1 ? 80 : 5);
    }));
  };
  await createClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "First",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn,
    adopt: async () => ({ attempted: true }),
  });
  const followed = await continueClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "Second",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn,
    adopt: async () => ({ attempted: true }),
  });
  assert.equal(followed.resumed, true);
  assert.equal(spawnCount, 2);
  assert.equal(secondStartedBeforeClose, false);
});

test("an initialization timeout terminates the worker so Retry has no zombie", async () => {
  let child = null;
  await assert.rejects(createClaudeDesktopCodeSession({
    sessionId: "cccccccc-dddd-4eee-8fff-000000000000",
    cwd: "/tmp/Relay",
    content: "Never initializes",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    initTimeoutMs: 10,
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn() { child = fakeChild(); return child; },
    adopt: async () => ({ attempted: true }),
  }), /did not initialize/);
  assert.equal(child.killed, true);
  assert.equal(child.stdin.writableEnded, true);
});

test("a turn stays alive until its provider-owned background work is collected", async () => {
  const sessionId = "eeeeeeee-ffff-4000-8000-222222222222";
  let child;
  let adopted = false;
  await createClaudeDesktopCodeSession({
    sessionId,
    cwd: "/tmp/Relay",
    content: "Count slowly",
    command: "/Applications/Claude.app/bundled/claude",
    homedir: "/Users/test",
    mintToken: async () => ({ accessToken: "desktop-token", apiHost: "https://api.anthropic.com", scope: "scope" }),
    spawn() {
      child = fakeChild((worker) => setImmediate(() => {
        worker.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{
          type: "tool_use",
          id: "tool-background",
          name: "Bash",
          input: { command: "sleep 1", run_in_background: true },
        }] } })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{
          type: "tool_result",
          tool_use_id: "tool-background",
          content: "Command running in background with ID: task-123. Output is being written.",
        }] } })}\n`);
        worker.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: "backgrounded" })}\n`);
      }));
      return child;
    },
    adopt: async () => { adopted = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(child.stdin.writableEnded, false, "the first result cannot tear down outstanding provider work");
  assert.equal(claudeDesktopCodeWorkerSnapshot(sessionId)?.settled, false);

  child.stdout.write(`${JSON.stringify({ type: "user", message: { content: [
    "<task-notification>",
    "<task-id>task-123</task-id>",
    "<status>completed</status>",
    "</task-notification>",
  ].join("\n") } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Finished" }] } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: "Finished" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(child.stdin.writableEnded, true, "the real terminal result closes the turn cleanly");
  child.emit("close", 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(adopted, true);
});
