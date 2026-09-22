import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import rollout from "../bootstrap/application-rollout.cjs";
import systemd from "../bootstrap/linux-systemd.cjs";
import state from "../bootstrap/application-handoff.cjs";
import nodeContract from "../bootstrap/node-contract.cjs";
import recoveryIO from "../bootstrap/recovery-launcher.cjs";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bootstrap");
export async function submitApplicationWorker({ platform = process.platform, node = process.execPath, env = process.env,
  run = (file, args, options) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options }),
  launchHidden, homeDir = os.homedir(), now = Date.now } = {}) {
  node = nodeContract.resolveManagedNode({ homeDir, node, run, env });
  const cleanEnv = nodeContract.nodeEnvironment(env);
  const parts = [node, path.join(directory, "update-watchdog.cjs"), path.join(directory, "application-update.cjs"), "--worker", "application"];
  const label = "work.relay.application.update";
  if (platform === "win32") {
    const launch = launchHidden || (await import("./canonical-updater.js")).launchHiddenWindowsProcess;
    return (await launch(parts, { env: cleanEnv })).ok === true;
  }
  if (platform === "darwin") {
    const observed = run("/bin/launchctl", ["list", label], { env: cleanEnv });
    const pid = Number(String(observed.stdout || "").match(/"PID"\s*=\s*([1-9]\d*)/)?.[1]);
    if (observed.status === 0 && pid) {
      const identity = recoveryIO.nativeProcessIdentity(pid, { platform, run });
      if (!identity) return false;
      const file = path.join(homeDir, ".relay", "application-worker-observation.json");
      const previous = recoveryIO.read(file);
      const firstSeen = previous?.identity === identity && previous.at <= now() ? previous.at : now();
      recoveryIO.write(file, { pid, identity, at: firstSeen });
      const command = run("/bin/ps", ["-p", String(pid), "-o", "command="], { env: cleanEnv });
      const text = String(command.stdout || "");
      if (command.status !== 0 || !/update-watchdog\.cjs.*application-update\.cjs/.test(text)) return false;
      // A stranded pre-contract Electron job can never run this worker. Other
      // live jobs retain the same finite deadline as the independent guardian.
      if (!/(?:^|\/)Electron(?:\.app\/|\s)/i.test(text) && now() - firstSeen < 25 * 60_000) return false;
    }
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
