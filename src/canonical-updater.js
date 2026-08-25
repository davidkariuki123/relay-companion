import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { compatibleNodeRuntime, stableNodePath } from "./install.js";
import {
  canonicalRuntimeLayout,
  readCanonicalRuntime,
  recoverCanonicalRuntime,
  repairCanonicalRuntime,
  verifyCanonicalCandidate,
} from "./canonical-runtime.js";

const DAEMON_LABEL = "work.relay.companion";
const PILL_LABEL = "work.relay.companion.pill";
const WINDOWS_DAEMON_TASK = "Relay Companion Daemon";
const WINDOWS_PILL_TASK = "Relay Companion Pill";
export const UPDATE_WORKER_LABEL_PREFIX = "work.relay.companion.update.";
export const UPDATE_WORKER_LABEL = "work.relay.companion.update";
export const UPDATE_REQUEST_SCHEMA = 1;
// Only processes running out of a node_modules/relay-companion tree — a canonical
// release or a legacy global install — are the runtime's own services. A developer's
// checkout pill (…/packages/companion/overlay/main.cjs) must be invisible here: it
// used to count as an "old pill", which failed exact-root health on EVERY canonical
// activation while a dev pill ran, rolling back and stranding a ~650MB release per
// attempt (David's Mac: 140 release dirs in one day).
const SERVICE_TREE_RE = /node_modules[\\/]relay-companion[\\/]/i;
const require = createRequire(import.meta.url);
const { stageVerifiedRuntime, releasePlatform } = require("../bootstrap/relay-setup.cjs");
const { exactRuntimeHealth, runtimeProcessCommands: processCommands } = require("../bootstrap/runtime-health.cjs");

export { exactRuntimeHealth };

export async function installSignedRuntimeCandidate({ stagingRoot, version, platform = process.platform } = {}) {
  try {
    const expectedPlatform = releasePlatform(platform, process.arch);
    await stageVerifiedRuntime({ version, platformKey: expectedPlatform, destination: stagingRoot });
    return { ok: true, source: "signed-runtime-artifact" };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }
}

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...options });
}

export function legacyRuntimeTarget(packageRoot, version, {
  node = process.execPath,
  platform = process.platform,
} = {}) {
  const verified = verifyCanonicalCandidate(packageRoot, version, { platform });
  if (!verified.ok) return null;
  return {
    kind: "legacy",
    version,
    packageRoot,
    bin: verified.bin,
    electronPath: verified.electronPath,
    node,
  };
}

