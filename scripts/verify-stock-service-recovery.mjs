// Removes both app services from a disposable macOS supervisor. The installed
// stock controller must restore them without an app observer or a test wake.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || process.platform !== "darwin") {
  throw Error("Service fault injection requires a disposable macOS GitHub runner");
}
const version = process.argv[2];
assert.match(version || "", /^\d+\.\d+\.\d+$/);
const homeDir = os.homedir(), root = path.join(homeDir, ".relay");
const readCurrent = () => JSON.parse(fs.readFileSync(path.join(root, "runtime", "current.json"), "utf8"));
const current = readCurrent();
assert.equal(current.active, true); assert.equal(current.version, version);
assert.ok(path.resolve(current.packageRoot).startsWith(path.join(root, "runtime", "releases") + path.sep));
const require = createRequire(import.meta.url);
const diagnostic = () => Object.fromEntries([
  "recovery/status.json", "recovery/repair-progress.json", "recovery/daemon.json",
  "recovery/daemon-progress.json", "recovery/recovery.log", "update.log", "daemon.log",
].map(file => {
  try { return [file, fs.readFileSync(path.join(root, file), "utf8").slice(-30_000)]; }
  catch { return [file, null]; }
}));
const failureDiagnostic = () => {
  const files = Object.fromEntries([
    "recovery/status.json", "recovery/launcher-status.json", "recovery/registration.json",
    "recovery/scheduler.json", "recovery/scheduler-cleanup.json",
    "recovery/scheduler-handover-status.json", "recovery/recovery.log",
  ].map(file => {
    try { return [file, fs.readFileSync(path.join(root, file), "utf8").slice(-8000)]; }
    catch { return [file, null]; }
  }));
  const launchd = Object.fromEntries([
    "work.relay.companion.recovery", "work.relay.recovery.schedule-handover",
  ].map(label => {
    const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8", timeout: 10_000 });
    return [label, { status: result.status, stdout: String(result.stdout || "").slice(-6000), stderr: String(result.stderr || "").slice(-1000) }];
  }));
  const interval = file => {
    try { return Number(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(fs.readFileSync(file, "utf8"))?.[1]) || null; }
    catch { return null; }
  };
  return { files, launchd, plistInterval: interval(path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.recovery.plist")),
    previousInterval: interval(path.join(root, "recovery", "scheduler-previous.plist")) };
};
const { waitForRecoveryReady } = require(path.join(current.packageRoot, "bootstrap", "recovery-readiness.cjs"));
const { activeCalls } = require(path.join(current.packageRoot, "bootstrap", "update-activity.cjs"));
assert.equal(activeCalls({ homeDir }), 0, "fault injection must not interrupt protected work");
const initial = await waitForRecoveryReady({ homeDir, target: current, timeoutMs: 90_000, requireProgress: true });
assert.equal(initial.ok, true, JSON.stringify(initial));
const started = Date.now();
for (const label of ["work.relay.companion", "work.relay.companion.pill"]) {
  const result = spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}
// Do not kickstart recovery: the native schedule itself is under test.
const recovered = await waitForRecoveryReady({ homeDir, target: current, after: started, timeoutMs: 180_000, requireProgress: true });
const elapsedMs = Date.now() - started;
const report = { version, platform: process.platform, arch: process.arch, scenario: "both-service-registrations-removed",
  recovered: recovered.ok, elapsedMs, targetMs: 60_000, targetMet: recovered.ok && elapsedMs <= 60_000, reason: recovered.reason || null };
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "relay-service-recovery.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!recovered.ok) {
  report.diagnostic = failureDiagnostic();
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "relay-service-recovery.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.diagnostic));
}
assert.equal(recovered.ok, true, JSON.stringify(recovered));
assert.equal(readCurrent().packageRoot, current.packageRoot, "recovery must restore the exact installed candidate");
if (!report.targetMet) console.log(`::warning::Recovery worked in ${elapsedMs}ms but has not met the approved 60000ms target. This remains an internal-test finding.`);

// A UI-only failure must not interrupt the recovered daemon. This also tests
// resumption through the stock independent controller, rather than a mock start.
const heartbeat = () => JSON.parse(fs.readFileSync(path.join(root, "recovery", "daemon.json"), "utf8"));
const daemonPid = heartbeat().pid;
report.beforePill = { daemonPid, diagnostic: diagnostic() };
const pillStarted = Date.now();
const removedPill = spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/work.relay.companion.pill`], { encoding: "utf8", timeout: 10_000 });
assert.equal(removedPill.status, 0, removedPill.stderr);
const pillRecovered = await waitForRecoveryReady({ homeDir, target: current, after: pillStarted, timeoutMs: 180_000, requireProgress: true });
report.pillOnly = { recovered: pillRecovered.ok, elapsedMs: Date.now() - pillStarted, daemonPreserved: heartbeat().pid === daemonPid };
report.afterPill = { daemonPid: heartbeat().pid, diagnostic: diagnostic() };
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "relay-service-recovery.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.pillOnly));
if (!pillRecovered.ok || !report.pillOnly.daemonPreserved) console.log(JSON.stringify(report));
assert.equal(pillRecovered.ok, true, JSON.stringify(pillRecovered));
assert.equal(report.pillOnly.daemonPreserved, true, "repairing the pill must preserve the healthy daemon");
