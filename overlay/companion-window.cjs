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
 * THE PILL IS THE EXCEPTION (2026-10-09). Expand turns it into the full app,
 * an ordinary application with a taskbar button and an Alt-Tab entry, and
 * Collapse turns it back. Electron cannot remove WS_EX_TOOLWINDOW from a live
 * window, so the pill is instead OWNED by a hidden window (pass `owner`). The
 * shell gives neither a taskbar button nor an Alt-Tab entry to a window with
 * an owner, as durably as to a tool window: it is the same rule that keeps
 * dialogs out of both, and activation, a re-show or an Explorer restart do not
 * undo it. Dropping the owner (setCompanionAppWindow) makes it an application
 * window; restoring it makes it the pill again.
 *
 * Electron can also change the Windows taskbar registration while it applies
 * other constructor options such as focusability. Reassert the native setting
 * after construction so the final window state still follows the contract.
 */
function createCompanionWindow(BrowserWindow, options = {}, { platform = process.platform, owner = null } = {}) {
  const owned = platform === "win32" && Boolean(owner);
  const nativeOptions = {
    ...options,
    ...(platform === "win32" ? (owned ? { parent: owner } : { type: "toolbar" }) : {}),
    skipTaskbar: platform !== "linux",
  };
  // An owned pill is a plain window: no caller-supplied kind may make it a
  // tool window it could never stop being.
  if (owned) delete nativeOptions.type;

  const window = new BrowserWindow(nativeOptions);
  if (platform === "win32") window.setSkipTaskbar(true);
  // Test seam: an end-to-end harness that drives this app over the debugging
  // port must never cover the person's own Relay. The page still renders and
  // can be captured; the window is invisible and lets every click through.
  if (process.env.RELAY_OVERLAY_TEST_INVISIBLE === "1") {
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
  }
  return window;
}

/**
 * The hidden owner that keeps the Windows pill out of the taskbar and Alt-Tab.
 * A BaseWindow has no web contents, so it costs no renderer. It is never shown.
 */
function createCompanionWindowOwner(BaseWindow, { platform = process.platform } = {}) {
  if (platform !== "win32" || typeof BaseWindow !== "function") return null;
  return new BaseWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    type: "toolbar",
    title: "Relay",
  });
}

/**
 * Make an owned Windows Companion window an ordinary application (taskbar
 * button, Alt-Tab entry) or the owned companion again. Electron re-shows a
 * visible window across an owner change so the shell sees it. Other platforms
 * are handled by their callers (the macOS Dock; Linux keeps its taskbar entry).
 */
function setCompanionAppWindow(window, appWindow, { platform = process.platform, owner = null } = {}) {
  if (platform !== "win32" || !window || !owner) return false;
  if (typeof window.isDestroyed === "function" && window.isDestroyed()) return false;
  if (typeof owner.isDestroyed === "function" && owner.isDestroyed()) return false;
  window.setParentWindow(appWindow ? null : owner);
  window.setSkipTaskbar(!appWindow);
  return true;
}

module.exports = { createCompanionWindow, createCompanionWindowOwner, setCompanionAppWindow };
