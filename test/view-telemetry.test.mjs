import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createViewTelemetry, FLUSH_EVERY_MS, SAVE_EVERY_MS } = require("../overlay/view-telemetry.cjs");

const MIN = 60 * 1000;

function harness({ saved = null, answer = { ok: true }, fullApp = true } = {}) {
  let clock = Date.parse("2026-10-09T08:00:00Z");
  let disk = saved;
  const sent = [];
  let reply = answer;
  const options = {
    now: () => clock,
    load: () => disk,
    save: (state) => { disk = JSON.parse(JSON.stringify(state)); },
    send: async (report) => { sent.push(report); return typeof reply === "function" ? reply() : reply; },
    fullAppAvailable: () => fullApp,
  };
  const telemetry = createViewTelemetry(options);
  return {
    telemetry,
    sent,
    advance: (ms) => { clock += ms; },
    disk: () => disk,
    answer: (next) => { reply = next; },
    restart: () => createViewTelemetry(options),
  };
}

function transitions(report) {
  return Object.fromEntries(report.transitions.map((t) => [`${t.from}>${t.to}>${t.cause}`, t.count]));
}

test("time in each view and every switch with its cause", async () => {
  const { telemetry, sent, advance } = harness();
  telemetry.view("pill", "launch");
  advance(10 * MIN);
  telemetry.view("card", "pill_tap");
  advance(2 * MIN);
  telemetry.view("full", "expand_button");
  advance(30 * MIN);
  telemetry.view("card", "expand_button");
  advance(1 * MIN);
  telemetry.view("pill", "minimise_button");
  advance(5 * MIN);
  telemetry.view("hidden", "close");
  advance(3 * MIN);
  await telemetry.flush();

  assert.equal(sent.length, 1);
  const [report] = sent;
  assert.equal(report.fullAppAvailable, true);
  assert.deepEqual(report.views, {
    full: { ms: 30 * MIN, focusedMs: 0, entries: 1 },
    card: { ms: 3 * MIN, focusedMs: 0, entries: 2 },
    pill: { ms: 15 * MIN, focusedMs: 0, entries: 2 },
    hidden: { ms: 3 * MIN, focusedMs: 0, entries: 1 },
  });
  assert.deepEqual(transitions(report), {
    "off>pill>launch": 1,
    "pill>card>pill_tap": 1,
    "card>full>expand_button": 1,
    "full>card>expand_button": 1,
    "card>pill>minimise_button": 1,
    "pill>hidden>close": 1,
  });
});

test("a repeated view is not a switch, and a cause expires", () => {
  const { telemetry, advance } = harness();
  telemetry.view("card");
  telemetry.view("card", "pill_tap");
  telemetry.cause("expand_button");
  advance(10 * 1000);
  telemetry.view("full");
  assert.deepEqual(telemetry.snapshot().totals.transitions, { "off>card>launch": 1, "card>full>other": 1 });
});

test("a cause from main carries over to the renderer's report of the same switch", () => {
  const { telemetry, advance } = harness();
  telemetry.view("hidden");
  telemetry.cause("menu_bar");
  telemetry.view("hidden"); // the window shows the parked card first
  advance(200);
  telemetry.view("card");
  assert.equal(telemetry.snapshot().totals.transitions["hidden>card>menu_bar"], 1);
});

test("time in front of other apps is counted apart from time on screen", async () => {
  const { telemetry, sent, advance } = harness();
  telemetry.view("full", "dock");
  telemetry.focus(true);
  advance(4 * MIN);
  telemetry.focus(false);
  advance(6 * MIN);
  telemetry.focus(true);
  advance(1 * MIN);
  await telemetry.flush();
  assert.deepEqual(sent[0].views.full, { ms: 11 * MIN, focusedMs: 5 * MIN, entries: 1 });
});

test("time asleep or locked is not counted", async () => {
  const { telemetry, sent, advance } = harness();
  telemetry.view("pill");
  advance(5 * MIN);
  telemetry.away(true, "pill");
  advance(8 * 60 * MIN);
  telemetry.view("card"); // nothing switches while away
  telemetry.away(false, "pill");
  advance(5 * MIN);
  await telemetry.flush();
  assert.deepEqual(sent[0].views, { pill: { ms: 10 * MIN, focusedMs: 0, entries: 1 } });
});

