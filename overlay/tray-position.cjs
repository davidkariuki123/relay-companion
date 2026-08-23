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
  positionKey = RELAY_TRAY_POSITION_KEY,
  defaultPosition = RELAY_TRAY_DEFAULT_POSITION,
  log = (message) => console.error(message),
} = {}) {
  if (platform !== "darwin") return { prepared: false, reason: "not-darwin" };
  let migrated = false;
  try {
    const existing = readDomainValue(RELAY_MAC_BUNDLE_IDENTIFIER, positionKey);
    const legacy = existing?.status === "missing"
      ? readDomainValue(RELAY_LEGACY_MAC_BUNDLE_IDENTIFIER, positionKey)
      : null;
    migrated = existing?.status === "missing" && legacy?.status === "found" && Number.isFinite(legacy.value);
    if (migrated) {
      // setUserDefault writes to this process's Relay-branded suite. It runs
      // before Tray construction and only when the destination has no value.
      systemPreferences.setUserDefault(positionKey, "double", legacy.value);
    }
  } catch (error) {
    migrated = false;
    log(`[overlay] could not migrate menu-bar position: ${error && error.message ? error.message : error}`);
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
    };
  } catch (error) {
    log(`[overlay] could not register menu-bar position default: ${error && error.message ? error.message : error}`);
    // Ordering is a recoverability enhancement, not permission to suppress the
    // only passive way back into Relay. Tray creation must still proceed.
    return { prepared: false, reason: "preparation-failed" };
  }
}

function destroyMacTrayPreservingPosition({
  platform = process.platform,
  tray,
  systemPreferences,
  positionKey = RELAY_TRAY_POSITION_KEY,
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

module.exports = {
  RELAY_TRAY_DEFAULT_POSITION,
  RELAY_TRAY_GUID,
  RELAY_TRAY_POSITION_KEY,
  destroyMacTrayPreservingPosition,
  prepareMacTrayPosition,
  readMacDefaultsNumber,
};
