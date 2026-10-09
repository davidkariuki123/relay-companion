"use strict";

// No Electron atoms, ever (ao1, 2026-10-08: "a bunch of the electron icons on
// my dash"). Relay's runtime ships an Electron binary. Started with a script
// instead of the pill, that binary is an Electron APP that runs the script and
// never quits: an agent given an older prompt that named the binary, a launcher
// that forgot ELECTRON_RUN_AS_NODE, anything. Two repairs run from the pill on
// macOS, where those apps sit in the Dock:
//
// 1. Sweep: an Electron app from a Relay runtime that is not this pill is a
//    leak. Every Relay script now re-runs itself as Node when started that way
//    (bootstrap/electron-as-node.cjs), but scripts in older runtime trees do
//    not. LaunchServices registers only Electron APPS; Electron run as Node
//    (the daemon's helpers, `relay update`, the MCP broker) never appears in
//    `lsappinfo`, so it is never touched.
// 2. Heal: release trees from before the runtime bundle was LSUIElement stay on
//    disk as rollback targets. Mark them LSUIElement (and re-sign ad hoc, as the
//    build does) so even a stray launch of one shows nothing in the Dock.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ELECTRON_MACOS_DIR = path.join("electron", "dist", "Electron.app", "Contents", "MacOS");

function runtimeRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "runtime");
}

// Executables that belong to Relay's own runtime: every release tree's
// Electron.app (MacOS/Electron and MacOS/Relay), and the runtime's Relay.app.
function isRelayRuntimeExecutable(executable, { homeDir = os.homedir() } = {}) {
  const file = path.resolve(String(executable || ""));
  const root = runtimeRoot(homeDir);
  if (file.startsWith(path.join(root, "Relay.app", "Contents", "MacOS") + path.sep)) return true;
  const releases = path.join(root, "releases") + path.sep;
  return file.startsWith(releases) && file.includes(path.sep + path.join("node_modules", ELECTRON_MACOS_DIR) + path.sep);
}

// `lsappinfo list` → [{ pid, executable }] for every registered application.
function parseLsappinfo(text) {
  const apps = [];
  let current = null;
  for (const line of String(text || "").split("\n")) {
    if (/^\s*\d+\)\s/.test(line)) {
      if (current) apps.push(current);
      current = { pid: 0, executable: "" };
      continue;
    }
    if (!current) continue;
    const exe = line.match(/executable path="([^"]+)"/);
    if (exe) current.executable = exe[1];
    const pid = line.match(/\bpid = (\d+)\b/);
    if (pid) current.pid = Number(pid[1]);
  }
  if (current) apps.push(current);
  return apps.filter((app) => app.pid > 0 && app.executable);
}

// A pill (any tree's overlay/main.cjs) is never a stray: another one is the
// single-instance loser and exits by itself, or a deliberate harness.
function isPillCommand(command) {
  return /[\\/]overlay[\\/]main\.cjs(?:\s|$)/.test(String(command || ""));
}

function strayRelayElectronApps({ lsappinfo, commands = new Map(), selfPid = process.pid, homeDir = os.homedir() }) {
  return parseLsappinfo(lsappinfo).filter((app) => app.pid !== selfPid
    && isRelayRuntimeExecutable(app.executable, { homeDir })
    && commands.has(app.pid)
    && !isPillCommand(commands.get(app.pid)));
}

function run(file, args, { execFileImpl = execFile, timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || ""), error });
    });
  });
}

