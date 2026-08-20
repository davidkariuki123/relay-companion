"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

// A local checkout may run beside Relay without invalidating the installed
// runtime. Only installed relay-companion trees count as production services.
const SERVICE_TREE_RE = /node_modules[\\/]relay-companion[\\/]/i;

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...options });
}

function runtimeProcessCommands(platform, run = defaultRun) {
  if (platform === "win32") {
    const script = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $_.CommandLine }";
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return commandOk(result) ? String(result.stdout || "").split(/\r?\n/) : [];
  }
  const result = run("/bin/ps", ["-axo", "command="]);
  return commandOk(result) ? String(result.stdout || "").split(/\r?\n/) : [];
}

function exactRuntimeHealth(target, {
  platform = process.platform,
  run = defaultRun,
  commands = null,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const lines = commands || runtimeProcessCommands(platform, run);
  const normalize = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value)).replaceAll("\\", "/");
  const daemonNeedle = normalize(target.bin);
  const pillNeedle = normalize(api.join(target.packageRoot, "overlay", "main.cjs"));
  const relayDaemons = lines.filter((line) => SERVICE_TREE_RE.test(line) && /(?:^|[\\/])relay\.js(?:"|'|\s).*\bdaemon\b/i.test(line));
  const relayPills = lines.filter((line) => SERVICE_TREE_RE.test(line) && /(?:^|[\\/])overlay[\\/]main\.cjs(?:"|'|\s|$)/i.test(line));
  const daemon = relayDaemons.some((line) => normalize(line).includes(daemonNeedle));
  const pill = relayPills.some((line) => normalize(line).includes(pillNeedle));
  const oldDaemon = relayDaemons.some((line) => !normalize(line).includes(daemonNeedle));
  const oldPill = relayPills.some((line) => !normalize(line).includes(pillNeedle));
  return { ok: daemon && pill && !oldDaemon && !oldPill, daemon, pill, oldDaemon, oldPill, packageRoot: target.packageRoot };
}

module.exports = { exactRuntimeHealth, runtimeProcessCommands };
