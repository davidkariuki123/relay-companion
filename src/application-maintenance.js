import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import rollout from "../bootstrap/application-rollout.cjs";
import systemd from "../bootstrap/linux-systemd.cjs";
import state from "../bootstrap/application-handoff.cjs";
import nodeContract from "../bootstrap/node-contract.cjs";
import recoveryIO from "../bootstrap/recovery-launcher.cjs";

export const APPLICATION_WORKER_LABEL = "work.relay.application.update";
const WORKER_FILES = ["update-watchdog.cjs", "application-update.cjs"];
const runningDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bootstrap");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A worker job outlives the release tree that launched it, and the release
// pruner reclaims every tree no live process references. Take the worker from
// the committed runtime pointer, and from this process's own tree only when the
// pointer names nothing usable. Never hand launchd a path that is already gone.
export function applicationWorkerDirectory({ homeDir = os.homedir(), fallback = runningDirectory, existsSync = fs.existsSync } = {}) {
  const current = recoveryIO.read(path.join(homeDir, ".relay", "runtime", "current.json"));
  const pointed = current?.active === true && typeof current.packageRoot === "string" ? path.join(current.packageRoot, "bootstrap") : null;
  return [pointed, fallback].find(dir => dir && WORKER_FILES.every(name => existsSync(path.join(dir, name)))) || null;
}

function macJob(run, env) {
  const observed = run("/bin/launchctl", ["list", APPLICATION_WORKER_LABEL], { env });
  if (observed.error || observed.status !== 0) return null;
  const text = String(observed.stdout || "");
  const args = [...(text.match(/"ProgramArguments"\s*=\s*\(([\s\S]*?)\);/)?.[1] || "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]);
  return { pid: Number(text.match(/"PID"\s*=\s*([1-9]\d*)/)?.[1]) || null, keepAlive: /"OnDemand"\s*=\s*false/.test(text), args, text };
}

async function removeMacJob(run, env, { attempts = 15, wait = sleep } = {}) {
  const removed = run("/bin/launchctl", ["remove", APPLICATION_WORKER_LABEL], { env });
  if (removed.error || removed.status !== 0) return false;
  // `remove` returns before launchd drops the label; bootstrapping the same
  // label while it lingers fails with EIO.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!macJob(run, env)) return true;
    await wait(200);
  }
  return !macJob(run, env);
}

/**
 * Builds before this one registered the worker with `launchctl submit`, which
 * keeps the job alive: launchd relaunched it roughly every ten seconds for as
 * long as the session lasted, with the arguments of whichever release submitted
 * it. Once that release was pruned every relaunch died on MODULE_NOT_FOUND.
 * Remove such a job, or any idle job naming a worker that no longer exists.
 * A running job is left to finish.
 */
export async function reconcileApplicationWorker({ platform = process.platform, env = process.env, existsSync = fs.existsSync,
  run = (file, args, options) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options }),
  wait = sleep } = {}) {
  if (platform !== "darwin") return { removed: false };
  const cleanEnv = nodeContract.nodeEnvironment(env);
  const job = macJob(run, cleanEnv);
  if (!job || job.pid) return { removed: false };
  const missing = job.args.slice(1, 3).find(file => path.isAbsolute(file) && !existsSync(file));
  if (!job.keepAlive && !missing) return { removed: false };
  return { removed: await removeMacJob(run, cleanEnv, { wait }), reason: job.keepAlive ? "keep-alive" : "worker-missing", missing };
}

