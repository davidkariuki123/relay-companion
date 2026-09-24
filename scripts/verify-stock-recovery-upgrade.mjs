// Native release canary for one Companion platform. Runs on a disposable
// GitHub runner only, from the Release candidate gate, and proves with the
// real stock packages that a machine on the current `installer` build:
//
//   1. updates itself to the candidate through the unmodified stock updater,
//      and every active component belongs to the candidate afterwards;
//   2. is healed by the independent recovery engine after an interrupted
//      activation whose rollback is unusable, along the ladder the shipped
//      recovery policy defines: the interrupted candidate is quarantined for
//      one release cooldown, and the first check after that cooldown
//      downloads the signed candidate and activates it;
//   3. is then proven by the native OS scheduler: the launcher runs through
//      launchd, systemd or Task Scheduler, reports the candidate current and
//      healthy, and records it known-good once probation completes.
//
// The test controls only discovery and local journal fixtures. It never edits
// installed application code, never moves a channel tag, and never bypasses a
// policy: the only clock it advances is the recovery runner's own injectable
// clock, so the post-cooldown check happens in minutes instead of half an hour.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const from = arg("--from-version"), to = arg("--to-version");
// A machine in the field did not start life on the current installer: it was
// installed on an older release and updated to it, so an older release tree, a
// rollback pointer to it, and an agent session holding the old broker open are
// all present when the candidate arrives. Every one of the six field machines
// that failed the 0.1.510 update on 2026-09-13 looked like that; a fresh runner
// looked like none of them. When an older thin installer exists, start there.
const livedInFrom = arg("--lived-in-from") || "";
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) throw Error("This destructive installation canary runs only on a disposable GitHub runner");
if (![from, to].every(value => /^\d+\.\d+\.\d+$/.test(value || ""))) throw Error("Exact baseline and candidate versions required");
if (livedInFrom && (!/^\d+\.\d+\.\d+$/.test(livedInFrom) || livedInFrom === from)) throw Error("--lived-in-from must be an exact older version than the baseline");
const root = path.join(os.homedir(), ".relay"), pointer = path.join(root, "runtime", "current.json");
const recoveryDir = path.join(root, "recovery");
if (fs.existsSync(root)) throw Error("Refusing to touch an existing Relay installation");
fs.mkdirSync(path.join(os.homedir(), ".codex"), { recursive: true });
const startedAt = Date.now();
const log = (...parts) => console.log(`[canary +${Math.round((Date.now() - startedAt) / 1000)}s]`, ...parts);
const run = (command, args, optional = false) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 25 * 60_000,
    shell: process.platform === "win32" && /\.cmd$/.test(command), maxBuffer: 8 * 1024 * 1024 });
  if (!optional && (result.error || result.status !== 0)) throw Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
};
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const readOptional = file => { try { return read(file); } catch { return null; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Poll a health-style check until it reports ok, for a bounded window.
const settle = async (check, ms) => {
  const until = Date.now() + ms;
  let last;
  while (true) {
    last = await check();
    if (last?.ok || Date.now() >= until) return last;
    await delay(2000);
  }
};
const pause = () => {
  if (process.platform === "darwin") for (const label of ["work.relay.companion", "work.relay.companion.pill"]) run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], true);
  else if (process.platform === "linux") run("systemctl", ["--user", "stop", "work.relay.companion.service", "work.relay.companion.pill.service"]);
  else {
    for (const task of ["Relay Companion Daemon", "Relay Companion Pill"]) run("schtasks.exe", ["/End", "/TN", task], true);
    // Task Scheduler's wrapper may have exited already. In this fresh runner,
    // also stop its escaped Relay children, restricted to the runner's SID.
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$relaySid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '[\\\\/]node_modules[\\\\/]relay-companion[\\\\/]' -and ($_.CommandLine -match '[\\\\/]relay\\.js.*\\bdaemon\\b' -or $_.CommandLine -match '[\\\\/]overlay[\\\\/]main\\.cjs') } | ForEach-Object { $relayOwner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if($relayOwner.Sid -eq $relaySid){ Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null } }"]);
  }
};
// Ask the OS scheduler to run the recovery job now, exactly as its interval
// would. Errors such as "already running" are the scheduler's own answer.
const kickScheduledRecovery = () => {
  if (process.platform === "darwin") run("launchctl", ["kickstart", `gui/${process.getuid()}/work.relay.companion.recovery`], true);
  else if (process.platform === "linux") run("systemctl", ["--user", "start", "work.relay.companion.recovery.service"], true);
  else run("schtasks.exe", ["/Run", "/TN", "Relay Companion Recovery"], true);
};
const tail = (file, lines = 80) => { try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n"); } catch { return "(absent)"; } };
const processRows = () => {
  try {
    const { runtimeProcessCommands } = require(path.join(readOptional(pointer)?.packageRoot || readOptional(pointer)?.candidate?.packageRoot || "", "bootstrap", "runtime-health.cjs"));
    return runtimeProcessCommands(process.platform).join("\n") || "(no Relay processes)";
  } catch (error) { return `(process listing unavailable: ${error.message})`; }
};
const snapshot = label => {
  log(`--- ${label}: runtime pointer`, JSON.stringify(readOptional(pointer)));
  log(`--- ${label}: recovery status`, JSON.stringify(readOptional(path.join(recoveryDir, "status.json"))));
  log(`--- ${label}: launcher status`, JSON.stringify(readOptional(path.join(recoveryDir, "launcher-status.json"))));
  log(`--- ${label}: known-good`, JSON.stringify(readOptional(path.join(recoveryDir, "known-good.json"))));
  log(`--- ${label}: repair progress`, JSON.stringify(readOptional(path.join(recoveryDir, "repair-progress.json"))));
  log(`--- ${label}: Relay processes\n${processRows()}`);
  log(`--- ${label}: recovery.log tail\n${tail(path.join(recoveryDir, "recovery.log"))}`);
  log(`--- ${label}: update.log tail\n${tail(path.join(root, "update.log"), 40)}`);
};
// Claude Code keeps Relay's MCP launcher open for as long as a session lasts, so
// on a real machine the old release's broker is alive while the update runs.
// Seed the agent host's config so stock setup registers its launcher there,
// then hold that launcher open the way an agent session would.
const claudeConfig = path.join(os.homedir(), ".claude.json");
if (!fs.existsSync(claudeConfig)) fs.writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { relay: { type: "stdio", command: "node", args: [] } } }));
let agentSession = null;
const startAgentSession = () => {
  const entry = readOptional(claudeConfig)?.mcpServers?.relay;
  assert.ok(entry?.command, `stock setup did not register the Relay MCP launcher for Claude Code: ${JSON.stringify(readOptional(claudeConfig))}`);
  const child = spawn(entry.command, entry.args || [], { env: { ...process.env, ...(entry.env || {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(entry.command) });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  child.on("exit", code => log(`agent session launcher exited (${code})`));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "relay-canary", version: "1" } } })}\n`);
  log(`agent session holding the Relay MCP launcher open: ${entry.command} ${(entry.args || []).join(" ")}`);
  return child;
};
const endAgentSession = () => { if (agentSession && agentSession.exitCode === null) { try { agentSession.kill(); } catch {} } agentSession = null; };
// Drive the stock updater of the installed release to `target` and wait for the
// pointer to commit and the runtime to settle. Returns the committed pointer.
const stockUpdate = async (installed, target) => {
  log(`driving the stock updater from ${installed.version} to ${target}`);
  try {
    run(process.execPath, ["scripts/trigger-stock-candidate-update.mjs", "--package-root", installed.packageRoot, "--current-version", installed.version, "--target-version", target]);
  } catch (error) {
    // The installed daemon runs the same updater on its own schedule. When the
    // channel already serves `target`, it can discover and launch the update
    // before this trigger does, and the updater then refuses a second worker.
    // That refusal is the product working; the update is already in flight.
    // worker-busy: a live worker was found up front. worker-not-admitted: the
    // request waited for the transaction and the other owner still held it.
    if (!/worker-busy|worker-not-admitted/.test(String(error.message))) throw error;
    log(`the installed daemon's own updater already owns the transaction to ${target}; waiting for it`);
  }
  let current;
  for (let attempt = 0; attempt < 120; attempt++) {
    current = read(pointer);
    if (current.active === true && current.version === target) break;
    await delay(5000);
  }
  assert.equal(current.version, target, `stock update did not commit ${target}: ${JSON.stringify(current)}`);
  assert.equal(current.active, true);
  const { exactRuntimeHealth } = require(path.join(current.packageRoot, "bootstrap", "runtime-health.cjs"));
  // The pointer commits before the last old process has exited; the runtime
  // must settle on exactly one daemon, one pill and no old broker shortly after.
  const health = await settle(() => exactRuntimeHealth(current), 90_000);
  assert.equal(health.ok, true, `runtime not healthy after the stock update to ${target}: ${JSON.stringify(health)}`);
  log(`stock update active at ${target}: ${JSON.stringify(health)}`);
  return current;
};
let baseline, failed = true;
try {
  // ---- 1. stock update ---------------------------------------------------
  // Both packages are stock public releases. Test controls only discovery and
  // local journal fixtures; it never edits installed application code or tags.
  const initial = livedInFrom || from;
  log(`installing stock relay-companion@${initial}`);
  run(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "--no-audit", "--no-fund", `relay-companion@${initial}`, "setup"]);
  baseline = read(pointer);
  assert.equal(baseline.version, initial);
  const originalConfig = read(path.join(root, "config.json"));
  if (livedInFrom) {
    // The first hop makes this a lived-in machine: an older release tree stays
    // on disk as the rollback target of the baseline the candidate will replace.
    pause();
    baseline = await stockUpdate(baseline, from);
    log(`lived-in baseline: ${from} installed over ${livedInFrom}, ${fs.readdirSync(path.join(root, "runtime", "releases")).length} release trees on disk`);
  }
  pause();
  agentSession = startAgentSession();
  await delay(5000);
  let current = await stockUpdate(baseline, to);
  const { exactRuntimeHealth } = require(path.join(current.packageRoot, "bootstrap", "runtime-health.cjs"));
  endAgentSession();
  const recovery = read(path.join(recoveryDir, "current.json"));
  assert.equal(recovery.version, to);
  assert.ok(recovery.node.startsWith(path.join(recoveryDir, "node")));
  assert.ok(!recovery.bundle.startsWith(current.releaseRoot));
  const skill = require(path.join(current.packageRoot, "bootstrap", "relay-skill.cjs"));
  const manifest = read(path.join(current.packageRoot, "skill", "manifest.json"));
  for (const target of skill.defaultTargets()) {
    assert.equal(skill.readState(target.directory)?.version, manifest.version);
    assert.deepEqual(skill.localChanges(target.directory), []);
  }

  // ---- 2. independent recovery from an interrupted activation -------------
  // Simulate the journal the canonical updater leaves when the candidate's
  // activation failed and its rollback failed too: inactive, candidate tree
  // retained, previous runtime unusable. The independent engine must recover
  // using signed candidate code, not old code.
  pause();
  fs.writeFileSync(pointer, JSON.stringify({ schema: 1, state: "recovery-required", active: false, candidate: current,
    previous: { ...current, packageRoot: path.join(root, "missing-old-runtime"), bin: path.join(root, "missing-old-runtime", "bin", "relay.js") },
    failure: { phase: "rollback", reason: "canary-simulated-rollback-failure", detail: "" }, updatedAt: Date.now() }));
  fs.writeFileSync(path.join(recoveryDir, "policy.json"), JSON.stringify({ autoUpdate: true }));
  const { recover } = require(path.join(recovery.bundle, "bootstrap", "recovery-runner.cjs"));
  const { waitForRecoveryReady } = require(path.join(recovery.bundle, "bootstrap", "recovery-readiness.cjs"));
  const { RELEASE_COOLDOWN_MS } = require(path.join(recovery.bundle, "bootstrap", "recovery-policy.cjs"));
  // Each pass is one scheduled check. The runner's clock is advanced only to
  // stand in for the wait between checks that its own policy imposes; the
  // readiness proof always runs on the real clock, because the daemon does.
  const passes = [];
  let offset = 0, healed = null;
  for (let pass = 1; pass <= 8; pass++) {
    const clock = () => Date.now() + offset;
    const injected = offset ? { now: clock, verifyReady: options => waitForRecoveryReady({ ...options, now: Date.now, after: options.after ? options.after - offset : 0 }) } : {};
    healed = await recover({ discoverImpl: async () => to, ...injected });
    passes.push({ pass, offsetMinutes: Math.round(offset / 60_000), status: healed.status, ok: healed.ok, repair: healed.repair || null });
    log(`recovery check ${pass} (${offset ? `${Math.round(offset / 60_000)} min after the cooldown started` : "real clock"}): ${JSON.stringify(healed)}`);
    const live = readOptional(pointer);
    if (healed.ok && ["current", "ahead"].includes(healed.status) && live?.active === true && live.version === to) break;
    if (healed.status === "recovery-lock-unavailable") { await delay(30_000); continue; }
    if (["failed", "configuration-unavailable", "repair-progress-unavailable"].includes(healed.status)) break;
    if (["deferred-release-cooldown", "backoff"].includes(healed.status)) {
      assert.equal(healed.desiredVersion, to, `quarantine must name the interrupted candidate: ${JSON.stringify(healed)}`);
      assert.ok(healed.retryAt > Date.now() && healed.retryAt <= Date.now() + RELEASE_COOLDOWN_MS + 60_000, `cooldown outside the release policy window: ${JSON.stringify(healed)}`);
      offset = Math.max(offset, healed.retryAt - Date.now() + 1000);
    }
  }
  assert.ok(passes.some(entry => entry.status === "deferred-release-cooldown"), `the interrupted candidate must be quarantined before it is retried: ${JSON.stringify(passes)}`);
  assert.equal(healed?.ok, true, `independent recovery did not heal the interrupted activation: ${JSON.stringify(passes)}`);
  assert.ok(["current", "ahead"].includes(healed.status), JSON.stringify(passes));
  assert.equal(healed.repair, "download", `recovery must activate signed candidate code, not old code: ${JSON.stringify(passes)}`);
  current = read(pointer);
  assert.equal(current.version, to); assert.equal(current.active, true);
  const healedHealth = await settle(() => exactRuntimeHealth(current), 90_000);
  assert.equal(healedHealth.ok, true, `runtime not healthy after independent recovery: ${JSON.stringify(healedHealth)}`);
  const afterConfig = read(path.join(root, "config.json"));
  for (const key of ["userId", "deviceId", "apiUrl", "updateChannel"]) assert.equal(afterConfig[key], originalConfig[key], key);
  log(`independent recovery restored ${to} through ${passes.length} scheduled checks`);

  // ---- 3. native scheduler proves and records the candidate ---------------
  // Execute through the actual OS registration and observe its durable check.
  // Known-good needs the runner's probation: fifteen minutes of continuous
  // healthy checks no more than seven minutes apart. Ask the scheduler for a
  // check every two minutes, as its own interval would every five.
  const before = Date.now();
  const deadline = before + 25 * 60_000;
  let scheduled = null, launcher = null, knownGood = null, lastKick = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastKick >= 120_000) { kickScheduledRecovery(); lastKick = Date.now(); }
    await delay(5000);
    scheduled = readOptional(path.join(recoveryDir, "status.json"));
    launcher = readOptional(path.join(recoveryDir, "launcher-status.json"));
    knownGood = readOptional(path.join(recoveryDir, "known-good.json"));
    if (launcher?.at >= before && ["current", "ahead"].includes(scheduled?.status) && knownGood?.version === to) break;
  }
  assert.ok(launcher?.at >= before, `native scheduler never ran the recovery launcher: ${JSON.stringify(launcher)}`);
  assert.ok(["current", "ahead"].includes(scheduled?.status) && scheduled.runtimeHealthy === true, `scheduled recovery did not report the candidate healthy: ${JSON.stringify(scheduled)}`);
  assert.equal(knownGood?.version, to, `native scheduler must prove the fallback engine, not merely register it: launcher=${JSON.stringify(launcher)} status=${JSON.stringify(scheduled)}`);
  console.log(JSON.stringify({ from, to, platform: `${process.platform}-${process.arch}`, stockUpdate: true, independentRecovery: true, recoveryChecks: passes.length, scheduledRecovery: true, knownGood: true, components: true, skillVersion: manifest.version }));
  failed = false;
} finally {
  endAgentSession();
  if (failed) snapshot("failure state");
  if (fs.existsSync(pointer)) {
    const active = read(pointer), target = active.active ? active : baseline;
    if (target?.bin && fs.existsSync(target.bin)) run(target.node || process.execPath, [target.bin, "uninstall", "--no-trampoline"], true);
  }
}
