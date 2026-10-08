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

module.exports = {
  LEGACY_MAC_EXECUTABLE_NAME,
  RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS,
  RELAY_MAC_EXECUTABLE_NAME,
  associatedBundleIdentifiersPlist,
  preferredMacElectronExecutable,
};
