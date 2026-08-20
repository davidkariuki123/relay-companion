import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCH_UP_REPLAY_CAP,
  LEDGER_KEY,
  MIN_FIRE_INTERVAL_MS,
  advanceSchedule,
  describeCadence,
  describeCountdown,
  dueFires,
  ledgerCommit,
  ledgerIsDone,
  ledgerPrune,
  ledgerSettle,
  nextFireTimes,
  parseRRule,
  runIdFor,
  validateSchedule,
} from "../src/schedule.js";

// 2026's real transitions, which every DST test below leans on:
//   America/New_York  spring 2026-03-08 (02:00→03:00)  fall 2026-11-01 (02:00→01:00)
//   Europe/London     spring 2026-03-29 (01:00→02:00)  fall 2026-10-25 (02:00→01:00)
const NY = "America/New_York";
const LONDON = "Europe/London";

function schedule(over = {}) {
  return {
    id: "sch_morning",
    relayId: "rly_1",
    threadId: "thr_1",
    briefHash: "sha256:abc",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timezone: NY,
    catchUp: "latest",
    overlap: "skip",
    maxRunMinutes: 30,
    autoSend: false,
    route: [{ app: "claude", model: "opus", effort: "high" }],
    state: "accepted",
    contractVersion: 1,
    acceptedAt: "2026-01-01T12:00:00Z",
    lastFireAt: null,
    createdAt: "2026-01-01T12:00:00Z",
    ...over,
  };
}

const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;

// ---------------------------------------------------------------------------
// parseRRule
// ---------------------------------------------------------------------------

test("parseRRule reads the supported subset", () => {
  const rule = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30;COUNT=10");
  assert.equal(rule.freq, "WEEKLY");
  assert.equal(rule.interval, 2);
  assert.deepEqual(
    rule.byday.map((d) => d.day),
    ["MO", "WE"],
  );
  assert.deepEqual(rule.byhour, [9]);
  assert.deepEqual(rule.byminute, [30]);
  assert.equal(rule.count, 10);
  assert.equal(rule.until, null);
});

test("parseRRule defaults INTERVAL to 1 and leaves absent BY parts null", () => {
  const rule = parseRRule("FREQ=DAILY");
  assert.equal(rule.interval, 1);
  assert.equal(rule.byday, null);
  assert.equal(rule.bymonthday, null);
  assert.equal(rule.byhour, null);
  assert.equal(rule.byminute, null);
});

test("parseRRule keeps BYDAY ordinals, positive and negative", () => {
  assert.deepEqual(parseRRule("FREQ=MONTHLY;BYDAY=2TU").byday, [{ day: "TU", dayIndex: 2, ordinal: 2 }]);
  assert.deepEqual(parseRRule("FREQ=MONTHLY;BYDAY=-1FR").byday, [{ day: "FR", dayIndex: 5, ordinal: -1 }]);
  assert.deepEqual(parseRRule("FREQ=MONTHLY;BYDAY=+1MO").byday, [{ day: "MO", dayIndex: 1, ordinal: 1 }]);
});

test("parseRRule normalises lists and tolerates an RRULE: prefix", () => {
  const rule = parseRRule("RRULE:FREQ=DAILY;BYHOUR=17,9,9;BYMINUTE=30");
  assert.deepEqual(rule.byhour, [9, 17], "sorted and de-duplicated");
  assert.equal(rule.freq, "DAILY");
});

