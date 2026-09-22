"use strict";
// Entry point for the native application. No npm, no remote feed lookup,
// no automatic execution on import. Preview receipts can never activate it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const bootstrap = require("./relay-setup.cjs");
const { APPLICATION_ID, applicationOwner } = require("./application-owner.cjs");

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function versionCompare(a, b) {
  const aa = a.split(".").map(BigInt), bb = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

async function verifyBundle({ resourcesDir, activationEnabled = false, trustStore, platformKey = bootstrap.releasePlatform() } = {}) {
  if (activationEnabled !== true) throw new Error("Application activation is disabled");
  const receipt = read(path.join(resourcesDir, "candidate.json"));
  if (receipt.schema !== 1 || receipt.distribution !== "application" || receipt.appId !== APPLICATION_ID
    || receipt.activationEnabled !== true || receipt.platform !== platformKey || receipt.packagingSourceDirty !== false
    || !/^\d+\.\d+\.\d+$/.test(receipt.applicationVersion || receipt.version || "")
    || !/^[a-f0-9]{40}$/.test(receipt.packagingSourceSha || "")) throw new Error("This application is a preview or has an invalid release identity");
  // Do not honor environment overrides for release trust in native installers.
  if (process.env.RELAY_ALLOW_DEV_RELEASE_KEY || process.env.RELAY_RELEASE_PUBLIC_KEY) throw new Error("Native setup does not accept development release keys");
  const verified = bootstrap.parseSignedManifest(fs.readFileSync(path.join(resourcesDir, "runtime-manifest.json")),
    { version: receipt.version, platformKey, ...(trustStore ? { trustStore } : {}) });
  if (verified.payload.sourceSha !== receipt.runtimeSourceSha) throw new Error("Application runtime source mismatch");
  const delivery = receipt.runtimeDelivery || "bundled";
  if (!["bundled", "download"].includes(delivery)) throw new Error("Unsupported application runtime delivery");
  const archive = delivery === "bundled" ? path.join(resourcesDir, "runtime.tar.gz") : null;
  if (archive) {
    if (fs.statSync(archive).size !== verified.artifact.bytes) throw new Error("Bundled runtime size mismatch");
    const hash = crypto.createHash("sha512");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (`sha512-${hash.digest("base64")}` !== verified.artifact.sha512) throw new Error("Bundled runtime digest mismatch");
  }
  const node = path.join(resourcesDir, process.platform === "win32" ? "node.exe" : "node");
  const nodeDigest = crypto.createHash("sha256").update(fs.readFileSync(node)).digest("hex");
  if (nodeDigest !== receipt.nodeSha256) throw new Error("Bundled Node digest mismatch");
  return { receipt, archive, artifact: verified.artifact, node, platformKey };
}

function extractBundle(bundle, destination, { run = spawnSync } = {}) {
  if (fs.existsSync(destination)) throw new Error("Refusing to overwrite a staged runtime");
  bootstrap.validateArchiveListing(bundle.archive);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const invocation = bootstrap.tarInvocation({ archivePath: bundle.archive, mode: "extract", destination });
  const args = process.platform === "win32" ? invocation.args.map((arg) => arg.replaceAll("\\", "/")) : invocation.args;
  const extracted = run(invocation.command, args, { cwd: invocation.cwd, encoding: "utf8", windowsHide: true, timeout: 5 * 60_000 });
  if (extracted.error || extracted.status !== 0) throw new Error(`Runtime extraction failed: ${extracted.error?.message || extracted.stderr}`);
  bootstrap.restoreRuntimeLinks(destination);
  const packageRoot = path.join(destination, "node_modules", "relay-companion");
  const runtime = bootstrap.verifyExtractedRuntime(packageRoot, bundle.receipt.version, bundle.platformKey);
  if (!fs.existsSync(path.join(packageRoot, "bootstrap", "application-owner.cjs"))) throw new Error("The bundled runtime predates application ownership; publish the bridge runtime first");
  return runtime;
}

function readCurrent(homeDir) {
  const file = path.join(homeDir, ".relay", "runtime", "current.json");
  try { return read(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// An installed runtime whose services are not running is not proof of a
// broken installation: a home folder restored onto a fresh OS keeps every file
// under ~/.relay and loses every logon task (Shane, 2026-09-19). Before that
// runtime is judged unhealthy, let its own CLI register and start its services,
// the same command `relay doctor` names. Never throws; the caller re-checks.
function repairInstalledRuntime(current, { run = spawnSync } = {}) {
  if (typeof current?.node !== "string" || typeof current?.bin !== "string") return { ok: false, reason: "runtime-cli-unknown" };
  const result = run(current.node, [current.bin, "repair-installation"], { encoding: "utf8", windowsHide: true, timeout: 3 * 60_000 });
  const ok = !result.error && result.status === 0;
  return { ok, reason: ok ? "repaired" : "repair-command-failed",
    detail: String(result.error?.message || result.stderr || result.stdout || "").trim().slice(0, 500) };
}

async function installFromApplication({ resourcesDir, applicationRoot, executable, activationEnabled = false,
  homeDir = os.homedir(), verify = verifyBundle, extract = extractBundle, activate = bootstrap.activateRuntime,
  acquireLock = bootstrap.acquireCanonicalLock, health = require("./runtime-health.cjs").exactRuntimeHealth,
  repairRuntime = repairInstalledRuntime,
  drain = require("./update-activity.cjs").drainCalls, download = bootstrap.downloadVerifiedArtifact,
  onProgress = () => {}, signal } = {}) {
  onProgress({ phase: "verifying", canCancel: false });
  // Verification finishes before creating anything in the person's Relay home.
  const bundle = await verify({ resourcesDir, activationEnabled });
  const channel = bundle.receipt.channel || "stable";
  if (!["stable", "dev"].includes(channel)) throw new Error("Unsupported application channel");
  const root = fs.realpathSync(applicationRoot);
  const receiptPath = fs.realpathSync(path.join(resourcesDir, "candidate.json"));
  if (!inside(root, fs.realpathSync(executable)) || !inside(root, receiptPath)) throw new Error("Application executable and receipt must belong to the installed application");
  if (path.resolve(homeDir) !== path.resolve(os.homedir()) && activate === bootstrap.activateRuntime) {
    throw new Error("Native activation must run in the target user's own login session");
  }
  const runtimeRoot = path.join(homeDir, ".relay", "runtime");
  const lock = acquireLock(path.join(runtimeRoot, "transaction.lock"));
  const ownerPath = path.join(homeDir, ".relay", "application-owner.json");
  const journalPath = path.join(homeDir, ".relay", "application-migration.json");
  let releaseDrain;
  let downloadDirectory;
  try {
    const recordedCurrent = readCurrent(homeDir);
    let removed;
    try { removed = read(path.join(homeDir, ".relay", "application-uninstall.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const reinstall = removed?.schema === 1 && removed.state === "complete"
      && recordedCurrent?.state === "inactive" && recordedCurrent.applicationUninstalled === removed.installationId;
    if (reinstall && /^\d+\.\d+\.\d+$/.test(recordedCurrent.version || "")
      && versionCompare(bundle.receipt.version, recordedCurrent.version) < 0) throw new Error("An older installer cannot downgrade the retained Relay runtime");
    const current = reinstall ? null : recordedCurrent;
    const configFile = path.join(homeDir, ".relay", "config.json");
    let config = {};
    try { config = read(configFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current && (config.updateChannel || "stable") !== channel) throw new Error(`Switch Relay to ${channel === "stable" ? "prod" : channel} with relay env before installing this candidate`);
    let priorJournal;
    try { priorJournal = read(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current && (current.schema !== 1 || current.active !== true || current.state !== "active"
      || !/^\d+\.\d+\.\d+$/.test(current.version || "")
      || !inside(path.join(runtimeRoot, "releases"), current.packageRoot || ""))) {
      throw new Error("Existing Relay needs recovery before application migration");
    }
    const retryFreshRollback = priorJournal?.schema === 1 && priorJournal.state === "rolled-back" && priorJournal.previous === null;
    if (!current && !reinstall && !retryFreshRollback && ["config.json", "recovery"].some((name) => fs.existsSync(path.join(homeDir, ".relay", name)))) {
      throw new Error("Legacy installation requires the separately planned repair route");
    }
    if (current && versionCompare(bundle.receipt.version, current.version) < 0) throw new Error("An older installer cannot downgrade Relay");
    require("./recovery-intent.cjs").setStopped(false, homeDir);
    // Live services, not files, decide whether the existing Relay is healthy.
    // A runtime whose daemon and pill are not running gets one repair through
    // its own CLI before it is judged; only a runtime that stays down blocks.
    let repairedExisting = false;
    if (current && !(await health(current, { platform: process.platform })).ok) {
      onProgress({ phase: "installing", canCancel: false });
      const repaired = await repairRuntime(current);
      if (!repaired?.ok || !(await health(current, { platform: process.platform })).ok) {
        throw new Error("Existing Relay is not healthy enough to bridge");
      }
      repairedExisting = true;
    }
    // Interrupted ownership changes require explicit reconciliation below; never
    // overwrite a journal whose runtime/owner outcome is still uncertain.
    if (priorJournal && !["complete", "rolled-back"].includes(priorJournal.state)) {
      throw new Error("An interrupted application migration needs reconcileApplication first");
    }
    const installedOwner = applicationOwner({ homeDir });
    let previousOwner = null;
    try { previousOwner = read(ownerPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const previousApplicationVersion = previousOwner?.applicationVersion || previousOwner?.version;
    if (previousOwner?.appId === APPLICATION_ID && /^\d+\.\d+\.\d+$/.test(previousApplicationVersion || "")
      && versionCompare(previousApplicationVersion, bundle.receipt.applicationVersion || bundle.receipt.version) > 0) throw new Error("An older installer cannot downgrade the Relay application");
    if (installedOwner?.root === root && installedOwner.packagingSourceSha === bundle.receipt.packagingSourceSha
      && (installedOwner.applicationVersion || installedOwner.version) === (bundle.receipt.applicationVersion || bundle.receipt.version)
      && current && versionCompare(current.version, bundle.receipt.version) >= 0) {
      onProgress({ phase: "ready", canCancel: false });
      return { ok: true, alreadyInstalled: true, repaired: repairedExisting, owner: installedOwner, runtime: current, updateOwner: "canonical-runtime" };
    }
    if (bundle.receipt.runtimeDelivery === "download") {
      signal?.throwIfAborted();
      // Stage beside releases: tar requires archive and destination on one volume.
      const releasesDir = path.join(runtimeRoot, "releases");
      fs.mkdirSync(releasesDir, { recursive: true, mode: 0o700 });
      // The canonical lock proves no other setup owns these partial downloads.
      bootstrap.removeAbandonedRuntimeDownloads(releasesDir);
      downloadDirectory = fs.mkdtempSync(path.join(releasesDir, ".relay-download-application-"));
      bundle.archive = path.join(downloadDirectory, "runtime.tar.gz");
      onProgress({ phase: "downloading", receivedBytes: 0, totalBytes: bundle.artifact.bytes, canCancel: true });
      await download(bundle.artifact.url, bundle.archive, bundle.artifact, { signal,
        onProgress: progress => onProgress({ ...progress, phase: "downloading", canCancel: true }) });
      signal?.throwIfAborted();
    }
    onProgress({ phase: "extracting", canCancel: false });
    const releaseId = `${bundle.receipt.version}-${bundle.platformKey}-${crypto.randomBytes(8).toString("hex")}`;
    const releaseRoot = path.join(runtimeRoot, "releases", releaseId);
    const runtime = extract(bundle, releaseRoot);
    const layout = { root: runtimeRoot, releaseId, releaseRoot, releasesDir: path.dirname(releaseRoot),
      packageRoot: runtime.packageRoot, pointerPath: path.join(runtimeRoot, "current.json"), lockPath: path.join(runtimeRoot, "transaction.lock") };
    const owner = { schema: 1, appId: APPLICATION_ID, platform: process.platform,
      root, executable, receipt: receiptPath, version: bundle.receipt.version,
      applicationVersion: bundle.receipt.applicationVersion || bundle.receipt.version,
      packagingSourceSha: bundle.receipt.packagingSourceSha, installationId: !reinstall && previousOwner?.installationId || crypto.randomUUID(),
      updateOwner: "canonical-runtime" };
    const journal = { schema: 1, state: "prepared", owner, previousOwner, previous: current, releaseId, at: Date.now() };
    atomic(journalPath, journal);
    onProgress({ phase: "installing", canCancel: false });
    releaseDrain = await drain({ homeDir });
    atomic(journalPath, { ...journal, state: "activating" });
    // Fresh Dev setup selects its account API before any runtime connects.
    // Existing installations must already select this channel explicitly.
    if (!current && channel === "dev") atomic(configFile, { ...config, updateChannel: "dev", apiUrl: "https://dev-api.sendrelays.com", devApiUrl: "https://dev-api.sendrelays.com" });
    atomic(ownerPath, owner);
    // Activation starts the pill. The marker, written first so the pill reads
    // it on its first paint, opens that pill centred with Continue with Google
    // in place of the setup window. A marker that cannot be written costs one
    // window position, not the install, so it never fails setup.
    try { bootstrap.writeSetupIntent(path.join(homeDir, ".relay"), bundle.receipt.version, [], { application: true }); } catch {}
    try {
      // This is the existing OS service/MCP/skill registration transaction, with
      // exact-root health, advancing heartbeat, durable Node and rollback.
      const result = await activate(layout, runtime, bundle.receipt.version, { homeDir });
      atomic(journalPath, { ...journal, state: "complete", completedAt: Date.now() });
      onProgress({ phase: "ready", canCancel: false });
      return { ok: true, owner, runtime: result.candidate, updateOwner: "canonical-runtime" };
    } catch (error) {
      // Bootstrap owns service rollback. Only restore our launcher marker once
      // the durable runtime pointer proves it restored the previous owner.
      const after = readCurrent(homeDir);
      const restored = current ? after?.active === true && after.packageRoot === current.packageRoot : after === null;
      if (restored) {
        if (previousOwner) atomic(ownerPath, previousOwner); else fs.rmSync(ownerPath, { force: true });
        atomic(journalPath, { ...journal, state: "rolled-back", failure: String(error.message).slice(0, 500) });
      } else atomic(journalPath, { ...journal, state: "recovery-required", failure: String(error.message).slice(0, 500) });
      throw error;
    }
  } finally {
    try { releaseDrain?.(); }
    finally {
      lock.release();
      if (downloadDirectory) fs.rmSync(downloadDirectory, { recursive: true, force: true });
    }
  }
}

async function reconcileApplication({ homeDir = os.homedir(), acquireLock = bootstrap.acquireCanonicalLock,
  health = require("./runtime-health.cjs").exactRuntimeHealth } = {}) {
  const root = path.join(homeDir, ".relay");
  const lock = acquireLock(path.join(root, "runtime", "transaction.lock"));
  try {
    const file = path.join(root, "application-migration.json");
    const journal = read(file);
    if (journal.schema !== 1 || !["prepared", "activating", "recovery-required", "complete", "rolled-back"].includes(journal.state)) throw new Error("Invalid application migration journal");
    if (["complete", "rolled-back"].includes(journal.state)) return journal;
    const current = readCurrent(homeDir);
    if (current?.active === true && current.state === "active" && current.releaseId === journal.releaseId
      && (await health(current, { platform: process.platform })).ok) {
      atomic(path.join(root, "application-owner.json"), journal.owner);
      atomic(file, { ...journal, state: "complete", completedAt: Date.now() });
      return { ok: true, state: "complete" };
    }
    const restored = journal.previous ? current?.active === true && current.packageRoot === journal.previous.packageRoot
      && (await health(current, { platform: process.platform })).ok : current === null;
    if (!restored) return { ok: false, state: "recovery-required", reason: "Wait for the independent runtime recovery engine before reconciling application ownership" };
    if (journal.previousOwner) atomic(path.join(root, "application-owner.json"), journal.previousOwner);
    else fs.rmSync(path.join(root, "application-owner.json"), { force: true });
    atomic(file, { ...journal, state: "rolled-back" });
    return { ok: true, state: "rolled-back" };
  } finally { lock.release(); }
}

module.exports = { verifyBundle, extractBundle, installFromApplication, reconcileApplication, repairInstalledRuntime, versionCompare };
