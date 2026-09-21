"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");

const GUIDE_VERSION = 1;
const transitions = Object.freeze({
  prompt: { AGENT_STARTED: "connecting" },
  connecting: { AUTH_OPENED: "browser", ACCOUNT_SAVED: "verifying" },
  browser: { AUTH_APPROVED: "finishing" },
  finishing: { ACCOUNT_SAVED: "verifying" },
  verifying: { HOST_VERIFIED: "teaching" },
  teaching: { SEND_CONFIRMED: "sent", LINK_CREATED: "link", COMPLETED: "complete" },
  sent: { LINK_CREATED: "link", COMPLETED: "complete" },
  link: { COMPLETED: "complete" },
  complete: {}, cancelled: {},
});
function initialRun({ entry = "home", context = null } = {}) {
  if (!["home", "invite", "share"].includes(entry)) throw new Error("Invalid entry");
  return { schema: 1, id: randomUUID(), revision: 0, guideVersion: GUIDE_VERSION,
    stage: "prompt", entry, context, accountId: null, host: null, error: null };
}
function reduce(state, event) {
  if (!state || state.schema !== 1 || !transitions[state.stage]) throw new Error("Invalid onboarding state");
  if (event.runId !== state.id || event.revision !== state.revision) throw new Error("Setup changed; read current status");
  if (event.type === "CANCELLED" && !["complete", "cancelled"].includes(state.stage)) {
    return { ...state, stage: "cancelled", revision: state.revision + 1, error: null };
  }
  if (event.type === "FAILED" && !["complete", "cancelled"].includes(state.stage)) {
    return { ...state, revision: state.revision + 1, error: { code: event.code || "unavailable", message: String(event.message || "Try again.").slice(0, 400) } };
  }
  const stage = transitions[state.stage][event.type];
  if (!stage) throw new Error(`Cannot ${event.type} from ${state.stage}`);
  if (event.type === "AGENT_STARTED" && (event.guideVersion !== GUIDE_VERSION || !["codex", "claude_code"].includes(event.host))) throw new Error("Read the current local guide with Claude Code or Codex");
  if (event.type === "ACCOUNT_SAVED" && !event.accountId) throw new Error("Missing verified account");
  if (["HOST_VERIFIED", "SEND_CONFIRMED", "LINK_CREATED", "COMPLETED"].includes(event.type)
    && (!state.accountId || event.accountId !== state.accountId)) throw new Error("Account changed; reconnect this setup");
  if (event.type === "SEND_CONFIRMED" && !event.relayId) throw new Error("Missing confirmed Relay");
  if (event.type === "LINK_CREATED") {
    const url = new URL(event.url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || !event.relayId) throw new Error("Missing verified link");
  }
  return { ...state, stage, revision: state.revision + 1, error: null,
    ...(event.type === "AGENT_STARTED" ? { host: event.host } : {}),
    ...(event.type === "ACCOUNT_SAVED" ? { accountId: event.accountId, context: event.context || state.context } : {}),
    ...(event.relayId ? { relayId: event.relayId } : {}),
    ...(event.type === "LINK_CREATED" ? { linkUrl: event.url } : {}),
  };
}
function createRunStore(directory) {
  const file = path.join(directory, "desktop-onboarding.json");
  return {
    read() {
      try {
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        if (state.schema !== 1 || !transitions[state.stage] || !Number.isSafeInteger(state.revision)) throw new Error("Unsupported onboarding state");
        return state;
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    write(state) { atomicWriteJsonSync(file, state, { mode: 0o600 }); return state; },
  };
}
module.exports = { GUIDE_VERSION, initialRun, reduce, createRunStore };
