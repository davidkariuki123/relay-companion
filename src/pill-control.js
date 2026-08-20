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
      lastStatus.reopenNonce === reopenNonce
    ) {
      return { ok: true, status: lastStatus };
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: "pill_ready_timeout", status: lastStatus, file };
}
