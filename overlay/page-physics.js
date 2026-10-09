// The physics of the Inbox's two pages (Chats ⇄ Relays and Tasks), pure.
// No DOM: inbox-pages.js feeds it wheel events and frame times and draws
// what it returns, and test/page-physics.test.mjs holds it to its opinions.
//
// Opinions, each one a number. Change a number only with a reason.
//  · One axis per gesture, decided on its FIRST event: horizontal only if it
//    starts inside a 29° cone (|dx| > 1.8·|dy|, |dx| ≥ 1). Anything else is a
//    scroll and is never touched — not even held — so ordinary scrolling
//    stays on the compositor (Chromium only lets a page cancel a scroll's
//    first event; leaving it alone keeps the whole scroll off the main
//    thread). The other axis is dead until the fingers are gone AND the
//    hardware's coasting has ended. Nothing scrolls under a moving page.
//  · The page is glued to the fingers, 1:1.
//  · Velocity is a least-squares slope over the last 100 ms of finger
//    positions — never one event's delta, which on a trackpad is noise.
//  · The lift is found, not guessed: macOS keeps sending wheel events after
//    the fingers leave, each 78–98.5 % of the last. Three such in a row ARE
//    the lift; 120 ms of silence is one too. What follows a lift is the
//    hardware's momentum, and is swallowed whole.
//  · The page is chosen by projection at UIKit's paging rate: where it would
//    stop = x + v·0.099 s. Past half, it goes. A deliberate flick (≥ 550 px/s)
//    commits from as little as 12 % of the way; a flick back cancels from as
//    far as 88 %.
//  · Every spring starts at the finger's own speed and is critically damped:
//    it arrives and never wobbles, never overshoots.
//  · The page never leaves its frame. There is nothing beyond the two pages
//    to show, so no rubber band and no bump at either end (David, 2026-10-09:
//    "it over extends the scroll into empty space").
//  · The list rides over Chats; Chats moves at a third of its speed and dims —
//    UIKit's push, so which page is on top is never ambiguous.
(function (root) {
  "use strict";

  const PHYS = Object.freeze({
    CONE: 1.8, MIN_DX: 1, RUBBER: .55, PARALLAX: .3, DIM: .55,
    VEL_WINDOW: 100, SILENCE: 120, COAST_MIN: .78, COAST_MAX: .985, COAST_RUN: 3,
    PROJECT: .099, INTENT_V: 550, INTENT_MIN: .12,
    SETTLE: Object.freeze({ response: .36, damping: 1 }),
    FLICK: Object.freeze({ response: .4, damping: 1, at: 1400 }),
    HOME: Object.freeze({ response: .34, damping: 1 }),
    TAP: Object.freeze({ response: .42, damping: 1 }),
    PEEK_OUT: Object.freeze({ response: .5, damping: 1 }),
    PEEK_HOME: Object.freeze({ response: .5, damping: 1 }),
  });

  // Apple's rubber band: d px of finger beyond an end shows as rubber(d) px.
  const rubber = (d, dim) => (1 - 1 / (d * PHYS.RUBBER / dim + 1)) * dim;
  // Its inverse, to catch a page that is resting in the band.
  const unrubber = (r, dim) => { const k = Math.min(Math.max(r, 0), dim * .985) / dim; return k / (1 - k) * dim / PHYS.RUBBER; };
  // d(rubber)/dd, to carry a finger's velocity into looking-space.
  const rubberSlope = (d, dim) => 1 / Math.pow(d * PHYS.RUBBER / dim + 1, 2);

  // Least-squares slope of [t ms, x px] samples inside the window, in px/s.
  function velocity(samples, now, windowMs = PHYS.VEL_WINDOW) {
    const s = samples.filter(([t]) => now - t <= windowMs);
    if (s.length < 2) return 0;
    const n = s.length;
    const mt = s.reduce((a, [t]) => a + t, 0) / n, mx = s.reduce((a, [, x]) => a + x, 0) / n;
    let num = 0, den = 0;
    for (const [t, x] of s) { num += (t - mt) * (x - mx); den += (t - mt) ** 2; }
    return den ? num / den * 1000 : 0;
  }

  // Where finger-space x shows on screen (inside [0, W] they are the same).
  function looking(x, W) {
    if (x < 0) return -rubber(-x, W);
    if (x > W) return W + rubber(x - W, W);
    return x;
  }
  // The decision at the lift. x and v are finger-space; from is the page the
  // gesture began on ("chats" | "list"). Returns the looking-space start, the
  // velocity to start the spring with, the page, and the spring to use.
  function decide({ x, v, W, from }) {
    const lx = Math.max(0, Math.min(W, x));
    // Against an end, the page is not moving outward, whatever the fingers do.
    const lv = (lx === 0 && v < 0) || (lx === W && v > 0) ? 0 : v;
    let toList = lx + lv * PHYS.PROJECT > W / 2;
    if (lv > PHYS.INTENT_V && lx > W * PHYS.INTENT_MIN) toList = true;
    if (lv < -PHYS.INTENT_V && lx < W * (1 - PHYS.INTENT_MIN)) toList = false;
    const to = toList ? "list" : "chats";
    const home = to === from;
    const spring = home ? PHYS.HOME : Math.abs(lv) >= PHYS.FLICK.at ? PHYS.FLICK : PHYS.SETTLE;
    return { x: lx, v: lv, to, target: toList ? W : 0, spring };
  }

  // The page, clamped to its frame.
  const clamp = (x, W) => Math.max(0, Math.min(W, x));

  // One step of a damped spring (semi-implicit Euler, 1/480 s substeps).
  function springStep(state, target, { response, damping }, dt) {
    const k = Math.pow(2 * Math.PI / response, 2), c = 4 * Math.PI * damping / response;
    let { x, v } = state;
    let left = Math.min(dt, .034);
    while (left > 1e-6) { const h = Math.min(left, 1 / 480); v += (-k * (x - target) - c * v) * h; x += v * h; left -= h; }
    const done = Math.abs(x - target) < .25 && Math.abs(v) < 5;
    return done ? { x: target, v: 0, done } : { x, v, done };
  }

  // The wheel stream, one gesture at a time. feed() returns what to do with
  // an event: { block } always; { grab, move } when the page is taken up and
  // follows; { deliverY } when held pixels belong to a vertical scroll;
  // { release } when the fingers have lifted.
  class WheelGesture {
    constructor() { this.reset(); this.lastT = -1e9; }
    reset() { this.phase = "idle"; this.acc = 0; this.accY = 0; this.run = 0; this.lastAbs = 0; }
    feed(t, dx, dy, { pageMoving = false } = {}) {
      const gap = t - this.lastT; this.lastT = t;
      const fresh = gap > PHYS.SILENCE;
      const mag = Math.hypot(dx, dy);
      if (this.phase === "coast") {
        if (!fresh && mag <= this.lastAbs * 1.03 + .6) { this.lastAbs = mag; return { block: true }; }
        this.reset();
      }
      if (this.phase === "y" && !fresh) return { block: false };
      if (this.phase === "x" && fresh) this.reset();   // a lift we never heard about
      if (this.phase !== "x" && pageMoving && !(Math.abs(dx) > PHYS.CONE * Math.abs(dy))) return { block: true };
      if (this.phase !== "x") {
        // A new gesture: its first event decides, and a scroll is left alone.
        this.reset();
        if (Math.abs(dx) >= PHYS.MIN_DX && Math.abs(dx) > PHYS.CONE * Math.abs(dy)) {
          this.phase = "x"; this.lastAbs = Math.abs(dx);
          return { block: true, grab: true, move: dx };
        }
        this.phase = "y";
        return { block: false };
      }
      // Horizontal: glued; vertical is dead. The first of three geometric
      // decays in a row is the lift.
      const abs = Math.abs(dx), r = this.lastAbs ? abs / this.lastAbs : 0;
      this.run = r >= PHYS.COAST_MIN && r <= PHYS.COAST_MAX ? this.run + 1 : 0;
      this.lastAbs = abs;
      if (this.run >= PHYS.COAST_RUN) { this.phase = "coast"; this.lastAbs = mag; return { block: true, move: dx, release: true }; }
      return { block: true, move: dx };
    }
    // Called when the stream has been silent for SILENCE ms.
    silence() { if (this.phase !== "x") return false; this.reset(); return true; }
  }

  const api = { PHYS, rubber, unrubber, rubberSlope, velocity, looking, clamp, decide, springStep, WheelGesture };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RelayPagePhysics = api;
})(typeof window !== "undefined" ? window : globalThis);