async function commandsFor(pids, options) {
  const commands = new Map();
  if (!pids.length) return commands;
  const ps = await run("/bin/ps", ["-o", "pid=,command=", "-p", pids.join(",")], options);
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

async function sweepStrayRelayElectronApps({
  homeDir = os.homedir(),
  selfPid = process.pid,
  execFileImpl = execFile,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  const options = { execFileImpl };
  const listed = await run("/usr/bin/lsappinfo", ["list"], options);
  if (!listed.ok) return { ok: false, reason: "lsappinfo-failed", killed: [] };
  const candidates = parseLsappinfo(listed.stdout)
    .filter((app) => app.pid !== selfPid && isRelayRuntimeExecutable(app.executable, { homeDir }));
  const commands = await commandsFor(candidates.map((app) => app.pid), options);
  const strays = strayRelayElectronApps({ lsappinfo: listed.stdout, commands, selfPid, homeDir });
  const killed = [];
  for (const stray of strays) {
    try { kill(stray.pid, "SIGTERM"); killed.push(stray.pid); log(`quit stray Electron app ${stray.pid}: ${commands.get(stray.pid)}`); } catch {}
  }
  if (killed.length) {
    await sleep(3000);
    for (const pid of killed) { try { kill(pid, 0); kill(pid, "SIGKILL"); } catch {} }
  }
  return { ok: true, killed };
}

function electronAppsOnDisk({ homeDir = os.homedir(), fsImpl = fs } = {}) {
  const releases = path.join(runtimeRoot(homeDir), "releases");
  let names = [];
  try { names = fsImpl.readdirSync(releases); } catch { return []; }
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(releases, name, "node_modules", "electron", "dist", "Electron.app"))
    .filter((appPath) => { try { return fsImpl.statSync(path.join(appPath, "Contents", "Info.plist")).isFile(); } catch { return false; } });
}

// Release trees whose Electron.app still lacks LSUIElement and from which no
// process is running (a running tree is never re-signed under itself).
async function healRuntimeDockIdentity({
  homeDir = os.homedir(),
  execFileImpl = execFile,
  fsImpl = fs,
  log = () => {},
} = {}) {
  const options = { execFileImpl };
  const apps = electronAppsOnDisk({ homeDir, fsImpl });
  if (!apps.length) return { ok: true, healed: [], skipped: [] };
  const running = await run("/bin/ps", ["-axo", "comm="], options);
  const busy = (appPath) => running.stdout.split("\n").some((comm) => comm.startsWith(path.dirname(path.dirname(path.dirname(path.dirname(appPath)))) + path.sep));
  const healed = [], skipped = [];
  for (const appPath of apps) {
    const info = path.join(appPath, "Contents", "Info.plist");
    const current = await run("/usr/bin/plutil", ["-extract", "LSUIElement", "raw", "-o", "-", info], options);
    if (current.ok && current.stdout.trim() === "true") continue;
    if (!running.ok || busy(appPath)) { skipped.push(appPath); continue; }
    const set = await run("/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "true", info], options);
    if (!set.ok) { skipped.push(appPath); continue; }
    const signed = await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { ...options, timeout: 5 * 60_000 });
    if (!signed.ok) { log(`could not re-sign ${appPath}: ${signed.error && signed.error.message}`); skipped.push(appPath); continue; }
    healed.push(appPath);
    log(`marked ${appPath} as a background app`);
  }
  return { ok: true, healed, skipped };
}

// Sweep shortly after launch and then every ten minutes; heal once, later,
// off the launch path. Returns a stop function.
function startStrayElectronGuard({
  platform = process.platform,
  log = () => {},
  firstSweepMs = 20_000,
  sweepEveryMs = 10 * 60_000,
  healAfterMs = 90_000,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
  sweep = sweepStrayRelayElectronApps,
  heal = healRuntimeDockIdentity,
} = {}) {
  if (platform !== "darwin") return () => {};
  let sweeping = false;
  const tick = () => {
    if (sweeping) return;
    sweeping = true;
    Promise.resolve().then(() => sweep({ log })).catch(() => {}).finally(() => { sweeping = false; });
  };
  const first = setTimeoutImpl(tick, firstSweepMs);
  const later = setTimeoutImpl(() => { Promise.resolve().then(() => heal({ log })).catch(() => {}); }, healAfterMs);
  const every = setIntervalImpl(tick, sweepEveryMs);
  for (const timer of [first, later, every]) timer?.unref?.();
  return () => { clearTimeoutImpl(first); clearTimeoutImpl(later); clearIntervalImpl(every); };
}

module.exports = {
  electronAppsOnDisk,
  healRuntimeDockIdentity,
  isPillCommand,
  isRelayRuntimeExecutable,
  parseLsappinfo,
  startStrayElectronGuard,
  strayRelayElectronApps,
  sweepStrayRelayElectronApps,
};
