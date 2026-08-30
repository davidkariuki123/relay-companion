import { accountIdentity, apiUrl, deviceToken } from "./config.js";
import { compareAccountIdentity } from "./account.js";
import { createRequire } from "node:module";
import {
  e2eeInboxItem,
  e2eePacket,
  e2eeSentItem,
  encryptE2eeMessage,
  ensureE2eeKeyPackages,
  identityOrThrow,
  localE2eeIdentityAvailable,
  verifiedE2eeStatus,
} from "./e2ee-mls.js";
import { e2eeChat, e2eeChatForThread, e2eeChatList, e2eeOpenedRecords } from "./e2ee-sync.js";
import {
  E2EE_GROUP_PRODUCT_EVENTS,
  e2eeGroupChat,
  e2eeGroupChatForThread,
  e2eeGroupChats,
  e2eeGroupOpenedRecords,
  e2eeGroupPacket,
  ensureE2eeGroupProductReady,
  sendE2eeGroupChange,
  sendE2eeGroupRelay,
} from "./e2ee-group-product.js";
import { offerE2eeDeviceHistory, syncE2eeDeviceHistory } from "./e2ee-device-history.js";
import {
  readImportedE2eeHistoryRecord,
  readProcessedGroupEvents,
  removeCachedPlaintext,
  removeImportedE2eeHistoryRecord,
  removeLocalE2eeAttachmentDirectory,
  removePendingE2eeOutbox,
  removeProcessedGroupEvent,
} from "./e2ee-state.js";

// Reported on every device-authenticated call so the server always knows which
// companion version each device runs — support and rollout questions get
// answered from data, never from screenshots.
const COMPANION_VERSION = (() => {
  try {
    return String(createRequire(import.meta.url)("../package.json").version || "");
  } catch {
    return "";
  }
})();

/**
 * One kept-alive connection to relay-api, shared by every caller in the process.
 *
 * Every companion call goes to a single host over TLS, and Node's built-in fetch
 * holds an idle connection for only 4 seconds — exactly the daemon's poll
 * interval, so in practice almost every request re-did the TCP and TLS
 * handshake before it could ask anything. Measured against production: a cold
 * call costs ~0.95s and a warm one ~0.22s, while the server itself answers in
 * about 1ms. The handshake, not the API, was most of what "slow" meant.
 *
 * undici's own fetch is the same implementation Node bundles; using it directly
 * with an explicit dispatcher avoids sharing an agent across two copies of the
 * library.
 */
let dispatcher = null;
let undiciFetch = null;
let transportPromise = null;

const RETRYABLE_TRANSPORT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function createRelayTransport() {
  try {
    const undici = await import("undici");
    return {
      dispatcher: new undici.Agent({
        // Comfortably longer than any poll interval, so the connection is warm
        // when the next request arrives.
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 300_000,
        connections: 8,
      }),
      fetch: undici.fetch,
    };
  } catch {
    // Without undici the client still works; it just pays the handshake again.
    return { dispatcher: null, fetch: (u, i) => fetch(u, i) };
  }
}

async function relayTransport() {
  if (undiciFetch) return { dispatcher, fetch: undiciFetch };
  if (!transportPromise) transportPromise = createRelayTransport();
  const pending = transportPromise;
  const created = await pending;
  if (transportPromise !== pending) {
    // closeRelayConnections() retired this pool while its import was pending.
    if (created.dispatcher) await created.dispatcher.close().catch(() => {});
    return relayTransport();
  }
  dispatcher = created.dispatcher;
  undiciFetch = created.fetch;
  transportPromise = null;
  return created;
}

async function keepAliveFetch(url, init, transportRef) {
  const transport = await relayTransport();
  // The request body may fail after headers arrive. Retain the exact pool used
  // by this attempt so a concurrent failure cannot retire a newer pool.
  if (transportRef) transportRef.current = transport;
  return transport.fetch(url, transport.dispatcher ? { ...init, dispatcher: transport.dispatcher } : init);
}

function retireRelayTransport(transport) {
  if (!transport) return;
  if (dispatcher === transport.dispatcher && undiciFetch === transport.fetch) {
    dispatcher = null;
    undiciFetch = null;
  }
  // Graceful close lets unrelated in-flight requests finish on the old pool;
  // every new request uses the fresh pool immediately.
  if (transport.dispatcher) void transport.dispatcher.close().catch(() => {});
}

function transportFailureDetails(error) {
  let current = error;
  let code = "";
  let name = "";
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (!code && typeof current.code === "string") code = current.code;
    if (typeof current.name === "string" && current.name) name = current.name;
    current = current.cause;
  }
  return { code, name: name || "Error" };
}

function isRetryableTransportFailure(error) {
  if (!error || Number(error.status || error.statusCode || 0)) return false;
  const { code } = transportFailureDetails(error);
  if (RETRYABLE_TRANSPORT_CODES.has(code)) return true;
  if (error.name === "TimeoutError") return true;
  // Undici sometimes has no coded cause (notably for a refused local port),
  // but preserves this stable outer error shape.
  return error.name === "TypeError" && /fetch failed|network|socket/i.test(String(error.message || ""));
}

function requestCanRetry(method, body) {
  if (RETRYABLE_METHODS.has(String(method).toUpperCase())) return true;
  return Boolean(
    body
      && typeof body === "object"
      && !Array.isArray(body)
      && typeof body.idempotencyKey === "string"
      && body.idempotencyKey.trim(),
  );
}

function recordTransportFailure(error, attempts) {
  const { code, name } = transportFailureDetails(error);
  try {
    Object.defineProperties(error, {
      relayTransportCode: { configurable: true, value: code || null },
      relayTransportCauseName: { configurable: true, value: name },
      relayTransportAttempts: { configurable: true, value: attempts },
    });
  } catch {
    // Some host errors may be non-extensible. The sanitized log still retains
    // the useful cause without ever printing request URLs, tokens, or bodies.
  }
  return code ? `${code} (${name})` : name;
}

/** Close the shared connection pool. Tests and short-lived CLIs use this to exit. */
export async function closeRelayConnections() {
  const closing = dispatcher;
  const pending = transportPromise;
  dispatcher = null;
  undiciFetch = null;
  transportPromise = null;
  const pendingTransport = pending ? await pending.catch(() => null) : null;
  const pools = new Set([closing, pendingTransport?.dispatcher].filter(Boolean));
  await Promise.all([...pools].map((pool) => pool.close().catch(() => {})));
}

const LOCAL_TRANSPORT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Production credentials and content may travel only over authenticated TLS. */
export function secureRelayApiUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol === "https:") return parsed.href.replace(/\/$/, "");
  if (parsed.protocol === "http:" && LOCAL_TRANSPORT_HOSTS.has(parsed.hostname)) {
    return parsed.href.replace(/\/$/, "");
  }
  throw new Error("Relay requires HTTPS except for a local development server.");
}

