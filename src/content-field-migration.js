import fs from "node:fs";
import path from "node:path";
import { companionHome, companionStatePath } from "./notifications.js";
import { withJsonLockStrict } from "./state-lock.cjs";

// v4 also repairs stores that were converted once and then overwritten by a
// still-old server response during a rolling deploy. Ingress now canonicalizes
// every packet, but those already reintroduced documents need one final sweep.
export const CONTENT_FIELD_SCHEMA_VERSION = 4;

const LEGACY_HUMAN_FIELD = "body" + "Markdown";
const LEGACY_AGENT_FIELD = "user" + "Instructions";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rename the retired content-lane keys anywhere inside a persisted Relay value.
 * New keys win if an interrupted or hand-edited file happens to contain both.
 */
export function migrateContentValue(value) {
  let changed = false;

  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;

    if (Object.hasOwn(node, LEGACY_HUMAN_FIELD)) {
      if (!Object.hasOwn(node, "forHuman")) node.forHuman = node[LEGACY_HUMAN_FIELD];
      delete node[LEGACY_HUMAN_FIELD];
      changed = true;
    }
    if (Object.hasOwn(node, LEGACY_AGENT_FIELD)) {
      if (!Object.hasOwn(node, "forAgent")) node.forAgent = node[LEGACY_AGENT_FIELD];
      delete node[LEGACY_AGENT_FIELD];
      changed = true;
    }
    for (const child of Object.values(node)) visit(child);
  }

  visit(value);
  if (changed && isRecord(value) && Number.isInteger(value.schemaVersion) && value.schemaVersion < CONTENT_FIELD_SCHEMA_VERSION) {
    value.schemaVersion = CONTENT_FIELD_SCHEMA_VERSION;
  }
  return changed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const mode = (() => {
    try {
      return fs.statSync(filePath).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.fields.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function persistedPacketPaths(state, homeDir) {
  const paths = new Set();
  for (const row of Object.values(state?.packets || {})) {
    if (!isRecord(row)) continue;
    for (const field of ["contentPath", "filePath"]) {
      const candidate = row[field];
      if (typeof candidate === "string" && candidate.trim()) paths.add(path.resolve(candidate));
    }
  }
  const packetsDir = path.join(homeDir, "packets");
  try {
    for (const name of fs.readdirSync(packetsDir)) {
      if (name.endsWith(".json")) paths.add(path.join(packetsDir, name));
    }
  } catch {}
  return [...paths];
}

/**
 * One-time startup migration for the companion's durable cache. Every JSON file
 * is replaced with an atomic rename; the state marker is written last, so a
 * partial process interruption safely retries on the next startup.
 */
export function migratePersistedContentFields({
  homeDir = companionHome(),
  statePath = companionStatePath(homeDir),
  log = () => {},
} = {}) {
  if (!fs.existsSync(statePath)) return { status: "absent", migratedFiles: 0 };

  const locked = withJsonLockStrict(statePath, () => {
    const state = readJson(statePath);
    if (state.contentFieldSchemaVersion === CONTENT_FIELD_SCHEMA_VERSION) {
      return { status: "current", migratedFiles: 0 };
    }

    let migratedFiles = 0;
    for (const packetPath of persistedPacketPaths(state, homeDir)) {
      if (!fs.existsSync(packetPath)) continue;
      const packet = readJson(packetPath);
      if (!migrateContentValue(packet)) continue;
      writeJsonAtomic(packetPath, packet);
      migratedFiles += 1;
    }

    migrateContentValue(state);
    state.contentFieldSchemaVersion = CONTENT_FIELD_SCHEMA_VERSION;
    writeJsonAtomic(statePath, state);
    migratedFiles += 1;
    return { status: "migrated", migratedFiles };
  });

  if (!locked.ok) {
    log(`content-field migration deferred (${locked.reason})`);
    return { status: "deferred", migratedFiles: 0, reason: locked.reason };
  }
  if (locked.value.status === "migrated") {
    log(`migrated ${locked.value.migratedFiles} persisted Relay content file(s) to schema ${CONTENT_FIELD_SCHEMA_VERSION}`);
  }
  return locked.value;
}
