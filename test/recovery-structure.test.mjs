import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { recover, write, read, STALE_CONFIRM_MS } = require("../bootstrap/recovery-runner.cjs");
const { exactRuntimeHealth, restoreMissingPill } = require("../bootstrap/runtime-health.cjs");
const { repairProgress } = require("../bootstrap/recovery-progress.cjs");
const { setStopped } = require("../bootstrap/recovery-intent.cjs");
const { beginCall } = require("../bootstrap/update-activity.cjs");
const { createOutbox } = require("../src/outbox.cjs");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-structure-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const root = path.join(homeDir, ".relay"), packageRoot = path.join(root, "runtime", "releases", "one", "node_modules", "relay-companion");
  const target = { active: true, packageRoot, version: "1.0.0", bin: path.join(packageRoot, "bin", "relay.js") };
  write(path.join(root, "config.json"), { updateChannel: "dev" });
  write(path.join(root, "runtime", "current.json"), target);
  let clock = 100000;
  const beat = (pid = 123) => write(path.join(root, "recovery", "daemon.json"), { version: target.version, at: clock, pid });
  beat();
  const options = { homeDir, platform: "win32", env: {}, now: () => clock,
    repairServices: async () => ({ ok: true, changed: false }), memory: () => ({ pressured: false }),
    discoverImpl: () => assert.fail("unhealthy local service must not wait for network"),
    stage: () => assert.fail("must not download"), restart: () => assert.fail("must not restart daemon"),
    verifyReady: async () => ({ ok: false }),
  };
  return { homeDir, root, target, options, beat, tick: ms => { clock += ms; }, now: () => clock };
}
const missingPill = { ok: false, known: true, daemon: true, daemonCount: 1, pill: false, pillCount: 0 };

test("failed process inspection is unknown, while a successful empty query proves absence", () => {
  const target = { packageRoot: "C:\\node_modules\\relay-companion", bin: "C:\\node_modules\\relay-companion\\bin\\relay.js" };
  for (const run of [() => ({ status: 1 }), () => { throw Error("timeout"); }]) {
    const result = exactRuntimeHealth(target, { platform: "win32", run });
    assert.equal(result.known, false); assert.equal(result.daemonCount, undefined);
  }
  const absent = exactRuntimeHealth(target, { platform: "win32", run: () => ({ status: 0, stdout: "" }) });
  assert.equal(absent.known, true); assert.equal(absent.daemonCount, 0);
});

test("unknown observation cannot spend restart budget or quarantine a release", async t => {
  const f = fixture(t);
  const result = await recover({ ...f.options, health: () => ({ known: false, reason: "service-process-query-failed" }) });
  assert.equal(result.status, "observation-unavailable");
  assert.equal(repairProgress(f.homeDir).count(`restart:${f.target.packageRoot}`), 0);
  assert.equal(fs.existsSync(path.join(f.root, "recovery", "release-health")), false);
});

test("missing pill is restored while daemon work stays admitted and protected", async t => {
  const f = fixture(t); const release = beginCall({ homeDir: f.homeDir }); t.after(release);
  let restored = false;
  const result = await recover({ ...f.options, health: () => missingPill,
    restorePill: async target => { assert.equal(target.packageRoot, f.target.packageRoot); restored = true; return { ok: true }; },
    verifyReady: async () => ({ ok: restored, current: f.target }),
  });
  assert.equal(result.repair, "pill"); assert.equal(result.runtimeAvailable, true);
});

for (const platform of ["win32", "linux"]) test(`${platform}: missing-pill repair uses only idempotent service start and resumes without duplication`, async t => {
  const f = fixture(t); let running = false; const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("/Run") || args.includes("start")) running = true;
    return { status: 0, stdout: `${path.join(f.target.packageRoot, "overlay", "main.cjs")}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>` };
  };
  const options = { homeDir: f.homeDir, platform, run, healthCheck: () => running ? { ok: true, known: true } : missingPill };
  assert.equal((await restoreMissingPill(f.target, options)).changed, true);
  // Simulate loss of the caller's success receipt, then enter a fresh operation.
  assert.equal((await restoreMissingPill(f.target, options)).changed, false);
  assert.equal(calls.filter(call => call.includes("/Run") || call.includes("start")).length, 1);
  assert.equal(calls.some(call => /kill|stop|restart|Daemon/.test(call.join(" "))), false);
});

test("quit arriving during pill inspection prevents the pending start", async t => {
  const f = fixture(t);
  const result = await restoreMissingPill(f.target, { homeDir: f.homeDir, platform: "win32", healthCheck: () => missingPill,
    run: (_command, args) => {
      assert.ok(args.includes("/Query")); setStopped(true, f.homeDir);
      return { status: 0, stdout: `${path.join(f.target.packageRoot, "overlay", "main.cjs")}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>` };
    },
  });
  assert.equal(result.reason, "intentionally-stopped"); assert.equal(result.deferred, true);
});

