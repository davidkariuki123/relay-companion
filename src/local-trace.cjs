// Content-free, append-only local lifecycle evidence for delivery diagnostics.
// This trail is deliberately non-authoritative: failure to write it can never
// block staging, opening, or marking a Relay read. Never put message bodies,
// titles, addresses, credentials, or local paths in an event.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function traceHome() {
  return process.env.RELAY_HOME || process.env.RELAY_COMPANION_HOME || path.join(os.homedir(), ".relay-companion");
}

function localTracePath(home = traceHome()) {
  return path.join(home, "delivery-trace.jsonl");
}

function safeTraceEvent(event, at) {
  return {
    at,
    event: String(event?.event || "unknown"),
    ...(event?.relayId ? { relayId: String(event.relayId) } : {}),
    ...(event?.surface ? { surface: String(event.surface) } : {}),
    ...(event?.state ? { state: String(event.state) } : {}),
    ...(event?.result ? { result: String(event.result) } : {}),
    ...(event?.restored === true ? { restored: true } : {}),
  };
}

function appendLocalTraces(events, { home = traceHome(), now = () => new Date().toISOString() } = {}) {
  try {
    const rows = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (!rows.length) return true;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const serialized = rows.map((event) => JSON.stringify(safeTraceEvent(event, now()))).join("\n");
    fs.appendFileSync(localTracePath(home), `${serialized}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function appendLocalTrace(event, options) {
  return appendLocalTraces([event], options);
}

module.exports = { appendLocalTrace, appendLocalTraces, localTracePath, traceHome };
