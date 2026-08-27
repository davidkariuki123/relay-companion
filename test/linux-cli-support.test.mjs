import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const cli = read("../bin/relay.js");

test("direct install propagates a failed Linux lifecycle", () => {
  const install = between(cli, "async function cmdInstall", "function cmdRepairDesktop");
  assert.match(install, /const install = await applyInstall\(/);
  assert.match(install, /if \(install\?\.lifecycleFailed\) process\.exitCode = 1/);
});

test("setup uses explicit Claude and Codex CLI paths for registration and activation", () => {
  const install = read("../src/install.js");
  const setup = between(install, "export async function runSetupInstall", "export function repairExistingAgentRegistrations");
  assert.match(setup, /configuredClaudeCommand = process\.env\.CLAUDE_CLI_PATH/);
  assert.match(setup, /configuredCodexCommand = process\.env\.CODEX_CLI_PATH/);
  assert.match(setup, /claudeCommand = configuredClaudeCommand[\s\S]*path\.resolve\(configuredClaudeCommand\)/);
  assert.match(setup, /codexCommand = configuredCodexCommand[\s\S]*path\.resolve\(configuredCodexCommand\)/);
  assert.match(setup, /installDaemonAutostart\(bin, node, \{ claim, reload, env: serviceEnv \}\)/);
  assert.match(setup, /installClaudeCode\(mcpBin, node, \{ command: claudeCommand \}\)/);
  assert.match(setup, /installCodex\(mcpBin, node, \{ command: codexCommand \}\)/);
  assert.match(setup, /activateCodexMcp\(\{ command: codexCommand \}\)/);
});

test("Linux doctor reports both systemd units and the logs that receive service output", () => {
  const doctor = between(cli, "async function cmdDoctor", "function cmdEnv");
  assert.match(doctor, /process\.platform === "linux"/);
  assert.match(doctor, /work\.relay\.companion\.service/);
  assert.match(doctor, /work\.relay\.companion\.pill\.service/);
  assert.match(doctor, /"systemctl",\s*\["--user", "show"/);
  assert.match(doctor, /MainPID,FragmentPath/);
  assert.match(doctor, /WRONG UNIT FILE/);
  assert.match(doctor, /readAutostartDaemonRoot\(\{ platform: "linux" \}\)/);
  assert.match(doctor, /"xdg-mime", \["query", "default", "x-scheme-handler\/relay"\]/);
  assert.match(doctor, /prepareLinuxElectronSandbox\(\{/);
  assert.match(doctor, /path\.join\(relayLogDir, "daemon\.log"\)/);
  assert.match(doctor, /path\.join\(relayLogDir, "pill\.log"\)/);
});

test("Linux requeue restart uses the shared service restart and never prints launchctl guidance", () => {
  const doctor = between(cli, "async function cmdDoctor", "function cmdEnv");
  const linuxRestart = between(
    doctor,
    '} else if (flags["restart-pill"] && process.platform === "linux")',
    '} else if (process.platform === "linux")',
  );
  assert.match(linuxRestart, /restartRelayServices\(\{ services: \["pill"\] \}\)/);
  assert.doesNotMatch(linuxRestart, /launchctl/);
  assert.match(doctor, /systemctl --user restart work\.relay\.companion\.pill\.service/);
});

test("Linux README names live logs, XWayland, and the secure Ubuntu sandbox approval", () => {
  const readme = read("../README.md");
  assert.match(readme, /~\/\.relay\/daemon\.log/);
  assert.match(readme, /~\/\.relay\/pill\.log/);
  assert.match(readme, /Wayland[\s\S]*XWayland/);
  assert.match(readme, /Ubuntu 24\.04[\s\S]*administrator approval[\s\S]*content-addressed Chromium sandbox helper/);
  assert.match(readme, /never disables Electron's sandbox/);
  assert.match(readme, /~\/\.local\/bin\/relay/);
});

test("Linux rollout kill switch survives API, IPC, and renderer boundaries", () => {
  const main = read("../overlay/main.cjs");
  const inbox = read("../overlay/inbox.html");
  assert.match(main, /INSTALLATION_AUTH_IPC_ERROR_CODES[\s\S]*"linux_desktop_disabled"/);
  assert.match(inbox, /detail\.includes\("linux_desktop_disabled"\)[\s\S]*New Linux desktop connections are temporarily paused/);
});
