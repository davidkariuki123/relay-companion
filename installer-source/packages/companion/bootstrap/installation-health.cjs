"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { runtimeProcessCommands, exactRuntimeHealth, linuxPillStatusPath } = require("./runtime-health.cjs");
const { progressPath, PROGRESS_FRESH_MS } = require("./daemon-progress.cjs");
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
const defaultRun = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
const commandOk = (result) => Boolean(result && !result.error && result.status === 0);
const PILL_LABEL = "work.relay.companion.pill";

// What the operating system says about the app (the pill), as opposed to what
// the updater believes it did. Sven's pill was dead for two days on 2026-10-10
// while the daemon kept reporting in and the fleet showed his machine healthy:
// the launch agent's program path pointed at a deleted release. Whether a pill
// process exists, whether its absence was chosen, how it last exited and whether
// its registered launch path still resolves are the facts that would have said
// so on the first day. Intent comes with it, so a pill someone quit or put away
// is never an alarm.
function pillLiveness({ homeDir, platform, env = process.env, live, current, run = defaultRun, now = Date.now() } = {}) {
  const running = live?.pill === true;
  let intent = "running";
  try { if (require("./recovery-intent.cjs").stopped(homeDir)) intent = "stopped"; } catch {}
  const statusPath = linuxPillStatusPath({ homeDir, env });
  let lastSeenAt = null;
  try {
    const modified = Number(fs.statSync(statusPath).mtimeMs);
    if (modified > 0 && modified <= now) lastSeenAt = new Date(modified).toISOString();
  } catch {}
  const status = read(statusPath);
  if (intent === "running" && running && (status?.pillHidden === true || status?.dismissed === true)) intent = "hidden";
  const pill = { running, intent, lastSeenAt, lastExit: null, launch: null };
  try {
    if (platform === "darwin") {
      pill.launch = macPillLaunch({ homeDir, current, run });
      if (!running) pill.lastExit = macPillLastExit(run);
    } else if (platform === "linux" && !running) {
      pill.lastExit = linuxPillLastExit(run);
    }
  } catch {}
  return pill;
}

// Does the pill's registered launch path still lead to the release the launch
// file names? A dangling or re-pointed ~/.relay/runtime/Relay.app link is
// invisible to every process-based check until launchd fails to start the pill.
function macPillLaunch({ homeDir, current, run }) {
  const mac = require("./mac-service-recovery.cjs");
  let record;
  try { record = mac.readRegistration(PILL_LABEL, { homeDir, run }); }
  catch (error) {
    // The first token only (ENOENT, invalid-service-plist, ...): never a path.
    return { ok: false, reason: `registration-invalid: ${String(error?.code || error?.message || "unknown").split(/[:\s]/)[0].slice(0, 40)}` };
  }
  if (record.releaseExecutable) {
    const identity = require("./mac-background-identity.cjs");
    const link = identity.inspectStablePillLink({ homeDir });
    if (!link.present || !link.resolves) return { ok: false, reason: "link-dangling" };
    const expected = path.resolve(record.releaseExecutable, "..", "..", "..");
    const target = link.target ? path.resolve(path.dirname(link.link), link.target) : null;
    if (target && target !== expected) return { ok: false, reason: "link-wrong-release" };
  }
  if (current?.packageRoot && record.packageRoot !== current.packageRoot) return { ok: false, reason: "registration-not-active-runtime" };
  return { ok: true, reason: null };
}

function macPillLastExit(run) {
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = run("/bin/launchctl", ["print", `gui/${userId}/${PILL_LABEL}`]);
  if (!commandOk(result)) return null;
  const code = /\blast exit code = (\d+)/.exec(String(result.stdout || ""))?.[1];
  return code === undefined ? null : { code: Number(code), reason: null };
}

