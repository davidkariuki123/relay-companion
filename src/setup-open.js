import { RelayClient } from "./client.js";
import { openRelay } from "./materializer.js";
import { stagePlainRelayItem } from "./notifications.js";

export function normalizeSetupHost(host) {
  const clean = String(host || "").trim().toLowerCase();
  return clean === "codex" ? "codex" : "claude";
}

export function setupOpenRelayToken(flags = {}) {
  return String(flags["open-relay"] || flags.openRelay || flags.relay || "").trim() || null;
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
