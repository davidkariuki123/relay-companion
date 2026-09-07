import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollOrdinaryRelayOnce, daemonDeliveryTick } from "../src/task-daemon.js";
import { notificationLedger } from "../src/inbox-receiver-worker.js";
import { queueInboxAttachments, processInboxAttachments, readInboxJson } from "../src/inbox-work.js";

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inbox-ingest-"));
  const keys = ["RELAY_CONFIG_DIR", "RELAY_HOME", "RELAY_COMPANION_HOME", "RELAY_CONFIG"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RELAY_CONFIG_DIR = process.env.RELAY_HOME = process.env.RELAY_COMPANION_HOME = dir;
  process.env.RELAY_CONFIG = path.join(dir, "config.json");
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const item = (id) => ({ relayId: id, createdAt: new Date().toISOString(), updatedAt: "1", state: "delivered" });
const options = { log: () => {}, queueCompletionWake: () => {}, processCompletionWakes: async () => {} };

test("newest packets stage before an older batch finishes; later fallback preserves earlier progress", async (t) => {
  scratch(t); const older = deferred(); const waiting = deferred(); let batches = 0;
  const staged = []; const fetched = [];
  const items = Array.from({ length: 101 }, (_, i) => item(`relay_batch_${i}`));
  const client = {
    inbox: async () => ({ items }),
    fetchRelayPackets: async (ids) => {
      if (++batches === 2) { waiting.resolve(); await older.promise; throw Object.assign(new Error("old server"), { status: 404 }); }
      return { packets: Object.fromEntries(ids.map((id) => [id, { packet: { relayId: id } }])) };
    },
    fetchRelay: async (id) => { fetched.push(id); return { packet: { relayId: id } }; },
  };
  const running = pollOrdinaryRelayOnce({ ...options, client, stagePlainRelay: ({ item }) => staged.push(item.relayId) });
  await waiting.promise;
  assert.equal(staged.length, 100);
  older.resolve(); await running;
  assert.equal(staged.length, 101);
  assert.deepEqual(fetched, ["relay_batch_100"]);
  await pollOrdinaryRelayOnce({ ...options, client, stagePlainRelay: () => assert.fail("duplicate stage") });
});

test("account changes during packet fetch prevent staging into the replacement account", async (t) => {
  scratch(t); let current = true;
  const client = {
    inbox: async () => ({ items: [item("old-account-relay")] }),
    fetchRelay: async () => { current = false; return { packet: {} }; },
  };
  const result = await pollOrdinaryRelayOnce({ ...options, client, isCurrent: () => current,
    stagePlainRelay: () => assert.fail("old account staged"),
  });
  assert.equal(result.inboxOk, false);
});

test("attachment queue failure leaves the Relay eligible for retry", async (t) => {
  scratch(t); let stages = 0; let fail = true;
  const client = { inbox: async () => ({ items: [item("queue-failure")] }), fetchRelay: async () => ({ packet: {} }) };
  const poll = () => pollOrdinaryRelayOnce({ ...options, client, stagePlainRelay: () => { stages++; }, queueAttachments: () => { if (fail) throw new Error("disk busy"); } });
  await poll(); fail = false; await poll(); await poll();
  assert.equal(stages, 2, "queue failure must not commit a dedupe entry");
});

test("notification ledger survives restart but resets with account/store generation", (t) => {
  const dir = scratch(t);
  const client = { url: "http://localhost", token: "fake", identity: { userId: "account-a" } };
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ account: { userId: "account-a", resetAt: "first" } }));
  fs.writeFileSync(path.join(dir, "task-ledger.json"), JSON.stringify({ sessions: { existing: {} }, plainRelays: { legacy: {} } }));
  let loaded = notificationLedger(client);
  assert.ok(loaded.ledger.plainRelays.legacy);
  loaded.ledger.plainRelays.new = {}; loaded.saveLedger(loaded.ledger);
  assert.ok(notificationLedger(client).ledger.plainRelays.new);
  fs.writeFileSync(stateFile, JSON.stringify({ account: { userId: "account-a", resetAt: "second" } }));
  loaded = notificationLedger(client);
  assert.deepEqual(loaded.ledger.plainRelays, {});
  loaded.saveLedger(loaded.ledger);
  assert.deepEqual(notificationLedger({ ...client, identity: { userId: "account-b" } }).ledger.plainRelays, {});
  assert.ok(readInboxJson(path.join(dir, "task-ledger.json")).sessions.existing);
  let current = true;
  const old = notificationLedger(client, { isCurrent: () => current });
  const replacement = notificationLedger({ ...client, identity: { userId: "account-b" } });
  replacement.ledger.plainRelays.replacement = {}; replacement.saveLedger(replacement.ledger);
  current = false;
  assert.throws(() => old.saveLedger(old.ledger), /account changed/);
  assert.ok(readInboxJson(path.join(dir, "inbox-ledger.json")).plainRelays.replacement);
});

test("downloads remain durable after failure and never erase concurrently queued work", async (t) => {
  const dir = scratch(t); const file = path.join(dir, "work.json"); const statePath = path.join(dir, "state.json");
  const scope = "account"; const a = { id: "a", attachments: [{ id: "file-a" }] };
  const b = { id: "b", attachments: [{ id: "file-b" }] };
  fs.writeFileSync(statePath, JSON.stringify({ packets: { a, b } }));
  const queue = (row) => queueInboxAttachments({ item: { relayId: row.id }, packet: row }, { scope, file });
  queue(a);
  await processInboxAttachments({ scope, file, statePath, now: () => 100, materialize: async () => { queue(b); throw new Error("offline"); } });
  assert.equal(readInboxJson(file).jobs.a.attempts, 1);
  assert.ok(readInboxJson(file).jobs.b);
  await processInboxAttachments({ scope, file, statePath, now: () => 1_000_000,
    materialize: async (row) => ({ ...row, attachments: row.attachments.map((a) => ({ ...a, localPath: "/local/fixture" })) }),
  });
  assert.deepEqual(readInboxJson(file).jobs, {});
  assert.equal(readInboxJson(statePath).packets.a.attachments[0].localPath, "/local/fixture");
});

test("daemon delegates ordinary mail to its worker for every account role", async () => {
  for (const requests of [false, true]) {
    let taskRan = false;
    await daemonDeliveryTick({ includeOrdinary: false, features: { requests },
      ordinaryPoll: () => assert.fail("ordinary mail must have only one owner"),
      taskPoll: async ({ includeOrdinary }) => { taskRan = true; assert.equal(includeOrdinary, false); return {}; },
    });
    assert.equal(taskRan, requests);
  }
});