test("Quit Relay and other stops are told apart, and nothing counts after", async () => {
  const { telemetry, sent, advance } = harness();
  telemetry.view("full");
  advance(MIN);
  telemetry.stop("quit");
  telemetry.stop("exit"); // before-quit follows Quit Relay
  telemetry.view("hidden"); // the window hides on the way out
  await telemetry.flush();
  assert.equal(sent[0].quits, 1);
  assert.equal(sent[0].exits, 0);
  assert.deepEqual(transitions(sent[0]), { "off>full>launch": 1, "full>off>quit": 1 });
});

test("a report that cannot be sent goes with the next one", async () => {
  const { telemetry, sent, advance, answer } = harness({ answer: { ok: false, retry: true } });
  telemetry.view("card");
  advance(10 * MIN);
  assert.equal(await telemetry.flush(), false);
  answer({ ok: true });
  advance(5 * MIN);
  telemetry.view("pill", "pill_tap");
  advance(5 * MIN);
  assert.equal(await telemetry.flush(), true);
  assert.deepEqual(sent[1].views, {
    card: { ms: 15 * MIN, focusedMs: 0, entries: 1 },
    pill: { ms: 5 * MIN, focusedMs: 0, entries: 1 },
  });
  assert.equal(sent[1].periodStart, sent[0].periodStart);
  // Sent: the next report starts empty.
  advance(MIN);
  await telemetry.flush();
  assert.deepEqual(sent[2].views, { pill: { ms: MIN, focusedMs: 0, entries: 0 } });
});

test("a report the API refuses as malformed is dropped", async () => {
  const { telemetry, sent, advance, answer } = harness({ answer: { ok: false, retry: false } });
  telemetry.view("card");
  advance(MIN);
  await telemetry.flush();
  answer({ ok: true });
  advance(MIN);
  await telemetry.flush();
  assert.deepEqual(sent[1].views, { card: { ms: MIN, focusedMs: 0, entries: 0 } });
  assert.deepEqual(sent[1].transitions, []);
});

test("nothing counted, nothing sent", async () => {
  const { telemetry, sent } = harness();
  assert.equal(await telemetry.flush(), false);
  assert.equal(sent.length, 0);
});

test("a restart keeps the totals; a stop nobody announced counts only to the last save", async () => {
  const first = harness();
  first.telemetry.view("full", "dock");
  first.advance(SAVE_EVERY_MS);
  await first.telemetry.tick(); // saves
  first.advance(20 * MIN); // then Relay is killed: these minutes are never counted
  const second = first.restart();
  second.view("pill", "launch");
  first.advance(MIN);
  await second.flush();
  const report = first.sent[0];
  assert.deepEqual(report.views.full, { ms: SAVE_EVERY_MS, focusedMs: 0, entries: 1 });
  assert.deepEqual(report.views.pill, { ms: MIN, focusedMs: 0, entries: 1 });
  assert.equal(report.unfinished, 1);
  assert.deepEqual(transitions(report), { "off>full>dock": 1, "full>off>exit": 1, "off>pill>launch": 1 });
});

test("a report in flight when Relay stopped is sent again after the restart", async () => {
  const first = harness({ answer: () => new Promise(() => {}) }); // never answers
  first.telemetry.view("card");
  first.advance(10 * MIN);
  void first.telemetry.flush();
  first.answer({ ok: true });
  const second = first.restart();
  await second.flush();
  assert.equal(first.sent.length, 2);
  assert.deepEqual(first.sent[1].views.card, { ms: 10 * MIN, focusedMs: 0, entries: 1 });
});

test("tick saves every minute and sends every half hour", async () => {
  const { telemetry, sent, advance, disk } = harness();
  telemetry.view("pill");
  advance(SAVE_EVERY_MS);
  await telemetry.tick();
  assert.equal(disk().totals.views.pill.ms, SAVE_EVERY_MS);
  assert.equal(sent.length, 0);
  advance(FLUSH_EVERY_MS);
  await telemetry.tick();
  assert.equal(sent.length, 1);
});

test("the report says whether this account has the full app", async () => {
  const { telemetry, sent, advance } = harness({ fullApp: false });
  telemetry.view("expanded", "expand_button");
  advance(MIN);
  await telemetry.flush();
  assert.equal(sent[0].fullAppAvailable, false);
  assert.ok(sent[0].views.expanded);
});
