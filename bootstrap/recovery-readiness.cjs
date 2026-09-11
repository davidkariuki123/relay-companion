"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { exactRuntimeHealth } = require("./runtime-health.cjs");
const { registration, LABELS } = require("./mac-service-recovery.cjs");
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

async function waitForRecoveryReady({ homeDir = os.homedir(), platform = process.platform,
  target = null, after = 0, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  health = exactRuntimeHealth, inspect = registration, stableMs = 10_000, timeoutMs = 30_000,
  readCurrent = () => read(path.join(homeDir, ".relay", "runtime", "current.json")),
  readHeartbeat = () => read(path.join(homeDir, ".relay", "recovery", "daemon.json")),
} = {}) {
  const started = now();
  let since = null, identity = null, firstBeat = null, lastNow = started;
  // The attempt bound also terminates a faulty/frozen clock in injected hosts.
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / 1000); attempt++) {
    const at = now(), current = readCurrent(), beat = readHeartbeat();
    const live = current?.active === true && current.packageRoot && (!target ||
      (current.version === target.version && (!target.packageRoot || target.packageRoot === current.packageRoot)))
      ? await health(current, { platform }) : null;
    const jobs = platform === "darwin" ? LABELS.map(label => inspect(label)) : [];
    const jobsReady = platform !== "darwin" || (jobs.every(job => job.known && job.present && job.pid > 0) && jobs[0].pid === beat?.pid);
    const fresh = beat?.version === current?.version && Number.isSafeInteger(beat?.pid) && beat.pid > 0
      && Number.isFinite(beat.at) && beat.at >= after && beat.at <= at && at - beat.at < 15_000;
    const key = `${current?.packageRoot}:${beat?.pid}:${jobs[1]?.pid || "pill"}`;
    if (at < lastNow || at - lastNow > 5000 || !live?.ok || !jobsReady || !fresh || key !== identity) {
      since = null; firstBeat = null; identity = key;
    }
    if (live?.ok && jobsReady && fresh) {
      if (since === null) { since = at; firstBeat = beat.at; }
      if (at - since >= stableMs && beat.at > firstBeat) return { ok: true, current, heartbeatAt: beat.at };
    }
    lastNow = at;
    if (at - started >= timeoutMs) break;
    await sleep(1000);
  }
  return { ok: false, reason: "runtime-did-not-stay-responsive" };
}
module.exports = { waitForRecoveryReady };