test("parseRRule accepts UNTIL in RFC basic form, bare date, or ISO with an offset", () => {
  assert.equal(parseRRule("FREQ=DAILY;UNTIL=20261101T090000Z").until.instantMs, Date.parse("2026-11-01T09:00:00Z"));
  assert.equal(parseRRule("FREQ=DAILY;UNTIL=20261101").until.instantMs, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(
    parseRRule("FREQ=DAILY;UNTIL=2026-11-01T09:00:00+02:00").until.instantMs,
    Date.parse("2026-11-01T07:00:00Z"),
    "UNTIL is an instant, so a foreign offset resolves to the same moment",
  );
});

test("parseRRule refuses every unsupported part instead of ignoring it", () => {
  // The whole point: a silently-dropped rule part is a broken promise.
  assert.throws(() => parseRRule("FREQ=DAILY;BYSETPOS=-1"), /BYSETPOS is not supported/);
  assert.throws(() => parseRRule("FREQ=YEARLY;BYMONTH=3"), /BYMONTH is not supported/);
  assert.throws(() => parseRRule("FREQ=WEEKLY;WKST=SU"), /WKST is not supported/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYSECOND=0"), /BYSECOND is not supported/);
  assert.throws(() => parseRRule("FREQ=WEEKLY;BYWEEKNO=3"), /BYWEEKNO is not supported/);
  assert.throws(() => parseRRule("FREQ=YEARLY;BYYEARDAY=10"), /BYYEARDAY is not supported/);
  assert.throws(() => parseRRule("FREQ=DAILY;DTSTART=20260101T090000Z"), /DTSTART is not supported/);
  assert.throws(() => parseRRule("FREQ=DAILY;NONSENSE=1"), /unknown rule part NONSENSE/);
});

test("parseRRule rejects malformed and self-contradicting rules", () => {
  assert.throws(() => parseRRule(""), /non-empty string/);
  assert.throws(() => parseRRule(null), /non-empty string/);
  assert.throws(() => parseRRule("every day at 9"), /is not NAME=VALUE/);
  assert.throws(() => parseRRule("BYHOUR=9"), /FREQ is required/);
  assert.throws(() => parseRRule("FREQ=HOURLY"), /FREQ=HOURLY is not supported/);
  assert.throws(() => parseRRule("FREQ=DAILY;FREQ=WEEKLY"), /FREQ appears more than once/);
  assert.throws(() => parseRRule("FREQ=DAILY;COUNT=3;UNTIL=20261101T090000Z"), /COUNT and UNTIL cannot both be set/);
  assert.throws(() => parseRRule("FREQ=DAILY;INTERVAL=0"), /INTERVAL=0 must be 1 or more/);
  assert.throws(() => parseRRule("FREQ=DAILY;COUNT=0"), /COUNT=0 must be 1 or more/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYHOUR=24"), /BYHOUR=24 is outside 0\.\.23/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYMINUTE=60"), /BYMINUTE=60 is outside 0\.\.59/);
  assert.throws(() => parseRRule("FREQ=MONTHLY;BYMONTHDAY=0"), /BYMONTHDAY=0 has no meaning/);
  assert.throws(() => parseRRule("FREQ=MONTHLY;BYDAY=0TU"), /ordinal 0 has no meaning/);
  assert.throws(() => parseRRule("FREQ=MONTHLY;BYDAY=XX"), /is not a weekday/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYHOUR="), /BYHOUR has an empty value/);
  assert.throws(() => parseRRule("FREQ=DAILY;UNTIL=soon"), /is not a date/);
  assert.throws(() => parseRRule("FREQ=DAILY;UNTIL=20261101T090000"), /UNTIL must carry a zone/);
});

test("parseRRule rejects BY parts that contradict their FREQ", () => {
  // RFC 5545: ordinals are meaningless without a month or year to count inside.
  assert.throws(() => parseRRule("FREQ=WEEKLY;BYDAY=2TU"), /ordinals \(2TU\) are meaningless with FREQ=WEEKLY/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYDAY=-1FR"), /ordinals \(-1FR\) are meaningless with FREQ=DAILY/);
  assert.throws(() => parseRRule("FREQ=WEEKLY;BYMONTHDAY=1"), /BYMONTHDAY cannot be used with FREQ=WEEKLY/);
});

// ---------------------------------------------------------------------------
// nextFireTimes — the ordinary cases
// ---------------------------------------------------------------------------

test("nextFireTimes returns the recipient's clock with the zone attached", () => {
  const next = nextFireTimes(schedule(), { after: "2026-08-13T12:00:00-04:00", count: 3 });
  assert.deepEqual(next, [
    "2026-08-14T09:00:00-04:00",
    "2026-08-15T09:00:00-04:00",
    "2026-08-16T09:00:00-04:00",
  ]);
});

test("nextFireTimes defaults to the next 3 after now, exclusive of now itself", () => {
  const now = "2026-08-14T09:00:00-04:00"; // exactly on a fire
  const next = nextFireTimes(schedule(), { now });
  assert.equal(next.length, 3);
  assert.equal(next[0], "2026-08-15T09:00:00-04:00", "a fire at exactly `after` is behind us");
});

test("nextFireTimes honours BYDAY, giving weekdays only", () => {
  const s = schedule({ rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9" });
  const next = nextFireTimes(s, { after: "2026-08-14T12:00:00-04:00", count: 3 }); // Friday afternoon
  assert.deepEqual(next, [
    "2026-08-17T09:00:00-04:00", // Monday — the weekend is skipped
    "2026-08-18T09:00:00-04:00",
    "2026-08-19T09:00:00-04:00",
  ]);
});

test("nextFireTimes counts INTERVAL from createdAt, so the preview matches what happens", () => {
  // Anchored on Monday 3 Aug; "every 2 weeks" must land on 3, 17, 31 — not on
  // whatever week the caller happens to ask from.
  const s = schedule({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9", createdAt: "2026-08-03T09:00:00-04:00" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-08-03T12:00:00-04:00", count: 3 }), [
    "2026-08-17T09:00:00-04:00",
    "2026-08-31T09:00:00-04:00",
    "2026-09-14T09:00:00-04:00",
  ]);
  // Asking from a different week does not shift the phase.
  assert.equal(nextFireTimes(s, { after: "2026-08-10T00:00:00-04:00", count: 1 })[0], "2026-08-17T09:00:00-04:00");
});

test("nextFireTimes takes the unsaid day from the anchor, RFC's DTSTART rule", () => {
  const weekly = schedule({ rrule: "FREQ=WEEKLY;BYHOUR=9", createdAt: "2026-08-05T09:00:00-04:00" }); // a Wednesday
  assert.deepEqual(nextFireTimes(weekly, { after: "2026-08-05T12:00:00-04:00", count: 2 }), [
    "2026-08-12T09:00:00-04:00",
    "2026-08-19T09:00:00-04:00",
  ]);
  const monthly = schedule({ rrule: "FREQ=MONTHLY;BYHOUR=9", createdAt: "2026-08-05T09:00:00-04:00" });
  assert.deepEqual(nextFireTimes(monthly, { after: "2026-08-05T12:00:00-04:00", count: 2 }), [
    "2026-09-05T09:00:00-04:00",
    "2026-10-05T09:00:00-04:00",
  ]);
  const yearly = schedule({ rrule: "FREQ=YEARLY;BYHOUR=9", createdAt: "2026-08-05T09:00:00-04:00" });
  assert.deepEqual(nextFireTimes(yearly, { after: "2026-08-05T12:00:00-04:00", count: 2 }), [
    "2027-08-05T09:00:00-04:00",
    "2028-08-05T09:00:00-04:00",
  ]);
});

test("nextFireTimes defaults the time of day to midnight, not to the anchor's clock", () => {
  const s = schedule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=2", createdAt: "2026-08-05T14:37:11-04:00" });
  assert.equal(nextFireTimes(s, { after: "2026-08-13T12:00:00-04:00", count: 1 })[0], "2026-09-02T00:00:00-04:00");
});

test("nextFireTimes skips months a day-of-month cannot exist in (RFC, not clamping)", () => {
  const s = schedule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-01-01T00:00:00-05:00", count: 3 }), [
    "2026-01-31T09:00:00-05:00",
    "2026-03-31T09:00:00-04:00", // February has no 31st — inventing the 28th would be a lie
    "2026-05-31T09:00:00-04:00",
  ]);
});

test("nextFireTimes reads negative BYMONTHDAY as days from the month's end", () => {
  const s = schedule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-01-01T00:00:00-05:00", count: 3 }), [
    "2026-01-31T17:00:00-05:00",
    "2026-02-28T17:00:00-05:00",
    "2026-03-31T17:00:00-04:00",
  ]);
});

