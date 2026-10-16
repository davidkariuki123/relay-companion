import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function relayCompanionHome(env = process.env, homeDir = os.homedir()) {
  return env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.join(homeDir, ".relay-companion");
}

export function pillStatusPath(env = process.env, homeDir = os.homedir()) {
  return path.join(relayCompanionHome(env, homeDir), "pill-status.json");
}

export function readPillStatus(file = pillStatusPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// How long `relay pill` waits for the pill to confirm it is on screen. The
// Relay app in the Start menu or Applications runs this command and gives up
// on it after 20 seconds (open-relay.cjs, every launcher up to 0.1.634), then
// shows its installer window although Relay is installed (Shane, 2026-10-16:
// a pill held up for 87 seconds by a busy laptop). A pill that is only slow
// often confirms within that window, so wait for as much of it as is left,
// counted from when this process started and leaving time to exit.
export const PILL_READY_DEADLINE_MS = 18_000;
export function pillReadyTimeoutMs(uptimeMs = process.uptime() * 1000) {
  return Math.max(6_000, Math.round(PILL_READY_DEADLINE_MS - uptimeMs));
}

export async function waitForPillReady(
  reopenNonce,
  {
    file = pillStatusPath(),
    timeoutMs = 12_000,
    intervalMs = 100,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readStatus = readPillStatus,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let lastStatus = null;
  while (now() <= deadline) {
    lastStatus = readStatus(file);
    if (
      lastStatus &&
      lastStatus.ready === true &&
      lastStatus.visible === true &&
      lastStatus.dismissed === false &&
      (lastStatus.reopenNonce === reopenNonce || (Array.isArray(lastStatus.presentedReopens) && lastStatus.presentedReopens.includes(reopenNonce)))
    ) {
      return { ok: true, status: lastStatus };
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: "pill_ready_timeout", status: lastStatus, file };
}
