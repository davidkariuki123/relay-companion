import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import release from "../../packages/companion/bootstrap/application-release.cjs";
import { nativeInstallModes, brokenConditions, applyBrokenCondition, downloadPublishedInstaller, startProof, waitForOtherTransaction, lockDiagnostics } from "./native-install-proof.mjs";
const require = createRequire(import.meta.url);
// The Linux counterpart of test-windows-install.mjs: install the retained
// stock DEB with the package manager, activate through the bundled Node as the
// login user, and remove it again. It never touches a developer machine.
if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.RUNNER_TEMP) throw new Error("Use a disposable GitHub-hosted Linux runner, never a self-hosted one");
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const directory = path.resolve(arg("--directory")), mode = arg("--mode");
if (!nativeInstallModes.includes(mode)) throw new Error(`Use one of: ${nativeInstallModes.join(", ")}`);
const channel = process.env.CANDIDATE_CHANNEL || "dev";
if (!["dev", "stable"].includes(channel)) throw new Error("Use dev or stable channel");
const relayRoot = path.join(os.homedir(), ".relay");
if (fs.existsSync(relayRoot)) throw new Error("Refusing an existing installation on this runner");
const applicationRoot = "/opt/Relay";
if (fs.existsSync(applicationRoot)) throw new Error("Refusing an existing application package on this runner");
const receiptFile = path.join(directory, "packaging-receipt.json");
const receipt = JSON.parse(fs.readFileSync(receiptFile));
if (receipt.distribution !== "application" || !receipt.activationEnabled || receipt.channel !== channel || receipt.packagingSourceDirty
  || receipt.packagingSourceSha !== (process.env.CANDIDATE_SOURCE_SHA || process.env.GITHUB_SHA) || receipt.platform !== `linux-${process.arch}`) throw new Error("Wrong activating candidate");
