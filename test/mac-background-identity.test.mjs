import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { installDaemonAutostart, installPillAutostart } from "../src/install.js";
import { ensureCandidateElectronRuntime } from "../src/canonical-runtime.js";
import { updateWorkerPlist } from "../src/canonical-updater.js";

const require = createRequire(import.meta.url);
const {
  RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS,
  associatedBundleIdentifiersPlist,
  preferredMacElectronExecutable,
} = require("../bootstrap/mac-background-identity.cjs");
const { APPLICATION_ID } = require("../bootstrap/application-owner.cjs");
const { runtimeExecutableInventory, verifyRuntimeExecutables } = require("../bootstrap/runtime-executables.cjs");
const { readRegistration } = require("../bootstrap/mac-service-recovery.cjs");
const { installRecovery } = require("../bootstrap/recovery-install.cjs");

// macOS Background Task Management names a legacy launch agent after the code at
// ProgramArguments[0]: the app its AssociatedBundleIdentifiers names when that
// app shares the code's Team ID, else a Developer ID's developer, else (ad-hoc,
// as the runtime's Electron is) the executable's own file name. A brand-new
// user saw "Electron can run in the background" (2026-10-08). These tests pin
// both halves of the fix.

const MAC_ONLY = process.platform !== "darwin" ? "needs macOS plutil and bundle layout" : false;
const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function macRuntime({ branded }) {
  const root = fs.realpathSync(temporary("relay-mac-runtime-"));
  const packageRoot = path.join(root, "release", "node_modules", "relay-companion");
  const electronRoot = path.join(packageRoot, "node_modules", "electron");
  const app = path.join(electronRoot, "dist", "Electron.app", "Contents");
  const macos = path.join(app, "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  for (const [bundle, executable] of [
    ["Electron Helper.app", "Electron Helper"],
    ["Electron Helper (GPU).app", "Electron Helper (GPU)"],
    ["Electron Helper (Plugin).app", "Electron Helper (Plugin)"],
    ["Electron Helper (Renderer).app", "Electron Helper (Renderer)"],
  ]) {
    const file = path.join(app, "Frameworks", bundle, "Contents", "MacOS", executable);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", { mode: 0o755 });
  }
  const crashpad = path.join(app, "Frameworks", "Electron Framework.framework", "Versions", "A", "Helpers", "chrome_crashpad_handler");
  fs.mkdirSync(path.dirname(crashpad), { recursive: true });
  fs.writeFileSync(crashpad, "", { mode: 0o755 });
  if (branded) {
    fs.writeFileSync(path.join(macos, "Relay"), "main", { mode: 0o755 });
    fs.symlinkSync("Relay", path.join(macos, "Electron"));
  } else {
    fs.writeFileSync(path.join(macos, "Electron"), "main", { mode: 0o755 });
  }
  // Electron's own index.js answers from path.txt, which always names MacOS/Electron.
  fs.writeFileSync(path.join(electronRoot, "package.json"), `${JSON.stringify({ name: "electron", main: "index.js" })}\n`);
  fs.writeFileSync(path.join(electronRoot, "index.js"),
    "module.exports = require('node:path').join(__dirname, 'dist/Electron.app/Contents/MacOS/Electron');\n");
  fs.writeFileSync(path.join(electronRoot, "install.js"), "throw new Error('must not reinstall a present runtime');\n");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "overlay"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "relay-companion", version: "9.8.7" })}\n`);
  fs.writeFileSync(path.join(packageRoot, "bin", "relay.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(packageRoot, "overlay", "main.cjs"), "// overlay\n");
  fs.writeFileSync(path.join(packageRoot, "overlay", "relayAppIcon.svg"), '<svg width="1024" height="1024"></svg>\n');
  fs.writeFileSync(path.join(packageRoot, "overlay", "relayTrayTemplate@2x.png"), "fallback");
  return { root, packageRoot, macos, homeDir: path.join(root, "home"), bin: path.join(packageRoot, "bin", "relay.js") };
}

function fakeMacCommands() {
  return (command, args) => {
    if (command === "/usr/bin/osacompile") {
      const output = args[args.indexOf("-o") + 1];
      fs.mkdirSync(path.join(output, "Contents", "MacOS"), { recursive: true });
      fs.mkdirSync(path.join(output, "Contents", "Resources", "Scripts"), { recursive: true });
      fs.writeFileSync(path.join(output, "Contents", "MacOS", "applet"), "applet\n", { mode: 0o755 });
      fs.writeFileSync(path.join(output, "Contents", "Resources", "Scripts", "main.scpt"), "script\n");
    }
    if (command === "/usr/bin/sips") {
      const output = args[args.indexOf("--out") + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "png");
    }
    if (command === "/usr/bin/iconutil") fs.writeFileSync(args[args.indexOf("-o") + 1], "icns");
    return { ok: true, out: "" };
  };
}

function plistJson(file) {
  const decoded = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr);
  return JSON.parse(decoded.stdout);
}

test("the association names the Developer ID application that owns Relay's installs", () => {
  assert.deepEqual(RELAY_MAC_ASSOCIATED_BUNDLE_IDENTIFIERS, [APPLICATION_ID]);
  assert.equal(APPLICATION_ID, "work.relay.application");
  assert.equal(associatedBundleIdentifiersPlist("  "),
    "  <key>AssociatedBundleIdentifiers</key><array><string>work.relay.application</string></array>");
});

test("a launch agent prefers the Relay-named bundle executable and leaves everything else alone", () => {
  const exists = (files) => ({ existsSync: (file) => files.includes(file), statSync: () => ({ isFile: () => true }) });
  const legacy = "/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const branded = "/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Relay";
  assert.equal(preferredMacElectronExecutable(legacy, exists([branded])), branded);
  assert.equal(preferredMacElectronExecutable(legacy, exists([])), legacy, "older runtimes keep MacOS/Electron");
  assert.equal(preferredMacElectronExecutable(branded, exists([branded])), branded);
  assert.equal(preferredMacElectronExecutable("C:\\r\\electron.exe", exists([])), "C:\\r\\electron.exe");
  assert.equal(preferredMacElectronExecutable("/r/dist/electron", exists([])), "/r/dist/electron");
  assert.equal(preferredMacElectronExecutable("/tmp/Electron", exists(["/tmp/Relay"])), "/tmp/Electron",
    "only a bundle's Contents/MacOS executable is renamed");
  assert.equal(preferredMacElectronExecutable(null), null);
});

test("runtime verification selects MacOS/Relay and still accepts runtimes that only have MacOS/Electron", { skip: MAC_ONLY }, (t) => {
  const branded = macRuntime({ branded: true });
  const legacy = macRuntime({ branded: false });
  t.after(() => { fs.rmSync(branded.root, { recursive: true, force: true }); fs.rmSync(legacy.root, { recursive: true, force: true }); });

  const brandedInventory = verifyRuntimeExecutables(branded.packageRoot, { platform: "darwin" });
  assert.equal(brandedInventory.ok, true, brandedInventory.reason);
  assert.equal(path.basename(brandedInventory.electronPath), "Relay");
  assert.equal(brandedInventory.paths.filter((entry) => entry.role === "electron").length, 1);

  const legacyInventory = verifyRuntimeExecutables(legacy.packageRoot, { platform: "darwin" });
  assert.equal(legacyInventory.ok, true, legacyInventory.reason);
  assert.equal(path.basename(legacyInventory.electronPath), "Electron");

  // An updater, recovery engine or native installer from before this change
  // checks exactly dist/Electron.app/Contents/MacOS/Electron: exists, is a
  // file, is executable. The compatibility link must keep satisfying it.
  const oldPath = path.join(branded.macos, "Electron");
  assert.equal(fs.existsSync(oldPath), true);
  assert.equal(fs.statSync(oldPath).isFile(), true);
  fs.accessSync(oldPath, fs.constants.X_OK);
});

test("candidate Electron repair is a no-op for either executable name", { skip: MAC_ONLY }, (t) => {
  for (const branded of [true, false]) {
    const runtime = macRuntime({ branded });
    t.after(() => fs.rmSync(runtime.root, { recursive: true, force: true }));
    const result = ensureCandidateElectronRuntime(runtime.packageRoot, {
      platform: "darwin",
      spawnSyncImpl: () => assert.fail("a present runtime must not run Electron's install.js"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, false);
    assert.equal(path.basename(result.electronPath), branded ? "Relay" : "Electron");
    assert.equal(result.electronPath, runtimeExecutableInventory(runtime.packageRoot, { platform: "darwin" }).electronPath);
  }
});

test("the pill agent launches MacOS/Relay, is associated with Relay.app, and is written identically each time", { skip: MAC_ONLY }, (t) => {
  const runtime = macRuntime({ branded: true });
  t.after(() => fs.rmSync(runtime.root, { recursive: true, force: true }));
  const install = () => installPillAutostart(runtime.bin, {
    platform: "darwin", homeDir: runtime.homeDir, reload: false, claim: true, runCommand: fakeMacCommands(),
  });
  const first = install();
  assert.equal(first.ok, true, first.reason);
  const plistPath = path.join(runtime.homeDir, "Library", "LaunchAgents", "work.relay.companion.pill.plist");
  const bytes = fs.readFileSync(plistPath, "utf8");
  const plist = plistJson(plistPath);
  // One path across updates: the stable link, pointing at this release's bundle.
  const stable = path.join(runtime.homeDir, ".relay", "runtime", "Relay.app");
  assert.equal(plist.ProgramArguments[0], path.join(stable, "Contents", "MacOS", "Relay"));
  assert.equal(fs.readlinkSync(stable), path.resolve(runtime.macos, "..", ".."));
  assert.deepEqual(plist.AssociatedBundleIdentifiers, ["work.relay.application"]);
  assert.equal(plist.Label, "work.relay.companion.pill");
  assert.equal(install().ok, true);
  assert.equal(fs.readFileSync(plistPath, "utf8"), bytes, "a rewrite must be byte-identical, never a reason to reload");
  // Recovery reads these registrations back and must keep accepting them.
  const record = readRegistration("work.relay.companion.pill", { homeDir: runtime.homeDir });
  assert.equal(record.executable, path.join(stable, "Contents", "MacOS", "Relay"));
  assert.equal(record.packageRoot, runtime.packageRoot);
});

test("the pill agent keeps MacOS/Electron for a runtime built before the rename", { skip: MAC_ONLY }, (t) => {
  const runtime = macRuntime({ branded: false });
  t.after(() => fs.rmSync(runtime.root, { recursive: true, force: true }));
  const result = installPillAutostart(runtime.bin, {
    platform: "darwin", homeDir: runtime.homeDir, reload: false, claim: true, runCommand: fakeMacCommands(),
  });
  assert.equal(result.ok, true, result.reason);
  const plist = plistJson(path.join(runtime.homeDir, "Library", "LaunchAgents", "work.relay.companion.pill.plist"));
  assert.equal(plist.ProgramArguments[0], path.join(runtime.homeDir, ".relay", "runtime", "Relay.app", "Contents", "MacOS", "Electron"));
});

test("the daemon agent is associated with Relay.app and still reads back as a recoverable registration", { skip: MAC_ONLY }, (t) => {
  const runtime = macRuntime({ branded: true });
  t.after(() => fs.rmSync(runtime.root, { recursive: true, force: true }));
  const result = installDaemonAutostart(runtime.bin, process.execPath, {
    platform: "darwin", homeDir: runtime.homeDir, reload: false, claim: true,
  });
  assert.equal(result.ok, true, result.reason);
  const plist = plistJson(result.plistPath);
  assert.deepEqual(plist.AssociatedBundleIdentifiers, ["work.relay.application"]);
  assert.deepEqual(plist.ProgramArguments, [process.execPath, "--max-old-space-size=128", runtime.bin, "daemon"]);
  assert.equal(readRegistration("work.relay.companion", { homeDir: runtime.homeDir }).script, runtime.bin);
});

test("the recovery agent is associated with Relay.app", { skip: MAC_ONLY }, (t) => {
  const homeDir = temporary("relay-recovery-identity-");
  let registered = false;
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const result = installRecovery({ homeDir, platform: "darwin", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    preserveNode: () => process.execPath,
    runCommand: (command, args) => {
      if (command !== "launchctl") return { status: 0 };
      if (args[0] === "bootstrap") registered = true;
      return args[0] === "print" && !registered ? { status: 113 } : { status: 0 };
    } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const plist = plistJson(path.join(homeDir, "Library", "LaunchAgents", "work.relay.companion.recovery.plist"));
  assert.deepEqual(plist.AssociatedBundleIdentifiers, ["work.relay.application"]);
  assert.equal(plist.StartInterval, 60);
});

test("the update worker job is associated with Relay.app", { skip: MAC_ONLY }, (t) => {
  const directory = temporary("relay-update-worker-identity-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "update-worker.plist");
  fs.writeFileSync(file, updateWorkerPlist(["/node", "/worker.cjs", "--worker", "payload"], "/tmp/update.log"));
  const plist = plistJson(file);
  assert.deepEqual(plist.AssociatedBundleIdentifiers, ["work.relay.application"]);
  assert.deepEqual(plist.ProgramArguments, ["/node", "/worker.cjs", "--worker", "payload"]);
});

// macOS 26 VM, 2026-10-08: a new ProgramArguments[0] path re-posts "Relay can
// run in the background"; the same path re-pointed at another binary does not.
test("an update re-points the pill's one stable path instead of naming a new one", (t) => {
  const { stablePillExecutable } = require("../bootstrap/mac-background-identity.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stable-pill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = (name) => {
    const macos = path.join(root, "releases", name, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, "Relay"), name);
    return path.join(macos, "Relay");
  };
  const home = path.join(root, "home");
  const first = stablePillExecutable(release("0.1.1"), { homeDir: home });
  const second = stablePillExecutable(release("0.1.2"), { homeDir: home });
  assert.equal(first, second, "the launch path survives the update");
  assert.equal(fs.readFileSync(second, "utf8"), "0.1.2", "and now runs the new release");
  // Never replaces a real directory, and falls back to the release path.
  const other = path.join(root, "other-home");
  fs.mkdirSync(path.join(other, ".relay", "runtime", "Relay.app"), { recursive: true });
  const fallback = release("0.1.3");
  assert.equal(stablePillExecutable(fallback, { homeDir: other }), fallback);
  // A path that is not inside an app bundle is left alone.
  assert.equal(stablePillExecutable("/usr/bin/true", { homeDir: home }), "/usr/bin/true");
});
