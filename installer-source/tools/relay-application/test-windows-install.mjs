import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import release from "../../packages/companion/bootstrap/application-release.cjs";
import { nativeInstallModes, brokenConditions, applyBrokenCondition, downloadPublishedInstaller, startProof, waitForOtherTransaction } from "./native-install-proof.mjs";
const require = createRequire(import.meta.url);
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !process.env.RUNNER_TEMP) throw new Error("Use a disposable GitHub-hosted Windows runner, never a self-hosted one");
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const directory = path.resolve(arg("--directory")), mode = arg("--mode");
if (!nativeInstallModes.includes(mode)) throw new Error(`Use one of: ${nativeInstallModes.join(", ")}`);
const channel = process.env.CANDIDATE_CHANNEL || "dev";
if (!["dev", "stable"].includes(channel)) throw new Error("Use dev or stable channel");
const relayRoot = path.join(os.homedir(), ".relay");
if (fs.existsSync(relayRoot)) throw new Error("Refusing an existing installation on this runner");
const receiptFile = path.join(directory, "packaging-receipt.json");
const receipt = JSON.parse(fs.readFileSync(receiptFile));
if (receipt.distribution !== "application" || !receipt.activationEnabled || receipt.channel !== channel || receipt.packagingSourceDirty
  || receipt.packagingSourceSha !== (process.env.CANDIDATE_SOURCE_SHA || process.env.GITHUB_SHA) || receipt.platform !== `win32-${process.arch}`) throw new Error("Wrong activating candidate");
const entry = receipt.artifacts.find(item => (item.filename || item.artifact).endsWith(".exe"));
const filename = entry.filename || entry.artifact;
const installer = path.join(directory, "installers", filename);
const { proof, record, write } = startProof({ receipt, receiptFile, artifact: entry, mode, channel });
const run = (file, parts, options = {}) => {
  console.log(JSON.stringify({ running: path.basename(file), action: parts[0] }));
  const r = spawnSync(file, parts, { encoding: "utf8", windowsHide: true, timeout: 15 * 60000, maxBuffer: 8 * 1024 * 1024,
    shell: /\.cmd$/.test(file), ...options });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(file)} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r.stdout;
};
const applicationRoot = path.join(process.env.LOCALAPPDATA, "Programs", "Relay");
const resources = path.join(applicationRoot, "resources"), node = path.join(resources, "node.exe");
const pointerFile = path.join(relayRoot, "runtime", "current.json"), configFile = path.join(relayRoot, "config.json");
const read = file => JSON.parse(fs.readFileSync(file));
const selectChannel = () => { const current = read(pointerFile); run(current.node, [current.bin, "env", channel === "stable" ? "prod" : "dev"]); };
function installPackage(file) {
  run(file, ["/S", `/D=${applicationRoot}`], { windowsVerbatimArguments: true });
  if (fs.existsSync(node)) return;
  // This runner is disposable and has no account credentials. Capture the
  // installed paths so a zero-exit NSIS result cannot hide missing resources.
  for (const directory of [applicationRoot, resources, path.dirname(applicationRoot)]) {
    console.error(JSON.stringify({ directory, entries: fs.existsSync(directory) ? fs.readdirSync(directory) : null }));
  }
  const registry = spawnSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "Relay"], { encoding: "utf8", windowsHide: true });
  console.error(registry.stdout);
  throw new Error("NSIS returned success without the bundled Node at the requested path");
}
// The silent uninstaller copies itself aside and returns at once. Removal is
// only proven when the application's own files are gone.
async function removePackage() {
  const uninstaller = fs.readdirSync(applicationRoot).find(name => /^Uninstall.*\.exe$/.test(name));
  assert.ok(uninstaller); run(path.join(applicationRoot, uninstaller), ["/S"]);
  const deadline = Date.now() + 3 * 60000;
  while (fs.existsSync(node) || fs.existsSync(path.join(applicationRoot, "relay.exe"))) {
    if (Date.now() >= deadline) throw new Error("The uninstaller returned success but left the application installed");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
// Selecting Dev can start the existing stock updater. Do not erase its
// lock or disable recovery just to make the migration test pass.
const activate = action => waitForOtherTransaction(() => run(node, [path.join(resources, "activate.cjs"), action, applicationRoot, path.join(applicationRoot, "Relay.exe")]));
async function assertHealthy() {
  const current = read(pointerFile);
  assert.equal(current.version, receipt.version); assert.equal(current.active, true);
  // Stock installations omit updateChannel for stable; the updater and recovery
  // configuration resolve an absent value to stable. Dev must remain explicit.
  assert.equal(read(configFile).updateChannel || "stable", channel);
  const { exactRuntimeHealth } = require(path.join(current.packageRoot, "bootstrap", "runtime-health.cjs"));
  assert.equal((await exactRuntimeHealth(current)).ok, true);
  const { applicationOwner } = require(path.join(current.packageRoot, "bootstrap", "application-owner.cjs"));
  assert.equal(applicationOwner().installedPackagingSourceSha, receipt.packagingSourceSha);
  return current;
}
try {
  await release.verifyApplicationArtifact(installer, entry);
  record("exact-retained-receipt-and-installer");
  fs.mkdirSync(path.join(os.homedir(), ".codex"), { recursive: true });
  if (mode !== "fresh") {
    proof.baseline = arg("--baseline");
    if (!/^\d+\.\d+\.\d+$/.test(proof.baseline || "")) throw new Error("Exact stock baseline required");
  }
  if (mode === "bridge" || mode === "broken") {
    run("npx.cmd", ["--yes", "--no-audit", "--no-fund", `relay-companion@${proof.baseline}`, "setup"]);
    // The broken route leaves the channel alone: its damaged configuration is
    // what the candidate has to recover from.
    if (mode === "bridge") selectChannel();
    record("stock-baseline-installation");
  }
  if (mode === "upgrade") {
    const published = await downloadPublishedInstaller({ version: proof.baseline, platform: receipt.platform, kind: "exe", directory: process.env.RUNNER_TEMP });
    proof.baselineArtifact = published.artifact;
    record("signed-baseline-installer");
    installPackage(published.file);
    await activate("install");
    assert.equal(read(pointerFile).active, true);
    if (channel !== "stable") selectChannel();
    record("baseline-native-activation");
  }
  installPackage(installer);
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
  await removePackage();
  record("os-uninstall");
  if (mode === "fresh") {
    // Someone who removed Relay and downloads it again keeps their settings.
    installPackage(installer);
    await activate("install");
    await assertHealthy();
    record("reinstall-after-removal");
    await activate("uninstall");
    await removePackage();
  }
  proof.ok = true;
} catch (error) {
  proof.failure = String(error.message).slice(0, 2000);
  throw error;
} finally { write(); }
