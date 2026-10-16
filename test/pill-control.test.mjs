import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pillReadyTimeoutMs, pillStatusPath, relayCompanionHome, waitForPillReady } from "../src/pill-control.js";

test("pill status paths follow the same RELAY_HOME precedence as the overlay", () => {
  assert.equal(relayCompanionHome({ RELAY_HOME: "/tmp/primary", RELAY_COMPANION_HOME: "/tmp/legacy" }, "/Users/x"), "/tmp/primary");
  assert.equal(relayCompanionHome({ RELAY_COMPANION_HOME: "/tmp/legacy" }, "/Users/x"), "/tmp/legacy");
  assert.equal(relayCompanionHome({}, "/Users/x"), path.join("/Users/x", ".relay-companion"));
  assert.equal(pillStatusPath({ RELAY_HOME: "/tmp/relay" }, os.homedir()), path.join("/tmp/relay", "pill-status.json"));
});

test("waitForPillReady requires the caller nonce and an actually visible, undismissed window", async () => {
  const statuses = [
    { ready: true, visible: false, dismissed: true, reopenNonce: "old" },
    { ready: true, visible: true, dismissed: false, reopenNonce: "old" },
    { ready: true, visible: true, dismissed: false, reopenNonce: "expected" },
  ];
  let clock = 0;
  const result = await waitForPillReady("expected", {
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readStatus: () => statuses.shift() || null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.reopenNonce, "expected");
});

test("waitForPillReady reports a timeout instead of claiming blind launch success", async () => {
  let clock = 0;
  const result = await waitForPillReady("expected", {
    timeoutMs: 20,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readStatus: () => ({ ready: true, visible: false, dismissed: true, reopenNonce: "expected" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "pill_ready_timeout");
});

test("relay pill waits for a slow pill as long as the launcher that ran it still listens", () => {
  // Launchers up to 0.1.634 give the command 20 seconds; it used to stop at 12.
  assert.equal(pillReadyTimeoutMs(1_000), 17_000);
  assert.ok(pillReadyTimeoutMs(1_000) > 12_000);
  assert.equal(pillReadyTimeoutMs(3_500), 14_500);
  assert.ok(1_000 + pillReadyTimeoutMs(1_000) < 20_000, "exits before the launcher gives up on it");
  assert.equal(pillReadyTimeoutMs(15_000), 6_000, "a slow start still gets a real chance to confirm");
});

test('concurrent launches retain receipts for both callers', async () => {
  const result = await waitForPillReady('first', {
    readStatus: () => ({ ready: true, visible: true, dismissed: false,
      reopenNonce: 'second', presentedReopens: ['first', 'second'] }),
  });
  assert.equal(result.ok, true);
});
