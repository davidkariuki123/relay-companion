import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recover, write, read } from "../bootstrap/recovery-runner.cjs";
import { repairProgress } from "../bootstrap/recovery-progress.cjs";
import { validateLocalRuntime } from "../bootstrap/recovery-local.cjs";
import { verifyCanonicalTreeComplete } from "../bootstrap/runtime-tree.cjs";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-escalation-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  write(path.join(homeDir, ".relay", "config.json"), { updateChannel: "stable" });
  const pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  let clock = 100000;
  const options = { homeDir, env: {}, now: () => clock, sleep: async ms => { clock += ms; },
    health: () => ({ ok: false, daemonCount: 0 }), verifyReady: async () => ({ ok: false }),
    memory: () => ({ pressured: false }), discoverImpl: async () => "1.0.0",
    validateLocal: () => false, repairServices: async () => ({ ok: true, changed: false }),
  };
  return { homeDir, pointer, options, tick: () => { clock += 300000; } };
}

test("repeated accepted bootstraps with an inactive journal reach replacement on the second tick", async t => {
  const f = fixture(t); let staged = 0, repairs = 0;
  write(f.pointer, { active: false, state: "recovery-required" });
  const options = { ...f.options,
    repairServices: async () => { repairs++; return { ok: true, changed: true, status: "services-restored" }; },
    stage: async () => { staged++; throw Error("download-stop"); },
  };
  assert.equal((await recover(options)).status, "service-repair-unhealthy");
  f.tick(); assert.equal((await recover(options)).lastError, "download-stop");
  assert.equal(staged, 1); assert.equal(repairs, 2);
});

test("persistent failed snapshot replay cannot prevent a verified replacement attempt", async t => {
  const f = fixture(t); let staged = 0;
  write(f.pointer, { active: false, state: "recovery-required" });
  const options = { ...f.options,
    repairServices: async () => ({ ok: false, changed: true, blocked: true, reason: "missing-backup-node" }),
    stage: async () => { staged++; throw Error("replacement-reached"); },
  };
  await recover(options); f.tick(); await recover(options);
  assert.equal(staged, 1);
});

test("restart and reactivation budgets survive overwritten status and memory deferral", async t => {
  const f = fixture(t); let restarts = 0, runs = 0, staged = 0;
  const packageRoot = path.join(f.homeDir, "installed", "node_modules", "relay-companion");
  write(f.pointer, { active: true, version: "1.0.0", packageRoot });
  const options = { ...f.options, validateLocal: () => true,
    restart: async (_target, context) => { assert.equal(context.homeDir, f.homeDir); restarts++; return { ok: true }; },
    run: async () => { runs++; throw Error("reactivation-crash"); },
    memory: () => ({ pressured: true }),
    stage: async () => { staged++; throw Error("download-reached"); },
  };
  for (let i = 0; i < 4; i++) {
    await recover(options); f.tick();
    write(path.join(f.homeDir, ".relay", "recovery", "status.json"), { status: "unrelated-status" });
  }
  assert.equal(restarts, 2); assert.equal(runs, 1); assert.equal(staged, 0);
  // The same failed release is now shared-quarantined even after pressure clears.
  for (let i = 0; i < 6; i++) f.tick();
  await recover({ ...options, memory: () => ({ pressured: false }) });
  assert.equal(staged, 1); assert.equal(restarts, 2); assert.equal(runs, 1);
});

test("a validated previous local runtime can restore service while offline", async t => {
  const f = fixture(t), target = { active: true, version: "0.9.0", packageRoot: path.join(f.homeDir, "previous", "node_modules", "relay-companion") };
  write(f.pointer, { active: false, previous: target });
  let ran = false;
  const result = await recover({ ...f.options,
    discoverImpl: async () => { throw Error("offline"); },
    validateLocal: value => value.packageRoot === target.packageRoot,
    stage: () => assert.fail("local recovery must not need the network"),
    run: async (_node, entry, args) => { ran = true; assert.equal(entry, path.join(target.packageRoot, "src", "recovery-entry.js")); assert.deepEqual(args, ["0.9.0", "stable"]); write(f.pointer, target); },
    verifyReady: async () => ({ ok: ran, current: target }),
  });
  assert.equal(result.repair, "local"); assert.equal(result.runtimeHealthy, true);
  assert.equal(result.runtimeProven, false, "one successful start does not erase repair history");
  assert.equal(read(path.join(f.homeDir, ".relay", "recovery", "repair-progress.json")).attempts['local:' + target.packageRoot], 1);
});

test("reserving an attempt before worker death survives a new progress instance", t => {
  const f = fixture(t);
  assert.equal(repairProgress(f.homeDir).claim("restart:old", 1), true);
  assert.equal(repairProgress(f.homeDir).claim("restart:old", 1), false);
  const file = path.join(f.homeDir, ".relay", "recovery", "repair-progress.json");
  fs.writeFileSync(file, "broken{");
  assert.equal(repairProgress(f.homeDir).claim("restart:old", 1), false);
  const evidence = fs.readdirSync(path.dirname(file)).find(name => name.endsWith(".damaged"));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), evidence), "utf8"), "broken{");
});

test("unusable progress storage still permits minimal registration repair", async t => {
  const f = fixture(t); let repaired = false;
  fs.mkdirSync(path.join(f.homeDir, ".relay", "recovery", "repair-progress.json"), { recursive: true });
  const result = await recover({ ...f.options,
    repairServices: async () => { repaired = true; return { ok: true, changed: true }; },
    stage: () => assert.fail("unrecordable progress must not trigger a download"),
  });
  assert.equal(repaired, true); assert.equal(result.status, "repair-progress-unavailable");
  assert.equal(result.runtimeHealthy, false);
});

test("local selection refuses missing executables and incomplete dependency manifests without imports", t => {
  const f = fixture(t), packageRoot = path.join(f.homeDir, "local", "node_modules", "relay-companion");
  write(path.join(packageRoot, "package.json"), { name: "relay-companion", version: "1.0.0", dependencies: { absent: "1.0.0" } });
  assert.equal(validateLocalRuntime({ packageRoot, version: "1.0.0" }), false);
  assert.equal(verifyCanonicalTreeComplete(packageRoot).ok, false);
  fs.mkdirSync(path.join(packageRoot, "node_modules", "absent"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "node_modules", "absent", "package.json"), "{");
  assert.equal(verifyCanonicalTreeComplete(packageRoot).ok, false);
});