test("nextFireTimes resolves BYDAY ordinals inside the month", () => {
  const second = schedule({ rrule: "FREQ=MONTHLY;BYDAY=2TU;BYHOUR=9" });
  assert.deepEqual(nextFireTimes(second, { after: "2026-01-01T00:00:00-05:00", count: 3 }), [
    "2026-01-13T09:00:00-05:00",
    "2026-02-10T09:00:00-05:00",
    "2026-03-10T09:00:00-04:00",
  ]);
  const last = schedule({ rrule: "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17" });
  assert.deepEqual(nextFireTimes(last, { after: "2026-01-01T00:00:00-05:00", count: 3 }), [
    "2026-01-30T17:00:00-05:00",
    "2026-02-27T17:00:00-05:00",
    "2026-03-27T17:00:00-04:00",
  ]);
});

test("nextFireTimes resolves a YEARLY BYDAY ordinal inside the YEAR", () => {
  // RFC 5545 scopes the ordinal to the FREQ's period: -1FR of a yearly rule is
  // the last Friday of the year, not of December-as-a-month (same day here) —
  // and 2TU is January's second Tuesday, not February's.
  const s = schedule({ rrule: "FREQ=YEARLY;BYDAY=2TU;BYHOUR=9" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-01-01T00:00:00-05:00", count: 2 }), [
    "2026-01-13T09:00:00-05:00",
    "2027-01-12T09:00:00-05:00",
  ]);
});

test("nextFireTimes expands several times of day per fire, in order", () => {
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-08-13T00:00:00-04:00", count: 5 }), [
    "2026-08-13T09:00:00-04:00",
    "2026-08-13T09:30:00-04:00",
    "2026-08-13T17:00:00-04:00",
    "2026-08-13T17:30:00-04:00",
    "2026-08-14T09:00:00-04:00",
  ]);
});

test("nextFireTimes stops at UNTIL and at COUNT", () => {
  const until = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;UNTIL=20260816T235959Z" });
  assert.deepEqual(nextFireTimes(until, { after: "2026-08-13T12:00:00-04:00", count: 10 }), [
    "2026-08-14T09:00:00-04:00",
    "2026-08-15T09:00:00-04:00",
    "2026-08-16T09:00:00-04:00",
  ]);
  const counted = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;COUNT=2" });
  assert.equal(nextFireTimes(counted, { after: "2026-08-13T12:00:00-04:00", count: 10 }).length, 2);
});

test("UNTIL pinned in another zone cuts the schedule where that instant falls", () => {
  // UNTIL 09:00 Berlin is 03:00 in New York, so the New York 09:00 fire on the
  // 15th is already past the end — a naive same-wall-clock reading would keep it.
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;UNTIL=2026-08-15T09:00:00+02:00" });
  assert.deepEqual(nextFireTimes(s, { after: "2026-08-13T12:00:00-04:00", count: 10 }), [
    "2026-08-14T09:00:00-04:00",
  ]);
  assert.equal(
    parseRRule(s.rrule).until.instantMs,
    Date.parse("2026-08-15T03:00:00-04:00"),
    "the same instant, read in the schedule's own zone",
  );
});

test("nextFireTimes previews proposed and paused schedules, never dead ones", () => {
  assert.equal(nextFireTimes(schedule({ state: "proposed" }), { now: "2026-08-13T12:00:00Z" }).length, 3);
  assert.equal(nextFireTimes(schedule({ state: "paused" }), { now: "2026-08-13T12:00:00Z" }).length, 3);
  for (const state of ["declined", "ended", "revoked"]) {
    assert.deepEqual(nextFireTimes(schedule({ state }), { now: "2026-08-13T12:00:00Z" }), [], state);
  }
});

test("nextFireTimes rejects an unknown timezone rather than guessing", () => {
  assert.throws(
    () => nextFireTimes(schedule({ timezone: "Mars/Olympus" }), { now: "2026-08-13T12:00:00Z" }),
    /unknown timezone "Mars\/Olympus"/,
  );
});

// ---------------------------------------------------------------------------
// nextFireTimes — DST
// ---------------------------------------------------------------------------

test("DST spring forward: 9:00 stays 9:00 and the day is 23 hours long", () => {
  const next = nextFireTimes(schedule(), { after: "2026-03-06T00:00:00-05:00", count: 4 });
  assert.deepEqual(next, [
    "2026-03-06T09:00:00-05:00",
    "2026-03-07T09:00:00-05:00",
    "2026-03-08T09:00:00-04:00", // the clock moved, the promise did not
    "2026-03-09T09:00:00-04:00",
  ]);
  assert.equal(hours(next[1], next[2]), 23, "the transition day is 23 real hours");
  assert.equal(hours(next[2], next[3]), 24);
});

