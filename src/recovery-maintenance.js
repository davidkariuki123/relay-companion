import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import monitor from "../bootstrap/recovery-monitor.cjs";
import io from "../bootstrap/recovery-launcher.cjs";
import installer from "../bootstrap/recovery-install.cjs";
import setup from "../bootstrap/relay-setup.cjs";

export function repairRecoverySchedule({ homeDir = os.homedir(), now = Date.now(), repair = installer.installRecovery,
  packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  const root = path.join(homeDir, ".relay", "recovery");
  const health = monitor.recoveryMonitor({ homeDir, now });
  if (!health.needsRepair) return { status: "not-needed" };
  const previous = io.read(path.join(root, "maintenance.json"));
  if (previous?.at <= now && now - previous.at < monitor.REPAIR_RETRY_MS) return { status: "backoff" };
  // Re-register only the recovery job, never a running recovery/activation tree.
  const releaseLauncher = io.acquireLauncherLock(root);
  if (!releaseLauncher) return { status: "busy" };
  let runLock;
  try { runLock = setup.acquireCanonicalLock(path.join(root, "run.lock")); }
  catch { releaseLauncher(); return { status: "busy" }; }
  try {
    io.write(path.join(root, "maintenance.json"), { schema: 1, at: now, status: "repairing" });
    const result = repair({ homeDir, packageRoot, node: process.execPath, reload: true });
    const status = result.ok ? "awaiting-check" : "failed";
    io.write(path.join(root, "maintenance.json"), { schema: 1, at: now, status });
    return { status };
  } catch {
    io.write(path.join(root, "maintenance.json"), { schema: 1, at: now, status: "failed" });
    return { status: "failed" };
  } finally { runLock.release(); releaseLauncher(); }
}
export function startRecoveryMaintenance({ homeDir = os.homedir(), now = Date.now, setIntervalImpl = setInterval,
  spawnRepair = () => new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(import.meta.url), "--repair-recovery-schedule"],
      { windowsHide: true, timeout: 120_000, maxBuffer: 128 * 1024,
        env: { ...process.env, RELAY_RECOVERY_WORKER: "" } }, error => error ? reject(error) : resolve());
  }) } = {}) {
  let pending = false;
  const tick = async () => {
    if (pending || !monitor.recoveryMonitor({homeDir,now:now()}).needsRepair) return;
    const previous = io.read(path.join(homeDir,".relay","recovery","maintenance.json"));
    if (previous?.at <= now() && now() - previous.at < monitor.REPAIR_RETRY_MS) return;
    pending = true;
    try { await spawnRepair(); }
    catch { io.write(path.join(homeDir,".relay","recovery","maintenance.json"), { schema: 1, at: now(), status: "failed" }); }
    finally { pending = false; }
  };
  const timer = setIntervalImpl(() => { void tick().catch(() => {}); }, 60_000);
  timer.unref?.();
  return timer;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--repair-recovery-schedule")) {
  const result = repairRecoverySchedule();
  console.log(JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
}
