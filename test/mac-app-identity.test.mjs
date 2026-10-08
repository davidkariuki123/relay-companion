import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { brandMacElectronApp, localizeMacDisplayName, renameMacElectronExecutable, runMacTrayPositionProbe } from "../scripts/build-runtime-artifact.mjs";
import { verifyMacElectronIdentity } from "../scripts/verify-installed-runtime.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RELAY_MAC_BUNDLE_IDENTIFIER } = require("../src/mac-app-identity.cjs");

test("the runtime builder brands and verifies the outer Electron application", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-brand-test-"));
  try {
    const appPath = path.join(root, "Electron.app");
    fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture");
    fs.writeFileSync(path.join(appPath, "Contents", "MacOS", "Electron"), "main executable", { mode: 0o755 });
    const calls = [];
    const result = brandMacElectronApp(appPath, {
      platform: "darwin",
      runCommand(command, args) {
        calls.push({ command, args });
        if (args.includes("-extract") && args.includes("CFBundleIdentifier")) return RELAY_MAC_BUNDLE_IDENTIFIER;
        if (args.includes("-extract") && args.includes("CFBundleExecutable")) return "Relay";
        return "";
      },
    });
    assert.equal(result.bundleIdentifier, RELAY_MAC_BUNDLE_IDENTIFIER);
    assert.equal(result.executable, "Relay");
    assert.deepEqual(
      calls.filter(({ command, args }) => command === "/usr/bin/plutil" && args[0] === "-replace")
        .map(({ args }) => args.slice(0, 4)),
      [
        ["-replace", "CFBundleIdentifier", "-string", RELAY_MAC_BUNDLE_IDENTIFIER],
        ["-replace", "CFBundleName", "-string", "Electron"],
        ["-replace", "CFBundleDisplayName", "-string", "Electron"],
        ["-replace", "CFBundleExecutable", "-string", "Relay"],
        ["-replace", "LSHasLocalizedDisplayName", "-bool", "true"],
        // A background agent from launch: no Electron atom in the Dock, ever.
        ["-replace", "LSUIElement", "-bool", "true"],
      ],
    );
    const plistEdit = calls.findIndex(({ args }) => args.includes("LSUIElement"));
    assert.ok(plistEdit >= 0 && plistEdit < calls.findIndex(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--sign")),
      "LSUIElement is set before the bundle is re-signed");
    // macOS prompts ("… wants access to control Claude") use the localized
    // display name; the base name matches the Electron.app folder so macOS
    // honors the localization, which says Relay.
    const strings = fs.readFileSync(path.join(appPath, "Contents", "Resources", "en.lproj", "InfoPlist.strings"), "utf8");
    assert.match(strings, /"CFBundleDisplayName" = "Relay";/);
    const localized = calls.findIndex(({ args }) => args.includes("LSHasLocalizedDisplayName"));
    assert.ok(localized >= 0 && localized < calls.findIndex(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--sign")),
      "the localization is in place before the bundle is re-signed");
    // macOS names the ad-hoc signed pill agent after this file: it must be
    // Relay, and the legacy path must stay a relative link for old verifiers.
    const macos = path.join(appPath, "Contents", "MacOS");
    assert.equal(fs.readFileSync(path.join(macos, "Relay"), "utf8"), "main executable");
    assert.equal(fs.readlinkSync(path.join(macos, "Electron")), "Relay");
    assert.equal(fs.readFileSync(path.join(macos, "Electron"), "utf8"), "main executable");
    // The rename happens before the bundle is re-signed.
    const firstSign = calls.findIndex(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--sign"));
    const executableKey = calls.findIndex(({ args }) => args.includes("CFBundleExecutable") && args[0] === "-replace");
    assert.ok(executableKey >= 0 && executableKey < firstSign);
    assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--sign")));
    assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--verify")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renaming the Electron executable is idempotent and refuses ambiguous bundles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-rename-test-"));
  try {
    const appPath = path.join(root, "Electron.app");
    const macos = path.join(appPath, "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, "Electron"), "bytes", { mode: 0o755 });
    renameMacElectronExecutable(appPath);
    renameMacElectronExecutable(appPath);
    assert.deepEqual(fs.readdirSync(macos).sort(), ["Electron", "Relay"]);
    assert.equal(fs.readlinkSync(path.join(macos, "Electron")), "Relay");

    fs.rmSync(path.join(macos, "Electron"));
    fs.writeFileSync(path.join(macos, "Electron"), "second copy", { mode: 0o755 });
    assert.throws(() => renameMacElectronExecutable(appPath), /two main executables/);

    fs.rmSync(macos, { recursive: true });
    fs.mkdirSync(macos);
    assert.throws(() => renameMacElectronExecutable(appPath), /main executable is missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function identityFixture({ executable = "Relay", link = "Relay" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-identity-test-"));
  const macos = path.join(root, "Electron.app", "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, executable), "bytes", { mode: 0o755 });
  if (link) fs.symlinkSync(link, path.join(macos, "Electron"));
  return { root, electronPath: path.join(macos, executable) };
}

function plistSpawn(values, calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    if (command !== "/usr/bin/plutil") return { status: 0, stdout: "", stderr: "" };
    const key = args[args.indexOf("-extract") + 1];
    return { status: 0, stdout: `${values[key] ?? ""}\n`, stderr: "" };
  };
}

test("installed macOS runtime refuses an Electron-named bundle executable", () => {
  const { root } = identityFixture({ executable: "Electron", link: null });
  try {
    const electronPath = path.join(root, "Electron.app", "Contents", "MacOS", "Electron");
    assert.throws(() => verifyMacElectronIdentity(electronPath, {
      platform: "darwin",
      spawn: plistSpawn({ CFBundleIdentifier: RELAY_MAC_BUNDLE_IDENTIFIER, CFBundleExecutable: "Electron" }),
    }), /executable is not Relay/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed macOS runtime requires the Electron compatibility link", () => {
  const { root, electronPath } = identityFixture({ link: null });
  try {
    assert.throws(() => verifyMacElectronIdentity(electronPath, {
      platform: "darwin",
      spawn: plistSpawn({ CFBundleIdentifier: RELAY_MAC_BUNDLE_IDENTIFIER, CFBundleExecutable: "Relay" }),
    }), /compatibility link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed macOS runtime rejects a generic Electron identity", () => {
  const electronPath = "/runtime/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  assert.throws(
    () => verifyMacElectronIdentity(electronPath, {
      platform: "darwin",
      spawn: () => ({ status: 0, stdout: "com.github.Electron\n", stderr: "" }),
    }),
    /not Relay-owned/,
  );
});

test("installed macOS runtime verifies the branded identity and strict signature", () => {
  const calls = [];
  const { root, electronPath } = identityFixture();
  try {
    const result = verifyMacElectronIdentity(electronPath, {
      platform: "darwin",
      spawn: plistSpawn({ CFBundleIdentifier: RELAY_MAC_BUNDLE_IDENTIFIER, CFBundleExecutable: "Relay" }, calls),
    });
    assert.equal(result.bundleIdentifier, RELAY_MAC_BUNDLE_IDENTIFIER);
    assert.equal(result.executable, "Relay");
    assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--strict")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-macOS runtimes do not mutate or inspect application bundles", () => {
  assert.deepEqual(brandMacElectronApp("", { platform: "win32" }), { branded: false, reason: "not-darwin" });
  assert.deepEqual(runMacTrayPositionProbe("", { platform: "win32" }), { probed: false, reason: "not-darwin" });
  assert.deepEqual(verifyMacElectronIdentity("C:\\Electron.exe", { platform: "win32" }), {
    verified: false,
    reason: "not-darwin",
  });
});

test("the branded runtime probe covers first run, quit, app.exit, and relaunch", () => {
  const calls = [];
  const inherited = { ELECTRON_RUN_AS_NODE: "1", SAFE_VALUE: "kept" };
  assert.deepEqual(runMacTrayPositionProbe("/runtime/Relay", {
    platform: "darwin",
    env: inherited,
    runCommand(command, args, options) { calls.push({ command, args, options }); },
  }), { probed: true });
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), [
    "first-run",
    "write-position",
    "read-position",
    "write-position-exit",
    "read-position",
    "destroy-preserve",
  ]);
  assert.ok(calls.every(({ command }) => command === "/runtime/Relay"));
  assert.ok(calls.every(({ options }) => options.env.ELECTRON_RUN_AS_NODE === undefined));
  assert.ok(calls.every(({ options }) => options.env.SAFE_VALUE === "kept"));
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, "1", "the caller's environment is not mutated");
});

test("every localization of the pill's bundle names it Relay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-display-name-test-"));
  try {
    const appPath = path.join(root, "Electron.app");
    for (const loc of ["fr.lproj", "ja.lproj"]) fs.mkdirSync(path.join(appPath, "Contents", "Resources", loc), { recursive: true });
    assert.equal(localizeMacDisplayName(appPath), 3, "adds en.lproj and fills the existing ones");
    for (const loc of ["en.lproj", "fr.lproj", "ja.lproj"]) {
      assert.match(fs.readFileSync(path.join(appPath, "Contents", "Resources", loc, "InfoPlist.strings"), "utf8"), /"CFBundleDisplayName" = "Relay";/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
