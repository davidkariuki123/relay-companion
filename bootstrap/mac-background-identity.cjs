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

function stablePillLink(homeDir) {
  return path.join(homeDir, ...STABLE_PILL_BUNDLE);
}

// Re-point the link at `bundle` atomically. A real directory at the link path
// is never replaced: false means the link could not be (and was not) changed.
function pointStablePillLink(bundle, { homeDir, fsImpl = fs, pid = process.pid } = {}) {
  const link = stablePillLink(homeDir);
  const existing = fsImpl.lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) return false;
  if (existing && fsImpl.readlinkSync(link) === bundle) return true;
  fsImpl.mkdirSync(path.dirname(link), { recursive: true });
  const temporary = `${link}.${pid}.tmp`;
  try { fsImpl.unlinkSync(temporary); } catch {}
  fsImpl.symlinkSync(bundle, temporary, "dir");
  fsImpl.renameSync(temporary, link);
  return true;
}

function stablePillExecutable(electronExecutable, { homeDir, fsImpl = fs, pid = process.pid } = {}) {
  const value = String(electronExecutable || "");
  if (!homeDir || !value) return electronExecutable;
  const bundle = path.resolve(value, "..", "..", "..");
  if (path.extname(bundle) !== ".app" || path.basename(path.dirname(value)) !== "MacOS") return electronExecutable;
  try {
    if (!pointStablePillLink(bundle, { homeDir, fsImpl, pid })) return electronExecutable;
    const stable = path.join(stablePillLink(homeDir), "Contents", "MacOS", path.basename(value));
    return fsImpl.statSync(stable).isFile() ? stable : electronExecutable;
  } catch {
    return electronExecutable;
  }
}

// The link is ours to rewrite, so a pill plist that launches through it is
// only as good as the Electron bundle of the package it runs. 2026-10-10: a
// rolled-back activation restored the plist but left the link on the failed
// release, cleanup then deleted that release, and every later update refused
// to start because the link no longer resolved. Validate and repair against
// the registered package instead of wherever the link happens to point.
//
// Returns the same executable inside packageRoot's own bundle, or null when
// `executable` does not launch through the link.
function stablePillReleaseExecutable(executable, packageRoot, { homeDir, fsImpl = fs } = {}) {
  if (!homeDir || !packageRoot) return null;
  const prefix = path.join(stablePillLink(homeDir), "Contents", "MacOS") + path.sep;
  const value = String(executable || "");
  if (!value.startsWith(prefix) || value.slice(prefix.length).includes(path.sep)) return null;
  // A real directory there is never re-pointed, so it is checked as it stands.
  const lstat = typeof fsImpl.lstatSync === "function" ? fsImpl.lstatSync.bind(fsImpl) : fs.lstatSync;
  try {
    const existing = lstat(stablePillLink(homeDir), { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) return null;
  } catch { return null; }
  const existsSync = typeof fsImpl.existsSync === "function" ? fsImpl.existsSync.bind(fsImpl) : fs.existsSync;
  const inventory = require("./runtime-executables.cjs").runtimeExecutableInventory(packageRoot, { platform: "darwin", existsSync });
  const bundle = inventory.ok
    ? path.resolve(inventory.electronPath, "..", "..", "..")
    : path.join(packageRoot, "node_modules", "electron", "dist", "Electron.app");
  return path.join(bundle, "Contents", "MacOS", path.basename(value));
}

/**
 * Point the link at the bundle a pill registration runs, before launchd starts
 * it. `record` is a readRegistration result; a plist that names a release path
 * directly needs nothing.
 */
function alignStablePillLink(record, { homeDir, fsImpl = fs } = {}) {
  if (!record?.releaseExecutable) return { ok: true, changed: false };
  const bundle = path.resolve(record.releaseExecutable, "..", "..", "..");
  let before = null;
  try { before = fsImpl.readlinkSync(stablePillLink(homeDir)); } catch {}
  if (before === bundle) return { ok: true, changed: false };
  // A real directory there is someone else's; leave it exactly as before.
  if (!pointStablePillLink(bundle, { homeDir, fsImpl })) return { ok: true, changed: false, skipped: "stable-pill-link-not-symlink" };
  return { ok: true, changed: true, from: before, to: bundle };
}

/** Where the link points and whether its executable exists, for doctor and cleanup. */
function inspectStablePillLink({ homeDir, fsImpl = fs } = {}) {
  const link = stablePillLink(homeDir);
  let stat;
  try { stat = fsImpl.lstatSync(link, { throwIfNoEntry: false }); } catch { stat = null; }
  if (!stat) return { present: false, link };
  if (!stat.isSymbolicLink()) return { present: true, symlink: false, link, resolves: true };
  let target = null;
  try { target = fsImpl.readlinkSync(link); } catch {}
  const resolves = [RELAY_MAC_EXECUTABLE_NAME, LEGACY_MAC_EXECUTABLE_NAME].some((name) => {
    try { return fsImpl.statSync(path.join(link, "Contents", "MacOS", name)).isFile(); } catch { return false; }
  });
  return { present: true, symlink: true, link, target, resolves };
}

module.exports = {
  LEGACY_MAC_EXECUTABLE_NAME,
  STABLE_PILL_BUNDLE,
  alignStablePillLink,
  inspectStablePillLink,
  stablePillExecutable,
  stablePillLink,
  stablePillReleaseExecutable,
  RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS,
  RELAY_MAC_EXECUTABLE_NAME,
  associatedBundleIdentifiersPlist,
  preferredMacElectronExecutable,
};