test("DST fall back: 9:00 stays 9:00 and the day is 25 hours long", () => {
  const next = nextFireTimes(schedule(), { after: "2026-10-30T00:00:00-04:00", count: 4 });
  assert.deepEqual(next, [
    "2026-10-30T09:00:00-04:00",
    "2026-10-31T09:00:00-04:00",
    "2026-11-01T09:00:00-05:00",
    "2026-11-02T09:00:00-05:00",
  ]);
  assert.equal(hours(next[1], next[2]), 25, "the transition day is 25 real hours");
});

test("DST: a wall time that does not exist fires at the first valid instant", () => {
  // 02:30 never happens on 2026-03-08 in New York — the clock jumps 02:00→03:00.
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30" });
  const next = nextFireTimes(s, { after: "2026-03-07T12:00:00-05:00", count: 3 });
  assert.deepEqual(next, [
    "2026-03-08T03:00:00-04:00", // the instant the clock jumps over 02:30
    "2026-03-09T02:30:00-04:00",
    "2026-03-10T02:30:00-04:00",
  ]);
  assert.equal(
    new Date(Date.parse(next[0])).toISOString(),
    "2026-03-08T07:00:00.000Z",
    "exactly the transition instant — never skipped, never doubled",
  );
});

test("DST: a wall time that happens twice fires ONCE, at the first of the two", () => {
  // 01:30 happens twice on 2026-11-01 in New York: 05:30Z (EDT) and 06:30Z (EST).
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30" });
  const next = nextFireTimes(s, { after: "2026-10-31T12:00:00-04:00", count: 3 });
  assert.deepEqual(next, [
    "2026-11-01T01:30:00-04:00",
    "2026-11-02T01:30:00-05:00",
    "2026-11-03T01:30:00-05:00",
  ]);
  assert.equal(new Date(Date.parse(next[0])).toISOString(), "2026-11-01T05:30:00.000Z", "the earlier instant");
  assert.equal(next.filter((iso) => iso.startsWith("2026-11-01")).length, 1, "fires once, not twice");
});

