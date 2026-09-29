"use strict";
// The pill records itself in pill-status.json once it is on screen
// (overlay/main.cjs writePillStatus). The application only reads it: this is
// how the setup window knows the pill has taken its place.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function pillStatusPath(env = process.env, homeDir = os.homedir()) {
  const home = env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.join(homeDir, ".relay-companion");
  return path.join(home, "pill-status.json");
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Whether a pill is up. `since` (a Date.now() value) accepts only a status
// the pill wrote after that moment, so a file left behind by an earlier pill
// whose pid the OS has since reused never counts. `visible` asks for a pill
// that is actually on screen, not one hidden by preference or dismissed.
function pillIsUp({ file = pillStatusPath(), since = 0, visible = false, runId = null, alive = processAlive } = {}) {
  let status;
  try { status = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (status?.ready !== true || !Number.isInteger(status.pid) || status.pid <= 0) return false;
  if (visible && status.visible !== true) return false;
  if (runId && status.onboardingRunId !== runId) return false;
  if (since > 0 && !(Date.parse(status.updatedAt) >= since)) return false;
  return alive(status.pid);
}

module.exports = { pillStatusPath, pillIsUp };
