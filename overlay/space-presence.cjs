const ACTIVE_SPACE_CHANGED = "NSWorkspaceActiveSpaceDidChangeNotification";
const ACTIVE_APPLICATION_CHANGED = "NSWorkspaceDidActivateApplicationNotification";

function isUsableWindow(win) {
  return Boolean(win && !(typeof win.isDestroyed === "function" && win.isDestroyed()));
}

function resetWindowZoom(win) {
  if (!isUsableWindow(win) || !win.webContents) return false;
  try {
    if (typeof win.webContents.setZoomFactor === "function") win.webContents.setZoomFactor(1);
  } catch {}
  try {
    if (typeof win.webContents.setVisualZoomLevelLimits === "function") {
      const res = win.webContents.setVisualZoomLevelLimits(1, 1);
      if (res && typeof res.catch === "function") res.catch(() => {});
    }
  } catch {}
  return true;
}

function reinforceSpacePresence(win, { moveTop = false, alwaysOnTop = true, platform = process.platform } = {}) {
  if (!isUsableWindow(win)) return false;
  resetWindowZoom(win);
  const isWindows = platform === "win32";
  // All-Spaces is a macOS Spaces concept. On Windows isVisibleOnAllWorkspaces()
  // always reports false, so the drift check below re-called the setter on every
  // 1.5s poll for nothing.
  if (!isWindows) {
    // Only touch window-server state that actually drifted. Re-asserting
    // setVisibleOnAllWorkspaces / setAlwaysOnTop unconditionally (every 1.5s poll +
    // every Space change) reorders the window each time and reads as flicker.
    try {
      if (typeof win.isVisibleOnAllWorkspaces !== "function" || !win.isVisibleOnAllWorkspaces()) {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
    } catch {}
  }
  if (isWindows && alwaysOnTop) {
    // Re-assert unconditionally: Electron's isAlwaysOnTop() is a cached flag from
    // its own last setAlwaysOnTop call and cannot observe the OS stripping
    // WS_EX_TOPMOST (scheduled-task-launched windows come up without it and sink
    // behind maximized windows). Trusting the getter made the repair a permanent
    // no-op. SetWindowPos-to-topmost on an already-topmost window is not a visible
    // reorder here, so the macOS flicker rationale above does not apply.
    try {
      win.setAlwaysOnTop(true, "screen-saver");
    } catch {}
  } else if (!isWindows) {
    try {
      const currentlyTop = typeof win.isAlwaysOnTop === "function" ? win.isAlwaysOnTop() : !alwaysOnTop;
      if (currentlyTop !== alwaysOnTop) {
        win.setAlwaysOnTop(alwaysOnTop, "floating");
      }
    } catch {}
  }
  // moveTop is macOS orderWindow:NSWindowAbove — on a HIDDEN window that orders it
  // back on-screen. That made the dismissed pill flash on every Space switch (shown
  // here, then hidden again by the visibility sync). Raising only means anything
  // for a window that is already on screen, so require confirmed visibility.
  if (moveTop && typeof win.moveTop === "function") {
    try {
      if (typeof win.isVisible === "function" && win.isVisible()) win.moveTop();
    } catch {}
  }
  return true;
}

function showInactiveOnAllSpaces(win, { force = false, alwaysOnTop = true, platform = process.platform } = {}) {
  if (!isUsableWindow(win)) return false;
  const visible = typeof win.isVisible === "function" ? win.isVisible() : false;
  // Capture drift BEFORE reinforceSpacePresence repairs it: once the collection
  // behavior has been re-asserted there is no way to tell whether a re-attach was
  // needed. A missing getter means we cannot verify, so take the re-show path.
  const canJoinAllSpacesIntact =
    typeof win.isVisibleOnAllWorkspaces === "function" && win.isVisibleOnAllWorkspaces();
  if (visible && !force) {
    reinforceSpacePresence(win, { alwaysOnTop, platform });
    return false;
  }
  if (visible && canJoinAllSpacesIntact) {
    // Forced re-show with nothing drifted: a canJoinAllSpaces window is already on
    // the active Space, so there is nothing to re-attach. showInactive()/moveTop()
    // here re-order the window mid Space-transition animation — the residual
    // "pill blinks on every swipe" after the hide()/show() cycle was removed.
    reinforceSpacePresence(win, { alwaysOnTop, platform });
    return false;
  }

  // NEVER hide() an already-visible window here: the hide/show cycle was a visible
  // blink on every forced re-show (twice per Space change). showInactive() on a
  // visible window is enough to re-attach it to the active Space once the
  // all-workspaces collection behavior has been re-asserted above.
  reinforceSpacePresence(win, { alwaysOnTop, platform });
  if (typeof win.showInactive === "function") win.showInactive();
  reinforceSpacePresence(win, { moveTop: alwaysOnTop, alwaysOnTop, platform });
  return !visible;
}

function subscribeActiveSpaceChanges(systemPreferences, callback, { log = () => {} } = {}) {
  if (!systemPreferences || typeof systemPreferences.subscribeWorkspaceNotification !== "function") return null;
  try {
    return systemPreferences.subscribeWorkspaceNotification(ACTIVE_SPACE_CHANGED, () => callback());
  } catch (error) {
    log(`space change subscription failed: ${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

function subscribeActiveApplicationChanges(systemPreferences, callback, { log = () => {} } = {}) {
  if (!systemPreferences || typeof systemPreferences.subscribeWorkspaceNotification !== "function") return null;
  try {
    return systemPreferences.subscribeWorkspaceNotification(ACTIVE_APPLICATION_CHANGED, () => callback());
  } catch (error) {
    log(`frontmost application subscription failed: ${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

module.exports = {
  ACTIVE_SPACE_CHANGED,
  ACTIVE_APPLICATION_CHANGED,
  reinforceSpacePresence,
  resetWindowZoom,
  showInactiveOnAllSpaces,
  subscribeActiveSpaceChanges,
  subscribeActiveApplicationChanges,
};
