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

// Windows starts each service through a hidden `cmd.exe /d /s /c "..."` wrapper
// (install.js windowsTaskAction) whose command line repeats the whole service
// command. That row is the same daemon or pill, not a second one: counting it
// made every exact-root health check on Windows report two daemons and two
// pills, so activation failed forever and the updater re-staged in a loop.
const WINDOWS_SHELL_WRAPPER_RE = /^\s*"?(?:[^"\r\n]*[\\/])?cmd\.exe"?\s/i;

function withoutWindowsShellWrappers(lines) {
  return lines.filter((line) => !WINDOWS_SHELL_WRAPPER_RE.test(line));
}

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...options });
}

function runtimeProcessQuery(platform) {
  if (platform === "win32") {
    const script = "$ErrorActionPreference = 'Stop'; $relaySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -match 'node_modules[\\\\/]relay-companion[\\\\/]' } | ForEach-Object { $relayOwner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop; if (-not $relayOwner.Sid) { throw 'service-owner-query-failed' }; if ($relayOwner.Sid -eq $relaySid) { $_.CommandLine } }";
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { command: "/bin/ps", args: ["-axo", "uid=,command="] };
}

function parseRuntimeProcessCommands(stdout, platform, userId = typeof process.getuid === "function" ? process.getuid() : 0) {
  if (platform === "win32") return withoutWindowsShellWrappers(String(stdout || "").split(/\r?\n/));
  const lines = [];
  for (const row of String(stdout || "").split(/\r?\n/)) {
    const match = row.match(/^\s*(\d+)\s+(.*)$/);
    if (match && Number(match[1]) === userId) lines.push(match[2]);
  }
  return lines;
}

function runtimeProcessCommands(platform, run = defaultRun, userId = typeof process.getuid === "function" ? process.getuid() : 0) {
  const { command, args } = runtimeProcessQuery(platform);
  const result = run(command, args);
  return commandOk(result) ? parseRuntimeProcessCommands(result.stdout, platform, userId) : [];
}

function exactRuntimeHealth(target, {
  platform = process.platform,
  run = defaultRun,
  commands = null,
  userId = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  let observed = commands;
  if (observed === null) {
    const query = runtimeProcessQuery(platform);
    let result;
    try { result = run(query.command, query.args); } catch (error) { result = { error }; }
    // An unavailable observer is not evidence that either service disappeared.
    if (!commandOk(result)) return { ok: false, known: false, reason: "service-process-query-failed", packageRoot: target.packageRoot };
    observed = parseRuntimeProcessCommands(result.stdout, platform, userId);
  }
  const lines = withoutWindowsShellWrappers(observed);
  const normalize = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value)).replaceAll("\\", "/");
  const daemonNeedle = normalize(target.bin);
  const pillNeedle = normalize(api.join(target.packageRoot, "overlay", "main.cjs"));
  const relayDaemons = lines.filter((line) => SERVICE_TREE_RE.test(line) && /(?:^|[\\/])relay\.js(?:"|'|\s).*\bdaemon\b/i.test(line));
  const relayPills = lines.filter((line) => SERVICE_TREE_RE.test(line) && /(?:^|[\\/])overlay[\\/]main\.cjs(?:"|'|\s|$)/i.test(line));
  const daemonCount = relayDaemons.filter((line) => normalize(line).includes(daemonNeedle)).length;
  const pillCount = relayPills.filter((line) => normalize(line).includes(pillNeedle)).length;
  const daemon = daemonCount === 1;
  const pill = pillCount === 1;
  const brokers = lines.filter((line) => SERVICE_TREE_RE.test(line) && /[\\/]mcp-broker-entry\.js(?:"|'|\s|$)/i.test(line));
  const oldBroker = brokers.some((line) => !normalize(line).includes(normalize(target.packageRoot)));
  const oldDaemon = relayDaemons.some((line) => !normalize(line).includes(daemonNeedle));
  const oldPill = relayPills.some((line) => !normalize(line).includes(pillNeedle));
  return { ok: daemon && pill && !oldDaemon && !oldPill && !oldBroker, known: true, daemon, pill, daemonCount, pillCount, brokerCount: brokers.length, oldBroker, oldDaemon, oldPill, packageRoot: target.packageRoot };
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
    const isBroker = /[\\/]mcp-broker-entry\.js(?:"|'|\s|$)/i.test(command);
    if (!isDaemon && !isPill && !isBroker) continue;
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
  let lastHealth = null;
  const preflight = installedServiceProcessRows(target, { run, includeTarget: true, processId });
  if (!preflight.ok) return { ...preflight, unchanged: true };
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
      lastHealth = health;
      if (health?.ok) return { ok: true, health };
      // A host bridge can restart an old broker after the initial reap. Treat
      // it like any other stale service so activation can converge again.
      if (health?.oldDaemon || health?.oldPill || health?.oldBroker) {
        for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
        break;
      }
      await sleep(healthPollMs);
    }
  }
  return { ok: false, reason: "activation-deadline-exceeded", health: lastHealth,
    detail: `${target.packageRoot}; ${JSON.stringify(lastHealth)}` };
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

// Physical memory left for new work. A machine this starved cannot extract a
// 245 MB runtime or start Codex without making everything else worse, so the
// callers that would do those things ask first. A restart of what is already
// installed stays allowed under pressure: it frees memory rather than taking it.
const MEMORY_PRESSURE_MIN_FREE_BYTES = 768 * 1024 * 1024;
const MEMORY_PRESSURE_MIN_FREE_RATIO = 0.05;
function memoryPressure({
  platform = process.platform,
  run = defaultRun,
  freeBytes = os.freemem(),
  totalBytes = os.totalmem(),
  minFreeBytes = MEMORY_PRESSURE_MIN_FREE_BYTES,
  minFreeRatio = MEMORY_PRESSURE_MIN_FREE_RATIO,
} = {}) {
  const free = Number(freeBytes);
  const total = Number(totalBytes);
  const known = Number.isFinite(free) && Number.isFinite(total) && total > 0;
  if (platform === "darwin") {
    // XNU exports dispatch flags here (1 normal, 2 warning, 4 critical),
    // NOT its internal 0..3 pressure enum. Never infer pressure from free pages.
    // bsd/kern/kern_memorystatus_notify.c: sysctl_memorystatus_vm_pressure_level.
    let result;
    try { result = run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 3000 }); } catch {}
    const value = commandOk(result) ? String(result.stdout || "").trim() : "";
    const level = ({ "1": "normal", "2": "warning", "4": "critical" })[value] || "unknown";
    return { pressured: level === "warning" || level === "critical", level, source: "macos-memory-pressure",
      freeBytes: known ? free : null, totalBytes: known ? total : null, freeMB: known ? Math.round(free / 1048576) : null };
  }
  const pressured = known && (free < minFreeBytes || free / total < minFreeRatio);
  return {
    pressured,
    freeBytes: known ? free : null,
    totalBytes: known ? total : null,
    freeMB: known ? Math.round(free / 1048576) : null,
  };
}

// Windows service identity for the in-place restart: the same task names
// install.js registers. The bootstrap must not import the application tree.
const WINDOWS_DAEMON_TASK = "Relay Companion Daemon";
const WINDOWS_PILL_TASK = "Relay Companion Pill";
// Only installed relay-companion trees, only this user's processes, and the
// whole tree of each (an Electron main process leaves renderers behind otherwise).
const WINDOWS_STOP_INSTALLED_SERVICES_PS = [
  "$relaySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'node_modules[\\\\/]relay-companion[\\\\/]' -and ($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b' -or $_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs') } | ForEach-Object { $relayOwner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; if ($relayOwner.Sid -eq $relaySid) { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null; Write-Output $_.ProcessId } }",
].join("; ");

/**
 * Restart the installed Windows daemon and pill from their existing scheduled
 * tasks, then prove the exact package root is the one running. No download and
 * no re-registration: this is the rung that repairs a starved or wedged runtime
 * whose code on disk is already the code we want.
 */
async function activateWindowsRuntimeServices(target, {
  platform = process.platform,
  run = defaultRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  healthCheck = exactRuntimeHealth,
  activationDeadlineMs = 90_000,
  healthPollMs = 1000,
  settleMs = 800,
} = {}) {
  if (platform !== "win32") return { ok: false, reason: "activation-platform-unsupported" };
  if (!target?.packageRoot || !target?.bin) return { ok: false, reason: "activation-target-invalid" };
  const tasks = [WINDOWS_DAEMON_TASK, WINDOWS_PILL_TASK];
  for (const task of tasks) {
    const registered = run("schtasks.exe", ["/Query", "/TN", task]);
    if (!commandOk(registered)) return { ok: false, reason: "service-task-missing", detail: task };
  }
  const stopped = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STOP_INSTALLED_SERVICES_PS]);
  if (!commandOk(stopped)) {
    return { ok: false, reason: "service-process-stop-failed", detail: String(stopped?.stderr || stopped?.error?.message || "").trim() };
  }
  const terminated = String(stopped.stdout || "").split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  if (terminated.length) await sleep(settleMs);
  for (const task of tasks) {
    const started = run("schtasks.exe", ["/Run", "/TN", task]);
    if (!commandOk(started)) {
      return { ok: false, reason: "service-start-failed", detail: `${task}: ${String(started?.stderr || started?.stdout || "").trim()}` };
    }
  }
  const deadline = now() + Math.max(1, activationDeadlineMs);
  let health = null;
  while (now() <= deadline) {
    health = await healthCheck(target, { platform, run });
    if (health?.ok) return { ok: true, health, terminated };
    await sleep(healthPollMs);
  }
  return { ok: false, reason: "activation-deadline-exceeded", detail: target.packageRoot, health, terminated };
}

// Use the existing OS service's idempotent start operation. Never spawn a second
// pill directly, kill a daemon, rewrite registrations, or drain unrelated work.
async function restoreMissingPill(target, {
  homeDir = os.homedir(), platform = process.platform, run = defaultRun,
  own = require("./lifecycle-ownership.cjs").lifecycleOwnership,
  healthCheck = exactRuntimeHealth, userId = process.getuid?.() ?? 0,
} = {}) {
  let lease;
  const defer = reason => ({ ok: false, deferred: true, reason });
  const assertTarget = () => {
    lease.assert();
    if (require("./recovery-intent.cjs").stopped(homeDir)) throw Error("intentionally-stopped");
    const current = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8"));
    if (!current.active || current.packageRoot !== target.packageRoot || current.committedAt !== target.committedAt) throw Error("runtime-changed");
  };
  try {
    try { lease = own({ homeDir }); } catch { return defer("deferred-update-owner"); }
    assertTarget();
    const health = await healthCheck(target, { platform, run });
    if (health.known === false) return defer("service-process-query-failed");
    if (health.ok) return { ok: true, changed: false };
    if (health.daemonCount !== 1 || health.pillCount !== 0 || health.oldDaemon || health.oldPill || health.oldBroker) return defer("runtime-changed");
    let command, args;
    const normalize = text => String(text).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replaceAll("\\", "/").toLowerCase();
    const script = normalize(path.join(target.packageRoot, "overlay", "main.cjs"));
    if (platform === "win32") {
      const task = run("schtasks.exe", ["/Query", "/TN", WINDOWS_PILL_TASK, "/XML"]);
      if (!commandOk(task)) return defer("service-registration-query-failed");
      const xml = normalize(task.stdout);
      // Stock Windows tasks normally delegate to a hidden launcher. Follow only
      // that exact managed file, never an arbitrary path supplied by task text.
      const launcher = path.join(homeDir, ".relay", "relay-companion-pill.vbs");
      const launcherTargetsCurrent = () => {
        const bytes = fs.readFileSync(launcher);
        // install.js writes the stock WScript launcher as UTF-16LE with a BOM
        // so non-ASCII account paths survive the Windows ANSI code page.
        const text = bytes[0] === 0xff && bytes[1] === 0xfe
          ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
        return normalize(text).includes(script);
      };
      const targetsCurrent = xml.includes(script) || (xml.includes(normalize(launcher))
        && launcherTargetsCurrent());
      if (!targetsCurrent || !/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/i.test(task.stdout)) return defer("service-target-unverified");
      command = "schtasks.exe"; args = ["/Run", "/TN", WINDOWS_PILL_TASK];
    } else if (platform === "linux") {
      const unit = `${PILL_LABEL}.service`;
      const service = run("systemctl", ["--user", "show", "--property=ExecStart", "--value", unit]);
      if (!commandOk(service)) return defer("service-registration-query-failed");
      if (!normalize(service.stdout).includes(script)) return defer("service-target-unverified");
      command = "systemctl"; args = ["--user", "start", unit];
    } else if (platform === "darwin") {
      const mac = require("./mac-service-recovery.cjs");
      const record = mac.readRegistration(PILL_LABEL, { homeDir, run });
      if (record.packageRoot !== target.packageRoot) return defer("runtime-changed");
      const observed = mac.registration(PILL_LABEL, { run, userId });
      if (!observed.known || !observed.present) return defer("service-registration-query-failed");
      command = "/bin/launchctl"; args = ["kickstart", `gui/${userId}/${PILL_LABEL}`];
    } else return defer("activation-platform-unsupported");
    // An updater cannot race this generation. Quit may have arrived while the
    // observer was waiting; check it again at the mutation boundary.
    assertTarget();
    const started = run(command, args);
    return commandOk(started) ? { ok: true, changed: true } : { ok: false, reason: "service-start-failed" };
  } catch (error) { return defer(error.message); }
  finally { lease?.release(); }
}

/** One entry point for "restart what is already installed" on every platform. */
async function restartInstalledRuntimeServices(target, { platform = process.platform, ...options } = {}) {
  if (!["darwin", "linux", "win32"].includes(platform)) return { ok: false, reason: "activation-platform-unsupported" };
  if (platform === "darwin") return require("./mac-service-recovery.cjs").restartMacRegisteredServices(target, options);
  let lease, releaseDrain;
  const homeDir = options.homeDir || require("node:os").homedir();
  try {
    try { lease = require("./lifecycle-ownership.cjs").lifecycleOwnership({ homeDir }); }
    catch { return { ok: false, reason: "deferred-update-owner" }; }
    const current = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8"));
    if (!current?.active || current.packageRoot !== target.packageRoot) return { ok: false, reason: "runtime-changed" };
    if (require("./recovery-intent.cjs").stopped(homeDir)) return { ok: false, reason: "intentionally-stopped" };
    const live = await (options.healthCheck || exactRuntimeHealth)(target, { platform, run: options.run });
    if (live.known === false) return { ok: false, reason: "service-process-query-failed" };
    releaseDrain = await require("./update-activity.cjs").drainCalls({ homeDir });
    lease.assert();
    const run = options.run || defaultRun;
    const guardedRun = (...args) => {
      lease.assert();
      if (require("./recovery-intent.cjs").stopped(homeDir)) throw Error("intentionally-stopped");
      return run(...args);
    };
    if (platform === "linux") return await activateLinuxRuntimeServices(target, { platform, ...options, run: guardedRun });
    if (platform === "win32") return await activateWindowsRuntimeServices(target, { platform, ...options, run: guardedRun });
    return { ok: false, reason: "activation-platform-unsupported" };
  } catch (error) { return { ok: false, reason: error.message }; }
  finally { releaseDrain?.(); lease?.release(); }
}

module.exports = {
  restoreMissingPill,
  activateLinuxRuntimeServices,
  activateMacRuntimeServices,
  activateWindowsRuntimeServices,
  exactRuntimeHealth,
  exactLinuxPillReady,
  installedServiceProcessRows,
  linuxPillStatusPath,
  memoryPressure,
  MEMORY_PRESSURE_MIN_FREE_BYTES,
  restartInstalledRuntimeServices,
  runtimeProcessCommands,
  runtimeProcessQuery,
  parseRuntimeProcessCommands,
  terminateInstalledServiceProcesses,
  WINDOWS_STOP_INSTALLED_SERVICES_PS,
};
