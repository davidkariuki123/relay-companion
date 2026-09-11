import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LABELS, repairMacServiceRegistrations, restartMacRegisteredServices } from "../bootstrap/mac-service-recovery.cjs";
import { recover, write } from "../bootstrap/recovery-runner.cjs";
import { acquireCanonicalLock } from "../bootstrap/relay-setup.cjs";
import { prepareSnapshot, readSnapshot, restoreSnapshot } from "../bootstrap/mac-registration-transaction.cjs";
import { macActivationTransaction } from "../bootstrap/mac-activation-transaction.cjs";
import { acquireMacPowerAssertion } from "../bootstrap/mac-power-assertion.cjs";
import { spawnSync } from "node:child_process";
import { activateCanonicalRuntime } from "../src/canonical-updater.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mac-recovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const packageRoot = path.join(homeDir, "runtime", "node_modules", "relay-companion");
  const node = path.join(homeDir, "node");
  fs.writeFileSync(node, "node");
  const plists = new Map();
  for (const [index, label] of LABELS.entries()) {
    const script = path.join(packageRoot, ...(index ? ["overlay", "main.cjs"] : ["bin", "relay.js"]));
    fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, "");
    const file = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
    const data = { Label: label, ProgramArguments: [node, script, ...(index ? [] : ["daemon"])] };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data));
    plists.set(file, data);
  }
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "relay-companion", version: "0.1.504" }));
  write(path.join(homeDir, ".relay", "config.json"), { updateChannel: "dev" });
  const registered = new Map(), loaded = new Map(), calls = [];
  const run = (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/plutil") return { status: 0, stdout: options.input };
    const label = args.at(-1).split(/[\\/]/).at(-1).replace(/\.plist$/, "");
    if (args[0] === "print") return registered.has(label) ? { status: 0, stdout: `pid = ${registered.get(label) || ""}\n${(loaded.get(label) || [...plists.values()].find(p => p.Label === label)).ProgramArguments.join("\n")}` } : { status: 113 };
    if (["bootstrap", "kickstart"].includes(args[0])) {
      registered.set(label, 123);
      if (args[0] === "bootstrap") loaded.set(label, JSON.parse(fs.readFileSync(args.at(-1), "utf8")));
      return { status: 0 };
    }
    assert.fail(`unexpected destructive command: ${args}`);
  };
  const opts = { homeDir, platform: "darwin", run, isAlive: () => true };
  return { homeDir, opts, registered, loaded, calls, plists, node, packageRoot };
}

test("Sven's inactive journal restores both services in one offline, pressured watchdog tick", async t => {
  const f = fixture(t);
  const pointer = path.join(f.homeDir, ".relay", "runtime", "current.json");
  write(pointer, { state: "recovery-required", active: false, version: null, previous: { version: "0.1.504" } });
  const before = fs.readFileSync(pointer, "utf8");
  const result = await recover({ homeDir: f.homeDir, platform: "darwin", env: {},
    verifyReady: async () => ({ ok: false }),
    repairServices: () => repairMacServiceRegistrations(f.opts),
    discoverImpl: () => assert.fail("local repair must precede network discovery"),
    memory: () => assert.fail("local repair must not consult memory") });
  assert.equal(result.status, "service-repair-unhealthy"); assert.equal(result.runtimeHealthy, false);
  assert.deepEqual([...f.registered.keys()], LABELS);
  assert.equal(fs.readFileSync(pointer, "utf8"), before);
  const again = await repairMacServiceRegistrations(f.opts);
  assert.equal(again.changed, false);
  assert.equal(f.calls.filter(x => x[1] === "bootstrap").length, 2);
});

test("a live updater excludes watchdog changes; a dead owner's lock is recovered", async t => {
  const f = fixture(t), file = path.join(f.homeDir, ".relay", "runtime", "transaction.lock");
  const owner = acquireCanonicalLock(file);
  try { assert.equal((await repairMacServiceRegistrations(f.opts)).status, "deferred-update-owner"); assert.equal(f.calls.length, 0); }
  finally { owner.release(); }
  fs.mkdirSync(file); write(path.join(file, "owner.json"), { pid: 99999999, nonce: "dead", createdAt: Date.now() });
  assert.equal((await repairMacServiceRegistrations(f.opts)).status, "services-restored");
});

