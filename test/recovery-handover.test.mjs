import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import schedule from "../bootstrap/recovery-schedule-handover.cjs";
import io from "../bootstrap/recovery-launcher.cjs";
import intent from "../bootstrap/recovery-intent.cjs";
import { model } from "./helpers/handover-model.cjs";
function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handover-fault-"));
  t.after(() => { assert.equal(path.dirname(homeDir), os.tmpdir()); fs.rmSync(homeDir, { recursive: true, force: true }); });
  const m = model(homeDir);
  return { ...m, homeDir, handover: options => schedule.handover({homeDir, userId: 123, attempts: 1, sleep: async () => {}, report() {}, run: m.run, ...options}) };
}
const xmlPlan = (target, homeDir) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${target.Label}</string><key>ProgramArguments</key><array>${target.ProgramArguments.map(arg => `<string>${arg}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${homeDir}</string></dict><key>StartInterval</key><integer>${target.StartInterval}</integer></dict></plist>`;
test("failed cleanup cannot repeat a completed schedule change or mark recovery unhealthy", async t => {
  const f = fixture(t); f.save({...f.read(), removeFailure: true});
  for (let i = 0; i < 3; i++) {
    const result = await f.handover();
    assert.equal(result.ok, true);
    assert.equal(result.cleanup.pending, true);
    assert.equal(result.cleanup.reason, "remove-failed");
  }
  assert.equal(f.mutations().filter(x => x === "bootout").length, 1);
  assert.equal(f.mutations().filter(x => x === "bootstrap").length, 1);
});
test("loaded desired schedule is authoritative when completion record is missing or corrupt", async t => {
  const f = fixture(t); f.save({...f.read(), loaded: f.plan(60)});
  fs.writeFileSync(path.join(f.root, "scheduler.json"), "broken");
  assert.equal((await f.handover()).ok, true);
  assert.deepEqual(f.mutations(), ["remove"]);
});
test("confirmed missing schedule is bootstrapped without trying to unload it", async t => {
  const f = fixture(t); f.save({...f.read(), loaded: null});
  assert.equal((await f.handover()).ok, true);
  assert.deepEqual(f.mutations(), ["bootstrap", "remove"]);
});
test("a missing rollback plist is rebuilt from the observed loaded cadence before unload", async t => {
  const f = fixture(t), target = f.plan(60);
  fs.writeFileSync(f.plist, xmlPlan(target, f.homeDir));
  const previous = path.join(f.root, "scheduler-previous.plist");
  fs.rmSync(previous);
  const result = await f.handover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(fs.readFileSync(previous, "utf8"), /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.equal(f.read().loaded.StartInterval, 60);
  assert.deepEqual(f.mutations(), ["bootout", "bootstrap", "remove"]);
});
test("a synthesized rollback restores the old schedule after failed registration", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.plist, xmlPlan(f.plan(60), f.homeDir));
  fs.rmSync(path.join(f.root, "scheduler-previous.plist"));
  f.save({...f.read(), bootstrapFailures: 1});
  const result = await f.handover();
  assert.equal(result.recoveryAvailable, true, JSON.stringify(result));
  assert.equal(f.read().loaded.StartInterval, 300);
  assert.deepEqual(f.mutations().filter(x => x !== "remove"), ["bootout", "bootstrap", "bootstrap"]);
});
test("an unknown loaded interpreter cannot synthesize a rollback or unload", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.plist, xmlPlan(f.plan(60), f.homeDir));
  const previous = path.join(f.root, "scheduler-previous.plist");
  fs.rmSync(previous);
  f.save({...f.read(), loaded: {...f.plan(300), ProgramArguments: ["/unrecognized/node", f.plan(300).ProgramArguments[1]]}});
  const result = await f.handover();
  assert.equal(result.reason, "recovery-schedule-target-unknown");
  assert.equal(fs.existsSync(previous), false);
  assert.deepEqual(f.mutations(), []);
});
test("unknown registration leaves the independent handover registered and does not mutate", async t => {
  const f = fixture(t); f.save({...f.read(), queryUnknown: true});
  const result = await f.handover();
  assert.equal(result.ok, false);
  assert.equal(f.read().job, true);
  assert.deepEqual(f.mutations(), []);
});
test("failed bootstrap restores old schedule; failed cleanup cannot repeat that attempt", async t => {
  const f = fixture(t); f.save({...f.read(), bootstrapFailures: 1, removeFailure: true});
  const result = await f.handover();
  assert.equal(result.ok, false);
  assert.equal(result.recoveryAvailable, true);
  assert.equal(f.read().loaded.StartInterval, 300);
  await f.handover();
  assert.equal(f.mutations().filter(x => x === "bootout").length, 1);
  assert.equal(f.mutations().filter(x => x === "bootstrap").length, 2);
});
test("when both bootstraps fail the handover remains independently runnable", async t => {
  const f = fixture(t); f.save({...f.read(), bootstrapFailures: 2});
  assert.equal((await f.handover()).ok, false);
  assert.equal(f.read().job, true);
  assert.equal(f.read().loaded, null);
  assert.ok(!f.mutations().includes("remove"));
  const next = await f.handover();
  assert.equal(next.recoveryAvailable, true);
  assert.equal(f.read().loaded.StartInterval, 300);
  assert.equal(f.mutations().filter(x => x === "bootout").length, 1);
});
for (const checkpoint of ["before-bootout", "bootout", "bootstrap"]) test(`process death at ${checkpoint} resumes without repeating unload`, async t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/handover-model.cjs", import.meta.url)), f.homeDir, checkpoint], {encoding: "utf8", timeout: 20_000, windowsHide: true});
  assert.equal(child.status, 86, child.stderr);
  assert.equal(f.read().job, true);
  const result = await f.handover();
  assert.equal(result.ok, true);
  assert.equal(f.mutations().filter(x => x === "bootout").length, checkpoint === "before-bootout" ? 2 : 1, "before-bootout records an attempted call but exits before changing the simulated OS");
  assert.equal(f.mutations().filter(x => x === "bootstrap").length, 1);
});
test("self-removal process death leaves a working schedule and reclaimable locks", t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/handover-model.cjs", import.meta.url)), f.homeDir, "remove"], {encoding: "utf8", timeout: 20_000, windowsHide: true});
  assert.equal(child.status, 86, child.stderr);
  assert.equal(f.read().job, false);
  assert.equal(f.read().loaded.StartInterval, 60);
  assert.equal(io.read(path.join(f.root, "scheduler-handover-status.json")).cleanup.pending, true, "worker never claimed to survive its removal");
  const release = io.acquireLauncherLock(f.root);
  assert.equal(typeof release, "function"); release();
  for (const file of [path.join(f.root, "run.lock"), path.join(f.homeDir, ".relay", "runtime", "transaction.lock")]) io.acquireCanonicalLock(file).release();
});
test("a failed command result cannot roll back registration that actually succeeded", async t => {
  const f = fixture(t);
  const run = (file, args, options) => {
    const result = f.run(file, args, options);
    return args[0] === "bootstrap" ? {status: 1, stderr: "lost reply"} : result;
  };
  assert.equal((await f.handover({run})).ok, true);
  assert.deepEqual(f.mutations(), ["bootout", "bootstrap", "remove"]);
});
test("lock contention does not retire the only pending handover", async t => {
  const f = fixture(t), release = io.acquireLauncherLock(f.root);
  try {
    assert.equal((await f.handover()).ok, false);
    assert.deepEqual(f.mutations(), []);
    assert.equal(f.read().job, true);
  } finally { release(); }
});
test("a worker cannot remove a job now owned by another process", async t => {
  const f = fixture(t); f.save({...f.read(), loaded: f.plan(60), pid: process.pid + 999});
  const result = await f.handover();
  assert.equal(result.ok, false);
  assert.equal(result.cleanup.pending, true);
  assert.deepEqual(f.mutations(), []);
});
test("cleanup executes while mutation locks are held and reporting precedes removal", async t => {
  const f = fixture(t); let reported = false;
  const run = model(f.homeDir, { before(args) {
    if (args[0] === "remove") {
      assert.equal(reported, true);
      for (const file of [path.join(f.root, "launcher.lock"), path.join(f.root, "run.lock"), path.join(f.homeDir, ".relay", "runtime", "transaction.lock")]) assert.equal(fs.existsSync(file), true);
    }
  }}).run;
  assert.equal((await f.handover({run, report() { reported = true; }})).ok, true);
  assert.equal(fs.existsSync(path.join(f.root, "launcher.lock")), false);
});

