"use strict";
// Recovery is executed by the verified candidate, never by the installation
// being rescued. Keep coordination and the candidate alive during state reset.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ownerEnvironment } = require("./lifecycle-ownership.cjs");

function marker(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("Invalid Relay state file");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Relay state object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code && !["EISDIR"].includes(error.code)) throw error;
    return { invalid: true };
  }
}

function assertLocalPath(homeDir, target) {
  const home = fs.realpathSync(homeDir);
  const relative = path.relative(path.resolve(homeDir), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Recovery path is outside the current user's home");
  let cursor = home;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error("Recovery refuses redirected Relay state paths");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function journalPath(homeDir) { return path.join(homeDir, ".relay", "runtime", "installer-recovery.json"); }
function writeJournal(homeDir, value) {
  const file = journalPath(homeDir), temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function resetState({ homeDir, releaseRoot, profileDirs = [] }) {
  const runtime = path.join(homeDir, ".relay", "runtime");
  if (path.dirname(releaseRoot) !== path.join(runtime, "releases")) throw Error("Invalid recovery candidate root");
  const roots = [path.join(homeDir, ".relay"), path.join(homeDir, ".relay-companion"), ...profileDirs];
  const keep = [releaseRoot, path.join(runtime, "transaction.lock"), journalPath(homeDir)];
  for (const target of [...roots, ...keep]) assertLocalPath(homeDir, target);
  // Validate every root before deleting any of them. Never traverse a link in
  // the tree: rm removes that directory entry, not its target.
  function remove(target) {
    if (keep.includes(target)) return;
    if (keep.some(file => file.startsWith(`${target}${path.sep}`))) {
      if (!fs.existsSync(target)) return;
      for (const child of fs.readdirSync(target)) remove(path.join(target, child));
      return;
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  for (const target of roots) remove(target);
}

function recoverWithCandidate({ bundle, runtime, releaseRoot, homeDir, run = spawnSync }) {
  const script = path.join(runtime.packageRoot, "src", "application-recovery.js");
  if (!fs.existsSync(script)) throw Error("This runtime does not support installer recovery; download a newer installer");
  const env = ownerEnvironment({ homeDir });
  // Native recovery always addresses the signed-in OS user's normal Relay.
  for (const key of Object.keys(env)) {
    if (/^RELAY_(CONFIG|HOME|COMPANION_HOME|NATIVE_CREDENTIALS)/.test(key)
      || ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(key)) delete env[key];
  }
  const result = run(bundle.node, [script, releaseRoot], { env, encoding: "utf8", windowsHide: true, timeout: 180_000 });
  if (result.error || result.status !== 0) throw Error(`Relay recovery stopped. Run this installer again to retry. ${String(result.error?.message || result.stderr || "Cleanup did not complete").slice(0, 500)}`);
  if (marker(journalPath(homeDir))?.deviceRetirement === "needs-account-review") {
    console.warn("The old device could not be retired online. After signing in, remove its old registration in Relay Settings > Devices.");
  }
}

module.exports = { marker, assertLocalPath, journalPath, writeJournal, resetState, recoverWithCandidate };
