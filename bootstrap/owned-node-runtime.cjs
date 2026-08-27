"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function nodeVersionSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 12);
}

function commandOutput(result) {
  return String(result?.stdout ?? result?.out ?? "").trim();
}

function verifiedNodeVersion(executable, { runCommand = spawnSync } = {}) {
  try {
    const result = runCommand(executable, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const ok = result?.ok === true || (!result?.error && result?.status === 0);
    const version = commandOutput(result);
    return ok && nodeVersionSupported(version)
      ? { ok: true, version }
      : { ok: false, version, detail: result?.error?.message || result?.stderr || result?.out || "Node did not start" };
  } catch (error) {
    return { ok: false, version: "", detail: error?.message || String(error) };
  }
}

function lexicalTemporaryNodePath(value, platform) {
  if (platform === "win32" || !value) return false;
  const normalized = path.posix.resolve(String(value).replaceAll("\\", "/"));
  return normalized.startsWith("/tmp/") || normalized.startsWith("/private/tmp/");
}

function isTemporaryNodePath(executable, {
  platform = process.platform,
  realpathSync = fs.realpathSync,
} = {}) {
  if (lexicalTemporaryNodePath(executable, platform)) return true;
  try {
    return lexicalTemporaryNodePath(realpathSync(executable), platform);
  } catch {
    return false;
  }
}

function fileDigest(file, fsImpl) {
  return crypto.createHash("sha256").update(fsImpl.readFileSync(file)).digest("hex");
}

/**
 * Preserve a temporary Node executable inside Relay's canonical runtime.
 * Content addressing makes reuse safe, while an execution check after copying
 * catches incomplete binaries and runtimes that depend on files beside them.
 */
function relayOwnedNodePath(executable, {
  platform = process.platform,
  runtimeRoot = path.join(os.homedir(), ".relay", "runtime"),
  fsImpl = fs,
  runCommand = spawnSync,
  realpathSync = fs.realpathSync,
  isTemporary = isTemporaryNodePath,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!executable || !isTemporary(executable, { platform, realpathSync })) return executable;

  let source;
  try {
    source = realpathSync(executable);
  } catch (error) {
    throw new Error(`Relay could not resolve its temporary Node runtime (${error?.message || error}).`);
  }
  const sourceRuntime = verifiedNodeVersion(source, { runCommand });
  if (!sourceRuntime.ok) {
    throw new Error(`Relay refused an invalid temporary Node runtime (${sourceRuntime.detail || sourceRuntime.version || source}).`);
  }

  let digest;
  try {
    digest = fileDigest(source, fsImpl);
  } catch (error) {
    throw new Error(`Relay could not read its temporary Node runtime (${error?.message || error}).`);
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  const directory = api.join(runtimeRoot, "node", digest);
  const destination = api.join(directory, platform === "win32" ? "node.exe" : "node");

  try {
    if (fileDigest(destination, fsImpl) === digest) {
      const existingRuntime = verifiedNodeVersion(destination, { runCommand });
      if (existingRuntime.ok && existingRuntime.version === sourceRuntime.version) {
        fsImpl.chmodSync(directory, 0o700);
        fsImpl.chmodSync(destination, 0o700);
        return destination;
      }
    }
  } catch {}

  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fsImpl.chmodSync(directory, 0o700);
    const temporary = api.join(directory, `.node-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      fsImpl.writeFileSync(temporary, fsImpl.readFileSync(source), { mode: 0o700, flag: "wx" });
      fsImpl.chmodSync(temporary, 0o700);
      if (fileDigest(temporary, fsImpl) !== digest) throw new Error("the copied executable failed its integrity check");
      fsImpl.rmSync(destination, { force: true });
      fsImpl.renameSync(temporary, destination);
    } finally {
      try { fsImpl.rmSync(temporary, { force: true }); } catch {}
    }
    fsImpl.chmodSync(destination, 0o700);
  } catch (error) {
    throw new Error(`Relay could not install its owned Node runtime (${error?.message || error}).`);
  }

  const installedRuntime = verifiedNodeVersion(destination, { runCommand });
  if (!installedRuntime.ok || installedRuntime.version !== sourceRuntime.version) {
    try { fsImpl.rmSync(destination, { force: true }); } catch {}
    throw new Error(`Relay's owned Node runtime failed verification (${installedRuntime.detail || installedRuntime.version || destination}).`);
  }
  return destination;
}

module.exports = {
  isTemporaryNodePath,
  nodeVersionSupported,
  relayOwnedNodePath,
  verifiedNodeVersion,
};
