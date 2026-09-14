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
// The gap is the time this process spent NOT sampling: the sleep between
// samples, plus anything that suspended the process. Taking the sample itself
// is excluded, because on Windows one process-health sample is a PowerShell
// query that costs two to three seconds on a good laptop and more on a loaded
// two-core runner, and a probe that times out costs ten. Counting that time
// as a gap reset the stability window on every sample and called a healthy
// daemon unresponsive (2026-09-14, Windows x64 release gate). A sample that
// takes longer than SAMPLE_MAX_MS is still treated as a gap: a machine that
// suspended mid-sample cannot be told apart from a slow one, and the proof
// must not vouch for a runtime it did not watch continuously.
const SAMPLE_GAP_MAX_MS = 5000;
const SAMPLE_MAX_MS = 30_000;

async function waitForRecoveryReady({ homeDir = os.homedir(), platform = process.platform,
  target = null, after = 0, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  health = exactRuntimeHealth, inspect = registration, stableMs = 10_000, timeoutMs = 45_000,
  heartbeatFreshMs = HEARTBEAT_FRESH_MS, probeTimeoutMs = PROBE_TIMEOUT_MS,
  probe = require("./recovery-probe.cjs").probeRuntime,
  requireProgress = false,
  readCurrent = () => read(path.join(homeDir, ".relay", "runtime", "current.json")),
  readHeartbeat = () => read(path.join(homeDir, ".relay", "recovery", "daemon.json")),
} = {}) {
  const started = now();
  let since = null, identity = null, firstBeat = null, lastSampleEnd = started;
  let probeSeen = false, probeIdentity = null, legacy = false;
  let firstProgress = null, firstProgressAt = null, progressAdvanced = false;
  // Why the last sample did not count, for the log line a failed proof leaves.
  let block = null, samples = 0, slowestSampleMs = 0;
  const reset = (key) => { since = null; firstBeat = null; identity = key; probeSeen = false; probeIdentity = null; legacy = false; firstProgress = null; firstProgressAt = null; progressAdvanced = false; };
  const healthSummary = (value) => value ? JSON.stringify({ daemon: value.daemon, pill: value.pill, daemonCount: value.daemonCount, pillCount: value.pillCount, oldDaemon: value.oldDaemon, oldPill: value.oldPill, oldBroker: value.oldBroker }) : "null";
  const probeSummary = (value) => value?.reason || value?.daemon?.reason || value?.pill?.reason || "answer-did-not-match-the-live-processes";
  // The attempt bound also terminates a faulty/frozen clock in injected hosts.
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / 1000); attempt++) {
    const at = now(), current = readCurrent(), beat = readHeartbeat();
    const gap = at - lastSampleEnd;
    const live = current?.active === true && current.packageRoot && (!target ||
      (current.version === target.version && (!target.packageRoot || target.packageRoot === current.packageRoot)))
      ? await health(current, { platform }) : null;
    const jobs = platform === "darwin" ? LABELS.map(label => inspect(label)) : [];
    const responsive = live?.ok ? await probe(current, { homeDir, timeoutMs: probeTimeoutMs }) : { ok: false };
    const sampled = now(), sampleMs = sampled - at;
    samples += 1; slowestSampleMs = Math.max(slowestSampleMs, sampleMs);
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
    const suspended = gap < 0 || gap > SAMPLE_GAP_MAX_MS || sampleMs > SAMPLE_MAX_MS;
    if (suspended || !alive || key !== identity
      || (probeIdentityNow && probeIdentity && probeIdentityNow !== probeIdentity)) {
      block = suspended ? `not-watched-continuously:gap=${gap}ms,sample=${sampleMs}ms`
        : !live ? "runtime-pointer-not-active-for-target"
        : !live.ok ? `health:${healthSummary(live)}`
        : !jobsReady ? `launchd-jobs-not-matching-heartbeat:daemon=${jobs[0]?.pid || "missing"},pill=${jobs[1]?.pid || "missing"},heartbeat=${beat?.pid || "missing"}`
        : !fresh ? `heartbeat-stale:${beat?.at ? `${at - beat.at}ms old` : "missing"}`
        : key !== identity ? "process-identity-changed" : "probe-identity-changed";
      reset(key);
    }
    if (alive) {
      if (since === null) { since = at; firstBeat = beat.at; }
      if (probeMatches) {
        probeSeen = true;
        legacy = responsive.legacy === true;
        if (probeIdentityNow) probeIdentity = probeIdentityNow;
        const progress = responsive.daemon?.progress;
        if (Number.isSafeInteger(progress?.sequence) && progress.sequence > 0 && ["running", "offline", "signed-out"].includes(progress.phase) && Number.isFinite(progress.at)
          && progress.at >= after && progress.at <= sampled && sampled - progress.at < heartbeatFreshMs) {
          if (firstProgress === null) { firstProgress = progress.sequence; firstProgressAt = progress.at; }
          else if (progress.sequence > firstProgress && progress.at - firstProgressAt >= stableMs) progressAdvanced = true;
        }
      } else block = `probe:${probeSummary(responsive)}`;
      // New daemons prove real loop progress; legacy recovery remains possible
      // but cannot satisfy activation of a release requiring this capability.
      const progressRequired = requireProgress || firstProgress !== null
        || (current?.packageRoot && fs.existsSync(path.join(current.packageRoot, "bootstrap", "daemon-progress.cjs")));
      if (probeMatches && progressRequired && !progressAdvanced) block = "daemon-loop-not-advancing";
      if (at - since >= stableMs && beat.at > firstBeat && probeSeen && (!progressRequired || progressAdvanced)) {
        return { ok: true, current, heartbeatAt: beat.at,
          identity: legacy ? null : `${key}:${probeIdentity || "legacy"}`, legacy };
      }
      if (!block && at - since >= stableMs && !(beat.at > firstBeat)) block = "heartbeat-not-advancing";
    }
    lastSampleEnd = sampled;
    if (at - started >= timeoutMs) break;
    await sleep(1000);
  }
  return { ok: false, reason: "runtime-did-not-stay-responsive",
    detail: `${block || "no-sample"}; samples=${samples} slowestSampleMs=${slowestSampleMs} probeSeen=${probeSeen}` };
}
module.exports = { waitForRecoveryReady, HEARTBEAT_FRESH_MS, PROBE_TIMEOUT_MS, SAMPLE_GAP_MAX_MS, SAMPLE_MAX_MS };
