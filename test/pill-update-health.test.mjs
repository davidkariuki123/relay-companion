// The pill's update-HEALTH surface.
//
// The pill already had an "update ready" backstop. What it could never say is
// that the update keeps FAILING — so a stuck machine was offered a cheerful
// "Update and Restart" that failed identically every time, forever, with no
// explanation anywhere a person looks. One Windows box sat on 0.1.77 while 62
// versions shipped (field report, Shane 2026-08-11), and the only way to notice
// was diffing package.json against npm by hand.
//
// main.cjs needs a real Electron runtime, so these assert on its source the same
// way the other pill UI suites do. The behaviour underneath (which records count
// as "stuck") is unit-tested in auto-update.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { UPDATE_FAILURE_ESCALATION_THRESHOLD, readUpdateFailure, recordUpdateFailure } from "../src/auto-update.js";
import os from "node:os";
import path from "node:path";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const main = read("../overlay/main.cjs");
const inbox = read("../overlay/inbox.html");

test("the pill reads the daemon's failure record rather than defining its own", () => {
  // A second definition of "stuck" in the overlay would silently drift from the
  // daemon's, so the threshold and the parser both come from auto-update.js.
  const check = between(main, "async function checkForUpdate", "function runUpdateNow");
  assert.match(check, /mod\.readUpdateFailure\(/, "parsing is imported, not reimplemented");
  assert.match(check, /mod\.UPDATE_FAILURE_ESCALATION_THRESHOLD/, "the threshold is imported, not reimplemented");
  assert.ok(
    !/const UPDATE_FAILURE_ESCALATION_THRESHOLD\s*=\s*\d/.test(main),
    "the overlay must not hardcode its own threshold",
  );
  // Canonical migration/recovery keep their own durable slots. A machine can burn
  // gigabytes in a canonical loop while the plain update slot stays empty — Sven's
  // did for six hours while every surface said "ok".
  assert.match(check, /mod\.readMigrationFailure\(/, "the canonical migration slot is read too");
  assert.match(check, /mod\.readRecoveryFailure\(/, "the canonical recovery slot is read too");
});

test("manual update uses canonical admission and observes its terminal record", () => {
  const block = between(main, "async function runUpdateNow", "function createTray");
  assert.match(block, /runUpdateOnce\(/, "the pill calls the shared update decision directly");
  assert.match(block, /waitForUpdateRequestTerminal\(/, "an admitted worker is observed to completion");
  assert.match(block, /if \(!admitted\)/, "the UI is never marked updating after a rejected admission");
  assert.doesNotMatch(block, /spawn\(process\.execPath/, "there is no second CLI-spawn update path");
});

test("doctor reads every durable failure slot and the canonical runtime state", () => {
  const doctor = fs.readFileSync(new URL("../bin/relay.js", import.meta.url), "utf8");
  const block = between(doctor, "async function cmdDoctor", "function cmdEnv");
  assert.match(block, /readMigrationFailure\(/, "doctor reads the migration slot");
  assert.match(block, /readRecoveryFailure\(/, "doctor reads the recovery slot");
  assert.match(block, /CANONICAL .*FAILING/, "canonical failures are said out loud");
  assert.match(block, /release trees on disk/, "stranded releases are visible");
  assert.match(block, /listUpdateWorkerJobs\(/, "orphaned/live update workers are visible");
  assert.match(block, /last updater event/, "the last update.log verdict is surfaced");
});

test("a failing update outranks an available one in the tray", () => {
  const menu = between(main, "tray.popUpContextMenu", "Quit Relay");
  const iFailing = menu.indexOf("updateFailure");
  const iAvailable = menu.indexOf("availableUpdate");
  assert.ok(iFailing > -1 && iAvailable > -1, "the tray knows about both states");
  assert.ok(iFailing < iAvailable, "the failure branch is checked FIRST");
  assert.match(menu, /updates are failing/i, "it says what is actually happening");
  // The log is the one file that says WHY; making the user find it by hand is
  // what cost Shane an afternoon.
  assert.match(menu, /Open the update log/, "the cause is one click away");
  assert.match(menu, /Try updating again/, "and the retry stays available");
});

test("a stuck machine is visible without opening the menu", () => {
  const sync = between(main, "function syncTray", "// \"Quit Relay\" from the tray");
  assert.match(sync, /Updates are failing/, "the tooltip carries the warning");
  // syncTray early-outs on unchanged state; without health in that gate the
  // tooltip would be pinned to whatever it said when the pill last toggled.
  assert.match(sync, /trayHealthState/, "the early-out accounts for a health change");
  assert.match(sync, /health === trayHealthState/);
  // The visibility half now also folds in unread and the hidden preference, because
  // with skipTaskbar and dock.hide the tooltip is Relay's only passive surface —
  // but it must still be part of the same gate, or the tooltip goes stale again.
  assert.match(sync, /const state = `\$\{showing\}:\$\{unread\}:\$\{pillHidden\}`/);
  assert.match(sync, /state === trayShownState && health === trayHealthState/);
});

test("the Settings card refuses to claim an update is merely 'ready' when it is failing", () => {
  assert.match(main, /updateFailing: updateFailure \? \{/, "the payload carries the failure state");
  const render = between(inbox, "if (info.updateFailing)", "settingsViewEl.innerHTML = html;");
  const iFailing = render.indexOf("info.updateFailing");
  const iAvailable = render.indexOf("info.updateAvailable");
  assert.ok(iFailing > -1 && iAvailable > iFailing, "the failing branch renders before the ready branch");
  assert.match(render, /failed attempts to install/, "it states the count and the target");
  assert.match(render, /Try Again/, "the button stops promising a restart it cannot deliver");
});

test("the pill's threshold matches the daemon's escalation point", () => {
  // Both surfaces must agree on when a machine is "stuck", or the daemon would
  // shout in the log while the pill stayed silent (or the reverse).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-health-"));
  const statePath = path.join(dir, "update-state.json");
  for (let i = 1; i < UPDATE_FAILURE_ESCALATION_THRESHOLD; i += 1) {
    recordUpdateFailure(statePath, "0.1.140", { now: () => 1000 });
    assert.ok(
      readUpdateFailure(statePath).count < UPDATE_FAILURE_ESCALATION_THRESHOLD,
      "a transient failure stays quiet — the pill must not cry wolf on attempt 1",
    );
  }
  recordUpdateFailure(statePath, "0.1.140", { now: () => 1000 });
  assert.equal(readUpdateFailure(statePath).count, UPDATE_FAILURE_ESCALATION_THRESHOLD, "then it surfaces");
});

test("a fault in Relay itself never masquerades as a relay from a person", () => {
  // Staging a synthetic packet row would have been the quick way to get this on
  // screen, and it would put an app fault through the attention queue, the
  // read/ack ledger, and server sync — as if someone had sent it.
  const health = between(main, "// ---- update FAILURE", "function runUpdateNow");
  assert.ok(!/stagePlainRelayItem|packets\[|relayNotificationKind/.test(health), "no synthetic relay row is staged");
  assert.match(health, /update-state\.json/, "it reads the daemon's own health record");
});
