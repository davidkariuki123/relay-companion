import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCompanionFleetTelemetry,
  companionFleetTelemetryHeader,
  encodeCompanionFleetTelemetry,
  resetCompanionFleetTelemetryCache,
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

test("fleet telemetry header is compact base64url and cached briefly", () => {
  resetCompanionFleetTelemetryCache();
  let collections = 0;
  const collect = () => ({
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
    sequence: ++collections,
  });
  const first = companionFleetTelemetryHeader({ now: () => 1000, collect });
  const second = companionFleetTelemetryHeader({ now: () => 2000, collect });
  assert.equal(first, second);
  assert.equal(collections, 1);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(encodeCompanionFleetTelemetry(collect()), "base64url").toString("utf8").includes("stable"), true);
});
