"use strict";

// Engagement telemetry for the inbox's "Five ways to use Relay" card. The card
// reports what the person did; this decides what is worth sending and sends it
// as a content-free onboarding event: an action name and, for an example, which
// way it was. Nothing here may slow or break the inbox, so every send is
// fire-and-forget and failures are dropped.

// "example_read" also retires a show-once way for the account on the server.
const EVENTS = new Set(["shown", "expanded", "minimised", "example_chosen", "example_copied", "example_read"]);
// Every way the card can offer; the API accepts the same ids.
const tip = require("./relay-anyone-tip.cjs");
const WAYS = new Set([...tip.EXAMPLES, ...tip.WAYS].map((way) => way.id));
// The pill comes and goes all day. "shown" counts the stretches in which the
// card was on screen, not every flicker of the window.
const SHOWN_EVERY_MS = 30 * 60 * 1000;
// A runaway renderer must not turn into a stream of requests.
const MAX_PER_HOUR = 60;

function createTeachingTelemetry({ send, now = Date.now } = {}) {
  let lastShownAt = -Infinity;
  let windowStart = -Infinity, sentInWindow = 0;
  return {
    record(name, way) {
      name = String(name || "");
      way = String(way || "");
      if (!EVENTS.has(name) || typeof send !== "function") return false;
      const needsWay = name.startsWith("example_");
      if (needsWay !== WAYS.has(way)) return false;
      const at = now();
      if (name === "shown") {
        if (at - lastShownAt < SHOWN_EVERY_MS) return false;
        lastShownAt = at;
      }
      if (at - windowStart >= 60 * 60 * 1000) { windowStart = at; sentInWindow = 0; }
      // A read is state the card depends on, and comes once per way.
      if (sentInWindow >= MAX_PER_HOUR && name !== "example_read") return false;
      sentInWindow++;
      try {
        Promise.resolve(send(`tip_${name}`, needsWay ? { way } : undefined)).catch(() => {});
      } catch {}
      return true;
    },
    // Another account signs in: its card has not been seen yet.
    reset() { lastShownAt = -Infinity; },
  };
}

module.exports = { createTeachingTelemetry, SHOWN_EVERY_MS, MAX_PER_HOUR };
