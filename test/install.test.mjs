import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  claudeAppearsPresent,
  claudeSettingsPath,
  ensureElectronRuntime,
  installClaudeHooks,
  isRelayClaudeHookCommand,
  isRelayCodexHookCommand,
  installDaemonAutostart,
  installRelayMacApp,
  repairDesktopSurfaces,
  repairAgentMcpRegistrations,
  removeCodexMcpConfig,
  removeTomlTable,
  replaceTomlTable,
  updateTomlStringArray,
  stableNodePath,
  ensureWindowsHiddenLauncher,
  windowsHiddenLauncherPath,
  windowsTaskAction,
  windowsTaskXml,
  windowsAutostartTaskStatus,
  writeClaudeCodeMcpConfig,
  writeCodexMcpConfig,
} from "../src/install.js";

test("Windows task status distinguishes a missing task from an unavailable scheduler query", () => {
  const missing = windowsAutostartTaskStatus({
    platform: "win32",
    runCommand: (_command, args) => args.at(-1) === "Relay Companion Daemon"
      ? { ok: true, out: "" }
      : { ok: false, out: "ERROR: The system cannot find the file specified." },
  });
  assert.deepEqual(missing, { missing: ["Relay Companion Pill"], unavailable: [] });

  const unavailable = windowsAutostartTaskStatus({
    platform: "win32",
    runCommand: () => ({ ok: false, out: "ERROR: The system cannot find the path specified." }),
  });
  assert.deepEqual(unavailable.missing, []);
  assert.deepEqual(unavailable.unavailable.map((entry) => entry.taskName), [
    "Relay Companion Daemon",
    "Relay Companion Pill",
  ]);
});

test("agent repair refreshes MCP launchers and preserves Relay hooks for existing fleets", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-mcp-repair-"));
  const bin = path.join(homeDir, ".relay", "lib", "node_modules", "relay-companion", "bin", "relay.js");
  const claudeConfigFile = path.join(homeDir, ".claude.json");
  const codexConfigFile = path.join(homeDir, ".codex", "config.toml");
  const claudeSettingsFile = path.join(homeDir, ".claude", "settings.json");
  const codexHooksFile = path.join(homeDir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
  fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
  fs.writeFileSync(bin, "// target\n");
  fs.writeFileSync(claudeConfigFile, JSON.stringify({ mcpServers: {} }));
  fs.writeFileSync(codexConfigFile, "model = \"test\"\n");
  fs.writeFileSync(claudeSettingsFile, JSON.stringify({
    theme: "dark",
    hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [
      { type: "command", command: "audit-claude" },
      { type: "command", command: process.execPath, args: [bin, "claude-hook"], timeout: 5 },
    ] }] },
  }));
  fs.writeFileSync(codexHooksFile, JSON.stringify({
    description: "keep me",
    hooks: { Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "audit-codex" },
      { type: "command", command: `${process.execPath} ${bin} codex-hook`, timeout: 5 },
    ] }] },
  }));
  const result = repairAgentMcpRegistrations({
    bin,
    node: process.execPath,
    homeDir,
    claudeConfigFile,
    codexConfigFile,
    claudeSettingsFile,
    codexHooksFile,
  });
  assert.equal(result.mcpBin, path.join(homeDir, ".relay", "bin", "mcp-launcher.cjs"));
  assert.equal(JSON.parse(fs.readFileSync(claudeConfigFile, "utf8")).mcpServers.relay.args[1], result.mcpBin);
  // Compare against the path AS THE FILE STORES IT. A TOML basic string escapes
  // backslashes (tomlQuote is JSON.stringify), so a raw Windows path turned into a
  // regex looks for `C:\Users\…` while the file legitimately holds `C:\\Users\\…`
  // and can never match — green on POSIX, permanently red on Windows.
  assert.ok(
    fs.readFileSync(codexConfigFile, "utf8").includes(JSON.stringify(result.mcpBin)),
    "the Codex TOML points at the launcher, quoted the way TOML requires",
  );
  assert.equal(result.claudeHooks.ok, true);
  assert.equal(result.codexHooks.ok, true);
  assert.equal(result.hookRepair.attempted, true);
  const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsFile, "utf8"));
  assert.equal(claudeSettings.theme, "dark");
  assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command, "audit-claude");
  assert.ok(claudeSettings.hooks.UserPromptSubmit.some((entry) =>
    entry.hooks.some((hook) => isRelayClaudeHookCommand(hook))));
  const codexHooks = JSON.parse(fs.readFileSync(codexHooksFile, "utf8"));
  assert.equal(codexHooks.description, "keep me");
  assert.equal(codexHooks.hooks.Stop[0].hooks[0].command, "audit-codex");
  assert.ok(codexHooks.hooks.Stop.some((entry) =>
    entry.hooks.some((hook) => isRelayCodexHookCommand(hook.command))));
});

function relayDesktopFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-desktop-fixture-"));
  const homeDir = path.join(root, "home");
  const packageRoot = path.join(root, "relay-companion");
  const bin = path.join(packageRoot, "bin", "relay.js");
  const overlayMain = path.join(packageRoot, "overlay", "main.cjs");
  const electronPath = path.join(packageRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.dirname(overlayMain), { recursive: true });
  fs.mkdirSync(path.dirname(electronPath), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "relay-companion", version: "9.8.7" })}\n`);
  fs.writeFileSync(bin, "#!/usr/bin/env node\n");
  fs.writeFileSync(overlayMain, "// overlay\n");
  fs.writeFileSync(electronPath, "");
  fs.chmodSync(electronPath, 0o755);
  const electronModuleDir = path.join(packageRoot, "node_modules", "electron");
  fs.writeFileSync(path.join(electronModuleDir, "package.json"), `${JSON.stringify({ main: "index.js" })}\n`);
  fs.writeFileSync(
    path.join(electronModuleDir, "index.js"),
    "const path = require('node:path'); module.exports = path.join(__dirname, 'dist/Electron.app/Contents/MacOS/Electron');\n",
  );
  fs.writeFileSync(path.join(packageRoot, "overlay", "relayAppIcon.svg"), '<svg width="1024" height="1024"></svg>\n');
  fs.writeFileSync(path.join(packageRoot, "overlay", "relayTrayTemplate@2x.png"), "fallback");
  return { root, homeDir, packageRoot, bin, overlayMain, electronPath };
}

function fakeMacCommands(calls) {
  return (command, args) => {
    calls.push({ command, args });
    if (command === "/usr/bin/osacompile") {
      const output = args[args.indexOf("-o") + 1];
      const executable = path.join(output, "Contents", "MacOS", "applet");
      const script = path.join(output, "Contents", "Resources", "Scripts", "main.scpt");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(executable, "fake native applet\n", { mode: 0o755 });
      fs.writeFileSync(script, "fake compiled script\n");
    }
    if (command === "/usr/bin/sips") {
      const output = args[args.indexOf("--out") + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "png");
    }
    if (command === "/usr/bin/iconutil") {
      const output = args[args.indexOf("-o") + 1];
      fs.writeFileSync(output, "icns");
    }
    return { ok: true, out: "" };
  };
}

test("stableNodePath keeps an already-stable public path", () => {
  const out = stableNodePath("/opt/homebrew/bin/node", {
    realpath: (p) => p,
    existsSync: () => true,
  });
  assert.equal(out, "/opt/homebrew/bin/node");
});

test("stableNodePath rewrites a Homebrew Cellar path to the public symlink resolving to it", () => {
  const cellar = "/opt/homebrew/Cellar/node/26.0.0/bin/node";
  const out = stableNodePath(cellar, {
    // both the Cellar path and the public symlink resolve to the same real binary
    realpath: (p) => (p === "/opt/homebrew/bin/node" || p === cellar ? cellar : p),
    existsSync: (p) => p === "/opt/homebrew/bin/node" || p === cellar,
  });
  assert.equal(out, "/opt/homebrew/bin/node", "should bake in the upgrade-surviving symlink");
});

test("stableNodePath rewrites a compatible nvm path when a compatible public node exists", () => {
  const nvm = "/Users/x/.nvm/versions/node/v24.18.0/bin/node";
  const out = stableNodePath(nvm, {
    realpath: (p) => p, // no exact-match symlink
    existsSync: (p) => p === "/usr/local/bin/node",
    runCommand: () => ({ status: 0, stdout: "24.18.0\n" }),
  });
  assert.equal(out, "/usr/local/bin/node", "a compatible public node beats a version-managed path");
});

test("stableNodePath treats a Hermes-managed Node as volatile and prefers a public Node", () => {
  const hermes = "/Users/x/.hermes/node/bin/node";
  const out = stableNodePath(hermes, {
    realpath: (p) => p,
    existsSync: (p) => p === "/opt/homebrew/bin/node",
    runCommand: () => ({ status: 0, stdout: "22.12.0\n" }),
  });
  assert.equal(out, "/opt/homebrew/bin/node");
});

test("stableNodePath never replaces a compatible runtime with an old public Node", () => {
  const managed = "/Users/x/.nvm/versions/node/v24.18.0/bin/node";
  const out = stableNodePath(managed, {
    realpath: (p) => p,
    existsSync: (p) => p === "/usr/local/bin/node",
    runCommand: () => ({ status: 0, stdout: "20.19.0\n" }),
  });
  assert.equal(out, managed);
});

test("stableNodePath falls back to Hermes Node only when no durable candidate exists", () => {
  const hermes = "/Users/x/.hermes/node/bin/node";
  const out = stableNodePath(hermes, { realpath: (p) => p, existsSync: () => false });
  assert.equal(out, hermes);
});

test("stableNodePath falls back to execPath when no public node exists", () => {
  const nvm = "/Users/x/.nvm/versions/node/v20.11.0/bin/node";
  const out = stableNodePath(nvm, { realpath: (p) => p, existsSync: () => false });
  assert.equal(out, nvm);
});

test("ensureElectronRuntime runs electron install.js when npm skipped the runtime download", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "relay-companion" })}\n`);
  const electronDir = path.join(dir, "node_modules", "electron");
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, "package.json"), `${JSON.stringify({ main: "index.js" })}\n`);
  fs.writeFileSync(
    path.join(electronDir, "index.js"),
    "const path = require('node:path'); module.exports = path.join(__dirname, 'dist/Electron.app/Contents/MacOS/Electron');\n",
  );
  const installScript = path.join(electronDir, "install.js");
  fs.writeFileSync(installScript, "// fake electron installer\n");

  const calls = [];
  const res = ensureElectronRuntime(dir, {
    runCommand(command, args) {
      calls.push({ command, args });
      const runtime = path.join(electronDir, "dist", "Electron.app", "Contents", "MacOS", "Electron");
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      fs.writeFileSync(runtime, "");
      return { ok: true, out: "" };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [fs.realpathSync(installScript)]);
});