/** Thin authenticated client for relay-api, used by the CLI, MCP server, and daemon. */
export class RelayClient {
  // Set when the caller supplied its own token: such a client is deliberately
  // pinned (tests, one-shot CLIs against another device) and never follows
  // config.json.
  #pinned = false;

  constructor({ url = apiUrl(), token } = {}) {
    this.url = secureRelayApiUrl(url);
    this.#pinned = token !== undefined;
    // The account this client speaks for. Captured once, here, because the
    // token is captured once — a long-lived holder (daemon, MCP server) uses
    // accountDrift() to learn when the machine has moved on without it.
    this.identity = this.#pinned ? { userId: "", email: "", deviceId: "", deviceToken: token } : accountIdentity();
    this.token = this.#pinned ? token : this.identity.deviceToken;
  }

  /**
   * Compare the account this client is bound to with config.json now. Returns
   * { status, bound, current } where status is one of same | rotated |
   * changed | signed_out (see compareAccountIdentity). A pinned client, or one
   * running under RELAY_DEVICE_TOKEN, is always "same": its credential does
   * not come from the file that pairing rewrites.
   */
  accountDrift() {
    const bound = this.identity;
    if (this.#pinned || process.env.RELAY_DEVICE_TOKEN) return { status: "same", bound, current: bound };
    const current = accountIdentity();
    return { status: compareAccountIdentity(bound, current), bound, current };
  }

  /** Re-bind to whatever config.json holds now: token and identity together. */
  rebindToCurrentAccount() {
    if (this.#pinned) return this.identity;
    this.identity = accountIdentity();
    this.token = this.identity.deviceToken;
    return this.identity;
  }

  async #req(method, path, body, { auth = true } = {}) {
    const hasBody = body !== undefined;
    const headers = hasBody ? { "Content-Type": "application/json" } : {};
    if (COMPANION_VERSION) headers["x-relay-version"] = COMPANION_VERSION;
    headers["x-relay-client"] = "relay-companion";
    headers["x-relay-send-contract"] = "2";
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    const retryable = requestCanRetry(method, body);
    for (let attempts = 1; attempts <= 2; attempts += 1) {
      const transportRef = { current: null };
      try {
        const res = await keepAliveFetch(`${this.url}${path}`, {
          method,
          headers,
          body: hasBody ? JSON.stringify(body) : undefined,
          // A hung request must never stall a caller forever (the pill serializes its
          // payload pushes behind these calls). 15s is generous for every route we have.
          signal: AbortSignal.timeout(15000),
        }, transportRef);
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
          const err = new Error(data.message || data.error || `HTTP ${res.status}`);
          err.status = res.status;
          // The whole body, not a summary of it. A share chat re-keys the moment its
          // link is claimed, so GET /v1/chats/:chatId answers 410 chat_moved with the
          // id the room moved to; a caller that only sees the message has nothing to
          // retry against and prints "conversation deleted" at a live conversation.
          err.body = data;
          throw err;
        }
        return data;
      } catch (error) {
        if (!isRetryableTransportFailure(error)) throw error;
        retireRelayTransport(transportRef.current);
        const retrying = retryable && attempts === 1;
        const cause = recordTransportFailure(error, attempts);
        console.warn(
          `[relay] API transport ${retrying ? "interrupted" : "failed"}: ${cause}; `
          + (retrying ? `retrying ${method} once with a fresh connection` : `${method} was not retried`),
        );
        if (!retrying) throw error;
      }
    }
    throw new Error("Relay transport retry exhausted");
  }

  me() {
    return this.#req("GET", "/v1/me");
  }

  /** A short-lived, single-use browser path for installing Relay in a chat app. */
  createMcpBrowserHandoff(provider = "chatgpt") {
    return this.#req("POST", "/v1/mcp/browser-handoff", { provider });
  }

  listSessions(filters = {}) {
    const query = new URLSearchParams();
    for (const key of ["provider", "placement", "state", "limit"]) {
      if (filters[key] !== undefined && filters[key] !== "") query.set(key, String(filters[key]));
    }
    const suffix = query.size ? `?${query}` : "";
    return this.#req("GET", `/v1/sessions${suffix}`);
  }

  getSession(sessionId) {
    return this.#req("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  publishSessionObservations(observations, controller) {
    return this.#req("POST", "/v1/sessions/observations", { observations, controller });
  }

  createSessionOperation(payload) {
    return this.#req("POST", "/v1/session-operations", payload);
  }

  getSessionOperation(operationId) {
    return this.#req("GET", `/v1/session-operations/${encodeURIComponent(operationId)}`);
  }

  sessionControllerInbox() {
    return this.#req("GET", "/v1/session-operations/controller-inbox");
  }

  claimSessionOperation(operationId) {
    return this.#req("POST", `/v1/session-operations/${encodeURIComponent(operationId)}/claim`, {});
  }

  renewSessionOperationLease(operationId, claimToken) {
    return this.#req("POST", `/v1/session-operations/${encodeURIComponent(operationId)}/lease`, { claimToken });
  }

  recordSessionOperationEvidence(operationId, payload) {
    return this.#req("POST", `/v1/session-operations/${encodeURIComponent(operationId)}/evidence`, payload);
  }

  chatAgentPreferences() {
    return this.#req("GET", "/v1/chat-agents/preferences");
  }

  updateChatAgentPreferences(payload) {
    return this.#req("PATCH", "/v1/chat-agents/preferences", payload);
  }

  chatAgentSessionByResponse(relayId) {
    return this.#req("GET", `/v1/chat-agent-sessions/by-response/${encodeURIComponent(relayId)}`);
  }

  chatAgentSession(sessionId) {
    return this.#req("GET", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}`);
  }

  chatAgentSessionEvents(sessionId, after = 0) {
    return this.#req("GET", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/events?after=${Number(after) || 0}`);
  }

  appendChatAgentSessionEvents(sessionId, payload) {
    return this.#req("POST", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/events`, payload);
  }

