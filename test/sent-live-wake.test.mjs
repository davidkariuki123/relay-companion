import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startSentLiveWake } = require("../overlay/sent-live-wake.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const immediate = { setTimeoutImpl: (fn) => setImmediate(fn), clearTimeoutImpl: (t) => clearImmediate(t) };

test("a changed cursor refreshes Sent once; the seed answer does not", async (t) => {
  const cursors = []; let refreshes = 0; const hold = deferred();
  const wake = startSentLiveWake({ ...immediate,
    wait: async (since, signal) => {
      cursors.push(since);
      if (since === undefined) return { version: "7", changed: false };
      if (since === "7") return { version: "8", changed: true };
      signal.addEventListener("abort", () => hold.resolve({ version: "8", changed: false }), { once: true });
      return hold.promise;
    },
    onChange: async () => { refreshes += 1; },
  });
  t.after(() => wake.stop());
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(cursors, [undefined, "7", "8"]);
  assert.equal(refreshes, 1);
  assert.equal(wake.cursor, "8");
});

test("an unchanged heartbeat costs no fetch", async (t) => {
  let refreshes = 0; let waits = 0; const hold = deferred();
  const wake = startSentLiveWake({ ...immediate,
    wait: async (since, signal) => {
      waits += 1;
      if (waits <= 3) return { version: "3", changed: waits === 1 ? false : false };
      signal.addEventListener("abort", () => hold.resolve({ version: "3", changed: false }), { once: true });
      return hold.promise;
    },
    onChange: async () => { refreshes += 1; },
  });
  t.after(() => wake.stop());
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(waits, 4);
  assert.equal(refreshes, 0);
});

test("a failed refresh keeps the old cursor so the change is asked for again", async (t) => {
  const cursors = []; let refreshes = 0; const hold = deferred();
  const wake = startSentLiveWake({ ...immediate, retryMs: 1,
    wait: async (since, signal) => {
      cursors.push(since);
      if (since === undefined) return { version: "1", changed: false };
      if (refreshes < 2) return { version: "2", changed: true };
      signal.addEventListener("abort", () => hold.resolve({ version: "2", changed: false }), { once: true });
      return hold.promise;
    },
    onChange: async () => { refreshes += 1; if (refreshes === 1) throw new Error("offline"); },
  });
  t.after(() => wake.stop());
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(refreshes, 2);
  assert.deepEqual(cursors.slice(0, 3), [undefined, "1", "1"]);
  assert.equal(wake.cursor, "2");
});

test("transport failures back off, an unsupported server waits a minute, stop aborts the wait", async (t) => {
  const delays = []; let waits = 0; const hold = deferred(); const logs = [];
  const wake = startSentLiveWake({ retryMs: 100, maxRetryMs: 400, unsupportedRetryMs: 60_000,
    setTimeoutImpl: (fn, ms) => { delays.push(ms); return setImmediate(fn); }, clearTimeoutImpl: (h) => clearImmediate(h),
    log: (m) => logs.push(m),
    wait: async (_since, signal) => {
      waits += 1;
      if (waits <= 3) throw new Error(`down ${waits}`);
      if (waits === 4) { const e = new Error("gone"); e.status = 404; throw e; }
      signal.addEventListener("abort", () => hold.resolve(undefined), { once: true });
      return hold.promise;
    },
    onChange: async () => {},
  });
  for (let i = 0; i < 12; i++) await tick();
  assert.deepEqual(delays, [100, 200, 400, 60_000]);
  assert.equal(waits, 5);
  assert.match(logs[0], /timer refresh continues/);
  wake.stop();
  await wake.loop;
});

test("a cursor bound to a stale account stops without another wait", async () => {
  let current = true; let waits = 0;
  const wake = startSentLiveWake({ ...immediate,
    isCurrent: () => current,
    wait: async () => { waits += 1; current = false; return { version: "1", changed: true }; },
    onChange: async () => { throw new Error("must not refresh for a stale account"); },
  });
  await wake.loop;
  assert.equal(waits, 1);
  assert.equal(wake.cursor, undefined);
});
