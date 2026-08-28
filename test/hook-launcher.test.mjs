import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureStableHookLauncher,
  stableHookLauncherPath,
  stableWindowsHookScriptPath,
} from "../src/hook-launcher.js";
import {
  claudeHookHandler,
  codexHookCommand,
  isRelayClaudeHookCommand,
  isRelayCodexHookCommand,
  repairExistingAgentHooks,
  repairExistingAgentRegistrations,
} from "../src/install.js";

function fixture(label = "home") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-hook-${label}-`));
}

function writeExecutable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}

const posixExecTest = process.platform === "win32" ? test.skip : test;

posixExecTest("POSIX bridge survives spaces and apostrophes, streams stdin, and prefers the dedicated entry", () => {
  const root = fixture("quoted");
  const homeDir = path.join(root, "Relay user's home");
  const targetBin = path.join(root, "runtime user's tree", "bin", "relay.js");
  writeExecutable(targetBin, "process.stdout.write('legacy');\n");
  writeExecutable(path.join(path.dirname(targetBin), "relay-hook.js"), `
let body = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) body += chunk;
process.stdout.write(process.argv[2] + ":" + body);
`);

  const invocation = ensureStableHookLauncher({ targetBin, node: process.execPath, homeDir, platform: "darwin" });
  const input = JSON.stringify({ prompt: "hello" });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, "claude-hook"], {
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `claude-hook:${input}`);
  assert.equal(invocation.markerPath, stableHookLauncherPath(homeDir));
  assert.match(fs.readFileSync(invocation.scriptPath, "utf8"), /exec "\$node"/);
  const handler = claudeHookHandler("ignored", "ignored", invocation);
  const throughHostShell = spawnSync("/bin/sh", ["-c", handler.command], { input, encoding: "utf8" });
  assert.equal(throughHostShell.status, 0, throughHostShell.stderr);
  assert.equal(throughHostShell.stdout, `claude-hook:${input}`);
  assert.match(handler.command, /relay\.js'\s+claude-hook$/);
});

posixExecTest("bridge fails silently and immediately when the target runtime is missing", () => {
  const root = fixture("missing");
  const invocation = ensureStableHookLauncher({
    targetBin: path.join(root, "gone", "bin", "relay.js"),
    node: process.execPath,
    homeDir: path.join(root, "home"),
    platform: "linux",
  });
  const started = Date.now();
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, "codex-hook"], {
    input: "x".repeat(1024 * 1024),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(Date.now() - started < 1000, "missing runtime does not wait through the five-second host deadline");
});

posixExecTest("POSIX host timeout terminates the dedicated hook process, not an orphaned child", async () => {
  const root = fixture("timeout");
  const targetBin = path.join(root, "runtime", "bin", "relay.js");
  const pidFile = path.join(root, "hook.pid");
  writeExecutable(targetBin, "// legacy fallback\n");
  writeExecutable(path.join(path.dirname(targetBin), "relay-hook.js"), `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const invocation = ensureStableHookLauncher({ targetBin, node: process.execPath, homeDir: root, platform: "linux" });
  const child = spawn(invocation.command, [...invocation.argsPrefix, "claude-hook"], { stdio: "ignore" });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(pidFile), true, "dedicated runtime started");
  assert.equal(Number(fs.readFileSync(pidFile, "utf8")), child.pid, "shell was replaced with Node");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

posixExecTest("legacy relay.js remains a silent fail-open downgrade fallback", () => {
  const root = fixture("legacy");
  const targetBin = path.join(root, "old runtime", "bin", "relay.js");
  writeExecutable(targetBin, "process.stdout.write('old'); process.stderr.write('hidden'); process.exit(7);\n");
  const invocation = ensureStableHookLauncher({ targetBin, node: process.execPath, homeDir: root, platform: "darwin" });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, "claude-hook"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "old");
  assert.equal(result.stderr, "");
});