export async function submitApplicationWorker({ platform = process.platform, node = process.execPath, env = process.env,
  run = (file, args, options) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options }),
  launchHidden, homeDir = os.homedir(), now = Date.now, existsSync = fs.existsSync, fallbackDirectory = runningDirectory,
  userId = typeof process.getuid === "function" ? process.getuid() : 0, writeFile = fs.writeFileSync, wait = sleep } = {}) {
  const directory = applicationWorkerDirectory({ homeDir, fallback: fallbackDirectory, existsSync });
  if (!directory) return { ok: false, reason: "worker-missing" };
  node = nodeContract.resolveManagedNode({ homeDir, node, run, env });
  const cleanEnv = nodeContract.nodeEnvironment(env);
  const parts = [node, path.join(directory, "update-watchdog.cjs"), path.join(directory, "application-update.cjs"), "--worker", "application"];
  const label = APPLICATION_WORKER_LABEL;
  const log = path.join(homeDir, ".relay", "application-update.log");
  if (platform === "win32") {
    const launch = launchHidden || (await import("./canonical-updater.js")).launchHiddenWindowsProcess;
    return (await launch(parts, { env: cleanEnv })).ok === true ? { ok: true } : { ok: false, reason: "launch-failed" };
  }
  if (platform === "darwin") {
    const job = macJob(run, cleanEnv);
    if (job?.pid) {
      const identity = recoveryIO.nativeProcessIdentity(job.pid, { platform, run });
      if (!identity) return { ok: false, reason: "busy" };
      const file = path.join(homeDir, ".relay", "application-worker-observation.json");
      const previous = recoveryIO.read(file);
      const firstSeen = previous?.identity === identity && previous.at <= now() ? previous.at : now();
      recoveryIO.write(file, { pid: job.pid, identity, at: firstSeen });
      const command = run("/bin/ps", ["-p", String(job.pid), "-o", "command="], { env: cleanEnv });
      const text = String(command.stdout || "");
      if (command.status !== 0 || !/update-watchdog\.cjs.*application-update\.cjs/.test(text)) return { ok: false, reason: "busy" };
      // A stranded pre-contract Electron job can never run this worker. Other
      // live jobs retain the same finite deadline as the independent guardian.
      if (!/(?:^|\/)Electron(?:\.app\/|\s)/i.test(text) && now() - firstSeen < 25 * 60_000) return { ok: false, reason: "busy" };
    }
    if (job && !(await removeMacJob(run, cleanEnv, { wait }))) return { ok: false, reason: "remove-failed" };
    const { updateWorkerPlist } = await import("./canonical-updater.js");
    const plist = path.join(homeDir, ".relay", "runtime", "application-update-worker.plist");
    fs.mkdirSync(path.dirname(plist), { recursive: true, mode: 0o700 });
    writeFile(plist, updateWorkerPlist(parts, log, label), { mode: 0o600 });
    const submitted = run("/bin/launchctl", ["bootstrap", `gui/${userId}`, plist], { env: cleanEnv });
    return !submitted.error && submitted.status === 0 ? { ok: true } : { ok: false, reason: "launch-failed" };
  }
  if (platform === "linux") {
    const submitted = run("systemd-run", ["--user", "--quiet", "--collect", `--unit=${label}`,
      ...systemd.systemdRunEnvironmentArgs(cleanEnv), "--property=Type=exec", "--property=RuntimeMaxSec=1800",
      "--property=KillMode=control-group", `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, ...parts], { env: cleanEnv });
    return !submitted.error && submitted.status === 0 ? { ok: true } : { ok: false, reason: "launch-failed" };
  }
  return { ok: false, reason: "unsupported-platform" };
}

export function startApplicationMaintenance({ enabled = rollout.enabled, setIntervalImpl = setInterval,
  submit = submitApplicationWorker, reconcile = reconcileApplicationWorker, homeDir = os.homedir(), env = process.env,
  now = Date.now, log = () => {} } = {}) {
  // Capability does not authorize migration: the worker requires a signed,
  // unexpired channel offer and an explicit device selection before handoff.
  if (enabled !== true) return null;
  let pending = false, reconciled = false, failures = 0, retryAt = 0, lastReason = null;
  const tick = async () => {
    if (pending) return;
    pending = true;
    try {
      if (!reconciled) {
        reconciled = true;
        const result = await reconcile({ env });
        if (result?.removed) log(`removed stale application update job (${result.reason}${result.missing ? `: ${result.missing}` : ""})`);
      }
      if (!state.updateConsent({ homeDir, env }).ok) return;
      const status = state.read(path.join(homeDir, ".relay", "application-update.json"));
      if (status?.nextCheckAt > now() && status.nextCheckAt - now() <= 6 * 60 * 60_000) return;
      if (retryAt > now()) return;
      const result = await submit({ homeDir, env });
      if (result?.ok || result?.reason === "busy") { failures = 0; retryAt = 0; lastReason = null; return; }
      // One line per failure streak, then exponential quiet: a launch that
      // cannot work is not retried every minute and does not fill the log.
      failures += 1;
      retryAt = now() + Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1));
      if (result?.reason !== lastReason) log(`application update worker not started (${result?.reason || "unknown"}); retrying with backoff`);
      lastReason = result?.reason;
    } catch { /* A later tick retries; messaging must remain available. */ }
    finally { pending = false; }
  };
  const timer = setIntervalImpl(tick, 60_000); timer.unref?.();
  return timer;
}
