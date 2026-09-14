import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  codexHookCommand,
  hookInstallNotices,
  installCodexHooks,
  isRelayCodexHookCommand,
  uninstallCodexHooks,
} from "../src/install.js";

const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse"];
const NODE = "/opt/homebrew/bin/node";
const BIN = "/Users/x/.relay/lib/node_modules/relay-companion/bin/relay.js";

function hooksFixture(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-hooks-"));
  const hooksPath = path.join(dir, "hooks.json");
  if (initial !== undefined) fs.writeFileSync(hooksPath, initial);
  return hooksPath;
}

function readHooks(hooksPath) {
  return JSON.parse(fs.readFileSync(hooksPath, "utf8"));
}

function relayEntries(config, event) {
  return (config.hooks?.[event] || []).filter((entry) =>
    (entry.hooks || []).some((hook) => isRelayCodexHookCommand(hook.command)),
  );
}

test("legacy Codex installation preserves user hooks and never requests hook trust", () => {
  const hooksPath = hooksFixture(JSON.stringify({ description: "keep", hooks: {
    PostToolUse: [{ hooks: [{ type: "command", command: "review-bash" }] }],
  } }));
  const before = fs.readFileSync(hooksPath, "utf8");
  for (const node of [NODE, "/usr/local/bin/node"]) {
    const result = installCodexHooks(BIN, node, { hooksPath });
    assert.equal(result.ok, true);
    assert.equal(result.retired, true);
    assert.equal(result.requiresTrustReview, false);
    assert.deepEqual(result.events, []);
    assert.equal(fs.readFileSync(hooksPath, "utf8"), before);
  }
});

test("Codex hook repair removes legacy Relay Stop handlers while preserving user handlers", () => {
  const userHook = { type: "command", command: "audit-stop" };
  const relayHook = { type: "command", command: codexHookCommand(BIN, NODE), timeout: 5 };
  for (const userHooks of [[], [userHook]]) {
    const hooksPath = hooksFixture(JSON.stringify({
      hooks: { Stop: [{ matcher: "*", hooks: [...userHooks, relayHook] }] },
    }));
    const result = installCodexHooks(BIN, NODE, { hooksPath });
    assert.equal(result.ok, true);
    const config = readHooks(hooksPath);
    assert.equal(relayEntries(config, "Stop").length, 0);
    assert.deepEqual(config.hooks?.Stop, userHooks.length
      ? [{ matcher: "*", hooks: userHooks }]
      : undefined);
    for (const event of HOOK_EVENTS) assert.equal(relayEntries(config, event).length, 0);
    assert.equal(installCodexHooks(BIN, NODE, { hooksPath }).removed, undefined);
  }
});

test("Codex hook uninstall removes only Relay handlers", () => {
  const relayCommand = codexHookCommand(BIN, NODE);
  const hooksPath = hooksFixture(JSON.stringify({
    keep: true,
    hooks: {
      UserPromptSubmit: [{
        matcher: "*",
        hooks: [
          { type: "command", command: "audit-prompt" },
          { type: "command", command: relayCommand },
        ],
      }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: relayCommand }] }],
    },
  }, null, 2));

  const result = uninstallCodexHooks({ hooksPath });
  assert.equal(result.ok, true);
  const config = readHooks(hooksPath);
  assert.equal(config.keep, true);
  assert.deepEqual(config.hooks, {
    UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "audit-prompt" }] }],
  });
});

test("Codex hook install never clobbers malformed user config", () => {
  const broken = '{ "hooks": { not-json';
  const hooksPath = hooksFixture(broken);
  const result = installCodexHooks(BIN, NODE, { hooksPath });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "codex_hooks_unreadable");
  assert.equal(fs.readFileSync(hooksPath, "utf8"), broken);
});

test("hook retirement notices surface failures and cached-runtime restart guidance", () => {
  assert.deepEqual(hookInstallNotices({
    claudeHooks: { ok: false, reason: "claude_settings_unreadable", detail: "bad JSON" },
    codexHooks: { ok: true, restartRequired: true },
  }), [
    "Could not remove Relay's retired hooks for Claude Code (claude_settings_unreadable: bad JSON).",
    "Restart Codex to clear cached hooks pointing into an older Relay runtime.",
  ]);
  assert.deepEqual(hookInstallNotices({ codexHooks: { ok: true, requiresTrustReview: false } }), []);
});

test("relay CLI wires the internal Codex hook command and fails open", () => {
  const cli = fileURLToPath(new URL("../bin/relay.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "codex-hook"], {
    input: "not json",
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
