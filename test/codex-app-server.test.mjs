import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defaultCodexCommand, windowsBundledCodexCommand } from "../src/codex-app-server.js";

test("Windows uses the newest Desktop-bundled Codex CLI", () => {
  const env = { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` };
  const binDir = path.win32.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const entries = [
    { name: "old-hash", isDirectory: () => true },
    { name: "current-hash", isDirectory: () => true },
    { name: "codex.exe", isDirectory: () => false },
  ];
  const modified = new Map([
    [path.win32.join(binDir, "old-hash", "codex.exe"), 100],
    [path.win32.join(binDir, "current-hash", "codex.exe"), 200],
  ]);
  const selected = windowsBundledCodexCommand({
    env,
    readdirSync: () => entries,
    existsSync: (candidate) => modified.has(candidate),
    statSync: (candidate) => ({ mtimeMs: modified.get(candidate) }),
  });
  assert.equal(selected, path.win32.join(binDir, "current-hash", "codex.exe"));
});

test("an explicit Codex CLI path still overrides Desktop discovery", () => {
  assert.equal(defaultCodexCommand({
    platform: "win32",
    env: { CODEX_CLI_PATH: String.raw`D:\tools\codex.exe`, LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
  }), String.raw`D:\tools\codex.exe`);
});
