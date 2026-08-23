import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverClaudeSessions, discoverCodexSessions, recordAnonymousSession } from "../src/session-directory.js";

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-directory-"));
}

function codexLine(type, payload, timestamp = new Date().toISOString()) {
  return JSON.stringify({ timestamp, type, payload });
}

test("directory reports native Codex parent tasks as active/idle and excludes subagents", () => {
  const root = fixture();
  const home = path.join(root, "codex");
  const day = path.join(home, "sessions", "2026", "08", "11");
  fs.mkdirSync(day, { recursive: true });
  const activeId = "019fa000-0000-7000-8000-000000000011";
  const idleId = "019fa000-0000-7000-8000-000000000012";
  const childId = "019fa000-0000-7000-8000-000000000013";
  const write = (id, lines) => fs.writeFileSync(path.join(day, `rollout-2026-08-11T10-00-00-${id}.jsonl`), `${lines.join("\n")}\n`);
  write(activeId, [
    codexLine("session_meta", { id: activeId, session_id: activeId, cwd: "/work/relay" }),
    codexLine("event_msg", { type: "task_started", turn_id: "turn-active" }),
  ]);
  write(idleId, [
    codexLine("session_meta", { id: idleId, session_id: idleId, cwd: "/work/other" }),
    codexLine("event_msg", { type: "task_started", turn_id: "turn-done" }),
    codexLine("event_msg", { type: "task_complete", turn_id: "turn-done" }),
  ]);
  write(childId, [
    codexLine("session_meta", { id: childId, session_id: childId, cwd: "/work/relay", thread_source: "subagent" }),
  ]);
  fs.writeFileSync(path.join(home, "session_index.jsonl"), [
    JSON.stringify({ id: activeId, thread_name: "Active native task", updated_at: "2026-08-11T10:00:00Z" }),
    JSON.stringify({ id: idleId, thread_name: "Idle native task", updated_at: "2026-08-11T09:00:00Z" }),
  ].join("\n"));

  const sessions = discoverCodexSessions({ homeDir: home, nowMs: Date.parse("2026-08-11T10:01:00Z") });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((row) => row.nativeId === activeId).state, "active");
  assert.equal(sessions.find((row) => row.nativeId === idleId).state, "idle");
  assert.ok(!sessions.some((row) => row.nativeId === childId));
  fs.rmSync(root, { recursive: true, force: true });
});

test("anonymous chat agent runs stay out of the visible Codex directory", () => {
  const root = fixture();
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = path.join(root, "relay-store");
  try {
    const home = path.join(root, "codex");
    const day = path.join(home, "sessions", "2026", "08", "23");
    fs.mkdirSync(day, { recursive:true });
    const visibleId = "019fa000-0000-7000-8000-000000000031";
    const anonymousId = "019fa000-0000-7000-8000-000000000032";
    for (const id of [visibleId, anonymousId]) {
      fs.writeFileSync(path.join(day, `rollout-2026-08-23T10-00-00-${id}.jsonl`), `${codexLine("session_meta", { id, session_id:id, cwd:"/work/relay" })}\n`);
    }
    recordAnonymousSession("codex", anonymousId);
    const sessions = discoverCodexSessions({ homeDir:home, nowMs:Date.parse("2026-08-23T10:01:00Z") });
    assert.ok(sessions.some((row) => row.nativeId === visibleId));
    assert.ok(!sessions.some((row) => row.nativeId === anonymousId));
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test("directory keeps a huge currently-growing Codex turn active after its start marker leaves the tail", () => {
  const root = fixture();
  const home = path.join(root, "codex");
  const day = path.join(home, "sessions", "2026", "08", "11");
  fs.mkdirSync(day, { recursive: true });
  const activeId = "019fa000-0000-7000-8000-000000000021";
  const staleId = "019fa000-0000-7000-8000-000000000022";
  const now = Date.parse("2026-08-11T10:00:00Z");
  const writeProgressOnly = (id, mtimeMs) => {
    const filePath = path.join(day, `rollout-2026-08-11T09-00-00-${id}.jsonl`);
    fs.writeFileSync(filePath, `${[
      codexLine("session_meta", { id, session_id: id, cwd: "/work/relay" }),
      codexLine("event_msg", { type: "agent_reasoning", text: "progress" }, new Date(mtimeMs).toISOString()),
    ].join("\n")}\n`);
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  };
  writeProgressOnly(activeId, now - 5_000);
  writeProgressOnly(staleId, now - 5 * 60_000);

  const sessions = discoverCodexSessions({ homeDir: home, nowMs: now });
  assert.equal(sessions.find((row) => row.nativeId === activeId).state, "active");
  assert.equal(sessions.find((row) => row.nativeId === staleId).state, "idle");
  fs.rmSync(root, { recursive: true, force: true });
});

test("directory distinguishes a live Claude chat from a cold but recoverable idle chat", () => {
  const root = fixture();
  const configDir = path.join(root, "claude");
  const desktopDir = path.join(root, "desktop");
  const cwd = "/work/relay";
  const idleId = "398a640d-6b6f-453b-9f07-d07324aaadb3";
  const activeId = "398a640d-6b6f-453b-9f07-d07324aaadb4";
  const projectDir = path.join(configDir, "projects", "-work-relay");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${idleId}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(projectDir, `${activeId}.jsonl`), "{}\n");
  const now = Date.parse("2026-08-11T10:00:00Z");
  for (const [nativeId, title] of [[idleId, "Cold idle"], [activeId, "Live active"]]) {
    fs.writeFileSync(path.join(desktopDir, `local_${nativeId}.json`), JSON.stringify({
      cliSessionId: nativeId,
      sessionId: `desktop-${nativeId}`,
      cwd,
      title,
      lastActivityAt: now - 1000,
    }));
  }
  const socketPath = path.join(root, "active.sock");
  fs.writeFileSync(socketPath, "");
  fs.writeFileSync(path.join(configDir, "sessions", "active.json"), JSON.stringify({
    pid: process.pid,
    sessionId: activeId,
    cwd,
    status: "running",
    messagingSocketPath: socketPath,
    updatedAt: now,
  }));

  const sessions = discoverClaudeSessions({ configDir, desktopDir, nowMs: now });
  const idle = sessions.find((row) => row.nativeId === idleId);
  const active = sessions.find((row) => row.nativeId === activeId);
  assert.equal(idle.state, "idle");
  assert.equal(idle.capabilities.send, true);
  assert.equal(idle.nativeRef.transcriptPath, path.join(projectDir, `${idleId}.jsonl`));
  assert.equal(active.state, "active");
  assert.equal(active.nativeRef.messagingSocketPath, socketPath);
  fs.rmSync(root, { recursive: true, force: true });
});
