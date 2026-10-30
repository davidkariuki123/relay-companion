"use strict";
// Liveness decisions shared by the pill (CommonJS under Electron) and the
// daemon (ESM). Pure functions over plain objects, so both sides and the tests
// reason about the same rules. Nothing here touches processes or the network.
const path = require("node:path");

const PILL_HEARTBEAT_MS = 5000;
// Long enough that a busy machine paging for a minute is not "hung"; short
// enough that a person waiting on the pill is not waiting on a 5-minute cadence.
const PILL_STALE_MS = 3 * 60_000;
const PILL_RESTART_COOLDOWN_MS = 10 * 60_000;
// How long the pill's own calls must keep failing before it says so: one
// dropped request on patchy Wi-Fi is not worth a sentence.
const CONNECTIVITY_NOTICE_MS = 15_000;
// While its calls fail the pill makes a fresh one this often. Nothing else may
// be due for minutes, and without a call it cannot notice the network is back.
const CONNECTIVITY_PROBE_MS = 15_000;
const DAEMON_HEARTBEAT_FRESH_MS = 60_000;
const DAEMON_API_FRESH_MS = 2 * 60_000;
// The daemon writes its heartbeat every 5 s (src/recovery-health.js). Two
// minutes of silence is a daemon that is gone or wedged, not one that is busy:
// a machine waking from sleep re-stamps within seconds.
const DAEMON_STALE_MS = 2 * 60_000;
// At logon the pill and the daemon start together; give the daemon this long
// to write its first heartbeat before the pill decides it is missing.
const DAEMON_REPAIR_GRACE_MS = 60_000;
// One repair per window. A daemon that keeps dying is the updater's or the
// recovery launcher's problem; the pill must not turn into a restart loop.
const DAEMON_REPAIR_COOLDOWN_MS = 10 * 60_000;

function pillHeartbeatPath(homeDir) {
  return path.join(homeDir, ".relay", "recovery", "pill.json");
}

/**
 * What the daemon should do about the pill's heartbeat file.
 *   none/no-heartbeat     older pill or never started: nothing to judge.
 *   none/fresh            reporting on time.
 *   none/pill-not-running quit or crashed: the OS supervisor's job, not ours.
 *   none/cooldown         restarted recently; do not flap.
 *   restart/hung          alive, silent for too long.
 */
function pillSupervisorDecision({ heartbeat, now = Date.now(), alive = false, lastRestartAt = 0,
  staleMs = PILL_STALE_MS, cooldownMs = PILL_RESTART_COOLDOWN_MS } = {}) {
  if (!heartbeat || !Number.isFinite(heartbeat.at)) return { action: "none", reason: "no-heartbeat" };
  if (heartbeat.at > now) return { action: "none", reason: "clock-ahead" };
  const ageMs = now - heartbeat.at;
  if (ageMs < staleMs) return { action: "none", reason: "fresh", ageMs };
  if (!alive) return { action: "none", reason: "pill-not-running", ageMs };
  if (lastRestartAt && now - lastRestartAt < cooldownMs) return { action: "none", reason: "cooldown", ageMs };
  return { action: "restart", reason: "hung", ageMs };
}

/**
 * What the pill says and does while its own Relay calls fail. It never quits:
 * every failed call already threw its connection pool away (src/client.js), so
 * a fresh call is the whole repair. Until 2026-10-19 the pill relaunched itself
 * after five minutes of failures if the daemon had reached Relay since. After
 * any outage that long the daemon reconnects first, so the relaunch fired the
 * moment the network came back, and on macOS launchd never started the pill
 * again (Sven, five times from 2026-09-28).
 *   online       calls are answered, or the daemon on this machine reaches
 *                Relay (not a network problem; the next call catches up).
 *   offline      the OS reports no network connection.
 *   unreachable  calls have failed for a while and nothing here reaches Relay.
 * probe says to make a fresh call now. Any HTTP answer, even an error status,
 * counts as reaching Relay.
 */
function pillConnectivityDecision({ transport, daemon, osOnline = true, now = Date.now(), lastProbeAt = 0,
  noticeMs = CONNECTIVITY_NOTICE_MS, probeMs = CONNECTIVITY_PROBE_MS,
  daemonFreshMs = DAEMON_HEARTBEAT_FRESH_MS, apiFreshMs = DAEMON_API_FRESH_MS } = {}) {
  if (osOnline === false) return { state: "offline", probe: false, reason: "os-offline" };
  const failingSince = Number(transport?.failingSince) || 0;
  if (!failingSince || Number(transport.lastSuccessAt) >= failingSince) return { state: "online", probe: false, reason: "transport-ok" };
  const probe = now - (Number(lastProbeAt) || 0) >= probeMs;
  const failingForMs = Math.max(0, now - failingSince);
  const daemonAt = Number(daemon?.at) || 0;
  const apiOkAt = Number(daemon?.apiOkAt) || 0;
  if (daemonAt && daemonAt <= now && now - daemonAt < daemonFreshMs && apiOkAt >= failingSince && now - apiOkAt < apiFreshMs) {
    return { state: "online", probe, reason: "service-reaches-relay", failingForMs };
  }
  if (failingForMs < noticeMs) return { state: "online", probe, reason: "failing-briefly", failingForMs };
  return { state: "unreachable", probe, reason: "unreachable", failingForMs };
}

