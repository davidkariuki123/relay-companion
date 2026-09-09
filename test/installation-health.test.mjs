import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import health from "../bootstrap/installation-health.cjs";
import { encodeCompanionFleetTelemetry } from "../src/fleet-telemetry.js";

test("installation identity survives pairing changes and inventory distinguishes mixed processes", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installation-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  assert.equal(health.installationId({ homeDir }), null);
  const id = health.installationId({ homeDir, create: true });
  assert.match(id, /^ins_[a-f0-9]{32}$/);
  assert.equal(health.installationId({ homeDir, create: true }), id);
  const command = (version, entry) => `node /user/.relay/runtime/releases/${version}-abc/node_modules/relay-companion/${entry}`;
  const inventory = health.componentInventory([
    command("0.1.490", "bin/relay.js daemon"), command("0.1.490", "bin/relay.js daemon"),
    command("0.1.489", "src/mcp-broker-entry.js"), command("0.1.490", "overlay/main.cjs"),
    "node /checkout/relay/packages/companion/bin/relay.js daemon",
  ], "0.1.490");
  assert.equal(inventory.duplicates, true);
  assert.equal(inventory.mixed, true);
  assert.equal(inventory.components.length, 3);
  health.recordTransport("mcp", { homeDir, now: 1000 });
  const report = health.collectInstallationHealth({ homeDir, commands: [], now: 2000 });
  assert.equal(report.transports.mcpLastUsedAt, new Date(1000).toISOString());
  assert.equal(report.transports.httpsLastUsedAt, null);
  assert.equal(report.daemonResponsive, false);
  assert.equal(JSON.stringify(report).includes(homeDir), false);
});

test("large optional process report cannot discard the base fleet report", () => {
  const value = { schema: 1, installation: { components: "x".repeat(5000) } };
  const encoded = encodeCompanionFleetTelemetry(value);
  assert.ok(encoded.length < 4096);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url")), { schema: 1 });
});
