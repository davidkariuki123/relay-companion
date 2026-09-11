"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const PROBATION_MS = 15 * 60_000, OBSERVATION_GAP_MS = 7 * 60_000;
const EMERGENCY_RETRY_MS = 15 * 60_000, RELEASE_COOLDOWN_MS = 30 * 60_000;
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function recoveryPolicy({ root = path.join(os.homedir(), ".relay", "recovery"), now = Date.now } = {}) {
  const directory = (channel, version) => {
    if (!["stable", "dev", "staging"].includes(channel) || !/^\d+\.\d+\.\d+$/.test(version || "")) throw Error("invalid-release-policy-target");
    return path.join(root, "release-health", channel, version);
  };
  const failure = (channel, version, { id = crypto.randomUUID(), reason = "runtime-not-healthy" } = {}) => {
    const dir = directory(channel, version), file = path.join(dir, 'failure-' + crypto.createHash("sha256").update(id).digest("hex") + '.json');
    // Independent immutable event files avoid lost increments when the daemon,
    // worker and watchdog report concurrently. A request ID deduplicates reports.
    if (fs.existsSync(file)) return;
    atomicFile(file, JSON.stringify({ at: now(), reason: String(reason).slice(0, 300) }));
    const probationFile = path.join(root, "probation.json");
    if (read(probationFile)?.identity?.startsWith(`${channel}:${version}:`)) {
      try { fs.unlinkSync(probationFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  const decision = (channel, version) => {
    const dir = directory(channel, version), healthyAt = read(path.join(dir, "proven.json"))?.at ?? -1;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const events = names.filter(name => /^failure-[a-f0-9]{64}\.json$/.test(name)).sort().map(name => ({ ...read(path.join(dir, name)), name }))
      .filter(event => Number.isFinite(event?.at) && event.at >= healthyAt);
    const lastAt = events.reduce((last, event) => Math.max(last, event.at), 0);
    const wait = Math.min(24 * 60 * 60_000, RELEASE_COOLDOWN_MS * 2 ** Math.min(Math.max(0, events.length - 1), 6));
    // Anchor a clock correction once. Recomputing min(lastAt, now) on every
    // check after clock reversal would slide the deadline forever.
    const signature = crypto.createHash("sha256").update(JSON.stringify(events)).digest("hex");
    const clockFile = path.join(dir, "cooldown.json"), old = read(clockFile), at = now();
    let retryAt = events.length ? lastAt + wait : 0;
    if (events.length) {
      if (old?.signature === signature && Number.isFinite(old.retryAt)) retryAt = old.retryAt;
      retryAt = Math.min(retryAt, at + wait);
      if (old?.signature !== signature || old.retryAt !== retryAt) atomicFile(clockFile, JSON.stringify({ signature, retryAt }));
    }
    return { blocked: events.length > 0 && now() < retryAt, retryAt, failures: events.length };
  };
  return {
    failure, decision,
    observe(channel, observed) {
      const current = observed.current, at = now(), file = path.join(root, "probation.json");
      // Only strong readiness probes supply an identity. Legacy process/heartbeat
      // checks may restore availability but cannot promote a new known-good copy.
      if (!observed.identity || !current?.packageRoot) return { proven: false };
      const identity = `${channel}:${current.version}:${current.packageRoot}:${observed.identity}`;
      const old = read(file);
      const continuing = old?.identity === identity && Number.isFinite(old.since) && old.since <= old.at && at >= old.at && at - old.at <= OBSERVATION_GAP_MS;
      const since = continuing ? old.since : at;
      const proven = at - since >= PROBATION_MS;
      atomicFile(file, JSON.stringify({ identity, since, at, proven }));
      if (proven) atomicFile(path.join(directory(channel, current.version), "proven.json"), JSON.stringify({ at, identity }));
      return { proven, since, remainingMs: Math.max(0, PROBATION_MS - (at - since)) };
    },
    interrupt() { try { fs.unlinkSync(path.join(root, "probation.json")); } catch (error) { if (error.code !== "ENOENT") throw error; } },
    emergency() {
      const file = path.join(root, "emergency-download.json"), old = read(file), at = now();
      if (Number.isFinite(old?.at) && at >= old.at && at - old.at < EMERGENCY_RETRY_MS) return { allowed: false, retryAt: old.at + EMERGENCY_RETRY_MS };
      // Reserve before staging, so worker death or status changes cannot reset it.
      atomicFile(file, JSON.stringify({ at }));
      return { allowed: true };
    },
  };
}
module.exports = { recoveryPolicy, PROBATION_MS, OBSERVATION_GAP_MS, EMERGENCY_RETRY_MS, RELEASE_COOLDOWN_MS };
