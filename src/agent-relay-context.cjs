"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = "recent-relay-context";
const SNAPSHOT_FILE = "inbox.json";
const TOPICS_FILE = "topics.json";
const TOPIC_MANDATE_MAX = 600;
const CONTEXT_MAX_ITEMS = 12;
const INDEX_MAX_ITEMS = 50;
const INDEX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 15_000;
// Recipient-visible delivery states, per shared/src/packet.ts RelayState. Both
// "read" and "acknowledged" mean the human has seen it; a naive equality test
// against "read" alone would report an acknowledged relay as unread.
const READ_STATES = new Set(["read", "acknowledged"]);
const KNOWN_STATES = new Set(["pending", "delivered", "read", "acknowledged"]);

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function scopeKey(accountScope) {
  const raw = String(accountScope || "").trim();
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : "";
}

function scopeDir(homeDir, accountScope) {
  const key = scopeKey(accountScope);
  return key ? path.join(homeDir, ROOT_DIR, key) : "";
}

function snapshotPath(homeDir, accountScope) {
  const dir = scopeDir(homeDir, accountScope);
  return dir ? path.join(dir, SNAPSHOT_FILE) : "";
}

function topicsPath(homeDir, accountScope) {
  const dir = scopeDir(homeDir, accountScope);
  return dir ? path.join(dir, TOPICS_FILE) : "";
}

function normalizeMetadata(value, max = 180) {
  let text = String(value || "");
  try { text = text.normalize("NFKC"); } catch {}
  text = text
    // ANSI escape sequences and single-byte escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, " ")
    // C0/C1 controls, bidi controls, zero-width format controls, and BOM.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function cleanItem(item) {
  const relayId = normalizeMetadata(item?.relayId, 140);
  if (!/^relay_[0-9A-Za-z_-]+$/.test(relayId)) return null;
  const createdAt = normalizeMetadata(item?.availableAt || item?.createdAt, 50);
  const state = normalizeMetadata(item?.state, 24);
  const title = normalizeMetadata(item?.title, 180);
  // An untitled relay is a typed text: nobody authored a title, so its content
  // IS the record. The summary poll omits bodies but always carries preview.
  const text = normalizeMetadata(item?.preview || item?.forHuman, 180);
  return {
    relayId,
    ...(title ? { title } : text ? { message: text } : { title: "Untitled Relay" }),
    sender: normalizeMetadata(item?.sender?.name || item?.sender?.email || "Someone", 100),
    createdAt,
    kind: normalizeMetadata(item?.kind || "message", 24),
    // Server-authoritative read state, already on every InboxItem in the poll
    // response the daemon hands us. Without it an agent holding this block
    // cannot tell a relay read three days ago from one never opened, while the
    // block's framing ("arrived", "history") leans toward unread — so agents
    // inferred it and asserted the guess as fact (Sven, 2026-08-18). Resolving
    // it here rather than against the local notifications.js mirror is what
    // makes reads on web and iOS count. An unrecognized state omits the field
    // instead of guessing: claiming "unread" for an unknown is the same false
    // assertion, merely inverted.
    ...(KNOWN_STATES.has(state) ? { read: READ_STATES.has(state) } : {}),
    ...(item?.recipientGroupName ? { group: normalizeMetadata(item.recipientGroupName, 100) } : {}),
  };
}

