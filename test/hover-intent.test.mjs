import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../overlay/hover-intent.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename:"hover-intent.js" });
const { createHoverIntentMachine, DEFAULTS } = context.RelayHoverIntent;

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { at:now + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

function harness() {
  const clock = fakeClock();
  const events = [];
  const machine = createHoverIntentMachine({
    clock,
    onOpen:(id, zone) => events.push(["open", id, zone]),
    onClose:(id, reason) => events.push(["close", id, reason]),
  });
  return { clock, events, machine };
}

test("scroll closes immediately, waits 220ms, then requires four pixels of real movement", () => {
  const { clock, events, machine } = harness();
  machine.pointerMove({ id:"older", zone:"body", x:10, y:10 });
  clock.advance(DEFAULTS.bodyDwellMs);
  assert.equal(machine.getState().openId, "older");

  machine.scroll();
  assert.equal(machine.getState().openId, null);
  assert.deepEqual(events.at(-1), ["close", "older", "scroll"]);
  clock.advance(DEFAULTS.scrollQuietMs);
  machine.pointerMove({ id:"older", zone:"body", x:13.9, y:10 });
  clock.advance(DEFAULTS.bodyDwellMs + 100);
  assert.equal(machine.getState().openId, null, "a stationary cursor or sub-threshold movement cannot re-open after scroll");

  machine.pointerMove({ id:"older", zone:"body", x:14, y:10 });
  clock.advance(DEFAULTS.bodyDwellMs - 1);
  assert.equal(machine.getState().openId, null);
  clock.advance(1);
  assert.equal(machine.getState().openId, "older");
});

test("the lower seam opens in 180ms while the body deliberately waits 420ms", () => {
  const seam = harness();
  seam.machine.pointerMove({ id:"seam-row", zone:"seam", x:20, y:90 });
  seam.clock.advance(DEFAULTS.seamDwellMs - 1);
  assert.equal(seam.machine.getState().openId, null);
  seam.clock.advance(1);
  assert.equal(seam.machine.getState().openId, "seam-row");

  const body = harness();
  body.machine.pointerMove({ id:"body-row", zone:"body", x:20, y:20 });
  body.clock.advance(DEFAULTS.seamDwellMs + 50);
  assert.equal(body.machine.getState().openId, null);
  body.clock.advance(DEFAULTS.bodyDwellMs - DEFAULTS.seamDwellMs - 50);
  assert.equal(body.machine.getState().openId, "body-row");
});

test("fast flyovers never open and drift restarts the dwell clock", () => {
  const flyover = harness();
  flyover.machine.pointerMove({ x:0, y:0 });
  flyover.clock.advance(1);
  flyover.machine.pointerMove({ id:"flyover", zone:"seam", x:100, y:100 });
  flyover.clock.advance(40);
  flyover.machine.pointerMove({ x:180, y:100 });
  flyover.clock.advance(DEFAULTS.seamDwellMs + DEFAULTS.fastSettleMs + 20);
  assert.equal(flyover.machine.getState().openId, null);

  const drift = harness();
  drift.machine.pointerMove({ id:"drift", zone:"seam", x:10, y:10 });
  drift.clock.advance(100);
  drift.machine.pointerMove({ id:"drift", zone:"seam", x:18, y:10 });
  drift.clock.advance(DEFAULTS.seamDwellMs - 1);
  assert.equal(drift.machine.getState().openId, null, "more than seven pixels restarts dwell");
  drift.clock.advance(1);
  assert.equal(drift.machine.getState().openId, "drift");
});

test("exit grace prevents seam flicker and opening a second row replaces the first", () => {
  const { clock, events, machine } = harness();
  machine.pointerMove({ id:"first", zone:"seam", x:10, y:10 });
  clock.advance(DEFAULTS.seamDwellMs);
  machine.pointerLeave();
  clock.advance(DEFAULTS.exitGraceMs - 1);
  assert.equal(machine.getState().openId, "first");
  machine.pointerMove({ id:"first", zone:"seam", x:11, y:10, blocked:true });
  clock.advance(DEFAULTS.exitGraceMs + 20);
  assert.equal(machine.getState().openId, "first", "returning over an expanded provider control cancels collapse");

  machine.pointerMove({ id:"second", zone:"seam", x:40, y:10 });
  clock.advance(DEFAULTS.seamDwellMs + DEFAULTS.fastSettleMs);
  assert.equal(machine.getState().openId, "second");
  assert.ok(events.some((event) => event[0] === "close" && event[1] === "first" && event[2] === "replaced"));

  machine.pointerLeave();
  clock.advance(DEFAULTS.exitGraceMs);
  assert.equal(machine.getState().openId, null);
});
