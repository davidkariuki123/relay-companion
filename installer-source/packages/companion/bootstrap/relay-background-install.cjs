"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STATUS_VERSION = 1;
const RUNNING_STATUSES = ["starting", "installing", "waiting_authorization"];

function statusPath({ homeDir = os.homedir(), env = process.env } = {}) {
  return env.RELAY_BACKGROUND_INSTALL_STATUS || path.join(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"), "companion-install.json");
}

function logPath({ homeDir = os.homedir(), env = process.env } = {}) {
  return env.RELAY_BACKGROUND_INSTALL_LOG || path.join(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"), "companion-install.log");
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function readStatus(options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(statusPath(options), "utf8"));
    return state?.version === STATUS_VERSION ? state : { version: STATUS_VERSION, status: "idle" };
  } catch {
    return { version: STATUS_VERSION, status: "idle" };
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function installationStatus(options = {}) {
  const state = readStatus(options);
  if (RUNNING_STATUSES.includes(state.status) && !processAlive(state.pid)) {
    return { ...state, status: "failed", reason: "installer_stopped", finishedAt: new Date().toISOString() };
  }
  return state;
}

function startBackgroundInstall({
  entry = path.resolve(__dirname, "relay-setup.cjs"),
  node = process.execPath,
  spawnImpl = spawn,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const paths = { homeDir, env };
  const existing = installationStatus(paths);
  if (RUNNING_STATUSES.includes(existing.status)) {
    return { ok: true, started: false, alreadyRunning: true, status: existing };
  }
  fs.mkdirSync(path.dirname(statusPath(paths)), { recursive: true, mode: 0o700 });
  const worker = spawnImpl(node, [__filename, "--worker", "--entry", entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, RELAY_BACKGROUND_INSTALL_STATUS: statusPath(paths), RELAY_BACKGROUND_INSTALL_LOG: logPath(paths) },
  });
  worker.unref?.();
  const state = {
    version: STATUS_VERSION,
    status: "starting",
    pid: worker.pid,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    reason: "",
    logPath: logPath(paths),
  };
  atomicWriteJson(statusPath(paths), state);
  return { ok: true, started: true, pid: worker.pid, status: state };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

// Download and verify first, but never activate or enroll Companion until the
// helper has verified the browser grant and finished its atomic handoff. Only
// inspect file existence here; account/consent checks remain in adoption.
async function waitForAgentAuthorization({
  env = process.env,
  homeDir = os.homedir(),
  exists = fs.existsSync,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30 * 60 * 1000,
  intervalMs = 1000,
} = {}) {
  const root = env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay");
  const credential = env.RELAY_AGENT_CONFIG || path.join(root, "agent-protocol.json");
  const pending = env.RELAY_AGENT_AUTHORIZATION || path.join(root, "agent-authorization.json");
  const deadline = now() + timeoutMs;
  const options = { env, homeDir };
  let waiting = false;
  while (exists(pending) || !exists(credential)) {
    if (!waiting) {
      atomicWriteJson(statusPath(options), { ...readStatus(options), status: "waiting_authorization" });
      waiting = true;
    }
    if (now() >= deadline) {
      throw new Error("Companion is downloaded but browser approval is not complete. Finish the Relay connection, then retry background-install.");
    }
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  if (waiting) atomicWriteJson(statusPath(options), { ...readStatus(options), status: "installing" });
}

async function runWorker(argv = process.argv.slice(2), { spawnImpl = spawn, env = process.env } = {}) {
  const entry = path.resolve(option(argv, "--entry") || path.resolve(__dirname, "relay-setup.cjs"));
  if (path.basename(entry) !== "relay-setup.cjs" || !fs.existsSync(entry)) throw new Error("Relay's background installer entry is invalid.");
  const statusFile = statusPath({ env });
  const outputFile = logPath({ env });
  const startedAt = new Date().toISOString();
  atomicWriteJson(statusFile, { version: STATUS_VERSION, status: "installing", pid: process.pid, startedAt, finishedAt: "", reason: "", logPath: outputFile });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  const output = fs.openSync(outputFile, "a", 0o600);
  const child = spawnImpl(process.execPath, [entry, "setup", "--agent-protocol"], {
    stdio: ["ignore", output, output],
    windowsHide: true,
    env: { ...env, RELAY_BACKGROUND_INSTALL_WORKER: "1" },
  });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ ok: false, reason: error?.message || "spawn_failed" }));
    child.once("exit", (code, signal) => resolve({ ok: code === 0, reason: code === 0 ? "" : signal || `exit_${code}` }));
  });
  try { fs.closeSync(output); } catch {}
  const final = {
    version: STATUS_VERSION,
    status: result.ok ? "installed" : "failed",
    pid: process.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    reason: result.reason,
    logPath: outputFile,
  };
  atomicWriteJson(statusFile, final);
  return final;
}

if (require.main === module) {
  if (process.argv.includes("--worker")) {
    runWorker().then((result) => { if (result.status !== "installed") process.exitCode = 1; }).catch((error) => {
      try {
        atomicWriteJson(statusPath(), {
          version: STATUS_VERSION,
          status: "failed",
          pid: process.pid,
          startedAt: "",
          finishedAt: new Date().toISOString(),
          reason: error?.message || String(error),
          logPath: logPath(),
        });
      } catch {}
      process.exitCode = 1;
    });
  }
}

module.exports = {
  STATUS_VERSION,
  atomicWriteJson,
  installationStatus,
  logPath,
  readStatus,
  runWorker,
  startBackgroundInstall,
  statusPath,
  waitForAgentAuthorization,
};
