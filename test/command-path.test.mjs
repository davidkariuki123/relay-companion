import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists, resolveCommand } from "../src/command-path.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-command-path-"));
}

test("finds a Windows executable on PATH through PATHEXT without any Unix tool", () => {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, "codex.exe"), "");
  const env = { PATH: `C:\\nowhere;${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolveCommand("codex", { env, platform: "win32" }), path.join(bin, "codex.exe"));
  assert.equal(commandExists("codex", { env, platform: "win32" }), true);
  assert.equal(commandExists("claude", { env, platform: "win32" }), false);
});

test("falls back to the default PATHEXT list when the variable is unset", () => {
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, "claude.cmd"), "");
  assert.equal(commandExists("claude", { env: { Path: bin }, platform: "win32" }), true);
});

test("honors an explicit path and rejects directories", () => {
  const bin = tempDir();
  const file = path.join(bin, "codex.exe");
  fs.writeFileSync(file, "");
  assert.equal(resolveCommand(file, { env: {}, platform: "win32" }), file);
  assert.equal(resolveCommand(path.join(bin, "codex"), { env: {}, platform: "win32" }), file);
  assert.equal(commandExists(bin, { env: {}, platform: "win32" }), false);
  assert.equal(commandExists("", { env: { PATH: bin }, platform: "win32" }), false);
});

test("requires the executable bit outside Windows", { skip: process.platform === "win32" }, () => {
  const bin = tempDir();
  const file = path.join(bin, "codex");
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(commandExists("codex", { env: { PATH: bin }, platform: "linux" }), false);
  fs.chmodSync(file, 0o755);
  assert.equal(commandExists("codex", { env: { PATH: bin }, platform: "linux" }), true);
});
