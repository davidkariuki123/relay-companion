import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createProviderInventoryCache, sanitizeProviderInventory } from "../src/provider-inventory-cache.js";

function tempCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-inventory-")), "provider-inventory.json");
}

function providers(name = "Gmail", status = "Connected") {
  return {
    claude: { integrations: { mcpServers: [{ name, status, source:"account", accessToken:"secret" }], apps:[] } },
    codex: { integrations: { mcpServers:[], apps:[{ name:"GitHub", status:"Connected", source:"account" }] } },
  };
}

test("provider inventory snapshots retain only display-safe fields", () => {
  const clean = sanitizeProviderInventory({ providers:providers("Gmail\n<script>") });
  assert.deepEqual(clean.claude.integrations.mcpServers, [
    { name:"Gmail script", status:"Connected", source:"account" },
  ]);
  assert.equal(JSON.stringify(clean).includes("accessToken"), false);
});

test("provider inventory refreshes once, persists privately, and observes its TTL", async () => {
  const cacheFile = tempCache();
  let clock = Date.parse("2026-08-17T08:00:00.000Z");
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inventory = createProviderInventoryCache({
    cacheFile,
    now: () => clock,
    ttlMs: 60_000,
    fallbackProviders: providers("local-relay", "Configured"),
    loadFresh: async () => {
      calls += 1;
      await gate;
      return { ok:true, providers:providers() };
    },
  });

  const cold = inventory.current();
  assert.equal(cold.checkedAt, null);
  assert.equal(cold.stale, true);
  assert.equal(cold.providers.claude.integrations.mcpServers[0].name, "local-relay");

  const first = inventory.refresh();
  const duplicate = inventory.refresh();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1);

  const persisted = fs.readFileSync(cacheFile, "utf8");
  assert.equal(persisted.includes("accessToken"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal((await inventory.refresh()).stale, false);
  assert.equal(calls, 1);

  let restartCalls = 0;
  const restarted = createProviderInventoryCache({
    cacheFile,
    now: () => clock,
    ttlMs: 60_000,
    loadFresh: async () => { restartCalls += 1; return { ok:true, providers:providers("Unexpected") }; },
  });
  assert.equal(restarted.current().providers.claude.integrations.mcpServers[0].name, "Gmail");
  await restarted.refresh();
  assert.equal(restartCalls, 0);

  clock += 60_001;
  await inventory.refresh();
  assert.equal(calls, 2);
});

test("a failed refresh keeps the last good inventory and backs off", async () => {
  const cacheFile = tempCache();
  let clock = Date.parse("2026-08-17T08:00:00.000Z");
  let calls = 0;
  const first = createProviderInventoryCache({
    cacheFile,
    now: () => clock,
    ttlMs: 1,
    loadFresh: async () => ({ ok:true, providers:providers() }),
  });
  await first.refresh();
  clock += 10;

  const failing = createProviderInventoryCache({
    cacheFile,
    now: () => clock,
    ttlMs: 1,
    retryMs: 30_000,
    loadFresh: async () => {
      calls += 1;
      throw new Error("health check failed");
    },
  });
  const failed = await failing.refresh();
  assert.equal(failed.providers.claude.integrations.mcpServers[0].name, "Gmail");
  assert.match(failed.error, /health check failed/);
  await failing.refresh();
  assert.equal(calls, 1);
});
