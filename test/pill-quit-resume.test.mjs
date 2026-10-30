// A Quit pauses recovery until Relay is opened on purpose or the computer
// restarts; the pill stays put away through the restart.
//
// Field case, Sven 2026-10-15 to 10-19 (macOS, dev): "Quit Relay" booted out
// both LaunchAgents and wrote recovery/intent.json {stopped:true}. The pause
// survived restarts, so when the service died recovery left it dead, logging
// {"ok":true,"status":"intentionally-stopped","runtimeHealthy":false} every
// minute, and refused the pill's own repair request.
//
// Wanted (Shane, 2026-10-19): a restart always brings the background service
// back, even after a Quit; a restart does not bring back a dismissed or quit
// pill; opening Relay on purpose clears both.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const intent = require("../bootstrap/recovery-intent.cjs");
const liveness = require("../src/pill-liveness.cjs");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-quit-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const intentFile = (homeDir) => path.join(homeDir, ".relay", "recovery", "intent.json");
const writeIntent = (homeDir, value) => {
  fs.mkdirSync(path.dirname(intentFile(homeDir)), { recursive: true });
  fs.writeFileSync(intentFile(homeDir), JSON.stringify({ schema: 1, ...value }));
};
const readIntent = (homeDir) => JSON.parse(fs.readFileSync(intentFile(homeDir), "utf8"));

test("a Quit's pause holds until the computer restarts, and then ends on its own", (t) => {
  const homeDir = home(t);
  const quitAt = Date.parse("2026-10-15T09:10:00Z");
  writeIntent(homeDir, { stopped: true, at: quitAt, by: "quit-relay" });
  // Same boot: the machine has been up since before the Quit.
  const sameBoot = { now: quitAt + 3_600_000, uptimeMs: 86_400_000 };
  assert.equal(intent.stopped(homeDir, sameBoot), true);
  // Restarted on 10-17: the pause predates the boot.
  const restarted = { now: Date.parse("2026-10-19T06:04:00Z"), uptimeMs: 2 * 86_400_000 - 3_600_000 };
  assert.equal(intent.stopped(homeDir, restarted), false);
  const after = readIntent(homeDir);
  assert.equal(after.stopped, false, "rewritten, so an older Relay reading the file agrees");
  assert.equal(after.by, "restart");
  const log = fs.readFileSync(path.join(homeDir, ".relay", "recovery", "recovery.log"), "utf8");
  assert.match(log, /intent resumed by=restart pid=\d+ \(was paused by=quit-relay at=2026-10-15T09:10:00\.000Z\)/);
});

test("a pause from moments before boot time is still this boot's, within the margin", (t) => {
  const homeDir = home(t);
  const now = Date.parse("2026-10-19T08:00:00Z");
  const uptimeMs = 10 * 60_000;
  const bootAt = now - uptimeMs;
  writeIntent(homeDir, { stopped: true, at: bootAt - intent.BOOT_MARGIN_MS + 1000 });
  assert.equal(intent.stopped(homeDir, { now, uptimeMs }), true);
  writeIntent(homeDir, { stopped: true, at: bootAt - intent.BOOT_MARGIN_MS - 1000 });
  assert.equal(intent.stopped(homeDir, { now, uptimeMs }), false);
});

test("a real restart lets recovery repair the service again; the same boot does not", (t) => {
  const homeDir = home(t);
  const recovery = require("../bootstrap/recovery-client.cjs");
  writeIntent(homeDir, { stopped: true, at: Date.now() - 1000, by: "quit-relay" });
  assert.deepEqual(recovery.requestRecovery({ homeDir, platform: "darwin", run: () => assert.fail("refused before any launchctl") }),
    { ok: false, reason: "intentionally-stopped" }, "what Sven's pill got at 06:05Z, before he restarted");
  writeIntent(homeDir, { stopped: true, at: Date.now() - os.uptime() * 1000 - 3_600_000, by: "quit-relay" });
  assert.notEqual(recovery.requestRecovery({ homeDir, platform: "darwin", run: () => ({ status: 1, stderr: "boom" }) }).reason,
    "intentionally-stopped", "after a restart the pill's repair reaches recovery");
});

