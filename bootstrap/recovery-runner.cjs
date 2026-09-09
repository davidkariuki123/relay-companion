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

async function recover({ homeDir = os.homedir(), env = process.env, now = Date.now, discoverImpl = discover,
  stage = stageVerifiedRuntime, run = execute, platform = process.platform, arch = process.arch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  health = require("./runtime-health.cjs").exactRuntimeHealth } = {}) {
  const root = path.join(homeDir, ".relay");
  const stateFile = path.join(root, "recovery", "status.json");
  const configFile = env.RELAY_CONFIG || path.join(env.RELAY_CONFIG_DIR || root, "config.json");
  const config = read(configFile);
  // A missing/malformed config must not silently switch a developer to stable.
  if (!config) return { ok: false, status: "configuration-unavailable" };
  const channel = channelFrom(config, env);
  const previous = read(stateFile);
  const status = (value) => { write(stateFile, { schema: 1, channel, launcherVersion: require("../package.json").version, checkedAt: now(), lastSuccessAt: previous?.lastSuccessAt || null, ...value }); return value; };
  if (/^(0|false|off|no)$/i.test(String(env.RELAY_AUTO_UPDATE || "")) || read(path.join(root, "recovery", "policy.json"))?.autoUpdate === false) return status({ ok: true, status: "disabled" });
  let lock;
  try { lock = require("./relay-setup.cjs").acquireCanonicalLock(path.join(root, "recovery", "run.lock")); }
  catch (error) { return { ok: false, status: "recovery-lock-unavailable", lastError: error.message }; }
  let staged = null;
  try {
    // Discovery always precedes migration, recovery journals and retry backoff.
    const desiredVersion = await discoverImpl(channel);
    const current = read(path.join(root, "runtime", "current.json"));
    if (current?.active && compare(desiredVersion, current.version) === -1) return status({ ok: true, status: "ahead", desiredVersion });
    const heartbeat = read(path.join(root, "recovery", "daemon.json"));
    const heartbeatFresh = heartbeat?.at <= now() && now() - heartbeat.at < HEARTBEAT_MS;
    if (current?.active && current.version === desiredVersion && heartbeatFresh && heartbeat.version === desiredVersion && health(current, { platform }).ok) {
      return status({ ok: true, status: "current", desiredVersion, lastSuccessAt: previous?.lastSuccessAt || now() });
    }
    if (busyLease(heartbeat, now())) return status({ ok: true, status: "deferred-busy", desiredVersion });
    if (previous?.desiredVersion === desiredVersion && previous.retryAt > now()) return { ...previous, status: "backoff" };
    status({ ok: true, status: "downloading", desiredVersion });
    const downloads = path.join(root, "recovery", "downloads");
    fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
    staged = path.join(downloads, crypto.randomUUID());
    const candidate = await stage({ version: desiredVersion, platformKey: releasePlatform(platform, arch), destination: staged });
    // Recheck channel and active-work lease after a potentially lengthy download.
    const latestConfig = read(configFile);
    if (!latestConfig) throw new Error("configuration-unavailable");
    if (channelFrom(latestConfig, env) !== channel) return status({ ok: true, status: "channel-changed", desiredVersion });
    if (read(path.join(root, "recovery", "policy.json"))?.autoUpdate === false) return status({ ok: true, status: "disabled", desiredVersion });
    if (busyLease(read(path.join(root, "recovery", "daemon.json")), now())) return status({ ok: true, status: "deferred-busy", desiredVersion });
    const entry = path.join(candidate.packageRoot, "src", "recovery-entry.js");
    if (!fs.existsSync(entry)) throw new Error("candidate-missing-recovery-engine");
    status({ ok: true, status: "activating", desiredVersion });
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
    return status({ ok: true, status: "current", desiredVersion, lastSuccessAt: now(), failures: 0 });
  } catch (error) {
    const activeStatus = read(stateFile);
    const failures = previous && previous.desiredVersion === activeStatus?.desiredVersion ? (previous.failures || 0) + 1 : 1;
    return status({ ok: false, status: "failed", desiredVersion: activeStatus?.desiredVersion || null,
      failures, lastError: String(error.message).slice(0, 300), retryAt: now() + Math.min(60 * 60_000, CHECK_MS * 2 ** Math.min(failures - 1, 4)) });
  } finally {
    // Only our fresh UUID directory; never remove a canonical or rollback release.
    try { if (staged && path.dirname(staged) === path.join(root, "recovery", "downloads")) fs.rmSync(staged, { recursive: true, force: true }); }
    finally { lock.release(); }
  }
}

module.exports = { recover, discover, busyLease, channelFrom, compare, execute, read, write, CHECK_MS, DEADLINE_MS };
if (require.main === module) recover().then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
