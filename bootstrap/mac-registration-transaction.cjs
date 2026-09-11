"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { LABELS, registration, readRegistration } = require("./mac-service-recovery.cjs");
const defaultRun = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, windowsHide: true, ...options });
const snapshotPath = homeDir => path.join(homeDir, ".relay", "runtime", "mac-registrations.json");
const ok = r => Boolean(r && !r.error && r.status === 0);

function atomicFile(file, bytes, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); fsImpl.closeSync(fd); fd = undefined;
    fsImpl.renameSync(temporary, file);
    // macOS can flush a directory after rename. Keep this conditional for test
    // hosts (Windows cannot open directory handles through this API).
    if (process.platform !== "win32") {
      const directory = fsImpl.openSync(path.dirname(file), "r");
      try { fsImpl.fsyncSync(directory); } finally { fsImpl.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
    try { fsImpl.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function readSnapshot({ homeDir = os.homedir(), fsImpl = fs } = {}) {
  let bytes;
  try { bytes = fsImpl.readFileSync(snapshotPath(homeDir), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const value = JSON.parse(bytes);
  if (typeof value.targetRoot !== "string" || !Array.isArray(value.previous) ||
    !((value.schema === 1 && value.previous.length === 2) || (value.schema === 2 && value.previous.length === 0 && value.previousRoot === null))) throw Error("invalid-registration-snapshot");
  return value;
}

function clearSnapshot({ homeDir = os.homedir(), fsImpl = fs } = {}) {
  try { fsImpl.unlinkSync(snapshotPath(homeDir)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Caller owns runtime/transaction.lock. Capture before repair-runtime rewrites
// the files. The snapshot survives even a successful activation until the
// canonical pointer has committed; a crash in that gap must still roll back.
function prepareSnapshot(target, { homeDir = os.homedir(), fsImpl = fs, run = defaultRun, allowRebuildRegistrations = false } = {}) {
  try { return prepareExistingSnapshot(target, { homeDir, fsImpl, run }); }
  catch (error) {
    if (!allowRebuildRegistrations) throw error;
    // Only the verified recovery worker may proceed without a usable backup.
    // Save the original bytes before replacing the live marker. Failed evidence
    // writes abort activation; they must never silently discard the old record.
    const evidence = { schema: 1, reason: error.message, targetRoot: target.packageRoot, at: Date.now(), files: {} };
    for (const file of [snapshotPath(homeDir), ...LABELS.map(label => path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`))]) {
      try { evidence.files[file] = fsImpl.readFileSync(file, "utf8"); }
      catch (readError) { if (readError.code !== "ENOENT") throw readError; evidence.files[file] = null; }
    }
    const archived = path.join(homeDir, ".relay", "runtime", "recovery-history", `registrations-${crypto.randomUUID()}.json`);
    atomicFile(archived, JSON.stringify(evidence), fsImpl);
    const snapshot = { schema: 2, targetRoot: target.packageRoot, previousRoot: null, previous: [], evidence: archived, preparedAt: Date.now() };
    atomicFile(snapshotPath(homeDir), JSON.stringify(snapshot), fsImpl);
    return snapshot;
  }
}

function prepareExistingSnapshot(target, { homeDir, fsImpl, run }) {
  const pending = readSnapshot({ homeDir, fsImpl });
  if (pending) {
    const current = JSON.parse(fsImpl.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8"));
    const committed = current?.active ? current : current?.previous;
    if (![pending.targetRoot, pending.previousRoot].includes(committed?.packageRoot)) throw Error("registration-recovery-pending");
    // Keep the original evidence until the new snapshot is durably published.
  }
  const records = LABELS.map(label => readRegistration(label, { homeDir, fsImpl, run }));
  if (records[0].packageRoot !== records[1].packageRoot) throw Error("mixed-service-targets");
  let current;
  try { current = JSON.parse(fsImpl.readFileSync(path.join(homeDir, ".relay", "runtime", "current.json"), "utf8")); } catch {}
  const previous = current?.active ? current : current?.previous;
  if (previous?.packageRoot && previous.packageRoot !== records[0].packageRoot) throw Error("previous-registration-target-mismatch");
  const snapshot = { schema: 1, targetRoot: target.packageRoot, previousRoot: records[0].packageRoot,
    previous: records.map(({ label, bytes }) => ({ label, bytes })), preparedAt: Date.now() };
  atomicFile(snapshotPath(homeDir), JSON.stringify(snapshot), fsImpl);
  return snapshot;
}

async function restoreSnapshot({ homeDir = os.homedir(), fsImpl = fs, run = defaultRun,
  userId = process.getuid?.() ?? 0, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  expectedRoot, healthCheck,
} = {}) {
  let snapshot;
  try { snapshot = readSnapshot({ homeDir, fsImpl }); }
  catch (error) { return { ok: false, changed: false, status: "service-repair-failed", reason: "registration-snapshot-unusable", lastError: error.message }; }
  if (!snapshot || snapshot.schema === 2) return { ok: false, changed: false, status: "service-repair-failed", reason: "registration-snapshot-unusable" };
  const repaired = [], errors = [];
  let changed = false;
  try {
    const records = LABELS.map(label => {
      const saved = snapshot.previous.find(item => item.label === label);
      if (typeof saved?.bytes !== "string") throw Error("invalid-registration-snapshot");
      return readRegistration(label, { homeDir, fsImpl, run, contents: saved.bytes });
    });
    if (records.some(record => record.packageRoot !== snapshot.previousRoot) || (expectedRoot && expectedRoot !== snapshot.previousRoot)) throw Error("registration-snapshot-target-mismatch");
    // Restore both durable files first. Interruption here is replayed from the
    // intact snapshot; the application tree is never needed to regenerate them.
    for (const record of records) {
      let existing; try { existing = fsImpl.readFileSync(record.file, "utf8"); } catch {}
      if (existing !== record.bytes) { atomicFile(record.file, record.bytes, fsImpl); changed = true; }
    }
    for (const record of records) {
      try {
        let observed = registration(record.label, { run, userId });
        if (!observed.known) throw Error(`service-registration-query-failed: ${record.label}`);
        if (observed.present && !(observed.detail.includes(record.script) && observed.detail.includes(record.executable))) {
          changed = true;
          if (!ok(run("/bin/launchctl", ["bootout", `gui/${userId}/${record.label}`]))) throw Error(`service-restore-bootout-failed: ${record.label}`);
          for (let attempt = 0; attempt < 20; attempt++) {
            observed = registration(record.label, { run, userId });
            if (!observed.known || !observed.present) break;
            await sleep(250);
          }
          if (!observed.known || observed.present) throw Error(`service-restore-removal-pending: ${record.label}`);
        }
        if (!observed.present) {
          changed = true;
          if (!ok(run("/bin/launchctl", ["bootstrap", `gui/${userId}`, record.file]))) throw Error(`service-restore-bootstrap-failed: ${record.label}`);
        } else if (!observed.pid) {
          changed = true;
          if (!ok(run("/bin/launchctl", ["kickstart", `gui/${userId}/${record.label}`]))) throw Error(`service-restore-start-failed: ${record.label}`);
        }
        const after = registration(record.label, { run, userId });
        if (!after.known || !after.present) throw Error(`service-registration-not-restored: ${record.label}`);
        repaired.push(record.label);
      } catch (error) { errors.push(error.message); }
    }
    if (errors.length) throw Error(errors.join("; "));
    if (healthCheck) {
      const target = { packageRoot: records[0].packageRoot, bin: records[0].script };
      let healthy = false;
      let cleanedEscapedProcesses = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const health = await healthCheck(target, { platform: "darwin", run });
        if (health.ok) { healthy = true; break; }
        if (!cleanedEscapedProcesses && (health.oldDaemon || health.oldPill || health.oldBroker)) {
          // A detached candidate broker or pill can outlive launchd bootout.
          // Stop only other installed Relay roots, AFTER both registrations are
          // restored. A failed ps query here cannot erase the recovery route.
          const stopped = await require("./runtime-health.cjs").terminateInstalledServiceProcesses(target, { run, sleep });
          if (!stopped.ok) throw Error(stopped.reason);
          cleanedEscapedProcesses = true;
          for (const label of LABELS) run("/bin/launchctl", ["kickstart", `gui/${userId}/${label}`]);
        }
        await sleep(500);
      }
      if (!healthy) throw Error("restored-runtime-not-healthy");
    }
    // Retain the snapshot until the canonical journal has also been resolved.
    return { ok: true, changed, status: changed ? "services-restored" : "services-present", repaired, restoredRoot: snapshot.previousRoot };
  } catch (error) {
    return { ok: false, changed, blocked: true, status: "service-repair-failed", reason: "registration-restore-failed", lastError: error.message };
  }
}

module.exports = { atomicFile, snapshotPath, readSnapshot, clearSnapshot, prepareSnapshot, restoreSnapshot };
