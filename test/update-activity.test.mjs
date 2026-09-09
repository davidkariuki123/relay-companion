import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginCall, drainCalls, activeCalls } from "../bootstrap/update-activity.cjs";

test("activation drains admitted calls and blocks new calls until the barrier is released", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-drain-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const releaseCall = beginCall({ homeDir });
  const releaseDrain = await drainCalls({ homeDir, sleep: async () => {
    assert.throws(() => beginCall({ homeDir }), /updating/);
    releaseCall();
  } });
  assert.throws(() => beginCall({ homeDir }), /updating/);
  releaseDrain();
  beginCall({ homeDir })();
});

test("a long call defers activation without being killed or replayed", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-drain-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const release = beginCall({ homeDir });
  await assert.rejects(drainCalls({ homeDir, attempts: 1, sleep: async () => {} }), /still active/);
  beginCall({ homeDir })();
  release();
});

test("an unreadable work owner cannot be treated as proof of idle", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-drain-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  beginCall({ homeDir })();
  const file = path.join(homeDir, ".relay", "recovery", "activity", "call-bad.json");
  fs.writeFileSync(file, JSON.stringify({ pid: "unknown" }));
  assert.equal(activeCalls({ homeDir }), null);
  await assert.rejects(drainCalls({ homeDir, attempts: 1, sleep: async () => {} }), /still active/);
  assert.equal(fs.existsSync(file), true);
});
