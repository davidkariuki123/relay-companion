// The pill observes service health; only independent recovery mutates services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import recovery from "../bootstrap/recovery-client.cjs";
import liveness from "./pill-liveness.cjs";

export const DAEMON_REPAIR_WAIT_MS = 30_000;
export function readDaemonHeartbeat(homeDir = os.homedir()) {
  try { return JSON.parse(fs.readFileSync(liveness.daemonHeartbeatPath(homeDir), "utf8")); } catch { return null; }
}
export async function repairDaemonService({ homeDir = os.homedir(), platform = process.platform,
  packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  log = () => {}, now = Date.now, request = recovery.requestRecoveryAsync,
  readHeartbeat = () => readDaemonHeartbeat(homeDir),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = DAEMON_REPAIR_WAIT_MS, pollMs = 500,
} = {}) {
  const startedAt = now();
  let result;
  try { result = await request({ homeDir, platform, packageRoot, reason: "daemon-unresponsive" }); }
  catch (error) { result = { ok: false, reason: "recovery-request-failed", detail: error.message }; }
  if (!result.ok) { log("daemon recovery: " + result.reason); return result; }
  for (let elapsed = 0; elapsed < waitMs; elapsed += Math.max(1, pollMs)) {
    const heartbeat = readHeartbeat();
    if (Number(heartbeat?.at) >= startedAt && liveness.daemonHeartbeatIsFresh(heartbeat, { now: now() })) {
      log("daemon recovery: background service is responsive");
      return { ok: true, reason: "daemon-heartbeat" };
    }
    await pause(pollMs);
  }
  // A queued request is not a failed repair. Recovery may be preserving active
  // work or proving a candidate; the pill must not start a competing repair.
  return { ok: false, pending: true, reason: "recovery-pending", detail: "The background service is being checked by Relay recovery." };
}
