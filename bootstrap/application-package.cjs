"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { verifyApplicationArtifact } = require("./application-release.cjs");
const { APPLICATION_ID, applicationOwner } = require("./application-owner.cjs");
const { inflateRawSync } = require("node:zlib");

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function command(run, file, args, options = {}) {
  const result = run(file, args, { encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Native installer failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout || "";
}
function packageLocation({ platform = process.platform, homeDir = os.homedir(), env = process.env } = {}) {
  const owner = applicationOwner({ homeDir, platform });
  if (owner) return { root: owner.root, resourcesDir: path.dirname(owner.receipt), executable: owner.executable };
  if (platform === "darwin") {
    const root = path.join(homeDir, "Applications", "Relay.app");
    return { root, resourcesDir: path.join(root, "Contents", "Resources"), executable: path.join(root, "Contents", "MacOS", "Relay") };
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    // Only a per-user, same-home native install is admitted by the bridge.
    if (!path.isAbsolute(local) || !inside(homeDir, local)) throw new Error("Native installer needs a local application folder inside this user's home");
    const root = path.join(local, "Programs", "Relay");
    return { root, resourcesDir: path.join(root, "resources"), executable: path.join(root, "relay.exe") };
  }
  if (platform === "linux") return { root: "/opt/Relay", resourcesDir: "/opt/Relay/resources", executable: "/opt/Relay/relay" };
  throw new Error("Unsupported native application platform");
}
function readReceipt(location, payload, platformKey) {
  const root = fs.realpathSync(location.root);
  for (const file of [location.executable, path.join(location.resourcesDir, "candidate.json")]) {
    if (!inside(root, fs.realpathSync(file)) || !fs.statSync(file).isFile()) throw new Error("Native application files escaped their package");
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(location.resourcesDir, "candidate.json"), "utf8"));
  if (receipt.schema !== 1 || receipt.distribution !== "application" || receipt.appId !== APPLICATION_ID
    || receipt.activationEnabled !== true || receipt.packagingSourceDirty !== false || receipt.platform !== platformKey
    || (receipt.applicationVersion || receipt.version) !== payload.version
    || receipt.version !== payload.runtime.version || receipt.packagingSourceSha !== payload.sourceSha
    || receipt.runtimeSourceSha !== payload.runtime.sourceSha) throw new Error("Installed native package does not match its signed release");
  return receipt;
}
function validateZipListing(text) {
  const entries = text.trim().split(/\r?\n/);
  if (!entries.length || entries.length > 100_000) throw new Error("Invalid application archive inventory");
  for (const entry of entries) {
    const clean = entry.replace(/\/$/, "");
    if (!clean || clean.includes("\\") || clean.includes("\0") || clean.startsWith("/")
      || clean.split("/").some(part => !part || part === "." || part === "..")
      || !(clean === "Relay.app" || clean.startsWith("Relay.app/") || clean.startsWith("__MACOSX/"))) {
      throw new Error("Unsafe native application archive entry");
    }
  }
}
function verifyMacTree(root, run) {
  const resolved = fs.realpathSync(root);
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        if (!inside(resolved, fs.realpathSync(file))) throw new Error("Application symlink escapes the signed bundle");
      } else if (item.isDirectory()) visit(file);
      else if (!item.isFile()) throw new Error("Unsupported native application file");
    }
  }
  visit(resolved);
  command(run, "/usr/bin/codesign", ["--verify", "--deep", "--strict", resolved]);
  command(run, "/usr/bin/xcrun", ["stapler", "validate", resolved]);
  command(run, "/usr/sbin/spctl", ["--assess", "--type", "execute", resolved]);
}

