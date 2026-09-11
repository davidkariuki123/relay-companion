"use strict";

// This file and its bootstrap dependencies live outside the application tree.
// No application imports, npm, credentials, or messaging API are needed to heal it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { stageVerifiedRuntime, releasePlatform } = require("./relay-setup.cjs");
const { verifyReleaseEnvelope } = require("./release-signature.cjs");
const trust = require("./trust.json");
const CHECK_MS = 5 * 60_000;
const DEADLINE_MS = 25 * 60_000;
const HEARTBEAT_MS = 60_000;
const BUSY_GRACE_MS = 15 * 60_000;

function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function compare(a, b) {
  if (!/^\d+\.\d+\.\d+$/.test(a || "") || !/^\d+\.\d+\.\d+$/.test(b || "")) return null;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
async function discover(channel, { fetchImpl = fetch, trustStore = trust } = {}) {
  let version;
  if (channel !== "stable") {
    const response = await fetchImpl("https://registry.npmjs.org/-/package/relay-companion/dist-tags", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`channel-discovery-http-${response.status}`);
    version = (await response.json())[channel];
    if (compare(version, "0.0.0") !== 1) throw new Error("channel-version-invalid");
  }
  const route = version ? `v${version}` : "stable";
  const response = await fetchImpl(`https://api.sendrelays.com/v1/companion-releases/${route}/manifest.json?recovery=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`manifest-http-${response.status}`);
  const envelope = await response.json();
  const payload = JSON.parse(verifyReleaseEnvelope(envelope, trustStore).toString("utf8"));
  if (payload.product !== "Relay" || compare(payload.version, "0.0.0") !== 1 || (version && version !== payload.version)) throw new Error("release-identity-invalid");
  return payload.version;
}
function busyLease(heartbeat, now = Date.now()) {
  return Boolean(heartbeat && heartbeat.busy === true && Number.isFinite(heartbeat.at) && now >= heartbeat.at && now - heartbeat.at < HEARTBEAT_MS);
}
function busyDecision(heartbeat, { homeDir = os.homedir(), now = Date.now() } = {}) {
  const file = path.join(homeDir, ".relay", "recovery", "busy.json");
  if (!busyLease(heartbeat, now)) { try { fs.rmSync(file, { force: true }); } catch {} return null; }
  const previous = read(file);
  const since = previous && previous.pid === heartbeat.pid && Number.isFinite(previous.since) && previous.since <= now ? previous.since : now;
  write(file, { pid: heartbeat.pid, since });
  if (now - since < BUSY_GRACE_MS) return "deferred-busy";
  // Older daemons do not protect their owned turns with independent leases.
  // Never mistake missing instrumentation for permission to interrupt them.
  if (heartbeat.activityVersion !== 1) return "deferred-unverified-work";
  const active = require("./update-activity.cjs").activeCalls({ homeDir });
  if (active === null || active > 0) return "deferred-active-work";
  // The canonical activation still closes admission and drains again, covering
  // real work beginning after this observation. Only the summary bit is ignored.
  return null;
}
function channelFrom(config, env = process.env) {
  const value = env.RELAY_UPDATE_CHANNEL || config?.updateChannel || "stable";
  if (!["stable", "dev", "staging"].includes(value)) throw new Error("unknown-update-channel");
  return value;
}

function terminateChildTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000, stdio: "ignore" });
    return;
  }
  // Nested recovery workers may lead their own process groups. Include those
  // descendants before terminating the original group so none escape its deadline.
  const rows = spawnSync("/bin/ps", ["-axo", "uid=,pid=,ppid="], { encoding: "utf8", timeout: 5000 });
  const descendants = new Set([child.pid]);
  if (rows.status === 0) {
    const processes = String(rows.stdout).split("\n").map(line => line.trim().split(/\s+/).map(Number))
      .filter(([uid, pid]) => uid === process.getuid() && Number.isSafeInteger(pid));
    let changed;
    do { changed = false; for (const [, pid, parent] of processes) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; } } while (changed);
  }
  for (const pid of [...descendants].reverse()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

// A child that owns the transaction has a parent-enforced deadline. Never free
// the transaction lock on a timeout: the engine reclaims it only after owner death.
function execute(node, entry, args, { timeoutMs = DEADLINE_MS, spawnImpl = spawn, env = process.env, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(node, [entry, ...args], { stdio, windowsHide: true, detached: process.platform !== "win32", env });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      terminateChildTree(child);
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error("recovery-worker-deadline-exceeded"));
      else if (code !== 0) reject(new Error(`recovery-worker-exit-${code}`));
      else resolve({ ok: true });
    });
  });
}

// A stale daemon heartbeat has two very different causes: a dead or wedged
// daemon, or a machine so starved that a healthy daemon missed a few ticks.
// Only a heartbeat that stays stale across two scheduled checks proves the
// former while the process is still alive. A missing process needs no second look.
// Ten minutes, two scheduled checks apart: a daemon whose process is present
// and whose heartbeat was recent is far more often slow than dead, and every
// false restart takes the person's Companion away with it.
const STALE_CONFIRM_MS = 10 * 60_000;
const MAX_IN_PLACE_RESTARTS = 2;

// A runner killed mid-extraction by the launcher's deadline leaves its staged
// tree behind. The next runner owns the recovery lock, so anything still in
// downloads is abandoned by definition.
function sweepAbandonedDownloads(downloads, log = () => {}) {
  let names;
  try { names = fs.readdirSync(downloads); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) && !name.startsWith(".relay-download-")) continue;
    try { fs.rmSync(path.join(downloads, name), { recursive: true, force: true }); removed += 1; } catch {}
  }
  if (removed) log(`swept ${removed} abandoned download(s)`);
  return removed;
}

function recoveryLogger(root, runId, now) {
  const { appendRecoveryLog } = require("./recovery-launcher.cjs");
  const started = now();
  return (line) => appendRecoveryLog(path.join(root, "recovery"), `runner run=${runId || "-"} +${now() - started}ms ${line}`, now);
}

async function recover(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  let lock;
  try { lock = require("./relay-setup.cjs").acquireCanonicalLock(path.join(homeDir, ".relay", "recovery", "run.lock")); }
  catch (error) { return { ok: false, status: "recovery-lock-unavailable", lastError: error.message }; }
  try { return await recoverLocked(options); } finally { lock.release(); }
}

async function recoverLocked({ homeDir = os.homedir(), env = process.env, now = Date.now, discoverImpl = discover,
  stage = stageVerifiedRuntime, run = execute, platform = process.platform, arch = process.arch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  health = require("./runtime-health.cjs").exactRuntimeHealth,
  restart = require("./runtime-health.cjs").restartInstalledRuntimeServices,
  memory = require("./runtime-health.cjs").memoryPressure,
  verifyReady = require("./recovery-readiness.cjs").waitForRecoveryReady,
  policyFactory = require("./recovery-policy.cjs").recoveryPolicy,
  validateLocal = require("./recovery-local.cjs").validateLocalRuntime,
  repairServices = require("./mac-service-recovery.cjs").repairMacServiceRegistrations } = {}) {
  const root = path.join(homeDir, ".relay");
  // Local availability is independent of update eligibility, network, memory,
  // and the journal's active flag. This helper shares the activation lock.
  let progress, reservedService;
  try {
    progress = require("./recovery-progress.cjs").repairProgress(homeDir, now);
    reservedService = progress.claim("services", 2);
  } catch (error) {
    // Bookkeeping failure must not suppress the minimal availability repair.
    const repaired = await repairServices({ homeDir, platform });
    return { ...repaired, ok: false, status: "repair-progress-unavailable", runtimeHealthy: false, lastError: error.message };
  }
  let services;
  try { services = await repairServices({ homeDir, platform }); }
  catch (error) { services = { ok: false, status: "service-repair-failed", lastError: error.message }; }
  if (reservedService && (services.status === "deferred-update-owner" || (services.ok && !services.changed))) progress.refund("services");
  const ready = (target = null, after = 0) => verifyReady({ homeDir, platform, target, after, now, sleep, health });
  const rememberReady = observed => {
    const active = observed?.current || read(path.join(root, "runtime", "current.json"));
    const probation = policy.observe(channel, { ...observed, current: active });
    if (!probation.proven) return probation;
    progress.reset();
    if (active?.active && active.packageRoot) {
      const goodFile = path.join(root, "recovery", "runtime-good.json");
      const old = read(goodFile);
      if (old?.packageRoot && old.packageRoot !== active.packageRoot) write(path.join(root, "recovery", "runtime-previous-good.json"), old);
      write(goodFile, { ...active, channel });
    }
    return probation;
  };
  const proven = (value, observed) => { const probation = rememberReady(observed); return status({ ...value, runtimeHealthy: !observed.legacy, runtimeAvailable: true, runtimeProven: probation.proven, probationRemainingMs: probation.remainingMs }); };
  const stateFile = path.join(root, "recovery", "status.json");
  const configFile = env.RELAY_CONFIG || path.join(env.RELAY_CONFIG_DIR || root, "config.json");
  const recoveredConfig = require("./recovery-config.cjs").loadRecoveryConfig(configFile);
  const config = recoveredConfig.config;
  // A missing/malformed config must not silently switch a developer to stable.
  if (!config) return { ok: false, status: "configuration-unavailable" };
  const channel = channelFrom(config, env);
  const policy = policyFactory({ root: path.join(root, "recovery"), now });
  const previous = read(stateFile);
  const runId = env.RELAY_RECOVERY_RUN_ID || null;
  const log = recoveryLogger(root, runId, now);
  if (recoveredConfig.restored) log("restored recovery settings from validated local copy");
  const status = (value) => {
    write(stateFile, { schema: 1, channel, runId, launcherVersion: require("../package.json").version, checkedAt: now(), lastSuccessAt: previous?.lastSuccessAt || null, ...value });
    log(`status=${value.status}${value.desiredVersion ? ` desired=${value.desiredVersion}` : ""}${value.lastError ? ` error=${value.lastError}` : ""}`);
    return value;
  };
  if (services.status === "deferred-update-owner") return status({ ...services, runtimeHealthy: false });
  if (services.changed || !services.ok) {
    const observed = await ready();
    if (observed.ok) return proven({ ok: true, status: "current", version: observed.current?.version, repair: "services", lastSuccessAt: now() }, observed);
    policy.interrupt();
    progress.fail(services.lastError || observed.reason);
    if (progress.count("services") < 2 && !progress.exhausted) return status({ ...services, ok: false, status: "service-repair-unhealthy", runtimeHealthy: false });
    // Accepted commands are not recovery. Repeated failure advances even when
    // an inactive journal or unusable registration snapshot is still present.
  }
  if (/^(0|false|off|no)$/i.test(String(env.RELAY_AUTO_UPDATE || "")) || read(path.join(root, "recovery", "policy.json"))?.autoUpdate === false) return status({ ok: true, status: "disabled" });
  const downloads = path.join(root, "recovery", "downloads");
  let staged = null;
  let discoveryError = null;
  let desiredVersion = null;
  let current = null;
  let runtimeResponsive = false;
  let runtimeVerified = false;
  try {
    sweepAbandonedDownloads(downloads, log);
    // Discovery still comes first, but an unreachable registry no longer blocks
    // the local rungs: a dead daemon with the right code on disk needs a restart,
    // not a network connection.
    try { desiredVersion = await discoverImpl(channel); log(`discovered ${desiredVersion} on ${channel}`); }
    catch (error) { discoveryError = error; log(`discovery failed: ${error.message}`); }
    current = read(path.join(root, "runtime", "current.json"));
    const heartbeat = read(path.join(root, "recovery", "daemon.json"));
    const heartbeatFresh = heartbeat?.at <= now() && now() - heartbeat.at < HEARTBEAT_MS;
    const installedIsDesired = current?.active === true;
    const live = installedIsDesired ? await health(current, { platform }) : null;
    if (live && platform === "darwin" && !services.ok) live.ok = false;
    if (installedIsDesired && heartbeatFresh && heartbeat.version === current.version && live.ok) {
      const observed = await ready(current);
      if (observed.ok) {
        runtimeResponsive = true;
        runtimeVerified = !observed.legacy;
        if (!desiredVersion || compare(current.version, desiredVersion) >= 0) return proven({ ok: true, status: current.version === desiredVersion || !desiredVersion ? "current" : "ahead", desiredVersion: desiredVersion || current.version, lastSuccessAt: previous?.lastSuccessAt || now() }, observed);
        const probation = rememberReady(observed);
        if (!probation.proven && !observed.legacy) return status({ ok: true, status: "probation", runtimeHealthy: true, runtimeProven: false, desiredVersion, version: current.version, probationRemainingMs: probation.remainingMs });
      } else { live.ok = false; policy.interrupt(); }
    }
    const memoryNow = memory();
    // Repair progress for the installed version survives every later status
    // write (a memory deferral, a busy lease, a download failure). Losing it
    // would restart the ladder from the top on the next check.
    const repairState = {};
    if (installedIsDesired) {
      repairState.version = current.version;
      const sameTarget = previous?.version === current.version;
      repairState.restarts = progress.count(`restart:${current.packageRoot || current.version}`);
      repairState.staleSince = sameTarget && Number.isFinite(previous.staleSince) && previous.staleSince <= now() ? previous.staleSince : now();
    }
    if (installedIsDesired && !(live.ok && heartbeatFresh && heartbeat.version === current.version)) {
      // The code on disk is the code we want; the problem is liveness. Repair in
      // place before touching the network: restart, then re-activate from disk.
      policy.interrupt();
      const { version, restarts, staleSince } = repairState;
      const daemonAlive = Number(live?.daemonCount) >= 1;
      const base = { desiredVersion: desiredVersion || version, version, staleSince, restarts, discoveryError: discoveryError ? String(discoveryError.message).slice(0, 300) : undefined,
        memoryFreeMB: memoryNow.freeMB };
      log(`installed ${version} not healthy: heartbeatFresh=${heartbeatFresh} daemonAlive=${daemonAlive} health=${JSON.stringify({ daemon: live?.daemon, pill: live?.pill, oldDaemon: live?.oldDaemon, oldPill: live?.oldPill })} memoryPressured=${memoryNow.pressured}`);
      if (daemonAlive && now() - staleSince < STALE_CONFIRM_MS) return status({ ok: true, status: "stale-observed", ...base });
      const busy = busyDecision(heartbeat, { homeDir, now: now() });
      if (busy) return status({ ok: true, status: busy, ...base });
      const restartKey = `restart:${current.packageRoot || current.version}`;
      if (progress.claim(restartKey, MAX_IN_PLACE_RESTARTS)) {
        status({ ok: true, status: "restarting", ...base, restarts: restarts + 1 });
        const restartedAt = now();
        let outcome;
        try { outcome = await restart(current, { platform, homeDir }); }
        catch (error) { outcome = { ok: false, reason: error.message }; }
        log(`restart ${outcome?.ok ? "ok" : `failed: ${outcome?.reason || "unknown"}`} terminated=${JSON.stringify(outcome?.terminated || [])}`);
        if (outcome?.reason === "deferred-update-owner" || outcome?.reason === "runtime-changed") {
          progress.refund(restartKey);
          return status({ ok: true, status: outcome.reason, runtimeHealthy: false, ...base });
        }
        const observed = outcome?.ok ? await ready(current, restartedAt) : null;
        if (observed?.ok) return proven({ ok: true, status: "current", desiredVersion: base.desiredVersion, version, repair: "restart", restarts: 0, lastSuccessAt: now(), failures: 0 }, observed);
        progress.fail(outcome?.reason || observed?.reason);
        return status({ ok: false, status: "restart-failed", ...base, restarts: restarts + 1,
          lastError: outcome?.ok ? "restarted-daemon-not-responding" : String(outcome?.reason || "restart-failed").slice(0, 300) });
      }
      policy.failure(channel, version, { id: `unhealthy:${current.packageRoot || version}:${heartbeat?.pid || "missing"}`, reason: "restart-budget-exhausted" });
      // Two restarts did not bring it back. Re-activate the release already on
      // disk: same verified tree, no download. Only then does the network rung run.
      const entry = path.join(current.packageRoot || "", "src", "recovery-entry.js");
      if (current.packageRoot && validateLocal(current, { platform, arch }) && progress.claim(`reactivate:${current.packageRoot}`, 1)) {
        status({ ok: true, status: "reactivating", ...base });
        const activationAt = now();
        try {
          await run(process.execPath, entry, [version, channel], { env: { ...env, RELAY_RECOVERY_WORKER: "1" } });
          const observed = await ready({ version }, activationAt);
          if (!observed.ok) throw new Error("reactivated-runtime-not-healthy");
          return proven({ ok: true, status: "current", desiredVersion: base.desiredVersion, version, repair: "reactivate", restarts: 0, lastSuccessAt: now(), failures: 0 }, observed);
        } catch (error) {
          progress.fail(error.message);
          log(`reactivate failed: ${error.message}`);
          status({ ok: false, status: "reactivate-failed", ...base, lastError: String(error.message).slice(0, 300) });
          // Fall through to the download rung below.
        }
      }
    }
    // Try a distinct, previously committed local release before requiring a
    // network download. Validation reads the tree without executing its imports.
    const failedCandidate = current?.active !== true ? current?.candidate : null;
    if (failedCandidate?.version) policy.failure(channel, failedCandidate.version, { id: `journal:${failedCandidate.packageRoot || failedCandidate.version}`, reason: "incomplete-update" });
    const good = read(path.join(root, "recovery", "runtime-good.json"));
    const olderGood = read(path.join(root, "recovery", "runtime-previous-good.json"));
    const alternatives = [good?.channel === channel ? good : null, olderGood?.channel === channel ? olderGood : null, current?.previous];
    const localBusy = busyDecision(read(path.join(root, "recovery", "daemon.json")), { homeDir, now: now() });
    if (!localBusy && (!installedIsDesired || !live?.ok || !heartbeatFresh)) for (const target of alternatives) {
      if (!target?.packageRoot || target.packageRoot === current?.packageRoot || policy.decision(channel, target.version).blocked || !validateLocal(target, { platform, arch }) || !progress.claim('local:' + target.packageRoot, 1)) continue;
      status({ ok: false, status: "restoring-local", desiredVersion, version: target.version, runtimeHealthy: false });
      try {
        const activationAt = now();
        await run(process.execPath, path.join(target.packageRoot, "src", "recovery-entry.js"), [target.version, channel], { env: { ...env, RELAY_RECOVERY_WORKER: "1" } });
        const observed = await ready({ version: target.version }, activationAt);
        if (!observed.ok) throw Error("local-runtime-not-healthy");
        return proven({ ok: true, status: "current", desiredVersion, version: target.version, repair: "local", lastSuccessAt: now(), failures: 0 }, observed);
      } catch (error) { progress.fail(error.message); log('local recovery failed: ' + error.message); }
    }
    if (discoveryError) throw discoveryError;
    let quarantine = policy.decision(channel, desiredVersion);
    if (quarantine.blocked && !runtimeResponsive) {
      // A signed re-download of a proven version can restore a missing local
      // backup without retrying the release that caused the outage.
      const fallback = [good, olderGood].find(target => target?.channel === channel && target.version !== desiredVersion && !policy.decision(channel, target.version).blocked);
      if (fallback) { desiredVersion = fallback.version; quarantine = policy.decision(channel, desiredVersion); }
    }
    if (quarantine.blocked) return status({ ok: true, status: "deferred-release-cooldown", desiredVersion, runtimeHealthy: runtimeVerified, runtimeAvailable: runtimeResponsive, retryAt: quarantine.retryAt, failures: quarantine.failures });
    const busy = busyDecision(heartbeat, { homeDir, now: now() });
    if (busy) return status({ ok: true, status: busy, desiredVersion, ...repairState });
    if (previous?.desiredVersion === desiredVersion && previous.retryAt > now()) return status({ ok: false, status: "backoff", desiredVersion, ...repairState,
      failures: previous.failures, retryAt: previous.retryAt, lastError: previous.lastError });
    // Ordinary upgrades wait for pressure to clear. An unavailable installation
    // can use the final recovery route at a bounded cadence after local repairs.
    if (memoryNow.pressured) {
      if (runtimeResponsive) return status({ ok: true, status: "deferred-memory-pressure", desiredVersion, ...repairState, memoryFreeMB: memoryNow.freeMB });
      const emergency = policy.emergency();
      if (!emergency.allowed) return status({ ok: false, status: "emergency-backoff", desiredVersion, runtimeHealthy: false, retryAt: emergency.retryAt });
      log("local recovery exhausted; allowing bounded emergency download despite memory pressure");
    }
    status({ ok: true, status: "downloading", desiredVersion, ...repairState });
    fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
    staged = path.join(downloads, crypto.randomUUID());
    const stageStarted = now();
    const candidate = await stage({ version: desiredVersion, platformKey: releasePlatform(platform, arch), destination: staged });
    log(`staged ${desiredVersion} in ${now() - stageStarted}ms`);
    // Recheck channel and active-work lease after a potentially lengthy download.
    const latestConfig = read(configFile);
    if (!latestConfig) throw new Error("configuration-unavailable");
    if (channelFrom(latestConfig, env) !== channel) return status({ ok: true, status: "channel-changed", desiredVersion });
    if (read(path.join(root, "recovery", "policy.json"))?.autoUpdate === false) return status({ ok: true, status: "disabled", desiredVersion });
    const stillBusy = busyDecision(read(path.join(root, "recovery", "daemon.json")), { homeDir, now: now() });
    if (stillBusy) return status({ ok: true, status: stillBusy, desiredVersion });
    const entry = path.join(candidate.packageRoot, "src", "recovery-entry.js");
    if (!fs.existsSync(entry)) throw new Error("candidate-missing-recovery-engine");
    status({ ok: true, status: "activating", desiredVersion, ...repairState });
    const activationAt = now();
    const attemptId = crypto.randomUUID();
    try {
      await run(process.execPath, entry, [desiredVersion, channel], { env: { ...env, RELAY_RECOVERY_WORKER: "1", RELAY_RECOVERY_ATTEMPT_ID: attemptId } });
      const observed = await ready({ version: desiredVersion }, activationAt);
      if (!observed.ok) throw new Error("replacement-not-healthy");
      return proven({ ok: true, status: "current", desiredVersion, version: desiredVersion, repair: "download", restarts: 0, lastSuccessAt: now(), failures: 0 }, observed);
    } catch (error) {
      policy.failure(channel, desiredVersion, { id: attemptId, reason: error.message });
      policy.interrupt();
      throw error;
    }
  } catch (error) {
    const activeStatus = read(stateFile);
    const failures = previous && previous.desiredVersion === activeStatus?.desiredVersion ? (previous.failures || 0) + 1 : 1;
    return status({ ok: false, status: "failed", desiredVersion: activeStatus?.desiredVersion || null, version: current?.version,
      restarts: activeStatus?.restarts, staleSince: activeStatus?.staleSince,
      failures, lastError: String(error.message).slice(0, 300), retryAt: now() + Math.min(60 * 60_000, CHECK_MS * 2 ** Math.min(failures - 1, 4)) });
  } finally {
    // Only our fresh UUID directory; never remove a canonical or rollback release.
    try { if (staged && path.dirname(staged) === downloads) fs.rmSync(staged, { recursive: true, force: true }); }
    catch {}
  }
}

module.exports = { recover, discover, busyLease, busyDecision, sweepAbandonedDownloads, BUSY_GRACE_MS, STALE_CONFIRM_MS, MAX_IN_PLACE_RESTARTS, channelFrom, compare, execute, read, write, CHECK_MS, DEADLINE_MS };
if (require.main === module) {
  if (process.argv.includes("--self-check")) {
    require("./release-signature.cjs").releaseKeys(trust);
    releasePlatform();
    if (typeof require("./runtime-health.cjs").exactRuntimeHealth !== "function") throw Error("recovery-health-unavailable");
    console.log("recovery-ready");
  } else recover().then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
