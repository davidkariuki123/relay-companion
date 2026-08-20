import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installWindowsStartMenuShortcut,
  windowsShortcutScript,
  windowsStartMenuDir,
  windowsStartMenuShortcutMissing,
  windowsStartMenuShortcutPath,
} from "../src/install.js";

// Relay had no launchable app on Windows: no taskbar button (skipTaskbar), no
// Alt-Tab entry, a tray icon parked in the Windows 11 overflow chevron, and
// nothing in the Start Menu. These pin the shortcut that fixes it.

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-startmenu-"));
  const homeDir = path.join(root, "home");
  const appData = path.join(homeDir, "AppData", "Roaming");
  const packageRoot = path.join(root, "relay-companion");
  const bin = path.join(packageRoot, "bin", "relay.js");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "overlay"), { recursive: true });
  fs.writeFileSync(bin, "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(packageRoot, "overlay", "relay.ico"), "icon");
  return { root, homeDir, env: { APPDATA: appData }, bin };
}

/** A runCommand that records calls and executes the PowerShell's real effect. */
function fakePowerShell(calls, { ok = true } = {}) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== "powershell") return { ok: true, out: "", missing: false };
    if (!ok) return { ok: false, out: "denied", missing: false };
    // CreateShortcut(...).Save() writes the staging file; stand in for it.
    const script = args[args.length - 1];
    const staging = /CreateShortcut\('([^']*(?:''[^']*)*)'\)/.exec(script)?.[1]?.replaceAll("''", "'");
    if (staging) fs.writeFileSync(staging, "lnk");
    return { ok: true, out: "", missing: false };
  };
}

test("the shortcut lands in the per-user Start Menu, where Start search indexes it", () => {
  const { env, homeDir } = fixture();
  assert.equal(
    windowsStartMenuDir(env, homeDir),
    path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  );
  assert.equal(path.basename(windowsStartMenuShortcutPath(env, homeDir)), "Relay.lnk");
});

test("APPDATA absent falls back to the standard Roaming path rather than throwing", () => {
  const homeDir = path.join("C:", "Users", "someone");
  assert.equal(
    windowsStartMenuDir({}, homeDir),
    path.join(homeDir, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  );
});

test("installing writes a .lnk that runs `relay pill` through the hidden VBS shim", () => {
  const { env, homeDir, bin } = fixture();
  const calls = [];
  const vbsPath = path.join(homeDir, ".relay", "relay-pill-launcher.vbs");
  const result = installWindowsStartMenuShortcut({
    bin,
    node: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    homeDir,
    env,
    runCommand: fakePowerShell(calls),
    ensureLauncher: ({ commandLine, taskName }) => {
      // The shim runs the CLI, which is what raises an ALREADY-RUNNING pill instead
      // of spawning a second one (the --relay-reopen nonce path).
      assert.match(commandLine, /node\.exe" ".*relay\.js" pill$/);
      assert.equal(taskName, "Relay Pill Launcher");
      return { wscript: "C:\\Windows\\System32\\wscript.exe", vbsPath };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hidden, true);
  assert.equal(result.target, "C:\\Windows\\System32\\wscript.exe");
  assert.match(result.args, /^\/\/B \/\/Nologo "/);
  assert.ok(fs.existsSync(result.lnkPath), "the shortcut is published, not left in staging");
  const script = calls.find((c) => c.cmd === "powershell").args.at(-1);
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /\$s\.Save\(\)/);
  assert.match(script, /IconLocation='.*relay\.ico'/, "the committed .ico is used when present");
});

test("Windows Script Host disabled falls back to node directly rather than shipping no shortcut", () => {
  const { env, homeDir, bin } = fixture();
  const calls = [];
  const result = installWindowsStartMenuShortcut({
    bin,
    node: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    homeDir,
    env,
    runCommand: fakePowerShell(calls),
    ensureLauncher: () => null, // policy turned WSH off
  });
  assert.equal(result.ok, true);
  assert.equal(result.hidden, false, "a console flash is accepted; a missing Start Menu entry is not");
  assert.equal(result.target, "C:\\Program Files\\nodejs\\node.exe");
  assert.match(result.args, /relay\.js" pill$/);
});

test("a missing .ico omits IconLocation instead of failing the shortcut", () => {
  const { env, homeDir, bin } = fixture();
  fs.rmSync(path.join(path.dirname(path.dirname(bin)), "overlay", "relay.ico"));
  const calls = [];
  const result = installWindowsStartMenuShortcut({
    bin,
    node: "node.exe",
    platform: "win32",
    homeDir,
    env,
    runCommand: fakePowerShell(calls),
    ensureLauncher: () => null,
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(calls.find((c) => c.cmd === "powershell").args.at(-1), /IconLocation/);
});

test("a failed write leaves no half-written shortcut in the user's Start Menu", () => {
  const { env, homeDir, bin } = fixture();
  const result = installWindowsStartMenuShortcut({
    bin,
    node: "node.exe",
    platform: "win32",
    homeDir,
    env,
    runCommand: fakePowerShell([], { ok: false }),
    ensureLauncher: () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "shortcut_write_failed");
  assert.equal(fs.existsSync(result.lnkPath), false);
  const staging = fs.readdirSync(path.dirname(result.lnkPath));
  assert.deepEqual(staging, [], "the staging .lnk is cleaned up");
});

test("PowerShell literals survive a path containing a single quote", () => {
  const script = windowsShortcutScript({
    stagingPath: "C:\\Users\\O'Brien\\Relay.lnk.tmp.lnk",
    target: "C:\\Windows\\System32\\wscript.exe",
    args: "//B //Nologo \"C:\\x.vbs\"",
    description: "Show the Relay pill",
  });
  assert.match(script, /CreateShortcut\('C:\\Users\\O''Brien\\Relay\.lnk\.tmp\.lnk'\)/);
});

test("nothing happens off win32", () => {
  for (const platform of ["darwin", "linux"]) {
    const result = installWindowsStartMenuShortcut({ platform });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported_platform");
    assert.equal(windowsStartMenuShortcutMissing({ platform }), false);
  }
});

test("a deleted shortcut is reported missing so repair can restore it", () => {
  const { env, homeDir } = fixture();
  assert.equal(windowsStartMenuShortcutMissing({ platform: "win32", env, homeDir }), true);
  const lnk = windowsStartMenuShortcutPath(env, homeDir);
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, "lnk");
  assert.equal(windowsStartMenuShortcutMissing({ platform: "win32", env, homeDir }), false);
});
