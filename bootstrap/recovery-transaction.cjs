"use strict";

// The daemon's own updater and the scheduled recovery runner both install
// releases through the same canonical transaction. When both discover a release
// in the same minute, one of them owns the lock and the other loses it. Losing
// the lock says nothing about the release: the other owner is installing it
// right now. On 2026-09-21 the runner read that loss as a broken release,
// quarantined a version that was booting healthily, and rolled the person back.
//
// This module answers one question without importing the application tree:
// is a canonical runtime transaction currently owned by a live process?
const fs = require("node:fs");
const path = require("node:path");
const { processAlive, nativeProcessIdentity, liveLockParticipants } = require("./recovery-launcher.cjs");

// An admitted update request older than this is debris from a worker that died
// without writing its terminal state; the lock engine reclaims after owner death.
const REQUEST_IN_FLIGHT_MAX_MS = 45 * 60_000;
// The exit code a recovery worker uses when the lock belongs to a live owner.
// EX_TEMPFAIL: try again later; nothing about the release was judged.
const WORKER_EXIT_TRANSACTION_IN_PROGRESS = 75;

function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function liveOwner(owner, { alive = processAlive, identity = nativeProcessIdentity } = {}) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!alive(pid)) return false;
  const expected = typeof owner.processIdentity === "string" ? owner.processIdentity : "";
  if (!expected) return true;
  const actual = identity(pid);
  return !actual || actual === expected;
}

// Returns the live transaction, or null when no live process owns one.
// The lock owner is authoritative; an admitted update request adds the version
// being installed, which the lock file does not carry.
function inFlightTransaction({ homeDir, now = Date.now(), alive = processAlive, identity = nativeProcessIdentity } = {}) {
  const root = path.join(homeDir, ".relay", "runtime");
  const owner = read(path.join(root, "transaction.lock", "owner.json"));
  let request = null;
  let names = [];
  try { names = fs.readdirSync(path.join(root, "update-requests")); } catch {}
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const value = read(path.join(root, "update-requests", name));
    if (value?.state !== "admitted") continue;
    const admittedAt = Number(value.admittedAt);
    if (!Number.isFinite(admittedAt) || admittedAt > now || now - admittedAt > REQUEST_IN_FLIGHT_MAX_MS) continue;
    const pid = Number(value.workerPid) || Number(value.lockOwner?.pid);
    if (!liveOwner({ pid, processIdentity: value.lockOwner?.processIdentity }, { alive, identity })) continue;
    request = { source: "request", pid, requestId: value.requestId || null, version: value.version || null, admittedAt };
    break;
  }
  if (request) return request;
  if (owner && (liveOwner(owner, { alive, identity }) || liveLockParticipants(path.join(root, "transaction.lock"), owner.nonce, { isProcessAlive: alive, processIdentity: identity }))) {
    return { source: "lock", pid: Number(owner.pid), requestId: owner.requestId || null, version: null, admittedAt: Number(owner.createdAt) || null };
  }
  return null;
}

function workerLostLock(error) {
  return /recovery-worker-exit-75$/.test(String(error?.message || error || ""));
}

module.exports = { inFlightTransaction, liveOwner, workerLostLock, REQUEST_IN_FLIGHT_MAX_MS, WORKER_EXIT_TRANSACTION_IN_PROGRESS };
