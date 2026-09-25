"use strict";
// launchctl submit is KeepAlive, including after exit 0. Re-entry must reconcile
// the loaded schedule, not replay bootout/bootstrap. Keep the independent job
// until a schedule is confirmed: the daemon may also be unavailable.
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const io = require("./recovery-launcher.cjs");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const HANDOVER_LABEL = "work.relay.recovery.schedule-handover";
const LABEL = "work.relay.companion.recovery";
const defaultRun = (file, args, options = {}) => spawnSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, ...options });
const ok = r => !r?.error && r?.status === 0;
const absent = r => !r?.error && (r?.status === 113 || /Could not find (?:specified )?service/i.test(String(r?.stderr || "")));

function loadedSchedule(run, userId) {
  const result = run("/bin/launchctl", ["print", `gui/${userId}/${LABEL}`]);
  const detail = String(result?.stdout || "");
  if (!ok(result)) return { known: absent(result), present: false };
  const interval = Number(/run interval = (\d+) seconds/.exec(detail)?.[1]);
  return { known: Number.isSafeInteger(interval) && interval > 0, present: true, interval, detail };
}

function readSchedule(file, homeDir, run) {
  const bytes = fs.readFileSync(file, "utf8");
  const result = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: bytes });
  if (!ok(result)) throw Error("recovery-schedule-invalid-plist");
  const value = JSON.parse(result.stdout);
  const args = value.ProgramArguments;
  if (value.Label !== LABEL || value.Program || !Array.isArray(args) || args.length !== 2
    || !args.every(x => typeof x === "string") || !path.isAbsolute(args[0])
    || args[1] !== path.join(homeDir, ".relay", "recovery", "launch.cjs")
    || !Number.isSafeInteger(value.StartInterval) || value.StartInterval <= 0) throw Error("recovery-schedule-invalid-target");
  return { bytes, args, interval: value.StartInterval };
}

function matches(loaded, plan) {
  return loaded.known && loaded.present && loaded.interval === plan.interval
    && plan.args.every(arg => loaded.detail.includes(arg));
}

function handoverJob(run) {
  const result = run("/bin/launchctl", ["list", HANDOVER_LABEL]);
  if (!ok(result)) return { known: absent(result), present: false };
  const detail = String(result.stdout || result.out || "");
  // A successful but unrecognizable response is not permission to remove a job.
  if (!/"Label"\s*=\s*"work\.relay\.recovery\.schedule-handover"/.test(detail)) return { known: false, present: true };
  const pid = /"PID"\s*=\s*(\d+)/.exec(detail);
  if (/"PID"/.test(detail) && !pid) return { known: false, present: true };
  return { known: true, present: true, pid: Number(pid?.[1]) || null };
}

function removeHandover(run, ownerPid = null) {
  const job = handoverJob(run);
  if (!job.known) return { removed: false, pending: true, reason: "query-unknown" };
  if (!job.present) return { removed: false, pending: false, reason: "absent" };
  if (ownerPid === null ? job.pid !== null : job.pid !== ownerPid) return { removed: false, pending: true, reason: "running" };
  const removed = run("/bin/launchctl", ["remove", HANDOVER_LABEL]);
  if (!ok(removed)) return { removed: false, pending: true, reason: "remove-failed" };
  // Self-removal may terminate us before this query. An external observer can
  // confirm absence later; the pre-removal record never claims cleanup finished.
  const after = handoverJob(run);
  if (!after.known || after.present) return { removed: false, pending: true, reason: "removal-unconfirmed" };
  return { removed: true, pending: false, reason: "idle" };
}

