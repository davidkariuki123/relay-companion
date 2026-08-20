import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const perf = require("../overlay/perf-counters.cjs");

test("inc accumulates named counters and snapshot returns a detached copy", () => {
  const before = perf.snapshot();
  perf.inc("testCounterX");
  perf.inc("testCounterX", 2);
  perf.inc("testCounterY");
  const after = perf.snapshot();
  assert.equal((after.testCounterX || 0) - (before.testCounterX || 0), 3);
  assert.equal((after.testCounterY || 0) - (before.testCounterY || 0), 1);
  assert.ok(after.uptimeMs >= 0);
  after.testCounterX = 999999; // mutating the snapshot must not touch the source
  assert.notEqual(perf.snapshot().testCounterX, 999999);
});

test("startPerfLog emits per-minute deltas on its interval", async () => {
  const lines = [];
  const timer = perf.startPerfLog({ log: (line) => lines.push(line), intervalMs: 20 });
  perf.inc("testCounterZ", 5);
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(timer);
  assert.ok(lines.length >= 1, "at least one perf log line");
  const parsed = JSON.parse(lines[0].replace("[overlay] perf/min ", ""));
  assert.equal(typeof parsed, "object");
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "testCounterZ"));
});