function validateZipFile(file) {
  // Inspect links before ditto writes anything: checking the extracted tree is
  // too late if an archive writes a child through an escaping symlink.
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const read = (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("Invalid ZIP bounds");
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated ZIP");
      return bytes;
    };
    const tail = read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = tail.length - 22;
    while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) end--;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("Unsupported ZIP directory");
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count === 65535 || length > 64 * 1024 ** 2 || offset + length > size - tail.length + end) throw new Error("Unsupported ZIP64 or oversized directory");
    const directory = read(offset, length), names = new Set(), links = new Set();
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry");
      const nameLength = directory.readUInt16LE(cursor + 28), extra = directory.readUInt16LE(cursor + 30), comment = directory.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameLength + extra + comment;
      if (next > directory.length) throw new Error("Truncated ZIP directory");
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      validateZipListing(name);
      if (names.has(name) || directory.readUInt16LE(cursor + 8) & 1) throw new Error("Duplicate or encrypted ZIP entry");
      names.add(name);
      const localOffset = directory.readUInt32LE(cursor + 42), local = read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || read(localOffset + 30, local.readUInt16LE(26)).toString("utf8") !== name) throw new Error("ZIP local name mismatch");
      const mode = directory.readUInt32LE(cursor + 38) >>> 16;
      if ((mode & 0xf000) === 0xa000) {
        const packedLength = directory.readUInt32LE(cursor + 20);
        if (packedLength > 16384 || directory.readUInt32LE(cursor + 24) > 4096) throw new Error("Oversized ZIP symlink");
        const packed = read(localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), packedLength);
        const method = directory.readUInt16LE(cursor + 10);
        const target = (method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: 4096 }) : Buffer.alloc(0)).toString("utf8");
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (!target || target.startsWith("/") || target.includes("\\") || target.includes("\0") || !resolved.startsWith("Relay.app/")) throw new Error("ZIP symlink escapes application");
        links.add(name);
      }
      cursor = next;
    }
    if (cursor !== directory.length) throw new Error("ZIP directory has trailing data");
    for (const name of names) {
      const parts = name.split("/");
      for (let index = 1; index < parts.length; index++) if (links.has(parts.slice(0, index).join("/"))) throw new Error("ZIP writes through a symlink");
    }
  } finally { fs.closeSync(fd); }
}

