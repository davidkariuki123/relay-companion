// Native fault injection into an unmodified published Companion. Only the
// disposable runner's scheduler state and test-owned driver files are changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || process.platform !== "darwin") {
  throw Error("Handover fault injection requires a disposable macOS GitHub runner");
}
const require = createRequire(import.meta.url);
const homeDir = os.homedir(), root = path.join(homeDir, ".relay"), recovery = path.join(root, "recovery");
const label = "work.relay.companion.recovery", job = "work.relay.recovery.schedule-handover";
const domain = `gui/${process.getuid()}`;
const current = JSON.parse(fs.readFileSync(path.join(root, "runtime", "current.json"), "utf8"));
assert.equal(current.active, true);
assert.ok(path.resolve(current.packageRoot).startsWith(path.join(root, "runtime", "releases") + path.sep));
const io = require(path.join(current.packageRoot, "bootstrap", "recovery-launcher.cjs"));
const { atomicFile } = require(path.join(current.packageRoot, "bootstrap", "mac-registration-transaction.cjs"));
const schedule = require(path.join(current.packageRoot, "bootstrap", "recovery-schedule-handover.cjs"));
const command = (file, args, options = {}) => spawnSync(file, args, {encoding: "utf8", timeout: 15_000, ...options});
const launchctl = args => command("/bin/launchctl", args);
const success = r => !r.error && r.status === 0;
const absent = r => !r.error && (r.status === 113 || /Could not find (?:specified )?service/i.test(r.stderr || ""));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureBase = path.join(process.env.RUNNER_TEMP, "relay-handover-native");
fs.mkdirSync(fixtureBase, {recursive: true});

