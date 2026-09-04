import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  relayCodexProjectThreadIds,
  relayCodexSessionThreadIds,
  repairRelayCodexProjectAssignments,
  startRelayCodexProjectRepairLoop,
} from "../src/codex-project-repair.js";

function writeSession(root, name, firstRow, trailing = "") {
  const dir = path.join(root, "2026", "08", "21");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${typeof firstRow === "string" ? firstRow : JSON.stringify(firstRow)}\n${trailing}`);
}

test("collects only unique Codex tasks materialized in the dedicated Relay root", () => {
  const relayRoot = path.join(path.sep, "Users", "tester", "Relay");
  const state = {
    packets: {
      first: { codexThreadId: "relay-one", openCwd: relayRoot, openCwdReason: "relay-folder" },
      duplicate: { codexThreadId: "relay-one", openCwd: `${relayRoot}${path.sep}` },
      second: { codexThreadId: "relay-two", openCwd: relayRoot },
      repo: { codexThreadId: "repo-thread", openCwd: path.join(path.sep, "repos", "relay") },
      claude: { claudeNativeSession: "claude-only", openCwd: relayRoot },
    },
  };
  assert.deepEqual(relayCodexProjectThreadIds(state, { relayRoot }), ["relay-one", "relay-two"]);
});

test("collects durable Relay tasks from Codex session metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-session-repair-"));
  const sessionsRoot = path.join(dir, "sessions");
  const relayRoot = path.join(dir, "Relay");
  writeSession(sessionsRoot, "valid", {
    type: "session_meta",
    payload: { id: "historical-relay", cwd: relayRoot, originator: "granular_relay_companion" },
  });
  writeSession(sessionsRoot, "duplicate", {
    type: "session_meta",
    payload: { session_id: "historical-relay", cwd: `${relayRoot}${path.sep}`, originator: "granular_relay_companion" },
  });
  writeSession(sessionsRoot, "repo", {
    type: "session_meta",
    payload: { id: "repo-task", cwd: path.join(dir, "repo"), originator: "granular_relay_companion" },
  });
  writeSession(sessionsRoot, "human", {
    type: "session_meta",
    payload: { id: "human-task", cwd: relayRoot, originator: "codex_cli_rs" },
  });
  writeSession(sessionsRoot, "malformed", "{not-json");
  assert.deepEqual(await relayCodexSessionThreadIds({ sessionsRoot, relayRoot }), ["historical-relay"]);
});

test("startup repair assigns every historical Relay task without opening one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-project-repair-"));
  const statePath = path.join(dir, "state.json");
  const sessionsRoot = path.join(dir, "sessions");
  const relayRoot = path.join(dir, "Relay");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      packets: {
        one: { codexThreadId: "thread-one", openCwd: relayRoot },
        two: { codexThreadId: "thread-two", openCwd: relayRoot },
      },
    }),
  );
  writeSession(sessionsRoot, "historical", {
    type: "session_meta",
    payload: { id: "thread-historical", cwd: relayRoot, originator: "granular_relay_companion" },
  });
  let received = null;
  const result = await repairRelayCodexProjectAssignments({
    statePath,
    sessionsRoot,
    relayRoot,
    notify: async (payload) => {
      received = payload;
      return { attempted: true, ok: true };
    },
  });
  assert.deepEqual(result.threadIds, ["thread-one", "thread-two", "thread-historical"]);
  assert.deepEqual(received, {
    threadIds: ["thread-one", "thread-two", "thread-historical"],
    workspaceRootsByThreadId: {
      "thread-one": [relayRoot],
      "thread-two": [relayRoot],
      "thread-historical": [relayRoot],
    },
    ensureWorkspaceRoot: relayRoot,
    openThreadId: null,
    assignmentOnly: true,
  });
});

test("startup repair no-ops when no Companion state exists", async () => {
  const result = await repairRelayCodexProjectAssignments({
    statePath: path.join(os.tmpdir(), `relay-missing-${Date.now()}`, "state.json"),
    sessionsRoot: path.join(os.tmpdir(), `relay-sessions-missing-${Date.now()}`),
    notify: async () => assert.fail("notify must not run"),
  });
  assert.deepEqual(result, { attempted: false, reason: "state-unavailable", threadIds: [] });
});

test("the daemon waits for an authenticated owner before repairing Codex project state", () => {
  const daemon = fs.readFileSync(new URL("../src/task-daemon.js", import.meta.url), "utf8");
  const run = daemon.slice(daemon.indexOf("export async function runTaskDaemon"));
  const signedIn = run.indexOf("const me = await resolveMe(client)");
  const repair = run.indexOf("startRelayCodexProjectRepairLoop({ log })");
  assert.ok(signedIn >= 0 && repair > signedIn, "account-owned Codex repair must start only after sign-in");
  assert.match(daemon, /waiting for sign-in in the Relay app/);
});

test("startup repair waits for Codex and stops retrying after assignment succeeds", async () => {
  const results = [
    { attempted: true, ok: false, reason: "codex-not-running" },
    { attempted: true, ok: true },
  ];
  const timers = [];
  let calls = 0;
  const stop = startRelayCodexProjectRepairLoop({
    repair: async () => {
      calls += 1;
      return results.shift();
    },
    retryMs: 123,
    setTimeoutImpl(callback, ms) {
      timers.push({ callback, ms, unref() {} });
      return timers.at(-1);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 123);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(timers.length, 1, "success must end the retry loop");
  stop();
});
