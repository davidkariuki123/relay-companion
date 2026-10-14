// Where the checkout index finds folders: Claude Code's project registry, with
// how recently Claude Code worked in each, on every platform including Windows,
// where the registry keys are C:\ paths (Shane, 2026-10-13: the folder list
// under "Which folder?" was empty on Windows because only "/" keys were read).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepoIndex } from "../src/repo-index.js";

function git(args, cwd) {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

test("Claude Code's folders are indexed with their native paths, newest first, from its own history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-repo-index-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_PROJECTS_DIR: process.env.CLAUDE_PROJECTS_DIR, CODEX_STATE_DB: process.env.CODEX_STATE_DB, RELAY_HOME: process.env.RELAY_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home");
  const projects = path.join(home, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_PROJECTS_DIR: projects, CODEX_STATE_DB: path.join(root, "no-codex.sqlite"), RELAY_HOME: path.join(root, "relay") });

  const repo = (name) => {
    const dir = path.join(root, "src", name);
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["commit", "-q", "--allow-empty", "-m", "first"], dir);
    return dir;
  };
  const older = repo("older"), newer = repo("newer");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  // Claude Code's transcripts: one folder per project, the path with every
  // character but a letter or digit turned into "-".
  const history = (dir, sessions, at) => {
    const folder = path.join(projects, dir.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(folder);
    for (let i = 0; i < sessions; i += 1) fs.writeFileSync(path.join(folder, `${i}.jsonl`), "{}\n");
    fs.utimesSync(folder, at, at);
  };
  history(older, 3, new Date("2026-10-01T10:00:00Z"));
  history(newer, 1, new Date("2026-10-12T10:00:00Z"));
  // The same folder written with the other slash on Windows, a scratch folder
  // that is not a checkout, and a key from another kind of machine.
  const otherSlash = process.platform === "win32" ? older.replace(/\\/g, "/") : older;
  const foreign = process.platform === "win32" ? "/Users/someone/src/relay" : "C:\\Users\\someone\\src\\relay";
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [older]: {}, [otherSlash]: {}, [newer]: {}, [scratch]: {}, [foreign]: {} } }));

  const index = buildRepoIndex({ useCache: false });
  const dirs = index.map((c) => c.dir);
  assert.deepEqual([...dirs].sort(), [newer, older].sort(), "both checkouts, once each; the scratch folder and the foreign key are left out");
  const byDir = Object.fromEntries(index.map((c) => [c.dir, c]));
  assert.equal(byDir[older].source, "claude");
  assert.equal(byDir[older].branch, "main");
  assert.ok(byDir[newer].lastUsedAt > byDir[older].lastUsedAt, "recency comes from Claude Code's own history");
  assert.ok(byDir[older].uses >= 3, "one use per conversation there");
});