test("atomic target refresh keeps the host command stable", () => {
  const homeDir = fixture("refresh");
  const first = ensureStableHookLauncher({
    targetBin: path.join(homeDir, "release-a", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    platform: "linux",
  });
  const before = fs.readFileSync(first.scriptPath, "utf8");
  const second = ensureStableHookLauncher({
    targetBin: path.join(homeDir, "release-b", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    platform: "linux",
  });
  const after = fs.readFileSync(second.scriptPath, "utf8");
  assert.equal(second.command, first.command);
  assert.deepEqual(second.argsPrefix, first.argsPrefix);
  assert.notEqual(after, before);
  assert.match(after, /release-b/);
  assert.doesNotMatch(after, /release-a/);
});

test("Windows bridge uses a stable PowerShell script and legacy-compatible ownership marker", () => {
  const homeDir = fixture("windows");
  const invocation = ensureStableHookLauncher({
    targetBin: "C:\\Users\\A B\\.relay\\runtime\\r1\\bin\\relay.js",
    node: "C:\\Program Files\\nodejs\\node.exe",
    homeDir,
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
  });
  assert.equal(invocation.scriptPath, stableWindowsHookScriptPath(homeDir));
  assert.ok(fs.existsSync(invocation.markerPath));
  assert.match(fs.readFileSync(invocation.scriptPath, "utf8"), /-PathType Leaf/);
  const claude = claudeHookHandler("ignored", "ignored", invocation);
  assert.equal(claude.args, undefined);
  assert.match(claude.command, /relay\.js["']? claude-hook$/);
  assert.equal(isRelayClaudeHookCommand(claude), true, "older installers can recognize and replace the handler");
  assert.match(claude.command, /relay\.js["']?\s+claude-hook(?:\s|$)/, "0.1.57 shell-only detector recognizes it");
  const codex = codexHookCommand("ignored", "ignored", invocation);
  assert.equal(isRelayCodexHookCommand(codex), true, "older uninstall/downgrade can recognize the command");
  assert.match(codex, /relay\.js["']? codex-hook$/);
});

test("repair migrates and deduplicates only existing Relay hooks", () => {
  const homeDir = fixture("migration");
  const claudeSettingsFile = path.join(homeDir, ".claude", "settings.json");
  const codexHooksFile = path.join(homeDir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
  fs.mkdirSync(path.dirname(codexHooksFile), { recursive: true });
  fs.writeFileSync(claudeSettingsFile, JSON.stringify({ hooks: {
    Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "user-stop" },
      { type: "command", command: "/old/node", args: ["/old/relay.js", "claude-hook"], timeout: 5 },
    ] }],
  } }));
  fs.writeFileSync(codexHooksFile, JSON.stringify({ hooks: {
    Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "user-stop" },
      { type: "command", command: "/old/node /old/relay.js codex-hook", timeout: 5 },
    ] }],
  } }));

  const result = repairExistingAgentHooks({
    bin: path.join(homeDir, "runtime", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    platform: "linux",
    claudeSettingsFile,
    codexHooksFile,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempted, true);
  const claude = JSON.parse(fs.readFileSync(claudeSettingsFile));
  const codex = JSON.parse(fs.readFileSync(codexHooksFile));
  for (const entries of Object.values(claude.hooks)) {
    assert.equal(entries.filter((entry) => entry.hooks.some(isRelayClaudeHookCommand)).length, 1);
  }
  for (const entries of Object.values(codex.hooks)) {
    assert.equal(entries.filter((entry) => entry.hooks.some((hook) => isRelayCodexHookCommand(hook.command))).length, 1);
  }
  assert.ok(claude.hooks.Stop[0].hooks.some((hook) => hook.command === "user-stop"));
  assert.ok(codex.hooks.Stop[0].hooks.some((hook) => hook.command === "user-stop"));
});

test("repair does not create absent host configs and ignores unrelated malformed configs", () => {
  const homeDir = fixture("absent");
  const claudeSettingsFile = path.join(homeDir, ".claude", "settings.json");
  const codexHooksFile = path.join(homeDir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
  fs.writeFileSync(claudeSettingsFile, "{ user settings are malformed");
  const before = fs.readFileSync(claudeSettingsFile, "utf8");
  const result = repairExistingAgentHooks({
    bin: path.join(homeDir, "runtime", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    claudeSettingsFile,
    codexHooksFile,
  });
  assert.deepEqual(result, { ok: true, attempted: false });
  assert.equal(fs.readFileSync(claudeSettingsFile, "utf8"), before);
  assert.equal(fs.existsSync(codexHooksFile), false);
  assert.equal(fs.existsSync(stableHookLauncherPath(homeDir)), false);
});

test("repair-installation preserves state while migrating hooks before refreshing restartable services", () => {
  const cliPath = fileURLToPath(new URL("../bin/relay.js", import.meta.url));
  const cli = fs.readFileSync(cliPath, "utf8");
  const start = cli.indexOf("function cmdRepairDesktop(");
  const end = cli.indexOf("\n}\n", start);
  const command = cli.slice(start, end);
  assert.ok(command.indexOf("repairExistingAgentHooks()") >= 0);
  assert.ok(command.indexOf("repairDesktopSurfaces(") > command.indexOf("repairExistingAgentHooks()"));
  assert.doesNotMatch(command, /writeConfig|purgeLocalState|revoke/i);
  assert.match(cli, /case "repair-installation":\s*case "repair-desktop":\s*return cmdRepairDesktop/);
  assert.match(cli, /preserves account, encryption, messages, outbox, and preferences/);
  assert.match(cli, /flags\["target-bin"\]/, "candidate repair can retarget a legacy runtime during rollback");
  assert.match(cli, /flags\["target-node"\]/);
  assert.match(cli, /reconcileCanonicalRuntimeNode/, "runtime repair reconciles the durable Node into current.json");
  assert.match(cli, /reconcileCanonicalRuntimeNode\(\{ node: runtimeNode \}\)/, "a claimed repair updates the active pointer regardless of its invoking install tree");
  assert.match(cli, /Relay runtime repaired with its durable Node/, "runtime repair reports what it repaired");
});

test("candidate runtime repair refreshes only existing Relay MCP registrations", () => {
  const homeDir = fixture("runtime-registration");
  const bin = path.join(homeDir, "release", "bin", "relay.js");
  const claudeConfigFile = path.join(homeDir, ".claude.json");
  const codexConfigFile = path.join(homeDir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
  fs.writeFileSync(claudeConfigFile, JSON.stringify({ keep: true, mcpServers: { relay: { command: "old" } } }));
  fs.writeFileSync(codexConfigFile, "model = \"keep\"\n\n[mcp_servers.relay]\ncommand = \"old\"\n");
  const result = repairExistingAgentRegistrations({
    bin,
    node: process.execPath,
    homeDir,
    platform: process.platform,
    claudeConfigFile,
    codexConfigFile,
    claudeSettingsFile: path.join(homeDir, ".claude", "settings.json"),
    codexHooksFile: path.join(homeDir, ".codex", "hooks.json"),
  });
  assert.equal(result.ok, true);
  assert.ok(result.mcpBin);
  assert.equal(JSON.parse(fs.readFileSync(claudeConfigFile, "utf8")).keep, true);
  assert.equal(JSON.parse(fs.readFileSync(claudeConfigFile, "utf8")).mcpServers.relay.args[1], result.mcpBin);
  assert.match(fs.readFileSync(codexConfigFile, "utf8"), /model = "keep"/);
  const bridge = path.resolve(path.dirname(bin), "../src/mcp-bridge.js");
  assert.ok(fs.readFileSync(result.mcpBin, "utf8").includes(JSON.stringify(bridge)));
});

test("candidate runtime repair does not add Relay MCP to unrelated host configs", () => {
  const homeDir = fixture("runtime-skip");
  const claudeConfigFile = path.join(homeDir, ".claude.json");
  const codexConfigFile = path.join(homeDir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
  fs.writeFileSync(claudeConfigFile, "{ unrelated malformed Claude config");
  fs.writeFileSync(codexConfigFile, "model = \"keep\"\n");
  const beforeClaude = fs.readFileSync(claudeConfigFile, "utf8");
  const beforeCodex = fs.readFileSync(codexConfigFile, "utf8");
  const result = repairExistingAgentRegistrations({
    bin: path.join(homeDir, "release", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    platform: "linux",
    claudeConfigFile,
    codexConfigFile,
    claudeSettingsFile: path.join(homeDir, ".claude", "settings.json"),
    codexHooksFile: path.join(homeDir, ".codex", "hooks.json"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mcpBin, null);
  assert.equal(fs.readFileSync(claudeConfigFile, "utf8"), beforeClaude);
  assert.equal(fs.readFileSync(codexConfigFile, "utf8"), beforeCodex);
});

test("candidate runtime repair refreshes an existing Claude Desktop-only registration", () => {
  const homeDir = fixture("desktop-only");
  const desktopDir = path.join(homeDir, "Claude data");
  const desktopConfig = path.join(desktopDir, "claude_desktop_config.json");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(desktopConfig, JSON.stringify({ keep: true, mcpServers: {
    relay: { command: "old-node", args: ["old-relay", "mcp"] },
    other: { command: "keep" },
  } }));
  const result = repairExistingAgentRegistrations({
    bin: path.join(homeDir, "release", "bin", "relay.js"),
    node: process.execPath,
    homeDir,
    platform: "darwin",
    env: { CLAUDE_USER_DATA_DIR: desktopDir },
    claudeConfigFile: path.join(homeDir, "absent-claude.json"),
    codexConfigFile: path.join(homeDir, "absent-codex.toml"),
    claudeSettingsFile: path.join(homeDir, "absent-settings.json"),
    codexHooksFile: path.join(homeDir, "absent-hooks.json"),
  });
  assert.equal(result.ok, true);
  assert.ok(result.mcpBin, "Desktop-only registration still refreshes the stable MCP target");
  const config = JSON.parse(fs.readFileSync(desktopConfig, "utf8"));
  assert.equal(config.keep, true);
  assert.deepEqual(config.mcpServers.other, { command: "keep" });
  assert.equal(config.mcpServers.relay.args[1], result.mcpBin);
});
