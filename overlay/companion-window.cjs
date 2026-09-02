"use strict";

/**
 * Create a native window that keeps Relay's Companion identity.
 *
 * Relay is an always-on companion with a tray/menu-bar presence, not a normal
 * Windows or macOS application. Keep every window out of those app surfaces.
 * Linux retains its taskbar fallback because a tray is not reliably available
 * across desktop environments.
 *
 * Electron can change the Windows taskbar registration while it applies other
 * constructor options such as focusability. Reassert the native setting after
 * construction so the final window state still follows the product contract.
 */
function createCompanionWindow(BrowserWindow, options = {}, { platform = process.platform } = {}) {
  const nativeOptions = { ...options, skipTaskbar: platform !== "linux" };

  const window = new BrowserWindow(nativeOptions);
  if (platform === "win32") window.setSkipTaskbar(true);
  return window;
}

module.exports = { createCompanionWindow };
