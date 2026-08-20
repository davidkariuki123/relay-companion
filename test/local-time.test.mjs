import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HELPER = fileURLToPath(new URL("../src/local-time.cjs", import.meta.url));
const { localIso, localizeAtFields } = require(HELPER);

// The process timezone is fixed at startup, so per-zone assertions run in a
// child with TZ pinned.
function localIsoIn(timeZone, value) {
  return execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(String(require(process.argv[1]).localIso(process.argv[2])))", HELPER, value],
    { env: { ...process.env, TZ: timeZone }, encoding: "utf8" },
  );
}

test("renders the Johannesburg wall clock for a UTC instant", () => {
  // The shipped bug: a 14:02 SAST relay read back to its sender as "12:02".
  assert.equal(localIsoIn("Africa/Johannesburg", "2026-08-18T12:02:31.000Z"), "2026-08-18T14:02:31+02:00");
});

test("resolves DST from the instant, not from now", () => {
  assert.equal(localIsoIn("America/New_York", "2026-08-18T12:02:31Z"), "2026-08-18T08:02:31-04:00");
  assert.equal(localIsoIn("America/New_York", "2026-01-15T12:00:00Z"), "2026-01-15T07:00:00-05:00");
});

test("carries non-whole-hour offsets", () => {
  assert.equal(localIsoIn("Asia/Kathmandu", "2026-08-18T12:02:31Z"), "2026-08-18T17:47:31+05:45");
});

test("UTC machines emit an explicit +00:00 offset", () => {
  assert.equal(localIsoIn("UTC", "2026-08-18T12:02:31Z"), "2026-08-18T12:02:31+00:00");
});

test("crosses the date line when the offset does", () => {
  assert.equal(localIsoIn("Pacific/Auckland", "2026-01-15T23:30:00Z"), "2026-01-16T12:30:00+13:00");
});

test("returns unparseable values unchanged", () => {
  assert.equal(localIso("time unknown"), "time unknown");
  assert.equal(localIso(""), "");
});

test("localizeAtFields rewrites only *At UTC timestamps", () => {
  const input = {
    createdAt: "2026-08-18T12:02:31.000Z",
    relayId: "relay_20260818120231000_abc",
    title: "Sent at 2026-08-18T12:02:31Z",
    expiresIn: "2026-08-18T12:02:31Z",
    items: [{ readAt: "2026-08-18T12:04:43.172Z", state: "read" }],
  };
  const out = JSON.parse(JSON.stringify(input, localizeAtFields));
  // Same instant, offset form — exact digits depend on the host timezone.
  assert.equal(Date.parse(out.createdAt), Date.parse(input.createdAt));
  assert.match(out.createdAt, /[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(out.items[0].readAt), Date.parse(input.items[0].readAt));
  assert.match(out.items[0].readAt, /[+-]\d{2}:\d{2}$/);
  // Ids, prose, and non-At keys keep their exact bytes.
  assert.equal(out.relayId, input.relayId);
  assert.equal(out.title, input.title);
  assert.equal(out.expiresIn, input.expiresIn);
  assert.equal(out.items[0].state, "read");
});
