"use strict";

// "A bunch of the electron icons on my dash" (ao1, 2026-10-08). Relay's
// runtime ships an Electron binary, and anyone handed that binary to run one of
// Relay's Node scripts (an agent given an old prompt, a launcher that forgot
// ELECTRON_RUN_AS_NODE, a stale descriptor) starts an Electron APP, not Node:
// the script runs, prints, and the app never quits. Before the runtime bundle
// was LSUIElement every such run left a generic atom in the Dock; after it,
// an invisible process that lives forever.
//
// Every script Relay can be asked to run requires this first. Started as an
// Electron app, the script re-runs itself as plain Node with the same
// arguments, stdin and stdout, and the app exits with its status. Required by
// the pill (or anything else) it does nothing: only the entry script itself is
// ever re-run.
const fs = require("node:fs");
const path = require("node:path");

const RELAUNCHED = "RELAY_ELECTRON_AS_NODE_RELAUNCHED";
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const ENTRY_SCRIPTS = Object.freeze([
  "bin/relay.js",
  "bin/relay-hook.js",
  "bootstrap/application-update.cjs",
  "bootstrap/diagnostics-reporter.cjs",
  "bootstrap/recovery-runner.cjs",
  "bootstrap/recovery-schedule-handover.cjs",
  "bootstrap/relay-background-install.cjs",
  "bootstrap/relay-setup.cjs",
  "bootstrap/update-watchdog.cjs",
  "src/mcp-bridge.js",
  "src/mcp-broker-entry.js",
  "src/recovery-maintenance.js",
]);

// Runnable, but copied on their own into the agent protocol bundle
// (tools/relay-application/prepare-protocol.mjs) where no sibling exists, so
// they cannot load this guard. Both run under Relay's Node; a stray Electron
// launch of either is still quit by the pill (src/stray-electron.cjs).
const STANDALONE_SCRIPTS = Object.freeze([
  "bootstrap/recovery-launcher.cjs",
  "bootstrap/relay-skill.cjs",
]);

function realpath(file, realpathSync = fs.realpathSync) {
  try { return realpathSync(path.resolve(String(file || ""))); } catch { return path.resolve(String(file || "")); }
}

// True when this process is Electron running a script as its app (the main,
// "browser", process). Under ELECTRON_RUN_AS_NODE Electron is plain Node and
// process.type is undefined.
function runningAsElectronApp({ versions = process.versions, type = process.type } = {}) {
  return Boolean(versions && versions.electron) && type === "browser";
}

function isRelayEntryScript(script, { packageRoot = PACKAGE_ROOT, realpathSync = fs.realpathSync } = {}) {
  if (!script) return false;
  const target = realpath(script, realpathSync);
  return ENTRY_SCRIPTS.some((relative) => realpath(path.join(packageRoot, relative), realpathSync) === target);
}

function relaunchAsNodeIfElectronApp({
  versions = process.versions,
  type = process.type,
  argv = process.argv,
  env = process.env,
  execPath = process.execPath,
  packageRoot = PACKAGE_ROOT,
  realpathSync = fs.realpathSync,
  spawnSync = require("node:child_process").spawnSync,
  hideDock = () => { try { require("electron").app?.dock?.hide?.(); } catch {} },
  exit = (code) => process.exit(code),
} = {}) {
  if (!runningAsElectronApp({ versions, type })) return { relaunched: false, reason: "not-electron-app" };
  if (!isRelayEntryScript(argv[1], { packageRoot, realpathSync })) return { relaunched: false, reason: "not-entry" };
  hideDock();
  // ELECTRON_RUN_AS_NODE was honoured once already and Electron is still an
  // app: the RunAsNode fuse is off. Say so and stop rather than loop.
  if (env[RELAUNCHED] === "1") {
    try { process.stderr.write("Relay: this Electron cannot run scripts as Node; run it with Node instead.\n"); } catch {}
    exit(1);
    return { relaunched: false, reason: "run-as-node-unavailable" };
  }
  const result = spawnSync(execPath, argv.slice(1), {
    stdio: "inherit",
    windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", [RELAUNCHED]: "1" },
  });
  const code = Number.isInteger(result.status) ? result.status : 1;
  exit(code);
  return { relaunched: true, code };
}

module.exports = {
  ENTRY_SCRIPTS,
  STANDALONE_SCRIPTS,
  RELAUNCHED,
  isRelayEntryScript,
  relaunchAsNodeIfElectronApp,
  runningAsElectronApp,
};

relaunchAsNodeIfElectronApp();
