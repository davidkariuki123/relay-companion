import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  restoreClaudeDesktopSessionTitle,
  setClaudeDesktopSessionPermissionMode,
} from "../src/claude-session-writer.js";
import { relayClaudePermissionMode } from "../src/claude-session-runtime.js";

test("Relay updates Claude Desktop's visible permission mode before reopening a controlled task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-desktop-mode-"));
  const group = path.join(root, "account", "group");
  const sessionId = "10a02c83-29af-41b4-9a65-726217600f01";
  const metadataPath = path.join(group, `local_${sessionId}.json`);
  fs.mkdirSync(group, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: `local_${sessionId}`,
    cliSessionId: sessionId,
    title: "Relay test",
    permissionMode: "default",
    unrelated: "preserved",
  }));
  const previous = process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = root;
  try {
    const result = setClaudeDesktopSessionPermissionMode({ sessionId, permissionMode: "auto" });
    assert.equal(result.updated, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, "utf8")), {
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      title: "Relay test",
      permissionMode: "auto",
      unrelated: "preserved",
    });
    assert.equal(
      setClaudeDesktopSessionPermissionMode({ sessionId, permissionMode: "auto" }).updated,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the task runtime picker's model and effort land in Desktop session metadata", async () => {
  const { writeClaudeDesktopSessionMetadata } = await import("../src/claude-session-writer.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-desktop-model-"));
  const group = path.join(root, "account", "group");
  fs.mkdirSync(group, { recursive: true });
  const previous = process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
  const previousModel = process.env.RELAY_CLAUDE_METADATA_MODEL;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = root;
  // The env override must LOSE to an explicit choice from the picker.
  process.env.RELAY_CLAUDE_METADATA_MODEL = "claude-from-env";
  try {
    const sessionId = "20b02c83-29af-41b4-9a65-726217600f02";
    const explicit = writeClaudeDesktopSessionMetadata({
      sessionId,
      title: "Task session",
      cwd: root,
      model: "claude-opus-5",
      effort: "high",
    });
    const written = JSON.parse(fs.readFileSync(explicit, "utf8"));
    assert.equal(written.model, "claude-opus-5");
    assert.equal(written.effort, "high");

    const fallbackId = "30b02c83-29af-41b4-9a65-726217600f03";
    const fallback = writeClaudeDesktopSessionMetadata({ sessionId: fallbackId, title: "Plain", cwd: root });
    const fallbackWritten = JSON.parse(fs.readFileSync(fallback, "utf8"));
    assert.equal(fallbackWritten.model, "claude-from-env");
    assert.equal(fallbackWritten.effort, "high");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previous;
    if (previousModel === undefined) delete process.env.RELAY_CLAUDE_METADATA_MODEL;
    else process.env.RELAY_CLAUDE_METADATA_MODEL = previousModel;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Claude Desktop's importCliSession builds the imported session with
// permissionMode "default" (the Manual label) hardcoded and saves it over the
// metadata Relay wrote before firing claude://resume. The title-repair pass runs
// after that import, so it is the last chance to put the mode back — it used to
// carry Desktop's "default" forward instead, which is why every Relay-opened
// session sat on Manual.
test("the title-repair pass overwrites the Manual mode Claude Desktop's import wrote", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-desktop-repair-"));
  const group = path.join(root, "account", "group");
  const sessionId = "6d9f5c21-4c2c-4f0a-9a2b-1d0f7c5b3e88";
  const metadataPath = path.join(group, `local_${sessionId}.json`);
  fs.mkdirSync(group, { recursive: true });
  // Exactly what Desktop persists for a freshly imported CLI session: its own
  // Default, no title, no titleSource.
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: `local_${sessionId}`,
    cliSessionId: sessionId,
    cwd: "/Users/dev/project",
    permissionMode: "default",
  }));
  const previous = process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = root;
  try {
    const result = restoreClaudeDesktopSessionTitle({
      sessionId,
      title: "Relay from Sven",
      cwd: "/Users/dev/project",
      metadataPath,
      retries: 1,
      delayMs: 0,
    });
    assert.equal(result.restored, true);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.permissionMode, relayClaudePermissionMode());
    assert.notEqual(metadata.permissionMode, "default");
    assert.equal(metadata.title, "Relay from Sven");
    assert.equal(metadata.titleSource, "user");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DESKTOP_SESSIONS_DIR;
    else process.env.CLAUDE_DESKTOP_SESSIONS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
