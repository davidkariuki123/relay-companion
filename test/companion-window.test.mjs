import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCompanionWindow, createCompanionWindowOwner, setCompanionAppWindow } = require("../overlay/companion-window.cjs");

function fakeBrowserWindow() {
  function BrowserWindow(options) {
    this.options = options;
    this.skipTaskbarCalls = [];
  }
  BrowserWindow.prototype.setSkipTaskbar = function setSkipTaskbar(value) {
    this.skipTaskbarCalls.push(value);
  };
  BrowserWindow.prototype.setParentWindow = function setParentWindow(parent) {
    this.parentCalls = [...(this.parentCalls || []), parent];
  };
  return BrowserWindow;
}

test("Windows Companion windows finish construction outside the taskbar", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", focusable: true, skipTaskbar: false },
    { platform: "win32" },
  );

  assert.equal(window.options.skipTaskbar, true);
  assert.deepEqual(window.skipTaskbarCalls, [true]);
});

test("Windows Companion windows are native tool windows so the shell never re-adds a taskbar or Alt-Tab entry", () => {
  // skipTaskbar on Windows is only an ITaskbarList::DeleteTab call; the shell
  // undoes it on the next activation, re-show or Explorer restart. Only the
  // WS_EX_TOOLWINDOW style (Electron's type: "toolbar") is durable, and it is
  // also the only thing that keeps the window out of Alt-Tab.
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", focusable: true, frame: false, transparent: true },
    { platform: "win32" },
  );

  assert.equal(window.options.type, "toolbar");
  assert.equal(window.options.focusable, true, "a tool window still accepts focus and keyboard input");
  assert.equal(window.options.frame, false);
});

test("a caller cannot opt a Windows Companion window back into being an application window", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", type: "normal", skipTaskbar: false },
    { platform: "win32" },
  );

  assert.equal(window.options.type, "toolbar");
  assert.equal(window.options.skipTaskbar, true);
});

test("macOS Companion windows are excluded from the app switcher", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", skipTaskbar: false },
    { platform: "darwin" },
  );

  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.type, undefined, "toolbar is a Windows-only style; macOS keeps its own window kinds");
  assert.deepEqual(window.skipTaskbarCalls, []);
});

test("Linux keeps the normal taskbar fallback", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", skipTaskbar: true },
    { platform: "linux" },
  );

  assert.equal(window.options.skipTaskbar, false);
  assert.equal(window.options.type, undefined, "Linux keeps a normal window so the taskbar fallback works");
  assert.deepEqual(window.skipTaskbarCalls, []);
});

test("the Windows pill is owned by a hidden window instead of being a tool window, so Expand can make it an app", () => {
  // Electron cannot remove WS_EX_TOOLWINDOW from a live window. An owned window
  // is kept out of the taskbar and Alt-Tab by the same durable shell rule, and
  // dropping the owner makes it an ordinary application window.
  const BrowserWindow = fakeBrowserWindow();
  const owner = { id: "owner" };
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", type: "toolbar", skipTaskbar: false },
    { platform: "win32", owner },
  );
  assert.equal(window.options.parent, owner);
  assert.equal("type" in window.options, false, "no tool-window style it could never shed");
  assert.equal(window.options.skipTaskbar, true);
  assert.deepEqual(window.skipTaskbarCalls, [true]);
});

test("Expand drops the owner and adds the taskbar button; Collapse restores both", () => {
  const BrowserWindow = fakeBrowserWindow();
  const owner = { id: "owner", isDestroyed: () => false };
  const window = createCompanionWindow(BrowserWindow, { title: "Relay" }, { platform: "win32", owner });
  window.isDestroyed = () => false;
  assert.equal(setCompanionAppWindow(window, true, { platform: "win32", owner }), true);
  assert.equal(setCompanionAppWindow(window, false, { platform: "win32", owner }), true);
  assert.deepEqual(window.parentCalls, [null, owner]);
  assert.deepEqual(window.skipTaskbarCalls, [true, false, true]);
});

test("app-window switching is Windows-only and needs the owner", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(BrowserWindow, { title: "Relay" }, { platform: "darwin" });
  assert.equal(setCompanionAppWindow(window, true, { platform: "darwin", owner: {} }), false);
  assert.equal(setCompanionAppWindow(window, true, { platform: "win32", owner: null }), false);
  assert.equal(window.parentCalls, undefined);
});

test("the hidden owner exists only on Windows and is never an app window itself", () => {
  function BaseWindow(options) { this.options = options; }
  assert.equal(createCompanionWindowOwner(BaseWindow, { platform: "darwin" }), null);
  assert.equal(createCompanionWindowOwner(BaseWindow, { platform: "linux" }), null);
  const owner = createCompanionWindowOwner(BaseWindow, { platform: "win32" });
  assert.equal(owner.options.show, false);
  assert.equal(owner.options.type, "toolbar");
  assert.equal(owner.options.skipTaskbar, true);
  assert.equal(owner.options.focusable, false);
});