test("ensureElectronRuntime repairs Electron when npm hoists it beside Relay", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-hoisted-test-"));
  const modules = path.join(prefix, "node_modules");
  const packageRoot = path.join(modules, "relay-companion");
  const electronDir = path.join(modules, "electron");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "relay-companion" })}\n`);
  fs.writeFileSync(path.join(electronDir, "package.json"), `${JSON.stringify({ name: "electron", main: "index.js" })}\n`);
  fs.writeFileSync(
    path.join(electronDir, "index.js"),
    "const fs = require('node:fs'); const path = require('node:path'); const p = path.join(__dirname, 'dist/Electron.app/Contents/MacOS/Electron'); if (!fs.existsSync(p)) throw new Error('not installed'); module.exports = p;\n",
  );
  const installScript = path.join(electronDir, "install.js");
  fs.writeFileSync(installScript, "// fake hoisted electron installer\n");

  const calls = [];
  const res = ensureElectronRuntime(packageRoot, {
    runCommand(command, args) {
      calls.push({ command, args });
      const runtime = path.join(electronDir, "dist", "Electron.app", "Contents", "MacOS", "Electron");
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      fs.writeFileSync(runtime, "");
      return { ok: true, out: "" };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.deepEqual(calls[0].args, [fs.realpathSync(installScript)]);
});

test("installRelayMacApp creates a valid Spotlight-searchable Relay.app with a real icon and reopen launcher", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const result = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand: fakeMacCommands(calls),
  });

  assert.equal(result.ok, true);
  assert.equal(result.appPath, path.join(fixture.homeDir, "Applications", "Relay.app"));
  const infoPath = path.join(result.appPath, "Contents", "Info.plist");
  const launcherPath = path.join(result.appPath, "Contents", "Resources", "relay-launcher.sh");
  const appletPath = path.join(result.appPath, "Contents", "MacOS", "applet");
  const info = fs.readFileSync(infoPath, "utf8");
  const launcher = fs.readFileSync(launcherPath, "utf8");
  assert.match(info, /<key>CFBundleIdentifier<\/key><string>work\.relay\.companion\.launcher<\/string>/);
  assert.match(info, /<key>CFBundleExecutable<\/key><string>applet<\/string>/);
  assert.match(info, /<key>CFBundlePackageType<\/key><string>APPL<\/string>/);
  assert.match(info, /<key>CFBundleIconFile<\/key><string>RelayIcon\.icns<\/string>/);
  assert.match(info, /<key>CFBundleShortVersionString<\/key><string>9\.8\.7<\/string>/);
  assert.equal(fs.existsSync(path.join(result.appPath, "Contents", "Resources", "RelayIcon.icns")), true);
  assert.equal(fs.statSync(appletPath).mode & 0o111, 0o111);
  assert.equal(fs.statSync(launcherPath).mode & 0o111, 0o111);
  assert.match(launcher, /launchctl bootstrap "\$domain" "\$plist"/);
  assert.match(launcher, /launchctl kickstart "\$service"/);
  assert.match(launcher, /plutil -extract pid raw/);
  assert.match(launcher, /plutil -extract ready raw/);
  assert.match(launcher, /kill -0 "\$owner_pid"/);
  assert.doesNotMatch(launcher, /grep -q "state = running"/);
  assert.match(launcher, /--relay-reopen "\$nonce"/);
  assert.match(launcher, new RegExp(fixture.electronPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // plutil is a macOS system binary; Linux CI still exercises the complete
  // fixture through fakeMacCommands but cannot invoke this host-only linter.
  if (fs.existsSync("/usr/bin/plutil")) {
    const plistLint = spawnSync("/usr/bin/plutil", ["-lint", infoPath], { encoding: "utf8" });
    assert.equal(plistLint.status, 0, plistLint.stderr || plistLint.stdout);
  }
  const shellLint = spawnSync("/bin/sh", ["-n", launcherPath], { encoding: "utf8" });
  assert.equal(shellLint.status, 0, shellLint.stderr);
  const compileCall = calls.find((call) => call.command === "/usr/bin/osacompile");
  assert.equal(path.basename(compileCall.args.at(-1)), "Relay.app");
  assert.match(path.basename(path.dirname(compileCall.args.at(-1))), /^\.relay-app-staging-/);
  assert.ok(calls.some((call) => call.command === "/usr/bin/codesign" && call.args[0] === "--force"));
  assert.ok(calls.some((call) => call.command === "/usr/bin/codesign" && call.args[0] === "--verify"));
  assert.ok(calls.some((call) => call.command.endsWith("/lsregister") && call.args[0] === "-f"));
  assert.ok(calls.some((call) => call.command === "/usr/bin/mdimport" && call.args[0] === result.appPath));
});

test("installRelayMacApp fails closed instead of creating a shell-executable app when osacompile fails", () => {
  const fixture = relayDesktopFixture();
  const result = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand(command) {
      if (command === "/usr/bin/osacompile") return { ok: false, out: "compile failed" };
      return { ok: true, out: "" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "relay_app_install_failed");
  assert.match(result.detail, /could not compile native Relay app launcher: compile failed/);
  assert.equal(fs.existsSync(path.join(fixture.homeDir, "Applications", "Relay.app")), false);
});

test("installRelayMacApp fails closed when the finished native bundle cannot be signed", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const fake = fakeMacCommands(calls);
  const existing = path.join(fixture.homeDir, "Applications", "Relay.app");
  fs.mkdirSync(path.join(existing, "Contents"), { recursive: true });
  fs.writeFileSync(
    path.join(existing, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>work.relay.companion.launcher</string></dict></plist>\n",
  );
  fs.writeFileSync(path.join(existing, "sentinel"), "keep existing app");
  const result = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand(command, args) {
      const result = fake(command, args);
      if (command === "/usr/bin/codesign" && args[0] === "--force") {
        return { ok: false, out: "signing failed" };
      }
      return result;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "relay_app_install_failed");
  assert.match(result.detail, /could not sign native Relay app launcher: signing failed/);
  assert.equal(fs.readFileSync(path.join(existing, "sentinel"), "utf8"), "keep existing app");
});

test("installRelayMacApp preserves an unrelated app that appears while the native bundle is compiling", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const fake = fakeMacCommands(calls);
  const target = path.join(fixture.homeDir, "Applications", "Relay.app");
  const result = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand(command, args) {
      const result = fake(command, args);
      if (command === "/usr/bin/codesign" && args[0] === "--verify") {
        fs.mkdirSync(path.join(target, "Contents"), { recursive: true });
        fs.writeFileSync(
          path.join(target, "Contents", "Info.plist"),
          "<plist><dict><key>CFBundleIdentifier</key><string>com.example.arrived-late</string></dict></plist>\n",
        );
        fs.writeFileSync(path.join(target, "sentinel"), "keep me");
      }
      return result;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "relay_app_install_failed");
  assert.match(result.detail, /Relay app target changed during installation/);
  assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "keep me");
  assert.equal(
    fs.readdirSync(path.join(fixture.homeDir, "Applications")).some((name) => name.startsWith(".relay-app-staging-")),
    false,
  );
});

test("installRelayMacApp never deletes an unrelated app with the same name", () => {
  const fixture = relayDesktopFixture();
  const unrelated = path.join(fixture.homeDir, "Applications", "Relay.app");
  fs.mkdirSync(path.join(unrelated, "Contents"), { recursive: true });
  fs.writeFileSync(
    path.join(unrelated, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other-relay</string></dict></plist>\n",
  );
  fs.writeFileSync(path.join(unrelated, "sentinel"), "keep me");

  const result = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand: fakeMacCommands([]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.appPath, path.join(fixture.homeDir, "Applications", "Relay Companion.app"));
  assert.equal(fs.readFileSync(path.join(unrelated, "sentinel"), "utf8"), "keep me");

  // If the name conflict later disappears, repairs must update the already-owned
  // fallback instead of creating a duplicate Relay.app Spotlight result.
  fs.rmSync(unrelated, { recursive: true, force: true });
  const repaired = installRelayMacApp({
    bin: fixture.bin,
    electronPath: fixture.electronPath,
    overlayMain: fixture.overlayMain,
    homeDir: fixture.homeDir,
    runCommand: fakeMacCommands([]),
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.appPath, result.appPath);
  assert.equal(fs.existsSync(path.join(fixture.homeDir, "Applications", "Relay.app")), false);
});

test("repairDesktopSurfaces --no-restart rewrites both LaunchAgents and Relay.app without launchctl or MCP work", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const result = repairDesktopSurfaces({
    bin: fixture.bin,
    node: "/opt/homebrew/bin/node",
    platform: "darwin",
    homeDir: fixture.homeDir,
    reload: false,
    snapshotTrayPosition: () => ({ ok: true, snapshotted: false, reason: "fixture" }),
    runCommand: fakeMacCommands(calls),
  });

  assert.equal(result.ok, true);
  assert.equal(result.daemon.started, false);
  assert.equal(result.pill.started, false);
  assert.equal(fs.existsSync(result.pill.appPath), true);
  assert.equal(calls.some((call) => call.command === "launchctl"), false);
  const daemonPlist = fs.readFileSync(result.daemon.plistPath, "utf8");
  const pillPlist = fs.readFileSync(result.pill.plistPath, "utf8");
  assert.match(daemonPlist, new RegExp(fixture.bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(pillPlist, new RegExp(fixture.electronPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(daemonPlist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(pillPlist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/);
  assert.doesNotMatch(pillPlist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(daemonPlist, /--full|--messages-only/);
  assert.doesNotMatch(pillPlist, /--full|--messages-only/);
});

test("candidate repair snapshots tray position before touching registrations", () => {
  const fixture = relayDesktopFixture();
  const events = [];
  const result = repairDesktopSurfaces({
    bin: fixture.bin,
    node: "/opt/homebrew/bin/node",
    platform: "darwin",
    homeDir: fixture.homeDir,
    reload: false,
    snapshotTrayPosition() {
      events.push("snapshot");
      return { ok: true, snapshotted: true, value: 347 };
    },
    runCommand(command, args, options) {
      events.push(`command:${command}`);
      return fakeMacCommands([])(command, args, options);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(events[0], "snapshot");
  assert.equal(result.positionSnapshot.value, 347);
});

test("repair-runtime snapshots before agent registrations so an old updater gets the ingress handoff", () => {
  const cli = fs.readFileSync(new URL("../bin/relay.js", import.meta.url), "utf8");
  const commandStart = cli.indexOf("function cmdRepairRuntime");
  const snapshot = cli.indexOf("snapshotDesktopTrayPosition()", commandStart);
  const registrations = cli.indexOf("repairExistingAgentRegistrations(target)", commandStart);
  const desktop = cli.indexOf("repairDesktopSurfaces({", commandStart);
  assert.ok(commandStart >= 0 && snapshot > commandStart);
  assert.ok(snapshot < registrations, "durable snapshot precedes any candidate registration mutation");
  assert.ok(registrations < desktop);
});

test("candidate repair fails before registration when a live position cannot be cached", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const result = repairDesktopSurfaces({
    bin: fixture.bin,
    node: "/opt/homebrew/bin/node",
    platform: "darwin",
    homeDir: fixture.homeDir,
    reload: false,
    snapshotTrayPosition: () => ({
      ok: false,
      snapshotted: false,
      reason: "cache-write-failed",
      detail: "disk full",
    }),
    runCommand(command, args) { calls.push([command, ...args]); return { ok: true, out: "" }; },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "tray-position-snapshot-failed",
    positionSnapshot: {
      ok: false,
      snapshotted: false,
      reason: "cache-write-failed",
      detail: "disk full",
    },
  });
  assert.deepEqual(calls, []);
});

test("desktop repair removes capability modes from daemon, pill, and Relay.app", () => {
  const fixture = relayDesktopFixture();
  const calls = [];
  const result = repairDesktopSurfaces({
    bin: fixture.bin,
    node: "/opt/homebrew/bin/node",
    platform: "darwin",
    homeDir: fixture.homeDir,
    reload: false,
    snapshotTrayPosition: () => ({ ok: true, snapshotted: false, reason: "fixture" }),
    runCommand: fakeMacCommands(calls),
  });

  assert.equal(result.ok, true);
  const daemonPlist = fs.readFileSync(result.daemon.plistPath, "utf8");
  const pillPlist = fs.readFileSync(result.pill.plistPath, "utf8");
  const launcher = fs.readFileSync(
    path.join(result.pill.appPath, "Contents", "Resources", "relay-launcher.sh"),
    "utf8",
  );
  assert.doesNotMatch(daemonPlist, /--full|--messages-only/);
  assert.doesNotMatch(pillPlist, /--full|--messages-only/);
  assert.doesNotMatch(launcher, /--full|--messages-only/);
});

test("writeClaudeCodeMcpConfig registers Relay directly in ~/.claude.json shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  const configPath = path.join(dir, ".claude.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ projects: {}, mcpServers: { other: { command: "x" } } }, null, 2)}\n`);

  const res = writeClaudeCodeMcpConfig("C:\\Relay\\relay.js", "C:\\Node\\node.exe", configPath);
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(res.ok, true);
  assert.deepEqual(cfg.mcpServers.other, { command: "x" });
  assert.deepEqual(cfg.mcpServers.relay, {
    type: "stdio",
    command: "C:\\Node\\node.exe",
    args: ["--max-old-space-size=96", "C:\\Relay\\relay.js", "mcp"],
    env: {},
    alwaysLoad: true,
  });
});