export function runtimeNpmCommand(node = process.execPath, {
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const directory = api.dirname(String(node || ""));
  const names = platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
  for (const name of names) {
    const candidate = api.join(directory, name);
    try { if (existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

export function smokeCanonicalCandidate(candidate, { run = defaultRun } = {}) {
  const result = run(candidate.node, [candidate.bin, "--help"], {
    env: { ...process.env, RELAY_SKIP_DESKTOP_POSTINSTALL: "1" },
  });
  return commandOk(result)
    ? { ok: true }
    : { ok: false, reason: "candidate-cli-smoke-failed", detail: result?.error?.message || result?.stderr || result?.stdout || "" };
}

export function processReferencedCanonicalRoots({
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  fsImpl = fs,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const { releasesDir } = canonicalRuntimeLayout({ homeDir, platform });
  let names = [];
  try {
    names = fsImpl.readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink?.())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const commands = processCommands(platform, run);
  const normalize = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value)).replaceAll("\\", "/");
  return names
    .map((name) => api.join(releasesDir, name, "node_modules", "relay-companion"))
    .filter((packageRoot) => commands.some((command) => normalize(command).includes(normalize(packageRoot))));
}

// The runtime's own service processes that are NOT running from the target root and
// are NOT tracked by the labels we just booted out: a pill that left the launchd
// domain without exiting, or a legacy global-tree pill/daemon started outside launchd.
// Left alone they hold the singleton lock, the freshly bootstrapped services lose it,
// and exact-root health fails — rollback, new ~650MB candidate, repeat. Sven ended his
// incident by killing exactly these by hand; do it here, scoped to relay-companion
// trees only so a developer's checkout services are never touched.
function staleServiceProcessRows(target, { run, includeTarget = false }) {
  const result = run("/bin/ps", ["-axo", "pid=,command="]);
  if (!commandOk(result)) return [];
  const targetNeedle = String(target.packageRoot || "").replaceAll("\\", "/");
  const rows = [];
  for (const line of String(result.stdout || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!SERVICE_TREE_RE.test(command)) continue;
    const isDaemon = /(?:^|[\\/])relay\.js(?:"|'|\s).*\bdaemon\b/i.test(command);
    const isPill = /(?:^|[\\/])overlay[\\/]main\.cjs(?:"|'|\s|$)/i.test(command);
    if (!isDaemon && !isPill) continue;
    if (!includeTarget && targetNeedle && command.replaceAll("\\", "/").includes(targetNeedle)) continue;
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    rows.push({ pid, command });
  }
  return rows;
}

async function terminateStaleServiceProcesses(target, { run, sleep, graceMs = 2000, includeTarget = false }) {
  const rows = staleServiceProcessRows(target, { run, includeTarget });
  if (!rows.length) return { terminated: [] };
  for (const row of rows) run("/bin/kill", ["-TERM", String(row.pid)]);
  await sleep(graceMs);
  const survivors = staleServiceProcessRows(target, { run, includeTarget }).filter((row) => rows.some((r) => r.pid === row.pid));
  for (const row of survivors) run("/bin/kill", ["-KILL", String(row.pid)]);
  if (survivors.length) await sleep(500);
  return { terminated: rows.map((row) => row.pid) };
}

export async function activateCanonicalRuntime(target, {
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Exact-root health polls, 500ms apart. 30s: an Electron pill can legitimately
  // take >15s to be killed and >5s to come back up on a loaded machine.
  attempts = 60,
  domainPollMs = 250,
  bootstrapDelayMs = 500,
  activationDeadlineMs = 90_000,
  now = Date.now,
  repairExecutable = target,
} = {}) {
  if (!target?.bin || !target?.node || !target?.packageRoot) return { ok: false, reason: "activation-target-invalid" };
  if (!repairExecutable?.bin || !repairExecutable?.node) return { ok: false, reason: "repair-runtime-missing" };
  const targetOverride = repairExecutable.bin === target.bin
    ? []
    : ["--target-bin", target.bin, "--target-node", target.node];
  const repair = run(repairExecutable.node, [
    repairExecutable.bin,
    "repair-runtime",
    "--no-restart",
    ...targetOverride,
  ], {
    env: { ...process.env, RELAY_SKIP_DESKTOP_POSTINSTALL: "1" },
  });
  if (!commandOk(repair)) {
    return { ok: false, reason: "runtime-registration-failed", detail: repair?.error?.message || repair?.stderr || repair?.stdout || "" };
  }

  if (platform === "darwin") {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    const agents = path.join(homeDir, "Library", "LaunchAgents");
    const labels = [PILL_LABEL, DAEMON_LABEL];
    const deadline = now() + Math.max(1, activationDeadlineMs);
    for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);

    // One state machine, one deadline: quiesce every production Relay service,
    // start the two exact registrations, then prove exact-root health. EIO means
    // launchd had not finished the prior bootout; it loops back through quiescence
    // instead of stacking a second blind retry mechanism on top.
    while (now() <= deadline) {
      const labelsPresent = labels.filter((label) => commandOk(run("/bin/launchctl", ["print", `${domain}/${label}`])));
      if (labelsPresent.length) {
        for (const label of labelsPresent) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
        await sleep(domainPollMs);
        continue;
      }

      await terminateStaleServiceProcesses(target, { run, sleep, includeTarget: true });
      if (staleServiceProcessRows(target, { run, includeTarget: true }).length) {
        await sleep(domainPollMs);
        continue;
      }

      let bootstrapFailure = null;
      for (const label of labels) {
        const started = run("/bin/launchctl", ["bootstrap", domain, path.join(agents, `${label}.plist`)]);
        if (!commandOk(started)) {
          bootstrapFailure = { label, result: started };
          break;
        }
      }
      if (bootstrapFailure) {
        for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
        const detail = `${bootstrapFailure.result?.stderr || bootstrapFailure.result?.stdout || ""}`;
        if (!/(?:Bootstrap failed:\s*5|Input\/output error|I\/O error)/i.test(detail)) {
          return { ok: false, reason: "service-bootstrap-failed", detail: `${bootstrapFailure.label}: ${detail}` };
        }
        await sleep(bootstrapDelayMs);
        continue;
      }

      while (now() <= deadline) {
        const health = exactRuntimeHealth(target, { platform, run });
        if (health.ok) return { ok: true, health };
        if (health.oldDaemon || health.oldPill) {
          for (const label of labels) run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
          break;
        }
        await sleep(500);
      }
    }
    return { ok: false, reason: "activation-deadline-exceeded", detail: target.packageRoot };
  } else if (platform === "win32") {
    for (const task of [WINDOWS_PILL_TASK, WINDOWS_DAEMON_TASK]) run("schtasks.exe", ["/End", "/TN", task]);
    // The tasks launch through a short-lived wscript/WshShell.Run wrapper. `/End`
    // can therefore succeed while the actual node/Electron child survives. Stop
    // every Relay service process by command-line identity before starting the new
    // exact-root actions; the updater worker itself does not match either pattern.
    const stopRelayChildren = [
      "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
      "  $_.CommandLine -and (($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b') -or ($_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs'))",
      "}; foreach($x in $p){ try { Invoke-CimMethod -InputObject $x -MethodName Terminate -ErrorAction Stop | Out-Null } catch {} }",
    ].join(" ");
    const stopped = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopRelayChildren]);
    if (!commandOk(stopped)) return { ok: false, reason: "old-service-stop-failed", detail: stopped?.stderr || stopped?.stdout || "" };
    for (const task of [WINDOWS_PILL_TASK, WINDOWS_DAEMON_TASK]) {
      const started = run("schtasks.exe", ["/Run", "/TN", task]);
      if (!commandOk(started)) return { ok: false, reason: "service-start-failed", detail: `${task}: ${started?.stderr || started?.stdout || ""}` };
    }
  } else {
    return { ok: false, reason: "activation-platform-unsupported" };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = exactRuntimeHealth(target, { platform, run });
    if (health.ok) return { ok: true, health };
    if (attempt + 1 < attempts) await sleep(500);
  }
  return { ok: false, reason: "exact-root-health-failed", detail: target.packageRoot };
}

export async function runCanonicalUpdateTransaction({
  version,
  runningPackageRoot,
  runningVersion,
  node = process.execPath,
  homeDir = os.homedir(),
  platform = process.platform,
  log = () => {},
  activate = activateCanonicalRuntime,
  repair = repairCanonicalRuntime,
  installCandidate = installSignedRuntimeCandidate,
  smoke = smokeCanonicalCandidate,
  npmCommand = runtimeNpmCommand(node, { platform }),
  getProtectedPackageRoots = processReferencedCanonicalRoots,
  resolveServiceNode = stableNodePath,
  onLockAcquired = () => {},
  requestId = null,
  workerId = null,
} = {}) {
  const serviceNode = resolveServiceNode(node);
  if (!serviceNode) return { ok: false, phase: "input", reason: "service-node-missing", detail: node };
  // Electron must never be baked into plists/pointers as the runtime's node, and it
  // cannot resolve npm either. spawnCanonicalUpdate substitutes a real node before
  // the worker exists; this guard is the backstop for every other caller.
  if (isElectronExecutable(serviceNode)) {
    return { ok: false, phase: "input", reason: "service-node-electron", detail: serviceNode };
  }
  const protectedPackageRoots = getProtectedPackageRoots({ homeDir, platform });
  const lockIdentity = { ...(requestId ? { requestId } : {}), ...(workerId ? { workerId } : {}) };
  let admitted = false;
  const admit = async (owner) => {
    if (admitted) return;
    await onLockAcquired(owner);
    admitted = true;
  };
  const recovered = await recoverCanonicalRuntime({
    homeDir,
    platform,
    protectedPackageRoots,
    rollbackActivate: async (target, context) => target
      ? activate({
          ...target,
          node: resolveServiceNode(target?.node || serviceNode) || serviceNode,
        }, { homeDir, platform, repairExecutable: context?.recovery?.candidate })
      : { ok: true },
    onLockAcquired: admit,
    lockIdentity,
  });
  if (!recovered.ok) return recovered;
  if (recovered.recovered) return recovered;
  // npm is resolved beside the worker's own runtime; when that yields nothing (the
  // worker was handed a bare binary with no sibling npm), fall back to the durable
  // service node's npm rather than failing the whole transaction.
  const npmExecutable = npmCommand || runtimeNpmCommand(serviceNode, { platform });
  const previous = readCanonicalRuntime({ homeDir, platform });
  const legacy = previous ? null : legacyRuntimeTarget(runningPackageRoot, runningVersion, { node: serviceNode, platform });
  if (!previous && !legacy) return { ok: false, phase: "input", reason: "legacy-runtime-invalid" };
  return repair({
    version,
    homeDir,
    platform,
    node: serviceNode,
    npmCommand: npmExecutable,
    installCandidate,
    protectedPackageRoots,
    normalizePreviousTarget: (target) => ({
      ...target,
      node: resolveServiceNode(target?.node || serviceNode) || serviceNode,
    }),
    onLockAcquired: admit,
    lockIdentity,
    rollbackTarget: legacy,
    preCommitVerify: async (candidate) => smoke(candidate),
    postCommitActivate: async (candidate) => {
      log(`activating ${candidate.version} from ${candidate.packageRoot}`);
      return activate(candidate, { homeDir, platform });
    },
    rollbackActivate: async (target, context) => {
      if (!target) return { ok: true };
      log(`restoring runtime targets to ${target.packageRoot}`);
      return activate(target, { homeDir, platform, repairExecutable: context?.failed });
    },
  });
}

function workerPath() {
  return fileURLToPath(import.meta.url);
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// The pill launches `relay update` with ELECTRON_RUN_AS_NODE=1, which changes
// behaviour but not process.execPath — so "the current runtime" reaching this
// module can be the Electron binary itself. `launchctl submit` carries no
// environment (the whole premise of the PATH bug above), so a submitted Electron
// runs the worker as a GUI app: GPU and network helpers, no npm resolvable beside
// it, and no exit when the work ends. That immortal worker is what Sven clicked
// "Update" into (pid 15090) — it did nothing, and it never went away.
export function isElectronExecutable(executable = process.execPath) {
  const value = String(executable || "");
  if (!value) return false;
  if (/[\\/]electron\.app[\\/]/i.test(value)) return true;
  const base = value.split(/[\\/]/).pop().toLowerCase();
  if (base === "electron" || base === "electron.exe") return true;
  return value === process.execPath && Boolean(process.versions?.electron);
}

export function resolveUpdateWorkerNode(node = process.execPath, {
  platform = process.platform,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  run = defaultRun,
} = {}) {
  if (node && !isElectronExecutable(node)) return node;
  const candidates = [];
  try {
    const current = readCanonicalRuntime({ homeDir, platform });
    if (current?.node) candidates.push(current.node);
  } catch {}
  if (platform !== "win32") candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  const which = run(platform === "win32" ? "where.exe" : "/usr/bin/which", ["node"]);
  if (commandOk(which)) {
    const first = String(which.stdout || "").split(/\r?\n/)[0].trim();
    if (first) candidates.push(first);
  }
  for (const candidate of candidates) {
    try {
      if (
        candidate &&
        !isElectronExecutable(candidate) &&
        existsSync(candidate) &&
        compatibleNodeRuntime(candidate, { runCommand: run })
      ) return candidate;
    } catch {}
  }
  return null;
}

// `launchctl list` rows are "PID\tStatus\tLabel". Current builds own one fixed
// label; suffixed labels identify legacy workers that must be removed wholesale.
export function listUpdateWorkerJobs({ run = defaultRun } = {}) {
  const result = run("/bin/launchctl", ["list"]);
  if (!commandOk(result)) return [];
  const jobs = [];
  for (const line of String(result.stdout || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, , label] = parts;
    if (!label || (label !== UPDATE_WORKER_LABEL && !label.startsWith(UPDATE_WORKER_LABEL_PREFIX))) continue;
    const spawnedAt = Number(label.split(".").pop()) || 0;
    jobs.push({
      label,
      kind: label === UPDATE_WORKER_LABEL ? "fixed" : "legacy",
      pid: pid === "-" ? null : Number(pid) || null,
      spawnedAt: label === UPDATE_WORKER_LABEL ? 0 : spawnedAt,
    });
  }
  return jobs;
}

// Every suffixed label belongs to a pre-fixed-label build. A young PID is not
// evidence that it is safe: the live process may itself be the stale storm
// generator replaying a dead version. The first current client to run removes all
// legacy jobs. The fixed label is deliberately retained while inactive; removing
// it from a delayed old worker creates an ABA race with the next update.
export function reconcileUpdateWorkerJobs({ run = defaultRun } = {}) {
  const jobs = listUpdateWorkerJobs({ run });
  const legacy = jobs.filter((job) => job.kind === "legacy");
  for (const job of legacy) run("/bin/launchctl", ["remove", job.label]);
  const fixed = jobs.find((job) => job.kind === "fixed") || null;
  return { removedLegacy: legacy.length, fixed };
}

function requestDirectory(homeDir, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(canonicalRuntimeLayout({ homeDir, platform }).root, "update-requests");
}

function atomicWriteText(destination, value, { fsImpl = fs, platform = process.platform } = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  fsImpl.mkdirSync(api.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fsImpl.writeFileSync(temporary, value, { mode: 0o600 });
  fsImpl.renameSync(temporary, destination);
}

function atomicWriteRequest(requestPath, value, options = {}) {
  atomicWriteText(requestPath, `${JSON.stringify(value)}\n`, options);
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function updateWorkerPlist(programArguments, logPath) {
  const argumentsXml = programArguments.map((argument) => `    <string>${plistEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UPDATE_WORKER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${plistEscape(logPath)}</string>
</dict>
</plist>
`;
}

function claimUpdateRequestDecision(requestPath, value, { fsImpl = fs } = {}) {
  const decisionPath = `${requestPath}.decision`;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(decisionPath, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    return { won: true, value };
  } catch (error) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    if (error?.code !== "EEXIST") throw error;
    // `open("wx")` is the linearization point. The winner may still be writing
    // the tiny record, so tolerate that bounded publication window.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const existing = JSON.parse(fsImpl.readFileSync(decisionPath, "utf8"));
        if (existing?.requestId && existing?.workerId && existing?.state) {
          return { won: false, value: existing };
        }
      } catch {}
      blockingSleep(5);
    }
    return { won: false, value: null };
  }
}

export function readUpdateRequest(requestPath, { fsImpl = fs } = {}) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(requestPath, "utf8"));
    return value?.schema === UPDATE_REQUEST_SCHEMA && value?.requestId ? value : null;
  } catch {
    return null;
  }
}

function blockingSleep(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, ms));
}

