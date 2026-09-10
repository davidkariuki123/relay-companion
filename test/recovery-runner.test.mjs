import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { recover, discover, busyLease, busyDecision, BUSY_GRACE_MS, compare, write, execute } = require("../bootstrap/recovery-runner.cjs");
const { exactRuntimeHealth } = require("../bootstrap/runtime-health.cjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-test-"));
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }); });
  write(path.join(home, ".relay", "config.json"), { updateChannel: "stable" });
  return home;
}
test("recovery discovers newer code with a missing application and never imports the old tree", async t => {
  const homeDir = fixture(t); const calls = [];
  const result = await recover({ homeDir, env: {}, now: () => 1000, memory: () => ({ pressured: false }),
    discoverImpl: async channel => { calls.push(channel); return "1.2.3"; },
    stage: async ({ destination, version }) => {
      assert.equal(version, "1.2.3");
      const packageRoot = path.join(destination, "node_modules", "relay-companion");
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "src", "recovery-entry.js"), "");
      return { packageRoot };
    }, run: async (_node, entry, args) => {
      assert.match(entry, /recovery-entry.js$/); assert.deepEqual(args, ["1.2.3", "stable"]);
      write(path.join(homeDir, ".relay", "runtime", "current.json"), { active: true, version: "1.2.3" });
      write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { version: "1.2.3", at: 1000 });
    }, health: () => ({ ok: true }) });
  assert.deepEqual(calls, ["stable"]); assert.equal(result.status, "current");
});
test("live active-work lease prevents replacement while allowing release discovery", async t => {
  const homeDir = fixture(t); let checks = 0;
  write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { busy: true, at: 1000 });
  const result = await recover({ homeDir, env: {}, now: () => 1010, discoverImpl: async () => { checks++; return "1.2.3"; }, stage: () => assert.fail("must not stage") });
  assert.equal(checks, 1); assert.equal(result.status, "deferred-busy");
  assert.equal(busyLease({ busy: true, at: 1000 }, 100000), false);
});

test("a refreshed but uncorroborated busy bit cannot postpone recovery forever", t => {
  const homeDir = fixture(t);
  const heartbeat = now => ({pid:process.pid,busy:true,at:now,activityVersion:1});
  assert.equal(busyDecision(heartbeat(1000),{homeDir,now:1000}),"deferred-busy");
  assert.equal(busyDecision(heartbeat(1000+BUSY_GRACE_MS),{homeDir,now:1000+BUSY_GRACE_MS}),null);
  // Restarts of the recovery runner do not restart the daemon's grace period.
  assert.equal(busyDecision(heartbeat(2000+BUSY_GRACE_MS),{homeDir,now:2000+BUSY_GRACE_MS}),null);
});

