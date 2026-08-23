import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import atomicJson from "./atomic-json.cjs";
import e2eeIdentityModule from "./e2ee-identity.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { identityPath } = e2eeIdentityModule;

function suffix(identity) {
  return createHash("sha256").update(`${identity.userId}\n${identity.deviceId}`).digest("base64url").slice(0, 24);
}

export function e2eeClaudeControlPaths(identity, options = {}) {
  const root = path.dirname(identityPath(options));
  const account = suffix(identity);
  return {
    intent: path.join(root, `e2ee-claude-intent-${account}.json`),
    status: path.join(root, `e2ee-claude-status-${account}.json`),
  };
}

function readBound(file, identity) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.version === 1 && value.userId === identity.userId && value.deviceId === identity.deviceId
      ? value
      : null;
  } catch { return null; }
}

export function readE2eeClaudeIntent(identity, options = {}) {
  return readBound(e2eeClaudeControlPaths(identity, options).intent, identity);
}

export function readE2eeClaudeStatus(identity, options = {}) {
  return readBound(e2eeClaudeControlPaths(identity, options).status, identity);
}

export function requestE2eeClaudeConnection(identity, options = {}) {
  const requestId = randomBytes(18).toString("base64url");
  const value = {
    version: 1,
    userId: identity.userId,
    deviceId: identity.deviceId,
    enabled: true,
    requestId,
    requestedAt: new Date().toISOString(),
  };
  atomicWriteJsonSync(e2eeClaudeControlPaths(identity, options).intent, value, { mode: 0o600 });
  return value;
}

export function disableE2eeClaudeConnection(identity, options = {}) {
  const current = readE2eeClaudeIntent(identity, options);
  const value = {
    version: 1,
    userId: identity.userId,
    deviceId: identity.deviceId,
    enabled: false,
    requestId: current?.requestId || "",
    requestedAt: new Date().toISOString(),
  };
  atomicWriteJsonSync(e2eeClaudeControlPaths(identity, options).intent, value, { mode: 0o600 });
  return value;
}

export function writeE2eeClaudeStatus(identity, status, options = {}) {
  const value = {
    version: 1,
    userId: identity.userId,
    deviceId: identity.deviceId,
    ready: status?.ready === true,
    endpointUrl: String(status?.endpointUrl || ""),
    handledRequestId: String(status?.handledRequestId || ""),
    enrollmentExpiresAt: String(status?.enrollmentExpiresAt || ""),
    error: String(status?.error || "").slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJsonSync(e2eeClaudeControlPaths(identity, options).status, value, { mode: 0o600 });
  return value;
}

export async function waitForE2eeClaudeConnection(identity, requestId, {
  timeoutMs = 120_000,
  pollMs = 250,
  ...options
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readE2eeClaudeStatus(identity, options);
    if (status?.handledRequestId === requestId) {
      if (status.ready && status.endpointUrl) return status;
      if (status.error) throw new Error(status.error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("Relay is still preparing encrypted Claude access. Try again in a moment.");
}
