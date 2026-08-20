import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultClaudeDesktopConfigPath,
  defaultClaudeDesktopSessionsDir,
} from "../src/host-paths.js";

test("Claude Desktop paths use APPDATA on Windows", () => {
  const options = {
    platform: "win32",
    env: { APPDATA: "C:\\Users\\David\\AppData\\Roaming" },
    homedir: "C:\\Users\\David",
  };

  assert.equal(
    defaultClaudeDesktopConfigPath(options),
    "C:\\Users\\David\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(
    defaultClaudeDesktopSessionsDir(options),
    "C:\\Users\\David\\AppData\\Roaming\\Claude\\claude-code-sessions",
  );
});

test("Claude Desktop paths preserve macOS Application Support defaults", () => {
  const options = {
    platform: "darwin",
    env: {},
    homedir: "/Users/david",
  };

  assert.equal(
    defaultClaudeDesktopConfigPath(options),
    "/Users/david/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    defaultClaudeDesktopSessionsDir(options),
    "/Users/david/Library/Application Support/Claude/claude-code-sessions",
  );
});
