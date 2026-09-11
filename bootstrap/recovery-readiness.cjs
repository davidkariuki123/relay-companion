"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { exactRuntimeHealth } = require("./runtime-health.cjs");
const { registration, LABELS } = require("./mac-service-recovery.cjs");
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// What "ready" means here is "alive and doing its job", not "never pauses".
// A daemon that spends twenty seconds on a large local sweep is slow, not
// dead: its process is present, its heartbeat is only seconds old, and it
// answers the probe as soon as the sweep ends. Restarting it for that costs
// the person their Companion for no reason. The proof therefore tolerates
// stalls shorter than the heartbeat window and probe answers that arrive
// late, and rejects only what a dead or wedged runtime cannot do: keep its
// process alive, advance its heartbeat, and answer the probe at least once.
const HEARTBEAT_FRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const SAMPLE_GAP_MAX_MS = 5000;

async function waitForRecoveryReady({ homeDir = os.homedir(), platform = process.platform,
  target = null, after = 0, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  health = exactRuntimeHealth, inspect = registration, stableMs = 10_000, timeoutMs = 45_000,
  heartbeatFreshMs = HEARTBEAT_FRESH_MS, probeTimeoutMs = PROBE_TIMEOUT_MS,
  probe = require("./recovery-probe.cjs").probeRuntime,
  readCurrent = () => read(path.join(homeDir, ".relay", "runtime", "current.json")),
  readHeartbeat = () => read(path.join(homeDir, ".relay", "recovery", "daemon.json")),
} = {}) {
  const started = now();
  let since = null, identity = null, firstBeat = null, lastNow = started;
  let probeSeen = false, probeIdentity = null, legacy = false;
  const reset = (key) => { since = null; firstBeat = null; identity = key; probeSeen = false; probeIdentity = null; legacy = false; };
  // The attempt bound also terminates a faulty/frozen clock in injected hosts.
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / 1000); attempt++) {
    const at = now(), current = readCurrent(), beat = readHeartbeat();
    const live = current?.active === true && current.packageRoot && (!target ||
      (current.version === target.version && (!target.packageRoot || target.packageRoot === current.packageRoot)))
      ? await health(current, { platform }) : null;
    const jobs = platform === "darwin" ? LABELS.map(label => inspect(label)) : [];
    const responsive = live?.ok ? await probe(current, { homeDir, timeoutMs: probeTimeoutMs }) : { ok: false };
    const jobsReady = platform !== "darwin" || (jobs.every(job => job.known && job.present && job.pid > 0) && jobs[0].pid === beat?.pid);
    const fresh = beat?.version === current?.version && Number.isSafeInteger(beat?.pid) && beat.pid > 0
      && Number.isFinite(beat.at) && beat.at >= after && beat.at <= at && at - beat.at < heartbeatFreshMs;
    const probeMatches = responsive.ok && (responsive.legacy || (responsive.daemon?.pid === beat?.pid
      && (platform !== "darwin" || responsive.pill?.pid === jobs[1]?.pid)));
    // Identity is the process set, not the probe answer: a probe that times out
    // during a stall must not look like a different runtime.
    const key = `${current?.packageRoot}:${beat?.pid}:${jobs[1]?.pid || "pill"}`;
    const alive = Boolean(live?.ok) && jobsReady && fresh;
    const probeIdentityNow = probeMatches && !responsive.legacy ? responsive.identity || null : null;
    if (at < lastNow || at - lastNow > SAMPLE_GAP_MAX_MS || !alive || key !== identity
      || (probeIdentityNow && probeIdentity && probeIdentityNow !== probeIdentity)) {
      reset(key);
    }
    if (alive) {
      if (since === null) { since = at; firstBeat = beat.at; }
      if (probeMatches) {
        probeSeen = true;
        legacy = responsive.legacy === true;
        if (probeIdentityNow) probeIdentity = probeIdentityNow;
      }
      if (at - since >= stableMs && beat.at > firstBeat && probeSeen) {
        return { ok: true, current, heartbeatAt: beat.at,
          identity: legacy ? null : `${key}:${probeIdentity || "legacy"}`, legacy };
      }
    }
    lastNow = at;
    if (at - started >= timeoutMs) break;
    await sleep(1000);
  }
  return { ok: false, reason: "runtime-did-not-stay-responsive" };
}
module.exports = { waitForRecoveryReady, HEARTBEAT_FRESH_MS, PROBE_TIMEOUT_MS };
