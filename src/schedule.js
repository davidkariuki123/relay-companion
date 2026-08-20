// The engine behind scheduled requests (RELAY_REQUESTS_SHIP_PLAN §10).
//
// Three entities, and this file only knows about the first two:
//   Schedule — the standing contract (cadence, route, policies, state).
//   Run      — one instance of that contract, identified by a DETERMINISTIC id.
//   Completion draft — one run's letter home (not this file's business).
//
// Everything here is pure: no filesystem, no network, no timers, no mutation of
// its arguments. The caller (task-daemon) owns persistence and spawning; this
// module answers "when", "which", "how many", and "under what id" — nothing else.
//
// THE ZONE LAW. A schedule fires on the RECIPIENT'S wall clock, so every
// calculation runs through Intl.DateTimeFormat with an IANA timeZone. A fixed
// UTC offset is never assumed anywhere in this file: "9:00 every day" is 13:00Z
// in a New York winter and 13:00Z-minus-an-hour in summer, and both are the same
// promise. DST edges obey §10.1 exactly:
//   - a wall time that does NOT exist (spring forward) fires at the first valid
//     instant — the moment the clock jumps over it;
//   - a wall time that happens TWICE (fall back) fires ONCE, at the first.
// Never double-fire, never silently skip.
//
// THE ANCHOR. RFC 5545 hangs a recurrence off DTSTART. A Relay schedule has no
// DTSTART, so `createdAt` plays that role: it supplies INTERVAL's phase ("every
// 2 weeks" counted from where) and any day the rule leaves unsaid (WEEKLY with
// no BYDAY, MONTHLY with no BYMONTHDAY, YEARLY's month). createdAt — not
// acceptedAt — because the fire times shown on the accept sheet must be the ones
// that actually happen after Accept is pressed.
//
// TIME OF DAY. BYHOUR/BYMINUTE default to 0, not to the anchor's clock time: a
// schedule written without a time is midnight, which is what §10.1's "every 2nd
// of the month · 00:00" says, and it never surprises anyone with 14:37.

import { createHash } from "node:crypto";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Policy floor from §10.1: no schedule may fire more often than this. */
export const MIN_FIRE_INTERVAL_MS = 5 * MINUTE_MS;

/** §10.3: `catchUp:"all"` replays sequentially capped at 10; the rest coalesce. */
export const CATCH_UP_REPLAY_CAP = 10;

/**
 * How late a fire may be and still count as "on time" rather than "missed".
 * The daemon polls on a few-second cadence; anything older than this window
 * means the machine was away, which is what catchUp is a policy about.
 */
export const DEFAULT_GRACE_MS = 5 * MINUTE_MS;

/** The ledger's map name. task-daemon keeps other dedupe maps beside it. */
export const LEDGER_KEY = "scheduleRuns";

const RUN_TERMINAL_STATES = new Set(["done", "failed", "skipped"]);
const SCHEDULE_STATES = new Set([
  "proposed",
  "accepted",
  "declined",
  "paused",
  "ended",
  "revoked",
]);
/** States whose future is over — no preview, no fires. */
const DEAD_STATES = new Set(["declined", "ended", "revoked"]);
const CATCH_UP_POLICIES = new Set(["latest", "all", "skip"]);
const OVERLAP_POLICIES = new Set(["skip", "queue"]);

// Guard against an unsatisfiable rule scanning forever. Every loop step is one
// day, one skipped month, or one skipped year, so this covers decades.
const MAX_SCAN_STEPS = 20000;

// How many owed fires a single recovery will enumerate — about thirteen years
// of a daily schedule. Past this the coalesced count stops being interesting
// and the memory does not need to be spent.
const MAX_OWED_FIRES = 5000;

// ---------------------------------------------------------------------------
// Zone primitives
// ---------------------------------------------------------------------------

const formatterCache = new Map();

function zoneFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new Error(`schedule: unknown timezone ${JSON.stringify(timeZone)}`);
    }
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock fields an instant shows in a zone. */
function zonedParts(instantMs, timeZone) {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instantMs));
  const out = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function utcMsFromCivil(year, month, day, hour = 0, minute = 0, second = 0) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (year >= 0 && year < 100) {
    // Date.UTC maps 0–99 into the 1900s; undo that for the (never-in-practice)
    // ancient case so the math stays honest.
    const d = new Date(ms);
    d.setUTCFullYear(year);
    return d.getTime();
  }
  return ms;
}

/** The zone's offset from UTC, in ms, at a given instant. */
function zoneOffsetMs(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  const asIfUtc = utcMsFromCivil(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instantMs / SECOND_MS) * SECOND_MS;
}

/**
 * Every instant that shows this wall time in this zone: two on a fall-back
 * hour, one normally, NONE inside a spring-forward gap. (The Temporal
 * "possible instants" algorithm: probe the offset a day either side, and keep
 * only the candidates that round-trip back to the wall time asked for.)
 */
