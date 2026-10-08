// THE FULL APP (David and Shane, 2026-10-08): Expand fills the screen and is
// an ordinary app while it does; Collapse puts the pill back where it was.
// Runs main.cjs's own surface functions against a stub window and screen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const block = main.slice(main.indexOf("let appSurface = null;"), main.indexOf("const HIT_IN = 6;"));

function harness() {
  const calls = [];
  const bounds = { x: 604, y: 41, width: 900, height: 800 };
  const win = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: (b) => { calls.push(["setBounds", b]); Object.assign(bounds, b); },
    setAlwaysOnTop: (v) => calls.push(["alwaysOnTop", v]),
    moveTop: () => calls.push(["moveTop"]),
    focus: () => calls.push(["focus"]),
    isVisible: () => true,
    webContents: { send: (channel, value) => calls.push(["send", channel, value]) },
  };
  const app = { dock: { show: () => { calls.push(["dock", "show"]); return Promise.resolve(); }, hide: () => calls.push(["dock", "hide"]), setIcon: () => {} }, focus: () => calls.push(["appFocus"]) };
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 33, width: 1512, height: 894 } }), getPrimaryDisplay: () => null };
  const run = Function("win", "app", "screen", "calls", `
    const CARD_MAX = { w: 900, h: 800 };
    const FIXED_OVERLAY_SURFACE = true;
    const RELAY_BUNDLE_IDS = ["work.relay.application"];
    const process = { platform: "darwin" };
    const path = { join: (...p) => p.join("/") };
    const __dirname = "/overlay";
    const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    const perf = { inc() {} };
    const execFile = (...a) => calls.push(["execFile", a[1]]);
    let frontmost = "com.anthropic.claudefordesktop";
    function frontmostBundleId(cb) { cb(frontmost); }
    let cardSize = { w: 344, h: 524 };
    let overlayElevated = true;
    function setOverlayElevated(next) { if (appSurface) next = false; overlayElevated = Boolean(next); calls.push(["elevated", overlayElevated]); }
    function showOverlayWindow() { calls.push(["show"]); }
    function reinforceSpacePresence() {}
    function setImmediate(fn) { fn(); }
    function setTimeout() {}
    ${block}
    return {
      size: (w, h, settled) => { cardSize = { w, h }; return syncAppSurfaceForCard(w, h, { settled }); },
      max: () => overlayCardMax(),
      inset: () => appSurfaceInset(),
      active: () => Boolean(appSurface),
      elevated: () => overlayElevated,
      front: (b) => { frontmost = b; },
    };
  `);
  return { calls, bounds, api: run(win, app, screen, calls) };
}

test("Expand grows the pill's surface to the screen and makes Relay an ordinary app", () => {
  const { calls, bounds, api } = harness();
  assert.equal(api.size(344, 524), null, "the small card never touches the surface");
  api.size(1512, 894);
  assert.deepEqual(bounds, { x: 0, y: 33, width: 1512, height: 894 }, "the surface is the work area");
  assert.deepEqual(api.max(), { w: 1512, h: 894 });
  assert.ok(calls.some((c) => c[0] === "alwaysOnTop" && c[1] === false), "not floating above other apps");
  assert.equal(api.elevated(), false);
  assert.ok(calls.some((c) => c[0] === "dock" && c[1] === "show"), "in the Dock and Cmd+Tab");
  assert.ok(calls.some((c) => c[0] === "focus"), "the app you expanded is in front");
  const inset = calls.find((c) => c[0] === "send" && c[1] === "relay:surfaceInset");
  assert.deepEqual(inset[2], { top: 8, right: 8 }, "the small card's place inside the grown surface");
  assert.deepEqual(api.inset(), { top: 0, right: 0 }, "the full card fills the surface");
});

test("Collapse returns the pill to exactly where it was, on top, and hands the screen back", () => {
  const { calls, bounds, api } = harness();
  api.size(1512, 894);
  api.front("work.relay.application"); // the full app is the app in front
  api.size(344, 524, false);
  assert.equal(api.active(), true, "the surface waits for the fold to settle");
  assert.deepEqual(api.inset(), { top: 8, right: 8 }, "the folding card shrinks toward its place");
  api.size(344, 524, true);
  assert.equal(api.active(), false);
  assert.deepEqual(bounds, { x: 604, y: 41, width: 900, height: 800 });
  assert.equal(api.elevated(), true, "floating again");
  assert.ok(calls.some((c) => c[0] === "dock" && c[1] === "hide"));
  assert.deepEqual(calls.find((c) => c[0] === "execFile")?.[1], ["-b", "com.anthropic.claudefordesktop"], "the app that was in front comes back");
});

test("Collapse never yanks focus from an app the person already switched to", () => {
  const { calls, api } = harness();
  api.size(1512, 894);
  api.front("com.google.Chrome");
  api.size(344, 524, true);
  assert.equal(calls.some((c) => c[0] === "execFile"), false);
});

test("the renderer sizes the expanded app to the screen and places the card at the surface inset", () => {
  assert.match(html, /function wideSize\(\) \{\n\s+const aw = Number\(window\.screen\?\.availWidth\)/);
  assert.match(html, /position:absolute; top:var\(--surface-top, 0px\); right:var\(--surface-right, 0px\);/);
  assert.match(html, /window\.relay\.onSurfaceInset\?\.\(/);
  assert.match(main, /if \(appSurface\) next = false;/, "the full app is never re-elevated by the frontmost poll");
  assert.match(main, /if \(appSurface\) return \{ \.\.\.appSurface\.workArea \};/, "re-showing the full app never shrinks it");
});
