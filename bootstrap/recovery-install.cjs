"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { relayOwnedNodePath } = require("./owned-node-runtime.cjs");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const { read, write, compare } = require("./recovery-runner.cjs");
const LABEL = "work.relay.companion.recovery";
const TASK = "Relay Companion Recovery";
const ok = (r) => r?.ok === true || (!r?.error && r?.status === 0);
const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unit = (s) => '"' + String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
function run(command, args) { return spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 }); }

// Task Scheduler reads this XML as UTF-16 (the caller adds the BOM). The settings
// that differ from schtasks' `/SC MINUTE` defaults are the load-bearing ones: both
// battery flags, StartWhenAvailable for missed ticks, and a run-time limit that
// still covers the launcher's own 25 minute deadline.
function windowsRecoveryTaskXml(script, startAt = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const boundary = `${startAt.getFullYear()}-${pad(startAt.getMonth() + 1)}-${pad(startAt.getDate())}T${pad(startAt.getHours())}:${pad(startAt.getMinutes())}:${pad(startAt.getSeconds())}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${boundary}</StartBoundary>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="RelayUser"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="RelayUser">
    <Exec><Command>wscript.exe</Command><Arguments>//B ${xml(`"${script}"`)}</Arguments></Exec>
  </Actions>
</Task>
`;
}

