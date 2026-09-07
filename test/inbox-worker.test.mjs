import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

test("live receive stages a new message while the daemon event loop is blocked", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inbox-worker-"));
  const api = new Worker(new URL("./fixtures/inbox-api-worker.mjs", import.meta.url));
  let worker;
  t.after(async () => { await worker?.terminate(); await api.terminate(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [{ url }] = await once(api, "message");
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ apiUrl: url, user: { id: "fixture-user", email: "fixture@example.test" } }));
  worker = new Worker(new URL("../src/inbox-receiver-worker.js", import.meta.url), {
    workerData: { intervalMs: 60_000 },
    env: { ...process.env, RELAY_CONFIG: config, RELAY_CONFIG_DIR: dir, RELAY_HOME: dir,
      RELAY_COMPANION_HOME: dir, RELAY_API_URL: url, RELAY_DEVICE_TOKEN: "fake-worker-token" },
  });
  t.after(() => worker.terminate());
  worker.on("error", (error) => assert.fail(error));
  // Waiting with a cursor means startup refreshes are done. No timer poll is
  // due for a minute, so only the live event can discover this arrival.
  await once(api, "message");
  api.postMessage({ deliver: "relay_worker_latency_fixture", delayMs: 50 });
  const blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  const unblockedAt = Date.now();
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const row = state.packets.relay_worker_latency_fixture;
  assert.ok(row, "receiver was starved by the daemon's synchronous work");
  assert.ok(Date.parse(row.stagedAt) >= blockedAt);
  assert.ok(Date.parse(row.stagedAt) < unblockedAt, "staging waited until the parent event loop resumed");
  t.diagnostic(`Fixture creation to staging: ${Date.parse(row.stagedAt) - Date.parse(row.createdAt)} ms; parent blocked for ${unblockedAt - blockedAt} ms`);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "inbox-ledger.json"), "utf8"));
  assert.ok(ledger.plainRelays[row.id]);
  assert.equal(fs.existsSync(path.join(dir, "task-ledger.json")), false, "receiver must not overwrite task bookkeeping");
});
