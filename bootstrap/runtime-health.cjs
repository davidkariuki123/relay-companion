"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { systemdImportEnvironmentArgs } = require("./linux-systemd.cjs");

const DAEMON_LABEL = "work.relay.companion";
const PILL_LABEL = "work.relay.companion.pill";

// A local checkout may run beside Relay without invalidating the installed
// runtime. Only installed relay-companion trees count as production services.
const SERVICE_TREE_RE = /node_modules[\\/]relay-companion[\\/]/i;

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...options });
}

function runtimeProcessCommands(platform, run = defaultRun, userId = typeof process.getuid === "function" ? process.getuid() : 0) {
  if (platform === "win32") {
    const script = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $_.CommandLine }";
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return commandOk(result) ? String(result.stdout || "").split(/\r?\n/) : [];
  }
  const result = run("/bin/ps", ["-axo", "uid=,command="]);
  if (!commandOk(result)) return [];
  const lines = [];
  for (const row of String(result.stdout || "").split(/\r?\n/)) {
    const match = row.match(/^\s*(\d+)\s+(.*)$/);
    if (match && Number(match[1]) === userId) lines.push(match[2]);
  }
  return lines;
}

function exactRuntimeHealth(target, {
  platform = process.platform,
  run = defaultRun,
  commands = null,
  userId = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const lines = commands || runtimeProcessCommands(platform, run, userId);
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

function linuxPillStatusPath({ homeDir = os.homedir(), env = process.env } = {}) {
  const root = env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.posix.join(homeDir, ".relay-companion");
  return path.posix.join(root, "pill-status.json");
}

function exactLinuxPillReady(target, {
  homeDir = os.homedir(),
  env = process.env,
  fsImpl = fs,
} = {}) {
  const statusPath = linuxPillStatusPath({ homeDir, env });
  try {
    const status = JSON.parse(fsImpl.readFileSync(statusPath, "utf8"));
    const packageRoot = path.posix.resolve(String(status?.packageRoot || ""));
    const expected = path.posix.resolve(String(target?.packageRoot || ""));
    return {
      ok: status?.ready === true && Number.isInteger(status?.pid) && status.pid > 0 && packageRoot === expected,
      status,
      statusPath,
    };
  } catch (error) {
    return { ok: false, status: null, statusPath, detail: error?.message || String(error) };
  }
}

function installedServiceProcessRows(target, {
  run = defaultRun,
  includeTarget = false,
  processId = process.pid,
  userId = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
  const result = run("/bin/ps", ["-axo", "uid=,pid=,command="]);
  if (!commandOk(result)) {
    return {
      ok: false,
      rows: [],
      reason: "service-process-query-failed",
      detail: result?.error?.message || String(result?.stderr || result?.stdout || "").trim(),
    };
  }
  const targetNeedle = String(target?.packageRoot || "").replaceAll("\\", "/");
  const rows = [];
  for (const line of String(result.stdout || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const uid = Number(match[1]);
    const pid = Number(match[2]);
    const command = match[3];
    if (!Number.isInteger(uid) || uid !== userId) continue;
    // This is the safety boundary: only an immutable/global production install
    // has node_modules/relay-companion in its command. A checkout's daemon or
    // Electron pill is deliberately invisible and must never be terminated.
    if (!SERVICE_TREE_RE.test(command)) continue;
    const isDaemon = /(?:^|[\\/])relay\.js(?:"|'|\s).*\bdaemon\b/i.test(command);
    const isPill = /(?:^|[\\/])overlay[\\/]main\.cjs(?:"|'|\s|$)/i.test(command);
    if (!isDaemon && !isPill) continue;
    if (!includeTarget && targetNeedle && command.replaceAll("\\", "/").includes(targetNeedle)) continue;
    if (!Number.isInteger(pid) || pid <= 0 || pid === processId) continue;
    rows.push({ pid, command });
  }
  return { ok: true, rows };
}

async function terminateInstalledServiceProcesses(target, {
  run = defaultRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = 2000,
  includeTarget = false,
  processId = process.pid,
  userId = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
  const first = installedServiceProcessRows(target, { run, includeTarget, processId, userId });
  if (!first.ok) return first;
  if (!first.rows.length) return { ok: true, terminated: [] };
  for (const row of first.rows) run("/bin/kill", ["-TERM", String(row.pid)]);
  await sleep(graceMs);
  const afterTerm = installedServiceProcessRows(target, { run, includeTarget, processId, userId });
  if (!afterTerm.ok) return afterTerm;
  const originalPids = new Set(first.rows.map((row) => row.pid));
  const survivors = afterTerm.rows.filter((row) => originalPids.has(row.pid));
  for (const row of survivors) run("/bin/kill", ["-KILL", String(row.pid)]);
  if (survivors.length) await sleep(500);
  const afterKill = installedServiceProcessRows(target, { run, includeTarget, processId, userId });
  if (!afterKill.ok) return afterKill;
  const remaining = afterKill.rows.filter((row) => originalPids.has(row.pid));
  if (remaining.length) {
    return { ok: false, reason: "service-process-stop-failed", detail: remaining.map((row) => row.pid).join(",") };
  }
  return { ok: true, terminated: first.rows.map((row) => row.pid) };
}

/**
 * Restart Relay's two macOS jobs from the registrations already written by the
 * caller, then prove that both processes belong to the requested package root.
 * Registration remains owned by setup/repair; this helper owns only the narrow
 * launchd handoff and never edits a plist, account file, or installed binary.
 */
async function activateMacRuntimeServices(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  domainPollMs = 250,
  bootstrapDelayMs = 500,
  healthPollMs = 500,
  activationDeadlineMs = 90_000,
  now = Date.now,
  processId = process.pid,
  healthCheck = exactRuntimeHealth,
} = {}) {
  if (platform !== "darwin") return { ok: false, reason: "activation-platform-unsupported" };
  if (!target?.packageRoot || !target?.bin) return { ok: false, reason: "activation-target-invalid" };
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
  const agents = path.posix.join(String(homeDir || ""), "Library", "LaunchAgents");
  const labels = [PILL_LABEL, DAEMON_LABEL];
  const deadline = now() + Math.max(1, activationDeadlineMs);
  for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);

  // launchctl bootout is asynchronous. Keep quiescence, bootstrap, and liveness
  // under one deadline so a racing EIO cannot create an unbounded retry loop.
  while (now() <= deadline) {
    const labelsPresent = labels.filter((label) => commandOk(run("/bin/launchctl", ["print", `${domain}/${label}`])));
    if (labelsPresent.length) {
      for (const label of labelsPresent) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
      await sleep(domainPollMs);
      continue;
    }

    const stopped = await terminateInstalledServiceProcesses(target, {
      run,
      sleep,
      includeTarget: true,
      processId,
    });
    if (!stopped.ok) return stopped;

    let bootstrapFailure = null;
    for (const label of labels) {
      const started = run("/bin/launchctl", ["bootstrap", domain, path.posix.join(agents, `${label}.plist`)]);
      if (!commandOk(started)) {
        bootstrapFailure = { label, result: started };
        break;
      }
    }
    if (bootstrapFailure) {
      for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
      const detail = String(bootstrapFailure.result?.stderr || bootstrapFailure.result?.stdout || "");
      if (!/(?:Bootstrap failed:\s*5|Input\/output error|I\/O error)/i.test(detail)) {
        return { ok: false, reason: "service-bootstrap-failed", detail: `${bootstrapFailure.label}: ${detail}` };
      }
      await sleep(bootstrapDelayMs);
      continue;
    }

    while (now() <= deadline) {
      const health = await healthCheck(target, { platform, run });
      if (health?.ok) return { ok: true, health };
      if (health?.oldDaemon || health?.oldPill) {
        for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
        break;
      }
      await sleep(healthPollMs);
    }
  }
  return { ok: false, reason: "activation-deadline-exceeded", detail: target.packageRoot };
}

/** Restart Linux user services from their already-repaired unit files. */
async function activateLinuxRuntimeServices(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  run = defaultRun,
  fsImpl = fs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 60,
  healthPollMs = 500,
  processId = process.pid,
  healthCheck = exactRuntimeHealth,
  pillReadyCheck = exactLinuxPillReady,
  requiredHealthySamples = 4,
} = {}) {
  if (platform !== "linux") return { ok: false, reason: "activation-platform-unsupported" };
  if (!target?.packageRoot || !target?.bin) return { ok: false, reason: "activation-target-invalid" };
  const units = [`${PILL_LABEL}.service`, `${DAEMON_LABEL}.service`];
  for (const unit of units) run("systemctl", ["--user", "stop", unit]);
  const stopped = await terminateInstalledServiceProcesses(target, {
    run,
    sleep,
    includeTarget: true,
    processId,
  });
  if (!stopped.ok) return stopped;
  const statusPath = linuxPillStatusPath({ homeDir, env });
  try { fsImpl.rmSync(statusPath, { force: true }); } catch {}
  const reloaded = run("systemctl", ["--user", "daemon-reload"]);
  if (!commandOk(reloaded)) {
    return { ok: false, reason: "systemd-user-unavailable", detail: reloaded?.stderr || reloaded?.stdout || "" };
  }
  const importArgs = systemdImportEnvironmentArgs(env);
  if (importArgs.length) {
    const imported = run("systemctl", importArgs);
    if (!commandOk(imported)) {
      return { ok: false, reason: "graphical-environment-import-failed", detail: imported?.stderr || imported?.stdout || "" };
    }
  }
  for (const unit of units) {
    const started = run("systemctl", ["--user", "start", unit]);
    if (!commandOk(started)) {
      return { ok: false, reason: "service-start-failed", detail: `${unit}: ${started?.stderr || started?.stdout || ""}` };
    }
  }
  let healthySamples = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await healthCheck(target, { platform, run });
    const ready = pillReadyCheck(target, { homeDir, env, fsImpl });
    healthySamples = health?.ok && ready?.ok ? healthySamples + 1 : 0;
    if (healthySamples >= Math.max(1, requiredHealthySamples)) return { ok: true, health, ready, healthySamples };
    if (attempt + 1 < attempts) await sleep(healthPollMs);
  }
  return { ok: false, reason: "exact-root-readiness-failed", detail: `${target.packageRoot}; ${statusPath}` };
}

module.exports = {
  activateLinuxRuntimeServices,
  activateMacRuntimeServices,
  exactRuntimeHealth,
  exactLinuxPillReady,
  installedServiceProcessRows,
  linuxPillStatusPath,
  runtimeProcessCommands,
  terminateInstalledServiceProcesses,
};