const run = (file, parts, options = {}) => {
  const r = spawnSync(file, parts, { encoding: "utf8", timeout: 15 * 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  // A failing step names its reason on stderr and the steps it took on stdout; keep both.
  if (r.error || r.status !== 0) throw new Error(`${path.basename(file)} failed: ${r.error?.message || [r.stderr, r.stdout].filter(Boolean).join("\n").slice(-6000)}`);
  return r.stdout;
};
const entries = Object.fromEntries(["deb", "rpm"].map(kind => [kind, receipt.artifacts.find(item => (item.filename || item.artifact).endsWith(`.${kind}`))]));
const { proof, record, write } = startProof({ receipt, receiptFile, artifact: entries.deb, mode, channel });
const executable = path.join(applicationRoot, "relay");
const resources = path.join(applicationRoot, "resources"), node = path.join(resources, "node");
const pointerFile = path.join(relayRoot, "runtime", "current.json"), configFile = path.join(relayRoot, "config.json");
const read = file => JSON.parse(fs.readFileSync(file));
const selectChannel = () => { const current = read(pointerFile); run(current.node, [current.bin, "env", channel === "stable" ? "prod" : "dev"]); };
const apt = parts => run("sudo", ["--non-interactive", "apt-get", ...parts], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
// The package manager owns /opt/Relay; activation runs unprivileged as the
// person would, and writes only under their own home.
function installPackage(file) {
  apt(["install", "-y", "-qq", file]);
  assert.ok(fs.existsSync(executable) && fs.existsSync(node) && fs.existsSync(path.join(resources, "candidate.json")));
}
const activate = action => waitForOtherTransaction(() => run(node, [path.join(resources, "activate.cjs"), action, applicationRoot, executable]),
  { onFirstWait: () => { try { console.log(`DIAGNOSTICS at first wait ${JSON.stringify(lockDiagnostics(os.homedir()), null, 1)}`); } catch {} } });
async function assertHealthy() {
  const current = read(pointerFile);
  assert.equal(current.version, receipt.version); assert.equal(current.active, true);
  // Stock installations omit updateChannel for stable; Dev must remain explicit.
  assert.equal(read(configFile).updateChannel || "stable", channel);
  const { exactRuntimeHealth } = require(path.join(current.packageRoot, "bootstrap", "runtime-health.cjs"));
  assert.equal((await exactRuntimeHealth(current)).ok, true);
  const { applicationOwner } = require(path.join(current.packageRoot, "bootstrap", "application-owner.cjs"));
  assert.equal(applicationOwner().installedPackagingSourceSha, receipt.packagingSourceSha);
  return current;
}
// A stock Linux setup installs Electron's exact Chromium sandbox helper as a
// root-owned setuid file through one pkexec approval. Runners have no polkit
// agent, so provision that same helper from the same runtime bytes through the
// runner's passwordless sudo first, as the release gate does. The helper is
// keyed by content hash: a mismatch is simply not trusted and setup fails.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function provisionSandbox(version, sourceSha) {
  const dir = path.join(process.env.RUNNER_TEMP, `relay-runtime-${version}`);
  const archive = path.join(dir, "runtime.tar.gz");
  if (sourceSha) run(process.execPath, [path.join(repo, "tools/relay-application/download.mjs"), "--version", version, "--source-sha", sourceSha, "--output", dir]);
  else {
    fs.mkdirSync(dir, { recursive: true });
    run("curl", ["--fail", "--silent", "--show-error",
      `https://api.sendrelays.com/v1/companion-releases/v${version}/relay-runtime-${version}-${receipt.platform}.tar.gz`, "-o", archive]);
  }
  const extracted = path.join(dir, "extracted");
  fs.mkdirSync(extracted);
  run("tar", ["-xzf", archive, "-C", extracted]);
  run(process.execPath, ["-e", 'require(process.argv[1]).restoreRuntimeLinks(process.argv[2])', path.join(repo, "packages/companion/bootstrap/relay-setup.cjs"), extracted]);
  const electron = path.join(extracted, "node_modules", "electron", "dist", "electron");
  assert.ok(fs.existsSync(path.join(path.dirname(electron), "chrome-sandbox")), `Runtime ${version} has no Chromium sandbox helper`);
  const destination = run(process.execPath, [path.join(repo, "packages/companion/scripts/prepare-linux-electron-sandbox.mjs"), "--electron-path", electron]).trim();
  assert.match(destination, /^\/usr\/local\/lib\/relay\/chromium-sandboxes\/[a-f0-9]{64}\/chrome-sandbox$/);
  return destination;
}
try {
  // Both package formats must be the exact bytes the receipt describes, even
  // though only the DEB is installed on this Debian-family runner.
  const packages = {};
  for (const kind of ["deb", "rpm"]) {
    if (!entries[kind]) throw new Error(`Retained build has no ${kind} package`);
    const file = path.join(directory, "installers", entries[kind].filename || entries[kind].artifact);
    await release.verifyApplicationArtifact(file, entries[kind]);
    packages[kind] = file;
  }
  proof.packages = { deb: path.basename(packages.deb), rpm: path.basename(packages.rpm), installed: "deb" };
  record("exact-retained-receipt-and-installer");
  const packageName = run("dpkg-deb", ["--field", packages.deb, "Package"]).trim();
  assert.match(packageName, /^[a-z0-9][a-z0-9.+-]+$/);
  const removePackage = () => { apt(["remove", "-y", "-qq", packageName]); assert.equal(fs.existsSync(executable), false); };
  fs.mkdirSync(path.join(os.homedir(), ".codex"), { recursive: true });
  proof.sandboxes = { candidate: provisionSandbox(receipt.version, receipt.runtimeSourceSha) };
  if (mode !== "fresh") {
    proof.baseline = arg("--baseline");
    if (!/^\d+\.\d+\.\d+$/.test(proof.baseline || "")) throw new Error("Exact stock baseline required");
  }
  if (mode === "bridge" || mode === "broken") {
    proof.sandboxes.baseline = provisionSandbox(proof.baseline);
    run("npx", ["--yes", "--no-audit", "--no-fund", `relay-companion@${proof.baseline}`, "setup"]);
    // The broken route leaves the channel alone: its damaged configuration is
    // what the candidate has to recover from.
    if (mode === "bridge") selectChannel();
    record("stock-baseline-installation");
  }
  if (mode === "upgrade") {
    const published = await downloadPublishedInstaller({ version: proof.baseline, platform: receipt.platform, kind: "deb", directory: process.env.RUNNER_TEMP });
    proof.baselineArtifact = published.artifact;
    assert.equal(run("dpkg-deb", ["--field", published.file, "Package"]).trim(), packageName, "The candidate must replace the published package, not sit beside it");
    record("signed-baseline-installer");
    proof.sandboxes.baseline = provisionSandbox(published.manifest.runtime.version, published.manifest.runtime.sourceSha);
    installPackage(published.file);
    await activate("install");
    assert.equal(read(pointerFile).active, true);
    if (channel !== "stable") selectChannel();
    record("baseline-native-activation");
  }
  installPackage(packages.deb);
  if (receipt.runtimeDelivery === "download") assert.equal(fs.existsSync(path.join(resources, "runtime.tar.gz")), false);
  record("os-install");
  if (mode === "upgrade") {
    // Replacing the outer package is not a request to disconnect Relay.
    assert.equal(fs.existsSync(path.join(relayRoot, "application-uninstall.json")), false);
    record("package-replaced-without-disconnect");
  }
  if (mode === "broken") {
    for (const condition of brokenConditions) {
      applyBrokenCondition(relayRoot, condition);
      await activate("install");
      const current = await assertHealthy();
      const recovery = read(path.join(relayRoot, "runtime", "installer-recovery.json"));
      assert.equal(recovery.state, "complete");
      assert.equal(path.basename(recovery.releaseRoot), current.releaseId, "This setup run must be the one that recovered");
      record(`recovered-${condition}`);
    }
    proof.brokenConditions = brokenConditions;
  } else {
    await activate("install");
    await assertHealthy();
  }
  record("stock-activation"); record("exact-runtime-health"); record("native-ownership"); record(`${channel}-channel`);
  await activate("install"); // The same installer can be reopened without damage.
  record("repeat-setup");
  const configBefore = fs.readFileSync(configFile);
  await activate("uninstall");
  assert.deepEqual(fs.readFileSync(configFile), configBefore);
  record("uninstall-preserves-config");
  removePackage();
  record("os-uninstall");
  if (mode === "fresh") {
    // Someone who removed Relay and downloads it again keeps their settings.
    installPackage(packages.deb);
    await activate("install");
    await assertHealthy();
    record("reinstall-after-removal");
    await activate("uninstall");
    removePackage();
  }
  proof.ok = true;
} catch (error) {
  proof.failure = String(error.message).slice(0, 2000);
  // Say who held Relay's locks at the moment of failure; a red job that only
  // says "in progress" cannot be told apart from a stuck or abandoned lock.
  try { proof.diagnostics = lockDiagnostics(os.homedir()); console.log(`DIAGNOSTICS at failure ${JSON.stringify(proof.diagnostics, null, 1)}`); } catch {}
  throw error;
} finally { write(); }
