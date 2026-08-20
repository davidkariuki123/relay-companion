import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { ackPacketsInState, ackPacketsTransaction } = require("../overlay/state-ack-worker.cjs");

test("a room read performs one deduplicated state transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    packets: {
      first: { state: "unread", relayNotificationKind: "plain_relay", untouched: 1 },
      second: { state: "unread", relayNotificationKind: "task", untouched: 2 },
      already: { state: "read", relayNotificationKind: "plain_relay", untouched: 3 },
    },
  }));

  try {
    const rows = ackPacketsInState(statePath, ["first", "second", "first", "already", "missing"], "2026-08-20T00:00:00.000Z");
    assert.deepEqual(rows, [
      { id: "first", relayNotificationKind: "plain_relay" },
      { id: "second", relayNotificationKind: "task" },
    ]);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(
      Object.fromEntries(Object.entries(persisted.packets).map(([id, row]) => [id, [row.state, row.updatedAt, row.untouched]])),
      {
        first: ["read", "2026-08-20T00:00:00.000Z", 1],
        second: ["read", "2026-08-20T00:00:00.000Z", 2],
        already: ["read", undefined, 3],
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or unreadable store fails instead of claiming a durable read", () => {
  const missing = path.join(os.tmpdir(), `relay-state-ack-missing-${process.pid}-${Date.now()}.json`);
  const missingResult = ackPacketsTransaction(missing, ["first"]);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error, /state_read_failed/);
  assert.deepEqual(ackPacketsInState(missing, []), []);
  fs.writeFileSync(missing, "{not json");
  try {
    const malformed = ackPacketsTransaction(missing, ["first"]);
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /state_read_failed/);
  } finally {
    fs.rmSync(missing, { force: true });
  }
});

test("the worker reports the exact state generation it read and committed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-generation-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ packets: { first: { state: "unread" } } }));
  try {
    const before = fs.statSync(statePath);
    const result = ackPacketsTransaction(statePath, ["first"], "2026-08-20T00:00:00.000Z");
    assert.equal(result.beforeStateStatSig, `${before.mtimeMs}:${before.size}`);
    const after = fs.statSync(statePath);
    assert.equal(result.stateStatSig, `${after.mtimeMs}:${after.size}`);
    assert.notEqual(result.stateStatSig, result.beforeStateStatSig);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an ambiguous commit retry retains metadata for already-read requested rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-retry-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    packets: { first: { state: "read", relayNotificationKind: "plain_relay" } },
  }));
  try {
    const result = ackPacketsTransaction(statePath, ["first"], "2026-08-20T00:00:00.000Z");
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows, [{ id: "first", relayNotificationKind: "plain_relay" }]);
    assert.deepEqual(result.changedIds, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an acknowledgement is bound to the account that presented the Relay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-account-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    account: { userId: "account_a", email: "a@example.com" },
    packets: { shared_id: { state: "unread" } },
  }));
  try {
    const result = ackPacketsTransaction(
      statePath,
      ["shared_id"],
      "2026-08-20T00:00:00.000Z",
      { userId: "account_b", email: "b@example.com" },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /account_mismatch/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).packets.shared_id.state, "unread");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("named accounts need one shared comparable identity field", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-account-shared-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    account: { email: "a@example.com" },
    packets: { shared_id: { state: "unread" } },
  }));
  try {
    const result = ackPacketsTransaction(
      statePath,
      ["shared_id"],
      "2026-08-20T00:00:00.000Z",
      { userId: "account_a" },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /account_mismatch/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).packets.shared_id.state, "unread");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict lock timeout never falls through to an unlocked write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-lock-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ packets: { first: { state: "unread" } } }));
  fs.mkdirSync(`${statePath}.lock`);
  try {
    const result = ackPacketsTransaction(
      statePath,
      ["first"],
      "2026-08-20T00:00:00.000Z",
      {},
      { timeoutMs: 20, staleMs: 10_000 },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /state_lock_timeout/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).packets.first.state, "unread");
  } finally {
    fs.rmdirSync(`${statePath}.lock`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lock contention waits on the worker while the main event loop stays responsive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-ack-responsive-"));
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ packets: { first: { state: "unread" } } }));
  fs.mkdirSync(`${statePath}.lock`);
  const worker = new Worker(new URL("../overlay/state-ack-worker.cjs", import.meta.url), {
    workerData: { statePath },
  });
  try {
    const response = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.postMessage({ requestId: 1, packetIds: ["first"], expectedAccount: {} });
    const startedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(performance.now() - startedAt < 250, "worker lock wait blocked the test event loop");
    fs.rmdirSync(`${statePath}.lock`);
    const result = await response;
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).packets.first.state, "read");
  } finally {
    await worker.terminate();
    try { fs.rmdirSync(`${statePath}.lock`); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
