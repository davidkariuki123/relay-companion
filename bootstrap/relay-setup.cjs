#!/usr/bin/env node

"use strict";

// Deliberately stdlib-only. This is every byte npm executes before the person
// has reviewed Relay: no package dependencies and no npm lifecycle scripts.
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { activateLinuxRuntimeServices, activateMacRuntimeServices, exactRuntimeHealth } = require("./runtime-health.cjs");
const { isTemporaryNodePath, relayOwnedNodePath } = require("./owned-node-runtime.cjs");
const {
  repairRuntimeExecutablePermissions,
  verifyRuntimeExecutables,
} = require("./runtime-executables.cjs");

const RELEASE_ORIGIN = "https://api.sendrelays.com";
const RELEASE_BASE_PATH = "/v1/companion-releases";
const PACKAGE_NAME = "relay-companion";
const WINDOWS_RELAY_TASKS = ["Relay Companion Pill", "Relay Companion Daemon"];
const WINDOWS_STOP_RELAY_SERVICES_PS = [
  "$p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "  $_.CommandLine -and ($_.CommandLine -match '[\\\\/]relay-companion[\\\\/]') -and (($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b') -or ($_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs') -or ($_.CommandLine -match '[\\\\/]mcp-broker-entry\\.js'))",
  "}; foreach($x in $p){ try { Invoke-CimMethod -InputObject $x -MethodName Terminate -ErrorAction Stop | Out-Null } catch {} }",
].join(" ");
const packageJson = require("../package.json");
const trust = require("./trust.json");
const { RELEASE_ALGORITHM, verifyReleaseEnvelope } = require("./release-signature.cjs");

function fail(message) {
  throw new Error(message);
}

function releasePlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if ([
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
    "linux-arm64",
    "linux-x64",
  ].includes(key)) return key;
  fail(`Relay supports 64-bit macOS, Windows, and Linux; this machine is ${key}.`);
}

function exactVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`The bootstrap does not carry an exact release version (${version || "missing"}).`);
  return version;
}

function assertCompatibleNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  const parts = match ? match.slice(1).map(Number) : [];
  const supported = parts.length === 3 && (parts[0] > 22 || (parts[0] === 22 && parts[1] >= 12));
  if (!supported) {
    fail(`Relay setup requires Node.js 22.12 or newer and will not switch runtimes automatically (found ${version || "unknown"}).`);
  }
  return true;
}

const VERSION_MANAGED_NODE_RE = /[\\/](Cellar[\\/]node|\.nvm[\\/]versions|\.n[\\/]versions|\.fnm|fnm[\\/]|\.volta|\.hermes[\\/]node)[\\/]/i;

function stableNodePath(execPath = process.execPath, {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  spawnImpl = spawnSync,
} = {}) {
  if (!execPath) return execPath;
  let realExec = execPath;
  try { realExec = realpathSync(execPath); } catch {}
  const volatile = VERSION_MANAGED_NODE_RE.test(execPath)
    || VERSION_MANAGED_NODE_RE.test(realExec)
    || isTemporaryNodePath(execPath, { platform, realpathSync });
  if (!volatile) return execPath;

  const api = platform === "win32" ? path.win32 : path.posix;
  const candidates = platform === "win32"
    ? [api.join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe")]
    : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const directory of String(env.PATH || "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    candidates.push(api.join(directory, platform === "win32" ? "node.exe" : "node"));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (
        existsSync(candidate)
        && !isTemporaryNodePath(candidate, { platform, realpathSync })
        && realpathSync(candidate) === realExec
      ) return candidate;
    } catch {}
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (
        !existsSync(candidate)
        || VERSION_MANAGED_NODE_RE.test(candidate)
        || isTemporaryNodePath(candidate, { platform, realpathSync })
      ) continue;
      const result = spawnImpl(candidate, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 });
      if (!result?.error && result?.status === 0) {
        assertCompatibleNode(String(result.stdout || "").trim());
        return candidate;
      }
    } catch {}
  }
  return execPath;
}

function durableNodePath(execPath = stableNodePath(), {
  platform = process.platform,
  runtimeRoot = path.join(os.homedir(), ".relay", "runtime"),
  fsImpl = fs,
} = {}) {
  if (platform !== "linux" || !execPath) return execPath;
  let source = execPath;
  try { source = fsImpl.realpathSync(execPath); } catch {}
  if (!VERSION_MANAGED_NODE_RE.test(execPath) && !VERSION_MANAGED_NODE_RE.test(source)) return execPath;
  let bytes;
  try { bytes = fsImpl.readFileSync(source); }
  catch (error) { fail(`Relay could not preserve its Node runtime (${error?.message || error}).`); }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(runtimeRoot, "node", digest);
  const destination = path.join(directory, "node");
  try {
    const existing = fsImpl.readFileSync(destination);
    if (crypto.createHash("sha256").update(existing).digest("hex") === digest) return destination;
  } catch {}
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.node-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fsImpl.writeFileSync(temporary, bytes, { mode: 0o700, flag: "wx" });
    fsImpl.chmodSync(temporary, 0o700);
    const copied = crypto.createHash("sha256").update(fsImpl.readFileSync(temporary)).digest("hex");
    if (copied !== digest) fail("Relay's durable Node copy failed its integrity check.");
    fsImpl.rmSync(destination, { force: true });
    fsImpl.renameSync(temporary, destination);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch {}
  }
  return destination;
}

