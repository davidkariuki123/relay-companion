"use strict";
// A launchd job cannot reload itself without killing its installer. This small
// independent worker waits for the old controller, owns its exclusion locks,
// and restores the previous plist if the new schedule cannot be loaded.
//
// It runs as a `launchctl submit` job, and submitted jobs are always KeepAlive:
// launchd respawns them after every exit, zero included. A handover that only
// returned stayed alive forever, re-bootstrapping the recovery job (RunAtLoad)
// every ten seconds, so recovery judged and repaired the runtime four times a
// minute (2026-09-23: 1,516 runs, seven self-inflicted restarts in a morning).
// Every terminal outcome therefore removes this job; the installer submits a
// fresh one if the schedule still needs handing over.
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const io = require("./recovery-launcher.cjs");
const HANDOVER_LABEL = "work.relay.recovery.schedule-handover";
const defaultRun = (file, args) => spawnSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
const ok = r => !r?.error && r?.status === 0;

async function attemptHandover({ homeDir, userId, sleep, run, attempts }) {
  const root = path.join(homeDir, ".relay", "recovery");
  const label = "work.relay.companion.recovery", domain = `gui/${userId}`;
  const plist = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const previous = path.join(root, "scheduler-previous.plist");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (require("./recovery-intent.cjs").stopped(homeDir)) return { ok: true, reason: "intentionally-stopped" };
    let release, runner, transaction;
    try {
      release = io.acquireLauncherLock(root);
      if (!release) continue;
      runner = io.acquireCanonicalLock(path.join(root, "run.lock"));
      transaction = io.acquireCanonicalLock(path.join(homeDir, ".relay", "runtime", "transaction.lock"));
      if (require("./recovery-intent.cjs").stopped(homeDir)) return { ok: true, reason: "intentionally-stopped" };
      // The old job is no longer running. Keep the old file until bootstrap is
      // proven; an interrupted handover remains repairable by the app/installer.
      const removed = run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
      if (!ok(removed)) throw Error("recovery-schedule-bootout-failed");
      const started = run("/bin/launchctl", ["bootstrap", domain, plist]);
      if (!ok(started)) {
        if (fs.existsSync(previous)) {
          require("./mac-registration-transaction.cjs").atomicFile(plist, fs.readFileSync(previous));
          run("/bin/launchctl", ["bootstrap", domain, plist]);
        }
        throw Error("recovery-schedule-bootstrap-failed");
      }
      io.write(path.join(root, "scheduler.json"), { schema: 1, intervalSeconds: 60, at: Date.now() });
      return { ok: true };
    } catch (error) {
      if (transaction) { io.write(path.join(root, "scheduler-error.json"), { at: Date.now(), error: error.message }); return { ok: false, reason: error.message }; }
    } finally {
      transaction?.release(); runner?.release(); release?.();
      // Sleep also on contention, without retaining any mutation authority.
      if (!transaction) await sleep(5000);
    }
  }
  return { ok: false, reason: "recovery-schedule-handover-deadline" };
}

async function handover({ homeDir, userId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  run = defaultRun, attempts = 360, report = result => console.log(JSON.stringify(result)) } = {}) {
  let result;
  try { result = await attemptHandover({ homeDir, userId, sleep, run, attempts }); }
  catch (error) { result = { ok: false, reason: error.message }; }
  // Report first: removing this job terminates the process that is running it.
  try { report(result); } catch {}
  run("/bin/launchctl", ["remove", HANDOVER_LABEL]);
  return result;
}

// A handover submitted by an older build never exits for good. Remove it once
// it is not mid-run; `launchctl list` reports a PID only while it executes.
function retireIdleHandover({ run = defaultRun } = {}) {
  const listed = run("/bin/launchctl", ["list", HANDOVER_LABEL]);
  if (!ok(listed)) return { removed: false, reason: "absent" };
  if (/"PID"\s*=\s*[1-9]\d*/.test(String(listed.stdout || ""))) return { removed: false, reason: "running" };
  return { removed: ok(run("/bin/launchctl", ["remove", HANDOVER_LABEL])), reason: "idle" };
}

// Retire only a handover whose work is visibly done: intent recorded and the
// loaded job on the 60 s cadence. A pending handover must keep its chance to run.
function retireFinishedHandover({ homeDir, userId = process.getuid?.() ?? 0, run = defaultRun } = {}) {
  if (io.read(path.join(homeDir, ".relay", "recovery", "scheduler.json"))?.intervalSeconds !== 60) return { removed: false, reason: "handover-pending" };
  const loaded = run("/bin/launchctl", ["print", `gui/${userId}/work.relay.companion.recovery`]);
  if (!ok(loaded) || Number(/run interval = (\d+) seconds/.exec(String(loaded.stdout || ""))?.[1]) !== 60) return { removed: false, reason: "handover-pending" };
  return retireIdleHandover({ run });
}

module.exports = { handover, retireIdleHandover, retireFinishedHandover, HANDOVER_LABEL };
if (require.main === module) handover({ homeDir: process.argv[2], userId: Number(process.argv[3]) })
  .catch(error => { console.error(error.message); });