test("DST in the other hemisphere of the calendar: Europe/London", () => {
  const gap = schedule({ timezone: LONDON, rrule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30" });
  assert.deepEqual(nextFireTimes(gap, { after: "2026-03-28T00:00:00Z", count: 3 }), [
    "2026-03-28T01:30:00+00:00",
    "2026-03-29T02:00:00+01:00", // 01:30 does not exist; fire when the clock reaches 02:00
    "2026-03-30T01:30:00+01:00",
  ]);
  assert.deepEqual(nextFireTimes(gap, { after: "2026-10-24T00:00:00Z", count: 3 }), [
    "2026-10-24T01:30:00+01:00",
    "2026-10-25T01:30:00+01:00", // the BST instance, not the repeat an hour later
    "2026-10-26T01:30:00+00:00",
  ]);
  const nine = schedule({ timezone: LONDON, rrule: "FREQ=DAILY;BYHOUR=9" });
  const across = nextFireTimes(nine, { after: "2026-03-28T00:00:00Z", count: 2 });
  assert.deepEqual(across, ["2026-03-28T09:00:00+00:00", "2026-03-29T09:00:00+01:00"]);
  assert.equal(hours(across[0], across[1]), 23);
});

test("DST: two wall times folded onto one instant by the gap fire only once", () => {
  // 02:00 and 03:00 on 2026-03-08 in New York are the same instant (07:00Z).
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=2,3" });
  const next = nextFireTimes(s, { after: "2026-03-08T00:00:00-05:00", count: 3 });
  assert.deepEqual(next, [
    "2026-03-08T03:00:00-04:00",
    "2026-03-09T02:00:00-04:00",
    "2026-03-09T03:00:00-04:00",
  ]);
  assert.equal(new Set(next.map((iso) => Date.parse(iso))).size, 3, "no instant repeats");
});

test("DST: a fire inside the repeated hour gets ONE run id, not two", () => {
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30" });
  const [fire] = nextFireTimes(s, { after: "2026-10-31T12:00:00-04:00", count: 1 });
  const ids = new Set([runIdFor(s.id, fire), runIdFor(s.id, "2026-11-01T05:30:00Z")]);
  assert.equal(ids.size, 1, "the same instant is the same run however it is spelled");
});

// ---------------------------------------------------------------------------
// describeCadence / describeCountdown
// ---------------------------------------------------------------------------

test("describeCadence speaks plain lowercase english", () => {
  const say = (rrule, over) => describeCadence(schedule({ rrule, ...over }), { now: "2026-08-13T12:00:00Z" });
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9"), "every monday · 9:00");
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9"), "every weekday · 9:00");
  assert.equal(say("FREQ=MONTHLY;BYMONTHDAY=2"), "every 2nd of the month · 00:00");
  assert.equal(say("FREQ=DAILY;BYHOUR=9"), "every day · 9:00");
  assert.equal(say("FREQ=DAILY;INTERVAL=2;BYHOUR=9"), "every other day · 9:00");
  assert.equal(say("FREQ=DAILY;INTERVAL=3;BYHOUR=9"), "every 3 days · 9:00");
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9"), "every monday and wednesday · 9:00");
  assert.equal(say("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9"), "every monday, wednesday and friday · 9:00");
  assert.equal(say("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9"), "every other tuesday · 9:00");
  assert.equal(say("FREQ=WEEKLY;INTERVAL=3;BYDAY=TU;BYHOUR=9"), "every 3 weeks on tuesday · 9:00");
  assert.equal(say("FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYHOUR=9"), "every day · 9:00");
  assert.equal(say("FREQ=MONTHLY;BYDAY=2TU;BYHOUR=9"), "every 2nd tuesday of the month · 9:00");
  assert.equal(say("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17"), "every last friday of the month · 17:00");
  assert.equal(say("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=17"), "every last day of the month · 17:00");
  assert.equal(say("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1;BYHOUR=9"), "every 3 months on the 1st · 9:00");
  assert.equal(
    say("FREQ=MONTHLY;BYHOUR=9", { createdAt: "2026-08-21T09:00:00-04:00" }),
    "every 21st of the month · 9:00",
    "the anchor supplies the day the rule left unsaid",
  );
  assert.equal(
    say("FREQ=YEARLY;BYHOUR=9", { createdAt: "2026-08-21T09:00:00-04:00" }),
    "every year on 21 august · 9:00",
  );
  assert.equal(say("FREQ=DAILY;BYHOUR=9,17"), "every day · 9:00 and 17:00");
  assert.equal(say("FREQ=DAILY;BYHOUR=9,13,17"), "every day · 9:00, 13:00 and 17:00");
  assert.equal(say("FREQ=DAILY;BYHOUR=9,11,13,17"), "every day · 4 times a day");
});

test("describeCadence renders the truth when the rule is too baroque to phrase", () => {
  const s = schedule({ rrule: "FREQ=MONTHLY;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8;BYHOUR=9" });
  assert.equal(describeCadence(s, { now: "2026-08-13T12:00:00Z" }), "recurring · next tue 8 sep · 9:00");
});

test("describeCadence appends the zone only when it is pinned foreign", () => {
  const berlin = schedule({ timezone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" });
  assert.equal(describeCadence(berlin, { localTimezone: NY, now: "2026-08-13T12:00:00Z" }), "every monday · 9:00 Berlin");
  assert.equal(describeCadence(berlin, { localTimezone: "Europe/Berlin", now: "2026-08-13T12:00:00Z" }), "every monday · 9:00");
  assert.equal(describeCadence(berlin, { now: "2026-08-13T12:00:00Z" }), "every monday · 9:00", "no reader zone, no suffix");
});

test("describeCountdown floors into one unit and never over-promises", () => {
  const now = "2026-08-13T11:00:00-04:00";
  assert.equal(describeCountdown("2026-08-18T09:00:00-04:00", now), "in 4d"); // 4d22h, floored
  assert.equal(describeCountdown("2026-08-14T11:00:00-04:00", now), "in 1d");
  assert.equal(describeCountdown("2026-08-13T14:00:00-04:00", now), "in 3h");
  assert.equal(describeCountdown("2026-08-13T11:12:00-04:00", now), "in 12m");
  assert.equal(describeCountdown("2026-08-13T11:00:30-04:00", now), "now");
  assert.equal(describeCountdown("2026-08-13T10:00:00-04:00", now), "now", "overdue reads now, never negative");
  assert.equal(describeCountdown(null, now), "now");
});

// ---------------------------------------------------------------------------
// runIdFor
// ---------------------------------------------------------------------------

test("runIdFor is deterministic and independent of how the instant is spelled", () => {
  const a = runIdFor("sch_1", "2026-08-13T09:00:00-04:00");
  assert.equal(a, runIdFor("sch_1", "2026-08-13T09:00:00-04:00"));
  assert.equal(a, runIdFor("sch_1", "2026-08-13T13:00:00Z"), "same instant, other zone, same run");
  assert.equal(a, runIdFor("sch_1", new Date("2026-08-13T13:00:00Z")));
  assert.equal(a, runIdFor("sch_1", Date.parse("2026-08-13T13:00:00Z")));
  assert.match(a, /^run_[0-9a-f]{24}$/);
});

test("runIdFor separates schedules and fire times", () => {
  const ids = new Set([
    runIdFor("sch_1", "2026-08-13T13:00:00Z"),
    runIdFor("sch_2", "2026-08-13T13:00:00Z"),
    runIdFor("sch_1", "2026-08-14T13:00:00Z"),
  ]);
  assert.equal(ids.size, 3);
  assert.throws(() => runIdFor("", "2026-08-13T13:00:00Z"), /needs a scheduleId/);
  assert.throws(() => runIdFor("sch_1", "not a time"), /is not a date/);
  assert.throws(() => runIdFor("sch_1", null), /needs a scheduled fire time/);
});

// ---------------------------------------------------------------------------
// dueFires
// ---------------------------------------------------------------------------

test("dueFires owes nothing when nothing has come due", () => {
  const out = dueFires(schedule(), { since: "2026-08-13T09:00:00-04:00", now: "2026-08-13T10:00:00-04:00" });
  assert.deepEqual(out.runs, []);
  assert.equal(out.missed, 0);
  assert.equal(out.next, "2026-08-14T09:00:00-04:00");
  assert.equal(out.exhausted, false);
});

test("dueFires runs an on-time fire under every catchUp policy", () => {
  // The daemon's ordinary tick: the fire is seconds old, not a missed one, so
  // even catchUp:"skip" must run it — otherwise a skip schedule never fires.
  for (const catchUp of ["latest", "all", "skip"]) {
    const out = dueFires(schedule({ catchUp }), {
      since: "2026-08-12T09:00:00-04:00",
      now: "2026-08-13T09:00:20-04:00",
    });
    assert.equal(out.runs.length, 1, catchUp);
    assert.equal(out.onTime, 1, catchUp);
    assert.equal(out.missed, 0, catchUp);
    assert.equal(out.runs[0].scheduledFor, "2026-08-13T09:00:00-04:00", catchUp);
    assert.equal(out.runs[0].coversFires, 1, catchUp);
  }
});

test("catchUp latest: two weeks asleep coalesce into ONE run that says what it covers", () => {
  const out = dueFires(schedule({ catchUp: "latest" }), {
    since: "2026-07-30T09:00:00-04:00",
    now: "2026-08-13T11:00:00-04:00",
  });
  assert.equal(out.missed, 14);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].coversFires, 14, "the seed can say: covers 14 missed fires");
  assert.equal(out.runs[0].coveredFrom, "2026-07-31T09:00:00-04:00");
  assert.equal(out.runs[0].scheduledFor, "2026-08-13T09:00:00-04:00", "the run stands at the newest owed fire");
  assert.equal(out.runs[0].coalesced, true);
  assert.equal(out.next, "2026-08-14T09:00:00-04:00");
});

test("catchUp all: two weeks asleep replay, capped at 10, remainder coalesced first", () => {
  const out = dueFires(schedule({ catchUp: "all" }), {
    since: "2026-07-30T09:00:00-04:00",
    now: "2026-08-13T11:00:00-04:00",
  });
  assert.equal(out.missed, 14);
  assert.equal(out.runs.length, CATCH_UP_REPLAY_CAP + 1, "10 replays plus one catch-up run");
  const [first, ...rest] = out.runs;
  assert.equal(first.coalesced, true);
  assert.equal(first.coversFires, 4, "the four oldest are summarised");
  assert.equal(first.coveredFrom, "2026-07-31T09:00:00-04:00");
  assert.equal(first.scheduledFor, "2026-08-03T09:00:00-04:00");
  assert.equal(rest.length, 10);
  assert.ok(
    rest.every((r) => r.coversFires === 1 && r.coalesced === false),
    "the ten most recent keep their detail",
  );
  assert.equal(rest[0].scheduledFor, "2026-08-04T09:00:00-04:00");
  assert.equal(rest[9].scheduledFor, "2026-08-13T09:00:00-04:00");
  assert.equal(
    out.runs.reduce((n, r) => n + r.coversFires, 0),
    14,
    "every missed fire is accounted for exactly once",
  );
  const ordered = out.runs.map((r) => Date.parse(r.scheduledForUTC));
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), "chronological");
});

