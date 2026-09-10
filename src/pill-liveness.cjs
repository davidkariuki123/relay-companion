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
// Every API call from the pill failing for this long, while the daemon on the
// same machine keeps reaching Relay, means the pill's own transport is wedged.
const TRANSPORT_WEDGE_MS = 5 * 60_000;
const DAEMON_HEARTBEAT_FRESH_MS = 60_000;
const DAEMON_API_FRESH_MS = 2 * 60_000;

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
 * Whether the pill should relaunch itself because its API transport is wedged.
 * The daemon's heartbeat carries apiOkAt, its last successful Relay call. Only
 * a daemon success dated AFTER the pill started failing separates "the pill is
 * broken" from "Relay is down for everyone", and only the former is fixable here.
 */
function shouldRelaunchForWedgedTransport({ transport, daemon, now = Date.now(),
  wedgeMs = TRANSPORT_WEDGE_MS, daemonFreshMs = DAEMON_HEARTBEAT_FRESH_MS, apiFreshMs = DAEMON_API_FRESH_MS } = {}) {
  const failingSince = Number(transport?.failingSince) || 0;
  if (!failingSince || Number(transport.lastSuccessAt) >= failingSince) return { relaunch: false, reason: "transport-ok" };
  if (now - failingSince < wedgeMs) return { relaunch: false, reason: "failing-briefly", failingForMs: now - failingSince };
  const daemonAt = Number(daemon?.at) || 0;
  if (!daemonAt || daemonAt > now || now - daemonAt >= daemonFreshMs) return { relaunch: false, reason: "daemon-unverified" };
  const apiOkAt = Number(daemon.apiOkAt) || 0;
  if (apiOkAt < failingSince || now - apiOkAt >= apiFreshMs) return { relaunch: false, reason: "api-down-for-everyone" };
  return { relaunch: true, reason: "wedged-transport", failingForMs: now - failingSince };
}

module.exports = {
  pillHeartbeatPath,
  pillSupervisorDecision,
  shouldRelaunchForWedgedTransport,
  PILL_HEARTBEAT_MS,
  PILL_STALE_MS,
  PILL_RESTART_COOLDOWN_MS,
  TRANSPORT_WEDGE_MS,
};
