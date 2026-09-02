"use strict";

// Where a downloaded attachment lands, and what it is called when it gets
// there. Kept out of main.cjs and free of Electron so the two decisions that
// actually bite — a chat title that is not a legal folder name, and a second
// file with a name the folder already holds — can be tested directly.

// Anything a path separator or a filesystem would choke on. Control characters
// included: a chat title is remote data, and " ../.." is a folder name only in
// the sense that a crowbar is a key.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

function collapse(value) {
  return String(value == null ? "" : value).replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}

/**
 * The per-chat folder under ~/Downloads/Relay. Falls back to "Relay" rather
 * than to an empty segment, which would silently spill files one level up.
 */
function sanitizeChatFolderName(title) {
  // Leading and trailing dots are stripped, so "." and ".." can never survive
  // as a name and no folder starts out hidden.
  const cleaned = collapse(title).replace(/^\.+/, "").replace(/\.+$/, "").trim();
  return cleaned.slice(0, 60).trim() || "Relay";
}

/**
 * Keep the sender's own filename. Only the parts a filesystem cannot hold are
 * replaced; the name is never rewritten for tidiness.
 */
function sanitizeDownloadFileName(name) {
  const cleaned = collapse(name).slice(0, 180).trim();
  // ".env" is a real name and stays one; "." and ".." are not names at all.
  if (!cleaned || /^\.+$/.test(cleaned)) return "attachment";
  return cleaned;
}

/**
 * " (2)", " (3)", … before the extension, the way every desktop does it. The
 * caller supplies `taken` so this works against a real directory, an in-flight
 * batch, or a test's Set.
 */
function uniqueDownloadName(name, taken) {
  const base = sanitizeDownloadFileName(name);
  const isTaken = typeof taken === "function"
    ? taken
    : (candidate) => Boolean(taken && typeof taken.has === "function" && taken.has(candidate));
  if (!isTaken(base)) return base;
  // A dot at position 0 is not an extension, it is a hidden file.
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

module.exports = { sanitizeChatFolderName, sanitizeDownloadFileName, uniqueDownloadName };
