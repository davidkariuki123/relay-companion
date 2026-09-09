import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { recover, discover, busyLease, compare, write, execute } = require("../bootstrap/recovery-runner.cjs");
const { exactRuntimeHealth } = require("../bootstrap/runtime-health.cjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-test-"));
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }); });
  write(path.join(home, ".relay", "config.json"), { updateChannel: "stable" });
  return home;
}
test("recovery discovers newer code with a missing application and never imports the old tree", async t => {
  const homeDir = fixture(t); const calls = [];
  const result = await recover({ homeDir, env: {}, now: () => 1000,
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
test("discovery failure is recorded and does not alter the runtime pointer", async t => {
  const homeDir = fixture(t), pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  write(pointer, { active: true, version: "1.0.0" });
  const before = fs.readFileSync(pointer, "utf8");
  const result = await recover({ homeDir, env: {}, discoverImpl: async () => { throw Error("offline"); }, stage: () => assert.fail("must not install") });
  assert.equal(result.ok, false); assert.equal(result.lastError, "offline");
  assert.equal(fs.readFileSync(pointer, "utf8"), before);
});
test("new release bypasses failed-target backoff; no unsigned manifest is accepted", async t => {
  const homeDir = fixture(t);
  write(path.join(homeDir, ".relay", "recovery", "status.json"), { desiredVersion: "1.0.0", retryAt: 999999, failures: 4 });
  let staged = false;
  const result = await recover({ homeDir, env: {}, now: () => 100, discoverImpl: async () => "1.0.1", stage: () => { staged = true; throw Error("test-stop"); } });
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
  const result = await recover({ homeDir, env: {}, discoverImpl: async () => "1.2.3", stage: async () => {
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
