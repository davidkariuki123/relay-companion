import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCompanionFleetTelemetry,
  encodeCompanionFleetTelemetry,
} from "../src/fleet-telemetry.js";
import { canonicalRuntimeLayout } from "../src/canonical-runtime.js";

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-telemetry-"));
}

test("fleet telemetry reports an active canonical runtime without local paths", () => {
  const homeDir = temp();
  const updateStatePath = path.join(homeDir, "update-state.json");
  const layout = canonicalRuntimeLayout({ homeDir, platform: "win32", releaseId: "release-1" });
  fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
  fs.writeFileSync(layout.pointerPath, JSON.stringify({
    schema: 1,
    state: "active",
    active: true,
    version: "0.1.440",
    releaseId: "release-1",
    releaseRoot: layout.releaseRoot,
    packageRoot: layout.packageRoot,
    bin: layout.bin,
    committedAt: 1_788_800_000_000,
  }));
  fs.writeFileSync(updateStatePath, JSON.stringify({ version: "0.1.440" }));
  const skillRoot = path.join(homeDir, ".codex", "skills", "relay");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, ".relay-managed.json"), JSON.stringify({
    schemaVersion: 1,
    name: "relay",
    version: "1.1.13",
    consentVersion: 2,
    installationId: "ski_0123456789abcdefghijklmn",
    installedAt: "2026-09-08T08:00:00.000Z",
    files: [],
  }));

  const telemetry = collectCompanionFleetTelemetry({
    homeDir,
    platform: "win32",
    channel: "dev",
    env: {},
    updateStatePath,
  });
  assert.equal(telemetry.runtimeState, "active");
  assert.equal(telemetry.activeVersion, "0.1.440");
  assert.equal(telemetry.channel, "dev");
  assert.equal(telemetry.autoUpdate, true);
  assert.deepEqual(telemetry.skills[0], {
    name: "relay",
    host: "codex",
    target: "primary",
    installationId: "ski_0123456789abcdefghijklmn",
    version: "1.1.13",
    consentVersion: 2,
    status: "managed",
    installedAt: "2026-09-08T08:00:00.000Z",
  });
  assert.equal(telemetry.skills.filter((skill) => skill.status === "absent").length, 2);
  assert.equal(JSON.stringify(telemetry).includes(homeDir), false);
});

test("fleet telemetry surfaces a pinned recovery candidate and all durable failure classes", () => {
  const homeDir = temp();
  const updateStatePath = path.join(homeDir, "update-state.json");
  const layout = canonicalRuntimeLayout({ homeDir, platform: "win32" });
  fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
  fs.writeFileSync(layout.pointerPath, JSON.stringify({
    schema: 1,
    state: "recovery-required",
    active: false,
    preparedAt: 1_788_800_000_000,
    candidate: { version: "0.1.420" },
    previous: { version: "0.1.417" },
  }));
  fs.writeFileSync(updateStatePath, JSON.stringify({
    failure: { target: "0.1.420", count: 4, firstAt: 1000, lastAt: 2000 },
    recoveryFailure: { target: "canonical-recovery:0.1.420", count: 70, firstAt: 3000, lastAt: 4000 },
  }));

  const telemetry = collectCompanionFleetTelemetry({
    homeDir,
    platform: "win32",
    channel: "staging",
    env: { RELAY_AUTO_UPDATE: "off" },
    updateStatePath,
  });
  assert.equal(telemetry.runtimeState, "recovery-required");
  assert.equal(telemetry.activeVersion, "0.1.417");
  assert.equal(telemetry.candidateVersion, "0.1.420");
  assert.equal(telemetry.autoUpdate, false);
  assert.deepEqual(telemetry.failures.map((failure) => [failure.kind, failure.count]), [
    ["update", 4],
    ["recovery", 70],
  ]);
});

test("fleet telemetry names a superseded recovery's real target and a parked episode", () => {
  const homeDir = temp();
  const updateStatePath = path.join(homeDir, "update-state.json");
  const layout = canonicalRuntimeLayout({ homeDir, platform: "darwin" });
  fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
  fs.writeFileSync(layout.pointerPath, JSON.stringify({
    schema: 1, state: "recovery-required", active: false, preparedAt: 1_788_800_000_000,
    candidate: { version: "0.1.510" }, previous: { version: "0.1.490" },
  }));
  const exhaustedAt = Date.parse("2026-09-14T12:00:00Z");
  fs.writeFileSync(updateStatePath, JSON.stringify({
    recoveryFailure: { target: "canonical-recovery:0.1.510", count: 24, firstAt: 3000, lastAt: exhaustedAt, launched: "0.1.624", exhaustedAt },
  }));
  const telemetry = collectCompanionFleetTelemetry({ homeDir, platform: "darwin", channel: "stable", env: {}, updateStatePath, collectHealth: () => undefined });
  assert.deepEqual(telemetry.failures, [{
    kind: "recovery",
    target: "canonical-recovery:0.1.510 via 0.1.624",
    count: 24,
    firstAt: new Date(3000).toISOString(),
    lastAt: new Date(exhaustedAt).toISOString(),
    exhaustedAt: new Date(exhaustedAt).toISOString(),
  }]);

  // An episode still on its own candidate, and not parked, reports exactly the
  // fields every deployed API already accepts.
  fs.writeFileSync(updateStatePath, JSON.stringify({
    recoveryFailure: { target: "canonical-recovery:0.1.510", count: 2, firstAt: 3000, lastAt: 4000, launched: "0.1.510" },
  }));
  const plain = collectCompanionFleetTelemetry({ homeDir, platform: "darwin", channel: "stable", env: {}, updateStatePath, collectHealth: () => undefined });
  assert.deepEqual(Object.keys(plain.failures[0]).sort(), ["count", "firstAt", "kind", "lastAt", "target"]);
  assert.equal(plain.failures[0].target, "canonical-recovery:0.1.510");
});

test("fleet telemetry header remains compact base64url", () => {
  const report = {
    schema: 1,
    channel: "stable",
    autoUpdate: true,
    runtimeKind: "legacy",
    runtimeState: "legacy",
    activeVersion: null,
    candidateVersion: null,
    previousVersion: null,
    stateChangedAt: null,
    failures: [],
  };
  const header = encodeCompanionFleetTelemetry(report);
  assert.match(header, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), report);
});

test("truncation diagnostics cannot break the bounded legacy header", () => {
  let count = 0;
  const header = encodeCompanionFleetTelemetry({ schema: 1, installation: { oversized: "x".repeat(5000) } }, { onTruncated: () => { count++; throw Error("diagnostics unavailable"); } });
  assert.equal(count, 1);
  assert.ok(header.length < 4096);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { schema: 1 });
});
