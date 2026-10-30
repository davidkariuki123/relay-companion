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
// A pause lasts until Relay is opened on purpose (`relay pill`, which Relay.app,
// both Start menu shortcuts and the CLI all run) or until the computer
// restarts. After a restart the background service must come back even if the
// person had quit Relay: Sven's quit pause survived his restarts and kept
// recovery away from a dead service for four days (2026-10-15 to 10-19). The
// pill keeps its own memory of being put away (overlay-prefs `dismissed`, set
// by ✕ and by Quit Relay), so it starts hidden after the restart.
//
// The boot time is wall clock minus uptime, which moves by a second or so
// between reads; a pause must predate it by this margin to count as before
// the restart. A clock set forward by more than that ends a pause early,
// which only ever brings the service back.
const BOOT_MARGIN_MS = 60_000;
function bootStartedAt({ now = Date.now(), uptimeMs = os.uptime() * 1000 } = {}) {
  return now - uptimeMs;
}
function endedByRestart(value, clock = {}) {
  const at = Number(value?.at) || 0;
  return value?.stopped === true && at > 0 && at < bootStartedAt(clock) - BOOT_MARGIN_MS;
}
// The installer's setup pauses recovery while it replaces Relay and records
// itself as the holder. A hold whose setup process is gone no longer counts,
// so a killed setup can never leave recovery paused for good. A hold from
// before a restart is gone too, whatever process now has its pid.
function heldBySetup(value, clock = {}) {
  return value?.stopped === true && value.heldBy === "setup" && Number.isInteger(value.pid)
    && !endedByRestart(value, clock) && alive(value.pid);
}
function stopped(homeDir = os.homedir(), clock = {}) {
  const { value, missing } = read(homeDir);
  if (!value) return !missing;
  if (endedByRestart(value, clock)) {
    // Rewritten as resumed so a reader from an older Relay agrees, and logged
    // once, naming the pause the restart ended.
    setStopped(false, homeDir, { by: "restart" });
    return false;
  }
  if (value.stopped === true && value.heldBy === "setup") return heldBySetup(value, clock);
  return value.stopped === true;
}
// Every pause and resume names who did it, in the file and in
// recovery/recovery.log. Sven's pause (2026-10-19) said only stopped:true, and a
// resume overwrote even that, so nobody could say who had stopped recovery or when.
const iso = (at) => (Number(at) > 0 ? new Date(Number(at)).toISOString() : "unknown");
function describeValue(value, now = Date.now()) {
  if (value?.stopped !== true) return { stopped: false };
  const at = Number(value.at) || 0;
  return { stopped: true, by: value.by || value.heldBy || "unknown", at: at || null, ageMs: at ? Math.max(0, now - at) : null };
}
function describe(homeDir = os.homedir(), now = Date.now()) {
  return describeValue(read(homeDir).value, now);
}
function setStopped(value, homeDir = os.homedir(), { heldBy, pid, by } = {}) {
  const launcher = require("./recovery-launcher.cjs");
  const previous = describeValue(read(homeDir).value);
  const source = by || heldBy || "unknown";
  launcher.write(file(homeDir), { schema: 1, stopped: value, at: Date.now(), by: source, byPid: process.pid, ...(value && heldBy ? { heldBy, pid } : {}) });
  if (previous.stopped === Boolean(value) && (!value || previous.by === source)) return;
  const was = previous.stopped ? `was paused by=${previous.by} at=${iso(previous.at)}` : "was running";
  launcher.appendRecoveryLog(path.dirname(file(homeDir)), `intent ${value ? "paused" : "resumed"} by=${source} pid=${process.pid} (${was})`);
}
// Opening Relay on purpose (setup, `relay pill`) resumes recovery, except while
// an installer's setup holds the pause; that setup lifts it when it ends.
function resumeUnlessHeld(homeDir = os.homedir(), { by = "resume" } = {}) {
  if (heldBySetup(read(homeDir).value)) return false;
  setStopped(false, homeDir, { by });
  return true;
}
module.exports = { stopped, describe, setStopped, resumeUnlessHeld, bootStartedAt, BOOT_MARGIN_MS };
