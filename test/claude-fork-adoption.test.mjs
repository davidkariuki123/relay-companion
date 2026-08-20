// The Claude lane's adoption step: which session Claude Code is told about, and
// WHEN. Both halves were live defects.
//
// `claude --bg --resume` FORKS — it reads the forged transcript and writes a new
// session id — so the session that runs is never the session that was forged.
// Two things went wrong on top of that:
//
//   1. The forge imported too, so the reader's Claude Code listed TWO rows for
//      one request: an 8-line seeded stub wearing the request's title, above the
//      real run. (Covered in overlay/main.cjs by the forge no longer importing.)
//   2. Adoption fired the deep link as soon as the background agent resolved.
//      The fork's seed rows carry no cwd, the app resolves a CLI session's
//      working directory by reading the transcript, and so it rejected the
//      import outright — "Cannot determine working directory for CLI session
//      <id> — the transcript may be incomplete", category `transcript_missing`.
//      Three of the observed fork adoptions were dropped this way and the run
//      never appeared in the list at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptClaudeSessionIntoDesktop, claudeTranscriptCwd } from "../src/claude-session-writer.js";

// The real row shapes, in the real order a forked background run writes them.
const SEED_ROWS = [
  { type: "custom-title", customTitle: "🔁 From David Kariuki: probe" },
  { type: "ai-title", aiTitle: "probe" },
  { type: "agent-name", agentName: "probe" },
  { type: "mode", mode: "default" },
  { type: "permission-mode", permissionMode: "acceptEdits" },
];
const SYSTEM_ROW = { type: "system", cwd: "/Users/david", sessionId: "fork" };

function writeRows(file, rows) {
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

test("a fork's seed rows are not a working directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fork-cwd-"));
  try {
    const file = path.join(dir, "fork.jsonl");
    assert.equal(claudeTranscriptCwd(file), "", "a transcript that does not exist yet has no cwd");

    writeRows(file, SEED_ROWS);
    assert.equal(
      claudeTranscriptCwd(file),
      "",
      "the seed rows carry no cwd — this is the moment adoption used to fire, and the app rejected it",
    );

    writeRows(file, [...SEED_ROWS, SYSTEM_ROW]);
    assert.equal(claudeTranscriptCwd(file), "/Users/david", "the system row is what makes the session adoptable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a half-written trailing line is 'not yet', never a failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fork-partial-"));
  try {
    const file = path.join(dir, "fork.jsonl");
    // A file being appended to is routinely caught mid-line.
    fs.writeFileSync(file, `${JSON.stringify(SEED_ROWS[0])}\n{"type":"system","cw`);
    assert.equal(claudeTranscriptCwd(file), "");
    fs.appendFileSync(file, `d":"/Users/david"}\n`);
    assert.equal(claudeTranscriptCwd(file), "/Users/david");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adoption waits for the cwd instead of handing the app a session it will reject", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fork-adopt-"));
  const group = path.join(root, "account", "group");
  fs.mkdirSync(group, { recursive: true });
  const previous = {
    dir: process.env.CLAUDE_DESKTOP_SESSIONS_DIR,
    import: process.env.RELAY_IMPORT_CLAUDE_DESKTOP,
  };
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = root;
  process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0"; // no real `open` deep link from a test
  const sessionId = "2f92b40d-b610-463c-b761-74647ce42155";
  const file = path.join(root, `${sessionId}.jsonl`);
  try {
    writeRows(file, SEED_ROWS);

    // The transcript never gains a cwd: adoption must decline, and must NOT
    // leave metadata behind claiming a session the app cannot open.
    const declined = await adoptClaudeSessionIntoDesktop({
      sessionId,
      title: "🔁 From David Kariuki: probe",
      sessionPath: file,
      timeoutMs: 20,
      pollMs: 10,
      sleep: async () => {},
    });
    assert.equal(declined.attempted, false);
    assert.equal(declined.reason, "transcript-has-no-cwd");
    assert.equal(
      fs.existsSync(path.join(group, `local_${sessionId}.json`)),
      false,
      "no metadata for a session we know the app would refuse",
    );

    // Now the system row lands mid-wait, exactly as it does live.
    let ticks = 0;
    const adopted = await adoptClaudeSessionIntoDesktop({
      sessionId,
      title: "🔁 From David Kariuki: probe",
      sessionPath: file,
      timeoutMs: 1000,
      pollMs: 10,
      sleep: async () => {
        ticks += 1;
        if (ticks === 3) writeRows(file, [...SEED_ROWS, SYSTEM_ROW]);
      },
    });
    assert.equal(adopted.attempted, true);
    assert.equal(adopted.cwd, "/Users/david", "the cwd comes from the transcript when the caller has none");
    assert.ok(adopted.waitedMs > 0, "it actually waited rather than racing the fork");
    const saved = JSON.parse(fs.readFileSync(path.join(group, `local_${sessionId}.json`), "utf8"));
    assert.equal(saved.cliSessionId, sessionId, "the adopted session is the fork, not the forged stub");
    assert.equal(saved.title, "🔁 From David Kariuki: probe");
    assert.equal(saved.cwd, "/Users/david", "listed under the right project");
  } finally {
    if (previous.dir === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previous.dir;
    if (previous.import === undefined) delete process.env.RELAY_IMPORT_CLAUDE_DESKTOP;
    else process.env.RELAY_IMPORT_CLAUDE_DESKTOP = previous.import;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Relay-owned settlement materializes without firing a Desktop import", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-materialize-"));
  const group = path.join(root, "account", "group");
  fs.mkdirSync(group, { recursive: true });
  const previous = process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = root;
  const sessionId = "8c1f94ab-40c0-41af-ac2f-28673a5e17c4";
  const file = path.join(root, `${sessionId}.jsonl`);
  writeRows(file, [...SEED_ROWS, SYSTEM_ROW]);
  try {
    const adopted = await adoptClaudeSessionIntoDesktop({
      sessionId,
      title: "Relay-owned run",
      sessionPath: file,
      importIntoDesktop: false,
    });
    assert.equal(adopted.materialized, true);
    assert.equal(adopted.desktopImport.attempted, false);
    assert.equal(adopted.desktopImport.reason, "deferred-until-user-open");
    assert.ok(fs.existsSync(path.join(group, `local_${sessionId}.json`)));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the forge stays quiet so one request is one row in the session list", () => {
  // The forge runs the open helper in a child process with an explicit env.
  // Importing there as well is what put the seeded stub in the reader's list
  // above the real run; adoption belongs to the fork, once.
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const forge = main.slice(main.indexOf("function forgeTaskSessionQuietly"));
  const body = forge.slice(0, forge.indexOf("perf.inc(\"spawns\")"));
  assert.match(body, /RELAY_IMPORT_CLAUDE_DESKTOP: "0"/);
  assert.match(body, /RELAY_ACTIVATE_CLAUDE: "0"/);
});