test("writeCodexMcpConfig replaces only the Relay MCP table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-test"',
      "",
      "[mcp_servers.relay]",
      'command = "old"',
      'args = ["old"]',
      "",
      "[mcp_servers.node_repl]",
      'command = "/node_repl"',
      "",
    ].join("\n"),
  );

  const res = writeCodexMcpConfig("/relay/bin/relay.js", "/usr/local/bin/node", configPath);
  const text = fs.readFileSync(configPath, "utf8");

  assert.equal(res.ok, true);
  assert.match(text, /model = "gpt-test"/);
  assert.match(text, /\[features\.code_mode\]\ndirect_only_tool_namespaces = \["mcp__relay"\]/);
  assert.match(text, /\[mcp_servers\.node_repl\]/);
  assert.match(text, /\[mcp_servers\.relay\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["--max-old-space-size=96", "\/relay\/bin\/relay\.js", "mcp"\]/);
  assert.doesNotMatch(text, /command = "old"/);
});

test("writeCodexMcpConfig merges Relay into an existing multiline direct namespace list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[features.code_mode]",
      "enabled = false",
      "direct_only_tool_namespaces = [",
      '  "mcp__history",',
      '  "mcp__notes",',
      "] # keep direct tools",
      'excluded_tool_namespaces = ["mcp__private"]',
      "",
    ].join("\n"),
  );

  assert.equal(writeCodexMcpConfig("/relay/bin/relay.js", "/usr/local/bin/node", configPath).ok, true);
  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /enabled = false/);
  assert.match(text, /direct_only_tool_namespaces =\s+\["mcp__history", "mcp__notes", "mcp__relay"\] # keep direct tools/);
  assert.match(text, /excluded_tool_namespaces = \["mcp__private"\]/);

  assert.equal(writeCodexMcpConfig("/relay/bin/relay.js", "/usr/local/bin/node", configPath).ok, true);
  assert.equal((fs.readFileSync(configPath, "utf8").match(/mcp__relay/g) || []).length, 1);
});

