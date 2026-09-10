import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createCompanionWindow } = require("../overlay/companion-window.cjs");

function fakeBrowserWindow() {
  function BrowserWindow(options) {
    this.options = options;
    this.skipTaskbarCalls = [];
  }
  BrowserWindow.prototype.setSkipTaskbar = function setSkipTaskbar(value) {
    this.skipTaskbarCalls.push(value);
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
