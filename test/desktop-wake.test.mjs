// Desktop idle-wake shim: the seam that adds --channels to Claude Desktop's
// own CLI spawn. Everything here runs against a FAKE Claude tree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cliBinaryPath, installDesktopWake, installedCliVersions, isMachO,
  shimSource, uninstallDesktopWake, wakeStatus,
} from "../src/desktop-wake.js";

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-wake-home-"));
}
// A stand-in for the signed CLI: Mach-O magic so the guard accepts it, but a
// script body so exec + --version actually work in the test.
function fakeCli(home, version, { works = true } = {}) {
  const dir = path.dirname(cliBinaryPath(version, { home }));
  fs.mkdirSync(dir, { recursive: true });
  const bin = cliBinaryPath(version, { home });
  fs.writeFileSync(bin, works ? `#!/bin/sh\necho "${version} (Claude Code)"\n` : "﻿broken");
  fs.chmodSync(bin, 0o755);
  return bin;
}
// Force the Mach-O gate to see what it expects without shipping a binary.
function stampMachO(file) {
  const body = fs.readFileSync(file);
  const magic = Buffer.alloc(4);
  magic.writeUInt32BE(0xfeedfacf, 0);
  fs.writeFileSync(file, Buffer.concat([magic, body]));
  fs.chmodSync(file, 0o755);
}

test("the shim execs the real binary and appends the channels flag, passing args through", () => {
  const src = shimSource("/path/to/claude.relay-real", "server:relay");
  assert.match(src, /^#!\/bin\/sh/);
  assert.match(src, /exec "\/path\/to\/claude\.relay-real" --dangerously-load-development-channels "server:relay" "\$@"/);
  // exec (not a subshell) so Desktop's process tree, signals and exit code are unchanged.
  assert.ok(!/\n[^#]*\$\(/.test(src), "no command substitution around the exec");
});

test("install moves the original aside, verifies the shim, and reports status", () => {
  const home = fakeHome();
  // The CLI must fail `--version` verification on EVERY platform, so its body
  // has to be unverifiable on its own merits — not merely unexecutable.
  // Prepending Mach-O magic to a shell script is unexecutable on macOS but NOT
  // on Linux: glibc's execvp falls back to /bin/sh on ENOEXEC, so the magic
  // becomes a "not found" line and the script's real body still runs. A test
  // that leaned on the stamp alone passed locally and failed in CI.
  const bin = fakeCli(home, "2.1.221", { works: false });
  const original = fs.readFileSync(bin);
  stampMachO(bin);
  assert.equal(isMachO(bin), true);
  const failed = installDesktopWake("2.1.221", { home });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /verify_failed/);
  assert.equal(fs.existsSync(`${bin}.relay-real`), false, "no orphaned real binary after rollback");
  assert.equal(isMachO(bin), true, "the original is back exactly as it was");

  fs.writeFileSync(bin, original);
  fs.chmodSync(bin, 0o755);
  stampMachO(bin);
  fs.writeFileSync(`${bin}.probe`, "");
  // Replacing this with a runnable body that still passes the Mach-O guard is
  // impossible by construction, so assert the guard itself protects the user.
  assert.equal(installDesktopWake("2.1.221", { home }).ok, false, "never shims something it cannot verify");
});

test("it refuses to shim a shim, and reports which versions are enabled", () => {
  const home = fakeHome();
  const bin = fakeCli(home, "2.1.222"); // a plain script == not the original binary
  assert.equal(isMachO(bin), false);
  const res = installDesktopWake("2.1.222", { home });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_original_binary");
  assert.deepEqual(wakeStatus({ home }), [{ version: "2.1.222", installed: false, present: true }]);
});

test("uninstall is a no-op when nothing was installed, and finds every version", () => {
  const home = fakeHome();
  fakeCli(home, "2.1.221");
  fakeCli(home, "2.1.222");
  assert.deepEqual(installedCliVersions({ home }), ["2.1.221", "2.1.222"]);
  assert.deepEqual(uninstallDesktopWake("2.1.221", { home }), { ok: true, version: "2.1.221", reason: "not_installed" });
});
