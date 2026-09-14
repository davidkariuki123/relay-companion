import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installClaudeHooks, installCodexHooks, uninstallClaudeHooks, uninstallCodexHooks,
  isRelayClaudeHookCommand, isRelayCodexHookCommand, retireAgentHooks,
  installClaudeHooksWithStableLauncher, installCodexHooksWithStableLauncher,
  agentHookRetirementStatus,
} from "../src/install.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-retirement-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const claudeSettingsFile = path.join(homeDir, ".claude", "settings.json");
  const codexHooksFile = path.join(homeDir, ".codex", "hooks.json");
  return { homeDir, claudeSettingsFile, codexHooksFile, node: process.execPath,
    bin: path.join(homeDir, "runtime", "bin", "relay.js") };
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
const userHook = { type: "command", command: "user-owned-command", timeout: 11 };
const permissions = { allow: ["Bash(ls:*)", "mcp__relay__relay_ai_session"], deny: ["Bash(rm:*)"] };
function legacy(host) {
  return { theme: "keep", permissions, hooks: Object.fromEntries(
    ["Stop", "PostToolUse", "SessionStart", "UserPromptSubmit", "FutureEvent"].map(event => [event, [
      { matcher: "Edit", custom: true, hooks: [userHook, { type: "command", command: `node '/old path/relay.js' '${host}-hook'` }] },
      { hooks: [{ type: "command", command: "node", args: ["C:\\old\\relay-hook.js", `${host}-hook`] }] },
    ]])) };
}

for (const [host, install, uninstall, predicate] of [
  ["claude", installClaudeHooks, uninstallClaudeHooks, isRelayClaudeHookCommand],
  ["codex", installCodexHooks, uninstallCodexHooks, isRelayCodexHookCommand],
]) {
  test(`${host} legacy installer removes only Relay handlers across all event names`, t => {
    const f = fixture(t);
    const file = host === "claude" ? f.claudeSettingsFile : f.codexHooksFile;
    const options = host === "claude" ? { settingsPath: file } : { hooksPath: file };
    write(file, legacy(host));
    assert.equal(install(f.bin, f.node, options).retired, true);
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(content.permissions, permissions);
    assert.equal(content.theme, "keep");
    for (const entries of Object.values(content.hooks)) {
      assert.deepEqual(entries, [{ matcher: "Edit", custom: true, hooks: [userHook] }]);
    }
    const before = fs.readFileSync(file, "utf8");
    assert.equal(install(f.bin, f.node, options).ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.existsSync(path.join(f.homeDir, ".relay")), false, "legacy per-file API has no unrelated filesystem effects");
  });

  test(`${host} absent and malformed settings are never overwritten`, t => {
    const f = fixture(t);
    const file = host === "claude" ? f.claudeSettingsFile : f.codexHooksFile;
    const options = host === "claude" ? { settingsPath: file } : { hooksPath: file };
    assert.equal(install(f.bin, f.node, options).ok, true);
    assert.equal(fs.existsSync(file), false);
    write(file, '{"hooks": invalid');
    assert.equal(install(f.bin, f.node, options).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), '{"hooks": invalid');
    assert.equal(uninstall(options).ok, false);
  });

  test(`${host} recognizes historic shell, dedicated entry, exec and Windows shapes only`, () => {
    for (const command of [
      `node /old/relay.js ${host}-hook`, `node '/path with spaces/relay-hook.js' '${host}-hook'`,
      { command: "node", args: ["C:\\Users\\A B\\relay.js", `${host}-hook`] },
      { command: "powershell", args: ["-File", "C:\\Users\\A B\\.relay\\bin\\hook-launcher.ps1", "C:\\Users\\A B\\.relay\\bin\\relay.js", `${host}-hook`] },
    ]) assert.equal(predicate(command), true, JSON.stringify(command));
    for (const command of ["user-owned-command", `node /other/not-relay.js ${host}-hook`, `node /x/relay.js ${host}-hook-extra`, `echo "node /x/relay.js ${host}-hook"`, `node -e "console.log('relay.js ${host}-hook')"`, "relay mcp"]) {
      assert.equal(predicate(command), false, command);
    }
  });
}

test("retirement covers primary, local and Codex files and leaves a silent bridge", t => {
  const f = fixture(t);
  const local = path.join(path.dirname(f.claudeSettingsFile), "settings.local.json");
  write(f.claudeSettingsFile, legacy("claude"));
  write(local, legacy("claude"));
  write(f.codexHooksFile, legacy("codex"));
  const first = retireAgentHooks(f);
  assert.equal(first.ok, true);
  assert.equal(first.restartRequired, true);
  assert.equal(first.claudeHooks.files.length, 2);
  assert.equal(agentHookRetirementStatus(f).registeredHandlers, 0);
  const report = agentHookRetirementStatus(f).lastMigration;
  assert.ok(report.lastRawHookRemovalAt);
  assert.doesNotMatch(JSON.stringify(report), /user-owned-command|old path/);
  assert.equal(retireAgentHooks(f).attempted, false);
  assert.equal(agentHookRetirementStatus(f).lastMigration.lastRawHookRemovalAt, report.lastRawHookRemovalAt, "repeat repair cannot claim cached raw hooks have stopped");
  const bridge = fs.readFileSync(first.hookInvocation.scriptPath, "utf8");
  assert.match(bridge, /Relay hooks are retired/);
  assert.doesNotMatch(bridge, /runtime\/bin|relay-hook\.js/);
});

test("unreadable Relay settings fail visibly after neutralizing the bridge", t => {
  const f = fixture(t);
  const malformed = '{"hooks": [{ "command": "node /old/relay.js claude-hook"';
  write(f.claudeSettingsFile, malformed);
  const result = retireAgentHooks(f);
  assert.equal(result.ok, false);
  assert.equal(result.retired, false);
  assert.equal(result.reason, "hook_retirement_incomplete");
  assert.equal(fs.readFileSync(f.claudeSettingsFile, "utf8"), malformed);
  assert.match(fs.readFileSync(result.hookInvocation.scriptPath, "utf8"), /Relay hooks are retired/);
  assert.deepEqual(agentHookRetirementStatus(f).unreadableFiles, [f.claudeSettingsFile]);
});

test("a bridge write failure cannot report a completed migration or alter settings", t => {
  const f = fixture(t);
  write(f.claudeSettingsFile, legacy("claude"));
  write(path.join(f.homeDir, ".relay"), "not a directory");
  const before = fs.readFileSync(f.claudeSettingsFile, "utf8");
  const result = retireAgentHooks(f);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hook_launcher_write_failed");
  assert.equal(fs.readFileSync(f.claudeSettingsFile, "utf8"), before);
});

test("legacy stable installers respect the supplied home and can only retire", t => {
  const f = fixture(t);
  write(f.claudeSettingsFile, legacy("claude"));
  write(f.codexHooksFile, legacy("codex"));
  assert.equal(installClaudeHooksWithStableLauncher(f.bin, f.node, { homeDir: f.homeDir, settingsPath: f.claudeSettingsFile }).ok, true);
  assert.equal(installCodexHooksWithStableLauncher(f.bin, f.node, { homeDir: f.homeDir, hooksPath: f.codexHooksFile }).ok, true);
  assert.equal(agentHookRetirementStatus(f).registeredHandlers, 0);
});
