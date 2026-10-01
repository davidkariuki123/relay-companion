// Shared by the disposable-runner install harnesses (test-windows-install.mjs,
// test-linux-install.mjs) and by the publication gate that reads their proofs.
// Importing this file touches nothing; only the harnesses change a machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import release from "../../packages/companion/bootstrap/application-release.cjs";

// The runner that packages a platform is the one that installs it. These are
// standard hosted runners in the public Companion repository, where they are
// free; the private repository has no hosted-runner budget.
export const nativeInstallRunners = { "win32-x64": "windows-latest", "win32-arm64": "windows-11-arm",
  "linux-x64": "ubuntu-24.04", "linux-arm64": "ubuntu-24.04-arm" };
// fresh: nothing installed, then removed and installed again.
// bridge: a healthy stock npm installation moves to the native installer.
// upgrade: the previous published native installer is replaced in place.
// broken: a stock installation with damaged state is recovered by the candidate.
export const nativeInstallModes = ["fresh", "bridge", "upgrade", "broken"];
export const brokenConditions = ["corrupt-config", "corrupt-pointer"];
export const installedKind = platform => platform.startsWith("win32") ? "exe" : "deb";
const sha256 = data => createHash("sha256").update(data).digest("hex");
const artifactName = item => item.filename || item.artifact;

export function requiredChecks(mode, channel) {
  return ["exact-retained-receipt-and-installer", "os-install", "stock-activation", "exact-runtime-health", "native-ownership",
    "application-finish-and-run",
    `${channel}-channel`, "repeat-setup", "uninstall-preserves-config", "os-uninstall",
    ...(mode === "fresh" ? ["reinstall-after-removal"] : []),
    ...(["bridge", "broken"].includes(mode) ? ["stock-baseline-installation"] : []),
    ...(mode === "upgrade" ? ["signed-baseline-installer", "baseline-native-activation", "package-replaced-without-disconnect"] : []),
    ...(mode === "broken" ? brokenConditions.map(condition => `recovered-${condition}`) : [])];
}

// "Finish and run" opens the installed application, and the application does
// the setup: it starts on its own and brings any existing Relay up to date.
// The harnesses used to drive activate.cjs directly, so the application's own
// startup was never exercised: on 2026-10-01 a macOS-only call left Windows
// with a hidden, idle Relay after every install. Open it as a person would,
// wait until the installation it set up is the candidate, keep its output, and
// fail on any startup error. The harness's own setup steps then run as repeats.
export const startupFailure = /Relay startup failed|UnhandledPromiseRejection|Uncaught|is not a function|ReferenceError|TypeError/;
export async function finishAndRun(executable, { done, timeoutMs = 12 * 60_000, pollMs = 2000, env = process.env, platform = process.platform } = {}) {
  const child = spawn(executable, [], { env: { ...env, ELECTRON_ENABLE_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32" });
  let output = "", exited = null;
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exit = new Promise(resolve => {
    child.on("exit", code => resolve(exited = { code }));
    child.on("error", error => resolve(exited = { error }));
  });
  const deadline = Date.now() + timeoutMs;
  let finished = false;
  while (!finished && !startupFailure.test(output) && !exited?.error && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    try { finished = Boolean(done()); } catch {}
  }
  // Close only the application. The Relay it set up (service, pill) keeps running.
  if (!exited) {
    if (platform === "win32") spawnSync("taskkill.exe", ["/F", "/IM", path.basename(executable)], { windowsHide: true });
    else spawnSync("pkill", ["-KILL", "-f", `^${executable}`]);
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 10_000))]);
  }
  console.log(`APPLICATION OUTPUT ${JSON.stringify(output.slice(-4000))}`);
  if (exited?.error) throw new Error(`The installed application could not be opened: ${exited.error.message}`);
  assert.doesNotMatch(output, startupFailure, `The installed application failed while starting:\n${output.slice(-4000)}`);
  assert.ok(finished, `Opening the installed application did not finish setting Relay up within ${timeoutMs / 60_000} minutes`);
  return { output };
}

// Damage only state files, as a failed disk write or interrupted update would.
// Services are left as they are: the candidate must stop what it replaces.
export function applyBrokenCondition(relayRoot, condition) {
  if (condition === "corrupt-config") fs.writeFileSync(path.join(relayRoot, "config.json"), "{");
  else if (condition === "corrupt-pointer") fs.writeFileSync(path.join(relayRoot, "runtime", "current.json"), "{");
  else throw new Error("Unsupported broken condition");
}

export function startProof({ receipt, receiptFile, artifact, mode, channel, env = process.env }) {
  const proof = { schema: 1, platform: receipt.platform, mode, channel, version: receipt.applicationVersion || receipt.version,
    runtimeVersion: receipt.version, sourceSha: receipt.packagingSourceSha, runtimeSourceSha: receipt.runtimeSourceSha,
    workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    receiptSha256: sha256(fs.readFileSync(receiptFile)), artifact, checks: [],
    signInTested: false, nextUpdateTested: false, ok: false };
  return { proof,
    record(name) { proof.checks.push(name); console.log(`PASS ${name}`); },
    // Written on failure too, so a red job still says how far it got.
    write() { fs.writeFileSync(path.resolve("native-install-proof.json"), JSON.stringify(proof, null, 2)); } };
}

