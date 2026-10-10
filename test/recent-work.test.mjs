import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// WHERE THE WORK STANDS (2026-10-10). David's first live run got four generic
// ideas because recent work returned each chat's FIRST ask; a chat's live open
// loop is at its END. These fixtures start on something stale and end on a
// person waiting with a deadline: recent work must surface the end and the name.

const require = createRequire(import.meta.url);
const { recentWork, peopleIn } = require("../src/recent-work.cjs");
const fixtures = new URL("./fixtures/recent-work/", import.meta.url);
const NOW = Date.parse("2026-10-10T12:00:00Z");

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recent-work-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, "claude", "projects", "-Users-alex-work-acme-pricing");
  fs.mkdirSync(projects, { recursive: true });
  for (const name of ["claude-pricing.jsonl", "claude-onboarding.jsonl", "claude-probe.jsonl"]) {
    fs.copyFileSync(new URL(name, fixtures), path.join(projects, name));
  }
  const day = path.join(root, "codex", "sessions", "2026", "10", "09");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, "rollout-2026-10-09T17-00-00-t1.jsonl");
  fs.copyFileSync(new URL("codex-login.jsonl", fixtures), rollout);
  fs.utimesSync(rollout, new Date("2026-10-09T17:06:00Z"), new Date("2026-10-09T17:06:00Z"));
  return { root, claudeProjectsDir: path.join(root, "claude", "projects"), codexHome: path.join(root, "codex"), rollout };
}

test("recent work surfaces each thread's live end and the people named there, not how it started", (t) => {
  const { claudeProjectsDir, codexHome } = home(t);
  const before = fs.readdirSync(claudeProjectsDir, { recursive: true }).length;
  const result = recentWork({ codexHome, claudeProjectsDir, now: NOW, spawn: () => ({ status: 1 }) });
  assert.deepEqual(result.sources, { codex: "sessions", claudeCode: "sessions" });
  assert.deepEqual(result.threads.map((thread) => thread.title), ["Q3 pricing sheet", "why does test_login_retry fail on CI only"],
    "newest first; Relay's onboarding chat and the scripted probe are left out");
  const [pricing, login] = result.threads;
  // The live loop, from the end of the thread.
  assert.equal(pricing.lastActiveAt, "2026-10-10T08:44:00.000Z", "last activity from the messages, not the file's mtime");
  assert.equal(pricing.project, "acme-pricing");
  assert.equal(pricing.messageCount, 7, "the person's typed messages and the AI's replies; tool results and meta lines are not messages");
  assert.deepEqual(pricing.lastUserMessages, [
    "ok now redo the margin column with the new AWS costs",
    "Sam needs the final Q3 sheet before Thursday's client call. Can you tidy the enterprise tier so I can send it to Sam for sign-off?",
    "also flag that the $48/seat enterprise price is still waiting on Sam's approval",
  ]);
  assert.match(pricing.lastAssistantEnding, /Sam's sign-off on \$48\/seat before Thursday's call/);
  assert.doesNotMatch(JSON.stringify(pricing), /VLOOKUP/, "the stale first ask is not the story");
  assert.deepEqual(pricing.people, ["Sam"]);
  assert.equal(pricing.recent, true);
  assert.deepEqual(login.lastUserMessages, ["why does test_login_retry fail on CI only", "Priya is picking this up Monday, I'm out. Can you write up what we tried and what's still flaky so I can hand it over to Priya?"],
    "an event and an item carrying the same message count once; host wrappers are not the person");
  assert.match(login.lastAssistantEnding, /Still flaky: the refresh race on CI runners with 2 cores\. \/ Next: pin the clock in test_login_retry before Monday\./);
  assert.deepEqual(login.people, ["Priya"]);
  assert.equal(login.project, "api");
  // Local and read-only: nothing written, no paths, short strings.
  assert.equal(fs.readdirSync(claudeProjectsDir, { recursive: true }).length, before);
  const flat = JSON.stringify(result);
  assert.doesNotMatch(flat, /\/Users\/alex/, "folder names only, never paths");
  assert.doesNotMatch(flat, /log line/, "tool output never leaves the transcript");
});

test("Codex threads come from the state database's rollout paths, with the database's title", (t) => {
  const { codexHome, rollout } = home(t);
  const db = path.join(codexHome, "state_5.sqlite");
  fs.writeFileSync(db, "");
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args[0]]);
    return { status: 0, stdout: JSON.stringify([{ name: "Login retry handoff", title: "why does test_login_retry fail", ask: "why does test_login_retry fail on CI only", cwd: "/Users/alex/work/api", rollout, at: Date.parse("2026-10-09T17:06:00Z") }]) };
  };
  const result = recentWork({ codexHome, codexStateDb: db, now: NOW, spawn });
  assert.deepEqual(calls[0], ["sqlite3", "-readonly"], "read-only");
  assert.equal(result.sources.codex, "threads");
  assert.equal(result.threads[0].title, "Login retry handoff");
  assert.deepEqual(result.threads[0].people, ["Priya"]);
});

test("the last 72 hours come first, then the week, capped and trimmed; long files are read at both ends", (t) => {
  const { claudeProjectsDir } = home(t);
  const dir = path.join(claudeProjectsDir, "-Users-alex-old");
  fs.mkdirSync(dir, { recursive: true });
  // Five days old but a big file: only its head and tail are read.
  const filler = { type: "assistant", timestamp: "2026-10-05T10:00:00Z", message: { content: [{ type: "text", text: "x".repeat(2000) }] } };
  const lines = [{ type: "user", timestamp: "2026-10-05T09:00:00Z", cwd: "/x/old", message: { content: "start the board deck" } },
    ...Array.from({ length: 1200 }, () => filler),
    { type: "user", timestamp: "2026-10-05T11:00:00Z", cwd: "/x/old", message: { content: "ask Jordan to confirm the 12 Oct launch date before he books the ads" } }];
  fs.writeFileSync(path.join(dir, "old.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const result = recentWork({ claudeProjectsDir, now: NOW });
  assert.deepEqual(result.threads.map((thread) => thread.recent), [true, false]);
  const old = result.threads[1];
  assert.equal(old.title, "start the board deck", "the title still comes from how it started");
  assert.equal(old.messageCount.endsWith("+"), true, "a partial count says so");
  assert.deepEqual(old.lastUserMessages, ["ask Jordan to confirm the 12 Oct launch date before he books the ads"]);
  assert.deepEqual(old.people, ["Jordan"]);
  assert.equal(recentWork({ claudeProjectsDir, now: NOW, limit: 1 }).threads.length, 1);
  const long = JSON.stringify(recentWork({ claudeProjectsDir, now: NOW }));
  assert.ok(long.length < 4000, "short strings");
});

test("names come only from strong positions and are never products or common words", () => {
  assert.deepEqual(peopleIn([
    "relay shane the chat transcript", "the call me and sven had", "waiting on Priya for the sign-off",
    "so that Shivani can pick it up", "@cezar thoughts?", "Hi Sam, could you",
  ]), ["Shane", "Sven", "Priya", "Shivani", "Cezar"].slice(0, 5));
  assert.deepEqual(peopleIn(["relay isnt working", "send it to the team", "ask Claude Code to fix it", "push it to main", "Sven and Shane get them too"]), [],
    "no product, no common word, no guess from a bare capitalised pair");
});
