"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { relayOwnedNodePath } = require("./owned-node-runtime.cjs");
const { read, write, compare } = require("./recovery-runner.cjs");
const LABEL = "work.relay.companion.recovery";
const TASK = "Relay Companion Recovery";
const ok = (r) => r?.ok === true || (!r?.error && r?.status === 0);
const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unit = (s) => '"' + String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
function run(command, args) { return spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 }); }

function installRecovery({ packageRoot, node = process.execPath, homeDir = os.homedir(), platform = process.platform,
  runCommand = run, reload = true, preserveNode = relayOwnedNodePath } = {}) {
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
    const bundle = path.join(root, "versions", hash.digest("hex"));
    const runtimeNode = preserveNode(node, { platform, runtimeRoot: root, isTemporary: () => true });
    fs.mkdirSync(path.join(bundle, "bootstrap"), { recursive: true, mode: 0o700 });
    for (const name of names) fs.copyFileSync(path.join(source, name), path.join(bundle, "bootstrap", name));
    fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(bundle, "package.json"));
    const pointer = path.join(root, "current.json");
    // Import an older stock engine only when it has already reported a healthy
    // check. Merely passing the installation probe does not make it known-good.
    const priorStatus = read(path.join(root, "status.json"));
    if (current && !read(path.join(root, "known-good.json")) && current.version === priorStatus?.launcherVersion
      && priorStatus.ok === true && ["current", "ahead"].includes(priorStatus.status)
      && require("./recovery-launcher.cjs").validPointer(current, root)) {
      write(path.join(root, "known-good.json"), current);
    }
    const temporary = `${pointer}.${process.pid}.tmp`;
    const checked = runCommand(runtimeNode, [path.join(bundle, "bootstrap", "recovery-runner.cjs"), "--self-check"]);
    if (!ok(checked)) throw Error("recovery-bundle-verification-failed");
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, version: incoming, node: runtimeNode, bundle }), { mode: 0o600 });
    fs.renameSync(temporary, pointer);
    const launcher = path.join(root, "launch.cjs");
    // Static launcher dispatches through a replaceable pointer. Never overwrite
    // the executable currently running; old bundles are recovery fallbacks.
    const launcherTemp = `${launcher}.${process.pid}.tmp.cjs`;
    fs.writeFileSync(launcherTemp, fs.readFileSync(path.join(source, "recovery-launcher.cjs")), { mode: 0o700 });
    if (!ok(runCommand(runtimeNode, ["--check", launcherTemp]))) throw Error("recovery-launcher-verification-failed");
    fs.renameSync(launcherTemp, launcher);
    // The scheduler must not depend on an unproven replacement Node binary to
    // reach the fallback launcher. Advance this host only from proven recovery.
    const proven = read(path.join(root, "known-good.json"));
    const oldHost = read(path.join(root, "launcher-node.json"))?.node;
    const preferredHost = proven?.node || oldHost;
    const launcherNode = typeof preferredHost === "string" && path.resolve(preferredHost).startsWith(path.join(root,"node") + path.sep)
      && ok(runCommand(preferredHost, ["--version"])) ? preferredHost : runtimeNode;
    write(path.join(root, "launcher-node.json"), { node: launcherNode });
    const log = path.join(root, "recovery.log");
    const results = [];
    if (platform === "win32") {
      const script = path.join(root, "launch.vbs");
      const command = `"${launcherNode}" "${launcher}"`;
      fs.writeFileSync(script, `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("${command.replaceAll('"', '""')}", 0, True)\r\n`);
      results.push(runCommand("schtasks.exe", ["/Create", "/TN", TASK, "/TR", `wscript.exe //B "${script}"`, "/SC", "MINUTE", "/MO", "5", "/RL", "LIMITED", "/F"]));
    } else if (platform === "darwin") {
      const plist = path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(launcherNode)}</string><string>${xml(launcher)}</string></array><key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`);
      if (reload && process.env.RELAY_RECOVERY_WORKER !== "1") {
        runCommand("launchctl", ["unload", plist]);
        results.push(runCommand("launchctl", ["load", plist]));
      }
    } else {
      const dir = path.join(homeDir, ".config", "systemd", "user");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${LABEL}.service`), `[Unit]\nDescription=Relay update recovery\n[Service]\nType=oneshot\nExecStart=${unit(launcherNode)} ${unit(launcher)}\nTimeoutStartSec=1800\nKillMode=control-group\n`);
      fs.writeFileSync(path.join(dir, `${LABEL}.timer`), `[Unit]\nDescription=Check Relay update health\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=5min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`);
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
module.exports = { installRecovery, uninstallRecovery, LABEL, TASK };
