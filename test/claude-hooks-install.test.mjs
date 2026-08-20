// Tests for the Claude Code hook installer (install.js installClaudeHooks /
// uninstallClaudeHooks): idempotent merge into settings.json, full preservation
// of user content, and uninstall that removes ONLY Relay's entries. All against
// temp settings files — never the real ~/.claude/settings.json.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeHookCommand,
  claudeHookHandler,
  installClaudeHooks,
  isRelayClaudeHookCommand,
  uninstallClaudeHooks,
} from "../src/install.js";

const HOOK_EVENTS = ["PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"];
const NODE = "/opt/homebrew/bin/node";
const BIN = "/Users/x/.relay/lib/node_modules/relay-companion/bin/relay.js";
const RELAY_ALLOWED_TOOLS = [
  "mcp__relay__relay_ai_sessions",
  "mcp__relay__relay_ai_session",
  "mcp__relay__relay_sessions",
  "mcp__relay__relay_session",
];

function settingsFixture(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-hooks-"));
  const settingsPath = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(settingsPath, initial);
  return settingsPath;
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function relayEntries(settings, event) {
  return (settings.hooks?.[event] || []).filter((entry) =>
    (entry.hooks || []).some((hook) => isRelayClaudeHookCommand(hook)),
  );
}

test("installClaudeHooks creates settings.json with one tagged entry per event", () => {
  const settingsPath = settingsFixture();
  const res = installClaudeHooks(BIN, NODE, { settingsPath });
  assert.equal(res.ok, true);
  const settings = readSettings(settingsPath);
  assert.deepEqual(settings.permissions.allow, RELAY_ALLOWED_TOOLS);
  for (const event of HOOK_EVENTS) {
    const entries = relayEntries(settings, event);
    assert.equal(entries.length, 1, `${event} gets exactly one Relay entry`);
    assert.equal(entries[0].matcher, "*");
    const hook = entries[0].hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.timeout, 5);
    assert.equal(hook.command, NODE);
    assert.deepEqual(hook.args, [BIN, "claude-hook"]);
    assert.equal(isRelayClaudeHookCommand(hook), true, "exec-form hook is recognizably Relay-owned");
  }
});

test("reinstalling is idempotent and refreshes a moved runtime path without duplicates", () => {
  const settingsPath = settingsFixture();
  installClaudeHooks(BIN, NODE, { settingsPath });
  installClaudeHooks(BIN, NODE, { settingsPath });
  const movedNode = "/usr/local/bin/node";
  installClaudeHooks(BIN, movedNode, { settingsPath });
  const settings = readSettings(settingsPath);
  for (const event of HOOK_EVENTS) {
    const entries = relayEntries(settings, event);
    assert.equal(entries.length, 1, `${event} never accumulates duplicates`);
    assert.equal(entries[0].hooks[0].command, movedNode);
    assert.deepEqual(entries[0].hooks[0].args, [BIN, "claude-hook"]);
  }
});

test("install preserves every user setting and every user hook", () => {
  const userSettings = {
    permissions: { allow: ["Bash(ls:*)"] },
    model: "opus",
    hooks: {
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "eslint --fix" }] }],
      Notification: [{ hooks: [{ type: "command", command: "afplay ding.wav" }] }],
    },
  };
  const settingsPath = settingsFixture(JSON.stringify(userSettings, null, 2));
  const res = installClaudeHooks(BIN, NODE, { settingsPath });
  assert.equal(res.ok, true);
  const settings = readSettings(settingsPath);
  assert.deepEqual(settings.permissions, {
    allow: ["Bash(ls:*)", ...RELAY_ALLOWED_TOOLS],
  });
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.hooks.Notification, userSettings.hooks.Notification);
  const postToolUse = settings.hooks.PostToolUse;
  assert.equal(postToolUse.length, 2);
  assert.deepEqual(postToolUse[0], userSettings.hooks.PostToolUse[0], "user entry survives untouched, in place");
  assert.equal(relayEntries(settings, "PostToolUse").length, 1);
});

test("a corrupt settings.json is never clobbered", () => {
  const broken = '{ "hooks": { this is not json';
  const settingsPath = settingsFixture(broken);
  const res = installClaudeHooks(BIN, NODE, { settingsPath });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "claude_settings_unreadable");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), broken, "file left byte-identical");
});

test("uninstall removes only Relay entries and drops event keys Relay emptied", () => {
  const settingsPath = settingsFixture(
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "eslint --fix" }] }],
        SessionEnd: [],
      },
    }),
  );
  installClaudeHooks(BIN, NODE, { settingsPath });
  const res = uninstallClaudeHooks({ settingsPath });
  assert.equal(res.ok, true);
  const settings = readSettings(settingsPath);
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
  assert.deepEqual(settings.hooks.PostToolUse, [
    { matcher: "Edit", hooks: [{ type: "command", command: "eslint --fix" }] },
  ]);
  // events that only ever held our entry are gone; the user's own empty array stays
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    assert.equal(settings.hooks[event], undefined, `${event} emptied by our removal is dropped`);
  }
  assert.deepEqual(settings.hooks.SessionEnd, [], "user's own empty array is untouched");
});

test("uninstall strips a Relay hook that was merged into a shared entry, keeping the user's hook", () => {
  const settingsPath = settingsFixture(
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "say done" },
              { type: "command", command: claudeHookCommand(BIN, NODE) },
            ],
          },
        ],
      },
    }),
  );
  const res = uninstallClaudeHooks({ settingsPath });
  assert.equal(res.ok, true);
  const settings = readSettings(settingsPath);
  assert.deepEqual(settings.hooks.Stop, [{ matcher: "*", hooks: [{ type: "command", command: "say done" }] }]);
});

test("uninstall on a settings file without Relay hooks changes nothing", () => {
  const original = JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }, null, 2);
  const settingsPath = settingsFixture(original);
  const res = uninstallClaudeHooks({ settingsPath });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original, "no gratuitous rewrite");
  const missing = uninstallClaudeHooks({ settingsPath: path.join(path.dirname(settingsPath), "absent.json") });
  assert.equal(missing.ok, true);
});

test("hook commands with spaces use Claude exec form and remain recognizably ours", () => {
  const handler = claudeHookHandler("/Users/x y/relay companion/bin/relay.js", "/opt/some node/bin/node");
  assert.deepEqual(handler, {
    type: "command",
    command: "/opt/some node/bin/node",
    args: ["/Users/x y/relay companion/bin/relay.js", "claude-hook"],
    timeout: 5,
  });
  assert.equal(isRelayClaudeHookCommand(handler), true);
  const legacyCommand = claudeHookCommand("/Users/x y/relay companion/bin/relay.js", "/opt/some node/bin/node");
  assert.equal(isRelayClaudeHookCommand(legacyCommand), true, "legacy shell form remains removable");
  assert.equal(isRelayClaudeHookCommand("eslint --fix"), false);
  assert.equal(isRelayClaudeHookCommand("node relay.js mcp"), false);
});

test("install replaces legacy shell-form Relay hooks with exec form", () => {
  const settingsPath = settingsFixture(JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        matcher: "*",
        hooks: [{ type: "command", command: claudeHookCommand(BIN, NODE), timeout: 5 }],
      }],
    },
  }));
  installClaudeHooks(BIN, NODE, { settingsPath });
  const entry = relayEntries(readSettings(settingsPath), "UserPromptSubmit")[0];
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].command, NODE);
  assert.deepEqual(entry.hooks[0].args, [BIN, "claude-hook"]);
});
