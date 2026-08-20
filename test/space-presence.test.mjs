import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ACTIVE_APPLICATION_CHANGED,
  ACTIVE_SPACE_CHANGED,
  reinforceSpacePresence,
  resetWindowZoom,
  showInactiveOnAllSpaces,
  subscribeActiveApplicationChanges,
  subscribeActiveSpaceChanges,
} = require("../overlay/space-presence.cjs");

function fakeWindow({ visible = false } = {}) {
  const calls = [];
  // Mirror AppKit: showInactive orders the window on-screen, hide orders it out.
  const win = {
    calls,
    isDestroyed: () => false,
    isVisible: () => win.visible,
    visible,
    setVisibleOnAllWorkspaces: (...args) => calls.push(["setVisibleOnAllWorkspaces", ...args]),
    setAlwaysOnTop: (...args) => calls.push(["setAlwaysOnTop", ...args]),
    moveTop: () => calls.push(["moveTop"]),
    hide: () => {
      calls.push(["hide"]);
      win.visible = false;
    },
    showInactive: () => {
      calls.push(["showInactive"]);
      win.visible = true;
    },
    webContents: {
      setZoomFactor: (...args) => calls.push(["setZoomFactor", ...args]),
      setVisualZoomLevelLimits: (...args) => calls.push(["setVisualZoomLevelLimits", ...args]),
    },
  };
  return win;
}

test("resetWindowZoom pins the renderer at 100 percent", () => {
  const win = fakeWindow();

  assert.equal(resetWindowZoom(win), true);

  assert.deepEqual(win.calls, [
    ["setZoomFactor", 1],
    ["setVisualZoomLevelLimits", 1, 1],
  ]);
});

test("reinforceSpacePresence applies all-Spaces and floating window flags", () => {
  const win = fakeWindow({ visible: true });

  assert.equal(reinforceSpacePresence(win, { moveTop: true }), true);

  assert.deepEqual(win.calls, [
    ["setZoomFactor", 1],
    ["setVisualZoomLevelLimits", 1, 1],
    ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
    ["setAlwaysOnTop", true, "floating"],
    ["moveTop"],
  ]);
});

test("reinforceSpacePresence NEVER moveTops a hidden window (macOS would show it)", () => {
  // The dismissed-pill Space-switch flash: moveTop() is orderWindow:NSWindowAbove,
  // which orders a hidden window back on-screen. Reinforcing presence must not
  // implicitly show anything.
  const win = fakeWindow({ visible: false });

  assert.equal(reinforceSpacePresence(win, { moveTop: true }), true);

  assert.ok(!win.calls.some(([name]) => name === "moveTop"), "hidden window must not be raised/shown");
});

test("showInactiveOnAllSpaces reasserts all-Spaces for already-visible windows", () => {
  const win = fakeWindow({ visible: true });

  assert.equal(showInactiveOnAllSpaces(win), false);

  assert.deepEqual(win.calls, [
    ["setZoomFactor", 1],
    ["setVisualZoomLevelLimits", 1, 1],
    ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
    ["setAlwaysOnTop", true, "floating"],
  ]);
});

test("showInactiveOnAllSpaces force NEVER hides a visible window (no blink)", () => {
  // No isVisibleOnAllWorkspaces getter on this fake: drift is unverifiable, so the
  // conservative re-show path runs — without ever hiding.
  const win = fakeWindow({ visible: true });

  // Returns false because the window was already visible (no hidden->shown
  // transition, so main must not reset the renderer's interactivity handshake).
  assert.equal(showInactiveOnAllSpaces(win, { force: true }), false);

  assert.ok(!win.calls.some(([name]) => name === "hide"), "force path must not hide()");
  assert.ok(win.calls.some(([name]) => name === "showInactive"), "still re-attaches via showInactive()");
  assert.ok(win.calls.some(([name]) => name === "moveTop"), "still raises the window");
});

test("showInactiveOnAllSpaces force is a no-op when nothing drifted (no reorder, no blink)", () => {
  // The Space-switch watcher force-refreshes twice per swipe. When the window is
  // visible and canJoinAllSpaces is intact it is ALREADY on the active Space;
  // re-showing it would reorder it mid transition animation — the residual flicker.
  const win = fakeWindow({ visible: true });
  win.isVisibleOnAllWorkspaces = () => true;
  win.isAlwaysOnTop = () => true;

  assert.equal(showInactiveOnAllSpaces(win, { force: true }), false);

  assert.ok(!win.calls.some(([name]) => name === "showInactive"), "no re-attach needed");
  assert.ok(!win.calls.some(([name]) => name === "moveTop"), "no reorder");
  assert.ok(!win.calls.some(([name]) => name === "hide"), "never hides");
});

test("showInactiveOnAllSpaces force re-attaches a visible window whose all-Spaces bit drifted", () => {
  const win = fakeWindow({ visible: true });
  let voaw = false;
  win.isVisibleOnAllWorkspaces = () => voaw;
  win.setVisibleOnAllWorkspaces = (...args) => {
    win.calls.push(["setVisibleOnAllWorkspaces", ...args]);
    voaw = true;
  };

  assert.equal(showInactiveOnAllSpaces(win, { force: true }), false);

  assert.ok(win.calls.some(([name]) => name === "setVisibleOnAllWorkspaces"), "repairs the drifted bit");
  assert.ok(win.calls.some(([name]) => name === "showInactive"), "re-attaches to the active Space");
  assert.ok(!win.calls.some(([name]) => name === "hide"), "never hides");
});

