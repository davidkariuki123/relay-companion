import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { updateChannel } from "./config.js";
import { storeDir } from "./host-paths.js";
import { readCanonicalRuntimeState } from "./canonical-runtime.js";

const require = createRequire(import.meta.url);
const relaySkill = require("../bootstrap/relay-skill.cjs");
const { collectInstallationHealth } = require("../bootstrap/installation-health.cjs");

export const COMPANION_TELEMETRY_SCHEMA = 1;
export const COMPANION_TELEMETRY_HEADER = "x-relay-companion-telemetry";
const TELEMETRY_CACHE_MS = 30_000;
const FAILURE_SLOTS = [
  ["failure", "update"],
  ["migrationFailure", "migration"],
  ["recoveryFailure", "recovery"],
  ["autostartRepointFailure", "autostart_repoint"],
];

function isoFromMillis(value) {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  try { return new Date(millis).toISOString(); } catch { return null; }
}

function cleanVersion(value) {
  const version = String(value || "").trim().slice(0, 40);
  return version || null;
}

function readObject(file, readFileSync) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function failureTelemetry(updateState) {
  const failures = [];
  for (const [slot, kind] of FAILURE_SLOTS) {
    const value = updateState?.[slot];
    const count = Number(value?.count);
    if (!value || !Number.isFinite(count) || count <= 0) continue;
    failures.push({
      kind,
      target: String(value.target || "").trim().slice(0, 80),
      count: Math.min(1_000_000, Math.floor(count)),
      firstAt: isoFromMillis(value.firstAt),
      lastAt: isoFromMillis(value.lastAt),
    });
  }
  return failures;
}

function autoUpdateEnabled(env) {
  const raw = String(env?.RELAY_AUTO_UPDATE ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function optionalIso(value) {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Inspect only Relay-owned metadata and hashes; never include local paths. */
function managedSkillTelemetry({ homeDir, env }) {
  return relaySkill.defaultTargets({ homeDir, env }).map((target) => {
    const state = relaySkill.readState(target.directory);
    const exists = fs.existsSync(target.directory);
    const changed = exists ? relaySkill.localChanges(target.directory, state) : [];
    return {
      name: "relay",
      host: target.host,
      target: target.target || "primary",
      ...(state && /^ski_[A-Za-z0-9_-]{20,80}$/.test(String(state.installationId || "")) ? { installationId: state.installationId } : {}),
      version: state && /^\d+\.\d+\.\d+$/.test(String(state.version || "")) ? state.version : null,
      consentVersion: Number.isSafeInteger(state?.consentVersion) && state.consentVersion > 0 ? state.consentVersion : null,
      status: !exists ? "absent" : !state ? "unmanaged" : changed.length ? "modified" : "managed",
      installedAt: optionalIso(state?.installedAt),
    };
  });
}

/** Collect only the state needed to identify and support a stranded updater. */
export function collectCompanionFleetTelemetry({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  channel = updateChannel(),
  updateStatePath = path.join(storeDir(), "update-state.json"),
  readFileSync = fs.readFileSync,
  collectHealth = collectInstallationHealth,
} = {}) {
  const canonical = readCanonicalRuntimeState({ homeDir, platform, readFileSync });
  const updateState = readObject(updateStatePath, readFileSync);
  const runtimeState = canonical?.state === "activating" || canonical?.state === "recovery-required"
    ? canonical.state
    : canonical?.active === true
      ? "active"
      : "legacy";
  const stateMillis = canonical?.committedAt || canonical?.updatedAt || canonical?.preparedAt || null;
  return {
    schema: COMPANION_TELEMETRY_SCHEMA,
    channel: ["dev", "staging"].includes(channel) ? channel : "stable",
    autoUpdate: autoUpdateEnabled(env),
    runtimeKind: canonical ? "canonical" : "legacy",
    runtimeState,
    activeVersion: cleanVersion(canonical?.active === true ? canonical.version : canonical?.previous?.version),
    candidateVersion: cleanVersion(canonical?.candidate?.version),
    previousVersion: cleanVersion(canonical?.previous?.version),
    stateChangedAt: isoFromMillis(stateMillis),
    failures: failureTelemetry(updateState),
    skills: managedSkillTelemetry({ homeDir, env }),
    installation: collectHealth({ homeDir, platform }),
  };
}

export function encodeCompanionFleetTelemetry(value) {
  const encode = (report) => Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
  let header = encode(value);
  // Never lose the entire report at the API's 4096-byte header boundary.
  if (header.length > 4096) header = encode({ ...value, installation: undefined });
  return header.length <= 4096 ? header : "";
}

let cachedAt = 0;
let cachedHeader = "";

/** A short-lived cache avoids synchronous filesystem reads on every API call. */
export function companionFleetTelemetryHeader({ now = Date.now, collect = collectCompanionFleetTelemetry } = {}) {
  const timestamp = now();
  if (cachedHeader && timestamp - cachedAt >= 0 && timestamp - cachedAt < TELEMETRY_CACHE_MS) return cachedHeader;
  try {
    cachedHeader = encodeCompanionFleetTelemetry(collect());
    cachedAt = timestamp;
  } catch {
    cachedHeader = "";
    cachedAt = timestamp;
  }
  return cachedHeader;
}

export function resetCompanionFleetTelemetryCache() {
  cachedAt = 0;
  cachedHeader = "";
}