// Selecting a channel can start the installed stock updater. Wait for its
// transaction instead of erasing its lock to make a test pass.
export async function waitForOtherTransaction(action, { timeoutMs = 6 * 60_000, delayMs = 5000, onFirstWait = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (!error.message.includes("Another verified Relay install or update is already in progress") || Date.now() >= deadline) throw error;
      if (!waited) { waited = true; onFirstWait(); }
      console.log("Waiting for the existing stock update transaction to finish");
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Who holds Relay's install and skill locks, and is that process still there?
// Read-only, on a disposable runner with no account: lock records hold a
// process id, a nonce and a start time, never a credential.
export function lockDiagnostics(home, { run = spawnSync, platform = process.platform } = {}) {
  const locks = [path.join(home, ".relay", "runtime", "transaction.lock")];
  for (const host of [".claude", ".codex", ".agents"]) {
    const skills = path.join(home, host, "skills");
    try { for (const name of fs.readdirSync(skills)) if (/^\..*-update\.lock$/.test(name)) locks.push(path.join(skills, name)); } catch {}
  }
  const records = locks.filter(lock => fs.existsSync(lock)).map(lock => ({ lock, files: Object.fromEntries(fs.readdirSync(lock).map(name => {
    try { return [name, fs.readFileSync(path.join(lock, name), "utf8").slice(0, 2000)]; } catch (error) { return [name, `unreadable: ${error.code}`]; }
  })) }));
  const listing = platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|electron|relay|wscript|powershell' } | ForEach-Object { '{0} parent={1} started={2} {3} :: {4}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '?' }), $_.Name, $_.CommandLine }"],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 })
    : run("ps", ["-eo", "pid,ppid,lstart,args"], { encoding: "utf8", timeout: 30_000 });
  const processes = String(listing.stdout || listing.error?.message || listing.stderr || "").split(/\r?\n/)
    .filter(line => platform === "win32" ? line.trim() : /relay|node|electron/i.test(line)).map(line => line.slice(0, 400));
  return { at: new Date().toISOString(), locks: records, processes };
}

// The previous native installer exactly as people downloaded it: the immutable
// signed production manifest names its bytes, and the committed trust roots
// authenticate that manifest.
export async function downloadPublishedInstaller({ version, platform, kind, directory, fetchImpl = globalThis.fetch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Exact published installer version required");
  const response = await fetchImpl(`${release.applicationReleaseBase("stable")}/v${version}/manifest.json`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`No immutable signed installer manifest for ${version} (${response.status})`);
  const envelope = await response.json();
  const sourceSha = JSON.parse(Buffer.from(envelope.payload, "base64")).sourceSha;
  const manifest = release.verifyApplicationRelease(envelope, { version, sourceSha, channel: "stable" });
  const artifact = manifest.artifacts[platform]?.find(item => item.kind === kind);
  if (!artifact) throw new Error(`Installer ${version} has no ${kind} for ${platform}`);
  const file = path.join(directory, `Relay-${version}-${platform}-baseline.${kind}`);
  const download = await fetchImpl(artifact.url, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
  if (!download.ok || !download.body) throw new Error(`Installer ${version} download failed (${download.status})`);
  await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(file, { flags: "wx" }));
  await release.verifyApplicationArtifact(file, artifact);
  return { file, artifact, manifest };
}

// A proof counts only for the exact retained bytes it installed, in the build
// run that produced them. `expected` comes from that run and its receipt.
export function verifyNativeProof(proof, receipt, receiptBytes, expected) {
  assert.equal(proof.schema, 1);
  for (const key of ["platform", "mode", "channel", "sourceSha", "version", "runtimeVersion", "runtimeSourceSha"])
    assert.equal(proof[key], expected[key], `Proof ${key} differs`);
  assert.equal(String(proof.runId), String(expected.runId), "Proof is from another run");
  // A failed install job may be rerun alone: the digests below, not the
  // attempt number, tie the proof to the retained installer.
  assert.ok(/^\d+$/.test(String(proof.runAttempt)) && Number(proof.runAttempt) >= 1 && Number(proof.runAttempt) <= Number(expected.runAttempt), "Proof is from an unknown attempt");
  assert.equal(proof.workflowSha, expected.workflowSha, "Proof was not produced by the build's own harness");
  assert.equal(proof.ok, true);
  assert.equal(proof.receiptSha256, sha256(receiptBytes), "Proof names another packaging receipt");
  assert.equal(receipt.platform, expected.platform);
  assert.equal(receipt.distribution, "application");
  assert.equal(receipt.activationEnabled, true);
  assert.equal(receipt.packagingSourceDirty, false);
  assert.equal(receipt.packagingSourceSha, expected.sourceSha);
  assert.equal(receipt.packagingPublicSourceSha, expected.workflowSha, "Installer was not packaged by this public build");
  assert.equal(receipt.channel || "stable", expected.channel);
  assert.equal(receipt.applicationVersion || receipt.version, expected.version);
  assert.equal(receipt.version, expected.runtimeVersion);
  assert.equal(receipt.runtimeSourceSha, expected.runtimeSourceSha);
  const installed = receipt.artifacts.find(item => artifactName(item).endsWith(`.${installedKind(expected.platform)}`));
  assert.ok(installed, "Receipt has no installable package");
  assert.deepEqual(proof.artifact, installed, "Proof installed other bytes");
  for (const check of requiredChecks(expected.mode, expected.channel)) assert.ok(proof.checks.includes(check), `Proof missing ${check}`);
  if (expected.mode !== "fresh") assert.match(proof.baseline || "", /^\d+\.\d+\.\d+$/, "Missing starting version");
  if (expected.mode === "upgrade") assert.match(proof.baselineArtifact?.sha512 || "", /^sha512-/, "Missing signed baseline installer");
  if (expected.mode === "broken") assert.deepEqual(proof.brokenConditions, brokenConditions);
}
