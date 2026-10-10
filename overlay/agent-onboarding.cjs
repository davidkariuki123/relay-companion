"use strict";
// WHICH AI DO YOU USE (2026-10-07). After sign-in, the person picks the AI
// they use most; Relay hands off to it once and then only watches account
// history. This module owns that choice per account, and for ChatGPT and
// Claude the one-time setup code their AI redeems itself. Nothing here sends
// a Relay or teaches anything: the lesson lives in the chosen AI.

const HOSTS = Object.freeze({
  claude: { name: "Claude", chat: true, surface: "claude" },
  chatgpt: { name: "ChatGPT", chat: true, surface: "chatgpt" },
  "claude-code": { name: "Claude Code", local: true, scheme: "claude://", open: (q) => `claude://code/new?q=${q}` },
  codex: { name: "Codex", local: true, scheme: "codex://", open: (q) => `codex://threads/new?prompt=${q}` },
  conductor: { name: "Conductor", local: true },
});
const PLACES = new Set(["browser", "app"]);
// A code is pasted within minutes. Re-mint a little before the server's 15.
const RUN_REFRESH_MARGIN_MS = 60 * 1000;
// CLAUDE CONNECTS BY CONNECTOR (2026-10-07). Claude's code sandbox reaches
// only allowlisted domains, so a setup code's exchange never leaves it (tested
// live, prod and dev). Relay's hosted connector does: Claude calls it from its
// own servers. The person adds it once, in Claude, and it then works in every
// Claude chat, on the web, in the app and on the phone. After it connects, a
// new chat opens with this sentence and Relay's connector runs the lesson.
const CLAUDE_START_PROMPT = "Help me get started with Relay.";
// The sentence names who the first Relay is for, because the person sends it.
// Claude's Auto mode refuses a send whose recipient came only from a tool
// ("the recipient came from the Relay setup, not from you"), and it never
// reached Relay (run 10, 2026-10-07). Sent by the person, the name is theirs.
function claudeStartPrompt(known) {
  const who = known?.kind === "org" ? known.org?.name : known?.kind === "hello" ? known.inviter?.name : "";
  if (who) return `Help me send my first Relay to ${who}.`;
  if (known?.kind === "link") return "Help me make my first Relay link.";
  return CLAUDE_START_PROMPT;
}
// CHATGPT CONNECTS BY ITS APP (2026-10-09), when the server's RELAY_CHATGPT_APP
// switch is on (features.chatGptApp). Relay's official ChatGPT app is the same
// hosted connector Claude uses, listed in ChatGPT's plugin directory: the
// person clicks Connect on Relay's page in ChatGPT, then Allow on Relay's own
// page, and it works in every ChatGPT chat, not only Work. The lesson then
// starts in an ordinary chat, opened with this sentence typed in, which is
// what the app's get-started flow answers. Off, ChatGPT keeps its setup code.
const CHATGPT_START_PROMPT = "Help me get started with Relay.";
const CHATGPT_START_URL = `https://chatgpt.com/?q=${encodeURIComponent(CHATGPT_START_PROMPT)}`;

