"use strict";

// The unread number on Relay's app icon (Shane, 2026-10-12). While Relay is
// the full app it has a Dock icon (macOS) or a taskbar button (Windows), and a
// Relay that arrives while another app is in front showed nowhere on it. The
// icon now carries the same number as the pill's unread count.
//
// macOS draws the Dock badge itself from a string. Windows has no badge API
// for a desktop app: the taskbar takes a small overlay icon, which the
// renderer draws (it has a canvas) and hands over as a PNG data URL. Linux
// sets the launcher count where the desktop supports one (Unity, KDE).

function appBadgeLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return "";
  return n > 99 ? "99+" : String(n);
}

function applyAppBadge({ app, win, nativeImage, platform = process.platform, count = 0, overlayDataUrl = "" }) {
  const label = appBadgeLabel(count);
  if (platform === "darwin") {
    try { if (app && app.dock) app.dock.setBadge(label); } catch {}
    return label;
  }
  if (platform === "win32") {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return label;
    let image = null;
    if (label && overlayDataUrl && nativeImage) {
      try { image = nativeImage.createFromDataURL(overlayDataUrl); } catch {}
      if (image && image.isEmpty()) image = null;
    }
    const description = label ? `${label} unread` : "";
    try { win.setOverlayIcon(image, description); } catch {}
    return label;
  }
  try { if (app && typeof app.setBadgeCount === "function") app.setBadgeCount(label ? Math.floor(Number(count)) : 0); } catch {}
  return label;
}

module.exports = { appBadgeLabel, applyAppBadge };
