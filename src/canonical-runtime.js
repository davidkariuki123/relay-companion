import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import runtimeExecutables from "../bootstrap/runtime-executables.cjs";

const { verifyRuntimeExecutables } = runtimeExecutables;

export const CANONICAL_RUNTIME_SCHEMA = 1;
export const CANONICAL_PACKAGE_NAME = "relay-companion";

function pathsFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function samePath(left, right, platform) {
  const api = pathsFor(platform);
  const a = api.resolve(String(left || ""));
  const b = api.resolve(String(right || ""));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeSegment(value) {
  return String(value || "").replace(/[^0-9A-Za-z._-]/g, "_");
}

export function canonicalRuntimeLayout({
  homeDir = os.homedir(),
  platform = process.platform,
  releaseId = null,
} = {}) {
  const api = pathsFor(platform);
  const root = api.resolve(homeDir, ".relay", "runtime");
  const releasesDir = api.join(root, "releases");
  const stagingDir = api.join(root, ".staging");
  const pointerPath = api.join(root, "current.json");
  const lockPath = api.join(root, "transaction.lock");
  const layout = { root, releasesDir, stagingDir, pointerPath, lockPath };
  if (!releaseId) return layout;
  const id = safeSegment(releaseId);
  const stagingRoot = api.join(stagingDir, id);
  const releaseRoot = api.join(releasesDir, id);
  const packageRelative = api.join("node_modules", CANONICAL_PACKAGE_NAME);
  return {
    ...layout,
    releaseId: id,
    stagingRoot,
    stagingPackageRoot: api.join(stagingRoot, packageRelative),
    releaseRoot,
    packageRoot: api.join(releaseRoot, packageRelative),
    bin: api.join(releaseRoot, packageRelative, "bin", "relay.js"),
  };
}

export function isCanonicalPackageRoot(packageRoot, {
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  const api = pathsFor(platform);
  const { releasesDir } = canonicalRuntimeLayout({ homeDir, platform });
  const root = api.resolve(String(packageRoot || ""));
  const relative = api.relative(releasesDir, root);
  if (!relative || relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return false;
  const suffix = api.join("node_modules", CANONICAL_PACKAGE_NAME);
  const comparable = platform === "win32" ? relative.toLowerCase() : relative;
  const expected = platform === "win32" ? suffix.toLowerCase() : suffix;
  return comparable.endsWith(`${api.sep}${expected}`);
}

function validatePointer(value, { homeDir, platform }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema !== CANONICAL_RUNTIME_SCHEMA || value.active !== true || (value.state && value.state !== "active")) return null;
  if (!value.version || !value.packageRoot || !value.bin || !value.releaseRoot) return null;
  if (!isCanonicalPackageRoot(value.packageRoot, { homeDir, platform })) return null;
  const api = pathsFor(platform);
  if (!samePath(value.bin, api.join(value.packageRoot, "bin", "relay.js"), platform)) return null;
  if (!samePath(value.releaseRoot, api.resolve(value.packageRoot, "..", ".."), platform)) return null;
  return value;
}

export function readCanonicalRuntimeState({
  homeDir = os.homedir(),
  platform = process.platform,
  readFileSync = fs.readFileSync,
} = {}) {
  const { pointerPath } = canonicalRuntimeLayout({ homeDir, platform });
  try {
    const value = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (!value || value.schema !== CANONICAL_RUNTIME_SCHEMA || typeof value !== "object") return null;
    if (["activating", "recovery-required"].includes(value.state) && value.active === false && value.candidate) return value;
    return validatePointer(value, { homeDir, platform });
  } catch {
    return null;
  }
}

export function readCanonicalRuntime({
  homeDir = os.homedir(),
  platform = process.platform,
  readFileSync = fs.readFileSync,
} = {}) {
  const { pointerPath } = canonicalRuntimeLayout({ homeDir, platform });
  try {
    return validatePointer(JSON.parse(readFileSync(pointerPath, "utf8")), { homeDir, platform });
  } catch {
    return null;
  }
}

/**
 * Keep an already-active canonical pointer aligned with the durable Node used
 * by repair-runtime. Activation journals are deliberately left alone: the
 * updater owns those state transitions and commits its candidate only after
 * exact-root health succeeds.
 */
export function reconcileCanonicalRuntimeNode({
  node,
  homeDir = os.homedir(),
  platform = process.platform,
  now = Date.now,
  fsImpl = fs,
} = {}) {
  if (!node) return { ok: false, changed: false, reason: "runtime-node-missing" };
  const state = readCanonicalRuntimeState({
    homeDir,
    platform,
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  });
  if (!state) return { ok: true, changed: false, reason: "canonical-runtime-absent" };
  if (state.active !== true) return { ok: true, changed: false, reason: "canonical-transaction-active" };
  if (samePath(node, state.node, platform)) {
    return { ok: true, changed: false, reason: "already-current", current: state };
  }

  const { pointerPath } = canonicalRuntimeLayout({ homeDir, platform });
  const next = { ...state, node, repairedAt: now() };
  atomicWritePointer(pointerPath, next, {
    platform,
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    renameSync: fsImpl.renameSync.bind(fsImpl),
  });
  const current = readCanonicalRuntime({
    homeDir,
    platform,
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  });
  if (!current || !samePath(current.node, node, platform)) {
    return { ok: false, changed: false, reason: "canonical-pointer-verification-failed" };
  }
  return { ok: true, changed: true, previousNode: state.node || null, current };
}

export function canonicalOwnershipGuard(packageRoot, {
  homeDir = os.homedir(),
  platform = process.platform,
  readCurrent = readCanonicalRuntime,
} = {}) {
  const canonical = isCanonicalPackageRoot(packageRoot, { homeDir, platform });
  const current = readCurrent({ homeDir, platform });
  if (!current) return { mayClaim: true, canonical, current: null, reason: canonical ? "canonical-no-pointer" : "no-canonical-runtime" };
  if (samePath(packageRoot, current.packageRoot, platform)) {
    return { mayClaim: true, canonical: true, current, reason: "canonical-current" };
  }
  return { mayClaim: false, canonical, current, reason: canonical ? "canonical-release-not-current" : "canonical-runtime-owned" };
}

export function pruneCanonicalReleases({
  homeDir = os.homedir(),
  platform = process.platform,
  active = null,
  previous = null,
  protectedPackageRoots = [],
  retainRecent = 1,
  fsImpl = fs,
} = {}) {
  const api = pathsFor(platform);
  const { releasesDir } = canonicalRuntimeLayout({ homeDir, platform });
  const keep = new Set([active?.releaseId, previous?.releaseId].filter(Boolean));
  for (const packageRoot of protectedPackageRoots) {
    if (!isCanonicalPackageRoot(packageRoot, { homeDir, platform })) continue;
    const relative = api.relative(releasesDir, api.resolve(packageRoot));
    const releaseId = relative.split(api.sep)[0];
    if (releaseId) keep.add(releaseId);
  }
  let entries = [];
  try {
    entries = fsImpl.readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink?.())
      .map((entry) => {
        const releaseRoot = api.join(releasesDir, entry.name);
        let modified = 0;
        try { modified = Number(fsImpl.statSync(releaseRoot).mtimeMs) || 0; } catch {}
        return { name: entry.name, releaseRoot, modified };
      });
  } catch {
    return { ok: true, removed: [], retained: [...keep], skipped: "releases-unreadable" };
  }
  const forensic = entries
    .filter((entry) => !keep.has(entry.name))
    .sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
    .slice(0, Math.max(0, Number(retainRecent) || 0));
  for (const entry of forensic) keep.add(entry.name);
  const removed = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    // `entry.name` came directly from readdir and resolve must remain one direct
    // child of Relay's own releases directory. Never follow a symlink or accept a
    // path-shaped name from an injected/corrupt directory listing.
    if (api.dirname(api.resolve(entry.releaseRoot)) !== api.resolve(releasesDir)) continue;
    try {
      fsImpl.rmSync(entry.releaseRoot, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {}
  }
  return { ok: true, removed, retained: [...keep] };
}

// One direct child of Relay's own releases directory, gone. The guard mirrors
// pruneCanonicalReleases: never follow a path-shaped name out of the tree.
function removeStrandedRelease(releaseRoot, { releasesDir, platform, rmSync = fs.rmSync }) {
  const api = pathsFor(platform);
  try {
    if (api.dirname(api.resolve(releaseRoot)) !== api.resolve(releasesDir)) return false;
    rmSync(releaseRoot, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// An already-installed release of the exact target version, verified, and neither
// current, previous, nor referenced by a running process. Failed activations used
// to strand these (~650MB each, npm-install-minutes each) and the next attempt
// installed the same version again beside them: 37 duplicates / 24GB in 25 minutes
// on Sven's Mac. Adopt instead of reinstalling.
function findReusableRelease({ version, layout, platform, io, exclude, verifyCandidate }) {
  if (typeof io.readdirSync !== "function") return null;
  const api = pathsFor(platform);
  const prefix = `${safeSegment(version)}-`;
  let names = [];
  try {
    names = io.readdirSync(layout.releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink?.())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix) && !exclude.has(name))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const releaseRoot = api.join(layout.releasesDir, name);
    const packageRoot = api.join(releaseRoot, "node_modules", CANONICAL_PACKAGE_NAME);
    let verified = null;
    try {
      verified = verifyCandidate(packageRoot, version, {
        platform,
        existsSync: io.existsSync,
        readFileSync: io.readFileSync,
        statSync: io.statSync,
        accessSync: io.accessSync,
      });
    } catch {
      verified = null;
    }
    if (verified?.ok) return { releaseId: name, releaseRoot, packageRoot, bin: api.join(packageRoot, "bin", "relay.js") };
  }
  return null;
}

/**
 * Reconcile a worker crash that left `current.json` non-authoritatively activating.
 * The journal remains in place while external registrations/services are restored;
 * only a successful rollback makes the previous canonical pointer authoritative.
 */
export async function recoverCanonicalRuntime({
  homeDir = os.homedir(),
  platform = process.platform,
  rollbackActivate = async () => ({ ok: false, reason: "rollback-handler-required" }),
  now = Date.now,
  fsImpl = fs,
  protectedPackageRoots = [],
  cleanupReleases = pruneCanonicalReleases,
  onLockAcquired = () => {},
  lockIdentity = {},
} = {}) {
  const state = readCanonicalRuntimeState({ homeDir, platform, readFileSync: fsImpl.readFileSync.bind(fsImpl) });
  if (!state || !["activating", "recovery-required"].includes(state.state)) return { ok: true, phase: "noop", recovered: false };
  const layout = canonicalRuntimeLayout({ homeDir, platform });
  const io = {
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    renameSync: fsImpl.renameSync.bind(fsImpl),
    rmSync: fsImpl.rmSync.bind(fsImpl),
    readdirSync: typeof fsImpl.readdirSync === "function" ? fsImpl.readdirSync.bind(fsImpl) : undefined,
    processAlive: typeof fsImpl.processAlive === "function" ? fsImpl.processAlive.bind(fsImpl) : undefined,
    processIdentity: typeof fsImpl.processIdentity === "function" ? fsImpl.processIdentity.bind(fsImpl) : undefined,
  };
  const lockOptions = { ...io, platform, now, ownerIdentity: lockIdentity };
  if (!lockOptions.processAlive) delete lockOptions.processAlive;
  if (!lockOptions.processIdentity) delete lockOptions.processIdentity;
  if (!lockOptions.readdirSync) delete lockOptions.readdirSync;
  let lock = null;
  try {
    lock = acquireLock(layout.lockPath, lockOptions);
  } catch (error) {
    return { ok: false, phase: "lock", reason: "transaction-lock-unavailable", detail: error?.message || String(error) };
  }
  if (!lock.ok) return { ok: false, phase: "lock", reason: lock.reason, owner: lock.owner || null };
  try {
    await onLockAcquired(lock.owner);
  } catch (error) {
    try { lock.release(); } catch {}
    return { ok: false, phase: "admission", reason: "worker-admission-failed", detail: error?.message || String(error) };
  }
  const target = state.previous || null;
  let rollback = null;
  try {
    rollback = await rollbackActivate(target, { recovery: state });
    if (!rollback?.ok) {
      atomicWritePointer(layout.pointerPath, {
        ...state,
        state: "recovery-required",
        failure: { phase: "recovery", reason: rollback?.reason || "rollback-failed", detail: rollback?.detail || "" },
        updatedAt: now(),
      }, { ...io, platform });
      return { ok: false, phase: "recovery", reason: rollback?.reason || "rollback-failed", state };
    }
    atomicWritePointer(layout.pointerPath, target?.active === true ? target : {
      schema: CANONICAL_RUNTIME_SCHEMA,
      active: false,
      state: "inactive",
      rolledBackFrom: state.candidate?.releaseId || null,
      recoveredAt: now(),
    }, { ...io, platform });
    // A machine that needed recovery has, by definition, been failing — and failed
    // attempts are what strand release trees. Sweep here so recovery heals the disk
    // too, not only the pointer.
    try {
      cleanupReleases({
        homeDir,
        platform,
        active: target?.active === true ? target : null,
        previous: null,
        protectedPackageRoots,
        retainRecent: 1,
        fsImpl,
      });
    } catch {}
    return { ok: true, phase: "recovered", recovered: true, target };
  } catch (error) {
    atomicWritePointer(layout.pointerPath, {
      ...state,
      state: "recovery-required",
      failure: { phase: "recovery", reason: "rollback-threw", detail: error?.message || String(error) },
      updatedAt: now(),
    }, { ...io, platform });
    return { ok: false, phase: "recovery", reason: "rollback-threw", detail: error?.message || String(error), state };
  } finally {
    try { lock.release(); } catch {}
  }
}

export function verifyCanonicalCandidate(packageRoot, expectedVersion, {
  platform = process.platform,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
  accessSync = fs.accessSync,
} = {}) {
  const api = pathsFor(platform);
  const required = ["package.json", api.join("bin", "relay.js"), api.join("src", "task-daemon.js"), api.join("overlay", "main.cjs")];
  for (const relative of required) {
    const absolute = api.join(packageRoot, relative);
    if (!existsSync(absolute)) return { ok: false, reason: "candidate-file-missing", detail: relative };
    try {
      if (!statSync(absolute).isFile()) return { ok: false, reason: "candidate-file-invalid", detail: relative };
    } catch {
      return { ok: false, reason: "candidate-file-invalid", detail: relative };
    }
  }
  let version = null;
  try {
    version = JSON.parse(readFileSync(api.join(packageRoot, "package.json"), "utf8")).version;
  } catch {
    return { ok: false, reason: "candidate-package-json-invalid" };
  }
  if (version !== expectedVersion) return { ok: false, reason: "candidate-version-mismatch", detail: `${version || "unknown"} != ${expectedVersion}` };
  try {
    if (platform !== "win32") accessSync(api.join(packageRoot, "bin", "relay.js"), fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "candidate-not-executable", detail: "relay-cli" };
  }
  const executables = verifyRuntimeExecutables(packageRoot, {
    platform,
    existsSync,
    statSync,
    accessSync,
  });
  if (!executables.ok) return executables;
  const electronPath = executables.electronPath;
  if (platform === "darwin") {
    const frameworks = api.resolve(electronPath, "..", "..", "Frameworks", "Electron Framework.framework");
    if (!existsSync(frameworks)) return { ok: false, reason: "candidate-electron-incomplete" };
  }
  return {
    ok: true,
    version,
    packageRoot,
    electronPath,
    executablePaths: executables.paths.map((entry) => entry.path),
    bin: api.join(packageRoot, "bin", "relay.js"),
  };
}

function atomicWritePointer(pointerPath, value, {
  platform = process.platform,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
} = {}) {
  const api = pathsFor(platform);
  mkdirSync(api.dirname(pointerPath), { recursive: true, mode: 0o700 });
  const temp = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, pointerPath);
}

export function canonicalNpmInvocation({
  npmCommand,
  node = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  if (!npmCommand) return { ok: false, reason: "runtime-npm-missing" };

  if (platform === "win32" && /\.cmd$/i.test(String(npmCommand))) {
    // Windows .cmd shims are shell scripts, not executable images. Passing npm.cmd
    // directly to spawn/spawnSync fails with EINVAL before npm starts. Execute npm's
    // JavaScript entrypoint with the exact Node runtime that owns the shim instead;
    // this also avoids cmd.exe's multi-layer quoting and shell-injection surface.
    const npmCli = path.win32.join(path.win32.dirname(String(npmCommand)), "node_modules", "npm", "bin", "npm-cli.js");
    try {
      if (!existsSync(npmCli)) {
        return { ok: false, reason: "runtime-npm-cli-missing", detail: npmCli };
      }
    } catch (error) {
      return { ok: false, reason: "runtime-npm-cli-check-failed", detail: error?.message || String(error) };
    }
    return { ok: true, command: node, args: [npmCli] };
  }

  // POSIX needs the SAME treatment, for a different reason. `npm` on macOS/Linux is
  // a symlink to npm-cli.js, whose shebang is `#!/usr/bin/env node` — so running it
  // resolves node through PATH. A launchd agent inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin,
  // which contains no Homebrew/nvm/volta node, so every canonical install died
  // instantly with "env: node: No such file or directory" (David's Mac, 2026-08-18:
  // 35,440 candidate-install-failed in one day, pinned at 0.1.265 while the fleet
  // moved on). Execute npm's JS with the exact node we already hold and PATH stops
  // mattering. If the shim is not a resolvable .js, fall back to running it directly.
  const api = pathsFor(platform);
  let resolved = "";
  try { resolved = String(realpathSync(String(npmCommand)) || ""); } catch { resolved = ""; }
  if (resolved && /\.(js|cjs|mjs)$/i.test(resolved)) return { ok: true, command: node, args: [resolved] };
  const sibling = api.join(api.dirname(api.dirname(String(npmCommand))), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  try {
    if (existsSync(sibling)) return { ok: true, command: node, args: [sibling] };
  } catch {}
  return { ok: true, command: npmCommand, args: [] };
}

// PATH with the directory owning `node` in front, deduplicated. Exported for the
// tests that pin the launchd-PATH behaviour above.
export function pathWithNodeDirectory(node, { platform = process.platform, env = process.env } = {}) {
  const api = pathsFor(platform);
  const separator = platform === "win32" ? ";" : ":";
  const directory = node ? api.dirname(String(node)) : "";
  const key = Object.keys(env || {}).find((name) => name.toUpperCase() === "PATH") || "PATH";
  const current = String((env || {})[key] || "");
  if (!directory) return current;
  const parts = current ? current.split(separator) : [];
  return [directory, ...parts.filter((part) => part && part !== directory)].join(separator);
}

/**
 * Ensure a staged package has the actual Electron runtime, not merely Electron's
 * JavaScript package. Electron 43 stopped declaring the postinstall lifecycle that
 * used to run install.js, so npm can exit successfully with no dist executable.
 *
 * During Relay's own npm postinstall, `onlyWhenUnscripted` avoids racing older
 * Electron releases that still own their lifecycle download. After npm exits, the
 * canonical updater always repairs a missing runtime before candidate verification.
 */
export function ensureCandidateElectronRuntime(packageRoot, {
  platform = process.platform,
  node = process.execPath,
  env = process.env,
  onlyWhenUnscripted = false,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  spawnSyncImpl = spawnSync,
} = {}) {
  const api = pathsFor(platform);
  const electronRoots = [api.join(packageRoot, "node_modules", "electron"), api.join(api.dirname(packageRoot), "electron")];
  const electronRoot = electronRoots.find((root) => {
    try { return existsSync(api.join(root, "package.json")); } catch { return false; }
  });
  if (!electronRoot) return { ok: false, reason: "electron-package-missing" };

  const electronRelative = platform === "win32"
    ? api.join("dist", "electron.exe")
    : platform === "darwin"
      ? api.join("dist", "Electron.app", "Contents", "MacOS", "Electron")
      : api.join("dist", "electron");
  const electronPath = api.join(electronRoot, electronRelative);
  try {
    if (existsSync(electronPath)) return { ok: true, electronPath, electronRoot, repaired: false };
  } catch {}

  if (onlyWhenUnscripted) {
    try {
      const manifest = JSON.parse(readFileSync(api.join(electronRoot, "package.json"), "utf8"));
      if (manifest?.scripts?.install || manifest?.scripts?.postinstall) {
        return { ok: true, electronPath, electronRoot, repaired: false, delegatedToLifecycle: true };
      }
    } catch {}
  }

  const installScript = api.join(electronRoot, "install.js");
  try {
    if (!existsSync(installScript)) {
      return { ok: false, reason: "electron-install-script-missing", electronPath, electronRoot, installScript };
    }
  } catch {
    return { ok: false, reason: "electron-install-script-missing", electronPath, electronRoot, installScript };
  }

  const childEnv = { ...process.env, ...env };
  childEnv.PATH = pathWithNodeDirectory(node, { platform, env: childEnv });
  const result = spawnSyncImpl(node, [installScript], {
    encoding: "utf8",
    timeout: 15 * 60_000,
    env: childEnv,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) {
    return {
      ok: false,
      reason: "electron-install-failed",
      electronPath,
      electronRoot,
      installScript,
      detail: result?.error?.message || result?.stderr || result?.stdout || "",
    };
  }
  try {
    if (existsSync(electronPath)) return { ok: true, electronPath, electronRoot, repaired: true };
  } catch {}
  return { ok: false, reason: "electron-runtime-missing", electronPath, electronRoot, installScript };
}

function defaultInstallCandidate({ npmCommand, stagingRoot, version, env, node, platform }) {
  const invocation = canonicalNpmInvocation({ npmCommand, node, platform });
  if (!invocation.ok) {
    return { ok: false, status: null, detail: `${invocation.reason}: ${invocation.detail || npmCommand || ""}`.trim() };
  }
  const installArgs = [
    "install", "--prefix", stagingRoot, `${CANONICAL_PACKAGE_NAME}@${version}`,
    "--prefer-online", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
    "--fetch-retries=3", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=10000",
  ];
  const result = spawnSync(
    invocation.command,
    [...invocation.args, ...installArgs],
    {
      encoding: "utf8",
      timeout: 15 * 60_000,
      // npm's own lifecycle scripts shell out to `node` by name, so the launchd PATH
      // has to gain the directory that owns this runtime before any of them run.
      env: { ...process.env, ...env, PATH: pathWithNodeDirectory(node, { platform, env: { ...process.env, ...env } }), RELAY_SKIP_DESKTOP_POSTINSTALL: "1" },
    },
  );
  if (result.error || result.status !== 0) {
    return { ok: false, status: result.status, detail: result.error?.message || result.stderr || result.stdout || "" };
  }
  const api = pathsFor(platform);
  const packageRoot = api.join(stagingRoot, "node_modules", CANONICAL_PACKAGE_NAME);
  const electron = ensureCandidateElectronRuntime(packageRoot, { platform, node, env });
  return electron.ok
    ? { ok: true, status: result.status, electron }
    : { ok: false, status: result.status, detail: `${electron.reason}${electron.detail ? `: ${electron.detail}` : ""}` };
}

function linuxProcessDetails(pid, {
  platform = process.platform,
  readFileSync = fs.readFileSync,
} = {}) {
  if (platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const bootId = String(readFileSync("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const stat = String(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const commandEnd = stat.lastIndexOf(")");
    if (!bootId || commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const state = fields[0];
    const startTicks = fields[19];
    if (!/^[A-Za-z]$/.test(state || "") || !/^\d+$/.test(startTicks || "")) return null;
    return { state, identity: `${bootId}:${startTicks}` };
  } catch {
    return null;
  }
}

function linuxProcessIdentity(pid, options = {}) {
  return linuxProcessDetails(pid, options)?.identity || "";
}

function processAlive(pid, {
  platform = process.platform,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const details = linuxProcessDetails(pid, { platform, readFileSync });
    return !details || !["Z", "X", "x"].includes(details.state);
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canonicalLockOwnerState(owner, { processAlive, processIdentity }) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (!processAlive(pid)) return "dead";
  const expectedIdentity = typeof owner?.processIdentity === "string" ? owner.processIdentity : "";
  if (expectedIdentity) {
    const actualIdentity = processIdentity(pid);
    if (actualIdentity && actualIdentity !== expectedIdentity) return "dead";
  }
  return "live";
}

function sameCanonicalLockGeneration(left, right, { requireBirth = false } = {}) {
  if (!left || !right || left.dev === undefined || left.ino === undefined
    || right.dev === undefined || right.ino === undefined) return false;
  const leftBirth = left.birthtimeNs ?? (left.birthtimeMs !== undefined ? Math.trunc(Number(left.birthtimeMs) * 1e6) : null);
  const rightBirth = right.birthtimeNs ?? (right.birthtimeMs !== undefined ? Math.trunc(Number(right.birthtimeMs) * 1e6) : null);
  const sameObject = String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
  if (!sameObject) return false;
  const hasBirth = leftBirth !== null && rightBirth !== null
    && String(leftBirth) !== "0" && String(rightBirth) !== "0";
  return hasBirth ? String(leftBirth) === String(rightBirth) : !requireBirth;
}

function canonicalLockGenerationNonce(owner) {
  return typeof owner?.nonce === "string" && /^[0-9a-f]{32}$/.test(owner.nonce)
    ? owner.nonce
    : "";
}

function acquireCanonicalReclaimClaim(reclaimPath, {
  nonce,
  now,
  staleAfterMs = 30_000,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
  existsSync,
  processAlive,
  processIdentity,
}) {
  const ownerProcessIdentity = processIdentity(process.pid);
  const claim = {
    pid: process.pid,
    nonce,
    createdAt: now(),
    ...(ownerProcessIdentity ? { processIdentity: ownerProcessIdentity } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(reclaimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!existsSync(reclaimPath)) continue;
      let priorBytes = null;
      let prior = null;
      try {
        priorBytes = String(readFileSync(reclaimPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        return false;
      }
      try { prior = JSON.parse(priorBytes); } catch {}
      let priorAt = Number(prior?.createdAt || 0);
      if (!priorAt) {
        try { priorAt = Number(statSync(reclaimPath).mtimeMs || 0); } catch {}
      }
      const state = canonicalLockOwnerState(prior, { processAlive, processIdentity });
      const stale = state === "dead" || (state === "unknown" && priorAt > 0 && now() - priorAt > staleAfterMs);
      if (!stale || attempt > 0) return false;
      const staleClaimPath = `${reclaimPath}.stale-${process.pid}-${nonce}`;
      try {
        renameSync(reclaimPath, staleClaimPath);
        const movedBytes = String(readFileSync(staleClaimPath, "utf8"));
        if (movedBytes !== priorBytes) {
          try { if (!existsSync(reclaimPath)) renameSync(staleClaimPath, reclaimPath); } catch {}
          return false;
        }
        rmSync(staleClaimPath, { force: true });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
  }
  return false;
}

function acquireLock(lockPath, {
  platform = process.platform,
  // This directory is shared with shipped bootstraps whose owner publication
  // was non-exclusive and had no reclaim handshake. Preserve their two-hour
  // incomplete-record grace during rollout; complete dead owners are immediate.
  staleAfterMs = 2 * 60 * 60_000,
  mkdirSync = fs.mkdirSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
  rmSync = fs.rmSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  existsSync = fs.existsSync,
  processAlive: isProcessAlive = (pid) => processAlive(pid, { platform, readFileSync }),
  processIdentity = (pid) => linuxProcessIdentity(pid, { platform, readFileSync }),
  now = Date.now,
  ownerIdentity = {},
} = {}) {
  const api = pathsFor(platform);
  mkdirSync(api.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString("hex");
  const ownerPath = api.join(lockPath, "owner.json");
  const reclaimPath = api.join(lockPath, "reclaim.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let createdStat = null;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try { createdStat = statSync(lockPath, { bigint: true }); } catch {}
    } catch {
      if (!existsSync(lockPath)) {
        if (attempt === 0) continue;
        return { ok: false, reason: "transaction-lock-unavailable" };
      }
      let ownerBytes = null;
      let owner = null;
      try {
        ownerBytes = String(readFileSync(ownerPath, "utf8"));
      } catch (readError) {
        if (readError?.code !== "ENOENT") {
          return { ok: false, reason: "transaction-lock-unavailable" };
        }
      }
      if (ownerBytes !== null) try { owner = JSON.parse(ownerBytes); } catch {}
      let observedStat = null;
      try { observedStat = statSync(lockPath, { bigint: true }); } catch {}
      const observedAt = Number(owner?.createdAt || observedStat?.mtimeMs || 0);
      const ownerState = canonicalLockOwnerState(owner, { processAlive: isProcessAlive, processIdentity });
      if (ownerState === "live") return { ok: false, reason: "transaction-in-progress", owner };
      const stale = ownerState === "dead"
        || (ownerState === "unknown" && observedAt > 0 && now() - observedAt > staleAfterMs);
      if (!stale || attempt > 0) return { ok: false, reason: "transaction-lock-unavailable", owner };

      let claimed = acquireCanonicalReclaimClaim(reclaimPath, {
        nonce,
        now,
        readFileSync,
        writeFileSync,
        renameSync,
        rmSync,
        statSync,
        existsSync,
        processAlive: isProcessAlive,
        processIdentity,
      });
      if (!claimed) return { ok: false, reason: "transaction-in-progress", owner };
      try {
        let confirmedOwnerBytes = null;
        let confirmedOwner = null;
        try {
          confirmedOwnerBytes = String(readFileSync(ownerPath, "utf8"));
        } catch (readError) {
          if (readError?.code !== "ENOENT") {
            return { ok: false, reason: "transaction-lock-unavailable" };
          }
        }
        if (confirmedOwnerBytes !== null) try { confirmedOwner = JSON.parse(confirmedOwnerBytes); } catch {}
        let confirmedStat = null;
        try { confirmedStat = statSync(lockPath, { bigint: true }); } catch {}
        // Only a fully parsed random nonce supplies generation identity. Missing
        // or partial records can repeat across generations; without birth time,
        // inode reuse makes those indistinguishable, so fail closed.
        const ownerNonce = canonicalLockGenerationNonce(owner);
        const confirmedNonce = canonicalLockGenerationNonce(confirmedOwner);
        const requireBirth = !ownerNonce || ownerNonce !== confirmedNonce;
        const sameGeneration = sameCanonicalLockGeneration(observedStat, confirmedStat, { requireBirth })
          && ownerBytes === confirmedOwnerBytes;
        if (!sameGeneration) return { ok: false, reason: "transaction-in-progress", owner: confirmedOwner };
        const confirmedAt = Number(confirmedOwner?.createdAt || observedAt || 0);
        const confirmedState = canonicalLockOwnerState(confirmedOwner, { processAlive: isProcessAlive, processIdentity });
        const confirmedStale = confirmedState === "dead"
          || (confirmedState === "unknown" && confirmedAt > 0 && now() - confirmedAt > staleAfterMs);
        if (!confirmedStale) return { ok: false, reason: "transaction-in-progress", owner: confirmedOwner };
        let confirmedClaim = null;
        try { confirmedClaim = JSON.parse(readFileSync(reclaimPath, "utf8")); } catch {}
        if (confirmedClaim?.nonce !== nonce) return { ok: false, reason: "transaction-in-progress", owner: confirmedOwner };
        const stalePath = `${lockPath}.stale-${now()}-${process.pid}-${nonce}`;
        renameSync(lockPath, stalePath);
        claimed = false;
        try { rmSync(stalePath, { recursive: true, force: true }); } catch {}
      } catch {
        return { ok: false, reason: "transaction-lock-unavailable", owner };
      } finally {
        if (claimed) {
          let claim = null;
          try { claim = JSON.parse(readFileSync(reclaimPath, "utf8")); } catch {}
          if (claim?.nonce === nonce) {
            try { rmSync(reclaimPath, { force: true }); } catch {}
          }
        }
      }
      continue;
    }

    const ownerProcessIdentity = processIdentity(process.pid);
    const owner = {
      ...ownerIdentity,
      pid: process.pid,
      nonce,
      createdAt: now(),
      ...(ownerProcessIdentity ? { processIdentity: ownerProcessIdentity } : {}),
    };
    const publishedOwnerBytes = `${JSON.stringify(owner)}\n`;
    try {
      writeFileSync(ownerPath, publishedOwnerBytes, { mode: 0o600, flag: "wx" });
      // Publication and reclamation form a two-sided handshake. Check the
      // claim first: if a reclaimer already won, abort; if it arrives after
      // this check, its mandatory owner re-read will observe us as live.
      try {
        readFileSync(reclaimPath, "utf8");
        throw new Error("Relay lost canonical runtime lock ownership to a recovery claimant.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      let confirmedOwnerBytes = null;
      let confirmedStat = null;
      try { confirmedOwnerBytes = String(readFileSync(ownerPath, "utf8")); } catch {}
      try { confirmedStat = statSync(lockPath, { bigint: true }); } catch {}
      const comparableGeneration = createdStat?.dev !== undefined && createdStat?.ino !== undefined
        && confirmedStat?.dev !== undefined && confirmedStat?.ino !== undefined;
      if (confirmedOwnerBytes !== publishedOwnerBytes
        || (comparableGeneration && !sameCanonicalLockGeneration(createdStat, confirmedStat))) {
        throw new Error("Relay lost canonical runtime lock ownership while publishing its owner record.");
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        let currentStat = null;
        try { currentStat = statSync(lockPath, { bigint: true }); } catch {}
        if (!existsSync(ownerPath)
          && sameCanonicalLockGeneration(createdStat, currentStat, { requireBirth: true })) {
          try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
        }
      }
      throw error;
    }
    const release = () => {
      let currentOwner = null;
      try { currentOwner = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {}
      if (currentOwner?.nonce === nonce) rmSync(lockPath, { recursive: true, force: true });
    };
    // Machines that ran the leaking build already carry the debris, and nothing else
    // ever looks at these names. Sweep them once per transaction so an upgrade heals
    // the directory instead of inheriting it.
    try {
      const parent = api.dirname(lockPath);
      const prefix = `${api.basename(lockPath)}.stale-`;
      for (const entry of readdirSync(parent)) {
        if (String(entry).startsWith(prefix)) {
          try { rmSync(api.join(parent, entry), { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
    return { ok: true, owner, release };
  }
  return { ok: false, reason: "transaction-lock-unavailable" };
}

/**
 * Install an exact Relay version into an immutable Relay-owned release, then switch.
 *
 * Contract:
 * - `preCommitVerify(candidate)` may only inspect/smoke-test the candidate.
 * - an `activating` journal is atomically written before
 *   `postCommitActivate(candidate)` may rewrite launchers/configs or restart services;
 *   readers and ownership guards do not treat it as the current runtime.
 * - activation must return `{ok:true}` only after exact-root service liveness.
 * - only then is `current.json` atomically flipped to `active`; no active pointer
 *   can ever precede service health.
 * - activation failure restores prior configs/services through the explicit
 *   canonical-or-legacy `rollbackTarget`, then restores the pointer/tombstone.
 * - no legacy/global package tree is ever renamed or deleted.
 */
export async function repairCanonicalRuntime({
  version,
  homeDir = os.homedir(),
  platform = process.platform,
  node = process.execPath,
  npmCommand = platform === "win32" ? "npm.cmd" : "npm",
  env = {},
  installCandidate = defaultInstallCandidate,
  verifyCandidate = verifyCanonicalCandidate,
  preCommitVerify = async () => ({ ok: true }),
  postCommitActivate = async () => ({ ok: true }),
  rollbackActivate = async () => ({ ok: true }),
  rollbackTarget = null,
  now = Date.now,
  nonce = () => `${process.pid}-${Math.random().toString(16).slice(2)}`,
  fsImpl = fs,
  cleanupReleases = pruneCanonicalReleases,
  protectedPackageRoots = [],
  normalizePreviousTarget = (target) => target,
  onLockAcquired = () => {},
  lockIdentity = {},
} = {}) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ""))) {
    return { ok: false, phase: "input", reason: "exact-version-required" };
  }
  const releaseId = `${safeSegment(version)}-${now()}-${safeSegment(nonce())}`;
  const layout = canonicalRuntimeLayout({ homeDir, platform, releaseId });
  // Do not spread `fsImpl`: injected implementations commonly put their methods on
  // the prototype, and spreading would silently drop them and fall back to the host
  // filesystem. Keep every filesystem dependency explicit.
  const io = {
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    renameSync: fsImpl.renameSync.bind(fsImpl),
    rmSync: fsImpl.rmSync.bind(fsImpl),
    existsSync: fsImpl.existsSync.bind(fsImpl),
    statSync: fsImpl.statSync.bind(fsImpl),
    accessSync: fsImpl.accessSync.bind(fsImpl),
    readdirSync: typeof fsImpl.readdirSync === "function" ? fsImpl.readdirSync.bind(fsImpl) : undefined,
    processAlive: typeof fsImpl.processAlive === "function" ? fsImpl.processAlive.bind(fsImpl) : undefined,
    processIdentity: typeof fsImpl.processIdentity === "function" ? fsImpl.processIdentity.bind(fsImpl) : undefined,
  };
  const lockOptions = { ...io, platform, now, ownerIdentity: lockIdentity };
  if (!lockOptions.processAlive) delete lockOptions.processAlive;
  if (!lockOptions.processIdentity) delete lockOptions.processIdentity;
  if (!lockOptions.readdirSync) delete lockOptions.readdirSync;
  let lock = null;
  try {
    lock = acquireLock(layout.lockPath, lockOptions);
  } catch (error) {
    return { ok: false, phase: "lock", reason: "transaction-lock-unavailable", detail: error?.message || String(error) };
  }
  if (!lock.ok) return { ok: false, phase: "lock", reason: lock.reason, owner: lock.owner || null };
  try {
    await onLockAcquired(lock.owner);
  } catch (error) {
    try { lock.release(); } catch {}
    return { ok: false, phase: "admission", reason: "worker-admission-failed", detail: error?.message || String(error) };
  }
  const storedPrevious = readCanonicalRuntime({ homeDir, platform, readFileSync: io.readFileSync });
  let previous = storedPrevious;
  if (storedPrevious) {
    try { previous = normalizePreviousTarget(storedPrevious) || storedPrevious; } catch {}
  }
  let activationJournalWritten = false;
  let activationStarted = false;
  let rollbackSucceeded = false;
  let candidate = null;
  // Everything the pruner would keep is excluded from adoption: the current
  // pointer's release, and any release a live process is running from.
  const adoptionExclude = new Set([storedPrevious?.releaseId].filter(Boolean));
  {
    const api = pathsFor(platform);
    for (const protectedRoot of protectedPackageRoots) {
      if (!isCanonicalPackageRoot(protectedRoot, { homeDir, platform })) continue;
      const relative = api.relative(layout.releasesDir, api.resolve(protectedRoot));
      const releaseId = relative.split(api.sep)[0];
      if (releaseId) adoptionExclude.add(releaseId);
    }
  }
  try {
    let chosen = null;
    let reused = false;
    try {
      chosen = findReusableRelease({ version, layout, platform, io, exclude: adoptionExclude, verifyCandidate });
    } catch {
      chosen = null;
    }
    if (chosen) {
      reused = true;
    } else {
      io.mkdirSync(layout.stagingDir, { recursive: true, mode: 0o700 });
      const installed = await installCandidate({ npmCommand, stagingRoot: layout.stagingRoot, version, env, node, platform });
      if (!installed?.ok) return { ok: false, phase: "install", reason: "candidate-install-failed", detail: installed?.detail || "", previous };
      const staged = verifyCandidate(layout.stagingPackageRoot, version, {
        platform,
        existsSync: io.existsSync,
        readFileSync: io.readFileSync,
        statSync: io.statSync,
        accessSync: io.accessSync,
      });
      if (!staged?.ok) return { ok: false, phase: "verify", reason: staged?.reason || "candidate-verification-failed", detail: staged?.detail || "", previous };
      const smoke = await preCommitVerify({ ...staged, releaseRoot: layout.stagingRoot, node, version });
      if (!smoke?.ok) return { ok: false, phase: "pre-commit", reason: smoke?.reason || "candidate-smoke-failed", detail: smoke?.detail || "", previous };
      io.mkdirSync(layout.releasesDir, { recursive: true, mode: 0o700 });
      io.renameSync(layout.stagingRoot, layout.releaseRoot);
      chosen = { releaseId: layout.releaseId, releaseRoot: layout.releaseRoot, packageRoot: layout.packageRoot, bin: layout.bin };
    }
    const published = verifyCandidate(chosen.packageRoot, version, {
      platform,
      existsSync: io.existsSync,
      readFileSync: io.readFileSync,
      statSync: io.statSync,
      accessSync: io.accessSync,
    });
    if (!published?.ok) {
      // Renamed out of staging (or adopted) but invalid: nothing references it and
      // the `finally` only cleans staging, so without this it leaks a full release.
      removeStrandedRelease(chosen.releaseRoot, { releasesDir: layout.releasesDir, platform, rmSync: io.rmSync });
      return { ok: false, phase: "publish-verify", reason: published?.reason || "published-candidate-invalid", detail: published?.detail || "", previous };
    }
    if (reused) {
      const smoke = await preCommitVerify({ ...published, releaseRoot: chosen.releaseRoot, node, version });
      if (!smoke?.ok) {
        removeStrandedRelease(chosen.releaseRoot, { releasesDir: layout.releasesDir, platform, rmSync: io.rmSync });
        return { ok: false, phase: "pre-commit", reason: smoke?.reason || "candidate-smoke-failed", detail: smoke?.detail || "", previous };
      }
    }
    candidate = {
      schema: CANONICAL_RUNTIME_SCHEMA,
      active: true,
      version,
      releaseId: chosen.releaseId,
      releaseRoot: chosen.releaseRoot,
      packageRoot: chosen.packageRoot,
      bin: chosen.bin,
      electronPath: published.electronPath,
      node,
      preparedAt: now(),
    };
    const activating = {
      schema: CANONICAL_RUNTIME_SCHEMA,
      state: "activating",
      active: false,
      candidate,
      previous: previous || rollbackTarget || null,
      preparedAt: now(),
    };
    atomicWritePointer(layout.pointerPath, activating, { ...io, platform });
    activationJournalWritten = true;
    activationStarted = true;
    const activated = await postCommitActivate(candidate, { previous });
    if (!activated?.ok) {
      const target = previous || rollbackTarget || null;
      let rollback = null;
      try {
        rollback = await rollbackActivate(target, { failed: candidate, activation: activated, previous });
      } catch (error) {
        rollback = { ok: false, reason: "rollback-threw", detail: error?.message || String(error) };
      }
      const rollbackPointer = previous || {
        schema: CANONICAL_RUNTIME_SCHEMA,
        active: false,
        rolledBackFrom: candidate.releaseId,
        committedAt: now(),
      };
      if (rollback?.ok) {
        atomicWritePointer(layout.pointerPath, rollbackPointer, { ...io, platform });
        // The rollback has already run (it executes through the failed candidate's
        // bin, so the tree was needed until this point) and the pointer no longer
        // references the candidate: it is pure debris now. Keeping it was Bug 4 —
        // every failed activation stranded ~650MB forever, and only the success
        // path ever pruned. Remove it, then sweep older debris too, so a machine
        // whose updates keep FAILING still converges to a bounded disk footprint.
        // On recovery-required the tree stays: recovery uses it as the repair
        // executable and may adopt it outright on the next attempt.
        removeStrandedRelease(candidate.releaseRoot, { releasesDir: layout.releasesDir, platform, rmSync: io.rmSync });
        try {
          cleanupReleases({
            homeDir,
            platform,
            active: previous?.active === true ? previous : null,
            previous: null,
            protectedPackageRoots,
            retainRecent: 1,
            fsImpl,
          });
        } catch {}
      } else {
        atomicWritePointer(layout.pointerPath, {
          ...activating,
          state: "recovery-required",
          failure: { phase: "rollback", reason: rollback?.reason || "rollback-failed", detail: rollback?.detail || "" },
          updatedAt: now(),
        }, { ...io, platform });
      }
      return {
        ok: false,
        phase: "activate",
        reason: activated?.reason || "candidate-activation-failed",
        detail: activated?.detail || "",
        candidate,
        previous,
        rollbackTarget: target,
        rolledBack: rollback?.ok === true,
        rollbackOk: rollback?.ok === true,
      };
    }
    candidate = { ...candidate, state: "active", active: true, committedAt: now() };
    atomicWritePointer(layout.pointerPath, candidate, { ...io, platform });
    let cleanup = null;
    try {
      cleanup = cleanupReleases({
        homeDir,
        platform,
        active: candidate,
        previous,
        protectedPackageRoots,
        retainRecent: 1,
        fsImpl,
      });
    } catch (error) {
      cleanup = { ok: false, reason: "release-cleanup-failed", detail: error?.message || String(error) };
    }
    return { ok: true, phase: "complete", candidate, previous, activation: activated, cleanup };
  } catch (error) {
    if (activationJournalWritten && candidate) {
      let rollback = null;
      try {
        rollback = await rollbackActivate(previous || rollbackTarget || null, { failed: candidate, error, previous });
        rollbackSucceeded = rollback?.ok === true;
      } catch (rollbackError) {
        rollback = { ok: false, reason: "rollback-threw", detail: rollbackError?.message || String(rollbackError) };
      }
      try {
        if (rollback?.ok) {
          atomicWritePointer(layout.pointerPath, previous || {
            schema: CANONICAL_RUNTIME_SCHEMA,
            active: false,
            rolledBackFrom: candidate.releaseId,
            committedAt: now(),
          }, { ...io, platform });
          // Same as the explicit activation-failure branch: rolled back, pointer
          // restored, the candidate tree is debris.
          removeStrandedRelease(candidate.releaseRoot, { releasesDir: layout.releasesDir, platform, rmSync: io.rmSync });
        } else atomicWritePointer(layout.pointerPath, {
          schema: CANONICAL_RUNTIME_SCHEMA,
          state: "recovery-required",
          active: false,
          candidate,
          previous: previous || rollbackTarget || null,
          failure: { phase: "rollback", reason: rollback?.reason || "rollback-failed", detail: rollback?.detail || "" },
          updatedAt: now(),
        }, { ...io, platform });
      } catch {}
    }
    return {
      ok: false,
      phase: activationStarted ? "activate" : "transaction",
      reason: "transaction-threw",
      detail: error?.message || String(error),
      candidate,
      previous,
      rollbackTarget: previous || rollbackTarget || null,
      rolledBack: rollbackSucceeded,
    };
  } finally {
    try { lock.release(); } catch {}
    // Only Relay-owned, unpublished staging is disposable. Published releases and
    // every legacy/global tree remain untouched for rollback and forensics.
    try { if (io.existsSync(layout.stagingRoot)) io.rmSync(layout.stagingRoot, { recursive: true, force: true }); } catch {}
  }
}