function itemTime(item) {
  const parsed = Date.parse(item.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotComparable(snapshot) {
  return JSON.stringify({
    nextSequence: Number(snapshot?.nextSequence) || 1,
    recentCount: Number(snapshot?.recentCount) || 0,
    truncated: Boolean(snapshot?.truncated),
    items: Array.isArray(snapshot?.items) ? snapshot.items : [],
  });
}

/** Record a seven-day record index (titles, or full texts for untitled relays) from the daemon's existing human inbox poll. */
function recordAgentRelayIndex(homeDir, accountScope, response, { nowMs = Date.now() } = {}) {
  const file = snapshotPath(homeDir, accountScope);
  if (!file) return { changed: false, snapshot: null };
  const prior = readJson(file, { nextSequence: 1, items: [] });
  const priorById = new Map((prior.items || []).map((item) => [item.relayId, item]));
  const seen = new Set();
  let nextSequence = Number(prior.nextSequence) || 1;
  const cutoff = nowMs - INDEX_WINDOW_MS;
  const eligible = [];
  for (const raw of Array.isArray(response?.items) ? response.items : []) {
    const item = cleanItem(raw);
    if (!item || seen.has(item.relayId) || itemTime(item) < cutoff) continue;
    seen.add(item.relayId);
    eligible.push(item);
  }
  eligible.sort((a, b) => {
    const timeOrder = itemTime(b) - itemTime(a);
    if (timeOrder) return timeOrder;
    const sequenceOrder = Number(priorById.get(b.relayId)?.sequence || 0)
      - Number(priorById.get(a.relayId)?.sequence || 0);
    return sequenceOrder || a.relayId.localeCompare(b.relayId);
  });
  // Assign arrival sequence numbers only to rows retained in the bounded
  // index. Otherwise every omitted row would receive a fresh sequence on every
  // four-second poll and force an idle disk rewrite forever.
  const retained = eligible.slice(0, INDEX_MAX_ITEMS);
  const newSequences = new Map();
  for (const item of retained
    .filter((candidate) => !priorById.has(candidate.relayId))
    .sort((a, b) => itemTime(a) - itemTime(b) || a.relayId.localeCompare(b.relayId))) {
    newSequences.set(item.relayId, nextSequence++);
  }
  const items = retained.map((item) => {
    const existing = priorById.get(item.relayId);
    return { ...item, sequence: Number(existing?.sequence) || newSequences.get(item.relayId) };
  });
  const snapshot = {
    updatedAt: new Date(nowMs).toISOString(),
    nextSequence,
    recentCount: eligible.length,
    truncated: eligible.length > items.length,
    items,
  };
  if (snapshotComparable(prior) === snapshotComparable(snapshot)) {
    return { changed: false, snapshot: prior };
  }
  writeJsonAtomic(file, snapshot);
  return { changed: true, snapshot };
}

function topicStanding(topic) {
  const state = normalizeMetadata(topic?.membership?.state, 24);
  if (state === "invited") return "invited";
  if (state !== "active") return "";
  return topic?.membership?.mandateCurrent === true ? "current" : "paused";
}

function cleanTopic(topic) {
  const topicId = normalizeMetadata(topic?.id, 140);
  if (!/^tpc_[0-9A-Za-z_-]+$/.test(topicId)) return null;
  const standing = topicStanding(topic);
  if (!standing) return null;
  return {
    topicId,
    name: normalizeMetadata(topic?.name, 120) || "Untitled topic",
    standing,
    mandateVersion: Number(topic?.mandateVersion) || 1,
    mandate: normalizeMetadata(topic?.mandate, TOPIC_MANDATE_MAX),
    postCount: Math.max(0, Number(topic?.postCount) || 0),
    latestPostAt: normalizeMetadata(topic?.latestPostAt, 50),
  };
}

/**
 * Record the person's subscribed topics from the daemon's topics poll. Like the
 * title index it is account-scoped and skips byte-identical rewrites.
 */
function recordAgentTopicIndex(homeDir, accountScope, response, { nowMs = Date.now() } = {}) {
  const file = topicsPath(homeDir, accountScope);
  if (!file) return { changed: false, snapshot: null };
  const topics = [];
  const seen = new Set();
  for (const raw of Array.isArray(response?.topics) ? response.topics : []) {
    const topic = cleanTopic(raw);
    if (!topic || seen.has(topic.topicId)) continue;
    seen.add(topic.topicId);
    topics.push(topic);
  }
  topics.sort((a, b) => a.topicId.localeCompare(b.topicId));
  const prior = readJson(file, { topics: [] });
  const snapshot = { updatedAt: new Date(nowMs).toISOString(), topics };
  if (JSON.stringify(prior.topics || []) === JSON.stringify(topics)) return { changed: false, snapshot: prior };
  writeJsonAtomic(file, snapshot);
  return { changed: true, snapshot };
}

/**
 * The person's subscribed topics as the daemon last recorded them, for a
 * session using MCP check-ins. Empty when nothing was recorded.
 */
function readAgentTopicIndex(homeDir, accountScope) {
  const snapshot = readJson(topicsPath(homeDir, accountScope), null);
  // Records were cleaned by recordAgentTopicIndex when written; only their
  // shape is checked here.
  return (Array.isArray(snapshot?.topics) ? snapshot.topics : []).filter((topic) =>
    /^tpc_[0-9A-Za-z_-]+$/.test(String(topic?.topicId || "")) && ["current", "invited", "paused"].includes(topic?.standing));
}

// Retired hooks never claim or consume arrival records. MCP owns its own cursor.
function claimAgentRelayHookContext() { return null; }

module.exports = {
  CLAIM_LEASE_MS,
  CONTEXT_MAX_ITEMS,
  INDEX_MAX_ITEMS,
  claimAgentRelayHookContext,
  normalizeMetadata,
  recordAgentRelayIndex,
  readAgentTopicIndex,
  recordAgentTopicIndex,
  snapshotPath,
  topicsPath,
};
