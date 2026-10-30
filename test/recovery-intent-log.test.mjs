// Who paused recovery, and when, must survive in the file and in recovery.log.
// Sven's machine (2026-10-19) had recovery paused for days with intent.json
// saying only stopped:true, and the next resume would have erased even that.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const intent = require("../bootstrap/recovery-intent.cjs");

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-intent-log-"));
}
const logLines = (homeDir) => {
  try { return fs.readFileSync(path.join(homeDir, ".relay", "recovery", "recovery.log"), "utf8").trim().split("\n"); }
  catch { return []; }
};

test("a pause and a resume each name who did it, once per change", () => {
  const homeDir = home();
  try {
    intent.setStopped(true, homeDir, { by: "quit-relay" });
    const file = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "intent.json"), "utf8"));
    assert.equal(file.stopped, true);
    assert.equal(file.by, "quit-relay");
    assert.equal(file.byPid, process.pid);
    const paused = intent.describe(homeDir);
    assert.equal(paused.stopped, true);
    assert.equal(paused.by, "quit-relay");
    assert.ok(paused.at > 0);

    // The same pause again is not news.
    intent.setStopped(true, homeDir, { by: "quit-relay" });
    assert.equal(logLines(homeDir).length, 1);
    assert.match(logLines(homeDir)[0], /intent paused by=quit-relay pid=\d+ \(was running\)$/);

    assert.equal(intent.resumeUnlessHeld(homeDir, { by: "relay-pill" }), true);
    const lines = logLines(homeDir);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /intent resumed by=relay-pill pid=\d+ \(was paused by=quit-relay at=\d{4}-\d\d-\d\dT/);
    assert.deepEqual(intent.describe(homeDir), { stopped: false });

    // Resuming a running recovery writes nothing to the log.
    intent.resumeUnlessHeld(homeDir, { by: "relay-pill" });
    assert.equal(logLines(homeDir).length, 2);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("an older file without a source still describes itself", () => {
  const homeDir = home();
  try {
    fs.mkdirSync(path.join(homeDir, ".relay", "recovery"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".relay", "recovery", "intent.json"), JSON.stringify({ schema: 1, stopped: true, at: 1000 }));
    assert.deepEqual(intent.describe(homeDir, 5000), { stopped: true, by: "unknown", at: 1000, ageMs: 4000 });
    assert.equal(intent.stopped(homeDir, { now: 3 * 3_600_000, uptimeMs: 3_600_000 }), false, "a restart since then ended it");
    assert.match(logLines(homeDir).at(-1), /intent resumed by=restart pid=\d+ \(was paused by=unknown at=1970-01-01T00:00:01\.000Z\)$/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
