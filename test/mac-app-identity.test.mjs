import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { brandMacElectronApp, runMacTrayPositionProbe } from "../scripts/build-runtime-artifact.mjs";
import { verifyMacElectronIdentity } from "../scripts/verify-installed-runtime.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RELAY_MAC_BUNDLE_IDENTIFIER } = require("../src/mac-app-identity.cjs");

test("the runtime builder brands and verifies the outer Electron application", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-electron-brand-test-"));
  try {
    const appPath = path.join(root, "Electron.app");
    fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture");
    const calls = [];
    const result = brandMacElectronApp(appPath, {
      platform: "darwin",
      runCommand(command, args) {
        calls.push({ command, args });
        return args.includes("CFBundleIdentifier") && args.includes("-extract")
          ? RELAY_MAC_BUNDLE_IDENTIFIER
          : "";
      },
    });
    assert.equal(result.bundleIdentifier, RELAY_MAC_BUNDLE_IDENTIFIER);
    assert.deepEqual(
      calls.filter(({ command, args }) => command === "/usr/bin/plutil" && args[0] === "-replace")
        .map(({ args }) => args.slice(0, 4)),
      [
        ["-replace", "CFBundleIdentifier", "-string", RELAY_MAC_BUNDLE_IDENTIFIER],
        ["-replace", "CFBundleName", "-string", "Relay"],
        ["-replace", "CFBundleDisplayName", "-string", "Relay"],
      ],
    );
    assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--sign")));
    assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--verify")));
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
  const electronPath = "/runtime/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const result = verifyMacElectronIdentity(electronPath, {
    platform: "darwin",
    spawn(command, args) {
      calls.push({ command, args });
      return command === "/usr/bin/plutil"
        ? { status: 0, stdout: `${RELAY_MAC_BUNDLE_IDENTIFIER}\n`, stderr: "" }
        : { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.bundleIdentifier, RELAY_MAC_BUNDLE_IDENTIFIER);
  assert.ok(calls.some(({ command, args }) => command === "/usr/bin/codesign" && args.includes("--strict")));
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
    "write-position-signal",
    "read-position",
    "destroy-preserve",
    "cleanup",
  ]);
  assert.ok(calls.every(({ command }) => command === "/runtime/Relay"));
  assert.ok(calls.every(({ options }) => options.env.ELECTRON_RUN_AS_NODE === undefined));
  assert.ok(calls.every(({ options }) => options.env.SAFE_VALUE === "kept"));
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, "1", "the caller's environment is not mutated");
});
