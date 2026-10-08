"use strict";

/**
 * Relay floats while a supported AI host is frontmost, and yields when the
 * person activates another app. An activation owned by Relay itself (a
 * composer briefly becoming key) must preserve the previous level.
 */
function elevationForFrontmost({
  bundle,
  current = true,
  host = null,
  selfBundles = [],
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") return true;
  const id = String(bundle || "").trim();
  if (!id) return Boolean(current);
  if (new Set(selfBundles.map(String)).has(id)) return Boolean(current);
  return Boolean(host);
}

// An explicit open (Dock, Spotlight, Relay.app, `relay pill`, the menu bar) is a
// promise that the card is on top. The launcher that carried the open quits a
// moment later and macOS hands focus straight back to whatever was in front —
// Safari, Terminal. That activation is not the person leaving, so it must not
// drop the pill behind the very window it was just opened over (field: "I
// click Relay and nothing happens"). The hold settles on the app that ends up
// in front during the grace window and lasts until a DIFFERENT app activates.
const EXPLICIT_OPEN_GRACE_MS = 5000;

function startExplicitOpenHold({ now = Date.now(), graceMs = EXPLICIT_OPEN_GRACE_MS } = {}) {
  return { until: now + graceMs, bundle: "" };
}

// Acting in the pill ends the grace: the launcher's focus handback is long
// over, so the next app to come forward is the person's own choice — Safari
// for Google sign-in must land on top of the pill, not under it.
function settleExplicitOpenHold(hold) {
  return hold ? { ...hold, until: 0 } : null;
}

function applyExplicitOpenHold({ hold, bundle, now = Date.now(), selfBundles = [] } = {}) {
  if (!hold) return { hold: null, keep: false };
  const id = String(bundle || "").trim();
  // Relay's own windows (a composer, a document viewer) leave the level to the
  // ordinary policy, which preserves it, and do not settle or end the hold.
  if (!id || new Set(selfBundles.map(String)).has(id)) return { hold, keep: false };
  if (now <= hold.until) return { hold: { ...hold, bundle: id }, keep: true };
  if (id === hold.bundle) return { hold, keep: true };
  return { hold: null, keep: false };
}

module.exports = { elevationForFrontmost, startExplicitOpenHold, settleExplicitOpenHold, applyExplicitOpenHold, EXPLICIT_OPEN_GRACE_MS };
