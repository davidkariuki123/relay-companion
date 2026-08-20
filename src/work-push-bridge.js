import {
  createWorkConversation,
  hydrateWorkConversation,
  normalizeActivity,
  reduceWorkEvent,
  workPresentationSnapshot,
} from "./work-conversation.js";

const DEFAULT_MAX_FEEDS = 64;
const DEFAULT_MAX_PENDING_EVENTS = 2_048;
const DEFAULT_MAX_SUBSCRIBERS = 16;
const DEFAULT_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_RENDERER_KEYS = new Set([
  "raw",
  "rawEvent",
  "reasoningContent",
  "encryptedContent",
  "arguments",
  "args",
  "input",
  "output",
  "stdout",
  "stderr",
  "environment",
  "env",
  "headers",
  "authorization",
  "apiKey",
  "token",
  "password",
  "secret",
]);

function cleanId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required`);
  return id;
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Defense in depth around the renderer projection. The canonical presenter is
 * responsible for deciding what the UI needs; this pass guarantees provider
 * payloads and common secret-bearing fields cannot accidentally cross IPC.
 */
export function rendererSafeClone(value, { maxDepth = 16, maxArray = 1_000, maxString = 64 * 1_024 } = {}, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((entry) => rendererSafeClone(entry, { maxDepth, maxArray, maxString }, depth + 1));
  }
  if (typeof value !== "object") return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RENDERER_KEYS.has(key) || /(?:^|_)(?:secret|password|token|authorization|api[_-]?key)$/i.test(key)) continue;
    out[key] = rendererSafeClone(entry, { maxDepth, maxArray, maxString }, depth + 1);
  }
  return out;
}

function normalizeHydration(value) {
  if (Array.isArray(value)) return { events: value };
  if (!value || typeof value !== "object") return { events: [] };
  return {
    state: value.state,
    events: Array.isArray(value.events) ? value.events : [],
    provider: String(value.provider || "").trim() || null,
  };
}

function defaultAlive() {
  return true;
}

/**
 * Owns one canonical Work conversation per Relay/native-session pair.
 *
 * The native subscription is attached before async hydration starts. Events
 * arriving during hydration are queued, then replayed after the persisted
 * history. The reducer's own event-id watermarks provide overlap dedupe.
 * Renderer subscribers receive only monotonic, bounded presentation snapshots.
 */
export function createWorkPushBridge({
  createState,
  reduceEvent,
  present,
  hydrate,
  subscribeNative,
  presentItemDetail = null,
  presentAttachment = null,
  authorizeDetail = null,
  maxFeeds = DEFAULT_MAX_FEEDS,
  maxPendingEvents = DEFAULT_MAX_PENDING_EVENTS,
  maxSubscribers = DEFAULT_MAX_SUBSCRIBERS,
  maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
  now = () => Date.now(),
} = {}) {
  if (typeof createState !== "function") throw new TypeError("createState must be a function");
  if (typeof reduceEvent !== "function") throw new TypeError("reduceEvent must be a function");
  if (typeof present !== "function") throw new TypeError("present must be a function");
  if (typeof hydrate !== "function") throw new TypeError("hydrate must be a function");
  if (typeof subscribeNative !== "function") throw new TypeError("subscribeNative must be a function");

  maxFeeds = finitePositive(maxFeeds, DEFAULT_MAX_FEEDS);
  maxPendingEvents = finitePositive(maxPendingEvents, DEFAULT_MAX_PENDING_EVENTS);
  maxSubscribers = finitePositive(maxSubscribers, DEFAULT_MAX_SUBSCRIBERS);
  maxEnvelopeBytes = finitePositive(maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES);

  const feeds = new Map();

  function keyFor(relayId, sessionId) {
    return `${cleanId(relayId, "relayId")}\u0000${cleanId(sessionId, "sessionId")}`;
  }

  function touch(feed) {
    feed.lastUsedAt = now();
    feeds.delete(feed.key);
    feeds.set(feed.key, feed);
  }

  function stopNative(feed) {
    if (!feed.nativeUnsubscribe) return;
    const unsubscribe = feed.nativeUnsubscribe;
    feed.nativeUnsubscribe = null;
    feed.nativeDetached = false;
    try { unsubscribe(); } catch {}
  }

  function suspendIdleFeed(feed) {
    if (feed.subscribers.size !== 0) return;
    stopNative(feed);
    // Native notifications can occur while nobody is watching. A later
    // subscriber must therefore hydrate the authoritative bounded log again,
    // rather than inheriting a snapshot with an invisible event gap.
    feed.epoch += 1;
    feed.hydrated = false;
    feed.hydratePromise = null;
    feed.pending.length = 0;
    feed.needsRehydrate = false;
  }

  function removeFeed(feed) {
    stopNative(feed);
    feed.epoch += 1;
    feed.subscribers.clear();
    feeds.delete(feed.key);
  }

  function evict() {
    if (feeds.size <= maxFeeds) return;
    for (const feed of feeds.values()) {
      if (feeds.size <= maxFeeds) break;
      if (feed.subscribers.size === 0) removeFeed(feed);
    }
  }

  function makeEnvelope(feed) {
    const projection = rendererSafeClone(present(feed.state, now()));
    const envelope = {
      relayId: feed.relayId,
      sessionId: feed.sessionId,
      provider: String(feed.state?.provider || projection?.provider || ""),
      revision: feed.revision,
      presentation: projection,
    };
    if (byteLength(envelope) > maxEnvelopeBytes) {
      throw Object.assign(new Error("Work presentation exceeded the IPC size limit"), { code: "WORK_PRESENTATION_TOO_LARGE" });
    }
    return envelope;
  }

  function publish(feed) {
    let envelope;
    try {
      envelope = makeEnvelope(feed);
    } catch (error) {
      feed.lastError = error;
      return;
    }
    for (const [id, subscriber] of feed.subscribers) {
      if (!subscriber.isAlive()) {
        feed.subscribers.delete(id);
        continue;
      }
      try {
        subscriber.send(envelope);
      } catch {
        feed.subscribers.delete(id);
      }
    }
    suspendIdleFeed(feed);
  }

  function apply(feed, event) {
    const next = reduceEvent(feed.state, event);
    if (next !== undefined) feed.state = next;
    feed.revision += 1;
  }

  function onNative(feed, epoch, event) {
    if (feed.epoch !== epoch || !feeds.has(feed.key)) return;
    touch(feed);
    if (!feed.hydrated) {
      if (feed.pending.length >= maxPendingEvents) {
        // Dropping a native delta would make the view dishonest. Invalidate the
        // generation and perform a fresh bounded hydration instead.
        feed.pending.length = 0;
        feed.needsRehydrate = true;
        return;
      }
      feed.pending.push(event);
      return;
    }
    apply(feed, event);
    publish(feed);
  }

  function attachNative(feed) {
    if (feed.nativeUnsubscribe || feed.subscribers.size === 0) return;
    const epoch = feed.epoch;
    const unsubscribe = subscribeNative(
      { relayId: feed.relayId, sessionId: feed.sessionId },
      (event) => onNative(feed, epoch, event),
    );
    feed.nativeUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : () => {};
    feed.nativeDetached = Boolean(unsubscribe?.detached);
  }

  function failDetachedActiveTurn(feed) {
    if (!feed.nativeDetached) return;
    const projected = present(feed.state, now());
    const activeTurn = Array.isArray(projected?.turns)
      ? projected.turns.findLast((turn) => turn?.active || turn?.status === "inProgress")
      : null;
    if (!activeTurn) return;
    const emittedAtMs = now();
    apply(feed, {
      method: "relay/connectionClosed",
      eventId: `detached:${feed.epoch}:${emittedAtMs}`,
      emittedAtMs,
      params: {
        turnId: activeTurn.id || activeTurn.key,
        message: "The provider process is no longer connected. This run did not finish.",
      },
    });
  }

  async function hydrateFeed(feed) {
    if (feed.hydratePromise) return feed.hydratePromise;
    const epoch = feed.epoch;
    feed.hydratePromise = (async () => {
      do {
        feed.needsRehydrate = false;
        const hydrated = normalizeHydration(await hydrate({ relayId: feed.relayId, sessionId: feed.sessionId }));
        if (feed.epoch !== epoch || !feeds.has(feed.key)) return null;
        feed.provider = hydrated.provider || hydrated.state?.provider || feed.provider || null;
        feed.state = hydrated.state ?? createState({
          relayId: feed.relayId,
          sessionId: feed.sessionId,
          provider: feed.provider,
        });
        for (const event of hydrated.events) apply(feed, event);
        const pending = feed.pending.splice(0);
        for (const event of pending) apply(feed, event);
        failDetachedActiveTurn(feed);
      } while (feed.needsRehydrate);
      feed.hydrated = true;
      feed.revision += 1;
      publish(feed);
      return makeEnvelope(feed);
    })().catch((error) => {
      if (feed.epoch === epoch) feed.lastError = error;
      throw error;
    }).finally(() => {
      if (feed.epoch === epoch) feed.hydratePromise = null;
    });
    return feed.hydratePromise;
  }

  function getOrCreate(relayId, sessionId) {
    const key = keyFor(relayId, sessionId);
    let feed = feeds.get(key);
    if (!feed) {
      // Retire idle feeds first. Active feeds are owned by visible surfaces and
      // must never be silently evicted; fail honestly when every slot is live.
      if (feeds.size >= maxFeeds) {
        for (const candidate of [...feeds.values()]) {
          if (feeds.size < maxFeeds) break;
          if (candidate.subscribers.size === 0) removeFeed(candidate);
        }
      }
      if (feeds.size >= maxFeeds) {
        throw Object.assign(new Error("Too many active Work feeds"), { code: "WORK_TOO_MANY_FEEDS" });
      }
      feed = {
        key,
        relayId: cleanId(relayId, "relayId"),
        sessionId: cleanId(sessionId, "sessionId"),
        provider: null,
        state: createState({ relayId, sessionId }),
        hydrated: false,
        hydratePromise: null,
        pending: [],
        needsRehydrate: false,
        nativeUnsubscribe: null,
        nativeDetached: false,
        subscribers: new Map(),
        revision: 0,
        epoch: 1,
        lastError: null,
        lastUsedAt: now(),
      };
      feeds.set(key, feed);
      evict();
    }
    touch(feed);
    return feed;
  }

  async function subscribe({ relayId, sessionId, subscriberId, send, isAlive = defaultAlive }) {
    if (typeof send !== "function") throw new TypeError("send must be a function");
    if (typeof isAlive !== "function") throw new TypeError("isAlive must be a function");
    const id = cleanId(subscriberId, "subscriberId");
    const feed = getOrCreate(relayId, sessionId);
    if (!feed.subscribers.has(id) && feed.subscribers.size >= maxSubscribers) {
      throw Object.assign(new Error("Too many Work subscribers"), { code: "WORK_TOO_MANY_SUBSCRIBERS" });
    }
    feed.subscribers.set(id, { send, isAlive });
    try {
      attachNative(feed); // subscribe first: hydration cannot open an event gap
      if (feed.hydrated) send(makeEnvelope(feed));
      else await hydrateFeed(feed);
    } catch (error) {
      // The caller never received an unsubscribe handle. Retire its provisional
      // registration here so failed hydration cannot leak a native listener.
      feed.subscribers.delete(id);
      suspendIdleFeed(feed);
      throw error;
    }
    return () => unsubscribe({ relayId, sessionId, subscriberId: id });
  }

  function unsubscribe({ relayId, sessionId, subscriberId }) {
    const feed = feeds.get(keyFor(relayId, sessionId));
    if (!feed) return false;
    const removed = feed.subscribers.delete(String(subscriberId || ""));
    suspendIdleFeed(feed);
    return removed;
  }

  async function reconnect({ relayId, sessionId }) {
    const feed = getOrCreate(relayId, sessionId);
    stopNative(feed);
    feed.epoch += 1;
    feed.hydrated = false;
    feed.hydratePromise = null;
    feed.pending.length = 0;
    feed.needsRehydrate = false;
    attachNative(feed);
    return hydrateFeed(feed);
  }

  async function itemDetail({ relayId, sessionId, subscriberId, turnId = "", itemId }) {
    if (typeof presentItemDetail !== "function") return { ok: false, error: "Detail is unavailable." };
    const feed = feeds.get(keyFor(relayId, sessionId));
    const subscriber = feed?.subscribers.get(String(subscriberId || ""));
    if (!feed || !subscriber || !subscriber.isAlive()) return { ok: false, error: "Not subscribed." };
    if (authorizeDetail && !await authorizeDetail({ relayId: feed.relayId, sessionId: feed.sessionId, subscriberId, turnId, itemId })) {
      return { ok: false, error: "Not authorized." };
    }
    const detail = rendererSafeClone(await presentItemDetail(feed.state, cleanId(itemId, "itemId"), { turnId: String(turnId || "") }));
    const payload = { ok: true, relayId: feed.relayId, sessionId: feed.sessionId, turnId: String(turnId || ""), itemId: String(itemId), revision: feed.revision, detail };
    if (byteLength(payload) > maxEnvelopeBytes) return { ok: false, error: "Detail is too large." };
    return payload;
  }

  async function attachment({
    relayId,
    sessionId,
    subscriberId,
    turnId = "",
    itemId,
    attachmentId = "",
    attachmentIndex = -1,
  }) {
    if (typeof presentAttachment !== "function") return { ok: false, error: "Attachment preview is unavailable." };
    const feed = feeds.get(keyFor(relayId, sessionId));
    const subscriber = feed?.subscribers.get(String(subscriberId || ""));
    if (!feed || !subscriber || !subscriber.isAlive()) return { ok: false, error: "Not subscribed." };
    const resolved = await presentAttachment(feed.state, cleanId(itemId, "itemId"), {
      turnId: String(turnId || ""),
      attachmentId: String(attachmentId || ""),
      attachmentIndex: Number.isInteger(attachmentIndex) ? attachmentIndex : -1,
    });
    if (!resolved) return { ok: false, error: "Attachment is not part of this Work item." };
    const payload = {
      ok: true,
      relayId: feed.relayId,
      sessionId: feed.sessionId,
      turnId: String(turnId || ""),
      itemId: String(itemId),
      revision: feed.revision,
      ...rendererSafeClone(resolved),
    };
    if (byteLength(payload) > maxEnvelopeBytes) return { ok: false, error: "Attachment preview is too large." };
    return payload;
  }

  function close() {
    for (const feed of [...feeds.values()]) removeFeed(feed);
  }

  return {
    subscribe,
    unsubscribe,
    reconnect,
    itemDetail,
    attachment,
    close,
    stats: () => [...feeds.values()].map((feed) => ({
      relayId: feed.relayId,
      sessionId: feed.sessionId,
      revision: feed.revision,
      hydrated: feed.hydrated,
      pending: feed.pending.length,
      subscribers: feed.subscribers.size,
      nativeAttached: Boolean(feed.nativeUnsubscribe),
    })),
  };
}

function canonicalItemDetail(state, requestedId, { turnId: requestedTurnId = "" } = {}) {
  const itemId = String(requestedId || "");
  for (const turnId of state?.turnOrder || []) {
    if (requestedTurnId && turnId !== requestedTurnId) continue;
    const turn = state.turns?.[turnId];
    const item = turn?.items?.[itemId];
    if (!item) continue;
    if (item.type === "reasoning") {
      // Private chain of thought is never a renderer detail. The reducer's
      // short provider-authored summary is already present in the overview.
      return { id: itemId, type: "reasoning", available: false };
    }
    const activity = normalizeActivity(item);
    const raw = item.raw || {};
    const tool = String(raw.tool || raw.name || activity?.tool || "").replace(/^mcp__.*?__/, "");
    const jsArguments = tool === "js" && raw.arguments && typeof raw.arguments === "object"
      ? raw.arguments
      : tool === "js" && raw.input && typeof raw.input === "object" ? raw.input : null;
    const command = item.type === "commandExecution"
      ? String(raw.command || raw.action?.command || raw.action?.cmd || "")
      : "";
    return {
      id: itemId,
      turnId,
      type: String(item.type || "activity"),
      status: String(item.status || ""),
      ...(activity ? { activity } : {}),
      ...(jsArguments ? {
        execution: {
          title: String(jsArguments.title || raw.title || "JavaScript"),
          script: String(jsArguments.code || ""),
          result: item.result ?? null,
        },
      } : {}),
      ...(item.type === "commandExecution" ? {
        execution: {
          title: String(activity?.fullObject || activity?.object || "Command"),
          command,
          transcript: String(item.output || ""),
        },
      } : {}),
      ...(item.type === "fileChange" ? {
        changes: (item.raw?.changes || []).slice(0, 200).map((change) => ({
          path: String(change?.path || change?.filePath || ""),
          kind: String(change?.kind || change?.type || ""),
        })),
      } : {}),
    };
  }
  return null;
}

function attachmentCandidates(raw) {
  const direct = Array.isArray(raw?.attachments) ? raw.attachments : [];
  const blocks = Array.isArray(raw?.content)
    ? raw.content.filter((entry) => entry && /image|file|attachment/i.test(String(entry.type || "")))
    : [];
  return [...direct, ...blocks].slice(0, 20);
}

/**
 * Resolve a renderer selector against the exact canonical reducer item. Paths,
 * URLs and hashes are taken only from main-process state; no renderer-supplied
 * source string participates in this lookup.
 */
export function canonicalAttachmentReference(state, requestedItemId, {
  turnId: requestedTurnId = "",
  attachmentId: requestedAttachmentId = "",
  attachmentIndex = -1,
} = {}) {
  const itemId = String(requestedItemId || "");
  const wantedAttachmentId = String(requestedAttachmentId || "");
  for (const turnId of state?.turnOrder || []) {
    if (requestedTurnId && turnId !== requestedTurnId) continue;
    const item = state.turns?.[turnId]?.items?.[itemId];
    if (!item) continue;
    const candidates = attachmentCandidates(item.raw);
    const candidate = Number.isInteger(attachmentIndex) && attachmentIndex >= 0
      ? candidates[attachmentIndex]
      : candidates.find((entry, index) => String(entry?.id || entry?.attachmentId || `${itemId}:${index}`) === wantedAttachmentId);
    if (!candidate || typeof candidate !== "object") return null;
    const canonicalId = String(candidate.id || candidate.attachmentId || `${itemId}:${candidates.indexOf(candidate)}`);
    if (wantedAttachmentId && canonicalId !== wantedAttachmentId) return null;
    const sourcePath = String(candidate.localPath || candidate.path || candidate.filePath || "").trim();
    const sourceUrl = String(candidate.url || candidate.image_url || candidate.file_url || "").trim();
    const sha256 = String(candidate.sha256 || candidate.digest || "").replace(/^sha256:/i, "").trim();
    const size = Number(candidate.size ?? candidate.bytes);
    return {
      id: canonicalId,
      path: sourcePath,
      url: /^https:\/\//i.test(sourceUrl) ? sourceUrl : "",
      name: String(candidate.name || candidate.fileName || candidate.filename || "Image"),
      mimeType: String(candidate.mimeType || candidate.contentType || candidate.mediaType || ""),
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
      sha256,
    };
  }
  return null;
}

/** Canonical provider-native Work composition used by Request Work and AI Preview. */
export function createCanonicalWorkPushBridge({ hydrate, subscribeNative, authorizeDetail, ...limits } = {}) {
  return createWorkPushBridge({
    ...limits,
    hydrate: async (identity) => {
      const value = normalizeHydration(await hydrate(identity));
      return {
        state: value.state ? hydrateWorkConversation(value.state) : createWorkConversation({
          provider: value.provider || identity.provider || "codex",
          sessionId: identity.sessionId,
        }),
        events: value.events,
        provider: value.provider || value.state?.provider || identity.provider || "codex",
      };
    },
    subscribeNative,
    authorizeDetail,
    createState: ({ sessionId, provider }) => createWorkConversation({ provider: provider || "codex", sessionId }),
    reduceEvent: reduceWorkEvent,
    present: (state, time) => workPresentationSnapshot(state, time),
    presentItemDetail: canonicalItemDetail,
    presentAttachment: limits.presentAttachment,
  });
}
