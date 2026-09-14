"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const PROGRESS_FRESH_MS = 60_000;
const CRASH_WINDOW_MS = 30 * 60_000;
const progressPath = homeDir => path.join(homeDir, ".relay", "recovery", "daemon-progress.json");
const crashPath = homeDir => path.join(homeDir, ".relay", "recovery", "daemon-crash.json");

function createDaemonProgress({ packageRoot, version, homeDir = os.homedir(), pid = process.pid, now = Date.now,
  persist = value => atomicFile(progressPath(homeDir), JSON.stringify(value)) } = {}) {
  const startedAt = now();
  let state = { schema: 1, packageRoot, version, pid, startedAt, at: startedAt, sequence: 0, phase: "starting", components: {} };
  const save = () => { try { persist(state); } catch {} };
  save();
  return {
    advance(phase = "running") { state = { ...state, phase, at: now(), sequence: state.sequence + 1 }; save(); },
    component(name, status) { if (state.components[name] !== status) { state.components[name] = status; save(); } },
    snapshot() { return { ...state, components: { ...state.components } }; },
    async waiting(operation, phase = "offline") {
      // Explicit local control progress while authentication/network is pending.
      // It reports a wait, never successful delivery or signed-in operation.
      const tick = () => { state = { ...state, phase, at: now(), sequence: state.sequence + 1 }; save(); };
      tick();
      const timer = setInterval(tick, 5000);
      try { return await operation(); } finally { clearInterval(timer); }
    },
    ready() { return state.sequence > 0 && state.at <= now() && now() - state.at < PROGRESS_FRESH_MS; },
  };
}

// Record only a fingerprint of the stack, never account data, paths or raw
// exception messages. Count one event per process, scoped to the exact runtime.
function recordDaemonCrash(error, { packageRoot, version, homeDir = os.homedir(), pid = process.pid, now = Date.now } = {}) {
  try {
    const file = crashPath(homeDir), previous = read(file), at = now();
    const fingerprint = crypto.createHash("sha256").update(String(error?.stack || error)).digest("hex");
    const same = previous?.packageRoot === packageRoot && previous.version === version && previous.fingerprint === fingerprint
      && at >= previous.at && at - previous.at < CRASH_WINDOW_MS;
    const count = same ? previous.count + (previous.pid === pid ? 0 : 1) : 1;
    const progress = read(progressPath(homeDir));
    const startup = progress?.pid !== pid || progress?.phase !== "running"
      || (Number.isFinite(progress.startedAt) && at >= progress.startedAt && at - progress.startedAt < 60_000);
    const report = { schema: 1, packageRoot, version, pid, at, fingerprint, count, startup };
    atomicFile(file, JSON.stringify(report));
    return report;
  } catch { return null; }
}
function repeatedStartupCrash(target, { homeDir = os.homedir(), now = Date.now() } = {}) {
  const report = read(crashPath(homeDir));
  return report?.startup === true && report.count >= 2 && report.packageRoot === target?.packageRoot && report.version === target?.version
    && report.at <= now && now - report.at < CRASH_WINDOW_MS ? report : null;
}
module.exports = { createDaemonProgress, recordDaemonCrash, repeatedStartupCrash, progressPath, PROGRESS_FRESH_MS };
