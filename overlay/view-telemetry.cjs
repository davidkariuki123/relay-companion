"use strict";

// HOW PEOPLE USE THE APP'S SIZES (Shane, 2026-10-09). Before the full app
// reaches production we want to know whether people use it: how often they
// switch between the pill, the card and the full app, how long they stay in
// each, how often they fold it down to the pill, and how often they close it
// or quit Relay.
//
// The pill reports which view is on screen; this module turns that into
// running totals and sends them to the API about every half hour as one
// content-free report. Totals, not a stream of events: a report that cannot be
// sent (offline, an older API) is folded back in and goes with the next one,
// so nothing is lost and the number of requests stays the same however much
// the person switches. The totals are kept on disk, so a restart, an update
// or a crash loses at most the last minute.
//
// Views:
//   full      the full app (fills the screen; features.fullAppExpand)
//   expanded  Expand for everyone else: the two-thirds card
//   card      the small card or the reader
//   banner    an arrival banner
//   pill      folded down to the smallest size
//   hidden    the window is off screen (✕, the menu-bar icon, Keep Relay hidden)
//
// The full app and the two-thirds card are told apart by the account's
// fullAppExpand, which is also sent with every report.
// Time asleep or locked is not counted at all, and neither is time Relay was
// not running: "off" appears only as the start or end of a switch.
//
// Each switch is counted by where it came from, where it went and what caused
// it, so "switched into the full app with the Expand button" and "folded to
// the pill with Minimize" are separate counts.

const VIEWS = ["full", "expanded", "card", "banner", "pill", "hidden"];
const VIEW_SET = new Set(VIEWS);
const ENDPOINTS = new Set([...VIEWS, "off"]);
const CAUSES = new Set([
  "expand_button", // the titlebar's Expand / Collapse switch
  "shortcut", // ⌘⇧E
  "dock", // the Dock icon, Relay.app or a launch that asks for the full app
  "menu_bar", // the status-area icon or its menu
  "minimise_button", // the titlebar's Minimize: folds to the pill
  "pill_tap", // a tap on the pill or the card's lockup
  "banner_tap", // a tap on an arrival banner
  "close", // the card's ✕
  "arrival", // a new Relay came in
  "launch", // Relay started
  "quit", // Quit Relay
  "exit", // Relay stopped for another reason: an update, a restart, a sign-out
  "other",
]);
const FLUSH_EVERY_MS = 30 * 60 * 1000;
const SAVE_EVERY_MS = 60 * 1000;
// A cause belongs to the switch it started, not to one seconds later.
const CAUSE_TTL_MS = 3000;
// Bounds the report however strange the history: 7 endpoints × 7 × causes.
const MAX_TRANSITIONS = 200;