if (process.argv[2] === "--child") {
  const fixture = path.resolve(process.argv[3]);
  assert.equal(path.dirname(fixture), fixtureBase);
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "mode.json"), "utf8"));
  assert.equal(current.packageRoot, config.packageRoot);
  const mode = config.mode;
  const event = value => fs.appendFileSync(path.join(fixture, "events.jsonl"), JSON.stringify({pid: process.pid, ...value}) + "\n");
  event({event: "start"});
  await schedule.handover({homeDir, userId: process.getuid(), report: result => event({event: "result", result}),
    run(file, args, options) {
      if (file.endsWith("launchctl") && ["bootout", "bootstrap", "remove"].includes(args[0])) event({event: args[0]});
      if (file.endsWith("launchctl") && args[0] === "remove" && mode === "refuse-removal") return {status: 1, stderr: "injected removal refusal"};
      if (file.endsWith("launchctl") && args[0] === "bootstrap" && mode === "failed-rollback") {
        const marker = path.join(fixture, "failed-registrations");
        const failures = Number(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : 0);
        if (failures < 2) {
          fs.writeFileSync(marker, String(failures + 1));
          event({event: "registration-refused", attempt: failures + 1});
          return {status: 1, stderr: "injected registration refusal"};
        }
      }
      const result = command(file, args, options);
      const crash = path.join(fixture, "crashed");
      if (file.endsWith("launchctl") && args[0] === mode && success(result) && !fs.existsSync(crash)) {
        fs.writeFileSync(crash, "once");
        // No app observer may rescue the worker after this interruption.
        for (const app of ["work.relay.companion", "work.relay.companion.pill"]) {
          const stopped = launchctl(["bootout", `${domain}/${app}`]);
          assert.ok(success(stopped) || absent(stopped), stopped.stderr);
        }
        event({event: "crash", checkpoint: mode});
        process.exit(86);
      }
      return result;
    }});
} else {
  assert.equal(current.version, process.argv[2]);
  const { activeCalls } = require(path.join(current.packageRoot, "bootstrap", "update-activity.cjs"));
  assert.equal(activeCalls({homeDir}), 0);
  const { waitForRecoveryReady } = require(path.join(current.packageRoot, "bootstrap", "recovery-readiness.cjs"));
  const initiallyReady = await waitForRecoveryReady({homeDir, target: current, timeoutMs: 90_000, requireProgress: true});
  assert.equal(initiallyReady.ok, true, JSON.stringify(initiallyReady));
  const plist = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const original = fs.readFileSync(plist, "utf8");
  assert.match(original, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  const older = original.replace(/(<key>StartInterval<\/key>\s*<integer>)60(<\/integer>)/, (_match, start, end) => `${start}300${end}`);
  const host = JSON.parse(fs.readFileSync(path.join(recovery, "launcher-node.json"), "utf8")).node;
  const observed = () => {
    const result = launchctl(["print", `${domain}/${label}`]);
    return {ok: success(result), interval: Number(/run interval = (\d+) seconds/.exec(result.stdout || "")?.[1])};
  };
  async function until(check, description, timeout = 180_000) {
    const deadline = Date.now() + timeout;
    do { if (check()) return; await sleep(500); } while (Date.now() < deadline);
    throw Error(`Native handover did not reach ${description}`);
  }
  async function own() {
    let result;
    await until(() => {
      const release = io.acquireLauncherLock(recovery);
      if (!release) return false;
      let runner, transaction;
      try {
        runner = io.acquireCanonicalLock(path.join(recovery, "run.lock"));
        transaction = io.acquireCanonicalLock(path.join(root, "runtime", "transaction.lock"));
        result = () => { transaction.release(); runner.release(); release(); };
        return true;
      } catch { transaction?.release(); runner?.release(); release(); return false; }
    }, "exclusive handover preparation");
    return result;
  }
  const reports = [];
  let touchedSchedule = false, testFixture = null;
  const testJobPresent = () => {
    const result = launchctl(["list", job]);
    return success(result) && testFixture && result.stdout.includes(testFixture)
      && result.stdout.includes(fileURLToPath(import.meta.url));
  };
  try {
    // If the upgrade left an old looping job behind, the stock controller must
    // retire it. Do not silently remove it to make the test setup succeed.
    await until(() => absent(launchctl(["list", job])), "legacy handover retirement");
    for (const mode of ["refuse-removal", "bootout", "bootstrap", "failed-rollback"]) {
      const fixture = fs.mkdtempSync(path.join(fixtureBase, `${mode}-`));
      fs.writeFileSync(path.join(fixture, "mode.json"), JSON.stringify({mode, packageRoot: current.packageRoot}));
      const events = () => {
        try { return fs.readFileSync(path.join(fixture, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
        catch { return []; }
      };
      const release = await own();
      try {
        assert.ok(absent(launchctl(["list", job])), "another handover owns the job");
        touchedSchedule = true;
        const removed = launchctl(["bootout", `${domain}/${label}`]);
        assert.ok(success(removed) || absent(removed), removed.stderr);
        atomicFile(plist, older);
        assert.ok(success(launchctl(["bootstrap", domain, plist])));
        assert.equal(observed().interval, 300);
        atomicFile(path.join(recovery, "scheduler-previous.plist"), older);
        atomicFile(plist, original);
        const result = launchctl(["submit", "-l", job, "-o", path.join(fixture, "worker.log"), "-e", path.join(fixture, "worker.log"), "--",
          "/usr/bin/env", "GITHUB_ACTIONS=true", `RUNNER_TEMP=${process.env.RUNNER_TEMP}`,
          host, fileURLToPath(import.meta.url), "--child", fixture]);
        assert.ok(success(result), result.stderr);
        testFixture = fixture;
      } finally { release(); }
      if (mode === "refuse-removal") {
        await until(() => {
          const failures = events().filter(e => e.event === "result" && e.result.cleanup?.reason === "remove-failed").length;
          return failures >= 2 || (failures >= 1 && absent(launchctl(["list", job])));
        }, "repeated cleanup refusal or stock observer retirement");
        if (testJobPresent()) assert.ok(success(launchctl(["remove", job])), "remove this test-owned worker");
      }
      await until(() => absent(launchctl(["list", job])), "worker retirement");
      const steps = events();
      assert.equal(steps.filter(e => e.event === "bootout").length, 1, JSON.stringify(steps));
      assert.equal(steps.filter(e => e.event === "bootstrap").length, mode === "failed-rollback" ? 3 : 1, JSON.stringify(steps));
      if (["bootout", "bootstrap"].includes(mode)) assert.equal(steps.filter(e => e.event === "crash").length, 1);
      if (mode === "failed-rollback") {
        assert.equal(steps.filter(e => e.event === "registration-refused").length, 2, JSON.stringify(steps));
        assert.ok(steps.filter(e => e.event === "start").length >= 2, "launchd must retry the independent worker");
        assert.equal(observed().interval, 300, "the stock worker must restore the old registration after both refusals");
        const install = require(path.join(current.packageRoot, "bootstrap", "recovery-install.cjs"));
        const repaired = install.installRecovery({packageRoot: current.packageRoot, node: current.node, homeDir, userId: process.getuid()});
        assert.equal(repaired.ok, true, JSON.stringify(repaired));
        await until(() => observed().interval === 60 && absent(launchctl(["list", job])), "stock repair after failed rollback");
      }
      assert.equal(observed().interval, 60);
      const ready = await waitForRecoveryReady({homeDir, target: current, timeoutMs: 180_000, requireProgress: true});
      assert.equal(ready.ok, true, JSON.stringify(ready));
      reports.push({mode, passed: true, starts: steps.filter(e => e.event === "start").length, steps});
      fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "relay-handover-native.json"), JSON.stringify({version: current.version, arch: process.arch, reports}, null, 2));
    }
  } finally {
    // Disposable runner only. Restore its original schedule so ordinary canary
    // cleanup remains usable even after a failing fault assertion.
    if (testJobPresent()) launchctl(["remove", job]);
    if (touchedSchedule) {
      const release = await own();
      try {
        const removed = launchctl(["bootout", `${domain}/${label}`]);
        assert.ok(success(removed) || absent(removed), removed.stderr);
        atomicFile(plist, original);
        assert.ok(success(launchctl(["bootstrap", domain, plist])));
      } finally { release(); }
    }
  }
  console.log(JSON.stringify({version: current.version, nativeHandover: reports.map(({mode, passed}) => ({mode, passed}))}));
}
