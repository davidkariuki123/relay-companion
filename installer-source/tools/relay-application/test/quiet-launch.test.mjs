// The application's quiet launch on a computer it already set up.
//
// Field case, Shane 2026-09-19: the OS was reinstalled, the home folder came
// back with every Relay marker, and the installer opened the Companion with no
// background service behind it because the markers said "set up". main.cjs
// needs Electron to run, so these assert on its source the way the pill's own
// UI suites do; the heartbeat rule underneath is unit-tested in migration.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../app/main.cjs", import.meta.url), "utf8");

test("a set-up computer whose service is not alive runs the install step before the Companion opens", () => {
  const launch = main.slice(main.indexOf("const state = installationState();"), main.indexOf("win.once(\"ready-to-show\""));
  assert.match(launch, /state\.serviceAlive \? Promise\.resolve\(\) : runLifecycle\("install", \{ allowRecovery: false \}\)/,
    "files alone never authorize the quiet launch; the service must be alive or be put back first");
  assert.match(launch, /ready\.then\(\(\) => handoffToRelay\(\)\)/, "the Companion opens only after that step");
  assert.match(launch, /quietLaunchFailed = true;\s*win\.show\(\)/, "a failed repair shows the window instead of nothing");
});

test("liveness comes from the inventory's heartbeat, and the renderer-facing lifecycle still checks its caller", () => {
  assert.match(main, /serviceAlive: installation\.serviceHeartbeat === "fresh"/);
  assert.match(main, /const lifecycle = \(event, action\) => \{\s*if \(!ownSender\(event\)/, "IPC callers are still verified");
  assert.match(main, /const runLifecycle = async \(action, \{ allowRecovery = true \} = \{\}\) => \{\s*if \(!application \|\| setupRunning\)/, "the internal path keeps the same guards");
});
