import { accountIdentity, apiUrl, deviceToken } from "./config.js";
import { compareAccountIdentity } from "./account.js";
import { createRequire } from "node:module";
import { COMPANION_TELEMETRY_HEADER, companionFleetTelemetryHeader } from "./fleet-telemetry.js";
import { applicationTelemetryHeader } from "./application-telemetry.js";
import { readContext, recordReadTiming, readTimeout } from "./read-context.js";

const { installationKey: currentInstallationKey } = createRequire(import.meta.url)("./installation-key.cjs");

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
  // Concurrent startup requests await the same import. The first adopts this
  // pool and clears transportPromise; the others must reuse it, not close it.
  if (dispatcher === created.dispatcher && undiciFetch === created.fetch) return created;
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

// Per-process transport health. The daemon publishes lastSuccessAt in its
// recovery heartbeat; the pill compares its own failing streak against it to
// tell "my transport is wedged" from "Relay is down" (src/pill-liveness.cjs).
const transportHealth = { lastSuccessAt: 0, lastFailureAt: 0, failingSince: 0, failureStreak: 0 };
function noteTransportSuccess(at = Date.now()) {
  transportHealth.lastSuccessAt = at;
  transportHealth.failingSince = 0;
  transportHealth.failureStreak = 0;
}
function noteTransportFailure(at = Date.now()) {
  transportHealth.lastFailureAt = at;
  transportHealth.failureStreak += 1;
  if (!transportHealth.failingSince) transportHealth.failingSince = at;
}
/** Snapshot of this process's Relay transport health: success and failure times, current failing streak. */
export function relayTransportHealth() {
  return { ...transportHealth };
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

  async #req(method, path, body, {
    auth = true,
    clientName = "relay-companion",
    sourceProvider = "",
    nativeSessionId = "",
    signal,
    timeoutMs = 15000,
    retry = true,
  } = {}) {
    const hasBody = body !== undefined;
    const context = readContext();
    if (context) signal = signal ? AbortSignal.any([signal, context.signal]) : context.signal;
    const headers = hasBody ? { "Content-Type": "application/json" } : {};
    if (COMPANION_VERSION) headers["x-relay-version"] = COMPANION_VERSION;
    headers["x-relay-client"] = String(clientName || "relay-companion").replace(/[^\x20-\x7e]/g, "_").trim().slice(0, 80);
    const provider = String(sourceProvider || "").replace(/[^\x20-\x7e]/g, "_").trim().slice(0, 120);
    const nativeSession = String(nativeSessionId || "").replace(/[^\x20-\x7e]/g, "_").trim().slice(0, 240);
    if (provider) headers["x-relay-source-provider"] = provider;
    if (nativeSession) headers["x-relay-native-session-id"] = nativeSession;
    headers["x-relay-send-contract"] = "2";
    if (context) headers["x-relay-request-id"] = context.requestId;
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (auth && String(this.token || "").startsWith("dev_")) {
      const telemetry = companionFleetTelemetryHeader({
        scope: JSON.stringify([this.url, this.identity?.userId, this.identity?.deviceId]),
      });
      if (telemetry) headers[COMPANION_TELEMETRY_HEADER] = telemetry;
      const application = applicationTelemetryHeader();
      if (application) headers["x-relay-application-telemetry"] = application;
    }
    const retryable = retry && requestCanRetry(method, body);
    const deadline = context?.deadline ?? Date.now() + timeoutMs * (retryable ? 2 : 1);
    for (let attempts = 1; attempts <= 2; attempts += 1) {
      const transportRef = { current: null };
      const attemptStarted = performance.now();
      let headersMs;
      let receivedHeaders = false;
      try {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw readTimeout();
        const res = await keepAliveFetch(`${this.url}${path}`, {
          method,
          headers,
          body: hasBody ? JSON.stringify(body) : undefined,
          // A hung request must never stall a caller forever (the pill serializes its
          // payload pushes behind these calls). Live waits opt into a longer deadline.
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, remaining))]) : AbortSignal.timeout(Math.min(timeoutMs, remaining)),
        }, transportRef);
        receivedHeaders = true;
        headersMs = Math.round(performance.now() - attemptStarted);
        // Any HTTP answer proves the transport; the status code is the API's business.
        noteTransportSuccess();
        const bodyAt = performance.now();
        const text = await res.text();
        const parseAt = performance.now();
        const data = text ? JSON.parse(text) : {};
        recordReadTiming({ phase: "http", attempt: attempts, status: res.status, headersMs,
          bodyMs: Math.round(parseAt - bodyAt), parseMs: Math.round(performance.now() - parseAt),
          serverMs: Number(res.headers.get("x-relay-read-ms")) || undefined,
          elapsedMs: Math.round(performance.now() - attemptStarted), responseBytes: Buffer.byteLength(text),
          messageCount: Array.isArray(data.items) ? data.items.length : undefined });
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
        recordReadTiming({ phase: "http_failure", attempt: attempts, headersMs,
          elapsedMs: Math.round(performance.now() - attemptStarted), receivedHeaders,
          outcome: signal?.aborted ? "cancelled_or_deadline" : error?.name === "TimeoutError" ? "timeout" : "error" });
        if (signal?.aborted) throw error;
        if (!isRetryableTransportFailure(error)) throw error;
        noteTransportFailure();
        retireRelayTransport(transportRef.current);
        const retrying = retryable && attempts === 1 && !receivedHeaders && Date.now() < deadline;
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

  completeNetworkOnboarding(version) {
    return this.#req("POST", "/v1/me/onboarding-complete", { version });
  }

  // The server holds healthy waits for 25 seconds. The ordinary request's
  // 15-second deadline must not interrupt them; reconnect belongs to the receiver.
  waitForAccountChange(since, signal) {
    const query = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
    return this.#req("GET", `/v1/account-events/wait${query}`, undefined, {
      signal, timeoutMs: 35_000, retry: false,
    });
  }

  /** Stable personal invite link for Companion onboarding. The established
   * endpoint is primary; invites-v2 remains a tolerant compatibility fallback
   * while older developer environments finish the migration. */
  async inviteLink() {
    try {
      const result = await this.#req("POST", "/v1/invite-link", {});
      if (result?.url) return result;
    } catch (error) {
      if (![404, 405].includes(Number(error?.status))) throw error;
    }
    return this.#req("POST", "/v1/invites-v2/link", {});
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

  chatAgentSessionTurn(sessionId, message, idempotencyKey, expectedStateVersion, clientMessageId = "") {
    return this.#req("POST", `/v1/chat-agent-sessions/${encodeURIComponent(sessionId)}/turns`, {
      message,
      idempotencyKey,
      ...(expectedStateVersion ? { expectedStateVersion } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
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

  /**
   * Register this computer against a pairing code. The installation key lets
   * the server replace this installation's earlier device instead of adding a
   * second one; see src/installation-key.cjs. The key comes back on the result
   * so the account config remembers which machine issued the credential.
   */
  async registerDevice({ pairingCode, name, platform, recoverySecret, installationKey }) {
    const key = installationKey === undefined ? await currentInstallationKey() : installationKey;
    const registration = await this.#req(
      "POST",
      "/v1/devices/register",
      {
        pairingCode,
        name,
        platform,
        ...(recoverySecret ? { recoverySecret } : {}),
        ...(key ? { installationKey: key } : {}),
      },
      { auth: false },
    );
    return key ? { ...registration, installationKey: key } : registration;
  }

  /** Revoke THIS device's own token (`relay uninstall --purge`, a replaced pairing, sign-out). */
  revokeSelf({ timeoutMs } = {}) {
    return this.#req("DELETE", "/v1/devices/self", undefined, timeoutMs ? { timeoutMs, retry: false } : {});
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

  sendRelay(payload) {
    return this.#req("POST", "/v1/relays", payload).catch((error) => {
      const reviewToken = error?.body?.error === "human_message_review_required" ? error.body.reviewToken : null;
      if (!reviewToken || payload?.longForHumanConfirmed !== true) throw error;
      return this.#req("POST", "/v1/relays", { ...payload, longForHumanReviewToken: reviewToken });
    });
  }

  /** Forward a plaintext relay the account sent or received; the server copies its content. */
  forwardRelay(relayId, payload) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(relayId)}/forward`, payload);
  }

  // The mint route runs the same 120-word review gate as POST /v1/relays, and the
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

  shareLinkStatus(relayId) {
    return this.#req("GET", `/v1/share-links/${encodeURIComponent(relayId)}`);
  }

  editMessage(relayId, payload) {
    return this.#req("PATCH", `/v1/messages/${encodeURIComponent(relayId)}`, payload);
  }

  deleteMessage(relayId, payload) {
    return this.#req("DELETE", `/v1/messages/${encodeURIComponent(relayId)}`, payload);
  }

  /**
   * `summary: true` asks for the change-detection projection — no bodies, no
   * signed attachment URLs. A poller running every few seconds wants this; it
   * re-fetches real packets (via fetchRelayPackets) only for what changed.
   */
  inbox({ summary = false } = {}) {
    return this.#req("GET", summary ? "/v1/inbox?view=summary" : "/v1/inbox");
  }

  /** Canonical managed Todo workflow projection. */
  async todo({ statuses = [], limit, cursor } = {}) {
    const query = new URLSearchParams();
    if (Array.isArray(statuses) && statuses.length) query.set("statuses", statuses.join(","));
    if (Number.isInteger(limit)) query.set("limit", String(limit));
    if (cursor) query.set("cursor", String(cursor));
    const suffix = query.toString();
    return this.#req("GET", `/v1/todo${suffix ? `?${suffix}` : ""}`);
  }

  /** Change one exact Relay/Task workflow status with optimistic concurrency. */
  async updateTodoStatus(itemId, payload, provenance = {}) {
    return this.#req("PATCH", `/v1/todo/${encodeURIComponent(itemId)}/status`, payload, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  // --- Topics ---------------------------------------------------------------
  // Invite-only boards under a standing mandate. Reads never change anyone's
  // read state; markTopicSeen is the one human read watermark.
  async topics() {
    return this.#req("GET", "/v1/topics");
  }

  async topic(topicId) {
    return this.#req("GET", `/v1/topics/${encodeURIComponent(topicId)}`);
  }

  async createTopic(payload) {
    return this.#req("POST", "/v1/topics", payload);
  }

  async updateTopic(topicId, payload) {
    return this.#req("PATCH", `/v1/topics/${encodeURIComponent(topicId)}`, payload);
  }

  async archiveTopic(topicId) {
    return this.#req("DELETE", `/v1/topics/${encodeURIComponent(topicId)}`);
  }

  async inviteToTopic(topicId, recipient) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/invites`, { recipient });
  }

  async approveTopicMandate(topicId, mandateVersion) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/approve`, { mandateVersion });
  }

  async declineTopicInvite(topicId) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/decline`, {});
  }

  async leaveTopic(topicId) {
    return this.#req("DELETE", `/v1/topics/${encodeURIComponent(topicId)}/membership`);
  }

  async updateTopicMembership(topicId, payload) {
    return this.#req("PATCH", `/v1/topics/${encodeURIComponent(topicId)}/membership`, payload);
  }

  async markTopicSeen(topicId) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/seen`, {});
  }

  async setTopicMemberRole(topicId, userId, role) {
    return this.#req("PATCH", `/v1/topics/${encodeURIComponent(topicId)}/members/${encodeURIComponent(userId)}`, { role });
  }

  async removeTopicMember(topicId, userId) {
    return this.#req("DELETE", `/v1/topics/${encodeURIComponent(topicId)}/members/${encodeURIComponent(userId)}`);
  }

  async topicContext(query, { topicId, limit } = {}) {
    const params = new URLSearchParams({ query: String(query || "") });
    if (topicId) params.set("topicId", topicId);
    if (limit) params.set("limit", String(limit));
    return this.#req("GET", `/v1/topics/context?${params}`);
  }

  async topicThreads(topicId, { query, cursor, limit, threadId } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ query, cursor, limit, threadId })) if (value) params.set(key, String(value));
    return this.#req("GET", `/v1/topics/${encodeURIComponent(topicId)}/threads?${params}`);
  }

  async moveTopicPosts(topicId, threadId, payload) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/threads/${encodeURIComponent(threadId)}/move`, payload);
  }

  async topicPosts(topicId, { since, cursor, limit, threadId, postIds, updatesOnly } = {}) {
    const query = new URLSearchParams();
    if (since) query.set("since", String(since));
    if (threadId) query.set("threadId", String(threadId));
    if (Array.isArray(postIds)) query.set("postIds", postIds.join(","));
    if (updatesOnly) query.set("updatesOnly", "true");
    if (cursor) query.set("cursor", String(cursor));
    if (Number.isInteger(limit)) query.set("limit", String(limit));
    const suffix = query.toString();
    return this.#req("GET", `/v1/topics/${encodeURIComponent(topicId)}/posts${suffix ? `?${suffix}` : ""}`);
  }

  async createTopicPost(topicId, payload, provenance = {}) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/posts`, payload, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  async updateTopicPost(topicId, postId, payload, provenance = {}) {
    return this.#req("PATCH", `/v1/topics/${encodeURIComponent(topicId)}/posts/${encodeURIComponent(postId)}`, payload, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  /** Answer one post: the author gets a Relay quoting it; mode "topic" also puts the reply on the board. */
  async replyToTopicPost(topicId, postId, payload, provenance = {}) {
    return this.#req("POST", `/v1/topics/${encodeURIComponent(topicId)}/posts/${encodeURIComponent(postId)}/replies`, payload, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  async deleteTopicPost(topicId, postId) {
    return this.#req("DELETE", `/v1/topics/${encodeURIComponent(topicId)}/posts/${encodeURIComponent(postId)}`);
  }

  /** Personal Todo membership only; the Relay remains available in the chat. */
  async todoVisibility(itemId) {
    return this.#req("GET", `/v1/todo/${encodeURIComponent(itemId)}/visibility`);
  }

  async updateTodoVisibility(itemId, payload) {
    return this.#req("PATCH", `/v1/todo/${encodeURIComponent(itemId)}/visibility`, payload);
  }

  /** The Companion opened a Relay in a native session: remember which one so the steward reads it first. */
  async recordRelaySessionTouch(relayId, { provider, nativeSessionId, cwd, title } = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(relayId)}/session-touch`, {
      provider: String(provider || ""),
      nativeSessionId: String(nativeSessionId || ""),
      ...(cwd ? { cwd: String(cwd) } : {}),
      ...(title ? { title: String(title) } : {}),
    });
  }

  /** Put the listed items first inside one Todo status; the rest follow in their current order. */
  async reorderTodo(status, itemIds, provenance = {}) {
    return this.#req("POST", "/v1/todo/reorder", {
      status: String(status || ""),
      itemIds: (Array.isArray(itemIds) ? itemIds : []).map((id) => String(id || "")).filter(Boolean),
      ...(provenance.idempotencyKey ? { idempotencyKey: String(provenance.idempotencyKey) } : {}),
    }, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  markAllRead(payload = {}) {
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
    // Serialize the fan-out so each receipt keeps its own operation id.
    for (const id of ids) {
      await this.markRead(id, {
        ...rest,
        idempotencyKey: `${idempotencyKey}:${id}`,
      });
    }
    return { ok: true, ordinaryRelaysUpdated: ids.length, relayIds: ids };
  }

  sent({ limit } = {}) {
    const query = Number.isFinite(limit) ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.#req("GET", `/v1/sent${query}`);
  }

  fetchRelay(id, provenance = {}) {
    return this.#req("GET", `/v1/relays/${encodeURIComponent(id)}`, undefined, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  /**
   * Packets for many relays in ONE round trip. Fetching them one at a time cost
   * a full request RTT each (~0.25-1s from a distant client), which is what made
   * catching up on a backlog take minutes. Ids the caller may not read are
   * absent from `packets` — same meaning as a 404 from the single-relay route.
   */
  async fetchRelayPackets(ids, provenance = {}) {
    const wanted = ids || [];
    if (!wanted.length) return { packets: {} };
    return this.#req("POST", "/v1/relays/packets", { ids: wanted }, {
      clientName: provenance.clientName || "relay-companion",
      sourceProvider: provenance.sourceProvider,
      nativeSessionId: provenance.nativeSessionId,
    });
  }

  async reactions(ids) {
    const wanted = ids || [];
    if (!wanted.length) return { reactions: {} };
    return this.#req("POST", "/v1/relays/reactions", { ids: wanted });
  }

  react(id, { emoji, action, idempotencyKey }) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/reactions`, {
      emoji,
      action,
      idempotencyKey,
    });
  }

  acknowledge(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/ack`, payload);
  }

  markRead(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/read`, payload);
  }

  /** Claim one shared channel Task for this human. */
  taskClaimed(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/claim`, payload);
  }

  /** Release this human's claim on an idle shared channel Task. */
  taskUnclaimed(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/unclaim`, payload);
  }

  /** The recipient started a Task, either in Relay Work or an external MCP session. */
  taskStarted(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/started`, payload);
  }

  /** The claimant's provider run is no longer live; ownership remains theirs. */
  taskStopped(id, payload = {}) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/stopped`, payload);
  }

  /** Complete one exact inbound Task and return its canonical result Relay. */
  taskCompleted(id, payload) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/completed`, payload);
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

  // A fresh signed URL for one chat attachment, scoped to the relay's
  // participants. This is the one download path that works for the SENDER too:
  // the packet refresh only serves recipients, and an attachment's durable
  // openUrl is the web app's route, which wants a browser session, not a
  // device token.
  attachmentDownloadUrl(relayId, attachmentId) {
    return this.#req(
      "GET",
      `/v1/relays/${encodeURIComponent(relayId)}/attachments/${encodeURIComponent(attachmentId)}/download-url`,
    );
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
    // Explicit surface requests are managed projections. Omitting the option
    // preserves the legacy client shape.
    if (explicitSurface && surface === "slack") return this.#req("GET", "/v1/chats?surface=slack");
    return this.#req("GET", relayListPath);
  }

  async chat(chatId, options = {}) {
    const surface = options && options.surface === "slack" ? "slack" : "relay";
    const includeSlack = options && options.includeSlack === true;
    const managedBase = `/v1/chats/${encodeURIComponent(chatId)}`;
    const page = new URLSearchParams();
    for (const key of ["limit", "beforeCursor", "afterCursor"]) if (options[key] !== undefined) page.set(key, String(options[key]));
    const suffix = page.size ? `&${page}` : "";
    const relayPath = `${managedBase}?surface=relay${suffix}`;
    // Native surfaces address the managed canonical room directly.
    if (surface === "slack") return this.#req("GET", `${managedBase}?surface=slack&includeSlack=true${suffix}`);
    if (includeSlack) return this.#req("GET", `${managedBase}?surface=relay&includeSlack=true${suffix}`);
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

  openMentionVisit(chatId, visitId) {
    return this.#req("POST", `/v1/chats/${encodeURIComponent(chatId)}/mention-visit`, { visitId });
  }

  markChatRead(chatId, idempotencyKey, surface = "relay", options = {}) {
    return this.#req("POST", `/v1/chats/${encodeURIComponent(chatId)}/read`, {
      source: "relay_pill_open",
      idempotencyKey: String(idempotencyKey || `chat-read-${chatId}`),
      surface: surface === "slack" ? "slack" : "relay",
      includeSlack: Boolean(options && options.includeSlack),
    });
  }

  chatTyping(chatId) {
    return this.#req("GET", `/v1/chats/${encodeURIComponent(chatId)}/typing`, undefined, {
      timeoutMs:4000, retry:false,
    });
  }

  setChatTyping(chatId, typing, peerEmail) {
    return this.#req("POST", `/v1/chats/${encodeURIComponent(chatId)}/typing`, {
      typing:Boolean(typing), ...(peerEmail ? { peerEmail:String(peerEmail) } : {}),
    }, { timeoutMs:3000, retry:false });
  }

  /** The chat around an open message, in one round trip. */
  chatForThread(threadId, options = {}) {
    const page = new URLSearchParams();
    for (const key of ["limit", "beforeCursor", "afterCursor"]) if (options[key] !== undefined) page.set(key, String(options[key]));
    return this.#req("GET", `/v1/chats/by-thread/${encodeURIComponent(threadId)}${page.size ? `?${page}` : ""}`);
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
    return this.#req("POST", "/v1/chats/resolve", { groupId: String(groupId || "") });
  }

  googleContactsStatus() { return this.#req("GET", "/v1/google-contacts/status"); }

  syncGoogleContacts() { return this.#req("POST", "/v1/google-contacts/sync", {}); }

  searchContacts(q) {
    return this.#req("GET", `/v1/contacts/search?q=${encodeURIComponent(q)}`);
  }

  groups() {
    return this.#req("GET", "/v1/contact-groups");
  }

  createGroup({ name }) {
    return this.#req("POST", "/v1/contact-groups", { name });
  }

  prepareOrg(input) { return this.#req("POST", "/v1/contact-groups/prepare-org", input); }

  orgInvite(groupId, input) { return this.#req("POST", `/v1/contact-groups/${encodeURIComponent(groupId)}/org-invite`, input); }

  prepareTeam(input) {
    return this.#req("POST", "/v1/contact-groups/prepare-team", input);
  }

  transferGroupAdmin(groupId, input) {
    return this.#req("POST", `/v1/contact-groups/${encodeURIComponent(groupId)}/admin`, input);
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
    return result;
  }

  async removeGroupMember(groupId, contactId) {
    const result = await this.#req(
      "DELETE",
      `/v1/contact-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(contactId)}`,
    );
    return result;
  }

  leaveGroup(groupId) {
    return this.#req("DELETE", `/v1/contact-groups/${encodeURIComponent(groupId)}/membership`);
  }

  listContacts() {
    return this.#req("GET", "/v1/contacts");
  }

  addRelayContact(email) {
    return this.#req("POST", "/v1/contacts/on-relay", { email });
  }

  connectionBlocks() {
    return this.#req("GET", "/v1/invites-v2/blocks");
  }

  setConnectionBlocked(userId, blocked) {
    return this.#req(blocked ? "POST" : "DELETE", `/v1/invites-v2/blocks/${encodeURIComponent(userId)}`, blocked ? {} : undefined);
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
