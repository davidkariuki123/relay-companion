import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { signInInProgress } from "../src/installation-authorization.js";

// Fresh Mac VM (2026-10-08): dev moved while a new user was on the email code
// screen; the update restarted the pill and the sign-in panel vanished.
test("a live sign-in counts as active work; a lapsed, finished or missing one does not", () => {
  const now = Date.parse("2026-10-08T15:30:00Z");
  const read = (state) => () => JSON.stringify(state);
  const live = (status) => signInInProgress({ now, readFileSync: read({ status, expiresAt: "2026-10-08T15:40:00Z" }) });
  for (const status of ["pending_identity", "pending_approval", "approved"]) assert.equal(live(status), true, status);
  assert.equal(live("expired"), false);
  assert.equal(live("consumed"), false);
  assert.equal(signInInProgress({ now, readFileSync: read({ status: "pending_identity", expiresAt: "2026-10-08T15:20:00Z" }) }), false, "lapsed");
  assert.equal(signInInProgress({ now, readFileSync: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), false, "no record");
  assert.equal(signInInProgress({ now, readFileSync: () => "{not json" }), false, "unreadable never blocks updates");
});

test("the daemon's updater waits for a sign-in in progress", () => {
  const daemon = fs.readFileSync(new URL("../src/task-daemon.js", import.meta.url), "utf8");
  assert.match(daemon, /hasActiveWork: \(\) => hasActiveTurns\(\) \|\| activeSessionOperationCount\(\) > 0 \|\| signInInProgress\(\),/);
});