export function waitForUpdateRequestAdmission(requestPath, {
  fsImpl = fs,
  now = Date.now,
  sleep = blockingSleep,
  timeoutMs = 5_000,
  pollMs = 50,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const value = readUpdateRequest(requestPath, { fsImpl });
    if (value && ["admitted", "completed", "failed", "rejected"].includes(value.state)) return value;
    sleep(pollMs);
  } while (now() < deadline);
  return readUpdateRequest(requestPath, { fsImpl });
}

export async function waitForUpdateRequestTerminal(requestPath, {
  fsImpl = fs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20 * 60_000,
  pollMs = 250,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const value = readUpdateRequest(requestPath, { fsImpl });
    if (value && ["completed", "failed", "rejected"].includes(value.state)) return value;
    await sleep(pollMs);
  } while (now() < deadline);
  return readUpdateRequest(requestPath, { fsImpl });
}

export function spawnCanonicalUpdate({
  version,
  runningPackageRoot,
  runningVersion,
  node = process.execPath,
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  existsSync = fs.existsSync,
  fsImpl = fs,
  requestId = randomUUID(),
  workerId = randomUUID(),
  waitForAdmission = waitForUpdateRequestAdmission,
} = {}) {
  const workerNode = resolveUpdateWorkerNode(node, { platform, homeDir, existsSync, run });
  if (!workerNode) {
    throw new Error("canonical update worker needs a real Node runtime: refusing to launch it under Electron, and no public node was found");
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  const requestPath = api.join(requestDirectory(homeDir, platform), `${requestId}.json`);
  const prepared = {
    schema: UPDATE_REQUEST_SCHEMA,
    requestId,
    workerId,
    state: "prepared",
    requestedAt: Date.now(),
    version,
    runningVersion,
  };
  atomicWriteRequest(requestPath, prepared, { fsImpl, platform });
  const payload = encodePayload({
    version, runningPackageRoot, runningVersion, node: workerNode, homeDir, platform,
    requestId, workerId, requestPath,
  });
  let launchedPid = null;
  if (platform === "darwin") {
    const reconciled = reconcileUpdateWorkerJobs({ run });
    if (reconciled.fixed?.pid) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "worker-busy", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "busy", requestId, workerId, requestPath };
    }
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    if (reconciled.fixed) run("/bin/launchctl", ["bootout", `${domain}/${UPDATE_WORKER_LABEL}`]);
    const layout = canonicalRuntimeLayout({ homeDir, platform });
    const workerPlistPath = api.join(layout.root, "update-worker.plist");
    const logPath = api.join(homeDir, ".relay", "update.log");
    atomicWriteText(
      workerPlistPath,
      updateWorkerPlist([workerNode, workerPath(), "--worker", payload], logPath),
      { fsImpl, platform },
    );
    const submitted = run("/bin/launchctl", ["bootstrap", domain, workerPlistPath]);
    if (!commandOk(submitted)) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "launch-failed", detail: submitted?.stderr || submitted?.stdout || "", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "launch-failed", requestId, workerId, requestPath };
    }
  } else if (platform === "win32") {
    const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
    const commandLine = [workerNode, workerPath(), "--worker", payload].map(quote).join(" ");
    const ps = `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine.replaceAll("'", "''")}'} -ErrorAction Stop;if($r.ReturnValue-ne 0){exit 1};Write-Output $r.ProcessId`;
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const submitted = run(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
    ]);
    if (!commandOk(submitted)) {
      atomicWriteRequest(requestPath, { ...prepared, state: "rejected", reason: "launch-failed", detail: submitted?.stderr || submitted?.stdout || "", completedAt: Date.now() }, { fsImpl, platform });
      return { status: "launch-failed", requestId, workerId, requestPath };
    }
    launchedPid = Number(String(submitted.stdout || "").trim()) || null;
  } else {
    throw new Error(`canonical updater unsupported on ${platform}`);
  }
  const admitted = waitForAdmission(requestPath, { fsImpl });
  if (admitted?.state === "failed" && admitted.workerId === workerId && admitted.admittedAt) {
    return { status: "failed", requestId, workerId, requestPath, admittedAt: admitted.admittedAt, terminal: admitted };
  }
  if (!admitted || !["admitted", "completed"].includes(admitted.state) || admitted.workerId !== workerId) {
    const rejected = {
      ...(admitted || prepared),
      schema: UPDATE_REQUEST_SCHEMA,
      requestId,
      workerId,
      state: "rejected",
      reason: admitted?.reason || "admission-timeout",
      completedAt: Date.now(),
    };
    const decision = claimUpdateRequestDecision(requestPath, rejected, { fsImpl });
    if (decision.value?.state === "admitted" && decision.value.workerId === workerId) {
      return { status: "admitted", requestId, workerId, requestPath, admittedAt: decision.value.admittedAt };
    }
    if (decision.won) atomicWriteRequest(requestPath, rejected, { fsImpl, platform });
    if (platform === "win32" && launchedPid && decision.won) {
      run("taskkill.exe", ["/PID", String(launchedPid), "/T", "/F"]);
    }
    // Never remove the fixed launchd label here. Another caller may have observed
    // its old inactive state, replaced it, and submitted a newer worker while this
    // caller waited. Removing by label would kill that newer owner (an ABA race).
    return { status: decision.value?.reason === "worker-busy" ? "busy" : "not-admitted", requestId, workerId, requestPath };
  }
  return { status: "admitted", requestId, workerId, requestPath, admittedAt: admitted.admittedAt };
}