async function handover({ homeDir, userId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  run = defaultRun, attempts = 360, report = result => console.log(JSON.stringify(result)) } = {}) {
  const root = path.join(homeDir, ".relay", "recovery");
  const plist = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const previous = path.join(root, "scheduler-previous.plist");
  const record = result => {
    // Cleanup diagnostics must not turn a healthy schedule into failed runtime
    // installation, rollback, or another service restart.
    try { io.write(path.join(root, "scheduler-handover-status.json"), { at: Date.now(), ...result }); } catch {}
    try { report(result); } catch {}
  };
  const finish = (result, retire = false) => {
    result = { ...result, cleanup: { removed: false, pending: true, reason: retire ? "removal-pending" : "handover-pending" } };
    record(result);
    if (retire) {
      try { result.cleanup = removeHandover(run, process.pid); }
      catch (error) { result.cleanup = { removed: false, pending: true, reason: "remove-failed", detail: error.message }; }
      record(result);
    }
    return result;
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    let release, runner, transaction;
    try {
      release = io.acquireLauncherLock(root);
      if (!release) continue;
      runner = io.acquireCanonicalLock(path.join(root, "run.lock"));
      transaction = io.acquireCanonicalLock(path.join(homeDir, ".relay", "runtime", "transaction.lock"));
      // Retirement also happens under the existing lock order. The installer
      // cannot replace this job between the owner check and remove.
      const owner = handoverJob(run);
      if (!owner.known || !owner.present || owner.pid !== process.pid) return finish({ ok: false, reason: "handover-owner-unconfirmed" });
      if (require("./recovery-intent.cjs").stopped(homeDir)) return finish({ ok: true, reason: "intentionally-stopped" }, true);
      const plan = readSchedule(plist, homeDir, run);
      const loaded = loadedSchedule(run, userId);
      if (!loaded.known) return finish({ ok: false, reason: "recovery-schedule-query-unknown" });
      const confirmed = (target, reason) => {
        io.write(path.join(root, "scheduler.json"), { schema: 1, intervalSeconds: target.interval, at: Date.now() });
        return finish({ ok: target.interval === 60, recoveryAvailable: true, reason: target.interval === 60 ? reason : "previous-schedule-retained" }, true);
      };
      // Covers success followed by death before recording completion, and a
      // restored previous plist followed by failed handover-job removal.
      if (matches(loaded, plan)) return confirmed(plan, "already-current");
      if (loaded.present) {
        // Do not unload a registration with an unexpected interpreter/launcher.
        if (!plan.args.every(arg => loaded.detail.includes(arg))) return finish({ ok: false, reason: "recovery-schedule-target-unknown" });
        // An older installer can leave disk at 60 s while launchd still runs
        // 300 s. The installer may not see that race; this owner holds the
        // mutation locks and can create the missing escape path from the
        // verified target and the cadence it actually observed.
        if (!fs.existsSync(previous)) {
          const fallbackBytes = plan.bytes.replace(/(<key>StartInterval<\/key>\s*<integer>)\d+(<\/integer>)/,
            (_match, open, close) => `${open}${loaded.interval}${close}`);
          if (fallbackBytes === plan.bytes) return finish({ ok: false, reason: "recovery-schedule-fallback-unavailable" });
          atomicFile(previous, fallbackBytes);
        }
        // Validate the escape path before removing the currently loaded one.
        const fallback = readSchedule(previous, homeDir, run);
        if (!matches(loaded, fallback)) return finish({ ok: false, reason: "recovery-schedule-fallback-unconfirmed" });
        if (!ok(run("/bin/launchctl", ["bootout", `gui/${userId}/${LABEL}`]))) return finish({ ok: false, reason: "recovery-schedule-bootout-failed" });
      }
      // A crash after bootout resumes here, without failing a second bootout of
      // an already-absent service. No daemon or application import is needed.
      if (require("./recovery-intent.cjs").stopped(homeDir)) return finish({ ok: true, reason: "intentionally-stopped" }, true);
      run("/bin/launchctl", ["bootstrap", `gui/${userId}`, plist]);
      let after = loadedSchedule(run, userId);
      if (matches(after, plan)) return confirmed(plan, "schedule-loaded");
      // A failed/uncertain command can still have taken effect. Never overwrite
      // its file or attempt rollback while the loaded result remains unknown.
      if (!after.known || after.present) return finish({ ok: false, reason: "recovery-schedule-bootstrap-unconfirmed" });
      if (require("./recovery-intent.cjs").stopped(homeDir)) return finish({ ok: true, reason: "intentionally-stopped" }, true);
      const fallback = readSchedule(previous, homeDir, run);
      atomicFile(plist, fallback.bytes);
      run("/bin/launchctl", ["bootstrap", `gui/${userId}`, plist]);
      after = loadedSchedule(run, userId);
      if (matches(after, fallback)) return confirmed(fallback, "schedule-restored");
      return finish({ ok: false, reason: "recovery-schedule-restore-unconfirmed" });
    } catch (error) {
      if (transaction) return finish({ ok: false, reason: error.message });
    } finally {
      transaction?.release(); runner?.release(); release?.();
      if (!transaction) await sleep(5000);
    }
  }
  return finish({ ok: false, reason: "recovery-schedule-handover-deadline" });
}

function retireIdleHandover({ run = defaultRun } = {}) { return removeHandover(run); }

function retireFinishedHandover({ homeDir, userId = process.getuid?.() ?? 0, run = defaultRun } = {}) {
  if (io.read(path.join(homeDir, ".relay", "recovery", "scheduler.json"))?.intervalSeconds !== 60) return { removed: false, reason: "handover-pending" };
  // The runner already owns its run lock (and normally its parent owns the
  // launcher lock). Acquire only the next lock; never reacquire the outer ones.
  let transaction;
  try { transaction = io.acquireCanonicalLock(path.join(homeDir, ".relay", "runtime", "transaction.lock")); }
  catch { return { removed: false, pending: true, reason: "update-owner" }; }
  try {
    const loaded = loadedSchedule(run, userId);
    if (!loaded.known || !loaded.present || loaded.interval !== 60) return { removed: false, reason: "handover-pending" };
    return retireIdleHandover({ run });
  } finally { transaction.release(); }
}

module.exports = { handover, retireIdleHandover, retireFinishedHandover, HANDOVER_LABEL };
if (require.main === module) handover({ homeDir: process.argv[2], userId: Number(process.argv[3]) })
  .catch(error => { console.error(error.message); });