function installRecovery({ packageRoot, node = process.execPath, homeDir = os.homedir(), platform = process.platform,
  runCommand = run, reload = true, preserveNode = relayOwnedNodePath, userId = process.getuid?.() ?? 0 } = {}) {
  if (!["darwin", "linux", "win32"].includes(platform)) return { ok: false, reason: "recovery-platform-unsupported" };
  try {
    const root = path.join(homeDir, ".relay", "recovery");
    const current = read(path.join(root, "current.json"));
    const incoming = read(path.join(packageRoot, "package.json"))?.version;
    if (current?.bundle && path.dirname(current.bundle) === path.join(root, "versions")
      && compare(current.version, incoming) === 1 && fs.existsSync(path.join(current.bundle, "bootstrap", "recovery-install.cjs"))) {
      // An old rollback repairs service registrations through the newer engine.
      try {
        const result = require(path.join(current.bundle, "bootstrap", "recovery-install.cjs")).installRecovery({ packageRoot: current.bundle, node: current.node, homeDir, platform, runCommand, reload, preserveNode });
        if (result.ok) return result;
      } catch { /* A broken newer recovery must not prevent a stock repair. */ }
    }
    const source = path.join(packageRoot, "bootstrap");
    const names = fs.readdirSync(source).filter((name) => /\.(cjs|json)$/.test(name)).sort();
    const hash = crypto.createHash("sha256");
    for (const name of names) hash.update(name).update(fs.readFileSync(path.join(source, name)));
    hash.update(fs.readFileSync(path.join(packageRoot, "package.json")));
    const digest = hash.digest("hex");
    let bundle = path.join(root, "versions", digest);
    const matches = directory => {
      try { return fs.readFileSync(path.join(directory, "package.json")).equals(fs.readFileSync(path.join(packageRoot, "package.json")))
        && names.every(name => fs.readFileSync(path.join(directory, "bootstrap", name)).equals(fs.readFileSync(path.join(source, name)))); }
      catch { return false; }
    };
    // A live runner may still import these files. Never repair them in place.
    if (fs.existsSync(bundle) && !matches(bundle)) bundle = path.join(root, "versions", crypto.createHash("sha256").update(digest + crypto.randomUUID()).digest("hex"));
    const runtimeNode = preserveNode(node, { platform, runtimeRoot: root, isTemporary: () => true });
    if (!fs.existsSync(bundle)) {
      const pending = path.join(root, "versions", '.pending-' + crypto.randomUUID());
      fs.mkdirSync(path.join(pending, "bootstrap"), { recursive: true, mode: 0o700 });
      try {
        for (const name of names) atomicFile(path.join(pending, "bootstrap", name), fs.readFileSync(path.join(source, name)));
        atomicFile(path.join(pending, "package.json"), fs.readFileSync(path.join(packageRoot, "package.json")));
        if (!ok(runCommand(runtimeNode, [path.join(pending, "bootstrap", "recovery-runner.cjs"), "--self-check"]))) throw Error("recovery-bundle-verification-failed");
        try { fs.renameSync(pending, bundle); }
        catch (error) { if (!matches(bundle)) throw error; }
      } finally { fs.rmSync(pending, { recursive: true, force: true }); }
    }
    const pointer = path.join(root, "current.json");
    // Import an older stock engine only when it has already reported a healthy
    // check. Merely passing the installation probe does not make it known-good.
    const priorStatus = read(path.join(root, "status.json"));
    if (current && !read(path.join(root, "known-good.json")) && current.version === priorStatus?.launcherVersion
      && priorStatus.ok === true && priorStatus.runtimeHealthy === true && ["current", "ahead"].includes(priorStatus.status)
      && require("./recovery-launcher.cjs").validPointer(current, root)) {
      write(path.join(root, "known-good.json"), current);
    }
    const checked = runCommand(runtimeNode, [path.join(bundle, "bootstrap", "recovery-runner.cjs"), "--self-check"]);
    if (!ok(checked)) throw Error("recovery-bundle-verification-failed");
    atomicFile(pointer, JSON.stringify({ schema: 1, version: incoming, node: runtimeNode, bundle }));
    const launcher = path.join(root, "launch.cjs");
    // Static launcher dispatches through a replaceable pointer. Never overwrite
    // the executable currently running; old bundles are recovery fallbacks.
    // The scheduler must not depend on an unproven replacement Node binary to
    // reach the fallback launcher. Advance this host only from proven recovery.
    const proven = read(path.join(root, "known-good.json"));
    const oldHost = read(path.join(root, "launcher-node.json"))?.node;
    const preferredHost = oldHost || proven?.node;
    const launcherNode = typeof preferredHost === "string" && path.resolve(preferredHost).startsWith(path.join(root,"node") + path.sep)
      && ok(runCommand(preferredHost, ["--version"])) ? preferredHost : runtimeNode;
    write(path.join(root, "launcher-node.json"), { node: launcherNode });
    const hostFile = path.join(root, "launcher-host.json");
    // This stdlib host is deliberately independent of bundle upgrades. A future
    // host protocol change must bump this schema to request an atomic upgrade.
    const host = read(hostFile);
    let hostIntact = false;
    try { hostIntact = host?.schema === 1 && host.sha256 === crypto.createHash("sha256").update(fs.readFileSync(launcher)).digest("hex"); } catch {}
    if (!hostIntact || !ok(runCommand(launcherNode, ["--check", launcher]))) {
      const bytes = fs.readFileSync(path.join(source, "recovery-launcher.cjs"));
      const launcherTemp = path.join(root, 'launcher-' + crypto.randomUUID() + '.cjs');
      try {
        atomicFile(launcherTemp, bytes);
        if (!ok(runCommand(launcherNode, ["--check", launcherTemp]))) throw Error("recovery-launcher-verification-failed");
        atomicFile(launcher, bytes);
        atomicFile(hostFile, JSON.stringify({ schema: 1, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
      } finally { fs.rmSync(launcherTemp, { force: true }); }
    }
    const log = path.join(root, "recovery.log");
    const results = [];
    if (platform === "win32") {
      const script = path.join(root, "launch.vbs");
      const command = `"${launcherNode}" "${launcher}"`;
      atomicFile(script, `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("${command.replaceAll('"', '""')}", 0, True)\r\n`);
      // Register from XML rather than `/SC MINUTE /MO 5`: schtasks' defaults refuse
      // to start a task on battery power and stop it when the plug comes out, so a
      // laptop that lost its Companion while unplugged never got this engine.
      const taskXml = path.join(root, "task.xml");
      atomicFile(taskXml, Buffer.from(`\uFEFF${windowsRecoveryTaskXml(script)}`, "utf16le"));
      results.push(runCommand("schtasks.exe", ["/Create", "/TN", TASK, "/XML", taskXml, "/F"]));
    } else if (platform === "darwin") {
      const plist = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      atomicFile(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(launcherNode)}</string><string>${xml(launcher)}</string></array><key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`);
      // The job dispatches through the stable host. Do not unload it on update.
      const observed = runCommand("launchctl", ["print", `gui/${userId}/${LABEL}`]);
      if (!ok(observed)) {
        const missing = !observed?.error && (observed?.status === 113 || /Could not find service/i.test(String(observed?.stderr || "")));
        if (!missing) throw Error("recovery-registration-query-failed");
        results.push(runCommand("launchctl", ["bootstrap", `gui/${userId}`, plist]));
        results.push(runCommand("launchctl", ["print", `gui/${userId}/${LABEL}`]));
      }
    } else {
      const dir = path.join(homeDir, ".config", "systemd", "user");
      fs.mkdirSync(dir, { recursive: true });
      atomicFile(path.join(dir, `${LABEL}.service`), `[Unit]\nDescription=Relay update recovery\n[Service]\nType=oneshot\nExecStart=${unit(launcherNode)} ${unit(launcher)}\nTimeoutStartSec=1800\nKillMode=control-group\n`);
      atomicFile(path.join(dir, `${LABEL}.timer`), `[Unit]\nDescription=Check Relay update health\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=5min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`);
      // The user manager can retain a different HOME from this installer.
      // Registration is required even when thin setup defers starting services.
      for (const ext of ["service", "timer"]) {
        runCommand("systemctl", ["--user", "link", path.join(dir, `${LABEL}.${ext}`)]);
      }
      results.push(runCommand("systemctl", ["--user", "daemon-reload"]));
      for (const ext of ["service", "timer"]) {
        const shown = runCommand("systemctl", ["--user", "show", "--property=FragmentPath", "--value", `${LABEL}.${ext}`]);
        const resolved = String(shown?.stdout ?? shown?.out ?? "").trim();
        let matches = false;
        try { matches = fs.realpathSync(resolved) === fs.realpathSync(path.join(dir, `${LABEL}.${ext}`)); } catch {}
        if (!ok(shown) || !matches) throw Error(`recovery-unit-not-resolved: ${LABEL}.${ext}`);
      }
      results.push(runCommand("systemctl", ["--user", "enable", ...(reload ? ["--now"] : []), `${LABEL}.timer`]));
    }
    const registered = results.every(ok);
    write(path.join(root, "registration.json"), { schema: 1, version: incoming, registered, at: Date.now(), platform });
    return { ok: registered, node: runtimeNode, bundle, launcher, reason: registered ? null : "recovery-registration-failed" };
  } catch (error) { return { ok: false, reason: "recovery-install-failed", detail: error.message }; }
}
function uninstallRecovery({ homeDir = os.homedir(), platform = process.platform, runCommand = run } = {}) {
  if (platform === "win32") {
    const present = runCommand("schtasks.exe", ["/Query", "/TN", TASK]);
    if (!ok(present)) return { ok: true, absent: true };
    runCommand("schtasks.exe", ["/End", "/TN", TASK]);
    return { ok: ok(runCommand("schtasks.exe", ["/Delete", "/TN", TASK, "/F"])) };
  }
  const files = platform === "darwin"
    ? [path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`)]
    : ["timer", "service"].map((ext) => path.join(homeDir, ".config", "systemd", "user", `${LABEL}.${ext}`));
  if (!files.some((file) => fs.existsSync(file))) return { ok: true, absent: true };
  const result = platform === "darwin" ? runCommand("launchctl", ["unload", files[0]])
    : runCommand("systemctl", ["--user", "disable", "--now", `${LABEL}.timer`, `${LABEL}.service`]);
  if (!ok(result)) return { ok: false, reason: "recovery-stop-failed", detail: String(result?.out || result?.stderr || result?.error?.message || "").trim() };
  for (const file of files) fs.rmSync(file, { force: true });
  return { ok: true };
}
module.exports = { installRecovery, uninstallRecovery, windowsRecoveryTaskXml, LABEL, TASK };
