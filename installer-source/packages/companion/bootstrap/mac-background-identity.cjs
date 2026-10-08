"use strict";

// How macOS names Relay's launch agents.
//
// Background Task Management (Login Items & Extensions, and the "App
// Background Activity" notice it posts when an agent first appears) names a
// legacy launch agent after the code at ProgramArguments[0]:
//
//   - When the plist's AssociatedBundleIdentifiers names an installed app
//     signed by the SAME Team ID as that code, the item shows as that app.
//   - Otherwise a Developer ID signed executable shows as its developer.
//   - An ad-hoc signed executable (no Team ID) shows as the executable's own
//     file name.
//
// Relay's daemon and recovery agents run the Node that ships inside
// /Applications/Relay.app (or a byte-identical copy), signed with the same
// Developer ID team as the app, so associating them with the app shows them as
// "Relay". The pill runs the runtime's ad-hoc signed Electron, which has no Team
// ID, so the association cannot apply to it; its main executable is therefore
// named "Relay" in the runtime artifact. MacOS/Electron stays as a link to it:
// installers, updaters and recovery engines already in the field locate the
// runtime by that path and must keep accepting new runtimes.

const fs = require("node:fs");
const path = require("node:path");
const { APPLICATION_ID } = require("./application-owner.cjs");

const RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS = Object.freeze([APPLICATION_ID]);
const RELAY_MAC_EXECUTABLE_NAME = "Relay";
const LEGACY_MAC_EXECUTABLE_NAME = "Electron";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The launchd plist fragment that files an agent under Relay.app in Login Items. */
function associatedBundleIdentifiersPlist(indent = "") {
  const values = RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS.map((id) => `<string>${xmlEscape(id)}</string>`).join("");
  return `${indent}<key>AssociatedBundleIdentifiers</key><array>${values}</array>`;
}

/**
 * The executable a macOS launch agent should name for an Electron runtime.
 * A Relay-built runtime's bundle executable is MacOS/Relay; MacOS/Electron is
 * only its compatibility link. Stock or older runtimes have MacOS/Electron
 * alone and keep it. Anything that is not a bundle main executable is
 * returned unchanged.
 */
function preferredMacElectronExecutable(electronPath, { existsSync = fs.existsSync, statSync = fs.statSync } = {}) {
  const value = String(electronPath || "");
  if (!value || path.posix.basename(value) !== LEGACY_MAC_EXECUTABLE_NAME) return electronPath;
  const directory = path.posix.dirname(value);
  if (path.posix.basename(directory) !== "MacOS" || path.posix.basename(path.posix.dirname(directory)) !== "Contents") return electronPath;
  const branded = path.posix.join(directory, RELAY_MAC_EXECUTABLE_NAME);
  try {
    if (existsSync(branded) && statSync(branded).isFile()) return branded;
  } catch {}
  return electronPath;
}

// Background Task Management also keys a legacy agent on the PATH at
// ProgramArguments[0]: a new path is a new item, and macOS posts "Relay can run
// in the background" again. The pill's path named its release folder, so every
// update re-posted the notice. Measured in a macOS 26 VM (2026-10-08): a new
// path posts it; the same path re-pointed at a differently signed binary, or
// with different later arguments, does not. The pill therefore launches
// through one link, ~/.relay/runtime/Relay.app, that each install re-points at
// its own Electron bundle. Any failure falls back to the release path (the old
// behaviour), and a real directory at the link path is never replaced.
const STABLE_PILL_BUNDLE = Object.freeze([".relay", "runtime", "Relay.app"]);

function stablePillExecutable(electronExecutable, { homeDir, fsImpl = fs, pid = process.pid } = {}) {
  const value = String(electronExecutable || "");
  if (!homeDir || !value) return electronExecutable;
  const bundle = path.resolve(value, "..", "..", "..");
  if (path.extname(bundle) !== ".app" || path.basename(path.dirname(value)) !== "MacOS") return electronExecutable;
  const link = path.join(homeDir, ...STABLE_PILL_BUNDLE);
  try {
    const existing = fsImpl.lstatSync(link, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) return electronExecutable;
    if (!existing || fsImpl.readlinkSync(link) !== bundle) {
      fsImpl.mkdirSync(path.dirname(link), { recursive: true });
      const temporary = `${link}.${pid}.tmp`;
      try { fsImpl.unlinkSync(temporary); } catch {}
      fsImpl.symlinkSync(bundle, temporary, "dir");
      fsImpl.renameSync(temporary, link);
    }
    const stable = path.join(link, "Contents", "MacOS", path.basename(value));
    return fsImpl.statSync(stable).isFile() ? stable : electronExecutable;
  } catch {
    return electronExecutable;
  }
}

module.exports = {
  LEGACY_MAC_EXECUTABLE_NAME,
  STABLE_PILL_BUNDLE,
  stablePillExecutable,
  RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS,
  RELAY_MAC_EXECUTABLE_NAME,
  associatedBundleIdentifiersPlist,
  preferredMacElectronExecutable,
};
