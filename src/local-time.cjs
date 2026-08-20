"use strict";

// Storage and the wire speak UTC; this module is the presentation boundary for
// the one human this companion serves. Models quote the clock digits they see,
// so agent-facing surfaces must carry the machine's wall clock — the same OS
// setting the pill's toLocaleString() already renders. The offset form
// ("2026-08-18T14:02:31+02:00") is the same instant as the Z form to any
// parser, so sorting and Date.parse round-trips are unaffected.
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const AT_KEY = /At$/;

function localIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  // getTimezoneOffset is evaluated at this instant, so DST resolves per-date,
  // not per-"now".
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const magnitude = Math.abs(offset);
  const millis = date.getMilliseconds();
  return (
    `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${millis ? `.${String(millis).padStart(3, "0")}` : ""}` +
    `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`
  );
}

// JSON.stringify replacer: rewrites `*At` fields holding UTC ISO strings into
// the local-offset form. Everything else — relay ids (which embed UTC digits),
// titles, idempotency keys, non-timestamp strings — passes through untouched.
function localizeAtFields(key, value) {
  return AT_KEY.test(key) && typeof value === "string" && UTC_ISO.test(value) ? localIso(value) : value;
}

module.exports = { localIso, localizeAtFields };
