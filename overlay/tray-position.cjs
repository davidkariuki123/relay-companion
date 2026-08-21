// macOS assigns a status item's initial ordering when NSStatusBar creates it.
// Electron exposes the documented autosave identity through Tray's GUID, but
// AppKit has no public ordering API. The private preferred-position default is
// therefore registered for this process before Tray construction. Registration
// is intentionally non-persistent: an existing value created by Cmd-dragging
// wins, while a new machine receives the least-overflow-prone initial position.

const RELAY_TRAY_GUID = "2aa0aef7-8c43-4644-b96d-2c5ba95a0232";
const RELAY_TRAY_DEFAULT_POSITION = 0;
const RELAY_TRAY_POSITION_KEY = `NSStatusItem Preferred Position ${RELAY_TRAY_GUID}`;
const {
  RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER,
  RELAY_MAC_BUNDLE_IDENTIFIER,
} = require("../src/mac-app-identity.cjs");
const { execFileSync: defaultExecFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteJsonSync } = require("../src/atomic-json.cjs");

const RELAY_TRAY_POSITION_CACHE_SCHEMA = 1;
const RELAY_TRAY_POSITION_CACHE_FILE = "tray-position.json";

function resolveMacTrayPositionCachePath({
  env = process.env,
  homeDir = os.homedir(),
  relayHome,
} = {}) {
  const root = relayHome
    || env.RELAY_HOME
    || env.RELAY_COMPANION_HOME
    || path.join(homeDir, ".relay-companion");
  return path.join(root, RELAY_TRAY_POSITION_CACHE_FILE);
}

function readMacTrayPositionCache(cachePath, { fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(cachePath, "utf8"));
    if (
      parsed?.schema !== RELAY_TRAY_POSITION_CACHE_SCHEMA
      || parsed?.guid !== RELAY_TRAY_GUID
      || ![RELAY_MAC_BUNDLE_IDENTIFIER, RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER].includes(parsed?.sourceDomain)
      || !Number.isFinite(parsed?.position)
    ) return { status: "error" };
    return { status: "found", value: parsed.position };
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "error" };
  }
}

function writeMacTrayPositionCache(cachePath, position, {
  atomicWriteJson = atomicWriteJsonSync,
  now = () => new Date(),
  sourceDomain = RELAY_MAC_BUNDLE_IDENTIFIER,
} = {}) {
  if (!Number.isFinite(position)) return { cached: false, reason: "position-invalid" };
  if (![RELAY_MAC_BUNDLE_IDENTIFIER, RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER].includes(sourceDomain)) {
    return { cached: false, reason: "source-domain-invalid" };
  }
  try {
    atomicWriteJson(cachePath, {
      schema: RELAY_TRAY_POSITION_CACHE_SCHEMA,
      guid: RELAY_TRAY_GUID,
      position,
      capturedAt: now().toISOString(),
      sourceDomain,
    }, { mode: 0o600 });
    return { cached: true, value: position, path: cachePath };
  } catch (error) {
    return {
      cached: false,
      reason: "cache-write-failed",
      detail: error && error.message ? error.message : String(error),
    };
  }
}

