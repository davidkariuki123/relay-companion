"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const file = homeDir => path.join(homeDir, ".relay", "recovery", "intent.json");
function read(homeDir) {
  try { return { value: JSON.parse(fs.readFileSync(file(homeDir), "utf8")) }; }
  catch (error) { return { missing: error.code === "ENOENT" }; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
// The installer's setup pauses recovery while it replaces Relay and records
// itself as the holder. A hold whose setup process is gone no longer counts,
// so a killed setup can never leave recovery paused for good.
function heldBySetup(value) {
  return value?.stopped === true && value.heldBy === "setup" && Number.isInteger(value.pid) && alive(value.pid);
}
function stopped(homeDir = os.homedir()) {
  const { value, missing } = read(homeDir);
  if (!value) return !missing;
  if (value.stopped === true && value.heldBy === "setup") return heldBySetup(value);
  return value.stopped === true;
}
function setStopped(value, homeDir = os.homedir(), { heldBy, pid } = {}) {
  require("./recovery-launcher.cjs").write(file(homeDir), { schema: 1, stopped: value, at: Date.now(), ...(value && heldBy ? { heldBy, pid } : {}) });
}
// Starting Relay (setup, the pill) resumes recovery, except while an
// installer's setup holds the pause; that setup lifts it when it ends.
function resumeUnlessHeld(homeDir = os.homedir()) {
  if (heldBySetup(read(homeDir).value)) return false;
  setStopped(false, homeDir);
  return true;
}
module.exports = { stopped, setStopped, resumeUnlessHeld };
