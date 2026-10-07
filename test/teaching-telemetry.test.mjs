import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTeachingTelemetry, SHOWN_EVERY_MS, MAX_PER_HOUR } = require("../overlay/teaching-telemetry.cjs");

function harness() {
  const sent = [];
  let clock = 1_000_000;
  const telemetry = createTeachingTelemetry({ send: (event, context) => { sent.push(context ? [event, context] : [event]); }, now: () => clock });
  return { sent, telemetry, advance: (ms) => { clock += ms; } };
}

test("card actions become content-free onboarding events", () => {
  const { sent, telemetry } = harness();
  telemetry.record("expanded");
  telemetry.record("example_chosen", "check_inbox");
  telemetry.record("example_copied", "check_inbox");
  telemetry.record("minimised");
  assert.deepEqual(sent, [
    ["tip_expanded"],
    ["tip_example_chosen", { way: "check_inbox" }],
    ["tip_example_copied", { way: "check_inbox" }],
    ["tip_minimised"],
  ]);
});

test("unknown names, unknown ways and misplaced ways are dropped", () => {
  const { sent, telemetry } = harness();
  assert.equal(telemetry.record("deleted_everything"), false);
  assert.equal(telemetry.record("example_copied", "a prompt someone typed"), false);
  assert.equal(telemetry.record("example_copied"), false);
  assert.equal(telemetry.record("expanded", "share_link"), false);
  assert.deepEqual(sent, []);
});

test("shown counts stretches on screen, not every flicker, and restarts for a new account", () => {
  const { sent, telemetry, advance } = harness();
  assert.equal(telemetry.record("shown"), true);
  advance(SHOWN_EVERY_MS - 1);
  assert.equal(telemetry.record("shown"), false);
  advance(1);
  assert.equal(telemetry.record("shown"), true);
  telemetry.reset();
  assert.equal(telemetry.record("shown"), true);
  assert.equal(sent.length, 3);
});

test("a runaway renderer is capped per hour", () => {
  const { sent, telemetry, advance } = harness();
  for (let i = 0; i < MAX_PER_HOUR + 10; i++) telemetry.record("expanded");
  assert.equal(sent.length, MAX_PER_HOUR);
  advance(60 * 60 * 1000);
  assert.equal(telemetry.record("expanded"), true);
});

test("reading a show-once way is always sent, with its way", () => {
  const { sent, telemetry } = harness();
  assert.equal(telemetry.record("example_read"), false, "a read names its way");
  for (let i = 0; i < MAX_PER_HOUR; i++) telemetry.record("expanded");
  assert.equal(telemetry.record("example_read", "pull_together"), true, "the hourly cap never drops a read");
  assert.deepEqual(sent.at(-1), ["tip_example_read", { way: "pull_together" }]);
});

test("a failing send never throws into the inbox", async () => {
  const rejecting = createTeachingTelemetry({ send: async () => { throw new Error("offline"); } });
  assert.equal(rejecting.record("expanded"), true);
  const throwing = createTeachingTelemetry({ send: () => { throw new Error("no client"); } });
  assert.equal(throwing.record("expanded"), true);
  await new Promise((resolve) => setImmediate(resolve));
});
