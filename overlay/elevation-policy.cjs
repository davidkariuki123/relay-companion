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

module.exports = { elevationForFrontmost };
