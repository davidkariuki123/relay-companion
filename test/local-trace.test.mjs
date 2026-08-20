import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import localTrace from "../src/local-trace.cjs";

const { appendLocalTrace, appendLocalTraces, localTracePath } = localTrace;

test("local delivery trace is append-only and strips message content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-trace-"));
  try {
    assert.equal(appendLocalTrace({
      event: "relay_staged",
      relayId: "relay_trace_1",
      surface: "relay_pill",
      state: "unread",
      title: "must not persist",
      forHuman: "must not persist",
    }, { home: root, now: () => "2026-08-19T12:00:00.000Z" }), true);
    assert.equal(appendLocalTrace({
      event: "relay_read_server",
      relayId: "relay_trace_1",
      surface: "relay_pill",
      state: "read",
      result: "confirmed",
    }, { home: root, now: () => "2026-08-19T12:01:00.000Z" }), true);
    const rows = fs.readFileSync(localTracePath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows, [
      {
        at: "2026-08-19T12:00:00.000Z",
        event: "relay_staged",
        relayId: "relay_trace_1",
        surface: "relay_pill",
        state: "unread",
      },
      {
        at: "2026-08-19T12:01:00.000Z",
        event: "relay_read_server",
        relayId: "relay_trace_1",
        surface: "relay_pill",
        state: "read",
        result: "confirmed",
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local trace failure never blocks the product action", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-trace-fail-"));
  const notDirectory = path.join(root, "not-a-directory");
  fs.writeFileSync(notDirectory, "file");
  try {
    assert.equal(appendLocalTrace({ event: "relay_staged", relayId: "relay_1" }, { home: notDirectory }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a batch preserves one content-free row per lifecycle event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-trace-batch-"));
  try {
    assert.equal(appendLocalTraces([
      { event: "relay_read_local", relayId: "one", title: "secret" },
      { event: "relay_read_local", relayId: "two", forHuman: "secret" },
    ], { home: root, now: () => "2026-08-20T12:00:00.000Z" }), true);
    const rows = fs.readFileSync(localTracePath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows, [
      { at: "2026-08-20T12:00:00.000Z", event: "relay_read_local", relayId: "one" },
      { at: "2026-08-20T12:00:00.000Z", event: "relay_read_local", relayId: "two" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
