"use strict";
// SETUP (2026-10-07). The pill's one place to connect Relay to every AI a
// person uses: the apps on this computer (from their own config files and
// running processes, src/agent-host-status.js) and the AIs connected from a
// browser (from the server, /v1/agent/connections). This module owns the
// facts and the three verbs: connect an app, restart the Claude app so it
// loads Relay, and disconnect a browser AI. Chat AIs connect through the
// first-run chooser's own setup request (agent-onboarding.cjs), never a
// second flow.

const LOCAL_TTL_MS = 2500;
const SERVER_TTL_MS = 15_000;
// A connect or restart outcome is said once, then the status line takes over.
const NOTE_MS = 12_000;

function createAgentConnections({
  inspect,              // async () => { hosts, scannedAt }
  client,               // async () => RelayClient
  runConnect,           // async (hostId) => { ok, restart?, reason?, detail? }
  restartApp,           // async (host) => void; resolves once the app is open again
  store = {},           // persisted per account: { dismissed: { "<host>:<state>": iso } }
  persist = () => {},
  now = Date.now,
}) {
  let local = null;
  let localAt = 0;
  let localPending = null;
  const server = new Map(); // account key -> { connections, at, error }
  const serverPending = new Map();
  const busy = new Map(); // host id or connection id -> "connecting" | "restarting" | "disconnecting"
  const notes = new Map(); // host id -> { tone, text, at }

  function note(id, tone, text) { notes.set(id, { tone, text, at: now() }); }
  function liveNotes() {
    const out = {};
    for (const [id, value] of notes) if (now() - value.at < NOTE_MS) out[id] = { tone: value.tone, text: value.text };
    return out;
  }

  async function scanLocal({ force = false } = {}) {
    if (!force && local && now() - localAt < LOCAL_TTL_MS) return local;
    if (localPending) return localPending;
    localPending = (async () => {
      try { local = await inspect(); localAt = now(); }
      catch (error) { console.error("[overlay] setup scan failed:", error && error.message); }
      finally { localPending = null; }
      return local;
    })();
    return localPending;
  }

  async function scanServer(key, { force = false } = {}) {
    if (!key) return null;
    const known = server.get(key);
    if (!force && known && now() - known.at < SERVER_TTL_MS) return known;
    if (serverPending.has(key)) return serverPending.get(key);
    const pending = (async () => {
      try {
        const answer = await (await client()).agentConnections();
        server.set(key, { connections: Array.isArray(answer?.connections) ? answer.connections : [], at: now(), error: "" });
      } catch (error) {
        // An older server has no list: say nothing rather than "none".
        const status = Number(error?.status || 0);
        server.set(key, { connections: known?.connections || null, at: now(), error: status === 404 ? "" : "Couldn’t check your browser connections." });
      } finally { serverPending.delete(key); }
      return server.get(key);
    })();
    serverPending.set(key, pending);
    return pending;
  }

  function dismissedFor(key) {
    const record = key && store[key] && typeof store[key] === "object" ? store[key] : {};
    return record.dismissed && typeof record.dismissed === "object" ? record.dismissed : {};
  }

  const api = {
    /** Everything the Setup page draws, from the last scans. */
    snapshot(key, options = {}) {
      const known = key ? server.get(key) : null;
      return {
        hosts: local?.hosts || null,
        scannedAt: local?.scannedAt || 0,
        connections: known?.connections ?? null,
        connectionsError: known?.error || "",
        busy: Object.fromEntries(busy),
        notes: liveNotes(),
        nudge: api.nudge(key, options),
      };
    },
    async refresh(key, { force = false } = {}) {
      await Promise.all([scanLocal({ force }), scanServer(key, { force })]);
      return api.snapshot(key);
    },
    /**
     * The one app worth a quiet word in the inbox: installed here and not yet
     * working with Relay, and not already waved away in that same state.
     */
    nudge(key, { rider = false } = {}) {
      if (!key || !local?.hosts) return null;
      const dismissed = dismissedFor(key);
      const order = ["claude-app", "chatgpt-app", "claude-code", "codex", "conductor"];
      const candidates = local.hosts
        // Conductor is offered only to accounts that have it (a developer preview).
        .filter((host) => host.installed && (rider || host.id !== "conductor") && ["available", "restart", "broken"].includes(host.state)
          // Something broken stays until it is fixed (David, 2026-10-07); only an
          // invitation to connect a new app can be waved away.
          && (host.state !== "available" || !dismissed[`${host.id}:${host.state}`]))
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      // Conductor rides Claude Code and Codex: never its own nudge while either is offered.
      const first = candidates.find((host) => host.id !== "conductor") || candidates[0];
      return first ? { id: first.id, state: first.state, ...(first.stopped ? { stopped: true } : {}) } : null;
    },
    dismissNudge(key, hostId, state) {
      if (!key || !hostId || !state) return api.snapshot(key);
      const record = key && store[key] && typeof store[key] === "object" ? store[key] : {};
      store[key] = { ...record, dismissed: { ...dismissedFor(key), [`${hostId}:${state}`]: new Date(now()).toISOString() } };
      persist();
      return api.snapshot(key);
    },
    /** Register Relay in one app, with the same code setup uses. */
    async connect(key, hostId) {
      const host = (await scanLocal({ force: true }))?.hosts?.find((entry) => entry.id === hostId);
      if (!host?.installed) throw new Error("That app isn’t on this computer.");
      if (busy.has(hostId)) return api.snapshot(key);
      busy.set(hostId, "connecting");
      notes.delete(hostId);
      try {
        const result = await runConnect(hostId);
        if (!result?.ok) throw new Error(result?.detail || result?.reason || "connect failed");
        const after = (await scanLocal({ force: true }))?.hosts?.find((entry) => entry.id === hostId);
        if (after?.state === "restart" || (result.restart && after?.running && !after?.live)) note(hostId, "next", "");
        else note(hostId, "done", "");
      } catch (error) {
        console.error(`[overlay] connect ${hostId} failed:`, error && error.message);
        note(hostId, "error", "Couldn’t connect. Try again.");
      } finally {
        busy.delete(hostId);
      }
      return api.snapshot(key);
    },
    /** Quit and reopen an app so it loads Relay: only ever the Claude app. */
    async restart(key, hostId) {
      const host = (await scanLocal({ force: true }))?.hosts?.find((entry) => entry.id === hostId);
      if (hostId !== "claude-app" || !host?.installed) throw new Error("Only the Claude app needs a restart.");
      if (busy.has(hostId)) return api.snapshot(key);
      busy.set(hostId, "restarting");
      notes.delete(hostId);
      try {
        await restartApp(host);
        // The app is up again; give it a moment to start its servers.
        const deadline = now() + 25_000;
        let after = null;
        while (now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          after = (await scanLocal({ force: true }))?.hosts?.find((entry) => entry.id === hostId);
          if (after?.live) break;
        }
        note(hostId, after?.live ? "done" : "error", after?.live ? "" : "Claude reopened, but Relay hasn’t started there yet.");
      } catch (error) {
        console.error("[overlay] restart failed:", error && error.message);
        note(hostId, "error", "Couldn’t restart Claude. Quit it from the menu bar, then open it again.");
      } finally {
        busy.delete(hostId);
      }
      return api.snapshot(key);
    },
    /** Turn off one browser AI's access. Its next request fails. */
    async disconnect(key, id) {
      if (!key || !id) throw new Error("Choose a connection.");
      busy.set(id, "disconnecting");
      try {
        await (await client()).disconnectAgentConnection(id);
      } finally {
        busy.delete(id);
      }
      await scanServer(key, { force: true });
      return api.snapshot(key);
    },
    /** A redeemed setup code: show the new browser connection at once. */
    async connectionsChanged(key) {
      await scanServer(key, { force: true });
      return api.snapshot(key);
    },
  };
  return api;
}

module.exports = { createAgentConnections };