test("catchUp all: under the cap, every missed fire replays individually", () => {
  const out = dueFires(schedule({ catchUp: "all" }), {
    since: "2026-08-10T09:00:00-04:00",
    now: "2026-08-13T11:00:00-04:00",
  });
  assert.equal(out.runs.length, 3);
  assert.ok(out.runs.every((r) => r.coversFires === 1 && !r.coalesced));
});

test("catchUp skip: the missed fires are dropped and the next natural fire is reported", () => {
  const out = dueFires(schedule({ catchUp: "skip" }), {
    since: "2026-07-30T09:00:00-04:00",
    now: "2026-08-13T11:00:00-04:00",
  });
  assert.equal(out.missed, 14);
  assert.equal(out.skipped, 14);
  assert.deepEqual(out.runs, []);
  assert.equal(out.next, "2026-08-14T09:00:00-04:00");
});

test("dueFires carries the contract version each run ran under", () => {
  const out = dueFires(schedule({ contractVersion: 7 }), {
    since: "2026-08-12T09:00:00-04:00",
    now: "2026-08-13T09:00:10-04:00",
  });
  assert.equal(out.runs[0].contractVersion, 7);
});

test("dueFires never runs an unaccepted or dead schedule", () => {
  const window = { since: "2026-07-30T09:00:00-04:00", now: "2026-08-13T11:00:00-04:00" };
  for (const state of ["proposed", "declined", "ended", "revoked"]) {
    const out = dueFires(schedule({ state }), window);
    assert.deepEqual(out.runs, [], state);
    assert.equal(out.missed, 0, `${state} accrues no debt`);
  }
  const paused = dueFires(schedule({ state: "paused" }), window);
  assert.deepEqual(paused.runs, [], "paused at fire time is a skip");
  assert.equal(paused.skipped, 14, "but the surface can still say what the pause cost");
});

test("dueFires stops at UNTIL — a machine that slept past the end owes nothing after it", () => {
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;UNTIL=20260805T235959Z" });
  const out = dueFires(s, { since: "2026-07-30T09:00:00-04:00", now: "2026-08-13T11:00:00-04:00" });
  assert.equal(out.runs[0].coversFires, 6, "31 Jul through 5 Aug, and nothing past UNTIL");
  assert.equal(out.runs[0].scheduledFor, "2026-08-05T09:00:00-04:00");
  assert.equal(out.next, null);
  assert.equal(out.exhausted, true, "the daemon can end it quietly");
});

test("dueFires never owes more fires than COUNT has left", () => {
  const s = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;COUNT=3", catchUp: "all" });
  const out = dueFires(s, { since: "2026-07-30T09:00:00-04:00", now: "2026-08-13T11:00:00-04:00" });
  assert.equal(out.runs.length, 3);
  assert.equal(
    out.runs.reduce((n, r) => n + r.coversFires, 0),
    3,
    "the occurrence stream simply ends — COUNT is not a budget you can overdraw",
  );
});

test("dueFires rejects an unknown catchUp policy", () => {
  assert.throws(
    () => dueFires(schedule({ catchUp: "sometimes" }), { now: "2026-08-13T11:00:00-04:00" }),
    /unknown catchUp policy "sometimes"/,
  );
});