function createAgentOnboarding({ store = {}, persist = () => {}, client, schemeOwner = () => "", openExternal, writeClipboard, now = Date.now, chatGptApp = () => false }) {
  const runs = new Map(); // key -> live setup run (code only in memory)
  const server = new Map(); // key -> last /v1/agent/onboarding answer
  // key + surface -> { startedAt, connected, checked, error }: a hosted connector being added
  const connectors = new Map();
  const connectorKey = (key, surface) => `${key}\u0000${surface}`;
  /** The surface whose hosted connector this AI connects by, or "" for a setup code / local agent. */
  function connectorSurface(host) {
    if (host === "claude") return "claude";
    if (host === "chatgpt") { try { return chatGptApp() === true ? "chatgpt" : ""; } catch { return ""; } }
    return "";
  }
  const ownsScheme = (scheme) => { try { return Boolean(String(schemeOwner(scheme) || "").trim()); } catch { return false; } };

  function record(key) { return key && store[key] && typeof store[key] === "object" ? store[key] : null; }
  function save(key, value) {
    if (!key) return;
    if (value) store[key] = value; else delete store[key];
    persist();
  }
  function liveRun(key) {
    const run = runs.get(key);
    if (!run) return null;
    // Replaced or lapsed on the server (another computer minted a newer one):
    // a dead code is no code, so the paste screen quietly gets a fresh one.
    if (run.status === "expired" || run.status === "cancelled") return null;
    if (run.status === "pending" && Date.parse(run.expiresAt) - RUN_REFRESH_MARGIN_MS <= now()) return null;
    return run;
  }

  const api = {
    hosts: HOSTS,
    /** What the renderer needs to draw the chooser, the paste screen and the handoff. */
    snapshot(key) {
      const chosen = record(key);
      const run = liveRun(key);
      const known = server.get(key);
      return {
        host: chosen?.host || "",
        place: chosen?.place || "",
        connectedAt: chosen?.connectedAt || "",
        run: run && chosen?.host && HOSTS[chosen.host]?.surface === run.surface && chosen.place === run.place
          ? { id: run.id, status: run.status, prompt: run.prompt, code: run.code, expiresAt: run.expiresAt, open: Boolean(run.openUrl) }
          : null,
        runError: chosen?.runError || "",
        kind: known?.kind || "",
        destination: known?.org?.name || known?.inviter?.name || "",
        openable: { "claude-code": ownsScheme("claude://"), codex: ownsScheme("codex://"), conductor: process.platform === "darwin" && ownsScheme("conductor://"), claudeApp: ownsScheme("claude://") },
        connector: connectorSurface(chosen?.host) ? api.connectorSnapshot(key, connectorSurface(chosen.host)) : null,
        // "connector" once a hosted connector connected this choice (ChatGPT's
        // app); a ChatGPT connected by a setup code started its lesson there.
        via: chosen?.via || "",
        // An AI asked Relay how to begin (server fact): the lesson is under way.
        tutorialStarted: Boolean(known?.tutorialStartedAt),
        startPrompt: chosen?.host === "chatgpt" ? CHATGPT_START_PROMPT : claudeStartPrompt(known),
      };
    },
    connectorSnapshot(key, surface = "claude") {
      const state = connectors.get(connectorKey(key, surface)) || {};
      return { started: Boolean(state.startedAt), connected: Boolean(state.connected), checked: Boolean(state.checked), error: state.error || "" };
    },
    /**
     * Open the AI's connect screen (Claude's add-connector dialog filled in,
     * or Relay's page in ChatGPT's plugin directory) through Relay's website
     * carrying this app's account: no Relay sign-in, and never another account.
     */
    async connect(key, surface) {
      if (!key) throw new Error("Sign in to Relay first.");
      if (connectorSurface(surface) !== surface) throw new Error("Connect ChatGPT with its setup message.");
      const name = HOSTS[surface].name;
      const id = connectorKey(key, surface);
      const state = connectors.get(id) || {};
      connectors.set(id, { ...state, error: "" });
      let url;
      try { url = (await (await client()).mcpBrowserHandoff(surface)).url; }
      catch {
        connectors.set(id, { ...state, error: `Relay couldn’t reach ${name}’s setup. Check your connection and try again.` });
        throw new Error(`Relay couldn’t reach ${name}’s setup. Check your connection and try again.`);
      }
      if (!/^https:\/\//.test(String(url || "")) && !/^http:\/\/localhost[:/]/.test(String(url || ""))) throw new Error(`Relay couldn’t reach ${name}’s setup.`);
      await openExternal(url);
      connectors.set(id, { ...connectors.get(id), startedAt: now(), error: "" });
      return api.snapshot(key);
    },
    connectClaude(key) { return api.connect(key, "claude"); },
    /** Relay's page in ChatGPT, where Connect adds Relay's ChatGPT app. Only with the server's switch on. */
    connectChatGptApp(key) { return api.connect(key, "chatgpt"); },
    /** Does this account have the AI's hosted connector? Read from the server's own list. */
    async checkConnector(key, surface = "claude") {
      const list = await (await client()).agentConnections();
      const connected = Array.isArray(list?.connections)
        && list.connections.some((item) => item.kind === "connector" && item.surface === surface);
      const id = connectorKey(key, surface);
      const before = connectors.get(id) || {};
      connectors.set(id, { ...before, connected, checked: true });
      return { connected, justNow: connected && !before.connected && Boolean(before.startedAt) };
    },
    /**
     * A new, empty Claude chat: the Claude app when it is here, else
     * claude.ai. Never prefilled (Claude puts a red "Use caution before
     * running this prompt" banner over any prefilled link), and never a silent
     * clipboard write: the person copies the first message themselves, with a
     * button, before this opens (David, 2026-10-07).
     */
    async openClaudeChat(key) {
      const chosen = record(key);
      const web = "https://claude.ai/new";
      if (ownsScheme("claude://")) {
        try { await openExternal("claude://claude.ai/new?surface=chat"); }
        catch { await openExternal(web); }
      } else await openExternal(web);
      if (chosen && !chosen.connectedAt) save(key, { ...chosen, connectedAt: new Date(now()).toISOString() });
      void api.refreshServer(key);
      return api.snapshot(key);
    },
    /**
     * A new, ordinary ChatGPT chat with the start sentence typed in, where
     * Relay's ChatGPT app answers it. Not Work: the app's tools work in Chat.
     * The person presses send; the clipboard is theirs (Copy instead).
     */
    async openChatGptChat(key) {
      await openExternal(CHATGPT_START_URL);
      void api.refreshServer(key);
      return api.snapshot(key);
    },
    choose(key, host, place = "") {
      if (!key || !HOSTS[host]) throw new Error("Choose one of the listed AIs.");
      if (place && !PLACES.has(place)) throw new Error("Choose the browser or the app.");
      const current = record(key) || {};
      // A different AI is a fresh handoff: a code minted for the old one must not connect.
      if (current.host !== host || (place && current.place !== place)) {
        const old = runs.get(key);
        runs.delete(key);
        if (old?.status === "pending") void client().then((c) => c.cancelAgentSetupRun(old.id)).catch(() => {});
      }
      // A connector works wherever its AI does, so Claude (and ChatGPT's app) has no "where".
      const where = connectorSurface(host) ? "" : HOSTS[host].chat ? place : "";
      const same = current.host === host && current.place === where;
      save(key, { host, place: where, connectedAt: same ? current.connectedAt || "" : "", ...(same && current.via ? { via: current.via } : {}) });
      return api.snapshot(key);
    },
    reset(key) {
      const old = runs.get(key);
      runs.delete(key);
      if (old?.status === "pending") void client().then((c) => c.cancelAgentSetupRun(old.id)).catch(() => {});
      save(key, null);
      return api.snapshot(key);
    },
    /** A live code for the chosen chat AI, minted on first need and again only after it lapses. */
    async prepare(key) {
      const chosen = record(key);
      const host = HOSTS[chosen?.host];
      if (!host?.chat || !PLACES.has(chosen.place)) throw new Error("Choose ChatGPT or Claude first.");
      try {
        await api.prepareRun(key, host.surface, chosen.place);
        if (chosen.runError) save(key, { ...chosen, runError: "" });
      } catch (error) {
        save(key, { ...chosen, runError: "Relay couldn’t make your setup request. Check your connection and try again." });
        throw error;
      }
      return api.snapshot(key);
    },
    // THE ONE CONNECT FLOW (Setup, 2026-10-07). The first-run chooser above
    // and the Setup page both connect a chat AI through these: one live code
    // per account (the server cancels any earlier one), for one AI and place.
    /** The account's live setup request for this AI and place, minting one when there is none. */
    async prepareRun(key, surface, place) {
      if (!key || !["claude", "chatgpt"].includes(surface) || !PLACES.has(place)) throw new Error("Choose ChatGPT or Claude, in the browser or the app.");
      const live = liveRun(key);
      if (live && live.surface === surface && live.place === place) return api.runSnapshot(key);
      const created = await (await client()).createAgentSetupRun({ surface, place });
      runs.set(key, { ...created, surface, place });
      return api.runSnapshot(key);
    },
    /** What a screen showing the request needs; never the code alone. */
    runSnapshot(key) {
      const run = liveRun(key) || (runs.get(key)?.status === "connected" ? runs.get(key) : null);
      return run ? { id: run.id, surface: run.surface, place: run.place, status: run.status, prompt: run.prompt, expiresAt: run.expiresAt,
        open: Boolean(run.openUrl), connectedAt: run.connectedAt || "" } : null;
    },
    /** Ask the server whether the AI redeemed the account's live request. */
    async pollRun(key) {
      const run = runs.get(key);
      if (!run || run.status !== "pending") return api.runSnapshot(key);
      const status = await (await client()).agentSetupRun(run.id);
      runs.set(key, { ...run, status: status.status, connectedAt: status.connectedAt || "" });
      return api.runSnapshot(key);
    },
    copyRun(key) {
      const run = liveRun(key);
      if (!run?.prompt) throw new Error("Relay has no setup request ready yet.");
      writeClipboard(run.prompt);
      return { ok: true };
    },
    /** Open the AI with the request in its composer, and on the clipboard in case it is not. */
    async openRun(key) {
      const run = liveRun(key);
      const name = HOSTS[run?.surface]?.name || "your AI";
      if (!run?.openUrl) throw new Error(`Copy the request, then paste it into ${name}.`);
      writeClipboard(run.prompt);
      try { await openExternal(run.openUrl); return { ok: true }; }
      catch {
        // The Claude app refused its own link: the web app takes the same sentence.
        if (run.surface === "claude" && run.openUrl.startsWith("claude://")) {
          await openExternal(`https://claude.ai/new?q=${encodeURIComponent(run.prompt)}`);
          return { ok: true, via: "web" };
        }
        throw new Error(`Couldn’t open ${name}. The request is copied: paste it there.`);
      }
    },
    cancelRun(key) {
      const old = runs.get(key);
      runs.delete(key);
      if (old?.status === "pending") void client().then((c) => c.cancelAgentSetupRun(old.id)).catch(() => {});
    },
    /** Did the AI redeem the code? The one event that moves the paste screen on. */
    async poll(key) {
      const chosen = record(key);
      const surface = connectorSurface(chosen?.host);
      if (surface && !chosen.connectedAt) {
        const { connected } = await api.checkConnector(key, surface);
        // Allow in the browser is the last click (or the AI had Relay already):
        // the app moves on to starting the first chat. Nothing opens by itself.
        if (connected) {
          save(key, { ...chosen, connectedAt: new Date(now()).toISOString(), via: "connector" });
          void api.refreshServer(key);
        }
        return api.snapshot(key);
      }
      // The AI's chat has the start sentence: wait for it to ask Relay how to begin.
      const lesson = chosen?.host === "claude" || (surface === "chatgpt" && chosen?.via === "connector");
      if (lesson && !server.get(key)?.tutorialStartedAt) {
        await api.refreshServer(key);
        return api.snapshot(key);
      }
      if (!runs.get(key) || !chosen || runs.get(key).status !== "pending") return api.snapshot(key);
      const run = await api.pollRun(key);
      if (run?.status === "connected" && !chosen.connectedAt) save(key, { ...chosen, connectedAt: run.connectedAt || new Date(now()).toISOString() });
      if (run?.status === "connected") void api.refreshServer(key);
      return api.snapshot(key);
    },
    /** A local agent started the installed helper: that is its connection. */
    markConnected(key) {
      const chosen = record(key);
      if (chosen?.host && !chosen.connectedAt) save(key, { ...chosen, connectedAt: new Date(now()).toISOString() });
    },
    async copyPrompt(key) {
      // Claude has no code: its start sentence, which names who the first Relay is for, is what gets pasted.
      if (record(key)?.host === "claude") {
        writeClipboard(claudeStartPrompt(server.get(key) || await api.refreshServer(key)));
        return { ok: true };
      }
      // ChatGPT's app has no code either: its start sentence, the one the chat opens with.
      if (record(key)?.host === "chatgpt" && record(key)?.via === "connector") {
        writeClipboard(CHATGPT_START_PROMPT);
        return { ok: true };
      }
      return api.copyRun(key);
    },
    /** Open the chosen AI with the request already in its composer, where it has a link for that. */
    async open(key, localPrompt = "") {
      const chosen = record(key);
      const host = HOSTS[chosen?.host];
      if (!host) throw new Error("Choose an AI first.");
      if (chosen.host === "claude") return api.openClaudeChat(key);
      if (chosen.host === "chatgpt" && chosen.via === "connector") return api.openChatGptChat(key);
      if (host.chat) return api.openRun(key);
      if (!host.open || !localPrompt || !ownsScheme(host.scheme)) throw new Error(`Copy the prompt, then paste it into ${host.name}.`);
      writeClipboard(localPrompt);
      await openExternal(host.open(encodeURIComponent(localPrompt)));
      return { ok: true };
    },
    async refreshServer(key) {
      try {
        const answer = await (await client()).agentOnboarding();
        if (answer && typeof answer.kind === "string") server.set(key, answer);
      } catch { /* An older server or offline: the local context still decides. */ }
      return server.get(key) || null;
    },
    serverAnswer(key) { return server.get(key) || null; },
  };
  return api;
}

module.exports = { createAgentOnboarding, AGENT_ONBOARDING_HOSTS: HOSTS, CLAUDE_START_PROMPT, CHATGPT_START_PROMPT, CHATGPT_START_URL, claudeStartPrompt };