test("a setup's hold stands while its setup runs this boot, and not after a restart", (t) => {
  const homeDir = home(t);
  const now = Date.parse("2026-10-19T08:00:00Z");
  writeIntent(homeDir, { stopped: true, at: now - 2 * 3_600_000, heldBy: "setup", pid: process.pid });
  assert.equal(intent.stopped(homeDir, { now, uptimeMs: 3 * 3_600_000 }), true);
  assert.equal(intent.stopped(homeDir, { now, uptimeMs: 3_600_000 }), false, "a restart ended it, whatever now holds that pid");
});

test("opening Relay on purpose ends the pause; a pill started at login or by recovery does not", (t) => {
  const homeDir = home(t);
  writeIntent(homeDir, { stopped: true, at: Date.now() - 1000, by: "quit-relay" });
  assert.equal(intent.resumeUnlessHeld(homeDir, { by: "relay-pill" }), true);
  assert.equal(intent.stopped(homeDir), false);
  // `relay pill` is what every deliberate open runs: Relay.app, both Start menu
  // shortcuts and the CLI.
  const relayPill = fs.readFileSync(new URL("../bin/relay.js", import.meta.url), "utf8");
  assert.match(between(relayPill, "async function cmdPill(", "migratePersistedContentFields"),
    /resumeUnlessHeld\(undefined, \{ by: "relay-pill" \}\)/);
  const launcher = fs.readFileSync(new URL("../../../tools/relay-application/app/main.cjs", import.meta.url), "utf8");
  assert.match(launcher, /spawn\(target\.node, \[target\.bin, "pill",/, "Relay.app opens Relay through `relay pill`");
  const primary = between(main, "if (!gotSingleInstanceLock) {", 'app.on("second-instance"');
  assert.doesNotMatch(primary, /resumeUnlessHeld|setStopped\(false/, "a pill's own start lifts nothing");
  assert.match(primary, /intent\.stopped\(\) \? intent\.describe\(\)/, "it only says when recovery is paused");
  assert.equal("resumeForStartedPill" in intent, false);
});

test("Quit Relay puts the pill away like ✕, so a restart brings it back hidden", () => {
  const quit = between(main, "function quitRelayCompletely() {", "app.quit();");
  assert.match(quit, /console\.error\(`\[overlay\] \$\{new Date\(\)\.toISOString\(\)\} Quit Relay:/);
  assert.match(quit, /setDismissed\(true\);/);
  assert.ok(quit.indexOf("setDismissed(true)") < quit.indexOf("quitRelayCommand("), "persisted before the pill is stopped");
  assert.ok(quit.indexOf("Quit Relay:") < quit.indexOf('setStopped(true, undefined, { by: "quit-relay" })'));
  // A deliberate open revokes the dismissal, on a running pill or a fresh one.
  assert.match(between(main, "function showFromTray(", "\n}\n"), /setDismissed\(false\);/);
  assert.match(main, /if \(pendingReopenNonce\) requestExternalReopen\(pendingReopenNonce\);/);
});

test("a transaction lock gates the pill's repair only while its owner lives", () => {
  const open = liveness.transactionLockOpen;
  assert.equal(open({ exists: false }), false);
  assert.equal(open({ exists: true, owner: { pid: 4242 }, ownerAlive: true, lockAgeMs: 4 * 86_400_000 }), true, "a long update is still an update");
  assert.equal(open({ exists: true, owner: { pid: 4242 }, ownerAlive: false, lockAgeMs: 1_000 }), false, "a dead owner's lock is not");
  // mkdir comes before owner.json: an ownerless lock is a transaction starting,
  // until it is too old to be one.
  assert.equal(open({ exists: true, owner: null, lockAgeMs: 1_000 }), true);
  assert.equal(open({ exists: true, owner: null, lockAgeMs: liveness.TRANSACTION_OWNERLESS_GRACE_MS }), false);
  const gate = between(main, "function updateTransactionOpen() {", "\n}\n");
  assert.match(gate, /pillLiveness\.transactionLockOpen\(\{ exists: true, owner, lockAgeMs: Date\.now\(\) - stat\.mtimeMs, ownerAlive \}\)/);
  assert.match(gate, /recovery-launcher\.cjs"\)\.processAlive\(owner\?\.pid\)/, "kill(pid, 0), cheap enough for a 5 s tick");
});