test("Windows follows the stock hidden launcher only when it targets this installation", async t => {
  const f = fixture(t), launcher = path.join(f.root, "relay-companion-pill.vbs"); let starts = 0;
  const options = { homeDir: f.homeDir, platform: "win32", healthCheck: () => missingPill,
    run: (_command, args) => {
      if (args.includes("/Run")) starts++;
      return { status: 0, stdout: `<Arguments>${launcher}</Arguments><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>` };
    },
  };
  fs.writeFileSync(launcher, `shell.Run "${path.join(f.target.packageRoot, "overlay", "main.cjs")}"`);
  assert.equal((await restoreMissingPill(f.target, options)).ok, true);
  fs.writeFileSync(launcher, 'shell.Run "some other installation"');
  assert.equal((await restoreMissingPill(f.target, options)).reason, "service-target-unverified");
  assert.equal(starts, 1);
});

test("an update owning the installation excludes pill repair without touching any service", async t => {
  const f = fixture(t);
  const owner = require("../bootstrap/lifecycle-ownership.cjs").lifecycleOwnership({ homeDir: f.homeDir });
  try {
    const result = await restoreMissingPill(f.target, { homeDir: f.homeDir, run: () => assert.fail("owner must exclude commands") });
    assert.equal(result.reason, "deferred-update-owner");
  } finally { owner.release(); }
});

test("slow failed readiness contributes observation time instead of starting a fresh confirmation wait", async t => {
  const f = fixture(t); let restarted = false;
  const result = await recover({ ...f.options, health: () => ({ ok: true, known: true, daemonCount: 1, pillCount: 1 }),
    verifyReady: async () => { f.tick(STALE_CONFIRM_MS + 1000); return { ok: false }; },
    restart: async () => { restarted = true; return { ok: false, reason: "test-stop" }; },
  });
  assert.equal(result.status, "restart-failed"); assert.equal(restarted, true);
  assert.equal(result.staleSince, 100000);
});

test("a delayed OS process query cannot supply the application's hang-confirmation evidence", async t => {
  const f = fixture(t);
  const result = await recover({ ...f.options,
    health: () => { f.tick(STALE_CONFIRM_MS + 1000); return { ok: false, known: true, daemonCount: 1, pillCount: 1 }; },
  });
  assert.equal(result.status, "stale-observed"); assert.equal(result.staleSince, f.now());
});

test("durable observation survives status replacement but resets for a new process or an unwatched interval", t => {
  const f = fixture(t), gapMs = 120000;
  assert.equal(repairProgress(f.homeDir, f.now).observe("root:process1", { gapMs }), 100000);
  f.tick(60000); write(path.join(f.root, "recovery", "status.json"), { status: "deferred" });
  assert.equal(repairProgress(f.homeDir, f.now).observe("root:process1", { gapMs }), 100000);
  assert.equal(repairProgress(f.homeDir, f.now).observe("root:process2", { gapMs }), 160000);
  f.tick(gapMs + 1);
  assert.equal(repairProgress(f.homeDir, f.now).observe("root:process2", { gapMs }), f.now());
  f.tick(-5000);
  assert.equal(repairProgress(f.homeDir, f.now).observe("root:process2", { gapMs }), f.now());
});

test("interrupted or unavailable readiness cannot become evidence authorizing a restart", async t => {
  const f = fixture(t);
  const result = await recover({ ...f.options, health: () => ({ ok: true, known: true }),
    verifyReady: async () => { f.tick(100000); return { ok: false, observationInvalid: true }; },
  });
  assert.equal(result.status, "observation-unavailable");
  assert.equal(read(path.join(f.root, "recovery", "repair-progress.json")).observation, undefined);
});

test("process death after remote acceptance preserves the same send identity on recovery", async t => {
  const f = fixture(t), file = path.join(f.homeDir, "outbox.json"), accepted = path.join(f.homeDir, "accepted.json");
  const modulePath = fileURLToPath(new URL("../src/outbox.cjs", import.meta.url));
  const script = `const fs=require('node:fs'); const {createOutbox}=require(${JSON.stringify(modulePath)});
    const q=createOutbox({file:${JSON.stringify(file)},scheduleTimer:()=>null,send:async entry=>{
      fs.writeFileSync(${JSON.stringify(accepted)},JSON.stringify({key:entry.idempotencyKey,relayId:'accepted-once'})); process.exit(23);
    }});q.enqueue({idempotencyKey:'durable-key',text:'retained message',recipient:{self:true}});q.flush();`;
  const child = spawnSync(process.execPath, ["-e", script], { windowsHide: true, timeout: 15000, encoding: "utf8" });
  assert.equal(child.status, 23, child.stderr);
  const receipt = read(accepted); let sends = 0;
  const resumed = createOutbox({ file, scheduleTimer: () => null, send: async entry => {
    sends++; assert.equal(entry.idempotencyKey, receipt.key); assert.equal(entry.text, "retained message");
    return { relayId: receipt.relayId };
  } });
  await resumed.flush();
  assert.equal(sends, 1); assert.equal(resumed.list()[0].relayId, "accepted-once");
  await createOutbox({ file, scheduleTimer: () => null, send: () => assert.fail("accepted receipt must suppress another send") }).flush();
});
