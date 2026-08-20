// Durable per-relay attention queue: the single source of truth for "which
// relays still owe the user a visible notification".
//
// Invariants (from the 2026-08 notification reliability audit):
//  - A relay enters the queue when it is staged unread and has never been
//    CONFIRMED seen. It leaves only via confirmSeen() (renderer-confirmed
//    visible dwell / explicit interaction) or drop() (the user acted on that
//    relay elsewhere: opened, deleted, read on another surface).
//  - "presented" (the legacy ledger) now means confirmed-seen, never
//    fired-and-forgotten. Sending IPC to the renderer proves nothing.
//  - The queue is plain serializable state persisted in overlay prefs, so a
//    crash, renderer reload, or process restart replays it instead of
//    dropping it. beginShow() is an in-flight marker, not an exit.
//  - Presentation is sequential: one card at a time, oldest first, so a
//    backlog plays one after another instead of a single folded stack.
//
// Pure logic + explicit state in/out: no Electron, no fs, unit-testable.

"use strict";

const SHOW_RETRY_LIMIT = 2; // failed dwells before a card turns sticky

function normalizeEntry(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  const entryId = String(raw.id || id || "").trim();
  if (!entryId) return null;
  return {
    id: entryId,
    enqueuedAt: Number.isFinite(raw.enqueuedAt) ? raw.enqueuedAt : Date.now(),
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    showing: raw.showing === true,
    sticky: raw.sticky === true,
    notBefore: Number.isFinite(raw.notBefore) ? raw.notBefore : 0,
  };
}

// prefs.pendingAttention -> Map(id -> entry). Tolerates legacy shapes.
function loadQueue(prefs) {
  const queue = new Map();
  const raw = prefs && typeof prefs === "object" ? prefs.pendingAttention : null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const normalized = normalizeEntry(entry, id);
      if (normalized) queue.set(normalized.id, normalized);
    }
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      const normalized = normalizeEntry(entry);
      if (normalized) queue.set(normalized.id, normalized);
    }
  }
  // A crash mid-show leaves showing=true with no renderer to confirm it.
  // Recover by demoting to pending; the attempt already counted.
  for (const entry of queue.values()) entry.showing = false;
  return queue;
}

function saveQueue(queue, prefs) {
  const out = {};
  for (const [id, entry] of queue.entries()) {
    out[id] = {
      id,
      enqueuedAt: entry.enqueuedAt,
      attempts: entry.attempts,
      showing: entry.showing === true,
      sticky: entry.sticky === true,
      notBefore: Number.isFinite(entry.notBefore) ? entry.notBefore : 0,
    };
  }
  prefs.pendingAttention = out;
  return prefs;
}

// Enqueue ids that are unread, not confirmed-seen, and not already queued.
// Returns the ids actually added (for logging).
function enqueueUnseen(queue, ids, { presentedIds, now = Date.now() } = {}) {
  const presented = presentedIds instanceof Set ? presentedIds : new Set(presentedIds || []);
  const added = [];
  for (const rawId of ids || []) {
    const id = String(rawId || "").trim();
    if (!id || queue.has(id) || presented.has(id)) continue;
    queue.set(id, { id, enqueuedAt: now, attempts: 0, showing: false, sticky: false });
    added.push(id);
  }
  return added;
}

// Oldest pending entry that is not mid-show. Sticky entries still surface —
// they just render latched instead of timer-folded.
function nextToShow(queue) {
  let best = null;
  for (const entry of queue.values()) {
    if (entry.showing) return null; // a card is on stage; strict one-at-a-time
    if (!best || entry.enqueuedAt < best.enqueuedAt) best = entry;
  }
  return best;
}

function beginShow(queue, id) {
  const entry = queue.get(String(id || ""));
  if (!entry) return null;
  entry.showing = true;
  entry.attempts += 1;
  return entry;
}

// The renderer confirmed a real, user-present dwell (or an interaction).
// Returns true when the id was pending.
function confirmSeen(queue, id) {
  return queue.delete(String(id || ""));
}

// The show did not count (user away, screen dark, renderer died). The entry
// stays queued; after SHOW_RETRY_LIMIT failed dwells it turns sticky so the
// next presentation latches open until interacted with instead of folding.
function abortShow(queue, id, { now = Date.now() } = {}) {
  const entry = queue.get(String(id || ""));
  if (!entry) return null;
  entry.showing = false;
  if (entry.attempts >= SHOW_RETRY_LIMIT) entry.sticky = true;
  // A failed dwell cools off before re-presenting (90s, then 3m, then 6m…):
  // the card must never re-peek the moment it folds (David's law) — and a
  // genuinely-away user still gets the fail-closed replay, just calmly.
  entry.notBefore = now + Math.min(90000 * Math.max(1, entry.attempts), 15 * 60000);
  return entry;
}

// The user acted on the relay through another path (opened it, deleted it,
// read it on the web/another device, mark-all-read). That is "seen".
function drop(queue, id) {
  return queue.delete(String(id || ""));
}

// Remove entries whose relay is no longer unread (read elsewhere, deleted,
// tombstoned). unreadIds is the currently-staged unread set.
function reconcileWithUnread(queue, unreadIds) {
  const unread = unreadIds instanceof Set ? unreadIds : new Set(unreadIds || []);
  const dropped = [];
  for (const id of [...queue.keys()]) {
    if (!unread.has(id)) {
      queue.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

function pendingCount(queue) {
  return queue.size;
}

function hasShowing(queue) {
  for (const entry of queue.values()) if (entry.showing) return true;
  return false;
}

module.exports = {
  SHOW_RETRY_LIMIT,
  loadQueue,
  saveQueue,
  enqueueUnseen,
  nextToShow,
  beginShow,
  confirmSeen,
  abortShow,
  drop,
  reconcileWithUnread,
  pendingCount,
  hasShowing,
};
