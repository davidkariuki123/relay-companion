"use strict";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampCardSize(size, maximum) {
  return {
    w: Math.max(1, Math.min(finite(size?.w, 1), finite(maximum?.w, 1))),
    h: Math.max(1, Math.min(finite(size?.h, 1), finite(maximum?.h, 1))),
  };
}

/** Fit the native window to the card while keeping its top/right screen edges fixed. */
function fittedOverlayBounds(workArea, size, {
  margin = 0,
  anchor = { top: 0, right: 0 },
  frame = { left: 0, bottom: 0 },
  maximum = size,
} = {}) {
  const card = clampCardSize(size, maximum);
  const right = Math.max(0, Math.round(finite(anchor?.right)));
  const top = Math.max(0, Math.round(finite(anchor?.top)));
  const left = Math.max(0, Math.round(finite(frame?.left)));
  const bottom = Math.max(0, Math.round(finite(frame?.bottom)));
  const width = Math.max(1, left + Math.ceil(card.w) + right);
  const height = Math.max(1, top + Math.ceil(card.h) + bottom);
  const wa = workArea || { x: 0, y: 0, width, height };
  return {
    x: Math.round(finite(wa.x) + finite(wa.width, width) - width - finite(margin)),
    y: Math.round(finite(wa.y) + finite(margin)),
    width,
    height,
  };
}

/** Resize an already-positioned pill without snapping a user-dragged window home. */
function resizedOverlayBounds(current, size, { maximum = size } = {}) {
  const card = clampCardSize(size, maximum);
  const width = Math.max(1, Math.ceil(card.w));
  const height = Math.max(1, Math.ceil(card.h));
  const bounds = current || { x: 0, y: 0, width, height };
  return {
    x: Math.round(finite(bounds.x) + finite(bounds.width, width) - width),
    y: Math.round(finite(bounds.y)),
    width,
    height,
  };
}

/**
 * macOS keeps one compositor surface to avoid an AppKit origin/size split.
 * Other platforms use an ordinary card-sized native window and need no
 * click-through input state.
 */
function usesFixedOverlaySurface(platform) {
  return String(platform || "").toLowerCase() === "darwin";
}

/**
 * A transparent compositor window can be larger than its visible card. Only
 * pixels occupied by the card may receive input; every other pixel must pass
 * through to the app underneath.
 */
function shouldIgnoreOverlayMouse(point, card, pad = 0) {
  const p = point || {};
  const r = card || {};
  const x = finite(p.x, Number.NEGATIVE_INFINITY);
  const y = finite(p.y, Number.NEGATIVE_INFINITY);
  const inset = Math.max(0, finite(pad));
  const onCard =
    x >= finite(r.x) - inset && x < finite(r.x) + finite(r.w) + inset &&
    y >= finite(r.y) - inset && y < finite(r.y) + finite(r.h) + inset;
  return !onCard;
}

module.exports = {
  clampCardSize,
  fittedOverlayBounds,
  resizedOverlayBounds,
  shouldIgnoreOverlayMouse,
  usesFixedOverlaySurface,
};