async function workerMain(payload) {
  let options = null;
  try {
    options = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    console.error(`[relay-update] worker payload invalid: ${error?.message || error}`);
    return null;
  }
  const requestApi = options.platform === "win32" ? path.win32 : path.posix;
  const expectedRequestPath = requestApi.join(requestDirectory(options.homeDir, options.platform), `${options.requestId}.json`);
  if (
    !options.requestId ||
    !options.workerId ||
    requestApi.resolve(String(options.requestPath || "")) !== requestApi.resolve(expectedRequestPath)
  ) {
    console.error("[relay-update] worker request identity/path invalid");
    return null;
  }
  const logPath = path.join(options.homeDir, ".relay", "update.log");
  const log = (message) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `[relay-update] ${new Date().toISOString()} ${message}\n`);
    } catch {}
  };
  const writeState = (state, extra = {}) => {
    if (!options.requestPath || !options.requestId || !options.workerId) return;
    const current = readUpdateRequest(options.requestPath) || {
      schema: UPDATE_REQUEST_SCHEMA,
      requestId: options.requestId,
      workerId: options.workerId,
      requestedAt: Date.now(),
    };
    if (current.requestId !== options.requestId || current.workerId !== options.workerId) {
      throw new Error("update request identity changed before worker admission");
    }
    if (current.state === "rejected" && state !== "rejected") return current;
    atomicWriteRequest(options.requestPath, { ...current, ...extra, state });
    return { ...current, ...extra, state };
  };
  try {
    const result = await runCanonicalUpdateTransaction({
      ...options,
      log,
      onLockAcquired: (owner) => {
        const admittedAt = Date.now();
        const admission = {
          schema: UPDATE_REQUEST_SCHEMA,
          requestId: options.requestId,
          workerId: options.workerId,
          state: "admitted",
          admittedAt,
          lockOwner: owner,
        };
        const decision = claimUpdateRequestDecision(options.requestPath, admission);
        if (!decision.won && (
          decision.value?.state !== "admitted" ||
          decision.value?.requestId !== options.requestId ||
          decision.value?.workerId !== options.workerId
        )) {
          throw new Error("update request was cancelled before worker admission");
        }
        writeState("admitted", { admittedAt, lockOwner: owner });
      },
    });
    const detail = String(result?.detail || "").trim().replace(/\s+/g, " ").slice(0, 2000);
    log(result.ok
      ? result.recovered ? "canonical activation journal recovered" : `canonical update committed: ${result.candidate.version}`
      : `canonical update failed at ${result.phase}: ${result.reason}${detail ? ` (${detail})` : ""}`);
    writeState(result.ok ? "completed" : "failed", {
      completedAt: Date.now(),
      result: { ok: Boolean(result.ok), phase: result.phase || null, reason: result.reason || null, detail },
    });
  } catch (error) {
    log(`canonical update worker crashed: ${error?.stack || error?.message || String(error)}`);
    try {
      writeState("failed", {
        completedAt: Date.now(),
        result: { ok: false, phase: "worker", reason: "worker-crashed", detail: error?.message || String(error) },
      });
    } catch {}
  }
  return options;
}

if (process.argv[2] === "--worker" && process.argv[3]) {
  const options = await workerMain(process.argv[3]);
  // ALWAYS exit 0. launchd restarts a submitted job that exits non-zero — forever,
  // with its original payload — so a failing worker used to be resurrected every
  // few seconds for hours, replaying a stale target version. Failure is reported
  // through update.log and the durable failure records, never the exit code
  // (nothing ever read it anyway).
  process.exitCode = 0;
}
