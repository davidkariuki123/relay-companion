import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { RelayClient } from "./client.js";
import { configDir } from "./config.js";
import { openRelay } from "./materializer.js";
import { stagePlainRelayItem } from "./notifications.js";

const { atomicWriteJsonSync } = createRequire(import.meta.url)("./atomic-json.cjs");
const PENDING_OPEN_VERSION = 1;

export function normalizeSetupHost(host) {
  const clean = String(host || "").trim().toLowerCase();
  return clean === "codex" ? "codex" : "claude";
}

export function setupOpenRelayToken(flags = {}) {
  return String(flags["open-relay"] || flags.openRelay || flags.relay || "").trim() || null;
}

export function pendingSetupOpenPath({ directory = configDir() } = {}) {
  return path.join(directory, "pending-open.json");
}

/**
 * Keep a first-run Relay intent across installation and account approval. The
 * bearer token is never passed to the renderer or written to config.json; this
 * owner-only file is removed only after an authenticated bind succeeds.
 */
export function persistPendingSetupOpen({ token, host = "claude", directory } = {}) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return null;
  const pending = {
    version: PENDING_OPEN_VERSION,
    token: cleanToken,
    host: normalizeSetupHost(host),
    createdAt: new Date().toISOString(),
  };
  atomicWriteJsonSync(pendingSetupOpenPath({ ...(directory ? { directory } : {}) }), pending, { mode: 0o600 });
  return pending;
}

export function readPendingSetupOpen({ directory } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(pendingSetupOpenPath({ ...(directory ? { directory } : {}) }), "utf8"));
    if (value?.version !== PENDING_OPEN_VERSION || typeof value.token !== "string" || !value.token.trim()) return null;
    return {
      version: PENDING_OPEN_VERSION,
      token: value.token.trim(),
      host: normalizeSetupHost(value.host),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    };
  } catch {
    return null;
  }
}

export function clearPendingSetupOpen({ directory } = {}) {
  try {
    fs.rmSync(pendingSetupOpenPath({ ...(directory ? { directory } : {}) }));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Public, read-only projection for the signed-out first-run surface. */
export async function pendingSetupOpenPreview({
  pending = readPendingSetupOpen(),
  client = new RelayClient(),
} = {}) {
  if (!pending?.token) return null;
  const [opened, fetched] = await Promise.all([
    client.openRelay(pending.token),
    client.openRelayPacket(pending.token),
  ]);
  const relay = opened?.relay || {};
  const packet = fetched?.packet || {};
  return {
    host: normalizeSetupHost(pending.host),
    relayId: String(relay.relayId || packet.relayId || packet.id || ""),
    title: String(relay.title || packet.title || "A Relay for you"),
    forHuman: String(relay.forHuman || packet.forHuman || relay.preview || ""),
    forAgent: String(relay.forAgent || packet.forAgent || ""),
    sender: {
      name: String(relay.sender?.name || packet.sender?.name || "Someone"),
      email: String(relay.sender?.email || packet.sender?.email || ""),
    },
    recipientEmail: String(relay.recipientEmail || packet.recipient?.email || ""),
    hasAttachments: Boolean((relay.attachments || packet.attachments || []).length),
  };
}

/** Bootstrap owns the exact-runtime service handoff. Pairing may update account
 * state inside that handoff, but must not wake the previous runtime before the
 * candidate has installed its registrations and is ready to take ownership. */
export function setupPairFlags(flags = {}, bootstrapActivated = process.env.RELAY_BOOTSTRAP_ACTIVATED === "1") {
  return bootstrapActivated ? { ...flags, "no-restart": true } : flags;
}

export function setupOpenStatus(opened, openUrlFn = () => false) {
  if (!opened) return { opened: false, fallbackAttempted: false, url: null };
  if (opened.openedInHost || opened.skipExternalOpen) {
    return { opened: true, fallbackAttempted: false, url: opened.url || null };
  }
  if (!opened.url) return { opened: false, fallbackAttempted: false, url: null };
  return { opened: Boolean(openUrlFn(opened.url)), fallbackAttempted: true, url: opened.url };
}


function inboxItemFromOpenRelay(relay) {
  return {
    relayId: relay.relayId,
    state: "delivered",
    createdAt: relay.createdAt,
    updatedAt: relay.createdAt,
    kind: relay.kind,
    title: relay.title,
    displayTitle: relay.title,
    sender: relay.sender,
    preview: relay.preview,
    hasAttachments: Boolean(relay.attachments?.length),
  };
}

export async function stageCurrentInbox({ client = new RelayClient(), stage = stagePlainRelayItem, forceUnread = false, log = () => {} } = {}) {
  const inbox = await client.inbox();
  const staged = [];
  for (const item of inbox.items || []) {
    try {
      const fetched = await client.fetchRelay(item.relayId);
      stage({ item, packet: fetched.packet, attachmentUrls: fetched.attachmentUrls || {} }, { forceUnread });
      staged.push(item.relayId);
    } catch (error) {
      log(`could not stage relay ${item.relayId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return staged;
}

export async function finishSetupOpenRelay({
  token,
  host = "claude",
  client = new RelayClient(),
  stage = stagePlainRelayItem,
  openRelayFn = openRelay,
  log = () => {},
} = {}) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return null;

  const bound = await client.bindOpenRelay(cleanToken);
  const relay = bound?.relay;
  if (!relay?.relayId) {
    throw new Error("Relay setup paired this device, but the relay link could not be attached to the account.");
  }

  const stagedIds = await stageCurrentInbox({ client, stage, forceUnread: true, log });
  if (!stagedIds.includes(relay.relayId)) {
    const fetched = await client.fetchRelay(relay.relayId);
    stage({
      item: inboxItemFromOpenRelay(relay),
      packet: fetched.packet,
      attachmentUrls: fetched.attachmentUrls || {},
    }, { forceUnread: true });
  }

  const result = await openRelayFn({ id: relay.relayId, host: normalizeSetupHost(host), log });
  return { relayId: relay.relayId, staged: true, opened: result };
}

export async function finishPendingSetupOpenRelay({ pending = readPendingSetupOpen(), directory, ...options } = {}) {
  if (!pending?.token) return null;
  const result = await finishSetupOpenRelay({ token: pending.token, host: pending.host, ...options });
  clearPendingSetupOpen({ ...(directory ? { directory } : {}) });
  return result;
}
