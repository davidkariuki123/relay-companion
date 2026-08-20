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

const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];
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

test("Codex hook install is preserving, idempotent, and requests trust only when changed", () => {
  const userEntry = { matcher: "^Bash$", hooks: [{ type: "command", command: "review-bash" }] };
  const userStopEntry = { matcher: "*", hooks: [{ type: "command", command: "audit-stop" }] };
  const hooksPath = hooksFixture(JSON.stringify({
    description: "user hooks",
    hooks: { PostToolUse: [userEntry], Stop: [userStopEntry] },
  }, null, 2));

  const first = installCodexHooks(BIN, NODE, { hooksPath });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.requiresTrustReview, true);
  let config = readHooks(hooksPath);
  assert.equal(config.description, "user hooks");
  assert.deepEqual(config.hooks.PostToolUse[0], userEntry);
  assert.deepEqual(config.hooks.Stop[0], userStopEntry);
  for (const event of HOOK_EVENTS) {
    const entries = relayEntries(config, event);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      matcher: "*",
      hooks: [{ type: "command", command: `${NODE} ${BIN} codex-hook`, timeout: 5 }],
    });
  }

  const before = fs.readFileSync(hooksPath, "utf8");
  const second = installCodexHooks(BIN, NODE, { hooksPath });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.requiresTrustReview, false);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), before, "unchanged install does not rewrite hooks.json");

  const moved = installCodexHooks(BIN, "/usr/local/bin/node", { hooksPath });
  assert.equal(moved.changed, true);
  assert.equal(moved.requiresTrustReview, true);
  config = readHooks(hooksPath);
  for (const event of HOOK_EVENTS) {
    assert.equal(relayEntries(config, event).length, 1);
    assert.equal(relayEntries(config, event)[0].hooks[0].command, `/usr/local/bin/node ${BIN} codex-hook`);
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

test("hook install notices surface failures and Codex trust review", () => {
  assert.deepEqual(hookInstallNotices({
    claudeHooks: { ok: false, reason: "claude_settings_unreadable", detail: "bad JSON" },
    codexHooks: { ok: true, requiresTrustReview: true },
  }), [
    "Could not install Relay hooks for Claude Code (claude_settings_unreadable: bad JSON).",
    "Codex requires one final step: open `/hooks` in Codex and trust the Relay hook.",
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
