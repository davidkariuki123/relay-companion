"use strict";

/**
 * Create a native window that keeps Relay's Companion identity.
 *
 * Relay is an always-on companion with a tray/menu-bar presence, not a normal
 * Windows or macOS application. Keep every window out of those app surfaces.
 * Linux retains its taskbar fallback because a tray is not reliably available
 * across desktop environments.
 *
 * On Windows, Electron's `skipTaskbar` is not a window style: it is a single
 * ITaskbarList::DeleteTab call. The shell re-registers a button for any plain
 * top-level window the next time it is activated, shown again after a hide,
 * or when Explorer restarts, and DeleteTab never removed the window from
 * Alt-Tab in the first place. The only durable exclusion is the
 * WS_EX_TOOLWINDOW extended style, which Electron applies for `type: "toolbar"`.
 * A tool window still accepts focus and keyboard input; it simply is not an
 * application window as far as the taskbar and the app switcher are concerned.
 *
 * Electron can also change the Windows taskbar registration while it applies
 * other constructor options such as focusability. Reassert the native setting
 * after construction so the final window state still follows the contract.
 */
function createCompanionWindow(BrowserWindow, options = {}, { platform = process.platform } = {}) {
  const nativeOptions = {
    ...options,
    ...(platform === "win32" ? { type: "toolbar" } : {}),
    skipTaskbar: platform !== "linux",
  };

  const window = new BrowserWindow(nativeOptions);
  if (platform === "win32") window.setSkipTaskbar(true);
  return window;
}

module.exports = { createCompanionWindow };
