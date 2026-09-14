"use strict";

// The installation key names one Relay installation on one machine.
//
// Relay's server revokes an account's earlier devices that carry the same key
// when a new device registers, so re-pairing the same computer replaces its
// previous device instead of leaving a second live token behind. That makes
// the key's one job to be DIFFERENT on every genuinely different device:
//
//   - installation-id.json alone is not enough. It lives in the home folder, so
//     a VM cloned from a laptop, or a home folder restored onto a new computer,
//     carries a copy. Two live machines would then revoke each other.
//   - The operating system's machine identifier tells those copies apart:
//     Windows MachineGuid, the macOS hardware UUID, Linux /etc/machine-id.
//     Every VM and WSL distribution has its own.
//   - On Windows and Linux the hostname is mixed in as well, because a VM
//     cloned without sysprep, or a Linux image cloned before first boot, can
//     keep the source machine identifier. A clone on the same network must be
//     renamed anyway. macOS is left out: its hostname changes with the network
//     (for example "Davids-MacBook-Pro.local" becoming a DHCP name).
//
// When the machine identifier cannot be read there is no key, and the server
// merges nothing. Failing that way can leave a stale device listed; it can
// never revoke a real one.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { installationId } = require("../bootstrap/installation-health.cjs");

const INSTALLATION_KEY_PATTERN = /^ik_[a-f0-9]{40}$/;

function runCommand(command, args, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout || ""));
      });
    } catch {
      resolve(null);
    }
  });
}

async function machineIdentifier({
  platform = process.platform,
  env = process.env,
  run = runCommand,
  readFile = fs.readFileSync,
} = {}) {
  if (platform === "win32") {
    const reg = path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
    const out = await run(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const guid = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(out || "")?.[1];
    return guid ? guid.toLowerCase() : null;
  }
  if (platform === "darwin") {
    const out = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const uuid = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(out || "")?.[1];
    return uuid ? uuid.toLowerCase() : null;
  }
  if (platform === "linux") {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = String(readFile(file, "utf8")).trim().toLowerCase();
        if (/^[a-f0-9]{32}$/.test(id)) return id;
      } catch {}
    }
  }
  return null;
}

/**
 * This installation's key, or null when the machine cannot be identified.
 * Never throws: pairing must not fail because the key could not be derived.
 */
async function installationKey({
  homeDir = os.homedir(),
  platform = process.platform,
  hostname = os.hostname(),
  env = process.env,
  run = runCommand,
  readFile = fs.readFileSync,
  readInstallationId = installationId,
} = {}) {
  try {
    const id = readInstallationId({ homeDir, create: true });
    if (!id) return null;
    const machine = await machineIdentifier({ platform, env, run, readFile });
    if (!machine) return null;
    const host = platform === "darwin" ? "" : String(hostname || "").trim().toLowerCase();
    const digest = crypto
      .createHash("sha256")
      .update(["relay-installation-key-v1", platform, id, machine, host].join("\n"))
      .digest("hex");
    return `ik_${digest.slice(0, 40)}`;
  } catch {
    return null;
  }
}

module.exports = { INSTALLATION_KEY_PATTERN, installationKey, machineIdentifier };
