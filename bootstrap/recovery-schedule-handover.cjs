"use strict";
// A launchd job cannot reload itself without killing its installer. This small
// independent worker waits for the old controller, owns its exclusion locks,
// and restores the previous plist if the new schedule cannot be loaded.
const fs = require("node:fs"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const io = require("./recovery-launcher.cjs");
async function handover({ homeDir, userId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  run = (file, args) => spawnSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true }), attempts = 360 } = {}) {
  const root = path.join(homeDir, ".relay", "recovery");
  const label = "work.relay.companion.recovery", domain = `gui/${userId}`;
  const plist = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const previous = path.join(root, "scheduler-previous.plist");
  const ok = r => !r?.error && r?.status === 0;
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
module.exports = { handover };
if (require.main === module) handover({ homeDir: process.argv[2], userId: Number(process.argv[3]) }).then(result => {
  console.log(JSON.stringify(result));
  // launchctl submit restarts nonzero exits; a failed migration must be bounded.
}).catch(error => { console.error(error.message); });