test("registered dead services are kickstarted without stopping the live daemon", async t => {
  const f = fixture(t); f.registered.set(LABELS[0], 123); f.registered.set(LABELS[1], null);
  const result = await repairMacServiceRegistrations(f.opts);
  assert.deepEqual(result.repaired, [LABELS[1]]);
  assert.equal(f.calls.filter(x => x[1] === "kickstart").length, 1);
  assert.equal(f.calls.some(x => x.includes("-k") || x[1] === "bootout"), false);
});

test("the watchdog's stale-runtime restart retains both registrations even when the second restart fails", async t => {
  const f = fixture(t); for (const label of LABELS) f.registered.set(label, 123);
  const target = { active: true, packageRoot: f.packageRoot };
  write(path.join(f.homeDir, ".relay", "runtime", "current.json"), target);
  const result = await restartMacRegisteredServices(target, { ...f.opts,
    run: (cmd, args, options) => args[0] === "kickstart" && args.at(-1).endsWith(LABELS[1])
      ? { error: new Error("ETIMEDOUT") } : f.opts.run(cmd, args, options) });
  assert.equal(result.ok, false); assert.equal(f.registered.size, 2);
  assert.equal(f.calls.some(c => c[1] === "bootout"), false);
});

test("query timeouts and invalid executable targets never trigger blind bootstrap", async t => {
  const f = fixture(t);
  const timedOut = await repairMacServiceRegistrations({ ...f.opts, run: (cmd, args, options) => cmd === "/bin/launchctl" ? { error: new Error("ETIMEDOUT") } : f.opts.run(cmd, args, options) });
  assert.equal(timedOut.status, "service-repair-failed"); assert.equal(f.registered.size, 0);
  fs.rmSync(f.node);
  assert.equal((await repairMacServiceRegistrations(f.opts)).ok, false); assert.equal(f.registered.size, 0);
});

test("activation preflight and assertion failure preserve registrations before repair starts", async t => {
  const f = fixture(t), target = { packageRoot: "candidate" };
  const failure = await macActivationTransaction(target, () => assert.fail("must not mutate"), {
    homeDir: f.homeDir, run: () => ({ error: new Error("ETIMEDOUT") }),
    acquirePower: () => assert.fail("probe fails first") });
  assert.equal(failure.unchanged, true); assert.equal(readSnapshot({ homeDir: f.homeDir }), null);
  const noPower = await macActivationTransaction(target, () => assert.fail("must not mutate"), {
    homeDir: f.homeDir, run: () => ({ status: 0, stdout: "" }), acquirePower: () => { throw Error("no assertion"); } });
  assert.equal(noPower.unchanged, true); assert.equal(readSnapshot({ homeDir: f.homeDir }), null);
});

test("the real canonical activation entry refuses a ps timeout before repair-runtime rewrites anything", async t => {
  const f = fixture(t), calls = [];
  const result = await activateCanonicalRuntime({ packageRoot: f.packageRoot, node: f.node, bin: "candidate" }, {
    homeDir: f.homeDir, platform: "darwin", drain: async () => () => {},
    run: (cmd, args) => { calls.push([cmd, ...args]); return { error: new Error("ETIMEDOUT") }; },
    acquirePower: () => assert.fail("preflight failed") });
  assert.equal(result.unchanged, true);
  assert.deepEqual(calls.map(c => c[0]), ["/bin/ps"]);
  assert.equal(readSnapshot({ homeDir: f.homeDir }), null);
});

test("a real process death after a partial plist rewrite leaves an independently restorable snapshot", async t => {
  const f = fixture(t), file = [...f.plists.keys()][0];
  write(path.join(f.homeDir, ".relay", "runtime", "current.json"), { state: "recovery-required", active: false });
  const modulePath = new URL("../bootstrap/mac-registration-transaction.cjs", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  const code = `const fs=require('node:fs'); const m=require(${JSON.stringify(decodeURIComponent(modulePath))});
    m.prepareSnapshot({packageRoot:'candidate'}, {homeDir:${JSON.stringify(f.homeDir)},run:(_c,_a,o)=>({status:0,stdout:o.input})});
    fs.writeFileSync(${JSON.stringify(file)},'interrupted partial write'); process.exit(17);`;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(child.status, 17, child.stderr);
  const result = await repairMacServiceRegistrations(f.opts);
  assert.equal(result.ok, true, result.lastError); assert.deepEqual([...f.registered.keys()], LABELS);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).Label, LABELS[0]);
  assert.ok(readSnapshot({ homeDir: f.homeDir }), "snapshot remains until canonical commit");
  const repeated = await repairMacServiceRegistrations(f.opts);
  assert.equal(repeated.changed, false, "replay must not endlessly restart a restored runtime");
});

