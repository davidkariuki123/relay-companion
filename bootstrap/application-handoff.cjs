"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const bootstrap = require("./relay-setup.cjs");
const { runBridge } = require("./application-bridge.cjs");
const release = require("./application-release.cjs");
const native = require("./application-package.cjs");
const lifecycle = require("./application-install.cjs");
const { applicationOwner } = require("./application-owner.cjs");
const io = require("./recovery-launcher.cjs");
const { exactRuntimeHealth } = require("./runtime-health.cjs");
const { waitForRecoveryReady } = require("./recovery-readiness.cjs");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function read(file) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid native handoff record"); return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function updateConsent({ homeDir, env = process.env }) {
  if (/^(0|false|off|no)$/i.test(String(env.RELAY_AUTO_UPDATE || ""))
    || read(path.join(homeDir, ".relay", "recovery", "policy.json"))?.autoUpdate === false) return { ok: false, reason: "updates-disabled" };
  const root = path.join(homeDir, ".relay");
  if (env.RELAY_CONFIG || env.RELAY_CONFIG_DIR) return { ok: false, reason: "custom-configuration-preserved" };
  const config = read(path.join(root, "config.json"));
  const channel = env.RELAY_UPDATE_CHANNEL || config?.updateChannel || "stable";
  if (!["stable", "dev"].includes(channel)) return { ok: false, reason: "non-stable-channel-preserved" };
  return { ok: true, channel, deviceId: config?.deviceId || "" };
}
function recoveryProof({ homeDir, version, platform = process.platform, run = spawnSync }) {
  const root = path.join(homeDir, ".relay", "recovery");
  const current = read(path.join(root, "current.json"));
  if (!io.validPointer(current, root) || current.version !== version) return { ok: false };
  const check = run(current.node, [path.join(current.bundle, "bootstrap", "recovery-runner.cjs"), "--self-check"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (check.error || check.status !== 0) return { ok: false };
  const scheduler = platform === "win32" ? ["schtasks.exe", ["/Query", "/TN", "Relay Companion Recovery", "/XML"]]
    : platform === "darwin" ? ["launchctl", ["print", `gui/${process.getuid()}/work.relay.companion.recovery`]]
      : ["systemctl", ["--user", "show", "work.relay.companion.recovery.service", "--property=ExecStart", "--value"]];
  const observed = run(...scheduler, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const text = String(observed.stdout || "").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  const launcher = path.join(root, "launch.cjs");
  const host = read(path.join(root, "launcher-node.json"))?.node;
  if (platform === "win32") {
    const wrapper = path.join(root, "launch.vbs");
    const expected = `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("${`"${host}" "${launcher}"`.replaceAll('"', '""')}", 0, True)\r\n`;
    let exactWrapper = false;
    try { exactWrapper = fs.readFileSync(wrapper, "utf8") === expected; } catch {}
    return { ok: !observed.error && observed.status === 0 && typeof host === "string"
      && text.includes(wrapper) && /<Command>wscript\.exe<\/Command>/i.test(text)
      && !/<Enabled>false<\/Enabled>/i.test(text) && exactWrapper };
  }
  if (platform === "linux") {
    const timer = run("systemctl", ["--user", "is-active", "work.relay.companion.recovery.timer"], { encoding: "utf8", timeout: 30_000 });
    if (timer.error || timer.status !== 0 || String(timer.stdout).trim() !== "active") return { ok: false };
  }
  return { ok: !observed.error && observed.status === 0 && typeof host === "string" && text.includes(host) && text.includes(launcher) };
}

async function handoffApplication({ activationEnabled = false, envelope, version, sourceSha, file,
  homeDir = os.homedir(), platform = process.platform, arch = process.arch, env = process.env,
  trustStore, health = exactRuntimeHealth, ready = waitForRecoveryReady, verifyRecovery = recoveryProof,
  installPackage = native.installNativePackage, activate = lifecycle.installFromApplication,
  reconcile = lifecycle.reconcileApplication, run = spawnSync,
  drain = require("./update-activity.cjs").drainCalls } = {}) {
  if (activationEnabled !== true) return { state: "disabled", changed: false };
  if (platform !== process.platform && installPackage === native.installNativePackage) throw new Error("Use the native platform for application handoff");
  const payload = release.verifyApplicationRelease(envelope, { version, sourceSha, ...(trustStore ? { trustStore } : {}) });
  const consent = updateConsent({ homeDir, env });
  if (!consent.ok) return { state: consent.reason, changed: false };
  if ((payload.channel || "stable") !== consent.channel) return { state: "channel-mismatch", changed: false };
  const platformKey = `${platform}-${arch}`;
  const artifacts = payload.artifacts[platformKey];
  const kind = platform === "darwin" ? "zip" : platform === "win32" ? "exe" : file?.endsWith(".rpm") ? "rpm" : "deb";
  const artifact = artifacts?.find(item => item.kind === kind);
  if (!artifact) throw new Error("No native artifact for this host");
  await release.verifyApplicationArtifact(file, artifact);
  const base = path.join(homeDir, ".relay"), pointerPath = path.join(base, "runtime", "current.json");
  const ownerPath = path.join(base, "application-owner.json");
  const workDir = path.join(base, "application-packages", `${version}-${sourceSha}-${platformKey}`);
  const journalFile = path.join(workDir, "bridge.json"), snapshotFile = path.join(workDir, "previous.json");
  const target = { version, sourceSha }, transactionId = `application_${sourceSha}_${platformKey}`;
  let lock, releaseDrain, snapshot, location;
  const current = () => read(pointerPath);
  const adapters = {
    lock() {
      lock = bootstrap.acquireCanonicalLock(path.join(base, "runtime", "transaction.lock"));
      return () => { releaseDrain?.(); lock.release(); };
    },
    load: () => read(journalFile), save: value => write(journalFile, value),
    async currentUpdateComplete() {
      const consent = updateConsent({ homeDir, env });
      if (!consent.ok) return { ...consent, preserveCurrent: true };
      const active = current();
      if (!active?.active || active.state !== "active" || !/^\d+\.\d+\.\d+$/.test(active.version || "")
        || !nativeLocationInside(path.join(base, "runtime", "releases"), active.packageRoot)) return { ok: false };
      snapshot = read(snapshotFile);
      // Another updater may have advanced after an interrupted handoff. Never
      // turn an old journal into authorization to roll that newer runtime back.
      if (lifecycle.versionCompare(active.version, payload.runtime.version) > 0) return { ok: false, preserveCurrent: true, reason: "newer-runtime-preserved" };
      const owner = applicationOwner({ homeDir, platform });
      if (owner && lifecycle.versionCompare(owner.installedPackageVersion, version) > 0) return { ok: false, preserveCurrent: true, reason: "newer-application-preserved" };
      if (snapshot && active.packageRoot !== snapshot.previous?.packageRoot
        && !(owner?.packagingSourceSha === sourceSha && active.version === payload.runtime.version)) return { ok: false, preserveCurrent: true, reason: "another-runtime-transaction-preserved" };
      if (!(await health(active, { platform })).ok) return { ok: false };
      if (!snapshot) { snapshot = { schema: 1, previous: active, owner: read(ownerPath) }; write(snapshotFile, snapshot); }
      if (snapshot.schema !== 1 || !snapshot.previous?.active || !nativeLocationInside(path.join(base, "runtime", "releases"), snapshot.previous.packageRoot)) throw new Error("Invalid previous application owner");
      return { ok: true };
    },
    async verifyTarget() { await release.verifyApplicationArtifact(file, artifact); return { ok: true }; },
    async stage() {
      // Verified immutable installer was downloaded outside the runtime lock.
      if (platform === "linux" && installPackage === native.installNativePackage) {
        try { native.readReceipt(native.packageLocation({ platform, homeDir, env }), payload, platformKey); }
        catch {
          write(path.join(workDir, "action.json"), { state: "installer-action-required", changed: false, artifact: file,
            detail: "Install the verified package with your system package manager, then open Relay. Existing Relay is still running." });
          return { ok: false, preserveCurrent: true, reason: "installer-action-required" };
        }
      }
      return { ok: true };
    },
    async drain() { releaseDrain = await drain({ homeDir }); return { ok: true }; },
    async transferOwnership() {
      const installed = await installPackage({ payload, artifact, file, workDir, homeDir, platform, arch, env, activationEnabled: true });
      if (!installed.ok) {
        write(path.join(workDir, "action.json"), installed);
        if (installed.state === "installer-action-required" && installed.changed === false) return { ok: false, preserveCurrent: true, reason: installed.state };
        throw new Error(installed.state || "native-package-failed");
      }
      location = installed;
      const pending = read(path.join(base, "application-migration.json"));
      const sharedLock = () => ({ release() {} }); // The adapter owns the canonical lease for this whole transaction.
      if (pending && !["complete", "rolled-back"].includes(pending.state)) {
        const reconciled = await reconcile({ homeDir, acquireLock: sharedLock, health });
        if (!reconciled.ok) throw new Error("Runtime recovery must finish before resuming native handoff");
      }
      const result = await activate({ homeDir, resourcesDir: location.resourcesDir, applicationRoot: location.root,
        executable: location.executable, activationEnabled: true, acquireLock: sharedLock, drain: async () => () => {} });
      return { ok: result.ok === true };
    },
    async verifyHealth() {
      const active = current();
      const owner = applicationOwner({ homeDir, platform });
      return { ok: owner?.packagingSourceSha === sourceSha && owner.installedPackageVersion === version
        && active?.version === payload.runtime.version && (await health(active, { platform })).ok };
    },
    verifyRecovery: () => verifyRecovery({ homeDir, platform, version: payload.runtime.version }),
    observeStability: () => ready({ homeDir, platform, target: { version: payload.runtime.version, packageRoot: current()?.packageRoot }, requireProgress: true }),
    async restorePrevious() {
      snapshot ||= read(snapshotFile);
      const previous = snapshot?.previous;
      if (!previous || !nativeLocationInside(path.join(base, "runtime", "releases"), previous.packageRoot)
        || !nativeLocationInside(previous.packageRoot, previous.bin)) return { ok: false };
      if (current()?.active && lifecycle.versionCompare(current().version, payload.runtime.version) > 0) return { ok: false };
      let restored = current()?.packageRoot === previous.packageRoot && (await health(previous, { platform })).ok;
      if (!restored) {
        const result = run(previous.node, [previous.bin, "repair-runtime", "--no-trampoline", "--claim"], { encoding: "utf8", windowsHide: true, timeout: 3 * 60_000 });
        restored = !result.error && result.status === 0 && (await health(previous, { platform })).ok;
      }
      if (!restored) return { ok: false };
      write(pointerPath, previous);
      if (snapshot.owner) write(ownerPath, snapshot.owner); else fs.rmSync(ownerPath, { force: true });
      // Keep a newly installed outer shell and previous app backup as evidence.
      // Never run an OS uninstall while restoring the working runtime.
      write(path.join(workDir, "restored.json"), { previousVersion: previous.version, outerPackageRetained: true });
      return { ok: true };
    },
    async retirePrevious() {
      const active = current();
      if (active?.version !== payload.runtime.version || !(await health(active, { platform })).ok) return { ok: false };
      // Known-good runtime trees and account data remain recovery-owned. Retire
      // migration eligibility, not the rollback copy or the frozen npm bridge.
      write(path.join(base, "application-handoff-complete.json"), { schema: 1, ...target, platform: platformKey,
        runtime: payload.runtime, at: Date.now(), previousRuntimeRetained: true });
      return { ok: true };
    },
  };
  return runBridge({ activationEnabled: true, transactionId, target, adapters });
}
function nativeLocationInside(root, file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
module.exports = { handoffApplication, recoveryProof, updateConsent, write, read };
