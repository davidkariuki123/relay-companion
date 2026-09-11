"use strict";

// Kept in the independent recovery bundle: restoring registrations must not
// require importing the application that failed to start.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const LABELS = ["work.relay.companion", "work.relay.companion.pill"];
const commandOk = r => Boolean(r && !r.error && r.status === 0);
const defaultRun = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, windowsHide: true, ...options });

function registration(label, { run = defaultRun, userId = process.getuid?.() ?? 0 } = {}) {
  const result = run("/bin/launchctl", ["print", `gui/${userId}/${label}`]);
  if (commandOk(result)) return { known: true, present: true, detail: String(result.stdout || ""), pid: Number(String(result.stdout || "").match(/\bpid = (\d+)/)?.[1]) || null };
  // A timeout or unavailable GUI domain is not evidence of a missing service.
  const missing = !result?.error && (result?.status === 113 || /Could not find service/i.test(String(result?.stderr || "")));
  return { known: missing, present: false, pid: null };
}

function readRegistration(label, { homeDir = os.homedir(), run = defaultRun, fsImpl = fs, contents } = {}) {
  const file = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const bytes = contents ?? fsImpl.readFileSync(file, "utf8");
  const decoded = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: bytes });
  if (!commandOk(decoded)) throw Error(`invalid-service-plist: ${label}`);
  const plist = JSON.parse(decoded.stdout);
  const args = plist.ProgramArguments;
  if (plist.Label !== label || !Array.isArray(args) || !args.every(x => typeof x === "string") || plist.Program) throw Error(`invalid-service-plist: ${label}`);
  const suffix = label === LABELS[0] ? /[\\/]bin[\\/]relay\.js$/ : /[\\/]overlay[\\/]main\.cjs$/;
  const script = args.find(x => /[\\/]node_modules[\\/]relay-companion[\\/]/.test(x) && suffix.test(x));
  if (!script || !path.isAbsolute(args[0]) || !path.isAbsolute(script) || (label === LABELS[0] && !args.includes("daemon"))) throw Error(`invalid-service-target: ${label}`);
  for (const filename of [args[0], script]) if (!fsImpl.statSync(filename).isFile()) throw Error(`missing-service-target: ${label}`);
  const packageRoot = script.replace(suffix, "");
  const pkg = JSON.parse(fsImpl.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "relay-companion") throw Error(`invalid-service-package: ${label}`);
  return { label, file, bytes, executable: args[0], script, packageRoot, version: pkg.version };
}

async function repairMacServiceRegistrations({
  homeDir = os.homedir(), platform = process.platform, run = defaultRun,
  userId = process.getuid?.() ?? 0, fsImpl = fs,
  acquireLock = file => require("./relay-setup.cjs").acquireCanonicalLock(file),
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } },
} = {}) {
  if (platform !== "darwin") return { ok: true, changed: false, status: "unsupported" };
  let lock;
  try { lock = acquireLock(path.join(homeDir, ".relay", "runtime", "transaction.lock")); }
  catch { return { ok: true, changed: false, status: "deferred-update-owner" }; }
  const repaired = [];
  try {
    const recovery = require("./mac-registration-transaction.cjs");
    const pending = recovery.readSnapshot({ homeDir, fsImpl });
    if (pending) {
      const current = (() => { try { return JSON.parse(fsImpl.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8")); } catch { return null; } })();
      if (current?.active === true && [pending.targetRoot, pending.previousRoot].includes(current.packageRoot)) recovery.clearSnapshot({ homeDir, fsImpl });
      else return await recovery.restoreSnapshot({ homeDir, run, fsImpl, userId });
    }
    // Read and validate both files under the updater's lock, before changing any
    // registration. They may describe a candidate while the journal is inactive.
    const records = LABELS.map(label => readRegistration(label, { homeDir, run, fsImpl }));
    if (records[0].packageRoot !== records[1].packageRoot) throw Error("mixed-service-targets");
    for (const record of records) {
      const observed = registration(record.label, { run, userId });
      if (!observed.known) throw Error(`service-registration-query-failed: ${record.label}`);
      if (observed.present && observed.pid && isAlive(observed.pid)) continue;
      const args = observed.present
        ? ["kickstart", `gui/${userId}/${record.label}`]
        : ["bootstrap", `gui/${userId}`, record.file];
      const result = run("/bin/launchctl", args);
      if (!commandOk(result)) throw Error(`service-registration-repair-failed: ${record.label}`);
      repaired.push(record.label);
      const after = registration(record.label, { run, userId });
      if (!after.known || !after.present) throw Error(`service-registration-not-restored: ${record.label}`);
    }
    return { ok: true, changed: repaired.length > 0, repaired, status: repaired.length ? "services-restored" : "services-present" };
  } catch (error) {
    return { ok: false, changed: repaired.length > 0, blocked: /^service-registration-/.test(error.message), repaired, status: "service-repair-failed", lastError: error.message };
  } finally { lock.release(); }
}

async function restartMacRegisteredServices(target, {
  homeDir = os.homedir(), run = defaultRun, userId = process.getuid?.() ?? 0,
  acquireLock = file => require("./relay-setup.cjs").acquireCanonicalLock(file),
  healthCheck = require("./runtime-health.cjs").exactRuntimeHealth,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let lock;
  try { lock = acquireLock(path.join(homeDir, ".relay", "runtime", "transaction.lock")); }
  catch { return { ok: false, reason: "deferred-update-owner" }; }
  try {
    const current = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8"));
    if (!current?.active || current.packageRoot !== target.packageRoot) return { ok: false, reason: "runtime-changed" };
    const records = LABELS.map(label => readRegistration(label, { homeDir, run }));
    if (records.some(r => r.packageRoot !== target.packageRoot)) return { ok: false, reason: "runtime-changed" };
    for (const record of records) {
      const observed = registration(record.label, { run, userId });
      if (!observed.known) return { ok: false, reason: "service-registration-query-failed" };
      const args = observed.present ? ["kickstart", "-k", `gui/${userId}/${record.label}`] : ["bootstrap", `gui/${userId}`, record.file];
      if (!commandOk(run("/bin/launchctl", args))) return { ok: false, reason: "service-restart-failed" };
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const health = await healthCheck(target, { platform: "darwin", run });
      if (health.ok) return { ok: true, health };
      await sleep(500);
    }
    return { ok: false, reason: "restarted-runtime-not-healthy" };
  } catch (error) { return { ok: false, reason: error.message }; }
  finally { lock.release(); }
}

module.exports = { LABELS, registration, readRegistration, repairMacServiceRegistrations, restartMacRegisteredServices };
