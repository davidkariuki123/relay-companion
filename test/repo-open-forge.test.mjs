// End-to-end: a relay carrying repo identity must forge its Claude session
// INTO that repo's project directory, not the home directory.
//
// This is the leg that actually matters. Claude's resume deep link carries only
// a session UUID — no path — so the working directory survives in exactly two
// places, and they must agree or the session opens somewhere else:
//
//   1. the transcript's location: ~/.claude/projects/<projectKey(cwd)>/<id>.jsonl
//   2. `cwd` / `originCwd` in the Desktop metadata file
//
// Asserting both is what proves the routing is real rather than cosmetic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeProjectKey } from "../src/claude-session-writer.js";

const ENV_KEYS = [
  "RELAY_HOME",
  "RELAY_OPEN_CWD",
  "CLAUDE_HOME",
  "CLAUDE_DESKTOP_SESSIONS_DIR",
  "RELAY_IMPORT_CLAUDE_DESKTOP",
  "RELAY_REPO_ROOTS",
];

function makeRepo(dir, originUrl) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  run(["remote", "add", "origin", originUrl]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return dir;
}

function stageRow(relayHome, row) {
  fs.mkdirSync(relayHome, { recursive: true });
  fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({ packets: { [row.id]: row } }));
}

function baseRow(overrides) {
  return {
    id: "relay_repo_1",
    direction: "inbound",
    state: "unread",
    kind: "message",
    relayNotificationKind: "plain_relay",
    senderName: "Shane",
    title: "Tunnel hostname",
    displayTitle: "From Shane: Tunnel hostname",
    forHuman: "Need one public hostname added.",
    createdAt: "2026-08-07T14:30:58.238Z",
    materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
    ...overrides,
  };
}

async function openIn(dir, row) {
  const relayHome = path.join(dir, "relay-home");
  const claudeHome = path.join(dir, "claude-home");
  // The Desktop metadata writer resolves <sessions>/<account>/<group>/ and
  // writes nothing when that shape is absent. Create it, or the metadata
  // assertions below would silently pass by never running.
  const desktopSessions = path.join(dir, "claude-desktop-sessions");
  fs.mkdirSync(path.join(desktopSessions, "account-1", "group-1"), { recursive: true });
  stageRow(relayHome, row);
  process.env.RELAY_HOME = relayHome;
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = desktopSessions;
  process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
  const { openRelay } = await import(`../src/materializer.js?repo-forge-${Date.now()}-${Math.random()}`);
  const opened = await openRelay({ id: row.id, host: "claude" });
  const state = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
  return { opened, row: state.packets[row.id], claudeHome };
}

test("a relay carrying repo identity forges its session into that repo", async (t) => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-repo-forge-"));
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const repo = makeRepo(path.join(dir, "acme-widgets"), "git@github.com:acme/widgets.git");
  // The fixture lives outside both agent history and the conventional source
  // roots, so point the index's disk scan at it.
  process.env.RELAY_REPO_ROOTS = dir;

  // The sender was on another machine at a path that does not exist here — only
  // the identity is portable, and the HTTPS form must still match the SSH form
  // the local checkout uses.
  const { opened, row, claudeHome } = await openIn(
    dir,
    baseRow({
      source: {
        host: "relay-mcp",
        cwd: "/home/shane/work/widgets",
        workspace: { kind: "git", key: "github.com/acme/widgets", label: "widgets", branch: "main" },
        repo: { name: "widgets", originKey: "github.com/acme/widgets", branch: "main" },
      },
    }),
  );

  assert.equal(opened.cwd, repo, "should route to the local checkout of the sender's repo");
  assert.equal(opened.cwdReason, "workspace-passport");

  // 1. The transcript physically lives in the repo's project directory.
  const sessionPath = row.claudeNativeSession.sessionPath;
  assert.equal(path.basename(path.dirname(sessionPath)), claudeProjectKey(repo));
  assert.ok(sessionPath.startsWith(path.join(claudeHome, "projects")), sessionPath);
  assert.ok(fs.existsSync(sessionPath));

  // 2. The transcript's own cwd field agrees.
  const rows = fs
    .readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.type === "assistant")?.cwd, repo);

  // 3. The Desktop metadata — the ONLY channel the pathless resume link has.
  const metaFile = row.claudeNativeSession.desktopMetadataPath;
  assert.ok(metaFile, "desktop session metadata must be written");
  assert.ok(fs.existsSync(metaFile), metaFile);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  assert.equal(meta.cwd, repo);
  assert.equal(meta.originCwd, repo);

  // 4. The decision is persisted so a re-open is stable.
  assert.equal(row.openCwd, repo);
  assert.equal(row.openCwdReason, "workspace-passport");
  assert.equal(row.openWorkspaceKey, "git:github.com/acme/widgets");
});

test("a relay for a workspace this machine does not have opens in the Relay folder, never the sender's path", async (t) => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-repo-forge-miss-"));
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  delete process.env.RELAY_OPEN_CWD;
  const { opened, row } = await openIn(
    dir,
    baseRow({
      id: "relay_repo_2",
      // Hostile shape: a real local path the sender wants us to open, plus a
      // repo identity we cannot resolve. The path must be ignored outright.
      source: {
        host: "relay-mcp",
        cwd: os.homedir() + "/.ssh",
        workspace: { kind: "git", key: "github.com/attacker/definitely-not-here", label: "evil" },
        repo: { name: "evil", originKey: "github.com/attacker/definitely-not-here" },
      },
    }),
  );

  // 9b9c0d6d: a product open of an unmatched passport lands in the dedicated
  // Relay folder (where an unanchored Relay goes) instead of failing closed.
  // The hostile sender path and home itself must still never be chosen.
  const relayFolder = path.resolve(os.homedir(), "Relay");
  assert.match(String(opened.url), /^claude:\/\/resume\?session=/);
  assert.equal(opened.cwd, relayFolder);
  assert.equal(opened.cwdReason, "workspace-unmapped-fallback");
  assert.notEqual(opened.cwd, os.homedir());
  assert.notEqual(opened.cwd, path.join(os.homedir(), ".ssh"));
  assert.equal(row.openCwd, relayFolder);
  assert.equal(row.openCwdReason, "workspace-unmapped-fallback");
  assert.equal(row.openWorkspaceKey, "git:github.com/attacker/definitely-not-here", "the unmatched passport stays on record");
  // The open really happened, and its session lives under the Relay folder's
  // project key, not under home's or the sender's path.
  const sessionPath = row.claudeNativeSession.sessionPath;
  assert.ok(sessionPath.includes(claudeProjectKey(relayFolder)), sessionPath);
});
