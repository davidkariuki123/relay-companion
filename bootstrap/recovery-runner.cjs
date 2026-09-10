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
const STALE_CONFIRM_MS = 4 * 60_000;
const MAX_IN_PLACE_RESTARTS = 2;
const RESTART_SETTLE_ATTEMPTS = 45;

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

async function recover({ homeDir = os.homedir(), env = process.env, now = Date.now, discoverImpl = discover,
  stage = stageVerifiedRuntime, run = execute, platform = process.platform, arch = process.arch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  health = require("./runtime-health.cjs").exactRuntimeHealth,
  restart = require("./runtime-health.cjs").restartInstalledRuntimeServices,
  memory = require("./runtime-health.cjs").memoryPressure } = {}) {
  const root = path.join(homeDir, ".relay");
  const stateFile = path.join(root, "recovery", "status.json");
  const configFile = env.RELAY_CONFIG || path.join(env.RELAY_CONFIG_DIR || root, "config.json");
  const config = read(configFile);
  // A missing/malformed config must not silently switch a developer to stable.
  if (!config) return { ok: false, status: "configuration-unavailable" };
  const channel = channelFrom(config, env);
  const previous = read(stateFile);
  const runId = env.RELAY_RECOVERY_RUN_ID || null;
  const log = recoveryLogger(root, runId, now);
  const status = (value) => {
    write(stateFile, { schema: 1, channel, runId, launcherVersion: require("../package.json").version, checkedAt: now(), lastSuccessAt: previous?.lastSuccessAt || null, ...value });
    log(`status=${value.status}${value.desiredVersion ? ` desired=${value.desiredVersion}` : ""}${value.lastError ? ` error=${value.lastError}` : ""}`);
    return value;
  };
  if (/^(0|false|off|no)$/i.test(String(env.RELAY_AUTO_UPDATE || "")) || read(path.join(root, "recovery", "policy.json"))?.autoUpdate === false) return status({ ok: true, status: "disabled" });
  let lock;
  try { lock = require("./relay-setup.cjs").acquireCanonicalLock(path.join(root, "recovery", "run.lock")); }
  catch (error) { return { ok: false, status: "recovery-lock-unavailable", lastError: error.message }; }
  const downloads = path.join(root, "recovery", "downloads");
  let staged = null;
  let discoveryError = null;
  let desiredVersion = null;
  let current = null;
  try {
    sweepAbandonedDownloads(downloads, log);
    // Discovery still comes first, but an unreachable registry no longer blocks
    // the local rungs: a dead daemon with the right code on disk needs a restart,
    // not a network connection.
    try { desiredVersion = await discoverImpl(channel); log(`discovered ${desiredVersion} on ${channel}`); }
    catch (error) { discoveryError = error; log(`discovery failed: ${error.message}`); }
    current = read(path.join(root, "runtime", "current.json"));
    if (desiredVersion && current?.active && compare(desiredVersion, current.version) === -1) return status({ ok: true, status: "ahead", desiredVersion });
    const heartbeat = read(path.join(root, "recovery", "daemon.json"));
    const heartbeatFresh = heartbeat?.at <= now() && now() - heartbeat.at < HEARTBEAT_MS;
    const installedIsDesired = current?.active === true && (!desiredVersion || current.version === desiredVersion);
    const live = installedIsDesired ? health(current, { platform }) : null;
    if (installedIsDesired && heartbeatFresh && heartbeat.version === current.version && live.ok) {
      return status({ ok: true, status: "current", desiredVersion: desiredVersion || current.version, lastSuccessAt: previous?.lastSuccessAt || now() });
    }
    const memoryNow = memory();
    // Repair progress for the installed version survives every later status
    // write (a memory deferral, a busy lease, a download failure). Losing it
    // would restart the ladder from the top on the next check.
    const repairState = {};
    if (installedIsDesired) {
      repairState.version = current.version;
      const sameTarget = previous?.version === current.version;
      repairState.restarts = sameTarget ? Number(previous.restarts) || 0 : 0;
      repairState.staleSince = sameTarget && Number.isFinite(previous.staleSince) && previous.staleSince <= now() ? previous.staleSince : now();
    }
    if (installedIsDesired) {
      // The code on disk is the code we want; the problem is liveness. Repair in
      // place before touching the network: restart, then re-activate from disk.
      const { version, restarts, staleSince } = repairState;
      const daemonAlive = Number(live?.daemonCount) >= 1;
      const base = { desiredVersion: desiredVersion || version, version, staleSince, restarts, discoveryError: discoveryError ? String(discoveryError.message).slice(0, 300) : undefined,
        memoryFreeMB: memoryNow.freeMB };
      log(`installed ${version} not healthy: heartbeatFresh=${heartbeatFresh} daemonAlive=${daemonAlive} health=${JSON.stringify({ daemon: live?.daemon, pill: live?.pill, oldDaemon: live?.oldDaemon, oldPill: live?.oldPill })} memoryPressured=${memoryNow.pressured}`);
      if (daemonAlive && now() - staleSince < STALE_CONFIRM_MS) return status({ ok: true, status: "stale-observed", ...base });
      const busy = busyDecision(heartbeat, { homeDir, now: now() });
      if (busy) return status({ ok: true, status: busy, ...base });
      if (restarts < MAX_IN_PLACE_RESTARTS) {
        status({ ok: true, status: "restarting", ...base, restarts: restarts + 1 });
        const restartedAt = now();
        let outcome;
        try { outcome = await restart(current, { platform }); }
        catch (error) { outcome = { ok: false, reason: error.message }; }
        log(`restart ${outcome?.ok ? "ok" : `failed: ${outcome?.reason || "unknown"}`} terminated=${JSON.stringify(outcome?.terminated || [])}`);
        let responding = false;
        for (let attempt = 0; outcome?.ok && attempt < RESTART_SETTLE_ATTEMPTS; attempt++) {
          const response = read(path.join(root, "recovery", "daemon.json"));
          responding = response?.version === version && response.at >= restartedAt && response.at <= now() && now() - response.at < HEARTBEAT_MS;
          if (responding) break;
          await sleep(1000);
        }
        if (responding && health(current, { platform }).ok) {
          return status({ ok: true, status: "current", desiredVersion: base.desiredVersion, version, repair: "restart", restarts: 0, lastSuccessAt: now(), failures: 0 });
        }
        return status({ ok: false, status: "restart-failed", ...base, restarts: restarts + 1,
          lastError: outcome?.ok ? "restarted-daemon-not-responding" : String(outcome?.reason || "restart-failed").slice(0, 300) });
      }
      // Two restarts did not bring it back. Re-activate the release already on
      // disk: same verified tree, no download. Only then does the network rung run.
      const entry = path.join(current.packageRoot || "", "src", "recovery-entry.js");
      if (current.packageRoot && fs.existsSync(entry) && previous?.status !== "reactivate-failed" && !memoryNow.pressured) {
        status({ ok: true, status: "reactivating", ...base });
        const activationAt = now();
        try {
          await run(process.execPath, entry, [version, channel], { env: { ...env, RELAY_RECOVERY_WORKER: "1" } });
          const active = read(path.join(root, "runtime", "current.json"));
          if (!active?.active || active.version !== version || !health(active, { platform }).ok) throw new Error("reactivated-runtime-not-healthy");
          let responding = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            const response = read(path.join(root, "recovery", "daemon.json"));
            responding = response?.version === version && response.at >= activationAt && response.at <= now() && now() - response.at < HEARTBEAT_MS;
            if (responding) break;
            await sleep(1000);
          }
          if (!responding) throw new Error("reactivated-daemon-not-responding");
          return status({ ok: true, status: "current", desiredVersion: base.desiredVersion, version, repair: "reactivate", restarts: 0, lastSuccessAt: now(), failures: 0 });
        } catch (error) {
          log(`reactivate failed: ${error.message}`);
          status({ ok: false, status: "reactivate-failed", ...base, lastError: String(error.message).slice(0, 300) });
          // Fall through to the download rung below.
        }
      }
    }
    if (discoveryError) throw discoveryError;
    const busy = busyDecision(heartbeat, { homeDir, now: now() });
    if (busy) return status({ ok: true, status: busy, desiredVersion, ...repairState });
    if (previous?.desiredVersion === desiredVersion && previous.retryAt > now()) return status({ ok: false, status: "backoff", desiredVersion, ...repairState,
      failures: previous.failures, retryAt: previous.retryAt, lastError: previous.lastError });
    // Downloading and extracting a runtime on a starved machine made the outage
    // longer last time. Wait for memory to come back; the restart rungs above
    // already ran, and the next check is five minutes away.
    if (memoryNow.pressured) return status({ ok: true, status: "deferred-memory-pressure", desiredVersion, ...repairState, memoryFreeMB: memoryNow.freeMB });
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
    await run(process.execPath, entry, [desiredVersion, channel], { env: { ...env, RELAY_RECOVERY_WORKER: "1" } });
    const active = read(path.join(root, "runtime", "current.json"));
    if (!active?.active || active.version !== desiredVersion || !health(active, { platform }).ok) throw new Error("replacement-not-healthy");
    let responding = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = read(path.join(root, "recovery", "daemon.json"));
      responding = response?.version === desiredVersion && response.at >= activationAt && response.at <= now() && now() - response.at < HEARTBEAT_MS;
      if (responding) break;
      await sleep(1000);
    }
    if (!responding) throw new Error("replacement-daemon-not-responding");
    return status({ ok: true, status: "current", desiredVersion, version: desiredVersion, repair: "download", restarts: 0, lastSuccessAt: now(), failures: 0 });
  } catch (error) {
    const activeStatus = read(stateFile);
    const failures = previous && previous.desiredVersion === activeStatus?.desiredVersion ? (previous.failures || 0) + 1 : 1;
    return status({ ok: false, status: "failed", desiredVersion: activeStatus?.desiredVersion || null, version: current?.version,
      restarts: activeStatus?.restarts, staleSince: activeStatus?.staleSince,
      failures, lastError: String(error.message).slice(0, 300), retryAt: now() + Math.min(60 * 60_000, CHECK_MS * 2 ** Math.min(failures - 1, 4)) });
  } finally {
    // Only our fresh UUID directory; never remove a canonical or rollback release.
    try { if (staged && path.dirname(staged) === downloads) fs.rmSync(staged, { recursive: true, force: true }); }
    finally { lock.release(); }
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
