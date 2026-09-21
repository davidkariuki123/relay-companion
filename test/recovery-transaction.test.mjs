import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { inFlightTransaction, liveOwner, workerLostLock, REQUEST_IN_FLIGHT_MAX_MS, WORKER_EXIT_TRANSACTION_IN_PROGRESS } = require("../bootstrap/recovery-transaction.cjs");
const { write } = require("../bootstrap/recovery-runner.cjs");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-transaction-test-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, runtime: path.join(homeDir, ".relay", "runtime") };
}
const DEAD_PID = 2 ** 22 - 7;

test("a live lock owner is in flight; a dead or replaced one is not", t => {
  const { homeDir, runtime } = fixture(t);
  const ownerFile = path.join(runtime, "transaction.lock", "owner.json");
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
  write(ownerFile, { pid: DEAD_PID, createdAt: 900, requestId: "dead" });
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
  write(ownerFile, { pid: process.pid, createdAt: 900, requestId: "live" });
  assert.deepEqual(inFlightTransaction({ homeDir, now: 1000 }), { source: "lock", pid: process.pid, requestId: "live", version: null, admittedAt: 900 });
  // Same pid, different process birth: the owner died and the pid was reused.
  write(ownerFile, { pid: process.pid, createdAt: 900, processIdentity: "win32:1:1" });
  assert.equal(inFlightTransaction({ homeDir, now: 1000, identity: () => "win32:2:2" }), null);
  assert.equal(liveOwner({ pid: process.pid, processIdentity: "win32:1:1" }, { identity: () => "win32:1:1" }), true);
  assert.equal(liveOwner({ pid: 0 }), false);
});

test("an admitted update request names the version being installed; terminal or stale requests do not count", t => {
  const { homeDir, runtime } = fixture(t);
  const requestFile = path.join(runtime, "update-requests", "11111111-1111-1111-1111-111111111111.json");
  const request = { schema: 1, requestId: "11111111-1111-1111-1111-111111111111", state: "admitted", version: "1.2.3", workerPid: process.pid, admittedAt: 900, lockOwner: { pid: process.pid } };
  write(requestFile, request);
  assert.deepEqual(inFlightTransaction({ homeDir, now: 1000 }), { source: "request", pid: process.pid, requestId: request.requestId, version: "1.2.3", admittedAt: 900 });
  write(requestFile, { ...request, state: "completed" });
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
  write(requestFile, { ...request, admittedAt: 1000 - REQUEST_IN_FLIGHT_MAX_MS - 1 });
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
  write(requestFile, { ...request, workerPid: DEAD_PID, lockOwner: { pid: DEAD_PID } });
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
  // A request from the future is a clock problem, not evidence of work.
  write(requestFile, { ...request, admittedAt: 5000 });
  assert.equal(inFlightTransaction({ homeDir, now: 1000 }), null);
});

test("only the temporary-failure exit code means the worker lost the lock", async () => {
  assert.equal(WORKER_EXIT_TRANSACTION_IN_PROGRESS, 75);
  // The worker entry and the runner agree on the code without sharing a module:
  // the entry runs from the downloaded release, the runner from the launcher bundle.
  const entry = await import("../src/recovery-entry.js");
  assert.equal(entry.EXIT_TRANSACTION_IN_PROGRESS, WORKER_EXIT_TRANSACTION_IN_PROGRESS);
  assert.equal(entry.recoveryExitCode(Object.assign(new Error("lock: transaction-in-progress: "), { transactionInProgress: true })), 75);
  assert.equal(entry.recoveryExitCode(new Error("activation: candidate-smoke-failed: ")), 1);
  assert.equal(workerLostLock(new Error("recovery-worker-exit-75")), true);
  assert.equal(workerLostLock(new Error("recovery-worker-exit-1")), false);
  assert.equal(workerLostLock(new Error("recovery-worker-exit-750")), false);
  assert.equal(workerLostLock(null), false);
});