function wallToInstants(wall, timeZone) {
  const guess = utcMsFromCivil(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second || 0);
  const before = zoneOffsetMs(guess - DAY_MS, timeZone);
  const after = zoneOffsetMs(guess + DAY_MS, timeZone);
  const offsets = before === after ? [before] : [before, after];
  const hits = [];
  for (const offset of offsets) {
    const ts = guess - offset;
    const p = zonedParts(ts, timeZone);
    if (
      p.year === wall.year &&
      p.month === wall.month &&
      p.day === wall.day &&
      p.hour === wall.hour &&
      p.minute === wall.minute &&
      p.second === (wall.second || 0)
    ) {
      hits.push(ts);
    }
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

/** The instant a zone's clock first reads >= the (nonexistent) wall time. */
function gapEndInstant(wall, timeZone) {
  const guess = utcMsFromCivil(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second || 0);
  let lo = guess - DAY_MS;
  let hi = guess + DAY_MS;
  const offLo = zoneOffsetMs(lo, timeZone);
  if (zoneOffsetMs(hi, timeZone) === offLo) return guess - offLo; // no transition: shouldn't happen
  while (hi - lo > SECOND_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / SECOND_MS) * SECOND_MS;
    if (mid === lo) break;
    if (zoneOffsetMs(mid, timeZone) === offLo) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The single instant a wall time fires at, per the DST law:
 * doubled → the FIRST of the two; nonexistent → the first valid instant.
 */
function wallToInstant(wall, timeZone) {
  const hits = wallToInstants(wall, timeZone);
  if (hits.length) return hits[0];
  return gapEndInstant(wall, timeZone);
}

function offsetLabel(offsetMs) {
  const sign = offsetMs < 0 ? "-" : "+";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / HOUR_MS);
  const minutes = Math.floor((abs % HOUR_MS) / MINUTE_MS);
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * An instant as an ISO-8601 string in the schedule's zone — wall time the
 * recipient recognises, offset attached so the instant stays unambiguous.
 * e.g. 2026-03-09T09:00:00-04:00
 */
function formatZonedISO(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  const offset = zoneOffsetMs(instantMs, timeZone);
  return (
    `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}` +
    `T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${offsetLabel(offset)}`
  );
}

// ---------------------------------------------------------------------------
// Civil-calendar helpers (pure day arithmetic, no zone involved)
// ---------------------------------------------------------------------------

function epochDayFromCivil(year, month, day) {
  return Math.floor(utcMsFromCivil(year, month, day) / DAY_MS);
}

function civilFromEpochDay(epochDay) {
  const d = new Date(epochDay * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. Epoch day 0 (1970-01-01) was a Thursday. */
function weekdayFromEpochDay(epochDay) {
  return (((epochDay % 7) + 7) % 7 + 4) % 7;
}

/** Monday-started week index (RFC's default WKST=MO). */
function weekIndexFromEpochDay(epochDay) {
  return Math.floor((epochDay + 3) / 7);
}

function daysInMonth(year, month) {
  return new Date(utcMsFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - DAY_MS).getUTCDate();
}

/**
 * The nth weekday inside a day range (BYDAY ordinals): ordinal 2 = the second,
 * -1 = the last. Returns an epoch day, or null when the range has no such one.
 */
function nthWeekdayEpochDay(startDay, endDay, weekday, ordinal) {
  if (ordinal > 0) {
    const first = startDay + ((weekday - weekdayFromEpochDay(startDay) + 7) % 7);
    const hit = first + 7 * (ordinal - 1);
    return hit <= endDay ? hit : null;
  }
  const last = endDay - ((weekdayFromEpochDay(endDay) - weekday + 7) % 7);
  const hit = last + 7 * (ordinal + 1);
  return hit >= startDay ? hit : null;
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

// ---------------------------------------------------------------------------
// RRULE
// ---------------------------------------------------------------------------

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const SUPPORTED_PARTS = new Set([
  "FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL",
]);
// Real RFC 5545 parts we deliberately do not implement. Named separately so the
// error says "not supported" rather than "unknown" — the difference between
// "you wrote nonsense" and "Relay can't keep that promise yet".
const KNOWN_UNSUPPORTED = new Set([
  "BYSECOND", "BYMONTH", "BYYEARDAY", "BYWEEKNO", "BYSETPOS", "WKST", "DTSTART", "TZID", "RSCALE", "SKIP",
]);

function fail(message) {
  throw new Error(`rrule: ${message}`);
}

function parseIntStrict(value, label) {
  if (!/^[+-]?\d+$/.test(value)) fail(`${label} must be an integer, got ${JSON.stringify(value)}`);
  return Number.parseInt(value, 10);
}

function parseNumberList(value, label, min, max) {
  const items = value.split(",").map((v) => v.trim());
  if (!items.length || items.some((v) => v === "")) fail(`${label} has an empty value`);
  const out = items.map((v) => {
    const n = parseIntStrict(v, label);
    if (n < min || n > max) fail(`${label}=${n} is outside ${min}..${max}`);
    return n;
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * UNTIL. RFC 5545 writes it as a UTC stamp (20261101T090000Z) or a bare date;
 * Relay schedules also travel as JSON, so a full ISO-8601 string with any
 * offset is accepted and resolved to the same instant. UNTIL is an INSTANT, not
 * a wall time: it may legitimately be pinned in a different zone from the
 * schedule's own, and it means the same moment either way.
 */
function parseUntil(raw) {
  const text = raw.trim();
  let instantMs = null;
  let basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (basic) {
    instantMs = utcMsFromCivil(+basic[1], +basic[2], +basic[3], +basic[4], +basic[5], +basic[6]);
  } else if ((basic = /^(\d{4})(\d{2})(\d{2})$/.exec(text))) {
    instantMs = utcMsFromCivil(+basic[1], +basic[2], +basic[3]);
  } else if (/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) fail(`UNTIL=${JSON.stringify(raw)} is not a date`);
    instantMs = parsed;
  } else if (/^\d{8}T\d{6}$/.test(text)) {
    fail("UNTIL must carry a zone — use the RFC UTC form (…Z) or a full ISO-8601 stamp with an offset");
  } else {
    fail(`UNTIL=${JSON.stringify(raw)} is not a date`);
  }
  if (Number.isNaN(instantMs)) fail(`UNTIL=${JSON.stringify(raw)} is not a date`);
  return { text, instantMs };
}

/**
 * Parse the RFC 5545 subset Relay supports. Anything else throws — an ignored
 * rule part is a broken promise, and a schedule is a promise.
 *
 * Supported: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, BYDAY (with ordinals
 * like 2TU / -1FR), BYMONTHDAY (negatives allowed), BYHOUR, BYMINUTE, COUNT,
 * UNTIL. A leading "RRULE:" is tolerated.
 */
export function parseRRule(rrule) {
  if (typeof rrule !== "string" || !rrule.trim()) fail("expected a non-empty string");
  let text = rrule.trim();
  if (/[\r\n]/.test(text)) fail("must be a single line");
  if (/^RRULE:/i.test(text)) text = text.slice(6).trim();
  if (!text) fail("expected a non-empty string");

  const seen = new Map();
  for (const segment of text.split(";")) {
    const part = segment.trim();
    if (!part) continue;
    const match = /^([A-Za-z-]+)=(.*)$/.exec(part);
    if (!match) fail(`${JSON.stringify(part)} is not NAME=VALUE`);
    const name = match[1].toUpperCase();
    const value = match[2].trim();
    if (seen.has(name)) fail(`${name} appears more than once`);
    if (!SUPPORTED_PARTS.has(name)) {
      if (KNOWN_UNSUPPORTED.has(name)) fail(`${name} is not supported by Relay schedules`);
      fail(`unknown rule part ${name}`);
    }
    if (value === "") fail(`${name} has an empty value`);
    seen.set(name, value);
  }

  if (!seen.has("FREQ")) fail("FREQ is required");
  const freq = seen.get("FREQ").toUpperCase();
  if (!FREQS.has(freq)) {
    fail(`FREQ=${seen.get("FREQ")} is not supported — use DAILY, WEEKLY, MONTHLY or YEARLY`);
  }

  let interval = 1;
  if (seen.has("INTERVAL")) {
    interval = parseIntStrict(seen.get("INTERVAL"), "INTERVAL");
    if (interval < 1) fail(`INTERVAL=${interval} must be 1 or more`);
  }

  let count = null;
  if (seen.has("COUNT")) {
    count = parseIntStrict(seen.get("COUNT"), "COUNT");
    if (count < 1) fail(`COUNT=${count} must be 1 or more`);
  }

  let until = null;
  if (seen.has("UNTIL")) until = parseUntil(seen.get("UNTIL"));
  if (count !== null && until) fail("COUNT and UNTIL cannot both be set");

  let byday = null;
  if (seen.has("BYDAY")) {
    byday = seen
      .get("BYDAY")
      .split(",")
      .map((raw) => {
        const token = raw.trim().toUpperCase();
        const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token);
        if (!m) fail(`BYDAY=${JSON.stringify(raw)} is not a weekday`);
        const dayIndex = DAY_CODES.indexOf(m[2]);
        if (dayIndex < 0) fail(`BYDAY=${JSON.stringify(raw)} is not a weekday`);
        let ordinal = null;
        if (m[1] !== undefined) {
          ordinal = Number.parseInt(m[1], 10);
          if (ordinal === 0) fail("BYDAY ordinal 0 has no meaning");
          if (Math.abs(ordinal) > 53) fail(`BYDAY ordinal ${ordinal} is outside ±53`);
          if (freq === "DAILY" || freq === "WEEKLY") {
            fail(`BYDAY ordinals (${token}) are meaningless with FREQ=${freq}`);
          }
        }
        return { day: m[2], dayIndex, ordinal };
      });
    const keyed = new Map(byday.map((d) => [`${d.ordinal ?? ""}${d.day}`, d]));
    byday = [...keyed.values()];
  }

  let bymonthday = null;
  if (seen.has("BYMONTHDAY")) {
    if (freq === "WEEKLY") fail("BYMONTHDAY cannot be used with FREQ=WEEKLY");
    bymonthday = parseNumberList(seen.get("BYMONTHDAY"), "BYMONTHDAY", -31, 31);
    if (bymonthday.includes(0)) fail("BYMONTHDAY=0 has no meaning");
  }

  const byhour = seen.has("BYHOUR") ? parseNumberList(seen.get("BYHOUR"), "BYHOUR", 0, 23) : null;
  const byminute = seen.has("BYMINUTE") ? parseNumberList(seen.get("BYMINUTE"), "BYMINUTE", 0, 59) : null;

  return { freq, interval, byday, bymonthday, byhour, byminute, count, until, source: text };
}

/** Rewrite only COUNT in a rule's text, leaving the author's wording intact. */
function rruleWithCount(rrule, nextCount) {
  const text = String(rrule);
  if (nextCount === null) return text.replace(/;?\s*COUNT=\d+/i, "");
  return text.replace(/(COUNT=)(\d+)/i, `$1${nextCount}`);
}

// ---------------------------------------------------------------------------
// Schedule reading
// ---------------------------------------------------------------------------

function toInstant(value, label = "time") {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new Error(`schedule: ${label} is an invalid Date`);
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`schedule: ${label} is not a finite timestamp`);
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`schedule: ${label} ${JSON.stringify(value)} is not a date`);
    return ms;
  }
  throw new Error(`schedule: ${label} must be an ISO string, Date or epoch ms`);
}

function timezoneOf(schedule) {
  const tz = schedule?.timezone;
  if (tz) {
    zoneFormatter(tz); // validates, throws with a clear message
    return tz;
  }
  // §10.1: the recipient's zone, resolved at each fire. This machine IS the
  // recipient's machine, so its zone is the answer when none is pinned.
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** RFC's DTSTART stand-in — see THE ANCHOR at the top of this file. */
function anchorInstant(schedule, nowMs) {
  return (
    toInstant(schedule?.createdAt, "createdAt") ??
    toInstant(schedule?.acceptedAt, "acceptedAt") ??
    toInstant(schedule?.lastFireAt, "lastFireAt") ??
    nowMs
  );
}

// ---------------------------------------------------------------------------
// Occurrence expansion
// ---------------------------------------------------------------------------

function dayMatches(rule, civil, anchorCivil) {
  const epochDay = epochDayFromCivil(civil.year, civil.month, civil.day);
  const weekday = weekdayFromEpochDay(epochDay);

  // 1. Is this day inside a period the INTERVAL selects?
  if (rule.freq === "DAILY") {
    const anchorDay = epochDayFromCivil(anchorCivil.year, anchorCivil.month, anchorCivil.day);
    if (mod(epochDay - anchorDay, rule.interval) !== 0) return false;
  } else if (rule.freq === "WEEKLY") {
    const anchorWeek = weekIndexFromEpochDay(
      epochDayFromCivil(anchorCivil.year, anchorCivil.month, anchorCivil.day),
    );
    if (mod(weekIndexFromEpochDay(epochDay) - anchorWeek, rule.interval) !== 0) return false;
  } else if (rule.freq === "MONTHLY") {
    const months = (civil.year - anchorCivil.year) * 12 + (civil.month - anchorCivil.month);
    if (mod(months, rule.interval) !== 0) return false;
  } else if (rule.freq === "YEARLY") {
    if (mod(civil.year - anchorCivil.year, rule.interval) !== 0) return false;
  }

  // 2. Does the day itself match the BY* parts (or the anchor's default day)?
  const hasDayFilter = Boolean(rule.byday || rule.bymonthday);

  if (rule.bymonthday) {
    const dim = daysInMonth(civil.year, civil.month);
    const ok = rule.bymonthday.some((d) => (d > 0 ? d === civil.day : dim + d + 1 === civil.day));
    if (!ok) return false;
  }

  if (rule.byday) {
    const ok = rule.byday.some((entry) => {
      if (entry.dayIndex !== weekday) return false;
      if (entry.ordinal === null) return true;
      // Ordinals count inside the month for MONTHLY, inside the year for YEARLY
      // (RFC 5545's scoping — "-1FR" of a yearly rule is the year's last Friday).
      const [startDay, endDay] =
        rule.freq === "YEARLY"
          ? [epochDayFromCivil(civil.year, 1, 1), epochDayFromCivil(civil.year, 12, 31)]
          : [
              epochDayFromCivil(civil.year, civil.month, 1),
              epochDayFromCivil(civil.year, civil.month, daysInMonth(civil.year, civil.month)),
            ];
      return nthWeekdayEpochDay(startDay, endDay, entry.dayIndex, entry.ordinal) === epochDay;
    });
    if (!ok) return false;
  }

  if (!hasDayFilter) {
    // Nothing said which day, so the anchor says it — RFC's DTSTART default.
    // Note the RFC behaviour for impossible dates: a monthly rule anchored on
    // the 31st simply has no February occurrence. Clamping to the 28th would
    // invent a fire nobody asked for.
    if (rule.freq === "WEEKLY") {
      const anchorWeekday = weekdayFromEpochDay(
        epochDayFromCivil(anchorCivil.year, anchorCivil.month, anchorCivil.day),
      );
      if (weekday !== anchorWeekday) return false;
    } else if (rule.freq === "MONTHLY") {
      if (civil.day !== anchorCivil.day) return false;
    } else if (rule.freq === "YEARLY") {
      if (civil.month !== anchorCivil.month || civil.day !== anchorCivil.day) return false;
    }
  }

  return true;
}

/**
 * Fire instants strictly after `fromMs`, ascending, honouring UNTIL and COUNT.
 * Yields at most `limit`. Duplicate instants (two wall times folded onto one by
 * a DST gap) collapse to one — never double-fire.
 */
function* occurrences(rule, { timeZone, anchorMs, fromMs, limit }) {
  const hours = rule.byhour ?? [0];
  const minutes = rule.byminute ?? [0];
  const anchorCivil = zonedParts(anchorMs, timeZone);
  const startCivil = zonedParts(fromMs, timeZone);

  let epochDay = epochDayFromCivil(startCivil.year, startCivil.month, startCivil.day);
  let emitted = 0;
  let lastInstant = -Infinity;
  const cap = rule.count === null ? Infinity : rule.count;

  for (let step = 0; step < MAX_SCAN_STEPS; step += 1) {
    if (emitted >= limit || emitted >= cap) return;
    const civil = civilFromEpochDay(epochDay);

    // Skip whole ineligible years/months in one step instead of day by day.
    if (rule.freq === "YEARLY" && mod(civil.year - anchorCivil.year, rule.interval) !== 0) {
      epochDay = epochDayFromCivil(civil.year + 1, 1, 1);
      continue;
    }
    if (rule.freq === "MONTHLY") {
      const months = (civil.year - anchorCivil.year) * 12 + (civil.month - anchorCivil.month);
      if (mod(months, rule.interval) !== 0) {
        epochDay = epochDayFromCivil(
          civil.month === 12 ? civil.year + 1 : civil.year,
          civil.month === 12 ? 1 : civil.month + 1,
          1,
        );
        continue;
      }
    }

    if (dayMatches(rule, civil, anchorCivil)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const instant = wallToInstant(
            { year: civil.year, month: civil.month, day: civil.day, hour, minute, second: 0 },
            timeZone,
          );
          if (instant <= fromMs || instant <= lastInstant) continue;
          if (rule.until && instant > rule.until.instantMs) return;
          lastInstant = instant;
          yield instant;
          emitted += 1;
          if (emitted >= limit || emitted >= cap) return;
        }
      }
    }
    epochDay += 1;
  }
}

function scheduleOccurrences(schedule, { fromMs, limit, nowMs }) {
  const rule = parseRRule(schedule?.rrule);
  const timeZone = timezoneOf(schedule);
  const anchorMs = anchorInstant(schedule, nowMs);
  return [...occurrences(rule, { timeZone, anchorMs, fromMs, limit })];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The next fire times, as ISO-8601 strings carrying the schedule's zone offset
 * — the accept sheet's "next 3 fire times in the recipient's clock", and the
 * echo-back the sending agent self-checks against its intent.
 *
 * Fires are strictly after `after` (default: now). Dead contracts (declined /
 * ended / revoked) have no future and return []. A paused schedule still
 * previews — pause is reversible and the UI has to be able to say what resumes.
 */
export function nextFireTimes(schedule, { after, count = 3, now } = {}) {
  const nowMs = toInstant(now, "now") ?? Date.now();
  const wanted = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (!wanted) return [];
  if (schedule?.state && DEAD_STATES.has(schedule.state)) return [];
  const fromMs = toInstant(after, "after") ?? nowMs;
  const timeZone = timezoneOf(schedule);
  return scheduleOccurrences(schedule, { fromMs, limit: wanted, nowMs }).map((ms) =>
    formatZonedISO(ms, timeZone),
  );
}

function timeOfDayPhrase(rule) {
  const hours = rule.byhour ?? [0];
  const minutes = rule.byminute ?? [0];
  const stamps = [];
  // Hours run unpadded — "9:00", the way a person says it — except midnight,
  // which is written "00:00" because a bare "0:00" reads like a typo. Both
  // spellings are §10.1's own ("every weekday · 9:00", "every 2nd of the
  // month · 00:00").
  for (const h of hours) for (const m of minutes) stamps.push(`${h === 0 ? "00" : h}:${pad2(m)}`);
  stamps.sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || a.localeCompare(b));
  if (stamps.length === 1) return stamps[0];
  if (stamps.length === 2) return `${stamps[0]} and ${stamps[1]}`;
  if (stamps.length === 3) return `${stamps[0]}, ${stamps[1]} and ${stamps[2]}`;
  return `${stamps.length} times a day`;
}

function ordinalWord(n) {
  const abs = Math.abs(n);
  const suffix =
    abs % 100 >= 11 && abs % 100 <= 13
      ? "th"
      : abs % 10 === 1
        ? "st"
        : abs % 10 === 2
          ? "nd"
          : abs % 10 === 3
            ? "rd"
            : "th";
  return `${abs}${suffix}`;
}

function monthdayWord(n) {
  if (n === -1) return "last day";
  if (n < 0) return `${ordinalWord(n)} last day`;
  return ordinalWord(n);
}

function bydayOrdinalWord(n) {
  if (n === -1) return "last";
  if (n < 0) return `${ordinalWord(n)} last`;
  return ordinalWord(n);
}

function listPhrase(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const WEEKDAY_SET = "MO,TU,WE,TH,FR";

function cadencePhrase(rule, anchorCivil) {
  const every = (n, unit) => (n === 1 ? `every ${unit}` : n === 2 ? `every other ${unit}` : `every ${n} ${unit}s`);

  if (rule.freq === "DAILY") {
    if (rule.byday || rule.bymonthday) return null; // a filtered daily rule is not phraseable
    return every(rule.interval, "day");
  }

  if (rule.freq === "WEEKLY") {
    const days = rule.byday
      ? rule.byday.map((d) => d.dayIndex)
      : [weekdayFromEpochDay(epochDayFromCivil(anchorCivil.year, anchorCivil.month, anchorCivil.day))];
    const codes = [...days].sort((a, b) => a - b).map((i) => DAY_CODES[i]);
    if (codes.length === 7) return every(rule.interval, "day");
    const isWeekdays = codes.slice().sort().join(",") === WEEKDAY_SET.split(",").sort().join(",");
    if (isWeekdays && rule.interval === 1) return "every weekday";
    const names = [...days].sort((a, b) => mod(a - 1, 7) - mod(b - 1, 7)).map((i) => DAY_NAMES[i]);
    if (rule.interval === 1) return `every ${listPhrase(names)}`;
    if (rule.interval === 2 && names.length === 1) return `every other ${names[0]}`;
    return `every ${rule.interval} weeks on ${listPhrase(names)}`;
  }

  if (rule.freq === "MONTHLY") {
    let what = null;
    if (rule.bymonthday && !rule.byday) {
      what = listPhrase(rule.bymonthday.map(monthdayWord));
    } else if (rule.byday && !rule.bymonthday) {
      if (rule.byday.some((d) => d.ordinal === null)) return null; // "every tuesday of the month" is a weekly rule in disguise
      what = listPhrase(rule.byday.map((d) => `${bydayOrdinalWord(d.ordinal)} ${DAY_NAMES[d.dayIndex]}`));
    } else if (!rule.byday && !rule.bymonthday) {
      what = monthdayWord(anchorCivil.day);
    } else {
      return null; // BYDAY and BYMONTHDAY together — say the truth instead
    }
    if (rule.interval === 1) return `every ${what} of the month`;
    if (rule.interval === 2) return `every other month on the ${what}`;
    return `every ${rule.interval} months on the ${what}`;
  }

  if (rule.freq === "YEARLY") {
    if (rule.byday) return null;
    const day = rule.bymonthday && rule.bymonthday.length === 1 ? rule.bymonthday[0] : anchorCivil.day;
    if (day < 0) return null;
    const when = `${day} ${MONTH_NAMES[anchorCivil.month - 1]}`;
    if (rule.interval === 1) return `every year on ${when}`;
    return `every ${rule.interval} years on ${when}`;
  }

  return null;
}

/** "thu 21 aug" — the short date the fallback phrase leans on. */
function shortDatePhrase(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone);
  const weekday = weekdayFromEpochDay(epochDayFromCivil(p.year, p.month, p.day));
  return `${DAY_SHORT[weekday]} ${p.day} ${MONTH_SHORT[p.month - 1]}`;
}

/** The last segment of an IANA zone, humanised: Europe/Berlin → Berlin. */
function zoneLabel(timeZone) {
  const tail = String(timeZone).split("/").pop() || String(timeZone);
  return tail.replace(/_/g, " ");
}

/**
 * The calm human phrase for a cadence — never RRULE, never cron-speak.
 *   "every weekday · 9:00", "every monday · 9:00", "every 2nd of the month · 0:00"
 * Too baroque to phrase? Render the truth instead: "recurring · next thu 21 aug · 9:00".
 *
 * Pass `localTimezone` (the reader's own zone) and a foreign pinned zone is
 * appended — "· 9:00 Berlin" — exactly as §10.1 requires and never otherwise.
 */
export function describeCadence(schedule, { localTimezone, now } = {}) {
  const nowMs = toInstant(now, "now") ?? Date.now();
  const rule = parseRRule(schedule?.rrule);
  const timeZone = timezoneOf(schedule);
  const anchorCivil = zonedParts(anchorInstant(schedule, nowMs), timeZone);
  const zoneSuffix = localTimezone && localTimezone !== timeZone ? ` ${zoneLabel(timeZone)}` : "";

  const phrase = cadencePhrase(rule, anchorCivil);
  if (phrase) return `${phrase} · ${timeOfDayPhrase(rule)}${zoneSuffix}`;

  const [next] = nextFireTimes(schedule, { now: nowMs, count: 1 });
  if (!next) return "recurring";
  const instant = Date.parse(next);
  return `recurring · next ${shortDatePhrase(instant, timeZone)} · ${timeOfDayPhrase(rule)}${zoneSuffix}`;
}

/**
 * "in 5d" / "in 3h" / "in 12m" — the countdown beside a next-fire time.
 * Floors, so it never over-promises; anything due, overdue, or under a minute
 * away reads "now".
 */
export function describeCountdown(nextISO, now) {
  const target = toInstant(nextISO, "next fire");
  if (target === null) return "now";
  const nowMs = toInstant(now, "now") ?? Date.now();
  const delta = target - nowMs;
  if (delta < MINUTE_MS) return "now";
  if (delta < HOUR_MS) return `in ${Math.floor(delta / MINUTE_MS)}m`;
  if (delta < DAY_MS) return `in ${Math.floor(delta / HOUR_MS)}h`;
  return `in ${Math.floor(delta / DAY_MS)}d`;
}

/**
 * The run id — hash(scheduleId, scheduledFireTime) — and the whole
 * exactly-once mechanism (§10.2). The fire time is normalised to its UTC
 * instant first, so the same moment written in two zones (or with a different
 * offset spelling) is the same run, never two.
 */
export function runIdFor(scheduleId, scheduledFireTimeISO) {
  const id = String(scheduleId ?? "").trim();
  if (!id) throw new Error("schedule: runIdFor needs a scheduleId");
  const instant = toInstant(scheduledFireTimeISO, "scheduled fire time");
  if (instant === null) throw new Error("schedule: runIdFor needs a scheduled fire time");
  const canonical = new Date(instant).toISOString();
  const digest = createHash("sha256").update(`${id} ${canonical}`).digest("hex");
  return `run_${digest.slice(0, 24)}`;
}

function makeRun(schedule, fireMs, { coversFires, coveredFromMs, timeZone, coalesced }) {
  return {
    runId: runIdFor(schedule.id, new Date(fireMs).toISOString()),
    scheduleId: schedule.id,
    scheduledFor: formatZonedISO(fireMs, timeZone),
    scheduledForUTC: new Date(fireMs).toISOString(),
    coversFires,
    coveredFrom: formatZonedISO(coveredFromMs, timeZone),
    coveredThrough: formatZonedISO(fireMs, timeZone),
    coalesced,
    contractVersion: schedule.contractVersion ?? null,
  };
}

/**
 * Which fires are owed, with `catchUp` applied (§10.3).
 *
 * Owed = every fire in (since, now]. A fire inside `graceMs` of now is ON TIME —
 * the daemon's ordinary tick — and always runs whatever the policy says; older
 * ones are MISSED, which is what catchUp is a policy about:
 *   "latest" — all owed fires coalesce into ONE run at the newest of them,
 *              reporting how many it covers.
 *   "all"    — the 10 most recent replay individually; anything older than that
 *              coalesces into one leading catch-up run, so the FRESH work keeps
 *              its detail and the ancient work is summarised.
 *   "skip"   — the missed ones are dropped; only an on-time fire runs.
 *
 * Returns { policy, missed, onTime, runs, skipped, next, exhausted }. Run
 * ordering is chronological; run ids are deterministic, so calling this twice
 * with the same inputs (a crash, a restart) yields the same ids.
 */
export function dueFires(schedule, { since, now, graceMs = DEFAULT_GRACE_MS, maxReplays = CATCH_UP_REPLAY_CAP } = {}) {
  const nowMs = toInstant(now, "now") ?? Date.now();
  const timeZone = timezoneOf(schedule);
  const policy = schedule?.catchUp ?? "latest";
  if (!CATCH_UP_POLICIES.has(policy)) {
    throw new Error(`schedule: unknown catchUp policy ${JSON.stringify(schedule?.catchUp)}`);
  }

  const empty = { policy, missed: 0, onTime: 0, runs: [], skipped: 0, next: null, exhausted: true };
  // Only an accepted contract may fire. A dead one owes nothing; a proposed one
  // has never run anything (§10.10) and its fires do not accrue.
  if (schedule?.state !== "accepted" && schedule?.state !== "paused") {
    if (schedule?.state && DEAD_STATES.has(schedule.state)) return empty;
    return { ...empty, next: nextFireTimes(schedule, { now: nowMs, count: 1 })[0] ?? null, exhausted: false };
  }

  const sinceMs =
    toInstant(since, "since") ??
    toInstant(schedule.lastFireAt, "lastFireAt") ??
    toInstant(schedule.acceptedAt, "acceptedAt") ??
    toInstant(schedule.createdAt, "createdAt") ??
    nowMs;

  // Well past the replay cap, so "how many did this cover" stays honest even
  // when the policy coalesces them; COUNT/UNTIL still bound the stream.
  const owed = scheduleOccurrences(schedule, {
    fromMs: sinceMs,
    limit: Math.max(maxReplays + 1, MAX_OWED_FIRES),
    nowMs,
  }).filter((ms) => ms <= nowMs);

  const nextISO = nextFireTimes(schedule, { after: Math.max(nowMs, sinceMs), now: nowMs, count: 1 })[0] ?? null;
  const onTimeCount = owed.filter((ms) => nowMs - ms <= graceMs).length;
  const missedCount = owed.length - onTimeCount;

  if (!owed.length) {
    return { policy, missed: 0, onTime: 0, runs: [], skipped: 0, next: nextISO, exhausted: nextISO === null };
  }

  const result = { policy, missed: missedCount, onTime: onTimeCount, runs: [], skipped: 0, next: nextISO, exhausted: nextISO === null };

  // Paused at fire time is a skip, not a debt — but the count is reported so
  // the surface can say what the pause cost instead of quietly losing it.
  if (schedule.state === "paused") {
    result.skipped = owed.length;
    return result;
  }

  if (policy === "skip") {
    const onTime = owed.filter((ms) => nowMs - ms <= graceMs);
    result.skipped = owed.length - onTime.length;
    // Several fires inside one grace window is still one "now" — coalesce them.
    if (onTime.length) {
      result.runs.push(
        makeRun(schedule, onTime[onTime.length - 1], {
          coversFires: onTime.length,
          coveredFromMs: onTime[0],
          timeZone,
          coalesced: onTime.length > 1,
        }),
      );
    }
    return result;
  }

  if (policy === "latest") {
    result.runs.push(
      makeRun(schedule, owed[owed.length - 1], {
        coversFires: owed.length,
        coveredFromMs: owed[0],
        timeZone,
        coalesced: owed.length > 1,
      }),
    );
    return result;
  }

  // policy === "all"
  const cap = Math.max(0, Math.trunc(maxReplays));
  const replayFrom = Math.max(0, owed.length - cap);
  const remainder = owed.slice(0, replayFrom);
  if (remainder.length) {
    result.runs.push(
      makeRun(schedule, remainder[remainder.length - 1], {
        coversFires: remainder.length,
        coveredFromMs: remainder[0],
        timeZone,
        coalesced: true,
      }),
    );
  }
  for (const ms of owed.slice(replayFrom)) {
    result.runs.push(
      makeRun(schedule, ms, { coversFires: 1, coveredFromMs: ms, timeZone, coalesced: false }),
    );
  }
  return result;
}

/**
 * Record that a fire happened: stamps lastFireAt, decrements COUNT by the
 * number of occurrences the run covered (a coalesced run consumes every
 * occurrence it stands in for), and ends the schedule the moment UNTIL or
 * COUNT leaves it with no future. Returns a NEW schedule; the input is
 * untouched.
 */
export function advanceSchedule(schedule, { firedAt, coversFires = 1, now } = {}) {
  const nowMs = toInstant(now, "now") ?? Date.now();
  const firedMs = toInstant(firedAt, "firedAt") ?? nowMs;
  const rule = parseRRule(schedule?.rrule);
  const covered = Math.max(1, Math.trunc(coversFires));

  const next = { ...schedule, lastFireAt: new Date(firedMs).toISOString() };

  if (rule.count !== null) {
    const remaining = Math.max(0, rule.count - covered);
    // COUNT=0 is not a legal RRULE, so an exhausted rule keeps its last legal
    // text and `state` carries the truth. Leaving it parseable matters: the
    // surfaces still have to describe a schedule after it ends.
    next.rrule = remaining > 0 ? rruleWithCount(schedule.rrule, remaining) : schedule.rrule;
    if (remaining <= 0) {
      next.state = "ended";
      next.endedReason = "count";
      return next;
    }
  }

  const future = scheduleOccurrences(next, { fromMs: firedMs, limit: 1, nowMs });
  if (!future.length) {
    next.state = "ended";
    next.endedReason = rule.until ? "until" : "exhausted";
  }
  return next;
}

// ---------------------------------------------------------------------------
// The fire ledger — exactly-once across crashes
// ---------------------------------------------------------------------------

function ledgerRuns(ledger) {
  const runs = ledger && typeof ledger === "object" ? ledger[LEDGER_KEY] : null;
  return runs && typeof runs === "object" && !Array.isArray(runs) ? runs : {};
}

/**
 * Claim a runId BEFORE spawning. Returns { ledger, fresh, entry }:
 * `fresh` is true only the first time a run is claimed, so the caller spawns on
 * true and, on false, consults ledgerIsDone — a claimed-but-unfinished run is a
 * crash, and it resumes under the SAME id rather than becoming a second run.
 * Never mutates the ledger it is handed.
 */
export function ledgerCommit(ledger, runId, { now, state = "running", ...extra } = {}) {
  const id = String(runId ?? "").trim();
  if (!id) throw new Error("schedule: ledgerCommit needs a runId");
  const at = new Date(toInstant(now, "now") ?? Date.now()).toISOString();
  const runs = ledgerRuns(ledger);
  const prior = runs[id];

  const entry = prior
    ? { ...prior, ...extra, state: prior.state, attempts: (prior.attempts || 1) + 1, lastSeenAt: at }
    : { runId: id, state, attempts: 1, committedAt: at, lastSeenAt: at, ...extra };

  return {
    ledger: { ...(ledger && typeof ledger === "object" ? ledger : {}), [LEDGER_KEY]: { ...runs, [id]: entry } },
    fresh: !prior,
    entry,
  };
}

/** True once a run reached a terminal state — the never-run-it-twice test. */
export function ledgerIsDone(ledger, runId) {
  const entry = ledgerRuns(ledger)[String(runId ?? "").trim()];
  return Boolean(entry && RUN_TERMINAL_STATES.has(entry.state));
}

/** Mark a claimed run terminal (done | failed | skipped). Returns a new ledger. */
export function ledgerSettle(ledger, runId, { state = "done", now, ...extra } = {}) {
  const id = String(runId ?? "").trim();
  if (!id) throw new Error("schedule: ledgerSettle needs a runId");
  if (!RUN_TERMINAL_STATES.has(state)) {
    throw new Error(`schedule: ${JSON.stringify(state)} is not a terminal run state`);
  }
  const at = new Date(toInstant(now, "now") ?? Date.now()).toISOString();
  const runs = ledgerRuns(ledger);
  const prior = runs[id] || { runId: id, attempts: 1, committedAt: at };
  const entry = { ...prior, ...extra, state, settledAt: at, lastSeenAt: at };
  return {
    ledger: { ...(ledger && typeof ledger === "object" ? ledger : {}), [LEDGER_KEY]: { ...runs, [id]: entry } },
    entry,
  };
}

/**
 * Keep the newest `keep` runs. The ledger is written on every daemon poll, so
 * an unbounded map turns into a multi-megabyte write every few seconds.
 */
export function ledgerPrune(ledger, { keep = 500 } = {}) {
  const runs = ledgerRuns(ledger);
  const ids = Object.keys(runs);
  if (ids.length <= keep) return ledger && typeof ledger === "object" ? ledger : {};
  const kept = ids
    .sort((a, b) => Date.parse(runs[b].lastSeenAt || runs[b].committedAt || 0) - Date.parse(runs[a].lastSeenAt || runs[a].committedAt || 0))
    .slice(0, keep);
  const next = {};
  for (const id of kept) next[id] = runs[id];
  return { ...ledger, [LEDGER_KEY]: next };
}

// ---------------------------------------------------------------------------
// Contract validation (§10.1)
// ---------------------------------------------------------------------------

/**
 * The gate a schedule passes before it can be proposed: the rule parses, the
 * zone exists, there is at least one future occurrence, the policy enums are
 * real, and the cadence respects the one-fire-per-5-minutes floor. Returns the
 * next 3 fire times so the sending agent can check them against its intent.
 */
export function validateSchedule(schedule, { now } = {}) {
  const nowMs = toInstant(now, "now") ?? Date.now();
  const errors = [];
  let next = [];
  let cadence = null;

  try {
    parseRRule(schedule?.rrule);
  } catch (err) {
    errors.push(err.message);
  }

  if (schedule?.timezone) {
    try {
      zoneFormatter(schedule.timezone);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (schedule?.catchUp !== undefined && !CATCH_UP_POLICIES.has(schedule.catchUp)) {
    errors.push(`schedule: catchUp must be latest, all or skip`);
  }
  if (schedule?.overlap !== undefined && !OVERLAP_POLICIES.has(schedule.overlap)) {
    errors.push(`schedule: overlap must be skip or queue`);
  }
  if (schedule?.state !== undefined && !SCHEDULE_STATES.has(schedule.state)) {
    errors.push(`schedule: ${JSON.stringify(schedule.state)} is not a schedule state`);
  }
  if (schedule?.maxRunMinutes !== undefined && schedule.maxRunMinutes !== null) {
    const n = Number(schedule.maxRunMinutes);
    if (!Number.isFinite(n) || n <= 0) errors.push("schedule: maxRunMinutes must be a positive number");
  }

  if (!errors.length) {
    const timeZone = timezoneOf(schedule);
    const upcoming = scheduleOccurrences(schedule, { fromMs: nowMs, limit: 4, nowMs });
    if (!upcoming.length) errors.push("schedule: the rule has no future occurrence");
    for (let i = 1; i < upcoming.length; i += 1) {
      if (upcoming[i] - upcoming[i - 1] < MIN_FIRE_INTERVAL_MS) {
        errors.push("schedule: fires more often than once every 5 minutes");
        break;
      }
    }
    next = upcoming.slice(0, 3).map((ms) => formatZonedISO(ms, timeZone));
    if (upcoming.length) cadence = describeCadence(schedule, { now: nowMs });
  }

  return { ok: errors.length === 0, errors, next, cadence };
}
