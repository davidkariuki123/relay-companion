"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const { acquireCanonicalLock } = require("./recovery-launcher.cjs");
const channels = ["stable", "dev", "staging"];
function settings(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const updateChannel = [undefined, null, ""].includes(config.updateChannel) ? "stable" : config.updateChannel;
  if (!channels.includes(updateChannel)) return null;
  const result = { updateChannel };
  for (const key of ["apiUrl", "webUrl"]) {
    if ([undefined, null, ""].includes(config[key])) continue;
    if (typeof config[key] !== "string") return null;
    try {
      const url = new URL(config[key]);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    } catch { return null; }
    result[key] = config[key];
  }
  return result;
}
const configSource = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const backupFile = file => path.join(path.dirname(file), "recovery", "config-" + crypto.createHash("sha256").update(configSource(file)).digest("hex") + ".json");
function rememberConfig(file, config) {
  const value = settings(config);
  if (!value) return false;
  // Recovery needs routing, not account authority. Never copy a device token or
  // credential pointer: restoring this file cannot undo sign-out/account switch.
  const bytes = JSON.stringify({ schema: 1, source: configSource(file), settings: value });
  const backup = backupFile(file);
  try { if (fs.readFileSync(backup, "utf8") === bytes) return true; } catch {}
  atomicFile(backup, bytes);
  return true;
}
function configLock(file) { return acquireCanonicalLock(file + ".recovery-lock"); }
function loadRecoveryConfig(file) {
  let lock;
  try {
    lock = configLock(file);
    let bytes = null, config = null;
    try { bytes = fs.readFileSync(file, "utf8"); config = JSON.parse(bytes); }
    catch (error) { if (error.code && error.code !== "ENOENT") throw error; }
    if (settings(config)) {
      // A backup write failure must not hide an otherwise usable live config.
      try { rememberConfig(file, config); } catch {}
      return { config, restored: false };
    }
    const backup = JSON.parse(fs.readFileSync(backupFile(file), "utf8"));
    const restored = settings(backup?.settings);
    if (backup?.schema !== 1 || backup.source !== configSource(file) || !restored
      || !channels.includes(backup.settings?.updateChannel)) throw Error("recovery-settings-invalid");
    // Preserve damaged evidence before replacing it. Both the recovery reader
    // and normal config writer hold this lock, so a successful user write wins.
    if (bytes !== null) atomicFile(file + ".damaged-" + crypto.randomUUID(), bytes);
    atomicFile(file, JSON.stringify(restored));
    return { config: restored, restored: true };
  } catch (error) { return { config: null, restored: false, reason: error.message }; }
  finally { lock?.release(); }
}
module.exports = { settings, backupFile, rememberConfig, configLock, loadRecoveryConfig };
