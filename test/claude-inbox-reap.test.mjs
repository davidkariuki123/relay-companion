import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxSessionBusy } from "../src/claude-inbox-session.js";

// Bug 5 (David + Sven, 2026-09-11): a background self-update reaped the live
// Claude session the user was working in, because the pill's before-quit killed
// EVERY Relay-spawned engine. before-quit now reaps only idle engines, gated by
// this predicate. Keeping a busy engine alive lets it outlive the runtime swap.
const reg = (rows) => () => new Map(rows.map((r) => [r.sessionId, r]));

test("a running or waiting engine is busy and must not be reaped", () => {
  for (const status of ["running", "busy", "working", "active", "waiting", "needs_input", "permission", "approval"]) {
    assert.equal(
      inboxSessionBusy("s1", reg([{ sessionId: "s1", socketLive: true, status }])),
      true,
      `status ${status} should count as busy`,
    );
  }
});

test("an idle, finished, or dead engine is reapable", () => {
  for (const status of ["idle", "ready", "completed", "failed", "error", ""]) {
    assert.equal(
      inboxSessionBusy("s1", reg([{ sessionId: "s1", socketLive: true, status }])),
      false,
      `status ${status} should be reapable`,
    );
  }
});

test("an engine with no live socket, or no registry row, is not busy", () => {
  assert.equal(inboxSessionBusy("s1", reg([{ sessionId: "s1", socketLive: false, status: "running" }])), false);
  assert.equal(inboxSessionBusy("missing", reg([])), false);
});
