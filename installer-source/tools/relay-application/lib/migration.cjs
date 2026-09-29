"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"];
const STEPS = [
  "complete-current-update", "verify-application", "stage-application",
  "wait-for-active-work", "transfer-update-ownership", "verify-application-health",
  "verify-independent-recovery", "observe-stability", "retire-old-runtime",
];

// This inspector deliberately reads only small ownership markers. In particular,
// it never opens config.json, credentials, protocol authorization or message data.
function readMarker(file, io = fs) {
  try {
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { status: "invalid" };
    const value = JSON.parse(io.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid" };
    return { status: "present", value };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "absent" : "unreadable" };
  }
}

// The daemon stamps this file every 5 s while it runs. Two minutes of silence
// is a service that is gone, whatever the runtime pointer says: a restored home
// folder on a fresh OS carries an active pointer and no logon task at all.
const SERVICE_HEARTBEAT_STALE_MS = 2 * 60_000;
function serviceHeartbeatState(root, io, now) {
  const heartbeat = readMarker(path.join(root, "recovery", "daemon.json"), io);
  if (heartbeat.status !== "present") return heartbeat.status === "absent" ? "absent" : "unknown";
  const at = Number(heartbeat.value.at) || 0;
  return at > 0 && at <= now && now - at < SERVICE_HEARTBEAT_STALE_MS ? "fresh" : "stale";
}

function inspectInstallation({ homeDir, io = fs, now = Date.now() } = {}) {
  if (!homeDir || !path.isAbsolute(homeDir)) throw new Error("An absolute home directory is required");
  const root = path.join(homeDir, ".relay");
  const pointer = readMarker(path.join(root, "runtime", "current.json"), io);
  const owner = readMarker(path.join(root, "application-owner.json"), io);
  const transaction = readMarker(path.join(root, "runtime", "transaction.lock"), io);
  const serviceHeartbeat = serviceHeartbeatState(root, io, now);
  let legacyInstallation = "absent";
  for (const marker of [path.join(root, "config.json"), path.join(root, "recovery"),
    path.join(root, "daemon.pid"), path.join(homeDir, "Applications", "Relay.app")]) {
    try { io.lstatSync(marker); legacyInstallation = "possible"; }
    catch (error) { if (error.code !== "ENOENT") legacyInstallation = "unknown"; }
  }
  const current = pointer.value;
  const valid = pointer.status === "present" && current.schema === 1
    && /^\d+\.\d+\.\d+$/.test(current.version || "")
    && current.active === true && (!current.state || current.state === "active")
    && typeof current.packageRoot === "string"
    && path.resolve(current.packageRoot).startsWith(`${path.join(root, "runtime", "releases")}${path.sep}`)
    && path.basename(current.packageRoot) === "relay-companion"
    && path.basename(path.dirname(current.packageRoot)) === "node_modules";
  return {
    schema: 1,
    pointer: valid ? "active" : pointer.status === "present" ? "needs-repair" : pointer.status,
    installedVersion: valid ? current.version : null,
    applicationOwner: owner.status === "absent" ? "absent" : "present-or-unknown",
    transaction: transaction.status,
    // "fresh" is the only value that means the background service is running.
    serviceHeartbeat,
    legacyInstallation,
    // Even an active pointer is not evidence that the updater is currently alive.
    updaterHealth: "not-probed",
  };
}

function planMigration({ installation, platform, targetVersion } = {}) {
  if (!PLATFORMS.includes(platform)) throw new Error("Unsupported application platform");
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion || "")) throw new Error("An exact target version is required");
  if (installation?.schema !== 1) throw new Error("An installation inventory is required");
  const blockers = [];
  if (installation.transaction !== "absent") blockers.push("existing-transaction-needs-review");
  if (installation.applicationOwner !== "absent") blockers.push("application-ownership-needs-review");
  if (!["active", "absent"].includes(installation.pointer)) blockers.push("existing-installation-needs-repair");
  if (installation.pointer === "absent" && installation.legacyInstallation !== "absent") blockers.push("legacy-installation-needs-review");
  const route = blockers.length ? "deferred-repair" : installation.pointer === "active" ? "bridge" : "fresh-install";
  return {
    schema: 1, platform, targetVersion, route, blockers,
    executionEnabled: false,
    updaterHealth: installation.updaterHealth,
    requiresLiveHealthProof: route === "bridge",
    steps: [...STEPS],
    preserve: ["account", "credentials", "messages", "encryption-keys", "protocol-authorization", "user-edited-skills"],
    retirementAllowed: false,
    reason: "Preview only. Native activation and ownership transfer have not been released.",
  };
}

// Transition proofs are pure data, not permission to perform an installation.
// A future executor must produce these under the existing canonical lock.
function validateMigrationProof(proof) {
  const required = ["currentUpdateComplete", "targetVerified", "workDrained", "singleUpdateOwner",
    "applicationHealthy", "independentRecoveryHealthy", "stabilityObserved"];
  const missing = required.filter((key) => proof?.[key] !== true);
  return { ok: missing.length === 0, missing };
}

module.exports = { PLATFORMS, STEPS, SERVICE_HEARTBEAT_STALE_MS, inspectInstallation, planMigration, validateMigrationProof };
