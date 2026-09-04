import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureClaudeDesktopImported,
  importClaudeDesktopSession,
  repairClaudeSessionModel,
  resolveClaudeSessionModel,
  writeClaudeNativeSession,
} from "../src/claude-session-writer.js";

const ENV_KEYS = [
  "CLAUDE_PROJECTS_DIR",
  "CLAUDE_DESKTOP_SESSIONS_DIR",
  "RELAY_CLAUDE_METADATA_MODEL",
  "RELAY_IMPORT_CLAUDE_DESKTOP",
];

test("the Node test runner cannot invoke Claude Desktop's protocol handler", () => {
  const previous = process.env.RELAY_IMPORT_CLAUDE_DESKTOP;
  try {
    delete process.env.RELAY_IMPORT_CLAUDE_DESKTOP;
    assert.ok(process.env.NODE_TEST_CONTEXT, "this assertion must execute under node --test");
    const result = importClaudeDesktopSession({ sessionId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(result.attempted, false);
    assert.equal(result.reason, "node-test-runner");
  } finally {
    restoreEnv("RELAY_IMPORT_CLAUDE_DESKTOP", previous);
  }
});

test("Claude session model resolution never emits Relay's internal sentinel", () => {
  const previous = process.env.RELAY_CLAUDE_METADATA_MODEL;
  try {
    process.env.RELAY_CLAUDE_METADATA_MODEL = " claude-from-env ";
    assert.equal(resolveClaudeSessionModel(" claude-from-picker "), "claude-from-picker");
    assert.equal(resolveClaudeSessionModel(""), "claude-from-env");
    assert.equal(resolveClaudeSessionModel("relay-companion"), "claude-from-env");

    process.env.RELAY_CLAUDE_METADATA_MODEL = " relay-companion ";
    assert.equal(resolveClaudeSessionModel(""), "claude-opus-5");
  } finally {
    restoreEnv("RELAY_CLAUDE_METADATA_MODEL", previous);
  }
});

test("ordinary and explicitly-modelled Relay opens write the same valid model to transcript and metadata", () => {
  const fixture = claudeFixture("relay-claude-session-model-");
  try {
    delete process.env.RELAY_CLAUDE_METADATA_MODEL;
    const ordinary = forge(fixture.root, "ordinary");
    assert.equal(ordinary.transcriptModel, "claude-opus-5");
    assert.equal(ordinary.metadataModel, ordinary.transcriptModel);

    process.env.RELAY_CLAUDE_METADATA_MODEL = "claude-from-env";
    const envSelected = forge(fixture.root, "environment");
    assert.equal(envSelected.transcriptModel, "claude-from-env");
    assert.equal(envSelected.metadataModel, envSelected.transcriptModel);

    const explicit = forge(fixture.root, "explicit", "claude-from-picker");
    assert.equal(explicit.transcriptModel, "claude-from-picker");
    assert.equal(explicit.metadataModel, explicit.transcriptModel);
  } finally {
    fixture.cleanup();
  }
});

test("legacy repair changes only Relay's forged assistant model and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-model-repair-"));
  const sessionPath = path.join(root, "legacy.jsonl");
  const relayRow = forgedAssistantRow({ model: "relay-companion" });
  const ordinaryClaudeRow = {
    type: "assistant",
    entrypoint: "claude-code",
    version: "claude-code",
    message: { id: "msg_not_relay", role: "assistant", model: "relay-companion", content: [] },
  };
  const userRow = { type: "user", message: { role: "user", content: "the words relay-companion are ordinary text" } };
  const originalLines = [JSON.stringify(relayRow), JSON.stringify(ordinaryClaudeRow), JSON.stringify(userRow), ""];
  fs.writeFileSync(sessionPath, originalLines.join("\n"));

  try {
    const repaired = repairClaudeSessionModel({ sessionPath, model: "claude-opus-5" });
    assert.equal(repaired.valid, true);
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.invalidRows, 1);

    const repairedLines = fs.readFileSync(sessionPath, "utf8").split("\n");
    assert.equal(JSON.parse(repairedLines[0]).message.model, "claude-opus-5");
    assert.equal(repairedLines[1], originalLines[1], "a non-Relay Claude row stays byte-identical");
    assert.equal(repairedLines[2], originalLines[2], "ordinary message text stays byte-identical");

    const once = fs.readFileSync(sessionPath, "utf8");
    const second = repairClaudeSessionModel({ sessionPath, model: "claude-opus-5" });
    assert.equal(second.valid, true);
    assert.equal(second.repaired, false);
    assert.equal(second.reason, "already-valid");
    assert.equal(fs.readFileSync(sessionPath, "utf8"), once);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy repair refuses to rewrite a malformed or changing transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-model-malformed-"));
  const sessionPath = path.join(root, "legacy.jsonl");
  const raw = `${JSON.stringify(forgedAssistantRow({ model: "relay-companion" }))}\n{"partial":`;
  fs.writeFileSync(sessionPath, raw);
  try {
    const result = repairClaudeSessionModel({ sessionPath });
    assert.equal(result.valid, false);
    assert.equal(result.repaired, false);
    assert.equal(result.reason, "transcript-is-changing-or-malformed");
    assert.equal(fs.readFileSync(sessionPath, "utf8"), raw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reopening an already-imported legacy Relay heals it before returning the deep link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-model-reopen-"));
  const sessionPath = path.join(root, "legacy.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify(forgedAssistantRow({ model: "relay-companion" }))}\n`);
  try {
    const nativeSession = {
      sessionId: "11111111-2222-4333-8444-555555555555",
      sessionPath,
      deepLink: "claude://resume?session=11111111-2222-4333-8444-555555555555",
      desktopImport: { attempted: false, reason: "disabled" },
    };
    const reopened = ensureClaudeDesktopImported(nativeSession, { model: "claude-opus-5" });
    assert.equal(reopened.transcriptModelRepair.repaired, true);
    assert.equal(JSON.parse(fs.readFileSync(sessionPath, "utf8").trim()).message.model, "claude-opus-5");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function claudeFixture(prefix) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CLAUDE_PROJECTS_DIR = path.join(root, "projects");
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = path.join(root, "desktop-sessions");
  process.env.RELAY_IMPORT_CLAUDE_DESKTOP = "0";
  fs.mkdirSync(path.join(process.env.CLAUDE_DESKTOP_SESSIONS_DIR, "account", "group"), { recursive: true });
  return {
    root,
    cleanup() {
      for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function forge(root, suffix, model = "") {
  const result = writeClaudeNativeSession({
    row: {
      id: `relay_${suffix}`,
      senderName: "Sven",
      title: `Model ${suffix}`,
      displayTitle: `From Sven: Model ${suffix}`,
      createdAt: "2026-08-31T08:00:00.000Z",
    },
    cwd: root,
    seed: { visible: `Visible ${suffix}`, operatorNote: "" },
    model,
  });
  const rows = fs.readFileSync(result.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const transcriptModel = rows.find((row) => row.type === "assistant")?.message?.model;
  const metadataModel = JSON.parse(fs.readFileSync(result.desktopMetadataPath, "utf8")).model;
  return { transcriptModel, metadataModel };
}

function forgedAssistantRow({ model }) {
  return {
    type: "assistant",
    entrypoint: "relay-companion",
    version: "relay-companion",
    message: {
      id: "msg_01relayabc123",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Relay seed" }],
    },
  };
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
