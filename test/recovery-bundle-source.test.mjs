// A rollback runs the FAILED candidate's `repair-runtime --target-bin <previous>`.
// When <previous> predates the independent recovery engine (anything before
// 0.1.510), the repair copied that tree's bootstrap into the recovery bundle,
// whose self-check can never pass. Every rollback to 0.1.490 therefore failed
// with `recovery-bundle-verification-failed` and two Macs stayed
// `recovery-required`, retrying hourly, from 2026-09-13 to 2026-10-10.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { recoveryBundleSourceRoot, repairDesktopSurfaces } from "../src/install.js";

const require = createRequire(import.meta.url);
const { installRecovery } = require("../bootstrap/recovery-install.cjs");
const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function preRecoveryTree(root) {
  // The shape of a 0.1.490 runtime: a bootstrap directory without the engine.
  const packageRoot = path.join(root, "releases", "r490", "node_modules", "relay-companion");
  fs.mkdirSync(path.join(packageRoot, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "relay-companion", version: "0.1.490" }));
  fs.writeFileSync(path.join(packageRoot, "bootstrap", "runtime-health.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(packageRoot, "bootstrap", "trust.json"), "{}\n");
  fs.writeFileSync(path.join(packageRoot, "bin", "relay.js"), "#!/usr/bin/env node\n");
  return { packageRoot, bin: path.join(packageRoot, "bin", "relay.js") };
}

// Real node for the bundle self-checks; launchd is never touched.
function sandboxCommands(calls) {
  return (command, args) => {
    calls.push([command, ...args].join(" "));
    if (/launchctl|systemctl|schtasks/.test(command)) return { status: 0, stdout: "", stderr: "" };
    return spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  };
}

test("a rollback target without the recovery engine installs the running tree's engine", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-source-"));
  const old = preRecoveryTree(root);
  assert.equal(recoveryBundleSourceRoot(old.bin), OWN_ROOT);
  assert.equal(recoveryBundleSourceRoot(path.join(OWN_ROOT, "bin", "relay.js"), { ownPackageRoot: "/elsewhere" }), OWN_ROOT,
    "a target that carries the engine supplies its own");
});

test("the old rollback fails deterministically and the fixed source root installs a working engine", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-rollback-"));
  const old = preRecoveryTree(root);
  const calls = [];
  const options = (homeDir) => ({ node: process.execPath, homeDir, platform: "darwin", runCommand: sandboxCommands(calls),
    reload: false, userId: 501, preserveNode: (node) => node });

  const before = installRecovery({ packageRoot: path.resolve(path.dirname(old.bin), ".."), ...options(path.join(root, "home-before")) });
  assert.equal(before.ok, false);
  assert.match(String(before.detail), /recovery-bundle-verification-failed/);

  const after = installRecovery({ packageRoot: recoveryBundleSourceRoot(old.bin), ...options(path.join(root, "home-after")) });
  assert.equal(after.ok, true, JSON.stringify(after));
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "home-after", ".relay", "recovery", "current.json"), "utf8"));
  assert.equal(pointer.version, JSON.parse(fs.readFileSync(path.join(OWN_ROOT, "package.json"), "utf8")).version);
});

test("repairDesktopSurfaces hands the recovery installer the engine-bearing tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-repair-"));
  const old = preRecoveryTree(root);
  const seen = [];
  const result = repairDesktopSurfaces({
    bin: old.bin,
    node: process.execPath,
    platform: "darwin",
    homeDir: path.join(root, "home"),
    reload: false,
    runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
    recoveryInstaller: (options) => { seen.push(options.packageRoot); return { ok: false, reason: "stop-here" }; },
    own: () => ({ assert() {}, release() {} }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(seen, [OWN_ROOT]);
});
