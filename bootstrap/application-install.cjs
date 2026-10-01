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
const recovery = require("./application-recovery.cjs");

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
// Relay's own recovery check runs every minute. Setup stops the existing
// services during activation; a check that notices starts repairing them and
// collides with setup, which then fails with "Rollback failed" (CI, 2026-10-01).
// Pause the check (recovery honours intent.json) and wait out a run already in
// progress. The returned function restores the previous state, or leaves
// recovery running when setup succeeded.
async function pauseRecoveryChecks({ homeDir, timeoutMs = 3 * 60_000, pollMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const intent = require("./recovery-intent.cjs");
  const wasStopped = intent.stopped(homeDir);
  intent.setStopped(true, homeDir);
  const runLock = path.join(homeDir, ".relay", "recovery", "run.lock");
  for (const deadline = Date.now() + timeoutMs; ;) {
    try { bootstrap.acquireCanonicalLock(runLock).release(); break; }
    catch (error) {
      // Past the deadline setup proceeds, as it did before this pause existed.
      if (!/already in progress/.test(error.message) || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
  }
  return {
    repause: () => intent.setStopped(true, homeDir),
    resume: succeeded => intent.setStopped(succeeded ? false : wasStopped, homeDir),
  };
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

async function installFromApplication({ resourcesDir, applicationRoot, executable, activationEnabled = false,
  allowRecovery = true,
  homeDir = os.homedir(), verify = verifyBundle, extract = extractBundle, activate = bootstrap.activateRuntime,
  acquireLock = bootstrap.acquireCanonicalLock, health = require("./runtime-health.cjs").exactRuntimeHealth,
  recover = recovery.recoverWithCandidate, pauseRecovery = pauseRecoveryChecks,
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
  recovery.assertLocalPath(homeDir, path.join(runtimeRoot, "transaction.lock"));
  recovery.assertLocalPath(homeDir, path.join(runtimeRoot, "releases"));
  const lock = acquireLock(path.join(runtimeRoot, "transaction.lock"));
  const ownerPath = path.join(homeDir, ".relay", "application-owner.json");
  const journalPath = path.join(homeDir, ".relay", "application-migration.json");
  let releaseDrain;
  let downloadDirectory;
  let pausedRecovery, succeeded = false;
  try {
    const recordedCurrent = recovery.marker(path.join(runtimeRoot, "current.json"));
    const removed = recovery.marker(path.join(homeDir, ".relay", "application-uninstall.json"));
    const reinstall = removed?.schema === 1 && removed.state === "complete"
      && recordedCurrent?.state === "inactive" && recordedCurrent.applicationUninstalled === removed.installationId;
    if (reinstall && /^\d+\.\d+\.\d+$/.test(recordedCurrent.version || "")
      && versionCompare(bundle.receipt.version, recordedCurrent.version) < 0) throw new Error("An older installer cannot downgrade the retained Relay runtime");
    let current = reinstall ? null : recordedCurrent;
    const configFile = path.join(homeDir, ".relay", "config.json");
    let config = recovery.marker(configFile) || {};
    if (!config.invalid && (current || config.updateChannel) && (config.updateChannel || "stable") !== channel) throw new Error(`Switch Relay to ${channel === "stable" ? "prod" : channel} with relay env before installing this candidate`);
    const priorJournal = recovery.marker(journalPath);
    const recoveryFile = recovery.journalPath(homeDir);
    const priorRecovery = recovery.marker(recoveryFile);
    for (const state of [recordedCurrent?.candidate, recordedCurrent?.previous, priorRecovery]) {
      if (/^\d+\.\d+\.\d+$/.test(state?.version || "") && versionCompare(bundle.receipt.version, state.version) < 0) {
        throw new Error("An older installer cannot downgrade a retained Relay recovery candidate");
      }
    }
    let needsRecovery = Boolean(config.invalid || (current && (current.schema !== 1 || current.active !== true || current.state !== "active"
      || !/^\d+\.\d+\.\d+$/.test(current.version || "")
      || typeof current.packageRoot !== "string" || !inside(path.join(runtimeRoot, "releases"), current.packageRoot))));
    const retryFreshRollback = priorJournal?.schema === 1 && priorJournal.state === "rolled-back" && priorJournal.previous === null;
    if (!current && !reinstall && !retryFreshRollback && (["config.json", "recovery", "daemon.pid"].some((name) => fs.existsSync(path.join(homeDir, ".relay", name)))
      || fs.existsSync(path.join(homeDir, ".relay-companion")))) {
      needsRecovery = true;
    }
    // The runtime updates itself far more often than the app. Under an installed
    // Relay app a newer runtime stays and only the app is replaced (below); a
    // legacy installation is never handed to an app older than its runtime.
    const newerRuntime = Boolean(current && /^\d+\.\d+\.\d+$/.test(current.version || "")
      && versionCompare(bundle.receipt.version, current.version) < 0);
    if (newerRuntime && recovery.marker(ownerPath)?.appId !== APPLICATION_ID) throw new Error("An older installer cannot downgrade Relay");
    if (current && /^\d+\.\d+\.\d+$/.test(current.version || "") && versionCompare(current.version, "0.1.500") < 0) needsRecovery = true;
    // Never execute an old CLI as a prerequisite for rescuing it.
    if (current && !needsRecovery && !(await health(current, { platform: process.platform })).ok) needsRecovery = true;
    if (priorJournal && !["complete", "rolled-back"].includes(priorJournal.state)) {
      needsRecovery = true;
    }
    if (priorRecovery && priorRecovery.state !== "complete") needsRecovery = true;
    const installedOwner = applicationOwner({ homeDir });
    let previousOwner = recovery.marker(ownerPath);
    if (previousOwner?.invalid) needsRecovery = true;
    const previousApplicationVersion = previousOwner?.applicationVersion || previousOwner?.version;
    if (previousOwner?.appId === APPLICATION_ID && /^\d+\.\d+\.\d+$/.test(previousApplicationVersion || "")
      && versionCompare(previousApplicationVersion, bundle.receipt.applicationVersion || bundle.receipt.version) > 0) throw new Error("An older installer cannot downgrade the Relay application");
    if (needsRecovery && !allowRecovery) throw new Error("Relay needs recovery. Run setup again to recover this installation and sign in again.");
    if (!needsRecovery && installedOwner?.root === root && installedOwner.packagingSourceSha === bundle.receipt.packagingSourceSha
      && (installedOwner.applicationVersion || installedOwner.version) === (bundle.receipt.applicationVersion || bundle.receipt.version)
      && current && versionCompare(current.version, bundle.receipt.version) >= 0) {
      onProgress({ phase: "ready", canCancel: false });
      return { ok: true, alreadyInstalled: true, owner: installedOwner, runtime: current, updateOwner: "canonical-runtime" };
    }
    if (newerRuntime) {
      // Repairing would install this older runtime over the newer one; the
      // runtime's own recovery owns that. A healthy newer runtime keeps running.
      if (needsRecovery) throw new Error("An older installer cannot downgrade Relay");
      const owner = { schema: 1, appId: APPLICATION_ID, platform: process.platform,
        root, executable, receipt: receiptPath, version: bundle.receipt.version,
        applicationVersion: bundle.receipt.applicationVersion || bundle.receipt.version,
        packagingSourceSha: bundle.receipt.packagingSourceSha, installationId: previousOwner?.installationId || crypto.randomUUID(),
        updateOwner: "canonical-runtime" };
      const at = Date.now();
      atomic(journalPath, { schema: 1, state: "complete", owner, previousOwner, previous: current, releaseId: current.releaseId,
        runtimeKept: true, at, completedAt: at });
      atomic(ownerPath, owner);
      onProgress({ phase: "ready", canCancel: false });
      return { ok: true, applicationOnly: true, owner, runtime: current, updateOwner: "canonical-runtime" };
    }
    pausedRecovery = await pauseRecovery({ homeDir });
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
    if (needsRecovery) {
      // The verified replacement exists before cleanup. The reset explicitly
      // preserves this candidate, the canonical lease and this retry journal.
      atomic(recoveryFile, { schema: 1, state: "cleaning", releaseRoot, version: bundle.receipt.version, at: Date.now(),
        ...(priorRecovery?.deviceRetirement ? { deviceRetirement: priorRecovery.deviceRetirement } : {}) });
      onProgress({ phase: "recovering", canCancel: false });
      await recover({ bundle, runtime, releaseRoot, homeDir });
      const cleaned = recovery.marker(recoveryFile);
      atomic(recoveryFile, { ...cleaned, schema: 1, state: "installing", releaseRoot, version: bundle.receipt.version });
      current = null; previousOwner = null; config = {};
    }
    // A repair may have reset the recovery folder; keep checks paused until setup ends.
    pausedRecovery.repause();
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
    if (!needsRecovery) releaseDrain = await drain({ homeDir });
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
      if (needsRecovery) atomic(recoveryFile, { ...recovery.marker(recoveryFile), state: "complete", completedAt: Date.now() });
      onProgress({ phase: "ready", canCancel: false });
      succeeded = true;
      return { ok: true, recovered: needsRecovery, owner, runtime: result.candidate, updateOwner: "canonical-runtime" };
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
      try { pausedRecovery?.resume(succeeded); } catch { /* recovery reads a missing intent as running */ }
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

module.exports = { pauseRecoveryChecks, verifyBundle, extractBundle, installFromApplication, reconcileApplication, versionCompare };