test("dueFires respects DST when counting a sleep across the transition", () => {
  // Asleep from 9:00 on 6 March to 11:00 on 9 March: fires on the 7th, 8th and
  // 9th. The 8th is the 23-hour day; a fixed-offset engine drops or doubles it.
  const out = dueFires(schedule({ catchUp: "all" }), {
    since: "2026-03-06T09:00:00-05:00",
    now: "2026-03-09T11:00:00-04:00",
  });
  assert.deepEqual(
    out.runs.map((r) => r.scheduledFor),
    ["2026-03-07T09:00:00-05:00", "2026-03-08T09:00:00-04:00", "2026-03-09T09:00:00-04:00"],
  );
  const back = dueFires(schedule({ catchUp: "all" }), {
    since: "2026-10-30T09:00:00-04:00",
    now: "2026-11-02T11:00:00-05:00",
  });
  assert.deepEqual(
    back.runs.map((r) => r.scheduledFor),
    ["2026-10-31T09:00:00-04:00", "2026-11-01T09:00:00-05:00", "2026-11-02T09:00:00-05:00"],
  );
});

// ---------------------------------------------------------------------------
// advanceSchedule
// ---------------------------------------------------------------------------

test("advanceSchedule stamps lastFireAt without touching the input", () => {
  const before = schedule();
  const frozen = JSON.stringify(before);
  const after = advanceSchedule(before, { firedAt: "2026-08-13T09:00:00-04:00" });
  assert.equal(after.lastFireAt, "2026-08-13T13:00:00.000Z", "stored canonically in UTC");
  assert.equal(after.state, "accepted");
  assert.equal(JSON.stringify(before), frozen, "the caller's schedule is untouched");
});

test("advanceSchedule decrements COUNT and ends the schedule when it runs out", () => {
  let s = schedule({ rrule: "FREQ=DAILY;BYHOUR=9;COUNT=2" });
  s = advanceSchedule(s, { firedAt: "2026-08-13T09:00:00-04:00" });
  assert.equal(s.rrule, "FREQ=DAILY;BYHOUR=9;COUNT=1");
  assert.equal(s.state, "accepted");
  s = advanceSchedule(s, { firedAt: "2026-08-14T09:00:00-04:00" });
  assert.equal(s.state, "ended");
  assert.equal(s.endedReason, "count");
  assert.deepEqual(nextFireTimes(s, { now: "2026-08-14T12:00:00-04:00" }), [], "an ended schedule has no future");
});

test("advanceSchedule charges a coalesced run for every occurrence it covered", () => {
  const s = advanceSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;COUNT=10" }), {
    firedAt: "2026-08-13T09:00:00-04:00",
    coversFires: 4,
  });
  assert.equal(s.rrule, "FREQ=DAILY;BYHOUR=9;COUNT=6");
});

test("advanceSchedule ends a schedule whose UNTIL has passed", () => {
  const s = advanceSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;UNTIL=20260813T235959Z" }), {
    firedAt: "2026-08-13T09:00:00-04:00",
  });
  assert.equal(s.state, "ended");
  assert.equal(s.endedReason, "until");
  assert.equal(s.lastFireAt, "2026-08-13T13:00:00.000Z");
});

test("advanceSchedule leaves an open-ended schedule accepted forever", () => {
  const s = advanceSchedule(schedule(), { firedAt: "2026-08-13T09:00:00-04:00" });
  assert.equal(s.state, "accepted");
  assert.equal(s.endedReason, undefined);
  assert.equal(nextFireTimes(s, { now: "2026-08-13T10:00:00-04:00" })[0], "2026-08-14T09:00:00-04:00");
});

test("advance then re-derive: the schedule's own lastFireAt drives the next window", () => {
  let s = schedule();
  s = advanceSchedule(s, { firedAt: "2026-08-13T09:00:00-04:00" });
  const out = dueFires(s, { now: "2026-08-15T11:00:00-04:00" }); // no explicit `since`
  assert.equal(out.missed, 2, "lastFireAt is the default watermark");
  assert.equal(out.runs[0].coversFires, 2);
});

// ---------------------------------------------------------------------------
// The fire ledger
// ---------------------------------------------------------------------------

test("ledgerCommit claims a run once; the second claim is not fresh", () => {
  const empty = {};
  const first = ledgerCommit(empty, "run_a", { now: "2026-08-13T13:00:00Z" });
  assert.equal(first.fresh, true);
  assert.equal(first.entry.state, "running");
  assert.equal(first.entry.attempts, 1);
  const second = ledgerCommit(first.ledger, "run_a", { now: "2026-08-13T13:00:05Z" });
  assert.equal(second.fresh, false, "only one process may spawn this run");
  assert.equal(second.entry.attempts, 2);
  assert.deepEqual(empty, {}, "the caller's ledger is never mutated");
  assert.throws(() => ledgerCommit({}, ""), /needs a runId/);
});

test("ledgerIsDone is false while running and true once terminal", () => {
  let { ledger } = ledgerCommit({}, "run_a", { now: "2026-08-13T13:00:00Z" });
  assert.equal(ledgerIsDone(ledger, "run_a"), false);
  assert.equal(ledgerIsDone(ledger, "run_b"), false, "an unknown run is not done");
  for (const state of ["done", "failed", "skipped"]) {
    const settled = ledgerSettle(ledger, "run_a", { state, now: "2026-08-13T13:30:00Z" });
    assert.equal(ledgerIsDone(settled.ledger, "run_a"), true, state);
    assert.equal(settled.entry.settledAt, "2026-08-13T13:30:00.000Z");
  }
  assert.throws(() => ledgerSettle(ledger, "run_a", { state: "running" }), /is not a terminal run state/);
  ({ ledger } = ledgerCommit(ledger, "run_a", { now: "2026-08-13T13:40:00Z" }));
  assert.equal(ledger[LEDGER_KEY].run_a.state, "running", "a re-claim never rewinds state");
});

