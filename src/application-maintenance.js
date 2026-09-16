import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import rollout from "../bootstrap/application-rollout.cjs";
import systemd from "../bootstrap/linux-systemd.cjs";
import state from "../bootstrap/application-handoff.cjs";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bootstrap");
export async function submitApplicationWorker({ platform = process.platform, node = process.execPath, env = process.env,
  run = (file, args, options) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options }),
  launchHidden, homeDir = os.homedir() } = {}) {
  const cleanEnv = { ...env };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete cleanEnv[key];
  const parts = [node, path.join(directory, "update-watchdog.cjs"), path.join(directory, "application-update.cjs"), "--worker", "application"];
  const label = "work.relay.application.update";
  if (platform === "win32") {
    const launch = launchHidden || (await import("./canonical-updater.js")).launchHiddenWindowsProcess;
    return (await launch(parts, { env: cleanEnv })).ok === true;
  }
  if (platform === "darwin") {
    const observed = run("/bin/launchctl", ["list", label], { env: cleanEnv });
    if (observed.status === 0 && /"PID"\s*=\s*[1-9]\d*/.test(observed.stdout || "")) return false;
    if (observed.status === 0) {
      const removed = run("/bin/launchctl", ["remove", label], { env: cleanEnv });
      if (removed.error || removed.status !== 0) return false;
    }
    const log = path.join(homeDir, ".relay", "application-update.log");
    const submitted = run("/bin/launchctl", ["submit", "-l", label, "-o", log, "-e", log, "--", ...parts], { env: cleanEnv });
    return !submitted.error && submitted.status === 0;
  }
  if (platform === "linux") {
    const log = path.join(homeDir, ".relay", "application-update.log");
    const submitted = run("systemd-run", ["--user", "--quiet", "--collect", `--unit=${label}`,
      ...systemd.systemdRunEnvironmentArgs(cleanEnv), "--property=Type=exec", "--property=RuntimeMaxSec=1800",
      "--property=KillMode=control-group", `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, ...parts], { env: cleanEnv });
    return !submitted.error && submitted.status === 0;
  }
  return false;
}

export function startApplicationMaintenance({ enabled = rollout.enabled, setIntervalImpl = setInterval,
  submit = submitApplicationWorker, homeDir = os.homedir(), env = process.env, now = Date.now } = {}) {
  // Capability does not authorize migration: the worker requires a signed,
  // unexpired channel offer and an explicit device selection before handoff.
  if (enabled !== true) return null;
  let pending = false;
  const tick = async () => {
    if (pending) return;
    pending = true;
    try {
      if (!state.updateConsent({ homeDir, env }).ok) return;
      const status = state.read(path.join(homeDir, ".relay", "application-update.json"));
      if (status?.nextCheckAt > now() && status.nextCheckAt - now() <= 6 * 60 * 60_000) return;
      await submit({ homeDir, env });
    } catch { /* A later tick retries; messaging must remain available. */ }
    finally { pending = false; }
  };
  const timer = setIntervalImpl(tick, 60_000); timer.unref?.();
  return timer;
}
