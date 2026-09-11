import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireLauncherLock, acquireCanonicalLock, nativeProcessIdentity, nativeIdentityBirth, write, read } from "../bootstrap/recovery-launcher.cjs";
import { repairRecoverySchedule } from "../src/recovery-maintenance.js";
import { CHECK_OVERDUE_MS, AWAKE_GRACE_MS } from "../bootstrap/recovery-monitor.cjs";
import { canonicalRuntimeLayout, recoverCanonicalRuntime } from "../src/canonical-runtime.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lock-proof-")), root = path.join(homeDir, ".relay", "recovery");
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, root };
}

test("process identity reads the current host and preserves unknown query results", () => {
  const identity = nativeProcessIdentity(process.pid);
  assert.ok(identity, "the actual test host must provide a birth identity");
  assert.ok(nativeIdentityBirth(identity) > 0);
  for (const platform of ["darwin", "win32"]) {
    assert.equal(nativeProcessIdentity(42, { platform, run: () => ({ error: Error("ETIMEDOUT") }) }), "");
  }
});

test("Mac identity includes boot and process birth, with fixed locale and timezone", () => {
  const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const identity = nativeProcessIdentity(42, { platform: "darwin", run: (command, args, options) => {
    assert.equal(options.env.LC_ALL, "C"); assert.equal(options.env.TZ, "UTC0");
    return { status: 0, stdout: command.endsWith("sysctl") ? boot : "Fri Sep 11 10:00:00 2026" };
  } });
  assert.equal(identity, `darwin:${boot}:${Date.parse("2026-09-11T10:00:00Z")}`);
});

test("launcher reclaims a reused PID but never steals a live or unknown owner", t => {
  const { root } = fixture(t), file = path.join(root, "launcher.lock", "owner.json");
  write(file, { pid: process.pid, nonce: "a".repeat(32), processIdentity: "prior-process", createdAt: 1 });
  const release = acquireLauncherLock(root);
  assert.equal(typeof release, "function");
  assert.equal(read(file).processIdentity, nativeProcessIdentity(process.pid));
  assert.equal(acquireLauncherLock(root), null, "same process identity remains exclusive");
  assert.equal(acquireLauncherLock(root, { processIdentity: () => "" }), null, "an unavailable query is not proof of abandonment");
  release();
});

test("legacy launcher lock is migrated when its PID belongs to a process born later", async t => {
  const { root } = fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    const file = path.join(root, "launcher.lock");
    write(file, { pid: child.pid, nonce: "old-launcher" });
    fs.utimesSync(file, new Date("2000-01-01"), new Date("2000-01-01"));
    const release = acquireLauncherLock(root);
    assert.equal(typeof release, "function");
    assert.ok(fs.statSync(file).isDirectory());
    assert.doesNotThrow(() => process.kill(child.pid, 0), "the unrelated process is never killed");
    release();
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
  }
});

test("maintenance can reclaim stale launcher and runner identities together", t => {
  const { homeDir, root } = fixture(t), now = 10 * CHECK_OVERDUE_MS;
  write(path.join(root, "daemon.json"), { pid: process.pid, at: now, awakeSince: now - AWAKE_GRACE_MS - 1 });
  for (const name of ["launcher.lock", "run.lock"]) write(path.join(root, name, "owner.json"), {
    pid: process.pid, nonce: "b".repeat(32), processIdentity: "previous-boot", createdAt: 1,
  });
  let repairs = 0;
  assert.equal(repairRecoverySchedule({ homeDir, now, repair: () => { repairs++; return { ok: true }; } }).status, "awaiting-check");
  assert.equal(repairs, 1);
});

test("migration preserves a late owner written by an older launcher", t => {
  const { root } = fixture(t), file = path.join(root, "launcher.lock");
  write(file, { pid: process.pid, nonce: "abandoned", processIdentity: "old" });
  const originalRename = fs.renameSync, live = { pid: process.pid, nonce: "late-owner", processIdentity: nativeProcessIdentity(process.pid) };
  let raced = false;
  fs.renameSync = (source, target) => {
    if (source === file && !raced) { raced = true; fs.writeFileSync(file, JSON.stringify(live)); }
    return originalRename(source, target);
  };
  try {
    assert.equal(acquireLauncherLock(root), null);
    assert.deepEqual(read(file), live);
  } finally { fs.renameSync = originalRename; }
});

test("concurrent reclaimers cannot delete the new lock generation", t => {
  const { root } = fixture(t), file = path.join(root, "transaction.lock"), ownerFile = path.join(file, "owner.json");
  write(ownerFile, { pid: process.pid, nonce: "c".repeat(32), processIdentity: "old", createdAt: 1 });
  let winner, raced = false;
  assert.throws(() => acquireCanonicalLock(file, {
    writeFileSync(target, ...args) {
      if (!raced && target === path.join(file, "reclaim.json")) {
        raced = true; winner = acquireCanonicalLock(file);
      }
      return fs.writeFileSync(target, ...args);
    },
  }), /already in progress/);
  assert.equal(read(ownerFile).processIdentity, nativeProcessIdentity(process.pid));
  assert.equal(fs.existsSync(path.join(file, "reclaim.json")), false);
  winner.release();
});

test("canonical journal recovery uses native process identity on the test host", async t => {
  const { homeDir } = fixture(t), layout = canonicalRuntimeLayout({ homeDir });
  write(layout.pointerPath, { schema: 1, active: false, state: "recovery-required", candidate: { version: "1.0.0" } });
  write(path.join(layout.lockPath, "owner.json"), { pid: process.pid, nonce: "d".repeat(32), processIdentity: "previous-process", createdAt: 1 });
  let admitted = false;
  const result = await recoverCanonicalRuntime({ homeDir, onLockAcquired(owner) {
    admitted = true; assert.equal(owner.processIdentity, nativeProcessIdentity(process.pid));
    throw Error("stop-after-lock-proof");
  } });
  assert.equal(admitted, true, JSON.stringify(result));
  assert.equal(result.phase, "admission");
  assert.equal(fs.existsSync(layout.lockPath), false);
});
