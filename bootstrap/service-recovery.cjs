"use strict";
const os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const io = require("./recovery-launcher.cjs");
const nodeContract = require("./node-contract.cjs");

// Registration restoration is part of the controller's canonical transaction.
// The UI may bootstrap the controller, but never constructs daemon/pill jobs.
async function repairServiceRegistrations({ homeDir = os.homedir(), platform = process.platform,
  run = (file, args) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 }),
  validate = require("./recovery-local.cjs").validateLocalRuntime,
  execute = (...args) => require("./recovery-runner.cjs").execute(...args),
  own = require("./lifecycle-ownership.cjs").lifecycleOwnership,
  drain = require("./update-activity.cjs").drainCalls,
  activate,
} = {}) {
  const stopped = () => require("./recovery-intent.cjs").stopped(homeDir);
  if (stopped()) return { ok: true, changed: false, status: "intentionally-stopped" };
  if (platform === "darwin") {
    const observed = await require("./mac-service-recovery.cjs").repairMacServiceRegistrations({ homeDir, platform, run });
    if (observed.ok || observed.blocked) return observed;
    // Invalid/missing plist bytes cannot be bootstrapped. A verified retained
    // runtime can rebuild them under the same ownership contract below.
  } else if (["win32", "linux"].includes(platform)) {
    let missing = false;
    for (const role of ["Daemon", "Pill"]) {
      const result = platform === "win32"
        ? run("schtasks.exe", ["/Query", "/TN", `Relay Companion ${role}`])
        : run("systemctl", ["--user", "show", "--property=LoadState", "--value", `work.relay.companion${role === "Pill" ? ".pill" : ""}.service`]);
      const text = String(result?.stdout || "").trim();
      const present = !result?.error && result.status === 0 && (platform === "win32" || text === "loaded");
      if (present) continue;
      const absent = !result?.error && (platform === "linux" ? text === "not-found" : /cannot find|does not exist|not found/i.test(String(result?.stderr || result?.stdout || "")));
      if (!absent) return { ok: false, changed: false, blocked: true, status: "service-repair-failed", lastError: "service-registration-query-failed" };
      missing = true;
    }
    if (!missing) return { ok: true, changed: false, status: "services-present" };
  } else return { ok: true, changed: false, status: "unsupported" };

  let lease, releaseDrain;
  try {
    try { lease = own({ homeDir }); }
    catch { return { ok: true, changed: false, status: "deferred-update-owner" }; }
    if (stopped()) return { ok: true, changed: false, status: "intentionally-stopped" };
    const target = io.read(path.join(homeDir, ".relay", "runtime", "current.json"));
    if (!target?.active || !validate(target, { platform })) return { ok: false, changed: false, status: "service-repair-failed", lastError: "no-verified-registration-source" };
    const node = nodeContract.resolveManagedNode({ homeDir, node: target.node, run });
    releaseDrain = await drain({ homeDir });
    lease.assert();
    if (stopped()) return { ok: true, changed: false, status: "intentionally-stopped" };
    await execute(node, path.join(target.packageRoot, "bin", "relay.js"), ["repair-runtime", "--no-restart"],
      { env: nodeContract.nodeEnvironment(lease.env), timeoutMs: 90_000 });
    lease.assert();
    if (stopped()) return { ok: true, changed: false, status: "intentionally-stopped" };
    const health = require("./runtime-health.cjs");
    const activateRuntime = activate || (platform === "darwin" ? health.activateMacRuntimeServices
      : platform === "win32" ? health.activateWindowsRuntimeServices : health.activateLinuxRuntimeServices);
    const result = await activateRuntime(target, { homeDir, platform });
    return { ok: result.ok, changed: true, status: result.ok ? "services-restored" : "service-repair-failed", lastError: result.reason };
  } catch (error) { return { ok: false, changed: false, status: "service-repair-failed", lastError: error.message }; }
  finally { releaseDrain?.(); lease?.release(); }
}
module.exports = { repairServiceRegistrations };
