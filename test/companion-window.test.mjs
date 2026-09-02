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

test("macOS Companion windows are excluded from the app switcher", () => {
  const BrowserWindow = fakeBrowserWindow();
  const window = createCompanionWindow(
    BrowserWindow,
    { title: "Relay", skipTaskbar: false },
    { platform: "darwin" },
  );

  assert.equal(window.options.skipTaskbar, true);
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
  assert.deepEqual(window.skipTaskbarCalls, []);
});
