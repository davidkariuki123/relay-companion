"use strict";
// SETUP (2026-10-07). The pill's one place to connect Relay to every AI a
// person uses: the apps on this computer (from their own config files and
// running processes, src/agent-host-status.js) and the AIs connected from a
// browser (from the server, /v1/agent/connections). This module owns the
// facts and the two verbs: connect an app, and disconnect a browser AI. Chat
// AIs connect through the first-run chooser's own setup request
// (agent-onboarding.cjs), never a second flow.
//
// THE CLAUDE APP'S CHATS use Relay's hosted connector, never a local server
// (David, 2026-10-10): its row is the account's own Claude connector, from
// the server's list, and Connect opens Claude's add-connector screen. Nothing
// on this computer can say it stopped, so there is never a restart to ask for.

const LOCAL_TTL_MS = 2500;
const SERVER_TTL_MS = 15_000;
// A connect outcome is said once, then the status line takes over.
const NOTE_MS = 12_000;
// A connection Claude has not reached in this long is a leftover (removed in
// Claude, never revoked here): the same rule as Your AIs' web rows.
const CONNECTOR_LIVE_MS = 30 * 24 * 60 * 60 * 1000;

/** Does this account have Claude's hosted connector? true | false | null (not known). */
function claudeConnectorState(connections, at) {
  if (!Array.isArray(connections)) return null;
  return connections.some((item) => {
    if (item?.kind !== "connector" || item?.surface !== "claude") return false;
    const seen = Date.parse(item.lastUsedAt || item.createdAt || "");
    return Number.isFinite(seen) && at - seen < CONNECTOR_LIVE_MS;
  });
}

/** The local scan, with the Claude app's chats decided by the account's connector. */
function withClaudeConnector(scan, connector) {
  if (!scan?.hosts) return scan;
  const hosts = scan.hosts.map((host) => (host.id !== "claude-app" || !host.installed ? host : {
    ...host,
    registered: connector === true,
    valid: connector === true,
    state: connector === true ? "connected" : connector === false ? "available" : "checking",
  }));
  const chat = scan.places?.["claude-chat"];
  if (!chat?.installed) return { ...scan, hosts };
  const place = { ...chat, connected: connector };
  delete place.action;
  delete place.reason;
  if (connector === false) place.action = "connect";
  return { ...scan, hosts, places: { ...scan.places, "claude-chat": place } };
}

function createAgentConnections({
  inspect,              // async () => { hosts, scannedAt }
  client,               // async () => RelayClient
  runConnect,           // async (hostId) => { ok, reason?, detail? }
  connectClaude = async () => { throw new Error("Claude connects with its connector."); }, // async (key) => opens Claude's add-connector screen
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

  /** The last local scan, with this account's Claude connector applied. */
  function resolved(key) {
    const known = key ? server.get(key) : null;
    return withClaudeConnector(local, claudeConnectorState(known?.connections, now()));
  }

  const api = {
    /** Everything the Setup page draws, from the last scans. */
    snapshot(key, options = {}) {
      const known = key ? server.get(key) : null;
      const scan = resolved(key);
      return {
        hosts: scan?.hosts || null,
        // Per place a person opens: what proves Relay worked there.
        places: scan?.places || null,
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
      const scan = resolved(key);
      if (!key || !scan?.hosts) return null;
      const dismissed = dismissedFor(key);
      const order = ["claude-app", "chatgpt-app", "claude-code", "codex", "conductor"];
      const candidates = scan.hosts
        // Conductor is offered only to accounts that have it (a developer preview).
        .filter((host) => host.installed && (rider || host.id !== "conductor") && ["available", "broken"].includes(host.state)
          // Something broken stays until it is fixed (David, 2026-10-07); only an
          // invitation to connect a new app can be waved away.
          && (host.state !== "available" || !dismissed[`${host.id}:${host.state}`]))
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      // Conductor rides Claude Code and Codex: never its own nudge while either is offered.
      const first = candidates.find((host) => host.id !== "conductor") || candidates[0];
      return first ? { id: first.id, state: first.state } : null;
    },
    dismissNudge(key, hostId, state) {
      if (!key || !hostId || !state) return api.snapshot(key);
      const record = key && store[key] && typeof store[key] === "object" ? store[key] : {};
      store[key] = { ...record, dismissed: { ...dismissedFor(key), [`${hostId}:${state}`]: new Date(now()).toISOString() } };
      persist();
      return api.snapshot(key);
    },
    /**
     * Register Relay in one app, with the same code setup uses. The Claude
     * app instead gets Relay's connector: Claude's add-connector screen
     * opens, and the server's list turns its row Connected.
     */
    async connect(key, hostId) {
      const host = (await scanLocal({ force: true }))?.hosts?.find((entry) => entry.id === hostId);
      if (!host?.installed) throw new Error("That app isn’t on this computer.");
      if (busy.has(hostId)) return api.snapshot(key);
      busy.set(hostId, "connecting");
      notes.delete(hostId);
      try {
        if (hostId === "claude-app") {
          await connectClaude(key);
          note(hostId, "next", "");
        } else {
          const result = await runConnect(hostId);
          if (!result?.ok) throw new Error(result?.detail || result?.reason || "connect failed");
          await scanLocal({ force: true });
          note(hostId, "done", "");
        }
      } catch (error) {
        console.error(`[overlay] connect ${hostId} failed:`, error && error.message);
        note(hostId, "error", "Couldn’t connect. Try again.");
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

module.exports = { createAgentConnections, claudeConnectorState, withClaudeConnector };