function fetchBuffer(url, redirects = 0, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return reject(new Error(`Relay refused a non-HTTPS release URL: ${url}`));
    const request = https.get(parsed, { headers: { "user-agent": `${PACKAGE_NAME}/${packageJson.version}` } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new Error("Too many release download redirects"));
        const next = new URL(response.headers.location, parsed);
        if (next.origin !== RELEASE_ORIGIN) return reject(new Error(`Relay refused a release redirect to ${next.origin}`));
        return fetchBuffer(next, redirects + 1, maxBytes).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Release download returned HTTP ${response.statusCode}`));
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) request.destroy(new Error("Release manifest exceeded the safety limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(60_000, () => request.destroy(new Error("Release download timed out")));
    request.on("error", reject);
  });
}

const MAX_ARTIFACT_BYTES = 750 * 1024 * 1024;
const ARTIFACT_DOWNLOAD_ATTEMPTS = 6;

class PermanentArtifactDownloadError extends Error {}

function artifactResponseShape(response, offset, totalBytes) {
  const expectedBytes = totalBytes - offset;
  const contentLength = Number(response.headers["content-length"]);
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
    throw new PermanentArtifactDownloadError("Release artifact Content-Length does not match its signed manifest");
  }
  if (offset === 0) {
    if (response.statusCode !== 200) {
      throw new PermanentArtifactDownloadError(`Release artifact returned HTTP ${response.statusCode}`);
    }
    return expectedBytes;
  }
  if (response.statusCode !== 206) {
    throw new PermanentArtifactDownloadError(`Release artifact resume returned HTTP ${response.statusCode}`);
  }
  const contentRange = String(response.headers["content-range"] || "");
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (
    !match ||
    Number(match[1]) !== offset ||
    Number(match[2]) !== totalBytes - 1 ||
    Number(match[3]) !== totalBytes
  ) {
    throw new PermanentArtifactDownloadError("Release artifact resume returned an invalid Content-Range");
  }
  return expectedBytes;
}

function downloadArtifactAttempt({ parsed, file, artifact, offset, get }) {
  return new Promise((resolve, reject) => {
    let complete = false;
    let responseStream = null;
    let responseDeadline = null;
    const finish = (error) => {
      if (complete) return;
      complete = true;
      if (responseDeadline) clearTimeout(responseDeadline);
      if (error) reject(error);
      else resolve();
    };
    const headers = {
      "user-agent": `${PACKAGE_NAME}/${packageJson.version}`,
      "accept-encoding": "identity",
      ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
    };
    const request = get(parsed, { headers }, async (response) => {
      if (responseDeadline) clearTimeout(responseDeadline);
      responseStream = response;
      let expectedBytes;
      try {
        expectedBytes = artifactResponseShape(response, offset, artifact.bytes);
      } catch (error) {
        response.resume();
        return finish(error);
      }
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > expectedBytes) {
          request.destroy(new PermanentArtifactDownloadError("Release artifact exceeded its signed size"));
        }
      });
      try {
        if (fs.statSync(file).size !== offset) {
          throw new PermanentArtifactDownloadError("Relay artifact staging file changed during download");
        }
        const output = fs.createWriteStream(file, { flags: "r+", start: offset, mode: 0o600 });
        await pipeline(response, output);
        if (received !== expectedBytes) {
          throw new Error(`Relay artifact download ended early (${received} != ${expectedBytes}).`);
        }
        const fd = fs.openSync(file, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        finish();
      } catch (error) {
        finish(error);
      }
    });
    // ClientRequest's socket timeout starts only after a socket is assigned.
    // Bound DNS, connection, TLS, and response-header setup separately so a
    // broken network cannot wedge setup before resumable transfer begins.
    responseDeadline = setTimeout(
      () => request.destroy(new Error("Release artifact connection timed out")),
      30_000,
    );
    request.setTimeout(60_000, () => request.destroy(new Error("Release artifact download stalled")));
    request.on("error", (error) => {
      if (responseStream) responseStream.destroy(error);
      finish(error);
    });
  });
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(`sha512-${hash.digest("base64")}`));
  });
}

async function downloadVerifiedArtifact(url, file, artifact, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== RELEASE_ORIGIN) {
    fail(`Relay refused an untrusted artifact origin: ${parsed.origin}`);
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_ARTIFACT_BYTES) {
    fail("Release artifact has an unsafe signed size");
  }
  const get = options.get || https.get;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts || ARTIFACT_DOWNLOAD_ATTEMPTS;
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const offset = fs.statSync(file).size;
    if (offset > artifact.bytes) fail("Release artifact exceeded its signed size");
    if (offset === artifact.bytes) break;
    try {
      await downloadArtifactAttempt({ parsed, file, artifact, offset, get });
    } catch (error) {
      lastError = error;
      if (error instanceof PermanentArtifactDownloadError) throw error;
      if (attempt + 1 >= attempts) break;
      const backoff = Math.min(4_000, 250 * (2 ** attempt));
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }
  const downloadedBytes = fs.statSync(file).size;
  if (downloadedBytes !== artifact.bytes) {
    throw new Error(`Relay artifact download failed after ${attempts} attempts (${downloadedBytes}/${artifact.bytes} bytes): ${lastError?.message || lastError || "incomplete response"}`);
  }
  const actual = await sha512File(file);
  if (actual.length !== artifact.sha512.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(artifact.sha512))) {
    fs.rmSync(file, { force: true });
    fail("Relay artifact checksum is invalid.");
  }
}

function parseSignedManifest(bytes, { version, platformKey, publicKeyPem, trustStore = trust }) {
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("Relay release manifest is not valid JSON."); }
  if (publicKeyPem) {
    trustStore = {
      schema: 2,
      activeKeyId: envelope?.keyId,
      keys: [{ keyId: envelope?.keyId, algorithm: RELEASE_ALGORITHM, publicKeyPem }],
    };
  } else if (process.env.RELAY_ALLOW_DEV_RELEASE_KEY === "1" && process.env.RELAY_RELEASE_PUBLIC_KEY) {
    trustStore = {
      schema: 2,
      activeKeyId: envelope?.keyId,
      keys: [{ keyId: envelope?.keyId, algorithm: RELEASE_ALGORITHM, publicKeyPem: process.env.RELAY_RELEASE_PUBLIC_KEY }],
    };
  }
  let payloadBytes;
  try { payloadBytes = verifyReleaseEnvelope(envelope, trustStore); }
  catch (error) { fail(error?.message || String(error)); }
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { fail("Relay signed release payload is invalid."); }
  if (payload?.product !== "Relay" || payload?.version !== version || !/^[0-9a-f]{40}$/.test(payload?.sourceSha || "")) {
    fail("Relay signed release identity does not match the requested exact version.");
  }
  const artifact = payload?.artifacts?.[platformKey];
  if (
    !artifact ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(artifact.sha512 || "") ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(artifact.dependencyLockSha512 || "") ||
    !Number.isSafeInteger(artifact.bytes)
  ) {
    fail(`Relay's signed release does not contain a valid ${platformKey} artifact.`);
  }
  const url = new URL(artifact.url);
  if (url.origin !== RELEASE_ORIGIN || !url.pathname.startsWith(`${RELEASE_BASE_PATH}/v${version}/`)) {
    fail("Relay's signed artifact URL is not an exact-version branded release URL.");
  }
  return { payload, artifact };
}