test("rollback retries a failed registration without unloading the service already restored", async t => {
  const f = fixture(t);
  prepareSnapshot({ packageRoot: "candidate" }, f.opts);
  let fail = true;
  const run = (cmd, args, options) => {
    if (fail && args[0] === "bootstrap" && args.at(-1).endsWith(`${LABELS[0]}.plist`)) return { error: new Error("ETIMEDOUT") };
    return f.opts.run(cmd, args, options);
  };
  const first = await restoreSnapshot({ ...f.opts, run });
  assert.equal(first.ok, false); assert.equal(f.registered.has(LABELS[1]), true);
  assert.ok(readSnapshot({ homeDir: f.homeDir }));
  fail = false;
  const second = await restoreSnapshot({ ...f.opts, run, expectedRoot: f.packageRoot });
  assert.equal(second.ok, true, second.lastError); assert.equal(f.registered.size, 2);
  assert.equal(f.calls.filter(c => c[1] === "bootstrap" && c.at(-1).endsWith(`${LABELS[1]}.plist`)).length, 1);
});

for (const damage of ["missing-node", "malformed-snapshot", "missing-plist"]) test(`verified recovery escapes ${damage} while retaining the original evidence`, async t => {
  const f = fixture(t);
  prepareSnapshot({ packageRoot: "failed-candidate" }, f.opts);
  const snapshotFile = path.join(f.homeDir, ".relay", "runtime", "mac-registrations.json");
  write(path.join(f.homeDir, ".relay", "runtime", "current.json"), { active: false, state: "recovery-required", previous: { packageRoot: f.packageRoot } });
  if (damage === "missing-node") fs.unlinkSync(f.node);
  if (damage === "malformed-snapshot") fs.writeFileSync(snapshotFile, "interrupted{");
  if (damage === "missing-plist") fs.unlinkSync([...f.plists.keys()][0]);
  const original = fs.readFileSync(snapshotFile, "utf8");
  assert.throws(() => prepareSnapshot({ packageRoot: "replacement" }, f.opts));
  assert.equal(fs.readFileSync(snapshotFile, "utf8"), original, "ordinary activation retains the backup");
  let activated = false;
  const result = await macActivationTransaction({ packageRoot: "replacement" }, async () => { activated = true; return { ok: true }; }, {
    ...f.opts, allowRebuildRegistrations: true,
    acquirePower: async () => () => {}, run: (cmd, args, opts) => cmd === "/bin/ps" ? { status: 0, stdout: "" } : f.opts.run(cmd, args, opts),
  });
  assert.equal(result.ok, true, result.reason); assert.equal(activated, true);
  const snapshot = readSnapshot({ homeDir: f.homeDir });
  assert.equal(snapshot.schema, 2);
  assert.equal(JSON.parse(fs.readFileSync(snapshot.evidence, "utf8")).files[snapshotFile], original);
  assert.equal((await restoreSnapshot(f.opts)).reason, "registration-snapshot-unusable");
});

test("replacement refuses to discard rollback evidence when archival fails", t => {
  const f = fixture(t);
  prepareSnapshot({ packageRoot: "failed-candidate" }, f.opts);
  fs.unlinkSync(f.node);
  const before = readSnapshot({ homeDir: f.homeDir });
  assert.throws(() => prepareSnapshot({ packageRoot: "replacement" }, { ...f.opts, allowRebuildRegistrations: true,
    fsImpl: { ...fs, openSync: () => { throw Error("disk-full"); } } }), /disk-full/);
  assert.deepEqual(readSnapshot({ homeDir: f.homeDir }), before);
});

