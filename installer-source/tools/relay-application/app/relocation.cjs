"use strict";
// Installing from the download moves this app into /Applications. A Relay
// already there is nearly always an earlier copy of this application, often
// the one whose first setup failed, and refusing to replace it left people
// stuck on "Relay could not move to Applications" (Magnus's cofounder,
// 2026-09-29). Replace an earlier or identical Relay; never a newer one, and
// never an app that is not Relay.
const fs = require("node:fs");
const path = require("node:path");

const APPLICATION_ID = "work.relay.application";

function version(receipt) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(receipt?.applicationVersion || receipt?.version || ""));
  return match ? match.slice(1).map(Number) : null;
}

function relocationPlan(destination, candidate, { exists = fs.existsSync, read = file => fs.readFileSync(file, "utf8") } = {}) {
  if (!exists(destination)) return { action: "move" };
  let receipt = null;
  try { receipt = JSON.parse(read(path.join(destination, "Contents", "Resources", "candidate.json"))); } catch {}
  if (receipt?.appId !== APPLICATION_ID) {
    return { action: "refuse", message: "Another app named Relay is in Applications. Move it to the Trash, then try again." };
  }
  const existing = version(receipt), ours = version(candidate);
  if (!existing || !ours) return { action: "refuse", message: "Move the Relay app in Applications to the Trash, then try again." };
  for (let i = 0; i < 3; i++) {
    if (existing[i] > ours[i]) return { action: "refuse", message: "A newer Relay is already in Applications. Open Relay from there." };
    if (existing[i] < ours[i]) break;
  }
  return { action: "replace" };
}

module.exports = { relocationPlan };