function emptyTotals(at) {
  return { periodStart: at, views: {}, transitions: {}, quits: 0, exits: 0, unfinished: 0 };
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function mergeTotals(into, from) {
  if (!from) return into;
  into.periodStart = Math.min(into.periodStart, Number(from.periodStart) || into.periodStart);
  for (const [view, row] of Object.entries(from.views || {})) {
    if (!VIEW_SET.has(view)) continue;
    const mine = into.views[view] || (into.views[view] = { ms: 0, focusedMs: 0, entries: 0 });
    mine.ms += count(row.ms);
    mine.focusedMs += count(row.focusedMs);
    mine.entries += count(row.entries);
  }
  for (const [key, n] of Object.entries(from.transitions || {})) {
    if (!count(n)) continue;
    if (!(key in into.transitions) && Object.keys(into.transitions).length >= MAX_TRANSITIONS) continue;
    into.transitions[key] = (into.transitions[key] || 0) + count(n);
  }
  into.quits += count(from.quits);
  into.exits += count(from.exits);
  into.unfinished += count(from.unfinished);
  return into;
}

function hasData(totals) {
  return Object.values(totals.views).some((row) => row.ms > 0 || row.entries > 0)
    || Object.keys(totals.transitions).length > 0 || totals.quits > 0 || totals.exits > 0;
}

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {() => any} [options.load] the saved state, or null
 * @param {(state: object) => void} [options.save]
 * @param {(report: object) => Promise<{ ok: boolean, retry?: boolean }>} options.send
 * @param {() => boolean} [options.fullAppAvailable]
 */
function createViewTelemetry({ now = Date.now, load = () => null, save = () => {}, send, fullAppAvailable = () => false } = {}) {
  let totals = emptyTotals(now());
  // The view on screen and since when. null: not counting (before start,
  // after stop, or while asleep).
  let current = null;
  let focused = false;
  let away = false;
  // Stopping is final: the window's own hide on the way out is not a switch.
  let stopped = false;
  let pendingCause = null;
  let lastSavedAt = 0;
  let lastFlushAt = now();
  let sending = null;

  // What the last run left behind: its totals, a report it was still sending,
  // and the view it was in. A view still open means Relay stopped without
  // saying so (a crash, a forced stop, the computer turning off); its time is
  // counted up to the last save, never across the gap.
  try {
    const saved = load();
    if (saved && typeof saved === "object") {
      mergeTotals(totals, saved.totals);
      mergeTotals(totals, saved.sending);
      const open = saved.current;
      if (open && VIEW_SET.has(open.view) && Number(saved.savedAt) >= Number(open.since)) {
        credit(open.view, Number(saved.savedAt) - Number(open.since), open.focused ? Number(saved.savedAt) - Number(open.focusedSince || open.since) : 0);
        bump(`${open.view}>off>exit`);
        totals.unfinished += 1;
      }
    }
  } catch {}

  function credit(view, ms, focusedMs = 0) {
    const row = totals.views[view] || (totals.views[view] = { ms: 0, focusedMs: 0, entries: 0 });
    row.ms += count(ms);
    row.focusedMs += count(focusedMs);
  }
  function bump(key) {
    if (!(key in totals.transitions) && Object.keys(totals.transitions).length >= MAX_TRANSITIONS) return;
    totals.transitions[key] = (totals.transitions[key] || 0) + 1;
  }
  function takeCause(at) {
    const cause = pendingCause && at - pendingCause.at <= CAUSE_TTL_MS ? pendingCause.cause : null;
    pendingCause = null;
    return cause;
  }
  // Close the open view's time up to `at` and keep it open from there.
  function checkpoint(at) {
    if (!current) return;
    credit(current.view, at - current.since, focused ? at - current.focusedSince : 0);
    current.since = at;
    current.focusedSince = at;
  }
  function persist(at) {
    lastSavedAt = at;
    try {
      save({
        v: 1,
        savedAt: at,
        totals,
        sending: sending ? sending.totals : null,
        current: current ? { view: current.view, since: current.since, focused, focusedSince: current.focusedSince } : null,
      });
    } catch {}
  }
  function enter(view, cause, at) {
    const from = current ? current.view : "off";
    if (current) checkpoint(at);
    current = { view, since: at, focusedSince: at };
    const row = totals.views[view] || (totals.views[view] = { ms: 0, focusedMs: 0, entries: 0 });
    row.entries += 1;
    bump(`${from}>${view}>${cause}`);
  }

  function report(at) {
    const views = {};
    for (const view of VIEWS) {
      const row = totals.views[view];
      if (row && (row.ms > 0 || row.entries > 0)) views[view] = { ms: row.ms, focusedMs: row.focusedMs, entries: row.entries };
    }
    const transitions = Object.entries(totals.transitions).map(([key, n]) => {
      const [from, to, cause] = key.split(">");
      return { from, to, cause, count: n };
    });
    return {
      periodStart: new Date(totals.periodStart).toISOString(),
      periodEnd: new Date(at).toISOString(),
      fullAppAvailable: Boolean(fullAppAvailable()),
      views,
      transitions,
      quits: totals.quits,
      exits: totals.exits,
      unfinished: totals.unfinished,
    };
  }

  return {
    /** The renderer or main says why the next switch is about to happen. */
    cause(cause) {
      if (CAUSES.has(cause)) pendingCause = { cause, at: now() };
    },
    /** The view now on screen. Repeats of the same view are ignored. */
    view(view, cause) {
      if (!VIEW_SET.has(view) || away || stopped) return;
      const at = now();
      if (CAUSES.has(cause)) pendingCause = { cause, at };
      if (current && current.view === view) return;
      enter(view, takeCause(at) || (current ? "other" : "launch"), at);
      persist(at);
    },
    focus(next) {
      next = Boolean(next);
      if (next === focused) return;
      const at = now();
      if (current) {
        if (focused) credit(current.view, 0, at - current.focusedSince);
        // Time is credited by checkpoint; focus only moves its own mark.
        current.focusedSince = at;
      }
      focused = next;
    },
    /** Asleep or locked: nobody is looking, so no view is counted. */
    away(next, viewNow) {
      next = Boolean(next);
      if (next === away || stopped) return;
      const at = now();
      if (next) {
        if (current) checkpoint(at);
        current = null;
        away = true;
      } else {
        away = false;
        if (VIEW_SET.has(viewNow)) {
          current = { view: viewNow, since: at, focusedSince: at };
        }
      }
      persist(at);
    },
    /** Relay is stopping. `quit` is the person's own Quit Relay. */
    stop(reason = "exit") {
      if (stopped) return;
      stopped = true;
      const at = now();
      const cause = reason === "quit" ? "quit" : "exit";
      if (current) {
        checkpoint(at);
        bump(`${current.view}>off>${cause}`);
        current = null;
      }
      if (cause === "quit") totals.quits += 1;
      else totals.exits += 1;
      persist(at);
    },
    /** Called every few seconds: saves each minute and sends each half hour. */
    tick({ force = false } = {}) {
      const at = now();
      if (force || at - lastSavedAt >= SAVE_EVERY_MS) {
        checkpoint(at);
        persist(at);
      }
      if (force || at - lastFlushAt >= FLUSH_EVERY_MS) return this.flush();
      return Promise.resolve(false);
    },
    /** Send what has been counted since the last report. */
    async flush() {
      if (sending || typeof send !== "function") return false;
      const at = now();
      lastFlushAt = at;
      checkpoint(at);
      if (!hasData(totals)) return false;
      const body = report(at);
      sending = { totals };
      totals = emptyTotals(at);
      persist(at);
      let result = null;
      try { result = await send(body); } catch { result = { ok: false, retry: true }; }
      const unsent = sending.totals;
      sending = null;
      // Sent, or refused as malformed (sending it again would be refused
      // again): either way it is done. Anything else goes with the next one.
      if (!(result && result.ok) && result?.retry !== false) mergeTotals(totals, unsent);
      persist(now());
      return Boolean(result && result.ok);
    },
    snapshot() {
      return { current: current ? current.view : null, focused, away, totals: JSON.parse(JSON.stringify(totals)) };
    },
  };
}

module.exports = { createViewTelemetry, VIEWS, CAUSES, FLUSH_EVERY_MS, SAVE_EVERY_MS, CAUSE_TTL_MS };
