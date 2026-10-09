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
    setVisibleOnAllWorkspaces: (...a) => calls.push(["allSpaces", ...a]),
    moveTop: () => calls.push(["moveTop"]),
    focus: () => calls.push(["focus"]),
    isVisible: () => true,
    webContents: { send: (channel, value) => calls.push(["send", channel, value]) },
  };
  const app = { dock: { show: () => { calls.push(["dock", "show"]); return Promise.resolve(); }, hide: () => calls.push(["dock", "hide"]), setIcon: () => {} }, focus: () => calls.push(["appFocus"]) };
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 33, width: 1512, height: 894 } },
    { id: 2, bounds: { x: 1512, y: 0, width: 2560, height: 1440 }, workArea: { x: 1512, y: 25, width: 2560, height: 1415 } },
  ];
  const pointer = { x: 1400, y: 60 };
  const on = (p) => displays.find((d) => p.x >= d.workArea.x && p.x < d.workArea.x + d.workArea.width) || displays[0];
  const screen = {
    getCursorScreenPoint: () => ({ ...pointer }),
    getDisplayNearestPoint: (p) => on(p),
    getDisplayMatching: (b) => on({ x: b.x + 1, y: b.y + 1 }),
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
  };
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
      refit: () => appSurfaceRefit(),
    };
  `);
  return { calls, bounds, displays, pointer, api: run(win, app, screen, calls) };
}

test("Expand grows the pill's surface to the screen and makes Relay an ordinary app", () => {
  const { calls, bounds, api } = harness();
  assert.equal(api.size(344, 524), null, "the small card never touches the surface");
  api.size(1512, 949);
  assert.deepEqual(bounds, { x: 0, y: 33, width: 1512, height: 949 }, "the surface is the whole screen below the menu bar, the Dock's strip included");
  assert.deepEqual(api.max(), { w: 1512, h: 949 });
  assert.ok(calls.some((c) => c[0] === "alwaysOnTop" && c[1] === false), "not floating above other apps");
  assert.equal(api.elevated(), false);
  assert.ok(calls.some((c) => c[0] === "dock" && c[1] === "show"), "in the Dock and Cmd+Tab");
  assert.deepEqual(calls.find((c) => c[0] === "allSpaces"), ["allSpaces", false, { skipTransformProcessType: true }],
    "on its own Space like any app, and the Dock icon is not toggled as a side effect");
  assert.ok(calls.some((c) => c[0] === "focus"), "the app you expanded is in front");
  const inset = calls.find((c) => c[0] === "send" && c[1] === "relay:surfaceInset");
  assert.deepEqual(inset[2], { top: 8, right: 8, width: 1512, height: 949 }, "the small card's place inside the grown surface, and the area it fills");
  assert.deepEqual(api.inset(), { top: 0, right: 0 }, "the full card fills the surface");
});

test("Collapse returns the pill to exactly where it was, on top, and hands the screen back", () => {
  const { calls, bounds, api } = harness();
  api.size(1512, 949);
  api.front("work.relay.application"); // the full app is the app in front
  api.size(344, 524, false);
  assert.equal(api.active(), true, "the surface waits for the fold to settle");
  assert.deepEqual(api.inset(), { top: 8, right: 8 }, "the folding card shrinks toward its place");
  api.size(344, 524, true);
  assert.equal(api.active(), false);
  assert.deepEqual(bounds, { x: 604, y: 41, width: 900, height: 800 });
  assert.equal(api.elevated(), true, "floating again");
  assert.ok(calls.some((c) => c[0] === "dock" && c[1] === "hide"));
  assert.deepEqual(calls.filter((c) => c[0] === "allSpaces").at(-1), ["allSpaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    "the pill follows you to every Space again");
  assert.deepEqual(calls.find((c) => c[0] === "execFile")?.[1], ["-b", "com.anthropic.claudefordesktop"], "the app that was in front comes back");
});

test("Collapse never yanks focus from an app the person already switched to", () => {
  const { calls, api } = harness();
  api.size(1512, 949);
  api.front("com.google.Chrome");
  api.size(344, 524, true);
  assert.equal(calls.some((c) => c[0] === "execFile"), false);
});

test("the renderer sizes the expanded app to the screen and places the card at the surface inset", () => {
  assert.match(html, /function wideSize\(\) \{\n\s+const aw = Number\(window\.screen\?\.availWidth\)/);
  assert.match(html, /position:absolute; top:var\(--surface-top, 0px\); right:var\(--surface-right, 0px\);/);
  assert.match(html, /window\.relay\.onSurfaceInset\?\.\(/);
  assert.match(main, /if \(appSurface\) next = false;/, "the full app is never re-elevated by the frontmost poll");
  assert.match(main, /if \(appSurface\) return \{ \.\.\.appSurfaceRefit\(\) \};/, "re-showing the full app never shrinks it");
  assert.match(main, /showInactiveOnAllSpaces\(win, \{ force, userInitiated, alwaysOnTop: overlayElevated, allSpaces: !appSurface \}\)/, "a Space switch never re-shows the full app");
  assert.doesNotMatch(main, /reinforceSpacePresence\(win, \{ alwaysOnTop: overlayElevated \}\)/, "every presence repair knows about the full app");
  assert.match(html, /if \(payload\.features\?\.fullAppExpand !== true\) \{\n\s+return \{ w: Math\.max\(READER\.w, Math\.min\(WIDE\.w, aw - 48\)\)/, "without the developer gate Expand keeps the two-thirds card");
});

test("the full app opens on the screen under the pointer, and a pill elsewhere grows from that screen's corner", () => {
  const { calls, bounds, pointer, api } = harness();
  pointer.x = 2000; pointer.y = 400; // looking at the second screen
  api.size(2560, 1415);
  assert.deepEqual(bounds, { x: 1512, y: 25, width: 2560, height: 1415 });
  const inset = calls.find((c) => c[0] === "send" && c[1] === "relay:surfaceInset");
  assert.deepEqual(inset[2], { top: 0, right: 0, width: 2560, height: 1415 });
  api.size(344, 524, true);
  assert.deepEqual(bounds, { x: 604, y: 41, width: 900, height: 800 }, "Collapse puts the pill back on its own screen");
});

test("a screen that changes under the full app refits it, and an unplugged one hands it to another", () => {
  const { displays, api } = harness();
  api.size(1512, 949);
  displays[0].bounds = { x: 0, y: 0, width: 1728, height: 1117 }; // a new resolution
  displays[0].workArea = { x: 0, y: 33, width: 1728, height: 1030 };
  assert.deepEqual(api.refit(), { x: 0, y: 33, width: 1728, height: 1084 });
  displays.splice(0, 1); // unplugged
  const moved = api.refit();
  assert.deepEqual(moved, { x: 1512, y: 25, width: 2560, height: 1415 });
});

// THE FULL APP ON WINDOWS (2026-10-09): the card-sized window drops to the
// normal level and drops its hidden owner, so it has a taskbar button and an
// Alt-Tab entry; Collapse owns it again and puts it back on top.
function windowsHarness({ platform = "win32", topmost = true } = {}) {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    setAlwaysOnTop: (...a) => calls.push(["alwaysOnTop", ...a]),
    focus: () => calls.push(["focus"]),
  };
  const owner = { id: "owner" };
  const run = Function("win", "pillOwner", "calls", "platform", "topmost", `
    const CARD_MAX = { w: 900, h: 800 };
    const FIXED_OVERLAY_SURFACE = platform === "darwin";
    const process = { platform, env: {} };
    let cardSize = { w: 344, h: 524 };
    let overlayElevated = true;
    function setCompanionAppWindow(w, on, { owner }) { calls.push(["appWindow", on, owner && owner.id]); }
    ${block}
    pillTopmost = topmost;
    return {
      full: (w, h) => cardIsFullApp(w, h),
      enter: () => enterAppWindow(),
      exit: () => exitAppWindow(),
      active: () => appWindow,
      elevated: () => overlayElevated,
    };
  `);
  return { calls, api: run(win, owner, calls, platform, topmost) };
}

test("Windows: the full app is an ordinary app until Collapse makes it the pill again", () => {
  const { calls, api } = windowsHarness();
  assert.equal(api.full(344, 524), false, "the small card is the pill");
  assert.equal(api.full(900, 800), false, "the two-thirds card fits the native maximum and stays the pill");
  assert.equal(api.full(1920, 1032), true);
  api.enter();
  assert.equal(api.active(), true);
  assert.equal(api.elevated(), false, "space presence stops re-asserting topmost");
  assert.deepEqual(calls.slice(0, 3), [["alwaysOnTop", false], ["appWindow", true, "owner"], ["focus"]],
    "drops to the normal level, gets its taskbar button and Alt-Tab entry, and is the app in front");
  api.enter();
  assert.equal(calls.length, 3, "entering twice changes nothing");
  api.exit();
  assert.equal(api.active(), false);
  assert.equal(api.elevated(), true);
  assert.deepEqual(calls.slice(3), [["appWindow", false, "owner"], ["alwaysOnTop", true, "screen-saver"]],
    "owned again (no taskbar, no Alt-Tab) and back above everything");
  api.exit();
  assert.equal(calls.length, 5, "collapsing twice changes nothing");
});

test("Linux: the full app drops to the normal level and floats again on Collapse", () => {
  const { calls, api } = windowsHarness({ platform: "linux" });
  api.enter();
  api.exit();
  assert.deepEqual(calls.filter((c) => c[0] === "alwaysOnTop"), [["alwaysOnTop", false], ["alwaysOnTop", true, "floating"]]);
});

test("a harness pill that never floated is not lifted on Collapse", () => {
  const { calls, api } = windowsHarness({ topmost: false });
  api.enter();
  api.exit();
  assert.deepEqual(calls.filter((c) => c[0] === "alwaysOnTop"), [["alwaysOnTop", false]]);
});

test("macOS keeps its own surface path", () => {
  const { calls, api } = windowsHarness({ platform: "darwin" });
  api.enter();
  assert.equal(api.active(), false);
  assert.deepEqual(calls, []);
});

test("Windows and Linux become the full app before growing and the pill after shrinking", () => {
  const fit = main.slice(main.indexOf("function fitOverlayWindowToCard"), main.indexOf("function scheduleNativeGeometryReconcile"));
  assert.ok(fit.indexOf("if (full) enterAppWindow();") < fit.indexOf("win.setBounds(target, false)"), "enter precedes the grow");
  assert.ok(fit.lastIndexOf("if (backToPill) exitAppWindow();") > fit.indexOf("win.setBounds(target, false)"), "exit follows the shrink");
  assert.match(fit, /const backToPill = settle && !full;/, "only a settled fold ends the full app");
  assert.match(main, /if \(appSurface \|\| appWindow\) return; \/\/ the full app fills the screen/);
  assert.match(main, /const maximum = appWindow \? \{ w: wa\.width, h: wa\.height \} : CARD_MAX;/, "re-showing the full app never shrinks it");
  assert.match(main, /\}, \{ owner: pillOwner \}\);\n\s+setPillAppDetails\(\);/, "the pill is created owned and carries Relay's taskbar identity");
});