async function installNativePackage({ payload, artifact, file, workDir, activationEnabled = false,
  platform = process.platform, arch = process.arch, homeDir = os.homedir(), env = process.env,
  run = spawnSync, verifyMac = verifyMacTree, verifyZip = validateZipFile } = {}) {
  if (activationEnabled !== true) return { ok: false, state: "disabled", changed: false };
  if (run === spawnSync && (platform !== process.platform || path.resolve(homeDir) !== path.resolve(os.homedir()))) {
    throw new Error("Native installation must run in the owning user's login session");
  }
  const location = packageLocation({ platform, homeDir, env });
  const platformKey = `${platform}-${arch}`;
  if (!payload.artifacts[platformKey]?.some(item => item.url === artifact.url && item.sha512 === artifact.sha512)) {
    throw new Error("Native artifact is absent from the verified release");
  }
  await verifyApplicationArtifact(file, artifact);
  const attemptFile = path.join(workDir, "native-install.json");
  let previousAttempt;
  try { previousAttempt = JSON.parse(fs.readFileSync(attemptFile, "utf8")); } catch {}
  const resumable = previousAttempt?.state === "started" && previousAttempt.root === location.root
    && previousAttempt.sourceSha === payload.sourceSha && previousAttempt.sha512 === artifact.sha512;
  if (platform === "linux") {
    // System packages require their package manager's user/admin interaction.
    // The daemon never runs sudo/pkexec, edits /opt, or bypasses that boundary.
    try { readReceipt(location, payload, platformKey); return { ok: true, alreadyInstalled: true, ...location }; }
    catch { return { ok: false, state: "installer-action-required", changed: false, artifact: file,
      detail: "Install this verified DEB or RPM with the system package manager, then open Relay to finish. Existing Relay continues running." }; }
  }
  if (!inside(homeDir, location.root) && !(platform === "darwin" && location.root === "/Applications/Relay.app")) throw new Error("Native destination is not a supported Relay application location");
  if (platform === "darwin" && location.root === "/Applications/Relay.app") {
    try { fs.accessSync(path.dirname(location.root), fs.constants.W_OK); }
    catch { return { ok: false, state: "installer-action-required", changed: false, artifact: file,
      detail: "Replace Relay using the verified application archive, then open it. The system Applications folder needs your approval; existing Relay continues running." }; }
  }
  // Do not adopt or overwrite another product merely because it is named Relay.
  if (fs.existsSync(location.root)) {
    let owned = false;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(location.resourcesDir, "candidate.json"), "utf8"));
      owned = existing.appId === APPLICATION_ID && existing.distribution === "application";
    } catch {}
    if (platform === "darwin" && !owned) {
      try { owned = /<string>\s*work\.relay\.companion\.launcher\s*<\/string>/.test(fs.readFileSync(path.join(location.root, "Contents", "Info.plist"), "utf8")); } catch {}
    }
    if ((!owned && !(platform === "win32" && resumable)) || fs.lstatSync(location.root).isSymbolicLink()) throw new Error("Native destination is not an owned Relay installation");
  }
  if (platform === "win32") {
    if (artifact.kind !== "exe") throw new Error("Windows requires the verified NSIS installer");
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(attemptFile, JSON.stringify({ state: "started", root: location.root, sourceSha: payload.sourceSha, sha512: artifact.sha512 }), { mode: 0o600 });
    // NSIS requires /D last and unquoted, including paths with spaces. There is
    // no shell; characters in the per-user destination remain literal data.
    command(run, path.resolve(file), ["/S", `/D=${location.root}`], { windowsVerbatimArguments: true });
  } else {
    if (artifact.kind !== "zip") throw new Error("Mac handoff requires the signed application ZIP");
    const staged = path.join(workDir, "mac-package");
    if (fs.existsSync(staged)) {
      const source = path.join(staged, "Relay.app");
      const candidate = fs.existsSync(source)
        ? { root: source, resourcesDir: path.join(source, "Contents", "Resources"), executable: path.join(source, "Contents", "MacOS", "Relay") } : location;
      try { readReceipt(candidate, payload, platformKey); verifyMac(candidate.root, run); }
      catch {
        // An interrupted extraction is retained for diagnosis, then re-extracted
        // from the hash-verified ZIP. Never treat a partial tree as an app.
        fs.renameSync(staged, path.join(workDir, `incomplete-mac-package-${require("node:crypto").randomUUID()}`));
      }
    }
    if (!fs.existsSync(staged)) {
      verifyZip(file);
      validateZipListing(command(run, "/usr/bin/unzip", ["-Z1", path.resolve(file)]));
      fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
      command(run, "/usr/bin/ditto", ["-x", "-k", path.resolve(file), staged]);
    }
    const source = path.join(staged, "Relay.app");
    // On retry after the atomic move, the exact installed receipt is authority.
    if (!fs.existsSync(source)) {
      readReceipt(location, payload, platformKey); verifyMac(location.root, run);
      return { ok: true, alreadyInstalled: true, ...location };
    }
    const sourceLocation = { root: source, resourcesDir: path.join(source, "Contents", "Resources"), executable: path.join(source, "Contents", "MacOS", "Relay") };
    readReceipt(sourceLocation, payload, platformKey); verifyMac(source, run);
    fs.mkdirSync(path.dirname(location.root), { recursive: true, mode: 0o700 });
    const backup = path.join(workDir, "previous-Relay.app");
    if (fs.existsSync(location.root)) {
      if (fs.existsSync(backup)) throw new Error("Native package replacement needs reconciliation; its backup already exists");
      fs.renameSync(location.root, backup);
    }
    try { fs.renameSync(source, location.root); }
    catch (error) {
      if (!fs.existsSync(location.root) && fs.existsSync(backup)) fs.renameSync(backup, location.root);
      throw error;
    }
  }
  readReceipt(location, payload, platformKey);
  if (platform === "win32") fs.writeFileSync(attemptFile, JSON.stringify({ state: "complete", root: location.root, sourceSha: payload.sourceSha, sha512: artifact.sha512 }), { mode: 0o600 });
  return { ok: true, ...location };
}
module.exports = { installNativePackage, packageLocation, readReceipt, validateZipListing, validateZipFile, verifyMacTree };
