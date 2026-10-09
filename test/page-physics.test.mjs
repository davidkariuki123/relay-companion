// The Inbox pages' physics, held to its opinions (overlay/page-physics.js).
import test from "node:test";
import assert from "node:assert/strict";
// The overlay script is a classic browser script; evaluate it the way the
// pill does and read what it hangs on the window.
import fs from "node:fs";
import vm from "node:vm";
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../overlay/page-physics.js", import.meta.url), "utf8"), context);
const { PHYS, rubber, unrubber, velocity, clamp, decide, springStep, WheelGesture } = context.window.RelayPagePhysics;

const W = 344;
// A trackpad: an event every 8 ms.
function feedAll(g, seq, { t0 = 1000, every = 8, pageMoving = false } = {}) {
  return seq.map(([dx, dy], i) => g.feed(t0 + i * every, dx, dy, { pageMoving }));
}
const coast = (from, n, ratio = .94) => Array.from({ length: n }, (_, i) => [from * Math.pow(ratio, i + 1), 0]);

test("a scroll is never touched — not even its first event — so it stays on the compositor", () => {
  const g = new WheelGesture();
  const acts = feedAll(g, Array.from({ length: 10 }, () => [4, 11]));
  assert.equal(g.phase, "y");
  assert.ok(acts.every((a) => !a.block && !a.grab && a.move === undefined));
});

test("the first event decides: horizontal only inside the 29° cone (|dx| > 1.8·|dy|, |dx| ≥ 1)", () => {
  const steep = new WheelGesture(); feedAll(steep, [[6, 3.5]]);
  assert.equal(steep.phase, "y");
  const tiny = new WheelGesture(); feedAll(tiny, [[.6, 0]]);
  assert.equal(tiny.phase, "y", "a sub-pixel twitch is not a swipe");
  const flat = new WheelGesture(); const [a] = feedAll(flat, [[6, 3]]);
  assert.equal(flat.phase, "x"); assert.equal(a.grab, true); assert.equal(a.block, true); assert.equal(a.move, 6);
});

test("once horizontal, every event is blocked — vertical noise never scrolls", () => {
  const g = new WheelGesture();
  const acts = feedAll(g, [[6, 1], ...Array.from({ length: 20 }, () => [10, 4])]);
  assert.ok(acts.every((a) => a.block));
});

test("the lift is three geometric decays in a row, and the coasting after it is swallowed", () => {
  const g = new WheelGesture();
  const acts = feedAll(g, [[6, 0], [10, 0], [12, 0], [12, 0], ...coast(12, 40)]);
  const lift = acts.findIndex((a) => a.release);
  assert.equal(lift, 4 + 2, "released on the third decaying event");
  assert.ok(acts.slice(lift + 1).every((a) => a.block && a.move === undefined && !a.grab), "momentum is swallowed, never moves the page");
});

test("a slowing finger is not a lift unless the decay is smooth", () => {
  const g = new WheelGesture();
  const acts = feedAll(g, [[6, 0], [12, 0], [9, 0], [11, 0], [8, 0], [10, 0], [7, 0]]);
  assert.ok(!acts.some((a) => a.release));
});

test("silence is a lift", () => {
  const g = new WheelGesture();
  feedAll(g, [[6, 0], [6, 0]]);
  assert.equal(g.silence(), true);
  assert.equal(g.phase, "idle");
});

test("nothing scrolls under a moving page", () => {
  const g = new WheelGesture();
  const acts = feedAll(g, Array.from({ length: 6 }, () => [0, 20]), { pageMoving: true });
  assert.ok(acts.every((a) => a.block && !a.deliverY));
});

test("a new gesture after the coast takes the page up again", () => {
  const g = new WheelGesture();
  feedAll(g, [[6, 0], [12, 0], [12, 0], ...coast(12, 10)]);
  const [again] = feedAll(g, [[8, 0]], { t0: 5000 });
  assert.equal(again.grab, true);
});

test("the page never leaves its frame", () => {
  assert.equal(clamp(-80, W), 0); assert.equal(clamp(W + 80, W), W); assert.equal(clamp(120, W), 120);
  const d = decide({ x: -192, v: -900, W, from: "chats" });
  assert.equal(d.x, 0); assert.equal(d.v, 0); assert.equal(d.to, "chats");
  const e = decide({ x: W + 50, v: 900, W, from: "list" });
  assert.equal(e.x, W); assert.equal(e.v, 0);
});

test("velocity is a least-squares slope over the last 100 ms", () => {
  const s = Array.from({ length: 20 }, (_, i) => [i * 8, i * 8 * 1.5]); // 1.5 px/ms
  assert.ok(Math.abs(velocity(s, 152) - 1500) < 1);
  assert.equal(velocity([[0, 0]], 10), 0);
  assert.equal(velocity(s, 400), 0, "stale samples say nothing");
});

test("the page is chosen by projection, with intent for deliberate flicks", () => {
  assert.equal(decide({ x: W * .45, v: 0, W, from: "chats" }).to, "chats");
  assert.equal(decide({ x: W * .55, v: 0, W, from: "chats" }).to, "list");
  assert.equal(decide({ x: W * .3, v: 2000, W, from: "chats" }).to, "list", "projection carries it");
  assert.equal(decide({ x: W * .15, v: 600, W, from: "chats" }).to, "list", "a deliberate flick commits from 12 %");
  assert.equal(decide({ x: W * .08, v: 600, W, from: "chats" }).to, "chats", "but not from less");
  assert.equal(decide({ x: W * .8, v: -600, W, from: "chats" }).to, "chats", "a flick back cancels");
});

test("every spring is critically damped: no overshoot, even after a hard flick", () => {
  assert.equal(decide({ x: W * .2, v: 0, W, from: "chats" }).spring, PHYS.HOME);
  assert.equal(decide({ x: W * .6, v: 200, W, from: "chats" }).spring, PHYS.SETTLE);
  assert.equal(decide({ x: W * .6, v: 2000, W, from: "chats" }).spring, PHYS.FLICK);
  const run = (state, target, spring) => { let s = { ...state }, max = -Infinity, n = 0; while (!s.done && n++ < 600) { s = springStep(s, target, spring, 1 / 60); max = Math.max(max, s.x); } return { s, max }; };
  const settle = run({ x: 200, v: 300 }, W, PHYS.SETTLE);
  assert.equal(settle.s.x, W); assert.ok(settle.max <= W + .25, "settle never overshoots");
  const flick = run({ x: 200, v: 2400 }, W, PHYS.FLICK);
  assert.equal(flick.s.x, W);
  assert.ok(flick.max <= W + .25, `a flick lands without a bump (${(flick.max - W).toFixed(2)} px over)`);
  const peek = run({ x: W * .24, v: 0 }, 0, PHYS.PEEK_HOME);
  assert.equal(peek.s.x, 0);
  let s = { x: W * .24, v: 0 }, min = Infinity; for (let i = 0; i < 300 && !s.done; i++) { s = springStep(s, 0, PHYS.PEEK_HOME, 1 / 60); min = Math.min(min, s.x); }
  assert.ok(min >= -.25, "the peek goes home without swinging past it");
});
