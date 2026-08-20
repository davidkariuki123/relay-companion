// Always-on, near-zero-cost perf counters for the overlay main process.
//
// Motivation (2026-08-05 whole-Mac stutter investigation): the pill's background
// cost is invisible until it is measured. Every recurring expense — process
// spawns, window-server re-assertions, cursor/idle queries, full payload builds,
// prefs writes — increments a named counter here, so a live overlay (or the
// sandboxed e2e/perf harness) can report exact per-minute rates instead of
// guesses. Incrementing a property on a plain object is nanoseconds; the module
// never allocates on the hot path.
//
// Reading:
//   - test seam: global.__relayTest.perf() returns snapshot()
//   - log line: RELAY_OVERLAY_PERF_LOG=1 prints per-minute deltas to stderr

"use strict";

const counters = Object.create(null);
const startedAt = Date.now();

function inc(name, by = 1) {
  counters[name] = (counters[name] || 0) + by;
}

function snapshot() {
  return { ...counters, uptimeMs: Date.now() - startedAt };
}

// Per-minute delta logger. Off unless explicitly enabled; unref'd so it never
// keeps the process alive.
function startPerfLog({ log = () => {}, intervalMs = 60000, now = Date.now } = {}) {
  let last = { ...counters };
  let lastAt = now();
  const timer = setInterval(() => {
    const at = now();
    const minutes = Math.max((at - lastAt) / 60000, 1e-6);
    const deltas = {};
    for (const key of Object.keys(counters)) {
      deltas[key] = Math.round(((counters[key] || 0) - (last[key] || 0)) / minutes);
    }
    last = { ...counters };
    lastAt = at;
    log(`[overlay] perf/min ${JSON.stringify(deltas)}`);
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { inc, snapshot, startPerfLog };
