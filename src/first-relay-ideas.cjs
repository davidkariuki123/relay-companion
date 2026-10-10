"use strict";
// YOUR FIRST RELAY, PICKED IN THE PILL (2026-10-10).
//
// After sign-in the person chooses Claude Code, Codex or Conductor, and the
// Relay app opens it with "Set up Relay with me." The AI finds the setup here,
// reads what the person worked on lately, and writes four ideas for a first
// Relay into the pill, where the person taps one. The AI's turn waits for that
// tap and then writes the Relay.
//
// One file is the whole conversation between the two processes: the MCP
// broker (the AI's tools) writes the ideas and claims the pick, the pill
// writes the setup and the pick. It lives in the Relay config directory so a
// sleep, a restart of either side or an update keeps it, and the ideas wait
// for the person indefinitely.
//
// The waiting tool's heartbeat is a second, tiny file. It is written every few
// seconds while an AI is waiting, and the pill reads it only when the person
// taps, so the ideas file (which the pill watches) changes only when
// something the person can see changes.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");

const IDEAS_FILE = "first-relay-ideas.json";
const WAITER_FILE = "first-relay-waiter.json";
const IDEA_KINDS = Object.freeze(["review", "answer", "handoff", "update"]);
const IDEA_COUNT = 4;
const TITLE_MAX_WORDS = 6;
const LINE_MAX_WORDS = 9;
// Words are what people read; characters keep one long word from overflowing a row.
const TITLE_MAX_CHARS = 48;
const LINE_MAX_CHARS = 72;
const PROMPT_MAX_CHARS = 2000;
const RECIPIENT_MAX_CHARS = 80;
// A tap counts as answered by a waiting AI when its heartbeat is this fresh.
const WAITER_LIVE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
// One wait call. Codex registers Relay with tool_timeout_sec = 300 and Claude
// Code's MCP tool timeout is far longer, so four minutes fits both with room.
const WAIT_MAX_MS = 240_000;
// The protocol helper reaches tools through the daemon, whose socket gives a
// call 120 seconds; its waits stay well inside that.
const HELPER_WAIT_MAX_MS = 100_000;
const HOSTS = Object.freeze({
  codex: "Codex",
  "claude-code": "Claude Code",
  conductor: "Conductor",
});