test("updateTomlStringArray preserves existing values and removes only Relay's value", () => {
  const original = [
    "[features.code_mode]",
    'direct_only_tool_namespaces = ["mcp__history", "mcp__relay", "mcp__notes"]',
    "disable_in_process_fallback = true",
    "",
  ].join("\n");
  const next = updateTomlStringArray(
    original,
    "features.code_mode",
    "direct_only_tool_namespaces",
    "mcp__relay",
    { remove: true },
  );
  assert.match(next, /direct_only_tool_namespaces =\s+\["mcp__history", "mcp__notes"\]/);
  assert.match(next, /disable_in_process_fallback = true/);
});

test("replaceTomlTable appends Relay table when Codex config has no existing Relay MCP", () => {
  const next = replaceTomlTable('model = "gpt-test"\n', "mcp_servers.relay", '[mcp_servers.relay]\ncommand = "node"\n');
  assert.match(next, /model = "gpt-test"\n\n\[mcp_servers\.relay\]\ncommand = "node"\n$/);
});

test("removeCodexMcpConfig clears the direct Relay table and leaves other tables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-test-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[mcp_servers.relay]",
      'command = "node"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[features.code_mode]",
      'direct_only_tool_namespaces = ["mcp__history", "mcp__relay"]',
      "",
    ].join("\n"),
  );

  const res = removeCodexMcpConfig(configPath);
  const text = fs.readFileSync(configPath, "utf8");

  assert.equal(res.ok, true);
  assert.doesNotMatch(text, /\[mcp_servers\.relay\]/);
  assert.match(text, /\[mcp_servers\.other\]/);
  assert.match(text, /direct_only_tool_namespaces =\s+\["mcp__history"\]/);
  assert.doesNotMatch(text, /mcp__relay/);
});