function tarInvocation({ archivePath, mode, destination, pathImpl = path }) {
  const cwd = pathImpl.dirname(archivePath);
  const archiveName = pathImpl.basename(archivePath);
  if (!archiveName || archiveName === "." || archiveName === pathImpl.sep) {
    fail("Relay runtime archive path is invalid.");
  }
  if (mode === "list-names") return { command: "tar", args: ["-tzf", archiveName], cwd };
  if (mode === "list-details") return { command: "tar", args: ["-tvzf", archiveName], cwd };
  if (mode === "extract") {
    const relativeDestination = pathImpl.relative(cwd, destination) || ".";
    if (pathImpl.isAbsolute(relativeDestination) || /^[A-Za-z]:/.test(relativeDestination)) {
      fail("Relay runtime archive and extraction directory must share a local volume.");
    }
    return { command: "tar", args: ["-xzf", archiveName, "-C", relativeDestination], cwd };
  }
  fail("Relay runtime archive operation is invalid.");
}

function validateArchiveListing(archivePath) {
  const nameInvocation = tarInvocation({ archivePath, mode: "list-names" });
  const detailInvocation = tarInvocation({ archivePath, mode: "list-details" });
  const names = spawnSync(nameInvocation.command, nameInvocation.args, { cwd: nameInvocation.cwd, encoding: "utf8", windowsHide: true });
  const details = spawnSync(detailInvocation.command, detailInvocation.args, { cwd: detailInvocation.cwd, encoding: "utf8", windowsHide: true });
  if (names.error || names.status !== 0 || details.error || details.status !== 0) {
    fail(`Relay could not inspect its runtime archive: ${names.error?.message || details.error?.message || names.stderr || details.stderr}`);
  }
  validateArchiveEntries(
    String(names.stdout || "").split(/\r?\n/).filter(Boolean),
    String(details.stdout || "").split(/\r?\n/).filter(Boolean),
  );
}

function validateArchiveEntries(names, details) {
  for (const name of names.map((value) => value.replaceAll("\\", "/"))) {
    if (name.startsWith("/") || /^[A-Za-z]:\//.test(name) || name.split("/").includes("..")) {
      fail(`Relay runtime archive contains an unsafe path: ${name}`);
    }
  }
  for (const line of details) {
    if (!/^[-d]/.test(line)) fail("Relay runtime archives may contain regular files and directories only.");
  }
  return true;
}

function rejectExtractedLinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`Relay runtime contains a link: ${absolute}`);
    if (stat.isDirectory()) rejectExtractedLinks(absolute);
  }
}

function withinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)) return true;
  // macOS exposes /tmp through /private/tmp. A reconstructed link's realpath
  // crosses that harmless system alias even though the lexical signed paths do
  // not. Compare real roots only as a second check for existing targets.
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function restoreRuntimeLinks(root) {
  const mapPath = path.join(root, "node_modules", PACKAGE_NAME, "runtime-links.json");
  let document;
  try { document = JSON.parse(fs.readFileSync(mapPath, "utf8")); } catch {
    fail("Relay runtime is missing its signed internal-link map.");
  }
  if (document?.schema !== 1 || !Array.isArray(document.links) || document.links.length > 256) {
    fail("Relay runtime internal-link map is invalid.");
  }
  const records = new Map();
  for (const item of document.links) {
    const linkPath = String(item?.path || "");
    const target = String(item?.target || "");
    const type = String(item?.type || "");
    if (
      !linkPath ||
      linkPath.includes("\\") ||
      linkPath.startsWith("/") ||
      /^[A-Za-z]:/.test(linkPath) ||
      linkPath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      !target ||
      target.includes("\\") ||
      target.startsWith("/") ||
      /^[A-Za-z]:/.test(target) ||
      !["file", "directory"].includes(type)
    ) {
      fail("Relay runtime internal-link map contains an unsafe entry.");
    }
    const absolute = path.resolve(root, ...linkPath.split("/"));
    const targetAbsolute = path.resolve(path.dirname(absolute), ...target.split("/"));
    if (
      !withinRoot(root, absolute) ||
      !withinRoot(root, targetAbsolute) ||
      targetAbsolute === absolute ||
      targetAbsolute.startsWith(`${absolute}${path.sep}`) ||
      records.has(absolute)
    ) {
      fail("Relay runtime internal-link map escapes or duplicates its signed root.");
    }
    if (fs.existsSync(absolute)) fail("Relay runtime link destination was unexpectedly present in the archive.");
    records.set(absolute, { absolute, target, targetAbsolute, type });
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(record) {
    if (visited.has(record.absolute)) return;
    if (visiting.has(record.absolute)) fail("Relay runtime internal-link map contains a cycle.");
    visiting.add(record.absolute);
    for (const dependency of records.values()) {
      if (
        dependency.absolute !== record.absolute &&
        (record.targetAbsolute === dependency.absolute || record.targetAbsolute.startsWith(`${dependency.absolute}${path.sep}`))
      ) {
        visit(dependency);
      }
    }
    visiting.delete(record.absolute);
    visited.add(record.absolute);
    ordered.push(record);
  }
  for (const record of records.values()) visit(record);

  for (const record of ordered) {
    const targetStat = fs.statSync(record.targetAbsolute, { throwIfNoEntry: false });
    if (!targetStat || (record.type === "directory" ? !targetStat.isDirectory() : !targetStat.isFile())) {
      const actualType = !targetStat ? "absent" : targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "unsupported";
      fail(`Relay runtime internal-link target is absent or has the wrong type (${path.relative(root, record.absolute)} -> ${record.target}; expected ${record.type}, found ${actualType}).`);
    }
    fs.symlinkSync(
      path.normalize(record.target),
      record.absolute,
      record.type === "directory" ? "dir" : "file",
    );
    const realTarget = fs.realpathSync(record.absolute);
    if (!withinRoot(root, realTarget)) fail("Relay runtime reconstructed a link outside its signed root.");
  }
  return ordered.length;
}

function verifyExtractedRuntime(packageRoot, version, platformKey) {
  const required = ["package.json", path.join("bin", "relay.js"), path.join("src", "task-daemon.js"), path.join("overlay", "main.cjs")];
  for (const relative of required) {
    if (!fs.statSync(path.join(packageRoot, relative), { throwIfNoEntry: false })?.isFile()) fail(`Relay runtime is missing ${relative}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version) fail("Relay runtime package identity is invalid.");
  const permissions = repairRuntimeExecutablePermissions(packageRoot, { platform: platformKey });
  if (!permissions.ok) {
    fail(`Relay runtime executable permission repair failed (${permissions.reason}${permissions.detail ? `: ${permissions.detail}` : ""}).`);
  }
  const bin = path.join(packageRoot, "bin", "relay.js");
  if (!platformKey.startsWith("win32-")) {
    try { fs.accessSync(bin, fs.constants.X_OK); }
    catch { fail("Relay runtime CLI is not executable."); }
  }
  const executables = verifyRuntimeExecutables(packageRoot, { platform: platformKey });
  if (!executables.ok) {
    fail(`Relay runtime executable verification failed (${executables.reason}${executables.detail ? `: ${executables.detail}` : ""}).`);
  }
  return {
    packageRoot,
    bin,
    electron: executables.electronPath,
    executablePaths: executables.paths.map((entry) => entry.path),
    repairedExecutableRoles: permissions.repaired,
  };
}

function runtimeLayout(version, platformKey) {
  const root = path.join(os.homedir(), ".relay", "runtime");
  const releasesDir = path.join(root, "releases");
  const releaseId = `${version}-${platformKey}-${crypto.randomBytes(8).toString("hex")}`;
  const releaseRoot = path.join(releasesDir, releaseId);
  return {
    root,
    releasesDir,
    releaseId,
    releaseRoot,
    packageRoot: path.join(releaseRoot, "node_modules", PACKAGE_NAME),
    pointerPath: path.join(root, "current.json"),
    lockPath: path.join(root, "transaction.lock"),
  };
}

function activeCanonicalCli({
  homeDir = os.homedir(),
  platform = process.platform,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const runtimeRoot = api.join(homeDir, ".relay", "runtime");
  let current;
  try { current = JSON.parse(readFileSync(api.join(runtimeRoot, "current.json"), "utf8")); }
  catch { return null; }
  if (current?.active !== true || current?.state !== "active" || !current.bin || !current.node) return null;
  const bin = api.resolve(String(current.bin));
  const releasesRoot = api.resolve(api.join(runtimeRoot, "releases"));
  const relative = api.relative(releasesRoot, bin);
  if (!relative || relative.startsWith("..") || api.isAbsolute(relative)) return null;
  try {
    if (!statSync(bin).isFile() || !statSync(String(current.node)).isFile()) return null;
  } catch { return null; }
  return { bin, node: String(current.node), version: String(current.version || "") };
}

function forwardActiveCanonicalCli(args = process.argv.slice(2), {
  findTarget = activeCanonicalCli,
  spawnImpl = spawnSync,
} = {}) {
  const target = findTarget();
  if (!target) return { forwarded: false };
  const result = spawnImpl(target.node, [target.bin, ...args], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result?.error) throw result.error;
  return { forwarded: true, status: Number.isInteger(result?.status) ? result.status : 1, target };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function acquireCanonicalLock(lockPath, {
  now = Date.now,
  staleAfterMs = 2 * 60 * 60_000,
  mkdirSync = fs.mkdirSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  rmSync = fs.rmSync,
  statSync = fs.statSync,
  existsSync = fs.existsSync,
  isProcessAlive = processAlive,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = crypto.randomBytes(16).toString("hex");
  const ownerPath = path.join(lockPath, "owner.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(
          ownerPath,
          `${JSON.stringify({ pid: process.pid, nonce, createdAt: now(), operation: "bootstrap-setup" })}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
        throw error;
      }
      return {
        release() {
          let owner = null;
          try { owner = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {}
          if (owner?.nonce === nonce) rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (!existsSync(lockPath) || !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      let owner = null;
      try { owner = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {}
      let observedAt = Number(owner?.createdAt || 0);
      if (!observedAt) {
        try { observedAt = Number(statSync(lockPath).mtimeMs || 0); } catch {}
      }
      const ownerDead = owner?.pid ? !isProcessAlive(Number(owner.pid)) : true;
      const stale = ownerDead && observedAt > 0 && now() - observedAt > staleAfterMs;
      if (!stale || attempt > 0) fail("Another verified Relay install or update is already in progress.");
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  fail("Relay could not acquire its canonical install lock.");
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function atomicCreateText(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { mode, flag: "wx" });
    fs.chmodSync(temporary, mode);
    // linkSync is the portable no-replace primitive Node exposes: unlike
    // renameSync it fails with EEXIST if another command appears after our
    // ownership preflight, so Relay can never win that race by overwriting it.
    fs.linkSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const CANONICAL_CLI_LAUNCHER_MARKER = "// relay-companion canonical CLI launcher v1";
const CANONICAL_CLI_SHIM_MARKER = "# relay-companion canonical CLI shim v1";

function canonicalCliLauncherSource(pointerPath) {
  return `#!/usr/bin/env node
${CANONICAL_CLI_LAUNCHER_MARKER}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pointerPath = ${JSON.stringify(pointerPath)};
let current;
try { current = JSON.parse(fs.readFileSync(pointerPath, "utf8")); }
catch { console.error("[relay] Relay is not installed. Run the exact setup command again."); process.exit(1); }
const releases = path.resolve(path.dirname(pointerPath), "releases");
const bin = path.resolve(String(current?.bin || ""));
const relative = path.relative(releases, bin);
if (current?.active !== true || current?.state !== "active" || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
  console.error("[relay] Relay's active runtime pointer is invalid. Run the exact setup command again.");
  process.exit(1);
}
try {
  if (!fs.statSync(bin).isFile() || !fs.statSync(String(current.node || "")).isFile()) throw new Error("missing");
} catch { console.error("[relay] Relay's active runtime is missing. Run the exact setup command again."); process.exit(1); }
const result = spawnSync(String(current.node), [bin, ...process.argv.slice(2)], { stdio: "inherit", env: process.env, windowsHide: true });
if (result.error) { console.error("[relay] " + (result.error.message || result.error)); process.exit(1); }
process.exit(Number.isInteger(result.status) ? result.status : 1);
`;
}

function canonicalCliShimSource(node, launcherPath) {
  return `#!/bin/sh\n${CANONICAL_CLI_SHIM_MARKER}\nexec ${shellSingleQuote(node)} ${shellSingleQuote(launcherPath)} "$@"\n`;
}

function canonicalCliPaths({
  homeDir = os.homedir(),
  pointerPath = path.join(homeDir, ".relay", "runtime", "current.json"),
} = {}) {
  const runtimeRoot = path.dirname(pointerPath);
  const binDir = path.join(homeDir, ".local", "bin");
  return {
    pointerPath,
    runtimeRoot,
    launcherPath: path.join(runtimeRoot, "relay-cli.cjs"),
    binDir,
    shimPath: path.join(binDir, "relay"),
  };
}

function isCanonicalCliShimSource(source, launcherPath) {
  const prefix = `#!/bin/sh\n${CANONICAL_CLI_SHIM_MARKER}\nexec `;
  const suffix = ` ${shellSingleQuote(launcherPath)} "$@"\n`;
  if (typeof source !== "string" || !source.startsWith(prefix) || !source.endsWith(suffix)) return false;
  const encodedNode = source.slice(prefix.length, -suffix.length);
  if (!encodedNode.startsWith("'") || !encodedNode.endsWith("'") || encodedNode.includes("\n") || encodedNode.includes("\r")) {
    return false;
  }
  const decodedNode = encodedNode.slice(1, -1).replaceAll(`'"'"'`, "'");
  return shellSingleQuote(decodedNode) === encodedNode;
}

function installCanonicalCliLauncher(candidate, {
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  pointerPath = path.join(homeDir, ".relay", "runtime", "current.json"),
} = {}) {
  if (platform !== "linux") return { ok: true, skipped: true };
  const { launcherPath, binDir, shimPath } = canonicalCliPaths({ homeDir, pointerPath });
  const launcherSource = canonicalCliLauncherSource(pointerPath);
  const shimSource = canonicalCliShimSource(candidate.node, launcherPath);
  try {
    const existingLauncher = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, "utf8") : null;
    const existingShim = fs.existsSync(shimPath) ? fs.readFileSync(shimPath, "utf8") : null;
    if (existingLauncher !== null && existingLauncher !== launcherSource) {
      return {
        ok: false,
        reason: "cli_launcher_collision",
        detail: `${launcherPath} already exists and is not Relay's generated launcher`,
        launcherPath,
        shimPath,
      };
    }
    if (existingShim !== null && !isCanonicalCliShimSource(existingShim, launcherPath)) {
      return {
        ok: false,
        reason: "cli_shim_collision",
        detail: `${shimPath} already exists and is not Relay's generated command`,
        launcherPath,
        shimPath,
      };
    }
    // Existing generated files deliberately remain byte-identical. The shim's
    // Node is itself a retained durable copy, while the launcher follows the
    // current pointer, so neither needs to be rewritten during an update.
    if (existingLauncher === null) atomicCreateText(launcherPath, launcherSource, 0o700);
    if (existingShim === null) atomicCreateText(shimPath, shimSource, 0o755);
    const pathAvailable = String(env.PATH || "").split(":").some((entry) => {
      try { return path.resolve(entry) === path.resolve(binDir); } catch { return false; }
    });
    return { ok: true, launcherPath, shimPath, pathAvailable };
  } catch (error) {
    return { ok: false, reason: "cli_launcher_install_failed", detail: error?.message || String(error), launcherPath, shimPath };
  }
}

async function waitForRuntimeHealth(runtime, {
  platform = process.platform,
  healthCheck = exactRuntimeHealth,
  attempts = 60,
  intervalMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let health = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    health = await healthCheck(runtime, { platform });
    if (health?.ok) return health;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return health || { ok: false, daemon: false, pill: false };
}

// Scheduled Tasks launch through wscript and return before their real children.
// Ending the task can therefore leave the old daemon/pill alive, where they win
// the singleton race and make exact-root health reject an otherwise valid runtime.
function stopPreviousWindowsRuntime({ platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== "win32") return { ok: true, attempted: false, detail: "" };
  for (const task of WINDOWS_RELAY_TASKS) {
    spawnImpl("schtasks.exe", ["/End", "/TN", task], { stdio: "ignore", windowsHide: true });
  }
  const stopped = spawnImpl(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STOP_RELAY_SERVICES_PS],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    ok: Boolean(stopped && !stopped.error && stopped.status === 0),
    attempted: true,
    detail: stopped?.error?.message || String(stopped?.stderr || stopped?.stdout || "").trim(),
  };
}

const SETUP_COMPATIBILITY_VALUE_FLAGS = new Set([
  "--code",
  "--api",
  "--web",
  "--open-relay",
  "--host",
]);
const SAFE_SETUP_TOKEN = /^[A-Za-z0-9_-]{4,256}$/;

/**
 * The signed-in website still emits the pre-pill setup contract while the
 * installer migration is in flight. Keep that compatibility surface narrow:
 * only the website's value-bearing arguments may cross the thin bootstrap into
 * the already-verified runtime, and endpoint overrides must be secure origins.
 */
function validateSetupCompatibilityArgs(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const args = argv.map((value) => String(value));
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!SETUP_COMPATIBILITY_VALUE_FLAGS.has(flag)) {
      fail("Relay setup received an unsupported compatibility option.");
    }
    if (!value || value.startsWith("--")) {
      fail("Relay setup received an incomplete compatibility option.");
    }
    if (values.has(flag)) fail("Relay setup received a duplicate compatibility option.");
    values.set(flag, value);
  }

  const code = values.get("--code");
  if (!code || !SAFE_SETUP_TOKEN.test(code)) fail("Relay setup received an invalid pairing code.");
  const openRelay = values.get("--open-relay");
  if (openRelay && !SAFE_SETUP_TOKEN.test(openRelay)) fail("Relay setup received an invalid relay token.");
  const host = values.get("--host");
  if (host && !openRelay) fail("Relay setup received a host without a relay token.");
  if (host && host !== "claude" && host !== "codex") fail("Relay setup received an invalid agent host.");

  for (const flag of ["--api", "--web"]) {
    const value = values.get(flag);
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      fail("Relay setup received an invalid service origin.");
    }
    const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      fail("Relay setup requires a secure service origin.");
    }
  }
  return args;
}

async function activateRuntime(layout, runtime, version, {
  platform = process.platform,
  homeDir = os.homedir(),
  spawnImpl = spawnSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writePointer = atomicWriteJson,
  removePointer = (file) => fs.rmSync(file, { force: true }),
  healthCheck = exactRuntimeHealth,
  healthAttempts = 60,
  healthIntervalMs = 500,
  sleep,
  activateLinuxServices = activateLinuxRuntimeServices,
  activateMacServices = activateMacRuntimeServices,
  activationDeadlineMs = 90_000,
  now = Date.now,
  setupCompatibilityArgs = [],
} = {}) {
  let previous = null;
  try { previous = JSON.parse(readFileSync(layout.pointerPath, "utf8")); } catch {}
  const preparedAt = Date.now();
  const candidate = {
    schema: 1,
    active: true,
    state: "active",
    version,
    releaseId: layout.releaseId,
    releaseRoot: layout.releaseRoot,
    packageRoot: runtime.packageRoot,
    bin: runtime.bin,
    node: relayOwnedNodePath(
      durableNodePath(stableNodePath(), { platform, runtimeRoot: layout.root }),
      { platform, runtimeRoot: layout.root },
    ),
    source: "signed-release-artifact",
    preparedAt,
    updatedAt: preparedAt,
  };
  const journal = {
    schema: 1,
    active: false,
    state: "activating",
    candidate,
    previous: previous?.active === true ? previous : null,
    preparedAt,
    updatedAt: preparedAt,
  };

  // The durable journal MUST precede every launcher/MCP/autostart mutation.
  // A crash can therefore be recovered; no process can mistake the candidate
  // for active before setup and service health have succeeded.
  writePointer(layout.pointerPath, journal);

  function commandOk(result) {
    return Boolean(result && !result.error && result.status === 0);
  }
  function rollback(activationFailure) {
    let target = null;
    let result = null;
    if (previous?.bin && existsSync(previous.bin)) {
      target = "previous runtime";
      result = spawnImpl(candidate.node, [previous.bin, "repair-runtime", "--no-trampoline", "--claim"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      // A failed first install has no former canonical owner. The candidate's
      // uninstall removes the partial MCP/autostart writes setup may have made.
      target = "partial installation";
      result = spawnImpl(candidate.node, [runtime.bin, "uninstall", "--no-trampoline"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    if (!commandOk(result)) {
      try {
        writePointer(layout.pointerPath, {
          ...journal,
          state: "recovery-required",
          failure: {
            reason: "activation-and-rollback-failed",
            detail: `${activationFailure}; could not restore ${target}`,
          },
          updatedAt: Date.now(),
        });
      } catch {}
      fail(`${activationFailure} Rollback failed; Relay left a recovery journal and did not claim the runtime active.`);
    }
    if (previous?.active === true) writePointer(layout.pointerPath, previous);
    else removePointer(layout.pointerPath);
    // Real runtime layouts place each immutable candidate directly beneath
    // releases/. Remove only that exact, now-unreferenced child after rollback;
    // recovery-required deliberately retains it above.
    if (layout.releasesDir) {
      const releasesDir = path.resolve(layout.releasesDir);
      const failedRoot = path.resolve(layout.releaseRoot);
      if (path.dirname(failedRoot) === releasesDir && failedRoot !== releasesDir) {
        try { fs.rmSync(failedRoot, { recursive: true, force: true }); } catch {}
      }
    }
  }

  const cliLauncher = installCanonicalCliLauncher(candidate, {
    platform,
    homeDir,
    pointerPath: layout.pointerPath,
  });
  if (!cliLauncher.ok) {
    const message = `Relay could not install its durable command launcher (${cliLauncher.detail || cliLauncher.reason}).`;
    rollback(message);
    fail(message);
  }

  const stopped = stopPreviousWindowsRuntime({ platform, spawnImpl });
  if (!stopped.ok) {
    const message = `Relay runtime activation could not stop the previous desktop services${stopped.detail ? ` (${stopped.detail})` : ""}.`;
    rollback(message);
    fail(message);
  }

  // On macOS/Linux setup owns registration, but the shared activation state
  // machine owns service restart. This keeps first-install MCP/autostart creation
  // in the candidate while bootstrap and the updater use the same exact-root handoff.
  const setupArgs = [runtime.bin, "setup", "--no-trampoline", "--claim", ...setupCompatibilityArgs];
  if (platform === "darwin" || platform === "linux") setupArgs.push("--no-restart");
  const result = spawnImpl(candidate.node, setupArgs, {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, RELAY_BOOTSTRAP_ACTIVATED: "1" },
  });
  if (!commandOk(result)) {
    const message = `Relay runtime activation failed${result?.status == null ? "" : ` (exit ${result.status})`}.`;
    rollback(message);
    fail(message);
  }
  let health = null;
  if (platform === "darwin") {
    const activated = await activateMacServices(runtime, {
      homeDir,
      platform,
      run: spawnImpl,
      healthCheck,
      activationDeadlineMs,
      now,
      ...(sleep ? { sleep } : {}),
    });
    if (!activated?.ok) {
      const detail = activated?.detail ? ` (${activated.detail})` : "";
      const message = `Relay runtime activation could not start the exact registered macOS services${detail}.`;
      rollback(message);
      fail(message);
    }
    health = activated.health;
  } else if (platform === "linux") {
    const activated = await activateLinuxServices(runtime, {
      homeDir,
      platform,
      run: spawnImpl,
      healthCheck,
      attempts: healthAttempts,
      ...(sleep ? { sleep } : {}),
    });
    if (!activated?.ok) {
      const detail = activated?.detail ? ` (${activated.detail})` : "";
      const message = `Relay runtime activation could not start the exact registered Linux services${detail}.`;
      rollback(message);
      fail(message);
    }
    health = activated.health;
  } else {
    health = await waitForRuntimeHealth(runtime, {
      healthCheck,
      attempts: healthAttempts,
      intervalMs: healthIntervalMs,
      ...(sleep ? { sleep } : {}),
    });
  }
  if (!health?.ok) {
    const missing = [health?.daemon ? "" : "daemon", health?.pill ? "" : "pill"].filter(Boolean).join(" and ");
    const message = `Relay runtime activation failed exact-root health${missing ? ` (${missing} did not start)` : ""}.`;
    rollback(message);
    fail(message);
  }
  try {
    writePointer(layout.pointerPath, candidate);
  } catch (error) {
    rollback("Relay could not commit the verified runtime pointer.");
    throw error;
  }
  return { candidate, cliLauncher };
}

async function setup(argv = []) {
  assertCompatibleNode();
  const setupCompatibilityArgs = validateSetupCompatibilityArgs(argv);
  const version = exactVersion(packageJson.version);
  const platformKey = releasePlatform();
  const layout = runtimeLayout(version, platformKey);
  const lock = acquireCanonicalLock(layout.lockPath);
  try {
    const runtime = await stageVerifiedRuntime({ version, platformKey, destination: layout.releaseRoot });
    const activated = await activateRuntime(layout, runtime, version, { setupCompatibilityArgs });
    if (setupCompatibilityArgs.includes("--code")) {
      console.log(`Relay ${version} is installed and paired. The Relay pill is open.`);
    } else {
      console.log(`Relay ${version} is installed. The Relay pill is open; sign in there to finish.`);
    }
    if (activated?.cliLauncher && !activated.cliLauncher.pathAvailable) {
      console.log(`Relay's command is installed at ${activated.cliLauncher.shimPath}. Open a new login session to add ~/.local/bin to PATH.`);
    }
  } finally {
    lock.release();
  }
}

async function stageVerifiedRuntime({ version, platformKey = releasePlatform(), destination }) {
  const manifestUrl = `${RELEASE_ORIGIN}${RELEASE_BASE_PATH}/v${version}/manifest.json`;
  if (!destination) fail("Relay runtime destination is missing.");
  if (fs.existsSync(destination)) {
    fail("Relay refused to reuse a pre-existing runtime destination.");
  }
  const { artifact } = parseSignedManifest(await fetchBuffer(manifestUrl), { version, platformKey });
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), `.relay-download-${version}-`));
  const archivePath = path.join(staging, "runtime.tar.gz");
  const extracted = path.join(staging, "root");
  try {
    fs.mkdirSync(extracted);
    await downloadVerifiedArtifact(artifact.url, archivePath, artifact);
    validateArchiveListing(archivePath);
    const unpackInvocation = tarInvocation({ archivePath, mode: "extract", destination: extracted });
    const unpack = spawnSync(unpackInvocation.command, unpackInvocation.args, {
      cwd: unpackInvocation.cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (unpack.error || unpack.status !== 0) fail(`Relay could not unpack its verified runtime: ${unpack.error?.message || unpack.stderr}`);
    rejectExtractedLinks(extracted);
    restoreRuntimeLinks(extracted);
    verifyExtractedRuntime(path.join(extracted, "node_modules", PACKAGE_NAME), version, platformKey);
    if (fs.existsSync(destination)) fail("Relay runtime destination appeared during verification; refusing the race.");
    fs.renameSync(extracted, destination);
    return verifyExtractedRuntime(path.join(destination, "node_modules", PACKAGE_NAME), version, platformKey);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2] || "help";
  // Once the signed canonical runtime exists, the npm-global thin installer is
  // only a human-facing command shim. Hand every ordinary command to the active
  // runtime; keep `setup` local because an explicit exact-version npx install is
  // allowed to replace or repair the canonical runtime.
  if (command !== "setup") {
    const forwarded = forwardActiveCanonicalCli();
    if (forwarded.forwarded) {
      process.exitCode = forwarded.status;
      return;
    }
  }
  if (command === "version" || process.argv.includes("--version")) return console.log(packageJson.version);
  if (command === "setup") return setup(process.argv.slice(3));
  console.log([
    "Relay secure setup",
    "",
    `  npx --yes ${PACKAGE_NAME}@${packageJson.version} setup`,
    "",
    "Downloads the exact signed Relay runtime, verifies it, installs Relay, and opens the signed-out pill.",
  ].join("\n"));
}

module.exports = {
  activeCanonicalCli,
  activateRuntime,
  acquireCanonicalLock,
  assertCompatibleNode,
  canonicalCliLauncherSource,
  canonicalCliPaths,
  canonicalCliShimSource,
  durableNodePath,
  downloadVerifiedArtifact,
  forwardActiveCanonicalCli,
  installCanonicalCliLauncher,
  isCanonicalCliShimSource,
  releasePlatform,
  parseSignedManifest,
  restoreRuntimeLinks,
  stageVerifiedRuntime,
  stableNodePath,
  tarInvocation,
  validateSetupCompatibilityArgs,
  validateArchiveEntries,
  verifyExtractedRuntime,
  waitForRuntimeHealth,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[relay] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
