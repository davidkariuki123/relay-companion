"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const AWAKE_GRACE_MS = 15 * 60_000;
const CHECK_OVERDUE_MS = 35 * 60_000; // exceeds the full launcher deadline + cadence
const REPAIR_RETRY_MS = 60 * 60_000;
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function recoveryMonitor({ homeDir = os.homedir(), now = Date.now() } = {}) {
  const root = path.join(homeDir, ".relay", "recovery");
  const heartbeat = read(path.join(root, "daemon.json"));
  const supervisor = read(path.join(root, "status.json"));
  const launcher = read(path.join(root, "launcher-status.json"));
  const repair = read(path.join(root, "maintenance.json"));
  let state = "unverified";
  const awake = Number.isFinite(heartbeat?.awakeSince) && heartbeat.awakeSince <= now && now - heartbeat.awakeSince >= AWAKE_GRACE_MS;
  const responsive = Number.isFinite(heartbeat?.at) && heartbeat.at <= now && now - heartbeat.at < 60_000;
  if (read(path.join(root, "policy.json"))?.autoUpdate === false) state = "disabled";
  else if (responsive && !awake) state = "warming-up";
  else if (responsive && awake) {
    const check = Math.max(Number(supervisor?.checkedAt) || 0, Number(launcher?.at) || 0);
    if (!check) state = "missing";
    else if (check > now || now - check > CHECK_OVERDUE_MS) state = "overdue";
    else if (launcher?.status === "failed") state = "launcher-failed";
    else if (launcher?.status === "fallback") state = "fallback";
    else state = "healthy";
  }
  const confirmed = repair?.at > 0 && supervisor?.checkedAt > repair.at
    && ["healthy", "fallback"].includes(state);
  return { state, needsRepair: ["missing", "overdue", "launcher-failed"].includes(state),
    repairStatus: confirmed ? "confirmed" : repair?.status || null, lastRepairAt: Number(repair?.at) || null };
}
module.exports = { recoveryMonitor, AWAKE_GRACE_MS, CHECK_OVERDUE_MS, REPAIR_RETRY_MS };