test("removeTomlTable handles a config containing only Relay", () => {
  assert.equal(removeTomlTable('[mcp_servers.relay]\ncommand = "node"\n', "mcp_servers.relay"), "");
});

test("windowsTaskAction runs through cmd with log redirection", () => {
  const action = windowsTaskAction(
    "C:\\Program Files\\nodejs\\node.exe",
    ["C:\\Users\\Ada Lovelace\\relay.js", "daemon"],
    "C:\\Users\\Ada Lovelace\\.relay\\daemon.log",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.match(action, /^"C:\\Windows\\System32\\cmd\.exe" \/d \/s \/c /);
  assert.match(action, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(action, /"C:\\Users\\Ada Lovelace\\relay\.js" "daemon"/);
  assert.match(action, />> "C:\\Users\\Ada Lovelace\\.relay\\daemon\.log" 2>&1/);
});

test("windowsTaskXml stores long quoted actions as XML data instead of /TR", () => {
  const longPath = `C:\\Users\\Ada Lovelace\\${"very-long-folder\\".repeat(20)}electron.exe`;
  const xml = windowsTaskXml(
    longPath,
    ["C:\\Program Files\\Relay\\overlay\\main.cjs", "--relay-reopen", "test-nonce"],
    "C:\\Users\\Ada Lovelace\\.relay\\pill.log",
    "C:\\Windows\\System32\\cmd.exe",
    "DESKTOP\\Ada",
  );

  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>DESKTOP\\Ada<\/UserId>/);
  assert.match(xml, /<Command>C:\\Windows\\System32\\cmd\.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/d \/s \/c &quot;&quot;C:\\Users\\Ada Lovelace/);
  assert.match(xml, /&gt;&gt; &quot;C:\\Users\\Ada Lovelace\\\.relay\\pill\.log&quot; 2&gt;&amp;1/);
  assert.ok(xml.length > 261, "the XML path is not constrained by schtasks /TR's 261-character ceiling");
});

test("windowsTaskXml points the task at the windowless wscript shim", () => {
  const xml = windowsTaskXml(
    "C:\\Relay\\electron.exe",
    ["C:\\Relay\\overlay\\main.cjs", "--relay-reopen", "test-nonce"],
    "C:\\Users\\Ada Lovelace\\.relay\\pill.log",
    "C:\\Windows\\System32\\cmd.exe",
    "DESKTOP\\Ada",
    { wscript: "C:\\Windows\\System32\\wscript.exe", vbsPath: "C:\\Users\\Ada Lovelace\\.relay\\relay-companion-pill.vbs" },
  );

  // A console Command here is exactly what Task Scheduler gives a visible window to.
  assert.match(xml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(
    xml,
    /<Arguments>\/\/B \/\/Nologo &quot;C:\\Users\\Ada Lovelace\\\.relay\\relay-companion-pill\.vbs&quot;<\/Arguments>/,
  );
  // The command belongs in the script, never in the arguments Windows re-parses.
  assert.ok(!xml.includes("electron.exe"), "the action carries a script path, not the command line");
});

test("windowsTaskXml falls back to the plain console action without a shim", () => {
  const xml = windowsTaskXml("C:\\Node\\node.exe", ["C:\\Relay\\relay.js", "daemon"], null, "C:\\Windows\\System32\\cmd.exe", "", null);

  assert.match(xml, /<Command>C:\\Windows\\System32\\cmd\.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/d \/s \/c &quot;&quot;C:\\Node\\node\.exe&quot;/);
  assert.ok(!xml.includes("wscript"), "no shim means no wscript reference");
});

test("ensureWindowsHiddenLauncher declines when Windows Script Host is disabled by policy", () => {
  const result = ensureWindowsHiddenLauncher({
    homeDir: "C:\\Users\\Ada",
    exists: () => true,
    runCommand: () => ({ ok: true, out: "    Enabled    REG_DWORD    0x0" }),
    writeFile: () => assert.fail("must not write the shim when WSH is off"),
  });

  assert.equal(result, null, "a disabled script host has to leave the task on the working console action");
});

test("ensureWindowsHiddenLauncher bakes the command into a per-task UTF-16 shim", () => {
  const written = [];
  const result = ensureWindowsHiddenLauncher({
    homeDir: "C:\\Users\\José",
    taskName: "Relay Companion Daemon",
    commandLine: '"C:\\Windows\\cmd.exe" /d /s /c ""C:\\Users\\José\\node.exe" "daemon" >> "C:\\log" 2>&1"',
    systemRoot: "C:\\Windows",
    exists: () => true,
    runCommand: () => ({ ok: false, out: "" }), // no policy key present
    makeDir: () => {},
    writeFile: (file, body, encoding) => written.push({ file, body, encoding }),
  });

  assert.equal(result.wscript, "C:\\Windows\\System32\\wscript.exe");
  assert.match(result.vbsPath, /relay-companion-daemon\.vbs$/);
  assert.equal(written.length, 1);
  // A BOM-less .vbs is read as the ANSI codepage, which would mangle "José".
  assert.equal(written[0].encoding, "utf16le");
  assert.ok(written[0].body.startsWith("\ufeff"), "the script host needs the BOM to read this as UTF-16");
  // `0` is the window style that makes this whole fix work.
  assert.match(written[0].body, /shell\.Run ".*", 0, False/);
  // VBScript escapes a quote by doubling it, and every quote in the command is quoted.
  assert.match(written[0].body, /shell\.Run """C:\\Windows\\cmd\.exe"" \/d \/s \/c """"C:\\Users\\José\\node\.exe"" ""daemon"" >> ""C:\\log"" 2>&1""", 0, False/);
});

test("each Windows service gets its own shim so the two tasks cannot overwrite each other", () => {
  assert.notEqual(
    windowsHiddenLauncherPath("C:\\Users\\Ada", "Relay Companion Daemon"),
    windowsHiddenLauncherPath("C:\\Users\\Ada", "Relay Companion Pill"),
  );
  assert.match(windowsHiddenLauncherPath("C:\\Users\\Ada", "Relay Companion Pill"), /relay-companion-pill\.vbs$/);
});

test("installDaemonAutostart creates and starts a Windows logon Scheduled Task", () => {
  const calls = [];
  const res = installDaemonAutostart("C:\\Relay\\relay.js", "C:\\Node\\node.exe", {
    platform: "win32",
    ensureLauncher: () => null,
    runCommand(command, args) {
      calls.push({ command, args });
      return { ok: true, out: "" };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.taskName, "Relay Companion Daemon");
  assert.deepEqual(calls.map((call) => [call.command, call.args[0], call.args[1]]), [
    ["schtasks", "/End", "/TN"],
    ["schtasks", "/Create", "/TN"],
    ["schtasks", "/Run", "/TN"],
  ]);
  assert.ok(calls[1].args.includes("/XML"));
  assert.doesNotMatch(calls[1].args.join(" "), /\/TR|ONLOGON/);
});

test("installDaemonAutostart --no-restart updates a Windows task without ending or running it", () => {
  const calls = [];
  const res = installDaemonAutostart("C:\\Relay\\relay.js", "C:\\Node\\node.exe", {
    platform: "win32",
    reload: false,
    ensureLauncher: () => null,
    runCommand(command, args) {
      calls.push({ command, args });
      return { ok: true, out: "" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.started, false);
  assert.deepEqual(calls.map((call) => call.args[0]), ["/Create"]);
});

// ---- Claude presence detection (Open-in-current-chat hook runtime) ----------
//
// runSetupInstall itself shells out to the `claude` CLI, so what is unit-testable
// is the gate it now uses: claudeAppearsPresent() must be true for a Claude
// install that has ~/.claude but no CLI on PATH, and installClaudeHooks must then
// write a usable hook there.

function withClaudeHome(homeDir, fn) {
  const priorHome = process.env.CLAUDE_HOME;
  const priorSettings = process.env.CLAUDE_SETTINGS;
  delete process.env.CLAUDE_SETTINGS; // CLAUDE_SETTINGS wins over CLAUDE_HOME
  process.env.CLAUDE_HOME = homeDir;
  try {
    return fn();
  } finally {
    if (priorHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = priorHome;
    if (priorSettings === undefined) delete process.env.CLAUDE_SETTINGS;
    else process.env.CLAUDE_SETTINGS = priorSettings;
  }
}

test("claudeAppearsPresent tracks the settings directory, not the claude CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-present-"));
  const claudeHome = path.join(dir, ".claude");

  withClaudeHome(claudeHome, () => {
    assert.equal(claudeSettingsPath(), path.join(claudeHome, "settings.json"));
    assert.equal(claudeAppearsPresent(), false, "no ~/.claude yet -> not present");
    fs.mkdirSync(claudeHome, { recursive: true });
    // Directory alone is enough: a Windows install registered by hand has
    // ~/.claude with no settings.json and no `claude` on PATH.
    assert.equal(claudeAppearsPresent(), true);
  });
});

test("claudeAppearsPresent honors an explicit CLAUDE_SETTINGS override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-present-"));
  const nested = path.join(dir, "custom");
  const prior = process.env.CLAUDE_SETTINGS;
  process.env.CLAUDE_SETTINGS = path.join(nested, "settings.json");
  try {
    assert.equal(claudeAppearsPresent(), false);
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(claudeAppearsPresent(), true);
    // Callers may also pass the path directly (runSetupInstall does not).
    assert.equal(claudeAppearsPresent({ settingsPath: path.join(dir, "gone", "settings.json") }), false);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_SETTINGS;
    else process.env.CLAUDE_SETTINGS = prior;
  }
});

test("a CLI-less Claude install still gets a working Open-in-current-chat hook", () => {
  // The Windows failure mode: installClaudeCode returns claude_code_not_found, so
  // the old `if (claude.ok)` gate skipped installClaudeHooks and the pill action
  // died silently. Same gate expression as runSetupInstall, with the CLI absent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-present-"));
  const claudeHome = path.join(dir, ".claude");
  fs.mkdirSync(claudeHome, { recursive: true });

  const res = withClaudeHome(claudeHome, () => {
    const claude = { ok: false, reason: "claude_code_not_found" };
    return claude.ok || claudeAppearsPresent()
      ? installClaudeHooks("C:\\Relay\\relay.js", "C:\\Node\\node.exe")
      : null;
  });

  assert.ok(res, "hook install must be attempted without the claude CLI");
  assert.equal(res.ok, true);
  assert.equal(res.settingsPath, path.join(claudeHome, "settings.json"));
  assert.ok(isRelayClaudeHookCommand({ command: res.command, args: res.args }));
  const settings = JSON.parse(fs.readFileSync(res.settingsPath, "utf8"));
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...res.events].sort());
});

