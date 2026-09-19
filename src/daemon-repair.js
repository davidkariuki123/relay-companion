// Put the background daemon back when the pill finds it gone.
//
// The pill is the one Relay process a person can see, and until 2026-09-19 it
// was also the one that never noticed the daemon was missing. Shane's Windows
// laptop came back from an OS reinstall with its home folder restored: the
// runtime tree, credentials and message store were all there, but the logon
// tasks that start the daemon, the pill and the recovery launcher were gone.
// The installer saw the files and called it set up; the pill opened, fetched
// its own Sent messages live, and quietly showed a Granular chat with Sven's
// replies missing, because inbound Relay rows only arrive through the daemon.
// Every self-heal Relay had lived inside the daemon or inside a task that had
// been wiped with it.
//
// This module is what the pill runs on a stale daemon heartbeat: register the
// daemon's autostart and the recovery launcher again (idempotent, and only the
// pieces that are missing on Windows), start the daemon through the platform
// supervisor with the same verified restart the account paths use, and count
// it repaired only once a fresh heartbeat proves the new process is alive.
// It never touches account data, the message store or the pill's own service.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  installDaemonAutostart,
  installPillAutostart,
  relayBinPath,
  restartRelayServices,
  stableNodePath,
  windowsAutostartTaskStatus,
} from "./install.js";

const require = createRequire(import.meta.url);
const liveness = require("./pill-liveness.cjs");
const { installRecovery } = require("../bootstrap/recovery-install.cjs");

export const DAEMON_REPAIR_WAIT_MS = 30_000;

export function readDaemonHeartbeat(homeDir = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(liveness.daemonHeartbeatPath(homeDir), "utf8"));
  } catch {
    return null;
  }
}

function failure(reason, detail = "") {
  return { ok: false, reason, detail: detail ? String(detail) : "" };
}

/**
 * Register what is missing, start the daemon, and wait for its heartbeat.
 * Returns { ok, reason, detail, registered, restart }. Never throws: the pill
 * reports the outcome, it does not roll anything back.
 */
export async function repairDaemonService({
  platform = process.platform,
  homeDir = os.homedir(),
  bin = relayBinPath(),
  node = stableNodePath(),
  env = process.env,
  log = () => {},
  now = Date.now,
  // Sync runner for registration (install.js's own by default) and the
  // verified async restart; both injectable so tests never touch a supervisor.
  runCommand,
  restart = restartRelayServices,
  installDaemon = installDaemonAutostart,
  installPill = installPillAutostart,
  installRecoveryImpl = installRecovery,
  taskStatus = windowsAutostartTaskStatus,
  readHeartbeat = () => readDaemonHeartbeat(homeDir),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = DAEMON_REPAIR_WAIT_MS,
  pollMs = 500,
} = {}) {
  const startedAt = now();
  const runner = runCommand ? { runCommand } : {};
  const shared = { platform, homeDir, reload: false, env, ...runner };
  const registered = {};
  const packageRoot = path.resolve(path.dirname(bin), "..");

  // 1. Registration. On Windows a missing task is the whole story of the
  //    field case, and re-creating a present one with /F is not free, so only
  //    the absent tasks are written. launchd and systemd registrations are a
  //    file each; rewriting them without a reload is harmless.
  let missing = [];
  if (platform === "win32") {
    try {
      const status = taskStatus({ platform, ...runner });
      missing = status.missing;
      if (status.unavailable.length) {
        log(`daemon repair: could not query Scheduled Tasks (${status.unavailable.map((entry) => entry.detail).join("; ")})`);
      }
    } catch (error) {
      log(`daemon repair: Scheduled Task query threw: ${error?.message || error}`);
    }
  }
  const daemonMissing = platform !== "win32" || missing.some((name) => /daemon/i.test(name));
  const pillMissing = platform === "win32" && missing.some((name) => /pill/i.test(name));
  if (daemonMissing) {
    try {
      registered.daemon = installDaemon(bin, node, shared);
    } catch (error) {
      registered.daemon = failure("daemon-registration-threw", error?.message || error);
    }
    if (!registered.daemon?.ok) log(`daemon repair: daemon autostart not registered (${registered.daemon?.reason || "unknown"})`);
  }
  if (pillMissing) {
    // Next logon must bring the pill back too; this pill keeps running.
    try {
      registered.pill = installPill(bin, { ...shared, node });
    } catch (error) {
      registered.pill = failure("pill-registration-threw", error?.message || error);
    }
  }
  try {
    // The five-minute recovery launcher is what would have repaired this on
    // its own, had it survived. Put it back without starting it.
    registered.recovery = installRecoveryImpl({ packageRoot, node, homeDir, platform, reload: false, ...runner });
  } catch (error) {
    registered.recovery = failure("recovery-registration-threw", error?.message || error);
  }

  // 2. Start through the supervisor, verified by the daemon's process.
  let restartResult;
  try {
    restartResult = await restart({ services: ["daemon"], platform });
  } catch (error) {
    restartResult = { daemon: "failed", detail: { daemon: error?.message || String(error) } };
  }
  let started = restartResult.daemon === "restarted";
  if (restartResult.daemon === "not_installed") {
    // Registered a moment ago but not yet loaded by the supervisor (launchd,
    // systemd), or the task write itself failed: load it now.
    try {
      registered.load = installDaemon(bin, node, { ...shared, reload: true });
    } catch (error) {
      registered.load = failure("daemon-load-threw", error?.message || error);
    }
    started = Boolean(registered.load?.ok && registered.load.started !== false);
  }
  if (!started) {
    const detail = restartResult.detail?.daemon || registered.load?.detail || registered.load?.reason || registered.daemon?.detail || registered.daemon?.reason || "";
    log(`daemon repair: the background service did not start (${restartResult.daemon}${detail ? `: ${detail}` : ""})`);
    return { ...failure("daemon-start-failed", detail), registered, restart: restartResult };
  }

  // 3. A heartbeat written after this repair began is the only proof that
  //    counts; a process the supervisor saw for a moment is not.
  const deadline = startedAt + waitMs;
  for (;;) {
    const heartbeat = readHeartbeat();
    if (Number(heartbeat?.at) >= startedAt) {
      log(`daemon repair: background service is back (pid ${heartbeat.pid || "?"})`);
      return { ok: true, reason: "daemon-heartbeat", detail: "", registered, restart: restartResult };
    }
    if (now() > deadline) break;
    await pause(pollMs);
  }
  log("daemon repair: the background service started but never reported a heartbeat");
  return { ...failure("no-heartbeat-after-start"), registered, restart: restartResult };
}