function readMacDefaultsNumber(domain, key, {
  execFileSync = defaultExecFileSync,
  env = process.env,
} = {}) {
  try {
    const raw = execFileSync("/usr/bin/defaults", ["read", domain, key], {
      encoding: "utf8",
      env: { ...env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return { status: "error" };
    const value = Number(raw);
    return Number.isFinite(value) ? { status: "found", value } : { status: "error" };
  } catch (error) {
    const stderr = String(error && error.stderr ? error.stderr : "");
    return /does not exist/i.test(stderr) ? { status: "missing" } : { status: "error" };
  }
}

function prepareMacTrayPosition({
  platform = process.platform,
  systemPreferences,
  readDomainValue = () => ({ status: "error" }),
  readCachedValue = () => ({ status: "missing" }),
  positionKey = RELAY_TRAY_POSITION_KEY,
  defaultPosition = RELAY_TRAY_DEFAULT_POSITION,
  log = (message) => console.error(message),
} = {}) {
  if (platform !== "darwin") return { prepared: false, reason: "not-darwin" };
  let migrated = false;
  let restoredFrom = null;
  try {
    const existing = readDomainValue(RELAY_MAC_BUNDLE_IDENTIFIER, positionKey);
    if (existing?.status === "missing") {
      const cached = readCachedValue();
      if (cached?.status === "found" && Number.isFinite(cached.value)) {
        systemPreferences.setUserDefault(positionKey, "double", cached.value);
        restoredFrom = "cache";
      } else if (cached?.status === "missing") {
        const legacy = readDomainValue(RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER, positionKey);
        migrated = legacy?.status === "found" && Number.isFinite(legacy.value);
        if (migrated) {
          systemPreferences.setUserDefault(positionKey, "double", legacy.value);
          restoredFrom = "legacy";
        }
      }
    }
    if (restoredFrom === "legacy") {
      // setUserDefault writes to this process's Relay-branded suite. It runs
      // before Tray construction and only when the destination has no value.
      migrated = true;
    }
  } catch (error) {
    migrated = false;
    restoredFrom = null;
    log(`[overlay] could not restore menu-bar position: ${error && error.message ? error.message : error}`);
  }
  try {
    systemPreferences.registerDefaults({
      [positionKey]: defaultPosition,
    });
    return {
      prepared: true,
      key: positionKey,
      value: defaultPosition,
      migrated,
      restoredFrom,
    };
  } catch (error) {
    log(`[overlay] could not register menu-bar position default: ${error && error.message ? error.message : error}`);
    // Ordering is a recoverability enhancement, not permission to suppress the
    // only passive way back into Relay. Tray creation must still proceed.
    return { prepared: false, reason: "preparation-failed" };
  }
}

function snapshotMacTrayPosition({
  platform = process.platform,
  cachePath = resolveMacTrayPositionCachePath(),
  readDomainValue = readMacDefaultsNumber,
  readCachedValue = () => readMacTrayPositionCache(cachePath),
  writeCachedValue = (value, sourceDomain) => writeMacTrayPositionCache(
    cachePath,
    value,
    { sourceDomain },
  ),
  positionKey = RELAY_TRAY_POSITION_KEY,
} = {}) {
  if (platform !== "darwin") return { ok: true, snapshotted: false, reason: "not-darwin" };
  let sourceDomain = RELAY_MAC_BUNDLE_IDENTIFIER;
  let current = readDomainValue(sourceDomain, positionKey);
  if (current?.status === "missing") {
    const cached = readCachedValue();
    if (cached?.status === "found" && Number.isFinite(cached.value)) {
      return { ok: true, snapshotted: false, reason: "cache-current", value: cached.value, cachePath };
    }
    if (cached?.status !== "missing") {
      return { ok: false, snapshotted: false, reason: "cache-read-failed" };
    }
    // A device may update directly from the last generic-Electron build. The
    // old updater will delete that legacy key moments later, so capture it now.
    sourceDomain = RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER;
    current = readDomainValue(sourceDomain, positionKey);
    if (current?.status === "missing") {
      return { ok: true, snapshotted: false, reason: "position-missing" };
    }
  }
  if (current?.status !== "found" || !Number.isFinite(current.value)) {
    return { ok: false, snapshotted: false, reason: "position-read-failed" };
  }
  const cached = writeCachedValue(current.value, sourceDomain);
  if (!cached?.cached) {
    return {
      ok: false,
      snapshotted: false,
      reason: cached?.reason || "cache-write-failed",
      detail: cached?.detail,
    };
  }
  return { ok: true, snapshotted: true, value: current.value, sourceDomain, cachePath };
}

function destroyMacTrayPreservingPosition({
  platform = process.platform,
  tray,
  systemPreferences,
  positionKey = RELAY_TRAY_POSITION_KEY,
  writeCachedValue,
  log = (message) => console.error(message),
} = {}) {
  if (platform !== "darwin") return { preserved: false, reason: "not-darwin" };
  if (!tray || (typeof tray.isDestroyed === "function" && tray.isDestroyed())) {
    return { preserved: false, reason: "tray-unavailable" };
  }
  let value;
  try {
    value = systemPreferences.getUserDefault(positionKey, "double");
    if (!Number.isFinite(value)) return { preserved: false, reason: "position-unavailable" };
  } catch (error) {
    log(`[overlay] could not read menu-bar position before exit: ${error && error.message ? error.message : error}`);
    return { preserved: false, reason: "position-read-failed" };
  }
  if (typeof writeCachedValue === "function") {
    const cached = writeCachedValue(value);
    if (!cached?.cached) {
      log(`[overlay] could not cache menu-bar position before exit: ${cached?.detail || cached?.reason || "unknown error"}`);
    }
  }
  try {
    // NSStatusBar.removeStatusItem deletes the named preferred-position key.
    // Destroy deliberately, then restore the exact value before process exit so
    // Electron teardown cannot silently reset a Cmd-dragged user choice.
    tray.destroy();
    systemPreferences.setUserDefault(positionKey, "double", value);
    return { preserved: true, value };
  } catch (error) {
    // A partial destroy may already have deleted the key; make one final restore
    // attempt even when Electron reports an error.
    try { systemPreferences.setUserDefault(positionKey, "double", value); } catch {}
    log(`[overlay] could not preserve menu-bar position during exit: ${error && error.message ? error.message : error}`);
    return { preserved: false, reason: "position-restore-failed" };
  }
}

function installMacTrayPositionSignalHandlers({
  platform = process.platform,
  processLike = process,
  app,
  preserve,
  log = (message) => console.error(message),
} = {}) {
  if (platform !== "darwin") return { installed: false, reason: "not-darwin" };
  let exiting = false;
  const handleSignal = (signal) => {
    if (exiting) return;
    exiting = true;
    try {
      preserve();
    } catch (error) {
      log(`[overlay] could not preserve menu-bar position on ${signal}: ${error && error.message ? error.message : error}`);
    } finally {
      app.exit(0);
    }
  };
  processLike.once("SIGTERM", () => handleSignal("SIGTERM"));
  processLike.once("SIGINT", () => handleSignal("SIGINT"));
  return { installed: true, handleSignal };
}

module.exports = {
  RELAY_TRAY_DEFAULT_POSITION,
  RELAY_TRAY_GUID,
  RELAY_TRAY_POSITION_CACHE_FILE,
  RELAY_TRAY_POSITION_CACHE_SCHEMA,
  RELAY_TRAY_POSITION_KEY,
  destroyMacTrayPreservingPosition,
  installMacTrayPositionSignalHandlers,
  prepareMacTrayPosition,
  readMacTrayPositionCache,
  readMacDefaultsNumber,
  resolveMacTrayPositionCachePath,
  snapshotMacTrayPosition,
  writeMacTrayPositionCache,
};