test("a failed process query during rollback cleanup leaves both restored registrations intact", async t => {
  const f = fixture(t); prepareSnapshot({ packageRoot: "candidate" }, f.opts);
  const result = await restoreSnapshot({ ...f.opts, sleep: async () => {},
    healthCheck: async () => ({ ok: false, oldBroker: true }),
    run: (cmd, args, options) => cmd === "/bin/ps" ? { error: new Error("ETIMEDOUT") } : f.opts.run(cmd, args, options) });
  assert.equal(result.ok, false); assert.equal(f.registered.size, 2);
  assert.ok(readSnapshot({ homeDir: f.homeDir }));
});

test("rollback bypasses activation and retains the power assertion until restoration finishes", async t => {
  const f = fixture(t); prepareSnapshot({ packageRoot: "candidate" }, f.opts);
  let released = false;
  const result = await macActivationTransaction({ packageRoot: f.packageRoot }, () => assert.fail("rollback must not re-run activation"), {
    ...f.opts, restoreRegistrations: true, acquirePower: async () => () => { released = true; },
    healthCheck: async () => { assert.equal(released, false); return { ok: true }; } });
  assert.equal(result.ok, true, result.lastError); assert.equal(released, true);
});

for (const boundary of ["bootout", "bootstrap"]) for (const interruptedLabel of LABELS) {
  test(`interruption after ${boundary} of ${interruptedLabel} is replayable`, async t => {
    const f = fixture(t); prepareSnapshot({ packageRoot: "candidate" }, f.opts);
    for (const label of LABELS) {
      f.registered.set(label, 456);
      f.loaded.set(label, { ProgramArguments: ["/candidate/node", "/candidate/script"] });
    }
    let interrupted = false;
    const run = (cmd, args, options) => {
      const label = args.at(-1).split(/[\\/]/).at(-1).replace(/\.plist$/, "");
      let result;
      if (args[0] === "bootout") { f.registered.delete(label); f.loaded.delete(label); result = { status: 0 }; }
      else result = f.opts.run(cmd, args, options);
      if (!interrupted && args[0] === boundary && label === interruptedLabel) {
        interrupted = true; throw Error("injected interruption after OS mutation");
      }
      return result;
    };
    const first = await restoreSnapshot({ ...f.opts, run, sleep: async () => {} });
    assert.equal(first.ok, false); assert.equal(interrupted, true);
    const second = await restoreSnapshot({ ...f.opts, run, sleep: async () => {} });
    assert.equal(second.ok, true, second.lastError);
    assert.equal(f.registered.size, 2);
    assert.ok([...f.loaded.values()].every(p => p.ProgramArguments.includes(f.node)));
    const third = await restoreSnapshot({ ...f.opts, run });
    assert.equal(third.changed, false);
  });
}

test("forward activation captures before mutation, releases its assertion, and never mislabels a later failure unchanged", async t => {
  const f = fixture(t); let released = false;
  const result = await macActivationTransaction({ packageRoot: "candidate" }, async () => {
    assert.ok(readSnapshot({ homeDir: f.homeDir })); assert.equal(released, false);
    return { ok: false, reason: "service-process-query-failed", unchanged: true };
  }, { ...f.opts, run: (cmd, args, opts) => cmd === "/bin/ps" ? { status: 0, stdout: "" } : f.opts.run(cmd, args, opts),
    acquirePower: async () => () => { released = true; } });
  assert.equal(result.unchanged, false); assert.equal(released, true);
});

test("power assertion acquisition verifies the OS assertion and always releases its child", async () => {
  let kills = 0;
  const child = { pid: 99, once() {}, kill() { kills++; } };
  const spawnImpl = (command, args) => { assert.equal(command, "/usr/bin/caffeinate"); assert.deepEqual(args, ["-i", "-w", "12"]); return child; };
  const release = await acquireMacPowerAssertion({ spawnImpl, processId: 12, run: () => ({ status: 0, stdout: "pid 99(caffeinate) PreventUserIdleSystemSleep" }) });
  assert.equal(kills, 0); release(); release(); assert.equal(kills, 1);
  await assert.rejects(acquireMacPowerAssertion({ spawnImpl, processId: 12, run: () => ({ status: 0, stdout: "" }), sleep: async () => {} }), /assertion-unavailable/);
  assert.equal(kills, 2);
});