test("genuine long work remains protected; old uninstrumented daemons are never forcibly interrupted", t => {
  const homeDir=fixture(t), now=BUSY_GRACE_MS+1000;
  busyDecision({pid:process.pid,busy:true,at:1000,activityVersion:1},{homeDir,now:1000});
  const release=require('../bootstrap/update-activity.cjs').beginCall({homeDir,kind:'work'});
  const heartbeat={pid:process.pid,busy:true,at:now,activityVersion:1};
  assert.equal(busyDecision(heartbeat,{homeDir,now}),"deferred-active-work");
  release();
  assert.equal(busyDecision(heartbeat,{homeDir,now}),null);
  assert.equal(busyDecision({...heartbeat,activityVersion:undefined},{homeDir,now}),"deferred-unverified-work");
});
test("discovery failure still restarts a dead daemon in place and never alters the runtime pointer", async t => {
  const homeDir = fixture(t), pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  write(pointer, { active: true, version: "1.0.0", packageRoot: path.join(homeDir, "nowhere") });
  const before = fs.readFileSync(pointer, "utf8");
  const restarts = [];
  const result = await recover({ homeDir, env: {}, now: () => 5000, discoverImpl: async () => { throw Error("offline"); }, stage: () => assert.fail("must not install"),
    health: () => ({ ok: false, daemonCount: 0 }), restart: async () => { restarts.push(1); return { ok: false, reason: "service-task-missing" }; }, memory: () => ({ pressured: false }) });
  assert.equal(result.ok, false); assert.equal(result.status, "restart-failed"); assert.equal(result.discoveryError, "offline");
  assert.equal(restarts.length, 1);
  assert.equal(fs.readFileSync(pointer, "utf8"), before);
  // Offline with nothing installed is still just "failed": no rung applies.
  fs.rmSync(pointer);
  const bare = await recover({ homeDir, env: {}, discoverImpl: async () => { throw Error("offline"); }, stage: () => assert.fail("must not install") });
  assert.equal(bare.ok, false); assert.equal(bare.lastError, "offline");
});
test("new release bypasses failed-target backoff; no unsigned manifest is accepted", async t => {
  const homeDir = fixture(t);
  write(path.join(homeDir, ".relay", "recovery", "status.json"), { desiredVersion: "1.0.0", retryAt: 999999, failures: 4 });
  let staged = false;
  const result = await recover({ homeDir, env: {}, now: () => 100, memory: () => ({ pressured: false }), discoverImpl: async () => "1.0.1", stage: () => { staged = true; throw Error("test-stop"); } });
  assert.equal(staged, true); assert.equal(result.failures, 1);
  await assert.rejects(discover("stable", { fetchImpl: async () => ({ ok: true, json: async () => ({ version: "99.0.0" }) }) }));
  assert.equal(compare("1.0.10", "1.0.9"), 1);
});
test("health refuses duplicate daemon and an older MCP broker", () => {
  const packageRoot = "/home/test/.relay/runtime/releases/new/node_modules/relay-companion";
  const target = { packageRoot, bin: `${packageRoot}/bin/relay.js` };
  const commands = [`node ${target.bin} daemon`, `electron ${packageRoot}/overlay/main.cjs`];
  assert.equal(exactRuntimeHealth(target, { platform: "linux", commands }).ok, true);
  assert.equal(exactRuntimeHealth(target, { platform: "linux", commands: [...commands, commands[0]] }).ok, false);
  assert.equal(exactRuntimeHealth(target, { platform: "linux", commands: [...commands, "node /old/node_modules/relay-companion/src/mcp-broker-entry.js"] }).oldBroker, true);
});
test("parent deadline terminates a hung worker rather than merely timing out its promise", async () => {
  await assert.rejects(execute(process.execPath, "-e", ["setInterval(()=>{},1000)"], { timeoutMs: 100 }), /deadline-exceeded/);
});

test("durable update opt-out survives an independent scheduler environment", async t => {
  const homeDir = fixture(t);
  write(path.join(homeDir, ".relay", "recovery", "policy.json"), { autoUpdate: false });
  const result = await recover({ homeDir, env: {}, discoverImpl: () => assert.fail("disabled") });
  assert.equal(result.status, "disabled");
});

test("configuration disappearing during download fails closed before activation", async t => {
  const homeDir = fixture(t);
  const result = await recover({ homeDir, env: {}, memory: () => ({ pressured: false }), discoverImpl: async () => "1.2.3", stage: async () => {
    fs.rmSync(path.join(homeDir, ".relay", "config.json")); return {};
  }, run: () => assert.fail("must not activate") });
  assert.equal(result.lastError, "configuration-unavailable");
});

test("execute forwards an explicit stdio so the Windows watchdog can route the worker tree into update.log", async () => {
  const seen = [];
  const spawnImpl = (node, args, options) => {
    seen.push({ node, args, options });
    const handlers = {};
    const child = { pid: 1, once(event, fn) { handlers[event] = fn; return child; } };
    setImmediate(() => handlers.exit(0));
    return child;
  };
  await execute("node", "entry.cjs", ["--worker", "p"], { spawnImpl, stdio: ["ignore", 7, 7] });
  assert.deepEqual(seen[0].options.stdio, ["ignore", 7, 7]);
  await execute("node", "entry.cjs", ["--worker", "p"], { spawnImpl });
  assert.equal(seen[1].options.stdio, "inherit");
});

