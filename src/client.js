import { accountIdentity, apiUrl, deviceToken } from "./config.js";
import { compareAccountIdentity } from "./account.js";
import { createRequire } from "node:module";

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
async function keepAliveFetch(url, init) {
  if (!undiciFetch) {
    try {
      const undici = await import("undici");
      dispatcher = new undici.Agent({
        // Comfortably longer than any poll interval, so the connection is warm
        // when the next request arrives.
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 300_000,
        connections: 8,
      });
      undiciFetch = undici.fetch;
    } catch {
      // Without undici the client still works; it just pays the handshake again.
      undiciFetch = (u, i) => fetch(u, i);
    }
  }
  return undiciFetch(url, dispatcher ? { ...init, dispatcher } : init);
}

/** Close the shared connection pool. Tests and short-lived CLIs use this to exit. */
export async function closeRelayConnections() {
  if (!dispatcher) return;
  const closing = dispatcher;
  dispatcher = null;
  undiciFetch = null;
  await closing.close().catch(() => {});
}

/** Thin authenticated client for relay-api, used by the CLI, MCP server, and daemon. */
export class RelayClient {
  // Set when the caller supplied its own token: such a client is deliberately
  // pinned (tests, one-shot CLIs against another device) and never follows
  // config.json.
  #pinned = false;

  constructor({ url = apiUrl(), token } = {}) {
    this.url = url.replace(/\/$/, "");
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
    const res = await keepAliveFetch(`${this.url}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      // A hung request must never stall a caller forever (the pill serializes its
      // payload pushes behind these calls). 15s is generous for every route we have.
      signal: AbortSignal.timeout(15000),
    });
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
  }

  me() {
    return this.#req("GET", "/v1/me");
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

  registerDevice({ pairingCode, name, platform }) {
    return this.#req("POST", "/v1/devices/register", { pairingCode, name, platform }, { auth: false });
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

  sendRelay(payload) {
    return this.#req("POST", "/v1/relays", payload).catch((error) => {
      const reviewToken = error?.body?.error === "human_message_review_required" ? error.body.reviewToken : null;
      if (!reviewToken || payload?.longForHumanConfirmed !== true) throw error;
      return this.#req("POST", "/v1/relays", { ...payload, longForHumanReviewToken: reviewToken });
    });
  }

  // The mint route runs the same 60-word review gate as POST /v1/relays, and the
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
    await Promise.all(ids.map((id) => this.markRead(id, {
      ...rest,
      idempotencyKey: `${idempotencyKey}:${id}`,
    })));
    return { ok: true, ordinaryRelaysUpdated: ids.length, relayIds: ids };
  }

  sent({ limit } = {}) {
    const query = Number.isFinite(limit) ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.#req("GET", `/v1/sent${query}`);
  }

  fetchRelay(id) {
    return this.#req("GET", `/v1/relays/${encodeURIComponent(id)}`);
  }

  /**
   * Packets for many relays in ONE round trip. Fetching them one at a time cost
   * a full request RTT each (~0.25-1s from a distant client), which is what made
   * catching up on a backlog take minutes. Ids the caller may not read are
   * absent from `packets` — same meaning as a 404 from the single-relay route.
   */
  fetchRelayPackets(ids) {
    return this.#req("POST", "/v1/relays/packets", { ids });
  }

  reactions(ids) {
    return this.#req("POST", "/v1/relays/reactions", { ids });
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

  /** The recipient pressed Start on a task relay. Idempotent server-side. */
  taskStarted(id) {
    return this.#req("POST", `/v1/relays/${encodeURIComponent(id)}/task/started`, {});
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
  chats() {
    return this.#req("GET", "/v1/chats");
  }

  chat(chatId) {
    return this.#req("GET", `/v1/chats/${encodeURIComponent(chatId)}`);
  }

  /** The chat around an open message, in one round trip. */
  chatForThread(threadId) {
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

  addGroupMember(groupId, contactId) {
    return this.#req(
      "POST",
      `/v1/contact-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(contactId)}`,
      {},
    );
  }

  removeGroupMember(groupId, contactId) {
    return this.#req(
      "DELETE",
      `/v1/contact-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(contactId)}`,
    );
  }

  leaveGroup(groupId) {
    return this.#req("DELETE", `/v1/contact-groups/${encodeURIComponent(groupId)}/membership`);
  }

  listContacts() {
    return this.#req("GET", "/v1/contacts");
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