test("no Claude on the machine still means no hook install", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-present-"));

  const res = withClaudeHome(path.join(dir, ".claude"), () => {
    const claude = { ok: false, reason: "claude_code_not_found" };
    return claude.ok || claudeAppearsPresent() ? installClaudeHooks() : null;
  });

  assert.equal(res, null, "claudeHooks stays null when Claude is genuinely absent");
});

test("the pill's launchd job is Interactive so macOS never throttles a window the user clicks", async () => {
  const { buildPillPlist } = await import("../src/install.js").catch(() => ({}));
  // The plist text is produced inside installLaunchAgents; assert on the shipped
  // source so the guarantee cannot be silently dropped in a refactor.
  const src = fs.readFileSync(new URL("../src/install.js", import.meta.url), "utf8");
  const pillSection = src.slice(src.indexOf("pillArgs.map"));
  assert.match(pillSection, /<key>ProcessType<\/key><string>Interactive<\/string>/,
    "pill plist must declare ProcessType Interactive");
  assert.match(pillSection, /<key>LowPriorityIO<\/key><false\/>/,
    "pill plist must opt out of low-priority IO");
  // The daemon is background polling and must NOT claim Interactive.
  const daemonSection = src.slice(src.indexOf("daemonArgs.map"), src.indexOf("pillArgs.map"));
  assert.doesNotMatch(daemonSection, /ProcessType/, "daemon stays ordinary background work");
});