test("the update watchdog appends the Windows worker tree to ~/.relay/update.log and inherits stdio elsewhere", t => {
  const { updateLogStdio } = require("../bootstrap/update-watchdog.cjs");
  const homeDir = fixture(t);
  const win = updateLogStdio("win32", homeDir);
  assert.equal(win.logPath, path.join(homeDir, ".relay", "update.log"));
  assert.equal(win.stdio[0], "ignore");
  assert.equal(typeof win.stdio[1], "number");
  assert.equal(win.stdio[1], win.stdio[2]);
  fs.writeSync(win.stdio[1], "Verifying and installing Relay...\n");
  fs.closeSync(win.stdio[1]);
  assert.match(fs.readFileSync(win.logPath, "utf8"), /Verifying and installing Relay/);
  assert.deepEqual(updateLogStdio("darwin", homeDir), { stdio: "inherit", logPath: null });
  assert.deepEqual(updateLogStdio("linux", homeDir), { stdio: "inherit", logPath: null });
});

// --- Local-first repair ladder (2026-09-10): a starved machine must never be
// answered with a 245 MB download when the right code is already installed.
const { STALE_CONFIRM_MS, MAX_IN_PLACE_RESTARTS, sweepAbandonedDownloads } = require("../bootstrap/recovery-runner.cjs");
function installed(homeDir, version = "1.0.0") {
  const packageRoot = path.join(homeDir, ".relay", "runtime", "releases", version, "node_modules", "relay-companion");
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "src", "recovery-entry.js"), "");
  write(path.join(homeDir, ".relay", "runtime", "current.json"), { active: true, version, packageRoot, bin: path.join(packageRoot, "bin", "relay.js") });
  return packageRoot;
}
test("a stale heartbeat with a live daemon is observed once, then the installed runtime is restarted in place, never downloaded", async t => {
  const homeDir = fixture(t);
  installed(homeDir);
  write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { version: "1.0.0", at: 0, busy: false });
  let clock = 100_000, restarted = false;
  const opts = { homeDir, env: {}, now: () => clock, discoverImpl: async () => "1.0.0", stage: () => assert.fail("must not download"),
    memory: () => ({ pressured: true, freeMB: 11 }), sleep: async () => {},
    health: () => ({ ok: restarted, daemonCount: 1, daemon: true, pill: restarted }),
    restart: async (target, { platform }) => {
      assert.equal(target.version, "1.0.0"); assert.ok(platform); restarted = true;
      write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { version: "1.0.0", at: clock, busy: false });
      return { ok: true, terminated: [1, 2] };
    } };
  const first = await recover(opts);
  assert.equal(first.status, "stale-observed"); assert.equal(first.staleSince, 100_000); assert.equal(restarted, false);
  clock += STALE_CONFIRM_MS;
  const second = await recover(opts);
  assert.equal(second.status, "current"); assert.equal(second.repair, "restart"); assert.equal(restarted, true);
  const log = fs.readFileSync(path.join(homeDir, ".relay", "recovery", "recovery.log"), "utf8");
  assert.match(log, /status=stale-observed/); assert.match(log, /restart ok terminated=\[1,2\]/); assert.match(log, /status=current/);
});
test("a dead daemon is restarted without waiting for a second observation", async t => {
  const homeDir = fixture(t);
  installed(homeDir);
  let restarts = 0;
  const result = await recover({ homeDir, env: {}, now: () => 1000, discoverImpl: async () => "1.0.0", stage: () => assert.fail("must not download"),
    memory: () => ({ pressured: false }), health: () => ({ ok: false, daemonCount: 0 }), restart: async () => { restarts++; return { ok: false, reason: "service-start-failed" }; } });
  assert.equal(restarts, 1); assert.equal(result.status, "restart-failed"); assert.equal(result.restarts, 1); assert.equal(result.lastError, "service-start-failed");
});
test("after the restart budget is spent the release already on disk is re-activated; the download rung waits for memory", async t => {
  const homeDir = fixture(t);
  const packageRoot = installed(homeDir);
  write(path.join(homeDir, ".relay", "recovery", "status.json"), { version: "1.0.0", desiredVersion: "1.0.0", status: "restart-failed", restarts: MAX_IN_PLACE_RESTARTS, staleSince: 0 });
  const ran = [];
  const clock = 50_000;
  let reactivated = false;
  const opts = { homeDir, env: {}, now: () => clock, discoverImpl: async () => "1.0.0", stage: () => assert.fail("must not download"), sleep: async () => {},
    restart: () => assert.fail("restart budget is spent"), health: () => ({ ok: reactivated, daemonCount: 0 }),
    run: async (_node, entry, args) => {
      ran.push({ entry, args }); reactivated = true;
      write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { version: "1.0.0", at: clock });
    } };
  // Under memory pressure neither re-activation nor download runs.
  const deferred = await recover({ ...opts, memory: () => ({ pressured: true, freeMB: 40 }) });
  assert.equal(deferred.status, "deferred-memory-pressure"); assert.deepEqual(ran, []);
  const result = await recover({ ...opts, memory: () => ({ pressured: false }) });
  assert.equal(result.status, "current"); assert.equal(result.repair, "reactivate");
  assert.equal(ran.length, 1); assert.equal(ran[0].entry, path.join(packageRoot, "src", "recovery-entry.js")); assert.deepEqual(ran[0].args, ["1.0.0", "stable"]);
});
test("a failed re-activation falls through to the download rung, and memory pressure defers a fresh install too", async t => {
  const homeDir = fixture(t);
  installed(homeDir);
  write(path.join(homeDir, ".relay", "recovery", "status.json"), { version: "1.0.0", desiredVersion: "1.0.0", status: "restart-failed", restarts: MAX_IN_PLACE_RESTARTS, staleSince: 0 });
  let staged = false;
  const result = await recover({ homeDir, env: {}, now: () => 9000, discoverImpl: async () => "1.0.0", memory: () => ({ pressured: false }), sleep: async () => {},
    restart: () => assert.fail("restart budget is spent"), health: () => ({ ok: false, daemonCount: 0 }), run: async () => { throw Error("worker-exit-1"); },
    stage: async () => { staged = true; throw Error("test-stop"); } });
  assert.equal(staged, true); assert.equal(result.status, "failed"); assert.equal(result.lastError, "test-stop");
  const nothingInstalled = fixture(t);
  const deferred = await recover({ homeDir: nothingInstalled, env: {}, discoverImpl: async () => "1.2.3", memory: () => ({ pressured: true, freeMB: 9 }), stage: () => assert.fail("no download under pressure") });
  assert.equal(deferred.status, "deferred-memory-pressure");
});
test("abandoned staged downloads are swept once the next runner owns the lock; canonical releases are untouched", async t => {
  const homeDir = fixture(t);
  installed(homeDir);
  write(path.join(homeDir, ".relay", "recovery", "daemon.json"), { version: "1.0.0", at: 1000 });
  const downloads = path.join(homeDir, ".relay", "recovery", "downloads");
  for (const name of ["86cf7715-6ece-4183-84a7-e60c520e919b", ".relay-download-1.0.0-abc"]) fs.mkdirSync(path.join(downloads, name, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(downloads, "notes.txt"), "keep");
  assert.equal(sweepAbandonedDownloads(path.join(homeDir, "missing")), 0);
  const result = await recover({ homeDir, env: {}, now: () => 1000, discoverImpl: async () => "1.0.0", health: () => ({ ok: true }), memory: () => ({ pressured: false }) });
  assert.equal(result.status, "current");
  assert.deepEqual(fs.readdirSync(downloads).sort(), ["notes.txt"]);
  assert.ok(fs.existsSync(path.join(homeDir, ".relay", "runtime", "releases", "1.0.0")));
  assert.match(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "recovery.log"), "utf8"), /swept 2 abandoned download\(s\)/);
});
