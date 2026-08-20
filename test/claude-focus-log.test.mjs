// Tier 0 targeting: read what Claude Desktop says is ON SCREEN, from its own
// main-process focus log, instead of inferring from timestamps.
//
// Measured on 2026-08-06 against a real machine: lastFocusedAt lands on disk
// 2-4s AFTER a chat switch (so a quick click targeted the chat the user had
// just left, 4 times in 150s of sampling), and the Home screen — 32 of the
// last 60 focus events — cannot be represented by the ranking at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  desktopSessionByLocalId,
  findCurrentClaudeSession,
  readFocusedSessionFromLog,
} from "../src/claude-inject.cjs";

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-focus-log-"));
  const logDir = path.join(root, "logs");
  const desktop = path.join(root, "sessions", "org_1", "ws_1");
  const home = path.join(root, "relay-home");
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, logDir, desktop: path.join(root, "sessions"), wsDir: desktop, home };
}
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
function writeLog(logDir, name, events) {
  fs.writeFileSync(
    path.join(logDir, name),
    events
      .map((e) => `${stamp(e.at)} [info] [CCD] LocalSessions.setFocusedSession: sessionId=${e.id === null ? "null" : e.id}`)
      .join("\n") + "\n",
  );
}
function writeSession(wsDir, localId, meta) {
  fs.writeFileSync(path.join(wsDir, `${localId}.json`), JSON.stringify({ cliSessionId: meta.cli, title: meta.title, cwd: meta.cwd, isArchived: meta.archived === true }));
}

test("the newest focus line wins, across rotated logs", () => {
  const r = rig();
  const now = Date.now();
  writeLog(r.logDir, "main1.log", [{ at: now - 60_000, id: "local_old" }]);
  writeLog(r.logDir, "main.log", [
    { at: now - 20_000, id: "local_a" },
    { at: now - 5_000, id: null },
    { at: now - 3_000, id: "local_b" },
  ]);
  const got = readFocusedSessionFromLog({ logDir: r.logDir, nowMs: now });
  assert.equal(got.localId, "local_b", "the LAST transition is the current state");
});

test("sessionId=null is a real answer: no chat is open", () => {
  const r = rig();
  const now = Date.now();
  writeLog(r.logDir, "main.log", [
    { at: now - 9_000, id: "local_a" },
    { at: now - 2_000, id: null },
  ]);
  assert.equal(readFocusedSessionFromLog({ logDir: r.logDir, nowMs: now }).localId, null);
  writeSession(r.wsDir, "local_a", { cli: "cli-a", title: "Some chat", cwd: "/x/relay" });
  // The resolver REFUSES rather than naming the last chat the user visited.
  const chosen = findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now });
  assert.equal(chosen, null, "Home screen must not resolve to a chat");
});

test("the focus log beats a stale lastFocusedAt (the 2-4s write lag)", () => {
  const r = rig();
  const now = Date.now();
  // On disk, the OLD chat still looks freshest — the switch has not been flushed.
  fs.writeFileSync(path.join(r.wsDir, "local_old.json"), JSON.stringify({ cliSessionId: "cli-old", title: "Chat I just left", lastFocusedAt: now - 1_000, completedTurns: 9, cwd: "/x/relay" }));
  fs.writeFileSync(path.join(r.wsDir, "local_new.json"), JSON.stringify({ cliSessionId: "cli-new", title: "Chat I am looking at", lastFocusedAt: now - 90_000, completedTurns: 4, cwd: "/x/relay" }));
  // The log knows the truth immediately.
  writeLog(r.logDir, "main.log", [{ at: now - 2_000, id: "local_new" }]);
  const chosen = findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now });
  assert.equal(chosen.sessionId, "cli-new", "on-screen beats most-recently-written");
  assert.equal(chosen.label, "Chat I am looking at");
  assert.equal(chosen.via, "focus-log");
  // With the log ignored, the old ranking reproduces the bug — the regression this guards.
  const legacy = findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, nowMs: now, useFocusLog: false });
  assert.equal(legacy.sessionId, "cli-old", "documents the behavior tier 0 replaces");
});

test("a stale, missing, or unparsable log falls back to the ranking instead of failing", () => {
  const r = rig();
  const now = Date.now();
  fs.writeFileSync(path.join(r.wsDir, "local_a.json"), JSON.stringify({ cliSessionId: "cli-a", title: "Real chat", lastFocusedAt: now - 30_000, completedTurns: 2, cwd: "/x/relay" }));
  // No log at all.
  assert.equal(findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now }).sessionId, "cli-a");
  // A log from yesterday says nothing about now.
  writeLog(r.logDir, "main.log", [{ at: now - 20 * 60 * 60 * 1000, id: "local_a" }]);
  assert.equal(readFocusedSessionFromLog({ logDir: r.logDir, nowMs: now }), null);
  assert.equal(findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now }).via, "ranking");
  // Format drift (a Claude update renames the line) must not break the click.
  fs.writeFileSync(path.join(r.logDir, "main.log"), "2026-08-06 10:00:00 [info] [CCD] Sessions.somethingElse: id=local_a\n");
  assert.equal(findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now }).sessionId, "cli-a");
});

test("a focused chat that is archived or unknown falls back rather than misfiring", () => {
  const r = rig();
  const now = Date.now();
  writeSession(r.wsDir, "local_gone", { cli: "cli-gone", title: "Archived", cwd: "/x/relay", archived: true });
  fs.writeFileSync(path.join(r.wsDir, "local_a.json"), JSON.stringify({ cliSessionId: "cli-a", title: "Real chat", lastFocusedAt: now - 30_000, completedTurns: 2, cwd: "/x/relay" }));
  writeLog(r.logDir, "main.log", [{ at: now - 1_000, id: "local_gone" }]);
  assert.equal(findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now }).sessionId, "cli-a");
  // An id with no session file on disk behaves the same way.
  writeLog(r.logDir, "main.log", [{ at: now - 1_000, id: "local_nosuchfile" }]);
  assert.equal(findCurrentClaudeSession({ homeDir: r.home, desktopSessionsDir: r.desktop, logDir: r.logDir, nowMs: now }).sessionId, "cli-a");
});

test("desktopSessionByLocalId maps Desktop's local id to the CLI session id", () => {
  const r = rig();
  writeSession(r.wsDir, "local_x", { cli: "cli-x", title: "Named chat", cwd: "/Users/x/src/granular-relay" });
  assert.deepEqual(desktopSessionByLocalId(r.desktop, "local_x"), {
    sessionId: "cli-x", label: "Named chat", cwd: "/Users/x/src/granular-relay", archived: false,
  });
  // No title -> the working directory's last segment names the chat.
  writeSession(r.wsDir, "local_y", { cli: "cli-y", title: "", cwd: "/Users/x/src/granular-relay" });
  assert.equal(desktopSessionByLocalId(r.desktop, "local_y").label, "granular-relay");
  assert.equal(desktopSessionByLocalId(r.desktop, "local_missing"), null);
});
