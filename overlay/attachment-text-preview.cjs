"use strict";

// What the file viewer shows for text, code and logs. Main reads the bytes —
// the viewer window can never touch the disk — so the decision of "is this
// readable, and which lines are the bad news" lives here, next to the reader,
// and can be tested without a window.

// Two megabytes. Past that a log stops being something you read in a pane and
// becomes something you open in a real editor, so the card offers to.
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_PREVIEW_MAX_LINES = 20000;

const TEXT_EXTENSION = /\.(?:txt|md|markdown|log|json|jsonl|ya?ml|xml|csv|tsv|ini|conf|cfg|toml|env|css|scss|html?|[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|diff|patch|gitignore|lock)$/i;

/** True when the bytes can be shown as lines rather than handed to the OS. */
function isTextPreviewable({ name = "", contentType = "", size = 0 } = {}) {
  if (Number(size) > TEXT_PREVIEW_MAX_BYTES) return false;
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (/^application\/(?:json|xml|x-ndjson|javascript|x-sh|x-yaml|yaml)\b/.test(type)) return true;
  if (type && !TEXT_EXTENSION.test(String(name))) return false;
  return TEXT_EXTENSION.test(String(name));
}

// A log is read for the line that went wrong, so that line is the one that
// carries colour. Nothing else in the pane is tinted, which is what makes it
// findable at a glance.
const TROUBLE = /\b(?:error|errors|failed|failure|fatal|exception|traceback)\b/i;

/**
 * Numbered lines, each flagged if it is the bad news. Returns
 * `{ lines:[{ n, text, trouble }], truncated }`.
 */
function textPreviewLines(source, { maxLines = TEXT_PREVIEW_MAX_LINES } = {}) {
  const body = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
  // A trailing newline is a terminator, not an empty last line.
  const raw = body.length && body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.length ? body.split("\n") : [];
  const truncated = raw.length > maxLines;
  const kept = truncated ? raw.slice(0, maxLines) : raw;
  return {
    truncated,
    total: raw.length,
    lines: kept.map((text, index) => ({ n: index + 1, text, trouble: TROUBLE.test(text) })),
  };
}

module.exports = { TEXT_PREVIEW_MAX_BYTES, TEXT_PREVIEW_MAX_LINES, isTextPreviewable, textPreviewLines };