test("a crash mid-fire recovers to the same runId and never double-runs", () => {
  const s = schedule({ catchUp: "latest" });
  const window = { since: "2026-08-12T09:00:00-04:00", now: "2026-08-13T09:00:10-04:00" };

  // Pass 1: the daemon computes the owed run and commits before spawning.
  const first = dueFires(s, window);
  const runId = first.runs[0].runId;
  const committed = ledgerCommit({}, runId, { now: "2026-08-13T13:00:10Z" }).ledger;
  // ...and the machine dies here, before anything is marked terminal.

  // Pass 2: same inputs (lastFireAt was never written), so the same run id.
  const second = dueFires(s, window);
  assert.equal(second.runs[0].runId, runId, "the fire ledger recognises the interrupted run");
  assert.equal(ledgerIsDone(committed, runId), false, "so it is resumed, not skipped");
  const retry = ledgerCommit(committed, runId, { now: "2026-08-13T13:05:00Z" });
  assert.equal(retry.fresh, false);
  assert.equal(retry.entry.attempts, 2, "the daemon can see how many attempts this fire has cost");

  // Once it finishes, the same fire computed again is refused.
  const done = ledgerSettle(retry.ledger, runId, { now: "2026-08-13T13:10:00Z" }).ledger;
  const third = dueFires(s, window);
  assert.equal(third.runs[0].runId, runId);
  assert.equal(ledgerIsDone(done, runId), true, "and never runs a second time");
});

test("run ids stay stable across a restart of a coalesced catch-up run", () => {
  const s = schedule({ catchUp: "latest" });
  const window = { since: "2026-07-30T09:00:00-04:00", now: "2026-08-13T11:00:00-04:00" };
  const a = dueFires(s, window).runs.map((r) => r.runId);
  const b = dueFires(s, window).runs.map((r) => r.runId);
  assert.deepEqual(a, b);
  const all = dueFires(schedule({ catchUp: "all" }), window).runs.map((r) => r.runId);
  assert.equal(new Set(all).size, all.length, "no two runs of one recovery share an id");
});

test("ledgerPrune keeps the newest entries and leaves a small ledger alone", () => {
  let ledger = { processedMessages: { keep: "me" } };
  for (let i = 0; i < 12; i += 1) {
    ledger = ledgerCommit(ledger, `run_${i}`, { now: new Date(Date.UTC(2026, 7, 13, 0, i)).toISOString() }).ledger;
  }
  const pruned = ledgerPrune(ledger, { keep: 5 });
  const kept = Object.keys(pruned.scheduleRuns);
  assert.equal(kept.length, 5);
  assert.deepEqual(kept.sort(), ["run_11", "run_10", "run_9", "run_8", "run_7"].sort());
  assert.deepEqual(pruned.processedMessages, { keep: "me" }, "other ledger maps are untouched");
  assert.equal(ledgerPrune(ledger, { keep: 500 }), ledger, "nothing to do, nothing rewritten");
});

// ---------------------------------------------------------------------------
// validateSchedule
// ---------------------------------------------------------------------------

test("validateSchedule passes a good contract and echoes the next 3 fires", () => {
  const out = validateSchedule(schedule(), { now: "2026-08-13T12:00:00-04:00" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.next, [
    "2026-08-14T09:00:00-04:00",
    "2026-08-15T09:00:00-04:00",
    "2026-08-16T09:00:00-04:00",
  ]);
  assert.equal(out.cadence, "every day · 9:00");
});

test("validateSchedule enforces the five-minute floor", () => {
  const out = validateSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0,1,2" }), { now: "2026-08-13T12:00:00Z" });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ["schedule: fires more often than once every 5 minutes"]);
  assert.equal(MIN_FIRE_INTERVAL_MS, 300000);
  const ok = validateSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0,5,10" }), { now: "2026-08-13T12:00:00Z" });
  assert.equal(ok.ok, true, "exactly five minutes apart is allowed");
});

test("validateSchedule demands at least one future occurrence", () => {
  const out = validateSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;UNTIL=20200101T000000Z" }), {
    now: "2026-08-13T12:00:00Z",
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ["schedule: the rule has no future occurrence"]);
});

test("validateSchedule reports bad rules, zones and policy values", () => {
  const out = validateSchedule(
    { rrule: "FREQ=FORTNIGHTLY", timezone: "Mars/Olympus", catchUp: "maybe", overlap: "parallel", state: "vibing", maxRunMinutes: 0 },
    { now: "2026-08-13T12:00:00Z" },
  );
  assert.equal(out.ok, false);
  assert.equal(out.errors.length, 6);
  assert.match(out.errors[0], /FREQ=FORTNIGHTLY is not supported/);
  assert.match(out.errors[1], /unknown timezone/);
  assert.match(out.errors[2], /catchUp must be latest, all or skip/);
  assert.match(out.errors[3], /overlap must be skip or queue/);
  assert.match(out.errors[4], /is not a schedule state/);
  assert.match(out.errors[5], /maxRunMinutes must be a positive number/);
  assert.deepEqual(out.next, [], "no fire times echoed for a contract that cannot be trusted");
});
