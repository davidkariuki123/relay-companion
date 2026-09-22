import os from "node:os";
import { createRequire } from "node:module";
import recovery from "../bootstrap/recovery-client.cjs";

const require = createRequire(import.meta.url);
const liveness = require("./pill-liveness.cjs");
const { read } = require("../bootstrap/recovery-launcher.cjs");

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

/**
 * The daemon watches the pill's heartbeat (overlay/main.cjs writes it from the
 * main process every 5 s) and restarts the pill through the platform supervisor
 * when the process is alive but has gone silent. Recovery only ever watched the
 * daemon; a pill frozen by memory starvation was invisible to everything until
 * a person noticed. Restart is allowed under memory pressure on purpose: it
 * gives memory back rather than taking more.
 */
export function startPillSupervisor({ homeDir = os.homedir(), now = Date.now, setIntervalImpl = setInterval,
  intervalMs = 30_000, log = () => {}, restart = () => recovery.requestRecoveryAsync({ homeDir, reason: "pill-unresponsive" }), isAlive = processAlive } = {}) {
  let lastRestartAt = 0;
  let pending = false;
  const tick = async () => {
    if (pending) return { action: "none", reason: "pending" };
    const heartbeat = read(liveness.pillHeartbeatPath(homeDir));
    const decision = liveness.pillSupervisorDecision({ heartbeat, now: now(), alive: heartbeat ? isAlive(heartbeat.pid) : false, lastRestartAt });
    if (decision.action !== "restart") return decision;
    pending = true;
    lastRestartAt = now();
    log(`pill supervisor: the Relay app has not reported for ${Math.round(decision.ageMs / 1000)}s while still running (worst stall ${Number(heartbeat.worstStallMs) || 0}ms); requesting independent recovery`);
    try {
      const result = await restart();
      log(`pill supervisor: recovery ${result?.reason || "unknown"}`);
    } catch (error) {
      log(`pill supervisor: restart failed: ${error?.message || error}`);
    } finally {
      pending = false;
    }
    return decision;
  };
  const timer = setIntervalImpl(() => { void tick().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { timer, tick };
}