function daemonHeartbeatPath(homeDir) {
  return path.join(homeDir, ".relay", "recovery", "daemon.json");
}

/** Whether the daemon's heartbeat file is evidence of a live daemon right now. */
function daemonHeartbeatIsFresh(heartbeat, { now = Date.now(), staleMs = DAEMON_STALE_MS } = {}) {
  const at = Number(heartbeat?.at) || 0;
  return at > 0 && at <= now && now - at < staleMs;
}

/**
 * What the pill should do about the daemon's heartbeat file. The pill is the
 * one Relay process a person can see, so it is also the one that must notice a
 * background service that never came back (an OS reinstall that kept the home
 * folder but dropped the logon tasks, Shane 2026-09-19) and put it back.
 *   none/updating          an update transaction owns the services right now.
 *   none/pill-just-started the daemon may still be booting beside this pill.
 *   none/fresh             reporting on time.
 *   none/clock-ahead       a heartbeat from the future is a clock problem.
 *   none/cooldown          repaired recently; do not flap.
 *   repair/no-heartbeat    never wrote one: not registered or never started.
 *   repair/stale           silent for too long: gone or wedged.
 */
function daemonRepairDecision({ heartbeat, now = Date.now(), pillStartedAt = 0, lastRepairAt = 0, updating = false,
  staleMs = DAEMON_STALE_MS, graceMs = DAEMON_REPAIR_GRACE_MS, cooldownMs = DAEMON_REPAIR_COOLDOWN_MS } = {}) {
  if (updating) return { action: "none", reason: "updating" };
  const at = Number(heartbeat?.at) || 0;
  if (at > now) return { action: "none", reason: "clock-ahead" };
  const ageMs = at ? now - at : null;
  if (at && ageMs < staleMs) return { action: "none", reason: "fresh", ageMs };
  // Not fresh. Inside the logon grace that is not yet a verdict, but it is a
  // reason for the pill to read rooms from the server until it is.
  if (pillStartedAt && now - pillStartedAt < graceMs) return { action: "none", reason: "pill-just-started", ageMs };
  if (lastRepairAt && now - lastRepairAt < cooldownMs) return { action: "none", reason: "cooldown", ageMs };
  if (!at) return { action: "repair", reason: "no-heartbeat" };
  return { action: "repair", reason: "stale", ageMs };
}

/**
 * Whether runtime/transaction.lock means an update owns the services right
 * now. The pill only asks recovery for a repair, and recovery takes the lock
 * properly, so this gate only has to keep the pill quiet during a live
 * update. A lock whose owner has died is not one: it used to hold the pill's
 * repair off until someone else reclaimed it.
 *   owner          parsed owner.json, or null when missing or unreadable.
 *   lockAgeMs      age of the lock directory (mkdir comes before owner.json).
 *   ownerAlive     whether owner.pid is a running process.
 */
const TRANSACTION_OWNERLESS_GRACE_MS = 10 * 60_000;
function transactionLockOpen({ exists = false, owner = null, lockAgeMs = 0, ownerAlive = false,
  ownerlessGraceMs = TRANSACTION_OWNERLESS_GRACE_MS } = {}) {
  if (!exists) return false;
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return !(lockAgeMs >= ownerlessGraceMs);
  return ownerAlive === true;
}

// Whether the service is actually RECEIVING messages (src/inbox-health.js),
// which a fresh heartbeat alone does not prove. No evidence from this very
// process (an older service, or the file of one that has since been replaced)
// is not a verdict. A service that woke recently has not had time to receive.
const INBOX_STALL_MS = 2 * 60_000;
function inboxHealthPath(homeDir) {
  return path.join(homeDir, ".relay", "recovery", "inbox.json");
}
function inboxReceiveDecision({ inbox, heartbeat, now = Date.now(), stallMs = INBOX_STALL_MS } = {}) {
  if (!inbox || inbox.schema !== 1 || !heartbeat || Number(inbox.pid) !== Number(heartbeat.pid)) return { receiving: true, reason: "unknown" };
  const okAt = Number(inbox.okAt) || 0;
  if (okAt && now - okAt < stallMs) return { receiving: true, reason: "receiving" };
  const awakeSince = Number(heartbeat.awakeSince) || 0;
  if (inbox.state !== "unbound" && awakeSince && now - awakeSince < stallMs) return { receiving: true, reason: "waking" };
  return { receiving: false, reason: inbox.state === "unbound" ? `unbound:${inbox.reason || "unknown"}` : "not-receiving",
    sinceMs: okAt ? now - okAt : null };
}

module.exports = {
  inboxHealthPath,
  inboxReceiveDecision,
  INBOX_STALL_MS,
  pillHeartbeatPath,
  daemonHeartbeatPath,
  daemonHeartbeatIsFresh,
  pillSupervisorDecision,
  pillConnectivityDecision,
  daemonRepairDecision,
  transactionLockOpen,
  PILL_HEARTBEAT_MS,
  PILL_STALE_MS,
  PILL_RESTART_COOLDOWN_MS,
  CONNECTIVITY_NOTICE_MS,
  CONNECTIVITY_PROBE_MS,
  DAEMON_STALE_MS,
  DAEMON_REPAIR_GRACE_MS,
  DAEMON_REPAIR_COOLDOWN_MS,
  TRANSACTION_OWNERLESS_GRACE_MS,
};
