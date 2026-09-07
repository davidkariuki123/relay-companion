import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { startInboxReceiver } from "../src/inbox-receiver.js";
import { startInboxWorker } from "../src/inbox-worker-controller.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function setup(t, overrides = {}) {
  let fallback;
  const receiver = startInboxReceiver({
    client: {}, refresh: async () => ({ inboxOk: true }),
    setIntervalImpl: (fn) => { fallback = fn; return 1; }, clearIntervalImpl: () => {},
    ...overrides,
  });
  t.after(() => receiver.stop());
  return { receiver, fallback: () => fallback() };
}

test("bursts coalesce into one follow-up while fallback ticks never pile up", async (t) => {
  const first = deferred(); let calls = 0; let concurrent = 0; let maxConcurrent = 0;
  const { receiver, fallback } = setup(t, { refresh: async () => {
    calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (calls === 1) await first.promise;
    concurrent--; return { inboxOk: true };
  } });
  for (let i = 0; i < 20; i++) fallback();
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) void receiver.requestRefresh();
  first.resolve(); await tick();
  assert.equal(calls, 2); assert.equal(maxConcurrent, 1);
});

test("initial cursor refresh closes the race with the startup inbox fetch", async (t) => {
  const initial = deferred(); const waiting = deferred(); let calls = 0; const cursors = [];
  setup(t, {
    refresh: async () => { calls++; return { inboxOk: true }; },
    client: { waitForAccountChange: (since, signal) => {
      cursors.push(since);
      if (since === undefined) return initial.promise;
      signal.addEventListener("abort", () => waiting.resolve({ version: "1", changed: false }), { once: true });
      return waiting.promise;
    } },
  });
  await tick(); assert.equal(calls, 1);
  initial.resolve({ version: "1", changed: false }); await tick();
  assert.equal(calls, 2); assert.deepEqual(cursors, [undefined, "1"]);
});

test("failed refresh does not advance the durable event cursor", async (t) => {
  const waitedAgain = deferred(); let changes = 0; let fail = false; const cursors = [];
  const { receiver } = setup(t, { retryMs: 1,
    refresh: async () => ({ inboxOk: !fail }),
    client: { waitForAccountChange: async (since, signal) => {
      cursors.push(since);
      if (since === undefined) return { version: "1", changed: false };
      changes++;
      if (changes === 1) { fail = true; return { version: "2", changed: true }; }
      if (changes === 2) { fail = false; return { version: "2", changed: true }; }
      waitedAgain.resolve();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ version: "2", changed: false }), { once: true }));
    } },
  });
  await waitedAgain.promise;
  assert.deepEqual(cursors, [undefined, "1", "1", "2"]);
  receiver.stop(); await receiver.events;
});

test("old servers retain fallback polling and stop aborts reconnect sleep", async (t) => {
  let refreshes = 0; let waits = 0;
  const { receiver, fallback } = setup(t, {
    refresh: async () => { refreshes++; return { inboxOk: true }; },
    client: { waitForAccountChange: async () => { waits++; throw Object.assign(new Error("old server"), { status: 404 }); } },
  });
  await tick(); fallback(); await tick();
  assert.equal(refreshes, 2); assert.equal(waits, 1);
  receiver.stop(); await receiver.events;
});

test("sign-out invalidates an in-flight response and aborts the subscription", async (t) => {
  const change = deferred(); let current = true; let refreshes = 0; let signal;
  const { receiver, fallback } = setup(t, {
    isCurrent: () => current,
    refresh: async () => { refreshes++; return { inboxOk: true }; },
    client: { waitForAccountChange: (_since, value) => { signal = value; return change.promise; } },
  });
  await tick(); current = false;
  change.resolve({ version: "2", changed: true }); fallback(); await tick();
  assert.equal(refreshes, 1);
  receiver.stop(); assert.equal(signal.aborted, true); await receiver.events;
});

test("an exited worker is replaced once; stopping prevents further restarts", async (t) => {
  const launches = new EventEmitter(); const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); launches.emit("launch"); }
    terminate() { this.terminated = true; this.emit("exit", 1); return Promise.resolve(1); }
  }
  const controller = startInboxWorker({ WorkerImpl: FakeWorker, restartMs: 1 });
  t.after(() => controller.stop());
  const restarted = once(launches, "launch");
  workers[0].emit("error", new Error("receiver crashed")); workers[0].emit("exit", 1);
  await restarted;
  assert.equal(workers.length, 2);
  await controller.stop(); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(workers.length, 2); assert.equal(workers[1].terminated, true);
});
