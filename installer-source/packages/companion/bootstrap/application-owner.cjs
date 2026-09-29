"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APPLICATION_ID = "work.relay.application";
function readObject(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Invalid application marker");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function compatibleReceipt(owner, receipt) {
  const previousVersion = owner.applicationVersion || owner.version;
  const installedVersion = receipt.applicationVersion || receipt.version;
  if (![previousVersion, installedVersion].every((value) => /^\d+\.\d+\.\d+$/.test(value || ""))
    || !/^[a-f0-9]{40}$/.test(receipt.packagingSourceSha || "")) return false;
  const previous = previousVersion.split(".").map(BigInt);
  const installed = installedVersion.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (installed[index] !== previous[index]) return installed[index] > previous[index];
  }
  return receipt.packagingSourceSha === owner.packagingSourceSha;
}

// Only the native installer writes this marker. Older installations have no
// marker and retain exactly their existing launcher and repair behaviour.
function applicationOwner({ homeDir = os.homedir(), platform = process.platform } = {}) {
  try {
    const owner = readObject(path.join(homeDir, ".relay", "application-owner.json"));
    try {
      const removed = readObject(path.join(homeDir, ".relay", "application-uninstall.json"));
      if (removed.schema === 1 && removed.state === "complete" && removed.installationId === owner.installationId) return null;
    } catch { /* No completed removal: validate the existing ownership normally. */ }
    if (owner.schema !== 1 || owner.appId !== APPLICATION_ID || owner.platform !== platform
      || owner.updateOwner !== "canonical-runtime" || !/^[a-f0-9-]{36}$/.test(owner.installationId || "")
      || ![owner.root, owner.executable, owner.receipt].every((value) => typeof value === "string" && path.isAbsolute(value))) return null;
    const root = fs.realpathSync(owner.root);
    if (!within(root, fs.realpathSync(owner.executable)) || !within(root, fs.realpathSync(owner.receipt))
      || !fs.statSync(owner.executable).isFile()) return null;
    const receipt = readObject(owner.receipt);
    if (receipt.schema !== 1 || receipt.distribution !== "application" || receipt.appId !== APPLICATION_ID
      || receipt.activationEnabled !== true || receipt.platform !== `${platform}-${process.arch}`
      || !compatibleReceipt(owner, receipt)) return null;
    if (platform === "darwin" && !root.endsWith(".app")) return null;
    // A native package upgrade replaces its receipt before its first launch.
    // Retain launcher ownership during that interval, without rewriting the
    // recorded activation provenance or accepting a package downgrade.
    return { ...owner, root, installedPackageVersion: receipt.applicationVersion || receipt.version,
      installedPackagingSourceSha: receipt.packagingSourceSha };
  } catch { return null; }
}

module.exports = { applicationOwner, APPLICATION_ID };