function defaultDirectory(env = process.env) {
  return env.RELAY_CONFIG_DIR || path.join(os.homedir(), ".relay");
}
function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}
function clean(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function firstName(name) {
  return clean(name).split(" ")[0] || "";
}

/**
 * Exactly four ideas, each short enough for one row in the pill. Returns the
 * cleaned ideas, or throws one error naming every idea to shorten so the AI
 * can fix them all in a single retry.
 */
function validateIdeas(input) {
  if (!Array.isArray(input) || input.length !== IDEA_COUNT) {
    throw new Error(`Write exactly ${IDEA_COUNT} ideas; got ${Array.isArray(input) ? input.length : "none"}.`);
  }
  const problems = [];
  const ideas = input.map((raw, index) => {
    const n = index + 1;
    const idea = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const title = clean(idea.title);
    const line = clean(idea.line);
    const kind = clean(idea.kind).toLowerCase();
    const prompt = String(idea.prompt ?? "").trim();
    const recipientName = clean(idea.recipientName);
    if (!title) problems.push(`idea ${n}: title is empty`);
    else if (words(title) > TITLE_MAX_WORDS || title.length > TITLE_MAX_CHARS) problems.push(`idea ${n}: title "${title}" is ${words(title)} words; use at most ${TITLE_MAX_WORDS} short words`);
    if (!line) problems.push(`idea ${n}: line is empty`);
    else if (words(line) > LINE_MAX_WORDS || line.length > LINE_MAX_CHARS) problems.push(`idea ${n}: line "${line}" is ${words(line)} words; use at most ${LINE_MAX_WORDS} short words`);
    if (!IDEA_KINDS.includes(kind)) problems.push(`idea ${n}: kind must be one of ${IDEA_KINDS.join(", ")}`);
    if (!prompt) problems.push(`idea ${n}: prompt is empty; write the full request you would act on`);
    else if (prompt.length > PROMPT_MAX_CHARS) problems.push(`idea ${n}: prompt is ${prompt.length} characters; keep it under ${PROMPT_MAX_CHARS}`);
    if (recipientName.length > RECIPIENT_MAX_CHARS) problems.push(`idea ${n}: recipientName is too long`);
    return { id: `idea-${n}`, title, line, kind, prompt, ...(recipientName ? { recipientName } : {}) };
  });
  if (problems.length) {
    throw Object.assign(new Error(`Nothing was shown yet. Shorten or fix these, then call again with all ${IDEA_COUNT} ideas: ${problems.join("; ")}.`), { code: "ideas_invalid" });
  }
  return ideas;
}

// What to do with the pick, by who the first Relay goes to. David's live run
// (2026-10-10): Codex worked for 87 seconds showing only "Working", and the
// pill showed the minted link before the chat said anything, so the tap looked
// like it did nothing. The chat now leads: say the pick first, draft without
// any more reading, show the draft, then mint or ask.
function nextMessageFor(idea) {
  return `You picked “${clean(idea?.title) || "your idea"}”. Writing it now…`;
}
function pickedInstruction(state, idea) {
  const first = `Before any other tool call or drafting, say exactly nextMessage in the chat ("${nextMessageFor(idea)}"). Then write it from this idea's prompt and what you already read: no more tool calls, reading or research before the draft, and do not ask for more first. Draft it as the Writing a Relay section says: forHuman in one or two plain spoken sentences, everything you know in forAgent.`;
  if (state.kind === "invite" && state.inviter) {
    return `${first} It goes to ${state.inviter.name}, who is on Relay: show the recipient, the human message and the agent document, ask for explicit approval of that exact message, and only then send it with relay_send to relayUserId ${state.inviter.relayUserId || "(the inviter's)"}.`;
  }
  if (state.kind === "org" && state.org) {
    return `${first} It goes to the ${state.org.name} group on Relay: show the recipient, the human message and the agent document, ask for explicit approval of that exact message, and only then send it with relay_send to groupId ${state.org.groupId || "(the organisation's)"}.`;
  }
  return `${first} Show the draft in the chat before minting: "{Name} reads" with the forHuman, and "{Name}'s AI gets" with a one- or two-line summary of the forAgent and its word count. Then mint it with relay_share_link (minting sends nothing, so it needs no approval) and end with the url on its own line, one sentence that whoever gets it reads and replies in their browser with nothing to install, and an offer to reword it (the link stays the same).`;
}

function createFirstRelayIdeas({ directory = defaultDirectory(), now = Date.now } = {}) {
  const file = path.join(directory, IDEAS_FILE);
  const waiterFile = path.join(directory, WAITER_FILE);
  const iso = () => new Date(now()).toISOString();
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return state && state.schema === 1 && typeof state.id === "string" ? state : null;
    } catch { return null; }
  }
  function write(state) {
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return state;
  }
  function readWaiter() {
    try { return JSON.parse(fs.readFileSync(waiterFile, "utf8")) || null; } catch { return null; }
  }
  function heartbeat(setupId) {
    try { atomicWriteJsonSync(waiterFile, { setupId, at: now(), pid: process.pid }, { mode: 0o600 }); } catch { /* A missed beat only makes a tap reopen the AI. */ }
  }
  function waiterLive(state = read()) {
    const beat = readWaiter();
    return Boolean(state && beat && beat.setupId === state.id && Number(beat.at) > now() - WAITER_LIVE_MS);
  }
  function activeFor(accountId) {
    const state = read();
    if (!state || state.endedAt) return null;
    if (accountId && state.accountId && state.accountId !== accountId) return null;
    return state;
  }

  const api = {
    file,
    read,
    waiterLive,
    /**
     * The pill: a local AI was chosen for this account. Same account and AI
     * keeps the setup (and any ideas) as it is; anything else starts afresh.
     */
    begin({ accountId, host, kind = "none", inviter = null, org = null, you = null }) {
      if (!accountId) throw new Error("Sign in to Relay first.");
      if (!HOSTS[host]) throw new Error("Choose Claude Code, Codex or Conductor.");
      const current = read();
      const destination = {
        kind: ["invite", "org"].includes(kind) ? kind : "none",
        inviter: kind === "invite" && inviter?.name ? { name: clean(inviter.name), ...(inviter.relayUserId ? { relayUserId: String(inviter.relayUserId) } : {}) } : null,
        org: kind === "org" && org?.name ? { name: clean(org.name), ...(org.groupId ? { groupId: String(org.groupId) } : {}) } : null,
        you: you?.name ? { name: clean(you.name) } : null,
      };
      if (current && !current.endedAt && current.accountId === accountId && current.host === host) {
        // The server may answer who the first Relay is for after the choice.
        if (!current.pick && JSON.stringify([current.kind, current.inviter, current.org, current.you]) !== JSON.stringify([destination.kind, destination.inviter, destination.org, destination.you])) {
          return write({ ...current, ...destination });
        }
        return current;
      }
      return write({ schema: 1, id: randomUUID(), accountId, host, ...destination,
        createdAt: iso(), openedAt: "", agentStartedAt: "", ideas: [], ideasAt: "", pick: null, endedAt: "" });
    },
    /** The pill opened the chosen AI. Opening it again restarts the minute before "Press send". */
    markOpened() {
      const state = read();
      if (!state || state.endedAt) return state;
      return write({ ...state, openedAt: iso() });
    },
    /** First Relay done, onboarding finished, or the person signed out. */
    end() {
      const state = read();
      if (!state || state.endedAt) return state;
      return write({ ...state, endedAt: iso() });
    },
    /** The AI asks what setup is in progress. Marks that an AI has started. */
    current({ accountId } = {}) {
      const state = activeFor(accountId);
      if (!state) {
        return { active: false, agentInstruction: "No first-Relay setup is waiting in the Relay app. Help the person with Relay as usual; nothing needs setting up or signing in here." };
      }
      // The AI has started: the pill leaves "press send" for "finding ideas" on this marker.
      const seen = state.agentStartedAt ? state : write({ ...state, agentStartedAt: iso() });
      return api.describe(seen);
    },
    describe(state) {
      const picked = state.pick ? state.ideas.find((idea) => idea.id === state.pick.ideaId) || null : null;
      const who = state.kind === "invite" && state.inviter ? state.inviter.name : state.kind === "org" && state.org ? state.org.name : "";
      return {
        active: true,
        setupId: state.id,
        host: HOSTS[state.host],
        kind: state.kind,
        ...(state.inviter ? { inviter: state.inviter } : {}),
        ...(state.org ? { org: state.org } : {}),
        ...(state.you ? { you: state.you } : {}),
        ideasWritten: state.ideas.length === IDEA_COUNT,
        ...(state.ideas.length ? { ideas: state.ideas } : {}),
        ...(picked ? { picked, pickedVia: state.pick.mode, ...(state.pick.mode === "waiter" ? { nextMessage: nextMessageFor(picked) } : {}) } : {}),
        agentInstruction: picked
          ? state.pick.mode === "reopened"
            ? "The person already picked an idea while no AI was waiting, and the Relay app opened it in a new conversation. Nothing more to do here."
            : pickedInstruction(state, picked)
          : state.ideas.length === IDEA_COUNT
            ? "Your ideas are in the Relay app. Call relay_onboarding_wait_pick until the person picks one."
            : `Follow the Relay skill's First Relay tutorial: read recent work with relay_onboarding_recent_work, then write four ideas with relay_onboarding_ideas${who ? `, all about what to send ${who}` : ""}. The account is already connected: run no setup commands and do not mention signing in.`,
      };
    },
    /** The AI's four ideas, shown in the pill. Replaces earlier ones until a pick. */
    setIdeas(input, { accountId } = {}) {
      const state = activeFor(accountId);
      if (!state) throw new Error("No first-Relay setup is waiting in the Relay app.");
      if (state.pick) throw new Error("The person already picked an idea. Write that Relay instead of new ideas.");
      const ideas = validateIdeas(input);
      const next = write({ ...state, ideas, ideasAt: iso(), agentStartedAt: state.agentStartedAt || iso() });
      // The AI calls the waiting tool next; a tap in the gap still reaches it.
      heartbeat(next.id);
      return next;
    },
    /**
     * The AI that took the pick checked in near the end of its turn. Cheap and
     * best-effort: only a claimed pick in an active setup records it.
     */
    noteWrapUp({ accountId } = {}) {
      const state = activeFor(accountId);
      if (!state?.pick?.claimedAt || state.pick.mode !== "waiter") return null;
      return write({ ...state, pick: { ...state.pick, wrapUpAt: iso() } });
    },
    /**
     * The pill: the person tapped an idea. With an AI waiting, the pick is
     * left for it; with none, the caller opens the AI with the idea's prompt.
     */
    pick(ideaId, { accountId } = {}) {
      const state = activeFor(accountId);
      if (!state) throw new Error("This setup has ended. Choose your AI again.");
      if (state.pick) {
        const idea = state.ideas.find((candidate) => candidate.id === state.pick.ideaId);
        return { state, idea, mode: state.pick.mode, repeated: true };
      }
      const idea = state.ideas.find((candidate) => candidate.id === ideaId);
      if (!idea) throw new Error("That idea is no longer on offer.");
      const mode = waiterLive(state) ? "waiter" : "reopened";
      const next = write({ ...state, pick: { ideaId: idea.id, mode, at: iso(), claimedAt: "" } });
      return { state: next, idea, mode, repeated: false };
    },
    /**
     * The AI waits for the tap, beating its heart so the pill knows someone
     * is listening. Returns { picked } or { waiting: true } at the deadline.
     */
    async waitForPick({ accountId, timeoutMs = WAIT_MAX_MS, pollMs = 1000, signal, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), shouldYield = () => false } = {}) {
      const limit = Math.max(1000, Math.min(WAIT_MAX_MS, Number(timeoutMs) || WAIT_MAX_MS));
      const started = now();
      let lastBeat = 0;
      for (;;) {
        const state = activeFor(accountId);
        if (!state) return { waiting: false, ended: true, agentInstruction: "The setup ended in the Relay app. Nothing more to do here." };
        if (state.pick) {
          const idea = state.ideas.find((candidate) => candidate.id === state.pick.ideaId) || null;
          if (state.pick.mode === "reopened") {
            return { waiting: false, picked: null, openedElsewhere: idea, agentInstruction: "The person picked an idea while no AI was waiting, so the Relay app opened it in a new conversation. Do not write it here; end your turn with one short line saying it opened there." };
          }
          if (!state.pick.claimedAt) write({ ...state, pick: { ...state.pick, claimedAt: new Date(now()).toISOString() } });
          return { waiting: false, picked: idea, nextMessage: nextMessageFor(idea), ...(state.inviter ? { inviter: state.inviter } : {}), ...(state.org ? { org: state.org } : {}), agentInstruction: pickedInstruction(state, idea) };
        }
        if (now() - lastBeat >= HEARTBEAT_MS) { heartbeat(state.id); lastBeat = now(); }
        if (signal?.aborted || shouldYield() || now() - started >= limit) {
          return { waiting: true, agentInstruction: "No pick yet. Call relay_onboarding_wait_pick again. After about 30 minutes of waiting in total, end your turn with one line: \"No rush. When you pick an idea in Relay, I’ll write it.\"" };
        }
        await sleep(Math.min(pollMs, Math.max(0, limit - (now() - started))));
      }
    },
    /** What the pill draws. */
    snapshot(accountId) {
      const state = activeFor(accountId);
      if (!state) return null;
      return {
        id: state.id,
        host: state.host,
        kind: state.kind,
        inviterName: state.inviter?.name || "",
        inviterFirstName: firstName(state.inviter?.name),
        orgName: state.org?.name || "",
        openedAt: state.openedAt || "",
        // Set by the AI's first onboarding tool call (current or recent work): it has started.
        agentStartedAt: state.agentStartedAt || state.agentSeenAt || "",
        ideas: state.ideas.map(({ id, title, line, kind, recipientName }) => ({ id, title, line, kind, ...(recipientName ? { recipientName } : {}) })),
        ideasAt: state.ideasAt || "",
        pick: state.pick ? { ideaId: state.pick.ideaId, mode: state.pick.mode, at: state.pick.at, claimed: Boolean(state.pick.claimedAt), wrapUpAt: state.pick.wrapUpAt || "" } : null,
      };
    },
  };
  return api;
}

module.exports = {
  createFirstRelayIdeas, validateIdeas,
  IDEA_KINDS, IDEA_COUNT, TITLE_MAX_WORDS, LINE_MAX_WORDS, WAITER_LIVE_MS, HEARTBEAT_MS, WAIT_MAX_MS, HELPER_WAIT_MAX_MS,
  FIRST_RELAY_HOSTS: HOSTS, IDEAS_FILE, WAITER_FILE,
};