  chatAgentSessionTurn(sessionId, message, idempotencyKey, expectedStateVersion) {
    return this.#req("POST", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/turns`, {
      message,
      idempotencyKey,
      ...(expectedStateVersion ? { expectedStateVersion } : {}),
    });
  }

  stopChatAgentSession(sessionId, idempotencyKey, expectedStateVersion) {
    return this.#req("POST", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/stop`, {
      idempotencyKey,
      ...(expectedStateVersion ? { expectedStateVersion } : {}),
    });
  }

  retryChatAgentSession(sessionId, idempotencyKey, expectedStateVersion) {
    return this.#req("POST", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/retry`, {
      idempotencyKey,
      ...(expectedStateVersion ? { expectedStateVersion } : {}),
    });
  }

  agentRunProgress(relayId, summary) {
    return this.#req("POST", `/v1/chat-agents/${encodeURIComponent(relayId)}/progress`, { summary });
  }

  agentRunComplete(relayId, forHuman, forAgent) {
    return this.#req("POST", `/v1/chat-agents/${encodeURIComponent(relayId)}/complete`, { forHuman, forAgent });
  }

  agentRunFinish(relayId, error = "") {
    return this.#req("POST", `/v1/chat-agents/${encodeURIComponent(relayId)}/finish`, error ? { error } : {});
  }

  registerDevice({ pairingCode, name, platform, e2eeIdentity }) {
    return this.#req(
      "POST",
      "/v1/devices/register",
      { pairingCode, name, platform, ...(e2eeIdentity ? { e2eeIdentity } : {}) },
      { auth: false },
    );
  }

  e2eeDirectory(relayUserId) {
    return this.#req("POST", "/v1/e2ee/directory", { relayUserId });
  }

  e2eeStatus() {
    return this.#req("GET", "/v1/e2ee/status");
  }

  e2eeRemoteEndpoint() {
    return this.#req("GET", "/v1/e2ee/remote-endpoint");
  }

  provisionE2eeRemoteEndpoint() {
    return this.#req("POST", "/v1/e2ee/remote-endpoint", {});
  }

  e2eeRemoteTunnelLease() {
    return this.#req("POST", "/v1/e2ee/remote-endpoint/lease", {});
  }

  publishE2eeRemoteDnsChallenge(value) {
    return this.#req("PUT", "/v1/e2ee/remote-endpoint/dns-challenge", { value });
  }

  removeE2eeRemoteDnsChallenge(value) {
    return this.#req("DELETE", "/v1/e2ee/remote-endpoint/dns-challenge", { value });
  }

  e2eeExportLegacyHistory(payload) {
    return this.#req("POST", "/v1/e2ee/history-import/export", payload);
  }

  e2eeTransparencySync(payload) {
    return this.#req("POST", "/v1/e2ee/transparency/sync", payload);
  }

  e2eeKeyPackageStatus() {
    return this.#req("GET", "/v1/e2ee/key-packages/status");
  }

  e2eeUploadKeyPackages(packages) {
    return this.#req("POST", "/v1/e2ee/key-packages", { packages });
  }

  e2eeCrossSignDevice(payload) {
    return this.#req("POST", "/v1/e2ee/device-cross-signatures", payload);
  }

  e2eePrepareSend(payload) {
    return this.#req("POST", "/v1/e2ee/messages/prepare", payload);
  }

  e2eeSendMessage(payload) {
    return this.#req("POST", "/v1/e2ee/messages", payload);
  }

  e2eeInbox() {
    return this.#req("GET", "/v1/e2ee/messages");
  }

  e2eeSent() {
    return this.#req("GET", "/v1/e2ee/messages/sent");
  }

  e2eeSync() {
    return this.#req("GET", "/v1/e2ee/messages/sync");
  }

  e2eeFetchMessages(ids) {
    return this.#req("POST", "/v1/e2ee/messages/batch", { ids });
  }

  e2eePrepareDeviceHistory(payload) {
    return this.#req("POST", "/v1/e2ee/device-history/prepare", payload);
  }

  e2eeUploadDeviceHistory(payload) {
    return this.#req("POST", "/v1/e2ee/device-history", payload);
  }

  e2eeDeviceHistory() {
    return this.#req("GET", "/v1/e2ee/device-history");
  }

  e2eeAcknowledgeDeviceHistory(transferId) {
    return this.#req("POST", `/v1/e2ee/device-history/${encodeURIComponent(transferId)}/ack`, {});
  }

  offerDeviceHistory(targetDeviceId, options) {
    return offerE2eeDeviceHistory(this, targetDeviceId, options);
  }

  syncDeviceHistory() {
    return syncE2eeDeviceHistory(this);
  }

  e2eePrepareGroup(payload) {
    return this.#req("POST", "/v1/e2ee/groups/prepare", payload);
  }

  e2eeBootstrapGroup(payload) {
    return this.#req("POST", "/v1/e2ee/groups", payload);
  }

  e2eePrepareGroupRekey(payload) {
    return this.#req("POST", "/v1/e2ee/groups/rekey/prepare", payload);
  }

  e2eeCommitGroupRekey(payload) {
    return this.#req("POST", "/v1/e2ee/groups/rekey", payload);
  }

  e2eeGroupWelcomes() {
    return this.#req("GET", "/v1/e2ee/groups/welcomes");
  }

  e2eeGroupEpochUpdates() {
    return this.#req("GET", "/v1/e2ee/groups/epochs");
  }

  e2eeAcknowledgeGroupWelcome(groupId, epoch) {
    return this.#req(
      "POST",
      `/v1/e2ee/groups/${encodeURIComponent(groupId)}/epochs/${encodeURIComponent(epoch)}/ack`,
      {},
    );
  }

  e2eeSendGroupMessage(payload) {
    return this.#req("POST", "/v1/e2ee/groups/messages", payload);
  }

  e2eeGroupMessages() {
    return this.#req("GET", "/v1/e2ee/groups/messages");
  }

  e2eeGroupTaskClaims(ids) {
    return this.#req("POST", "/v1/e2ee/groups/messages/task/claims", { ids });
  }

  e2eeAcknowledgeGroupMessage(eventId) {
    return this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(eventId)}/ack`, {});
  }

  e2eeUploadHistoryArchive(payload) {
    return this.#req("POST", "/v1/e2ee/groups/history", payload);
  }

  e2eeHistoryArchives() {
    return this.#req("GET", "/v1/e2ee/groups/history");
  }

  e2eeAcknowledgeHistoryArchive(archiveId) {
    return this.#req("POST", `/v1/e2ee/groups/history/${encodeURIComponent(archiveId)}/ack`, {});
  }

  ensureE2eeReady() {
    return ensureE2eeKeyPackages(this);
  }

  /** Revoke THIS device's own token (`relay uninstall --purge`). */
  revokeSelf() {
    return this.#req("DELETE", "/v1/devices/self");
  }

  createTask(payload) {
    return this.#req("POST", "/v1/tasks", payload);
  }

  listTasks() {
    return this.#req("GET", "/v1/tasks");
  }

  listRelays() {
    return this.#req("GET", "/v1/task-relays");
  }

  async sendRelay(payload) {
    if (!localE2eeIdentityAvailable()) return this.#req("POST", "/v1/relays", payload).catch((error) => {
      const reviewToken = error?.body?.error === "human_message_review_required" ? error.body.reviewToken : null;
      if (!reviewToken || payload?.longForHumanConfirmed !== true) throw error;
      return this.#req("POST", "/v1/relays", { ...payload, longForHumanReviewToken: reviewToken });
    });
    const status = await verifiedE2eeStatus(this);
    if (status.mode !== "off") {
      if (payload.recipient?.groupId || String(payload.recipient?.chatId || "").startsWith("grp_")) {
        return sendE2eeGroupRelay(this, payload);
      }
      return encryptE2eeMessage(this, payload, status);
    }
    return this.#req("POST", "/v1/relays", payload).catch((error) => {
      const reviewToken = error?.body?.error === "human_message_review_required" ? error.body.reviewToken : null;
      if (!reviewToken || payload?.longForHumanConfirmed !== true) throw error;
      return this.#req("POST", "/v1/relays", { ...payload, longForHumanReviewToken: reviewToken });
    });
  }

  // The mint route runs the same 95-word review gate as POST /v1/relays, and the
  // confirmation the server accepts is an HMAC token it issued, not a boolean.
  // Without this retry a legitimate longForHumanConfirmed can never be honoured.
  mintShareLink(payload) {
    return this.#req("POST", "/v1/share-links", payload).catch((error) => {
      const reviewToken = error?.body?.error === "human_message_review_required" ? error.body.reviewToken : null;
      if (!reviewToken || payload?.longForHumanConfirmed !== true) throw error;
      return this.#req("POST", "/v1/share-links", { ...payload, longForHumanReviewToken: reviewToken });
    });
  }

  revokeShareLink(relayId) {
    return this.#req("DELETE", `/v1/share-links/${encodeURIComponent(relayId)}`);
  }

  async editMessage(relayId, payload) {
    if (String(relayId).startsWith("egmsg_")) {
      const sent = await sendE2eeGroupChange(
        this,
        relayId,
        E2EE_GROUP_PRODUCT_EVENTS.edit,
        {
          ...(payload.forHuman !== undefined ? { forHuman: payload.forHuman } : {}),
          ...(payload.forAgent !== undefined ? { forAgent: payload.forAgent } : {}),
        },
        payload.idempotencyKey,
      );
      const now = new Date().toISOString();
      return { ok: true, relayId, affectedRelayIds: [relayId], updatedAt: now, editedAt: now, e2eeEventId: sent.eventId };
    }
    if (String(relayId).startsWith("erelay_")) {
      const status = await verifiedE2eeStatus(this);
      const sent = await encryptE2eeMessage(this, {
        kind: "message",
        recipient: {},
        ...(payload.forHuman !== undefined ? { forHuman: payload.forHuman } : {}),
        ...(payload.forAgent !== undefined ? { forAgent: payload.forAgent } : {}),
        idempotencyKey: payload.idempotencyKey,
        e2eeEvent: { type: "message.edited", targetRelayId: relayId },
      }, status);
      const now = new Date().toISOString();
      return { ok: true, relayId, affectedRelayIds: [relayId], updatedAt: now, editedAt: now, e2eeEventId: sent.relayId };
    }
    return this.#req("PATCH", `/v1/messages/${encodeURIComponent(relayId)}`, payload);
  }

  async deleteMessage(relayId, payload) {
    if (String(relayId).startsWith("egmsg_")) {
      const sent = await sendE2eeGroupChange(
        this,
        relayId,
        E2EE_GROUP_PRODUCT_EVENTS.delete,
        { deleted: true },
        payload.idempotencyKey,
      );
      const identity = identityOrThrow();
      const target = readProcessedGroupEvents(identity).find((record) => record.eventId === relayId);
      await this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(relayId)}/purge`, {
        tombstoneEventId: sent.eventId,
      });
      if (target) removeProcessedGroupEvent(identity, target.groupId, relayId);
      removeLocalE2eeAttachmentDirectory(relayId);
      const now = new Date().toISOString();
      return { ok: true, relayId, affectedRelayIds: [relayId], updatedAt: now, deletedAt: now, e2eeEventId: sent.eventId };
    }
    if (String(relayId).startsWith("erelay_")) {
      const status = await verifiedE2eeStatus(this);
      const sent = await encryptE2eeMessage(this, {
        kind: "message",
        recipient: {},
        forHuman: "",
        idempotencyKey: payload.idempotencyKey,
        e2eeEvent: { type: "message.deleted", targetRelayId: relayId },
      }, status);
      await this.#req("POST", `/v1/e2ee/messages/${encodeURIComponent(relayId)}/purge`, {
        tombstoneEventId: sent.relayId,
      });
      const identity = identityOrThrow();
      removeCachedPlaintext(identity, relayId);
      removeImportedE2eeHistoryRecord(identity, relayId);
      removePendingE2eeOutbox(identity, `direct:${relayId}`);
      removeLocalE2eeAttachmentDirectory(relayId);
      const now = new Date().toISOString();
      return { ok: true, relayId, affectedRelayIds: [relayId], updatedAt: now, deletedAt: now, e2eeEventId: sent.relayId };
    }
    return this.#req("DELETE", `/v1/messages/${encodeURIComponent(relayId)}`, payload);
  }

  /**
   * `summary: true` asks for the change-detection projection — no bodies, no
   * signed attachment URLs. A poller running every few seconds wants this; it
   * re-fetches real packets (via fetchRelayPackets) only for what changed.
   */
  async inbox({ summary = false } = {}) {
    if (!localE2eeIdentityAvailable()) {
      return this.#req("GET", summary ? "/v1/inbox?view=summary" : "/v1/inbox");
    }
    const status = await verifiedE2eeStatus(this);
    if (status.mode === "off") return this.#req("GET", summary ? "/v1/inbox?view=summary" : "/v1/inbox");
    await ensureE2eeKeyPackages(this, status);
    const encrypted = await this.e2eeSync();
    const e2eeItems = [];
    const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
    for (const record of synchronized.opened.filter((entry) => entry.item.direction === "inbound")) {
      const item = e2eeInboxItem(record.wire, record.plaintext);
      e2eeItems.push(summary ? {
        relayId: item.relayId,
        state: item.state,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        kind: item.kind,
        ...(item.title ? { title: item.title } : {}),
        sender: item.sender,
        preview: item.preview,
        inReplyToRelayId: item.inReplyToRelayId,
        threadId: item.threadId,
        hasAttachments: false,
        e2ee: item.e2ee,
        ...(item.historyImported ? { historyImported: true } : {}),
      } : item);
    }
    const groupRecords = await e2eeGroupOpenedRecords(this);
    for (const record of groupRecords.filter((entry) => entry.item.direction === "inbound")) {
      const item = record.item;
      e2eeItems.push(summary ? {
        relayId: item.relayId,
        state: item.state,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        kind: item.kind,
        ...(item.title ? { title: item.title } : {}),
        sender: item.sender,
        preview: item.preview,
        inReplyToRelayId: item.inReplyToRelayId,
        threadId: item.threadId,
        ...(item.taskState ? { taskState: item.taskState } : {}),
        ...(item.taskStartedAt ? { taskStartedAt: item.taskStartedAt } : {}),
        ...(item.taskCompletedAt ? { taskCompletedAt: item.taskCompletedAt } : {}),
        ...(item.taskClaim ? { taskClaim: item.taskClaim } : {}),
        ...(item.recipientGroupId ? { recipientGroupId: item.recipientGroupId } : {}),
        ...(item.recipientGroupName ? { recipientGroupName: item.recipientGroupName } : {}),
        hasAttachments: item.hasAttachments,
        e2ee: item.e2ee,
        ...(item.historyImported ? { historyImported: true } : {}),
      } : item);
    }
    const managed = status.mode === "optional"
      ? await this.#req("GET", summary ? "/v1/inbox?view=summary" : "/v1/inbox")
      : { items: [] };
    return {
      items: [...(managed.items || []), ...e2eeItems]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      ...(managed.cursor ? { cursor: managed.cursor } : {}),
    };
  }

  async markAllRead(payload = {}) {
    if (localE2eeIdentityAvailable()) {
      const status = await verifiedE2eeStatus(this);
      if (status.mode !== "off") {
        const encrypted = await this.e2eeSync();
        const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
        const ids = synchronized.opened
          .filter((entry) => entry.item.direction === "inbound" && entry.item.state === "delivered")
          .map((entry) => entry.wire.relayId);
        const result = await this.markManyRead(ids, payload);
        if (status.mode === "required") return result;
      }
    }
    return this.#req("POST", "/v1/inbox/read-all", payload);
  }

  /**
   * Read a batch of Relays the human has actually been shown.
   *
   * POST /v1/inbox/read is now a no-op compatibility shim for companions that
   * predate read-free fetches: it answers 200 having updated nothing. Sending a
   * real human read through it drops the receipt silently, and the sender waits
   * on "delivered" forever. The recipient-scoped per-Relay route is the only
   * surviving write path, so a batch is a fan-out over it. Each id carries its
   * own operation id, otherwise the provenance trace cannot tell the reads
   * apart. Every write is monotonic, so a partial failure is safe to retry.
   */
  async markManyRead(relayIds, payload = {}) {
    const ids = Array.from(new Set((relayIds || []).filter(Boolean)));
    if (!ids.length) return { ok: true, ordinaryRelaysUpdated: 0, relayIds: [] };
    const { idempotencyKey = "mark-many-read", ...rest } = payload;
    // E2EE receipts reserve one-time packages and update encrypted local state;
    // serialize the fan-out so concurrent file replacements cannot lose one.
    for (const id of ids) {
      await this.markRead(id, {
        ...rest,
        idempotencyKey: `${idempotencyKey}:${id}`,
      });
    }
    return { ok: true, ordinaryRelaysUpdated: ids.length, relayIds: ids };
  }

  async sent({ limit } = {}) {
    const query = Number.isFinite(limit) ? `?limit=${encodeURIComponent(limit)}` : "";
    if (!localE2eeIdentityAvailable()) return this.#req("GET", `/v1/sent${query}`);
    const status = await verifiedE2eeStatus(this);
    if (status.mode === "off") return this.#req("GET", `/v1/sent${query}`);
    await ensureE2eeKeyPackages(this, status);
    const encrypted = await this.e2eeSync();
    const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
    const groupRecords = await e2eeGroupOpenedRecords(this);
    const groupViews = (await this.groups()).groups || [];
    const groupNames = new Map(groupViews.map((group) => [group.id, group.name]));
    const items = synchronized.opened
      .filter((entry) => entry.item.direction === "outbound")
      .map((entry) => e2eeSentItem(entry.wire, entry.plaintext));
    for (const record of groupRecords.filter((entry) => entry.item.direction === "outbound")) {
      const item = record.item;
      items.push({
        ...item,
        recipient: { name: groupNames.get(record.groupId) || "Relay group", onRelay: true },
        recipientGroupId: record.groupId,
        recipientGroupName: groupNames.get(record.groupId) || "Relay group",
        delivery: { channel: "device", state: item.state, sentAt: item.createdAt },
      });
    }
    const selected = items
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200);
    if (status.mode === "required") return { items: selected };
    const managed = await this.#req("GET", `/v1/sent${query}`);
    return {
      items: [...(managed.items || []), ...selected]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200),
    };
  }

  async fetchRelay(id) {
    if (String(id).startsWith("egmsg_")) {
      const records = await e2eeGroupOpenedRecords(this);
      const projected = records.find((entry) => entry.eventId === id);
      if (!projected) throw new Error("Encrypted group Relay not found.");
      const group = (await this.groups()).groups?.find((item) => item.id === projected.groupId);
      return e2eeGroupPacket(projected, group?.name);
    }
    if (!String(id).startsWith("erelay_")) return this.#req("GET", `/v1/relays/${encodeURIComponent(id)}`);
    const encrypted = await this.e2eeSync();
    const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
    const projected = synchronized.opened.find((entry) => entry.wire.relayId === id);
    if (!projected) throw new Error("Encrypted Relay not found.");
    return await e2eePacket(projected.wire, projected.plaintext);
  }

  /**
   * Packets for many relays in ONE round trip. Fetching them one at a time cost
   * a full request RTT each (~0.25-1s from a distant client), which is what made
   * catching up on a backlog take minutes. Ids the caller may not read are
   * absent from `packets` — same meaning as a 404 from the single-relay route.
   */
  async fetchRelayPackets(ids) {
    const identity = localE2eeIdentityAvailable() ? identityOrThrow() : null;
    const imported = new Map();
    if (identity) {
      for (const id of ids || []) {
        if (!String(id).startsWith("erelay_")) continue;
        const record = readImportedE2eeHistoryRecord(identity, id);
        if (record) imported.set(id, record);
      }
    }
    const encryptedIds = (ids || []).filter((id) => String(id).startsWith("erelay_") && !imported.has(id));
    const groupIds = (ids || []).filter((id) => String(id).startsWith("egmsg_"));
    const legacyIds = (ids || []).filter((id) => !String(id).startsWith("erelay_") && !String(id).startsWith("egmsg_"));
    const result = legacyIds.length
      ? await this.#req("POST", "/v1/relays/packets", { ids: legacyIds })
      : { packets: {} };
    if (encryptedIds.length || imported.size) {
      const encrypted = await this.e2eeSync();
      const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
      const wanted = new Set((ids || []).map(String));
      for (const record of synchronized.opened) {
        if (!wanted.has(record.wire.relayId)) continue;
        result.packets[record.wire.relayId] = await e2eePacket(record.wire, record.plaintext);
      }
    }
    if (groupIds.length) {
      const [records, groups] = await Promise.all([e2eeGroupOpenedRecords(this), this.groups()]);
      const names = new Map((groups.groups || []).map((group) => [group.id, group.name]));
      const wanted = new Set(groupIds.map(String));
      for (const record of records) {
        if (wanted.has(record.eventId)) result.packets[record.eventId] = await e2eeGroupPacket(record, names.get(record.groupId));
      }
    }
    return result;
  }

  async reactions(ids) {
    const encryptedIds = (ids || []).filter((id) => String(id).startsWith("erelay_"));
    const groupIds = (ids || []).filter((id) => String(id).startsWith("egmsg_"));
    const legacyIds = (ids || []).filter((id) => !String(id).startsWith("erelay_") && !String(id).startsWith("egmsg_"));
    const result = legacyIds.length
      ? await this.#req("POST", "/v1/relays/reactions", { ids: legacyIds })
      : { reactions: {} };
    if (encryptedIds.length) {
      const encrypted = await this.e2eeSync();
      const synchronized = await e2eeOpenedRecords(this, encrypted.items || []);
      const wanted = new Set(encryptedIds.map(String));
      for (const record of synchronized.opened) {
        if (wanted.has(record.wire.relayId)) result.reactions[record.wire.relayId] = record.item.reactions;
      }
    }
    if (groupIds.length) {
      const records = await e2eeGroupOpenedRecords(this);
      const wanted = new Set(groupIds.map(String));
      for (const record of records) {
        if (wanted.has(record.eventId)) result.reactions[record.eventId] = record.item.reactions;
      }
    }
    return result;
  }

  async react(id, { emoji, action, idempotencyKey }) {
    if (String(id).startsWith("egmsg_")) {
      const sent = await sendE2eeGroupChange(
        this,
        id,
        E2EE_GROUP_PRODUCT_EVENTS.reaction,
        { emoji, action },
        idempotencyKey,
      );
      return { ok: true, relayId: id, changed: true, reactions: { aggregates: [], events: [] }, fanoutRelayIds: [sent.eventId] };
    }
    if (String(id).startsWith("erelay_")) {
      const status = await verifiedE2eeStatus(this);
      const sent = await encryptE2eeMessage(this, {
        kind: "message",
        recipient: {},
        forHuman: "",
        idempotencyKey,
        e2eeEvent: { type: "reaction.changed", targetRelayId: id, emoji, action },
      }, status);
      return { ok: true, relayId: id, changed: true, reactions: { aggregates: [], events: [] }, fanoutRelayIds: [sent.relayId] };
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/reactions`, {
      emoji,
      action,
      idempotencyKey,
    });
  }

  async acknowledge(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      const sent = await sendE2eeGroupChange(
        this,
        id,
        E2EE_GROUP_PRODUCT_EVENTS.receipt,
        { state: "acknowledged" },
        payload.idempotencyKey || `acknowledge:${id}`,
      );
      return { ok: true, relayId: id, e2eeEventId: sent.eventId };
    }
    if (String(id).startsWith("erelay_")) {
      const status = await verifiedE2eeStatus(this);
      const idempotencyKey = payload.idempotencyKey || `acknowledge:${id}`;
      await encryptE2eeMessage(this, {
        kind: "message",
        recipient: {},
        forHuman: "",
        idempotencyKey,
        e2eeEvent: { type: "receipt.changed", targetRelayId: id, state: "acknowledged" },
      }, status);
      // Acknowledgement also authorizes erasing this device's one-time Welcome.
      return this.#req("POST", `/v1/e2ee/messages/${encodeURIComponent(id)}/ack`, payload);
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/ack`, payload);
  }

  async markRead(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      const sent = await sendE2eeGroupChange(
        this,
        id,
        E2EE_GROUP_PRODUCT_EVENTS.receipt,
        { state: "read" },
        payload.idempotencyKey || `mark-read:${id}`,
      );
      return { ok: true, relayId: id, e2eeEventId: sent.eventId };
    }
    if (String(id).startsWith("erelay_")) {
      const status = await verifiedE2eeStatus(this);
      const idempotencyKey = payload.idempotencyKey || `mark-read:${id}`;
      const sent = await encryptE2eeMessage(this, {
        kind: "message",
        recipient: {},
        forHuman: "",
        idempotencyKey,
        e2eeEvent: { type: "receipt.changed", targetRelayId: id, state: "read" },
      }, status);
      return { ok: true, relayId: id, e2eeEventId: sent.relayId };
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/read`, payload);
  }

  /** Claim one shared channel Task for this human. */
  async taskClaimed(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      return this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(id)}/task/claim`, payload);
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/claim`, payload);
  }

  /** Release this human's claim on an idle shared channel Task. */
  async taskUnclaimed(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      return this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(id)}/task/unclaim`, payload);
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/unclaim`, payload);
  }

  /** The recipient started a Task, either in Relay Work or an external MCP session. */
  async taskStarted(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      return this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(id)}/task/started`, payload);
    }
    if (String(id).startsWith("erelay_")) {
      return this.e2eeTaskChanged(id, "started", {
        ...payload,
        taskRunOwner: payload.taskRunOwner || { kind: "relay_work" },
        idempotencyKey: payload.idempotencyKey || `task-started:${id}`,
      });
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/started`, payload);
  }

  /** The claimant's provider run is no longer live; ownership remains theirs. */
  async taskStopped(id, payload = {}) {
    if (String(id).startsWith("egmsg_")) {
      return this.#req("POST", `/v1/e2ee/groups/messages/${encodeURIComponent(id)}/task/stopped`, payload);
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/stopped`, payload);
  }

  /** Complete one exact inbound Task and return its canonical result Relay. */
  async taskCompleted(id, payload) {
    if (String(id).startsWith("egmsg_")) {
      const records = await e2eeGroupOpenedRecords(this);
      const target = records.find((record) => record.eventId === id && record.item.kind === "task");
      if (!target) throw new Error("Encrypted group Task not found on this device.");
      await this.taskStarted(id, {
        idempotencyKey: `task-started:${id}`,
        source: "relay_mcp_human_requested",
        ...(payload.sourceProvider ? { sourceProvider: payload.sourceProvider } : {}),
        ...(payload.sourceNativeId ? { sourceNativeId: payload.sourceNativeId } : {}),
      });
      const sent = await this.sendRelay({
        recipient: { groupId: target.groupId },
        kind: "message",
        type: "completion",
        forHuman: payload.forHuman,
        forAgent: payload.forAgent || "",
        attachments: payload.attachments || [],
        inReplyToRelayId: id,
        idempotencyKey: `task-complete:${id}`,
        source: {
          host: "relay-mcp",
          ...(payload.sourceProvider === "codex" ? { surface: "codex" } : {}),
          ...(payload.sourceProvider === "claude" ? { surface: "claude_code" } : {}),
          ...(payload.sourceNativeId ? { threadId: payload.sourceNativeId } : {}),
        },
      });
      const completed = await this.#req(
        "POST",
        `/v1/e2ee/groups/messages/${encodeURIComponent(id)}/task/completed`,
        { idempotencyKey: `task-complete-state:${id}` },
      );
      return {
        taskRelayId: id,
        state: "done",
        completedAt: completed.completedAt,
        resultRelayId: sent.relayId,
        taskClaim: completed.taskClaim,
      };
    }
    if (String(id).startsWith("erelay_")) {
      const sent = await this.sendRelay({
        recipient: {},
        kind: "message",
        type: "completion",
        forHuman: payload.forHuman,
        forAgent: payload.forAgent || "",
        attachments: payload.attachments || [],
        inReplyToRelayId: id,
        idempotencyKey: `task-complete:${id}`,
        source: {
          host: "relay-mcp",
          ...(payload.sourceProvider === "codex" ? { surface: "codex" } : {}),
          ...(payload.sourceProvider === "claude" ? { surface: "claude_code" } : {}),
          ...(payload.sourceNativeId ? { threadId: payload.sourceNativeId } : {}),
        },
      });
      return {
        taskRelayId: id,
        state: "done",
        completedAt: new Date().toISOString(),
        resultRelayId: sent.relayId,
      };
    }
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/completed`, payload);
  }

  /** Append an opaque encrypted task receipt; the API cannot read its state. */
  async e2eeTaskChanged(id, state, { resultMessageId, taskRunOwner, idempotencyKey } = {}) {
    if (!String(id).startsWith("erelay_")) throw new Error("Encrypted Task receipts require an E2EE Task id.");
    const status = await verifiedE2eeStatus(this);
    return encryptE2eeMessage(this, {
      kind: "message",
      recipient: {},
      forHuman: "",
      idempotencyKey: idempotencyKey || `task-${state}:${id}`,
      e2eeEvent: {
        type: "task.changed",
        targetRelayId: id,
        taskId: id,
        state,
        ...(resultMessageId ? { resultMessageId } : {}),
        ...(taskRunOwner ? { taskRunOwner } : {}),
      },
    }, status);
  }

  deleteInboxItem(itemId, payload = {}) {
    return this.#req("POST", `/v1/inbox-items/${encodeURIComponent(itemId)}/delete`, payload);
  }

  recentlyDeleted() {
    return this.#req("GET", "/v1/recently-deleted");
  }

  restoreInboxItem(itemId, payload = {}) {
    return this.#req("POST", `/v1/recently-deleted/${encodeURIComponent(itemId)}/restore`, payload);
  }

  openRelay(token) {
    return this.#req("GET", `/v1/open/${encodeURIComponent(token)}`, undefined, { auth: false });
  }

  openRelayPacket(token) {
    return this.#req("GET", `/v1/open/${encodeURIComponent(token)}/packet`, undefined, { auth: false });
  }

  bindOpenRelay(token) {
    return this.#req("POST", `/v1/open/${encodeURIComponent(token)}/bind`, {});
  }

  createFileUpload(payload) {
    return this.#req("POST", "/v1/files", payload);
  }

  fileDownload(fileId) {
    return this.#req("GET", `/v1/files/${encodeURIComponent(fileId)}/download`);
  }

  openTaskInvitation(token) {
    return this.#req("GET", `/v1/task-invitations/${encodeURIComponent(token)}`, undefined, { auth: false });
  }

  bindTaskInvitation(token, payload = {}) {
    return this.#req("POST", "/v1/task-invitations/bind", { token, ...payload });
  }

  getTask(taskId) {
    return this.#req("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  acceptTask(taskId, participantId, payload) {
    return this.#req(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/invitations/${encodeURIComponent(participantId)}/accept`,
      payload,
    );
  }

  rejectTask(taskId, participantId, payload) {
    return this.#req(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/invitations/${encodeURIComponent(participantId)}/reject`,
      payload,
    );
  }

  createTaskMessage(taskId, payload) {
    return this.#req("POST", `/v1/tasks/${encodeURIComponent(taskId)}/messages`, payload);
  }


  approveShare(taskId, approvalId, payload) {
    return this.#req(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}/approve`,
      payload,
    );
  }

  declineShare(taskId, approvalId, payload) {
    return this.#req(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}/decline`,
      payload,
    );
  }

  completeTask(taskId, payload) {
    return this.#req("POST", `/v1/tasks/${encodeURIComponent(taskId)}/results`, payload);
  }

  taskEvents(taskId) {
    return this.#req("GET", `/v1/tasks/${encodeURIComponent(taskId)}/events`);
  }

  agentInbox() {
    return this.#req("GET", "/v1/tasks/agent-inbox");
  }

  heartbeatSession(sessionId, payload) {
    return this.#req("POST", `/v1/task-agent-sessions/${encodeURIComponent(sessionId)}/heartbeat`, payload);
  }

  postDaemonEvent(taskId, payload) {
    return this.#req("POST", `/v1/tasks/${encodeURIComponent(taskId)}/daemon-events`, payload);
  }

  listConnectors() {
    return this.#req("GET", "/v1/connectors");
  }

  toolCatalog() {
    return this.#req("GET", "/v1/tools/catalog");
  }

  requestToolApproval(payload) {
    return this.#req("POST", "/v1/tools/approvals", payload);
  }

  callTool(payload) {
    return this.#req("POST", "/v1/tools/call", payload);
  }

  thread(threadId) {
    return this.#req("GET", `/v1/threads/${encodeURIComponent(threadId)}`);
  }

  // Chats: every thread between the same set of people, merged into one
  // conversation. See apps/api/src/services/chat-identity.ts for the ontology.
  async chats(options = {}) {
    const explicitSurface = Boolean(options && Object.prototype.hasOwnProperty.call(options, "surface"));
    const surface = options && options.surface === "slack" ? "slack" : "relay";
    const relayListPath = "/v1/chats?surface=relay";
    // Explicit surface requests are managed projections. They never
    // participate in the local E2EE merge, whose identities and ciphertext
    // belong to Relay. Omitting the option preserves the legacy merged client.
    if (explicitSurface && surface === "slack") return this.#req("GET", "/v1/chats?surface=slack");
    if (explicitSurface) return this.#req("GET", relayListPath);
    if (!localE2eeIdentityAvailable()) return this.#req("GET", relayListPath);
    const status = await verifiedE2eeStatus(this);
    if (status.mode === "off") return this.#req("GET", relayListPath);
    await ensureE2eeKeyPackages(this, status);
    const encrypted = await this.e2eeSync();
    const e2ee = await e2eeChatList(this, encrypted.items || []);
    const groupChats = await e2eeGroupChats(this);
    for (const chat of groupChats) {
      const { items: _items, hasMoreMessages: _more, ...summary } = chat;
      e2ee.chats.push(summary);
    }
    e2ee.chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (status.mode === "required") return e2ee;
    const managed = await this.#req("GET", relayListPath);
    const merged = new Map((managed.chats || []).map((chat) => [chat.chatId, chat]));
    for (const chat of e2ee.chats) merged.set(chat.chatId, chat);
    return { chats: [...merged.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
  }

  async chat(chatId, options = {}) {
    const explicitSurface = Boolean(options && Object.prototype.hasOwnProperty.call(options, "surface"));
    const surface = options && options.surface === "slack" ? "slack" : "relay";
    const includeSlack = options && options.includeSlack === true;
    const managedBase = `/v1/chats/${encodeURIComponent(chatId)}`;
    const relayPath = `${managedBase}?surface=relay`;
    // Native surfaces address the managed canonical room directly, including
    // under E2EE-required accounts. Unqualified calls retain their old merge.
    if (surface === "slack") return this.#req("GET", `${managedBase}?surface=slack&includeSlack=true`);
    if (includeSlack) return this.#req("GET", `${managedBase}?surface=relay&includeSlack=true`);
    if (explicitSurface) return this.#req("GET", relayPath);
    if (!localE2eeIdentityAvailable()) return this.#req("GET", relayPath);
    const status = await verifiedE2eeStatus(this);
    if (status.mode === "off") return this.#req("GET", relayPath);
    await ensureE2eeKeyPackages(this, status);
    if (String(chatId).startsWith("grp_")) {
      const group = await e2eeGroupChat(this, chatId);
      if (!group) throw new Error("Encrypted group chat not found.");
      return group;
    }
    const encrypted = await this.e2eeSync();
    const e2ee = await e2eeChat(this, encrypted.items || [], chatId);
    if (e2ee || status.mode === "required") {
      if (!e2ee) throw new Error("Encrypted chat not found.");
      return e2ee;
    }
    return this.#req("GET", relayPath);
  }

  sendChatMessage(chatId, input) {
    return this.#req("POST", `/v1/chats/${encodeURIComponent(chatId)}/messages`, input || {});
  }

  slackConnection() {
    return this.#req("GET", "/v1/integrations/slack");
  }

  startSlackConnection(input = {}) {
    return this.#req("POST", "/v1/integrations/slack/oauth/start", input);
  }

  reconnectSlack(input = {}) {
    return this.#req("POST", "/v1/integrations/slack/reconnect", input);
  }

  disconnectSlack() {
    return this.#req("POST", "/v1/integrations/slack/disconnect-user", {});
  }

  markChatRead(chatId, idempotencyKey, surface = "relay", options = {}) {
    return this.#req("POST", `/v1/chats/${encodeURIComponent(chatId)}/read`, {
      source: "relay_pill_open",
      idempotencyKey: String(idempotencyKey || `chat-read-${chatId}`),
      surface: surface === "slack" ? "slack" : "relay",
      includeSlack: Boolean(options && options.includeSlack),
    });
  }

  /** The chat around an open message, in one round trip. */
  async chatForThread(threadId) {
    if (!localE2eeIdentityAvailable()) return this.#req("GET", `/v1/chats/by-thread/${encodeURIComponent(threadId)}`);
    const status = await verifiedE2eeStatus(this);
    if (status.mode === "off") return this.#req("GET", `/v1/chats/by-thread/${encodeURIComponent(threadId)}`);
    await ensureE2eeKeyPackages(this, status);
    const encrypted = await this.e2eeSync();
    const e2ee = await e2eeChatForThread(this, encrypted.items || [], threadId);
    const group = e2ee || await e2eeGroupChatForThread(this, threadId);
    if (group || status.mode === "required") {
      if (!group) throw new Error("Encrypted chat not found.");
      return group;
    }
    return this.#req("GET", `/v1/chats/by-thread/${encodeURIComponent(threadId)}`);
  }

  /**
   * The chat with one person, by address — the room a contact card opens. It
   * resolves even when nothing has been said in it yet, so a contact you have
   * never written to still has somewhere to write. POST keeps the address out
   * of the URL, and so out of every access log between here and the API.
   */
  chatWith(email) {
    return this.#req("POST", "/v1/chats/resolve", { email: String(email || "") });
  }

  /**
   * The chat a contact group names — its owner plus its roster. A group is not
   * a container for messages, so this is the same lookup as chatWith: the room
   * those people share, empty or not.
   */
  chatForGroup(groupId) {
    if (localE2eeIdentityAvailable()) {
      return verifiedE2eeStatus(this).then((status) => status.mode === "off"
        ? this.#req("POST", "/v1/chats/resolve", { groupId: String(groupId || "") })
        : e2eeGroupChat(this, String(groupId || "")).then((chat) => {
            if (!chat) throw new Error("Encrypted group chat not found.");
            return chat;
          }));
    }
    return this.#req("POST", "/v1/chats/resolve", { groupId: String(groupId || "") });
  }

  searchContacts(q) {
    return this.#req("GET", `/v1/contacts/search?q=${encodeURIComponent(q)}`);
  }

  groups() {
    return this.#req("GET", "/v1/contact-groups");
  }

  createGroup({ name }) {
    return this.#req("POST", "/v1/contact-groups", { name });
  }

  renameGroup(groupId, { name }) {
    return this.#req("PATCH", `/v1/contact-groups/${encodeURIComponent(groupId)}`, { name });
  }

  deleteGroup(groupId) {
    return this.#req("DELETE", `/v1/contact-groups/${encodeURIComponent(groupId)}`);
  }

  async addGroupMember(groupId, contactId) {
    const result = await this.#req(
      "POST",
      `/v1/contact-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(contactId)}`,
      {},
    );
    if (localE2eeIdentityAvailable() && (await verifiedE2eeStatus(this)).mode !== "off") {
      await ensureE2eeGroupProductReady(this, groupId, `group-add:${groupId}:${contactId}`);
    }
    return result;
  }

  async removeGroupMember(groupId, contactId) {
    const result = await this.#req(
      "DELETE",
      `/v1/contact-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(contactId)}`,
    );
    if (localE2eeIdentityAvailable() && (await verifiedE2eeStatus(this)).mode !== "off") {
      await ensureE2eeGroupProductReady(this, groupId, `group-remove:${groupId}:${contactId}`);
    }
    return result;
  }

  leaveGroup(groupId) {
    return this.#req("DELETE", `/v1/contact-groups/${encodeURIComponent(groupId)}/membership`);
  }

  listContacts() {
    return this.#req("GET", "/v1/contacts");
  }

  googleContactsStatus() {
    return this.#req("GET", "/v1/google-contacts/status");
  }

  syncGoogleContacts() {
    return this.#req("POST", "/v1/google-contacts/sync", {});
  }

  upsertContact({ name, firstName, surname, lastName, email, emails, notes, idempotencyKey }) {
    return this.#req("POST", "/v1/contacts", { name, firstName, surname, lastName, email, emails, notes, idempotencyKey });
  }

  updateContact(contactId, { name, firstName, surname, lastName, email, emails, notes, idempotencyKey } = {}) {
    return this.#req("PATCH", `/v1/contacts/${encodeURIComponent(contactId)}`, {
      name,
      firstName,
      surname,
      lastName,
      email,
      emails,
      notes,
      idempotencyKey,
    });
  }

  deleteContact(contactId) {
    return this.#req("DELETE", `/v1/contacts/${encodeURIComponent(contactId)}`);
  }

  importContacts(contacts, source = "imported") {
    return this.#req("POST", "/v1/contacts/import", { contacts, source });
  }
}