test("intentional Quit never bootstraps an absent recovery schedule", async t => {
  const f = fixture(t); f.save({...f.read(), loaded: null});
  intent.setStopped(true, f.homeDir);
  assert.equal((await f.handover()).reason, "intentionally-stopped");
  assert.deepEqual(f.mutations(), ["remove"]);
});
test("Quit arriving after unload is respected before registration", async t => {
  const f = fixture(t);
  const run = (file, args, options) => {
    const result = f.run(file, args, options);
    if (args[0] === "bootout") intent.setStopped(true, f.homeDir);
    return result;
  };
  assert.equal((await f.handover({run})).reason, "intentionally-stopped");
  assert.deepEqual(f.mutations(), ["bootout", "remove"]);
});
test("an invalid target or stale fallback never authorizes unloading the old registration", async t => {
  for (const bad of ["target", "fallback"]) {
    const f = fixture(t);
    fs.writeFileSync(bad === "target" ? f.plist : path.join(f.root, "scheduler-previous.plist"), bad === "target" ? "invalid" : JSON.stringify(f.plan(60)));
    assert.equal((await f.handover()).ok, false);
    assert.deepEqual(f.mutations(), []);
    assert.equal(f.read().job, true);
  }
});
test("unknown cleanup queries cannot delete a worker or claim it absent", t => {
  const f = fixture(t); f.save({...f.read(), jobQueryUnknown: true});
  const result = schedule.retireIdleHandover({run: f.run});
  assert.equal(result.reason, "query-unknown");
  assert.equal(result.pending, true);
  assert.deepEqual(f.mutations(), []);
});
test("external retirement respects an installer's transaction ownership", t => {
  const f = fixture(t);
  io.write(path.join(f.root, "scheduler.json"), {intervalSeconds: 60});
  const lock = io.acquireCanonicalLock(path.join(f.homeDir, ".relay", "runtime", "transaction.lock"));
  try {
    const result = schedule.retireFinishedHandover({homeDir: f.homeDir, userId: 123, run: () => assert.fail("must defer before OS inspection")});
    assert.equal(result.reason, "update-owner");
  } finally { lock.release(); }
});
test("successful bootstrap with an uncertain follow-up query retains the worker without rollback", async t => {
  const f = fixture(t);
  const run = (file, args, options) => {
    const result = f.run(file, args, options);
    if (args[0] === "bootstrap") f.save({...f.read(), queryUnknown: true});
    return result;
  };
  assert.equal((await f.handover({run})).ok, false);
  assert.equal(f.read().job, true);
  assert.deepEqual(f.mutations(), ["bootout", "bootstrap"]);
  f.save({...f.read(), queryUnknown: false});
  assert.equal((await f.handover()).ok, true);
  assert.deepEqual(f.mutations(), ["bootout", "bootstrap", "remove"]);
});
