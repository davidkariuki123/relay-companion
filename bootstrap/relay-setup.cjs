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
const { exactRuntimeHealth } = require("./runtime-health.cjs");

const RELEASE_ORIGIN = "https://api.sendrelays.com";
const RELEASE_BASE_PATH = "/v1/companion-releases";
const PACKAGE_NAME = "relay-companion";
const packageJson = require("../package.json");
const trust = require("./trust.json");
const { RELEASE_ALGORITHM, verifyReleaseEnvelope } = require("./release-signature.cjs");

function fail(message) {
  throw new Error(message);
}

function releasePlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"].includes(key)) return key;
  fail(`Relay currently supports macOS and Windows; this machine is ${key}.`);
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

function downloadVerifiedArtifact(url, file, artifact) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.origin !== RELEASE_ORIGIN) {
      return reject(new Error(`Relay refused an untrusted artifact origin: ${parsed.origin}`));
    }
    const request = https.get(parsed, { headers: { "user-agent": `${PACKAGE_NAME}/${packageJson.version}` } }, async (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Release artifact returned HTTP ${response.statusCode}`));
      }
      const declaredLength = Number(response.headers["content-length"]);
      if (!Number.isSafeInteger(declaredLength) || declaredLength !== artifact.bytes) {
        response.resume();
        return reject(new Error("Release artifact Content-Length does not match its signed manifest"));
      }
      let bytes = 0;
      const hash = crypto.createHash("sha512");
      const fd = fs.openSync(file, "wx", 0o600);
      const output = fs.createWriteStream(file, { fd, autoClose: false });
      response.on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        if (bytes > artifact.bytes || bytes > 750 * 1024 * 1024) {
          request.destroy(new Error("Release artifact exceeded its signed size"));
        }
      });
      try {
        await pipeline(response, output);
        if (bytes !== artifact.bytes) fail(`Relay artifact size mismatch (${bytes} != ${artifact.bytes}).`);
        const actual = `sha512-${hash.digest("base64")}`;
        if (actual.length !== artifact.sha512.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(artifact.sha512))) {
          fail("Relay artifact checksum is invalid.");
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        resolve();
      } catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(file, { force: true }); } catch {}
        reject(error);
      }
    });
    request.setTimeout(10 * 60_000, () => request.destroy(new Error("Release artifact download timed out")));
    request.on("error", reject);
  });
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
  const electron = platformKey.startsWith("win32-")
    ? path.join(path.dirname(packageRoot), "electron", "dist", "electron.exe")
    : path.join(path.dirname(packageRoot), "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (!fs.statSync(electron, { throwIfNoEntry: false })?.isFile()) fail("Relay runtime has no verified native Electron executable.");
  return { packageRoot, bin: path.join(packageRoot, "bin", "relay.js"), electron };
}

function runtimeLayout(version, platformKey) {
  const root = path.join(os.homedir(), ".relay", "runtime");
  const releaseId = `${version}-${platformKey}-${crypto.randomBytes(8).toString("hex")}`;
  const releaseRoot = path.join(root, "releases", releaseId);
  return {
    root,
    releaseId,
    releaseRoot,
    packageRoot: path.join(releaseRoot, "node_modules", PACKAGE_NAME),
    pointerPath: path.join(root, "current.json"),
    lockPath: path.join(root, "transaction.lock"),
  };
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

async function activateRuntime(layout, runtime, version, {
  spawnImpl = spawnSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writePointer = atomicWriteJson,
  removePointer = (file) => fs.rmSync(file, { force: true }),
  healthCheck = exactRuntimeHealth,
  healthAttempts = 60,
  healthIntervalMs = 500,
  sleep,
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
    node: process.execPath,
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
      result = spawnImpl(process.execPath, [previous.bin, "repair-runtime", "--no-trampoline", "--claim"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      // A failed first install has no former canonical owner. The candidate's
      // uninstall removes the partial MCP/autostart writes setup may have made.
      target = "partial installation";
      result = spawnImpl(process.execPath, [runtime.bin, "uninstall", "--no-trampoline"], {
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
  }

  const result = spawnImpl(process.execPath, [runtime.bin, "setup", "--no-trampoline", "--claim"], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, RELAY_BOOTSTRAP_ACTIVATED: "1" },
  });
  if (!commandOk(result)) {
    const message = `Relay runtime activation failed${result?.status == null ? "" : ` (exit ${result.status})`}.`;
    rollback(message);
    fail(message);
  }
  const health = await waitForRuntimeHealth(runtime, {
    healthCheck,
    attempts: healthAttempts,
    intervalMs: healthIntervalMs,
    ...(sleep ? { sleep } : {}),
  });
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
}

async function setup() {
  assertCompatibleNode();
  const version = exactVersion(packageJson.version);
  const platformKey = releasePlatform();
  const layout = runtimeLayout(version, platformKey);
  const lock = acquireCanonicalLock(layout.lockPath);
  try {
    const runtime = await stageVerifiedRuntime({ version, platformKey, destination: layout.releaseRoot });
    await activateRuntime(layout, runtime, version);
    console.log(`Relay ${version} is installed. The Relay pill is open; sign in there to finish.`);
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
  if (process.argv.includes("--code")) fail("New Relay setup never accepts a pairing code. Sign in from the Relay pill after installation.");
  if (command === "version" || process.argv.includes("--version")) return console.log(packageJson.version);
  if (command === "setup") return setup();
  console.log([
    "Relay secure setup",
    "",
    `  npx --yes ${PACKAGE_NAME}@${packageJson.version} setup`,
    "",
    "Downloads the exact signed Relay runtime, verifies it, installs Relay, and opens the signed-out pill.",
  ].join("\n"));
}

module.exports = {
  activateRuntime,
  acquireCanonicalLock,
  assertCompatibleNode,
  releasePlatform,
  parseSignedManifest,
  restoreRuntimeLinks,
  stageVerifiedRuntime,
  tarInvocation,
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