test("showInactiveOnAllSpaces force shows a hidden window and reports the transition", () => {
  const win = fakeWindow({ visible: false });

  assert.equal(showInactiveOnAllSpaces(win, { force: true }), true);

  assert.ok(win.calls.some(([name]) => name === "showInactive"));
  const shownAt = win.calls.findIndex(([name]) => name === "showInactive");
  const raisedAt = win.calls.findIndex(([name]) => name === "moveTop");
  assert.ok(raisedAt > shownAt, "a genuine show still raises the now-visible window");
  assert.ok(!win.calls.some(([name]) => name === "hide"));
});

test("reinforceSpacePresence skips window-server calls that would be no-ops", () => {
  const win = fakeWindow({ visible: true });
  win.isVisibleOnAllWorkspaces = () => true;
  win.isAlwaysOnTop = () => true;

  assert.equal(reinforceSpacePresence(win), true);

  assert.ok(
    !win.calls.some(([name]) => name === "setVisibleOnAllWorkspaces" || name === "setAlwaysOnTop"),
    "already-correct state must not be re-asserted (it reorders the window and flickers)",
  );
});

test("reinforceSpacePresence re-asserts state that actually drifted", () => {
  const win = fakeWindow({ visible: true });
  win.isVisibleOnAllWorkspaces = () => false;
  win.isAlwaysOnTop = () => false;

  assert.equal(reinforceSpacePresence(win), true);

  assert.ok(win.calls.some(([name]) => name === "setVisibleOnAllWorkspaces"));
  assert.ok(win.calls.some(([name]) => name === "setAlwaysOnTop"));
});

test("a yielded macOS pill stays open but drops its topmost level", () => {
  const win = fakeWindow({ visible: true });
  win.isVisibleOnAllWorkspaces = () => true;
  win.isAlwaysOnTop = () => true;

  assert.equal(showInactiveOnAllSpaces(win, { force: true, alwaysOnTop: false }), false);

  assert.ok(!win.calls.some(([name]) => name === "hide"), "yielding never closes the reader");
  assert.ok(!win.calls.some(([name]) => name === "moveTop"), "yielding never raises over the newly active app");
  assert.deepEqual(win.calls.filter(([name]) => name === "setAlwaysOnTop"), [["setAlwaysOnTop", false, "floating"]]);
});

test("reinforceSpacePresence on win32 re-asserts topmost even when Electron claims it is set", () => {
  // Windows strips WS_EX_TOPMOST from the pill (verified with EnumWindows on a
  // scheduled-task-launched window) but Electron's isAlwaysOnTop() keeps returning
  // its own cached true — a drift check here never fires and the pill stays sunk
  // behind maximized windows forever.
  const win = fakeWindow({ visible: true });
  win.isVisibleOnAllWorkspaces = () => false;
  win.isAlwaysOnTop = () => true;

  assert.equal(reinforceSpacePresence(win, { platform: "win32" }), true);
  assert.equal(reinforceSpacePresence(win, { platform: "win32" }), true);

  assert.deepEqual(
    win.calls.filter(([name]) => name === "setAlwaysOnTop"),
    [
      ["setAlwaysOnTop", true, "screen-saver"],
      ["setAlwaysOnTop", true, "screen-saver"],
    ],
    "every poll must re-assert topmost at screen-saver level",
  );
});

test("reinforceSpacePresence on win32 skips the macOS-only all-Spaces call", () => {
  const win = fakeWindow({ visible: true });

  assert.equal(reinforceSpacePresence(win, { moveTop: true, platform: "win32" }), true);

  assert.ok(
    !win.calls.some(([name]) => name === "setVisibleOnAllWorkspaces"),
    "Spaces are a macOS concept; on Windows the getter always reads false and the setter never sticks",
  );
  assert.ok(win.calls.some(([name]) => name === "moveTop"), "raising a visible window still applies");
});

test("reinforceSpacePresence on darwin keeps the drift-checked floating behavior", () => {
  const settled = fakeWindow({ visible: true });
  settled.isVisibleOnAllWorkspaces = () => true;
  settled.isAlwaysOnTop = () => true;

  assert.equal(reinforceSpacePresence(settled, { platform: "darwin" }), true);
  assert.ok(
    !settled.calls.some(([name]) => name === "setVisibleOnAllWorkspaces" || name === "setAlwaysOnTop"),
    "mac must not re-assert undrifted state (it reorders the window and flickers)",
  );

  const drifted = fakeWindow({ visible: true });
  drifted.isVisibleOnAllWorkspaces = () => false;
  drifted.isAlwaysOnTop = () => false;

  assert.equal(reinforceSpacePresence(drifted, { platform: "darwin" }), true);
  assert.deepEqual(drifted.calls.slice(2), [
    ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
    ["setAlwaysOnTop", true, "floating"],
  ]);
});

test("subscribeActiveSpaceChanges uses the macOS workspace notification center", () => {
  const calls = [];
  let handler = null;
  const systemPreferences = {
    subscribeWorkspaceNotification(event, cb) {
      calls.push(event);
      handler = cb;
      return 42;
    },
  };
  let fired = 0;

  const id = subscribeActiveSpaceChanges(systemPreferences, () => { fired += 1; });
  handler();

  assert.equal(id, 42);
  assert.deepEqual(calls, [ACTIVE_SPACE_CHANGED]);
  assert.equal(fired, 1);
});

test("subscribeActiveApplicationChanges reacts at the app activation edge", () => {
  const calls = [];
  let handler = null;
  const systemPreferences = {
    subscribeWorkspaceNotification(event, cb) {
      calls.push(event);
      handler = cb;
      return 43;
    },
  };
  let fired = 0;

  const id = subscribeActiveApplicationChanges(systemPreferences, () => { fired += 1; });
  handler();

  assert.equal(id, 43);
  assert.deepEqual(calls, [ACTIVE_APPLICATION_CHANGED]);
  assert.equal(fired, 1);
});
