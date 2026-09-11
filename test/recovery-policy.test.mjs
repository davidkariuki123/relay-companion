import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoveryPolicy, PROBATION_MS, RELEASE_COOLDOWN_MS, EMERGENCY_RETRY_MS } from "../bootstrap/recovery-policy.cjs";
import { recover, read, write } from "../bootstrap/recovery-runner.cjs";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-")), root = path.join(homeDir, ".relay", "recovery");
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let clock = 100000;
  const now = () => clock, advance = ms => { clock += ms; };
  const policy = recoveryPolicy({ root, now });
  write(path.join(homeDir, ".relay", "config.json"), { updateChannel: "stable" });
  const pointer = path.join(homeDir, ".relay", "runtime", "current.json");
  const current = { active: true, version: "1.0.0", packageRoot: path.join(homeDir, "old", "node_modules", "relay-companion") };
  const observed = { ok: true, current, identity: "daemon-1:pill-1" };
  const options = { homeDir, env: {}, now, sleep: async () => {}, policyFactory: () => policy,
    discoverImpl: async () => "2.0.0", memory: () => ({ pressured: true }), repairServices: async () => ({ ok: true }),
    health: () => ({ ok: false, daemonCount: 0 }), validateLocal: () => false, verifyReady: async () => ({ ok: false }),
  };
  return { homeDir, root, now, advance, policy, pointer, current, observed, options };
}

test("dead Relay gets a bounded emergency download despite sustained memory pressure", async t => {
  const f = fixture(t); let downloads = 0;
  const options = { ...f.options, stage: async () => { downloads++; throw Error("offline"); } };
  assert.equal((await recover(options)).lastError, "offline"); assert.equal(downloads, 1);
  f.advance(5 * 60000);
  write(path.join(f.root, "status.json"), { status: "other-status" });
  assert.equal((await recover(options)).status, "emergency-backoff"); assert.equal(downloads, 1);
  f.advance(EMERGENCY_RETRY_MS);
  await recover(options); assert.equal(downloads, 2);
});

test("healthy Relay still defers an ordinary upgrade under memory pressure", async t => {
  const f = fixture(t);
  write(f.pointer, f.current);
  for (let i = 0; i <= 3; i++) { f.policy.observe("stable", f.observed); if (i < 3) f.advance(5 * 60000); }
  write(path.join(f.root, "daemon.json"), { version: "1.0.0", at: f.now() });
  const result = await recover({ ...f.options, health: () => ({ ok: true }), verifyReady: async () => f.observed,
    stage: () => assert.fail("a working installation must retain its memory gate") });
  assert.equal(result.status, "deferred-memory-pressure");
});

test("rollback does not immediately re-offer the failed release; a newer fix remains eligible", async t => {
  const f = fixture(t); let desired = "2.0.0", downloaded = null;
  write(f.pointer, { active: false, previous: f.current, candidate: { version: desired, packageRoot: "failed-candidate" } });
  const options = { ...f.options, memory: () => ({ pressured: false }), discoverImpl: async () => desired,
    validateLocal: target => target.version === "1.0.0", health: () => ({ ok: true }), verifyReady: async () => f.observed,
    run: async () => { write(f.pointer, f.current); }, stage: async ({ version }) => { downloaded = version; throw Error("download-reached"); },
  };
  assert.equal((await recover(options)).repair, "local");
  for (let i = 0; i < 3; i++) {
    f.advance(5 * 60000); write(path.join(f.root, "daemon.json"), { version: "1.0.0", at: f.now() });
    const result = await recover(options);
    assert.equal(result.status, i < 2 ? "probation" : "deferred-release-cooldown");
  }
  assert.equal(downloaded, null);
  desired = "2.0.1";
  assert.equal((await recover(options)).lastError, "download-reached"); assert.equal(downloaded, "2.0.1");
});

test("crash/reboot or missed observations restart probation and cannot erase failed-release history", t => {
  const f = fixture(t);
  f.policy.failure("stable", "1.0.0", { id: "failed-install" });
  f.policy.failure("stable", "2.0.0", { id: "another-failed-install" });
  assert.equal(f.policy.observe("stable", f.observed).proven, false);
  f.advance(5 * 60000); assert.equal(f.policy.observe("stable", f.observed).proven, false);
  f.advance(5 * 60000); assert.equal(f.policy.observe("stable", f.observed).proven, false);
  const restarted = { ...f.observed, identity: "daemon-2:pill-2" };
  assert.equal(f.policy.observe("stable", restarted).proven, false);
  assert.equal(f.policy.decision("stable", "1.0.0").failures, 1);
  for (let i = 0; i < 3; i++) { f.advance(5 * 60000); f.policy.observe("stable", restarted); }
  assert.equal(f.policy.decision("stable", "1.0.0").failures, 0);
  assert.equal(f.policy.decision("stable", "2.0.0").failures, 1);
  f.advance(PROBATION_MS);
  assert.equal(f.policy.observe("stable", restarted).proven, false, "an unobserved sleep gap does not count as health");
});

test("failed-release events are shared, channel scoped, deduplicated and expire after a bounded cooldown", t => {
  const f = fixture(t), other = recoveryPolicy({ root: f.root, now: f.now });
  f.policy.failure("stable", "2.0.0", { id: "request-1" });
  other.failure("stable", "2.0.0", { id: "request-1" });
  assert.equal(other.decision("stable", "2.0.0").failures, 1);
  other.failure("stable", "2.0.0", { id: "request-2" });
  assert.equal(f.policy.decision("stable", "2.0.0").failures, 2);
  assert.equal(f.policy.decision("dev", "2.0.0").blocked, false);
  f.advance(2 * RELEASE_COOLDOWN_MS);
  assert.equal(f.policy.decision("stable", "2.0.0").blocked, false);
});

test("a reversed clock anchors a bounded cooldown instead of moving its deadline each tick", t => {
  const f = fixture(t);
  f.advance(24 * 60 * 60000);
  f.policy.failure("stable", "2.0.0", { id: "before-clock-correction" });
  f.policy.decision("stable", "2.0.0");
  f.advance(-24 * 60 * 60000);
  const corrected = f.policy.decision("stable", "2.0.0");
  assert.equal(corrected.retryAt, f.now() + RELEASE_COOLDOWN_MS);
  f.advance(5 * 60000);
  assert.equal(f.policy.decision("stable", "2.0.0").retryAt, corrected.retryAt);
  f.advance(RELEASE_COOLDOWN_MS);
  assert.equal(f.policy.decision("stable", "2.0.0").blocked, false);
});