function linuxPillLastExit(run) {
  const result = run("systemctl", ["--user", "show", `${PILL_LABEL}.service`, "-p", "ExecMainStatus", "-p", "Result"]);
  if (!commandOk(result)) return null;
  const output = String(result.stdout || "");
  const code = /\bExecMainStatus=(\d+)/.exec(output)?.[1];
  const reason = /\bResult=([a-z-]+)/.exec(output)?.[1] || null;
  return code === undefined && !reason ? null : { code: code === undefined ? null : Number(code), reason: reason ? reason.slice(0, 40) : null };
}
function installationId({ homeDir = os.homedir(), create = false } = {}) {
  const file = path.join(homeDir, ".relay", "installation-id.json");
  const existing = read(file);
  if (/^ins_[a-f0-9]{32}$/.test(existing?.id || "")) return existing.id;
  if (!create || fs.existsSync(file)) return null;
  const id = `ins_${crypto.randomBytes(16).toString("hex")}`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, JSON.stringify({ schema: 1, id }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return read(file)?.id || null;
}
function componentInventory(commands, activeVersion = null) {
  const roles = new Map();
  for (const command of commands) {
    if (!/node_modules[\\/]relay-companion[\\/]/i.test(command)) continue;
    const role = /[\\/]mcp-broker-entry\.js\b/.test(command) ? "mcp-broker"
      : /[\\/]relay\.js.*\bdaemon\b/.test(command) ? "daemon"
      : /[\\/]overlay[\\/]main\.cjs(?:"|'|\s|$)/.test(command) ? "pill" : null;
    if (!role) continue;
    const version = /[\\/]releases[\\/](\d+\.\d+\.\d+)(?:-|[\\/])/.exec(command)?.[1] || null;
    const key = `${role}:${version}`;
    const item = roles.get(key) || { role, version, count: 0 };
    item.count++; roles.set(key, item);
  }
  const components = [...roles.values()];
  const duplicates = ["daemon", "pill"].some(role => components.filter(c => c.role === role).reduce((n,c) => n+c.count,0) > 1);
  const mixed = components.some(c => c.version && activeVersion && c.version !== activeVersion);
  return { components: components.slice(0, 12), duplicates, mixed };
}
function collectInstallationHealth({ homeDir = os.homedir(), platform = process.platform, arch = process.arch,
  osVersion = os.release(), commands, now = Date.now(), run = defaultRun, env = process.env } = {}) {
  const root = path.join(homeDir, ".relay"), current = read(path.join(root, "runtime", "current.json"));
  const activeVersion = current?.active === true ? current.version : null;
  const processCommands = commands || runtimeProcessCommands(platform);
  const inventory = componentInventory(processCommands, activeVersion);
  const live = current?.bin && current.packageRoot ? exactRuntimeHealth(current, { platform, commands: processCommands }) : null;
  const supervisor = read(path.join(root, "recovery", "status.json"));
  const monitor = require("./recovery-monitor.cjs").recoveryMonitor({ homeDir, now });
  const monitorFailure = ({ missing: "recovery-checks-missing", overdue: "recovery-checks-overdue", "launcher-failed": "recovery-launcher-failed", fallback: "recovery-fallback" })[monitor.state] || null;
  const heartbeat = read(path.join(root, "recovery", "daemon.json"));
  const progress = read(progressPath(homeDir));
  const progressSupported = !!current?.packageRoot && fs.existsSync(path.join(current.packageRoot, "bootstrap", "daemon-progress.cjs"));
  const progressMatches = progress?.packageRoot === current?.packageRoot && progress?.version === activeVersion && progress?.pid === heartbeat?.pid;
  const progressFresh = progressMatches && progress.sequence > 0 && progress.at <= now && now - progress.at < PROGRESS_FRESH_MS;
  const daemonResponsive = Boolean(live?.daemon && heartbeat?.version === activeVersion && heartbeat?.at <= now && now - heartbeat.at < 60_000
    && (!progressSupported || progressFresh));
  const componentNames = ["inbox-background", "agent-sessions", "topics", "tasks"];
  const unhealthyComponents = progressMatches ? componentNames.filter(name => ["failed", "stalled"].includes(progress.components?.[name])) : [];
  const pill = pillLiveness({ homeDir, platform, env, live, current, run, now });
  let serviceHealth = { state: "healthy", reason: "ready", components: unhealthyComponents };
  if (!activeVersion) serviceHealth = { ...serviceHealth, state: "unverified", reason: "runtime-not-active" };
  else if (!live?.daemon) serviceHealth = { ...serviceHealth, state: "failed", reason: "daemon-missing" };
  else if (!daemonResponsive) serviceHealth = { ...serviceHealth, state: "failed", reason: "daemon-not-responsive" };
  // A pill that was quit is waiting on the person; one that is simply gone is a
  // failure of its own, named as such rather than folded into a process mismatch.
  else if (!live?.pill && pill.intent === "stopped") serviceHealth = { ...serviceHealth, state: "waiting", reason: "pill-stopped" };
  else if (!live?.pill) serviceHealth = { ...serviceHealth, state: "failed", reason: "pill-missing" };
  else if (!live?.ok) serviceHealth = { ...serviceHealth, state: "failed", reason: "service-process-mismatch" };
  else if (unhealthyComponents.length) serviceHealth = { ...serviceHealth, state: "degraded", reason: "component-failed" };
  else if (progressMatches && ["offline", "signed-out"].includes(progress.phase)) serviceHealth = { ...serviceHealth, state: "waiting", reason: progress.phase };
  else if (monitorFailure || supervisor?.ok === false) serviceHealth = { ...serviceHealth, state: "degraded", reason: "recovery-failed" };
  else if (!progressSupported) serviceHealth = { ...serviceHealth, state: "unverified", reason: "legacy-readiness" };
  const transport = (name) => {
    const report = read(path.join(root, "transport-health", `${name}.json`));
    return report?.at > 0 && now >= report.at ? new Date(report.at).toISOString() : null;
  };
  return {
    installationId: installationId({ homeDir }), os: platform, osVersion: osVersion.slice(0, 80), arch,
    ...inventory, daemonResponsive, health: serviceHealth, pill,
    recovery: supervisor || monitorFailure ? { status: supervisor?.status || monitor.state, version: supervisor?.launcherVersion || null,
      checkedAt: supervisor?.checkedAt > 0 ? new Date(supervisor.checkedAt).toISOString() : null,
      desiredVersion: supervisor?.desiredVersion || null,
      lastSuccessAt: supervisor?.lastSuccessAt > 0 ? new Date(supervisor.lastSuccessAt).toISOString() : null,
      monitor: { state: monitor.state, repairStatus: monitor.repairStatus,
        lastRepairAt: monitor.lastRepairAt > 0 ? new Date(monitor.lastRepairAt).toISOString() : null },
      // Do not upload logs, URLs, usernames, or raw errors. These stay in doctor.
      failureCode: monitorFailure || (supervisor?.ok === false ? "recovery-failed" : null) } : null,
    transports: { mcpLastUsedAt: transport("mcp"), httpsLastUsedAt: transport("https") },
  };
}
function recordTransport(name, { homeDir = os.homedir(), now = Date.now() } = {}) {
  if (!["mcp", "https"].includes(name)) return;
  const root = path.join(homeDir, ".relay", "transport-health");
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify({ at: now }), { mode: 0o600 }); } catch {}
}
function describeInstallationHealth(installation) {
  const reason = installation?.health?.reason;
  const message = ({ "daemon-missing": "Background service stopped", "daemon-not-responsive": "Background service is not responding",
    "service-process-mismatch": "Relay services are not running together correctly", "component-failed": "An optional background component needs attention",
    "pill-missing": "Relay app is not running", "pill-stopped": "Relay app was quit",
    "recovery-failed": "Recovery needs attention", "offline": "Waiting for Relay's connection", "signed-out": "Waiting for sign-in",
    "runtime-not-active": "Runtime health has not been verified", "legacy-readiness": "Background service running; readiness not verified",
    "ready": "Relay is running" })[reason] || "Runtime health has not been verified";
  return message + (["restarting", "reactivating", "restoring-local", "downloading"].includes(installation?.recovery?.status) ? "; recovery in progress" : "");
}
/** One doctor line about the app, from the OS facts above. */
function describePillLiveness(pill) {
  if (!pill) return "not reported";
  if (pill.running) return pill.intent === "hidden" ? "running, hidden by choice" : "running";
  if (pill.intent === "stopped") return "not running; it was quit on purpose (relay pill starts it again)";
  const parts = [`NOT running${pill.lastSeenAt ? ` since ${pill.lastSeenAt}` : ""}`];
  if (pill.lastExit && pill.lastExit.code !== null) parts.push(`last exit code ${pill.lastExit.code}${pill.lastExit.reason ? ` (${pill.lastExit.reason})` : ""}`);
  else if (pill.lastExit?.reason) parts.push(`last exit ${pill.lastExit.reason}`);
  if (pill.launch && pill.launch.ok === false) parts.push(`cannot launch: ${pill.launch.reason}`);
  parts.push("fix with: relay repair-installation");
  return parts.join("; ");
}
module.exports = { installationId, componentInventory, collectInstallationHealth, recordTransport, describeInstallationHealth, describePillLiveness, pillLiveness };
