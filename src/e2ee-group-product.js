import { createHash } from "node:crypto";
import {
  createE2eeGroupBootstrap,
  sendE2eeGroupEvent,
  shareE2eeGroupHistory,
  syncE2eeGroupEvents,
  syncE2eeGroupHistoryArchives,
  syncE2eeGroupWelcomes,
  syncE2eeGroupEpochUpdates,
  updateE2eeGroupMembership,
} from "./e2ee-groups.js";
import {
  attachmentInputs,
  attachmentRequestBindings,
  cacheE2eeAttachmentInputs,
  decryptAttachmentMetadata,
  encryptAttachments,
  ensureE2eeKeyPackages,
  identityOrThrow,
  materializeE2eeAttachments,
} from "./e2ee-mls.js";
import {
  readEncryptedGroupState,
  readPendingGroupOutbox,
  readProcessedGroupEvent,
  readProcessedGroupEvents,
  removeLocalE2eeAttachmentDirectory,
  removeProcessedGroupEvent,
  removeEncryptedGroupState,
} from "./e2ee-state.js";

const PRODUCT_MESSAGE = "relay.message";
const PRODUCT_EDIT = "relay.edited";
const PRODUCT_DELETE = "relay.deleted";
const PRODUCT_REACTION = "relay.reaction";
const PRODUCT_RECEIPT = "relay.receipt";

async function groupView(client, groupId) {
  const groups = (await client.groups()).groups || [];
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new Error("That encrypted group is not visible to this account.");
  if (group.archivedAt) throw new Error("That group is archived and cannot receive new messages.");
  return group;
}

/** Bootstrap once, then converge the local MLS epoch to the visible roster. */
export async function ensureE2eeGroupProductReady(client, groupId, idempotencyKey) {
  const identity = identityOrThrow();
  await ensureE2eeKeyPackages(client);
  await syncE2eeGroupWelcomes(client);
  await syncE2eeGroupEpochUpdates(client);
  let local = readEncryptedGroupState(identity, groupId);
  if (!local) {
    try {
      const preparation = await client.e2eePrepareGroup({
        groupId,
        idempotencyKey: `${idempotencyKey}:prepare`,
      });
      const bootstrap = await createE2eeGroupBootstrap(client, preparation);
      await client.e2eeBootstrapGroup({
        preparationId: bootstrap.preparationId,
        groupId: bootstrap.groupId,
        membershipRevision: bootstrap.membershipRevision,
        epoch: bootstrap.epoch,
        welcome: bootstrap.welcome,
        ratchetTree: bootstrap.ratchetTree,
        senderCheckpoint: bootstrap.senderCheckpoint,
        idempotencyKey: `${idempotencyKey}:bootstrap`,
      });
      local = readEncryptedGroupState(identity, groupId);
    } catch (error) {
      if (error?.body?.error !== "group_already_exists") throw error;
      // Another device won bootstrap. Its Welcome is the only safe state to
      // keep; a locally-created losing branch must never be used for sends.
      removeEncryptedGroupState(identity, groupId);
      await syncE2eeGroupWelcomes(client);
      local = readEncryptedGroupState(identity, groupId);
      if (!local) throw new Error("Another device created this encrypted group. Bring that device online once so this device can join.");
    }
  }
  let transition = null;
  try {
    transition = await updateE2eeGroupMembership(client, {
      groupId,
      idempotencyKey: `${idempotencyKey}:roster`,
    });
  } catch (error) {
    if (error?.body?.error !== "group_current") throw error;
  }
  if (transition?.addedDeviceIds?.length) {
    await shareE2eeGroupHistory(client, {
      groupId,
      recipientDeviceIds: transition.addedDeviceIds,
      idempotencyKey: `${idempotencyKey}:history`,
    });
  }
  return readEncryptedGroupState(identity, groupId);
}

function cleanSource(source) {
  if (!source) return undefined;
  const { cwd: _cwd, threadId: _threadId, authKind: _auth, clientVersion: _version, sendContract: _contract, ...safe } = source;
  return Object.keys(safe).length ? safe : undefined;
}

export async function sendE2eeGroupRelay(client, payload) {
  const groupId = String(payload.recipient?.groupId || payload.recipient?.chatId || "");
  if (!groupId.startsWith("grp_")) throw new Error("Encrypted group sends require a saved group id.");
  if ((payload.files || []).length) throw new Error("Encrypted file paths must be prepared locally before sending.");
  const group = await groupView(client, groupId);
  const local = await ensureE2eeGroupProductReady(client, groupId, payload.idempotencyKey);
  if (!local) throw new Error("This device could not establish the encrypted group.");
  const identity = identityOrThrow();
  const eventId = `egmsg_${createHash("sha256")
    .update("relay-e2ee-group-message-id-v1")
    .update(groupId)
    .update(identity.deviceId)
    .update(String(payload.idempotencyKey || ""))
    .digest("base64url")}`;
  const cached = readProcessedGroupEvent(identity, groupId, eventId);
  const pending = readPendingGroupOutbox(identity, groupId, eventId);
  if (cached && pending) {
    const replay = await sendE2eeGroupEvent(client, {
      eventId,
      groupId,
      membershipRevision: cached.membershipRevision,
      type: cached.type,
      body: cached.body,
      ...(cached.conversation?.replyToMessageId ? { replyToMessageId: cached.conversation.replyToMessageId } : {}),
      attachments: pending.wire.attachments || [],
      historyImport: payload.historyImport === true,
      idempotencyKey: payload.idempotencyKey,
    });
    return groupSendResponse(group, payload, replay);
  }
  const inputs = attachmentInputs(payload);
  const attachmentEnvelopes = encryptAttachments(eventId, inputs);
  const attachmentKeys = attachmentEnvelopes.map((attachment) => attachment.key);
  const attachmentWires = attachmentEnvelopes.map((attachment) => attachment.wire);
  const sent = await sendE2eeGroupEvent(client, {
    eventId,
    groupId,
    membershipRevision: local.membershipRevision,
    type: PRODUCT_MESSAGE,
    body: {
      version: 1,
      kind: payload.kind || "message",
      ...(payload.type ? { relayType: payload.type } : {}),
      ...(String(payload.title || "").trim() ? { title: String(payload.title).trim() } : {}),
      forHuman: String(payload.forHuman || ""),
      forAgent: String(payload.forAgent || ""),
      targetSurfaces: [...(payload.targetSurfaces || [])],
      ...(cleanSource(payload.source) ? { source: cleanSource(payload.source) } : {}),
      attachments: attachmentKeys,
      attachmentBindings: attachmentRequestBindings(inputs),
      ...(payload.historyImport && payload.historyImportEdited ? { historyImportEdited: true } : {}),
      ...(payload.historyImport && payload.historyImportDeleted ? { historyImportDeleted: true } : {}),
    },
    attachments: attachmentWires,
    historyImport: payload.historyImport === true,
    ...(payload.inReplyToRelayId ? { replyToMessageId: payload.inReplyToRelayId } : {}),
    idempotencyKey: payload.idempotencyKey,
  });
  const metadata = decryptAttachmentMetadata(eventId, attachmentKeys, attachmentWires);
  cacheE2eeAttachmentInputs(eventId, inputs, metadata);
  return groupSendResponse(group, payload, sent);
}

function groupSendResponse(group, payload, sent) {
  return {
    relayId: sent.eventId,
    state: "delivered",
    deliveredVia: "device",
    recipient: { name: group.name, onRelay: true },
    attachments: (payload.attachments || []).map(({ contentBase64: _content, ...attachment }) => attachment),
    uploads: [],
    ...(payload.inReplyToRelayId ? { inReplyToRelayId: payload.inReplyToRelayId } : {}),
    threadId: payload.inReplyToRelayId || sent.eventId,
    groupSendId: sent.eventId,
    groupRecipients: group.members.map((member) => ({
      relayId: sent.eventId,
      state: "delivered",
      recipient: { name: member.name, email: member.email, onRelay: member.onRelay },
    })),
  };
}

export async function sendE2eeGroupChange(client, targetEventId, type, body, idempotencyKey) {
  const records = await e2eeGroupOpenedRecords(client);
  const target = records.find((record) => record.eventId === targetEventId);
  if (!target) throw new Error("Encrypted group message not found on this device.");
  const local = readEncryptedGroupState(identityOrThrow(), target.groupId);
  if (!local) throw new Error("This device has not joined that encrypted group.");
  return sendE2eeGroupEvent(client, {
    groupId: target.groupId,
    membershipRevision: local.membershipRevision,
    type,
    messageId: targetEventId,
    threadId: target.plaintext.conversation?.threadId || targetEventId,
    body,
    idempotencyKey,
  });
}

export async function syncE2eeGroupProduct(client) {
  await ensureE2eeKeyPackages(client);
  await syncE2eeGroupEvents(client);
  await syncE2eeGroupHistoryArchives(client);
  const identity = identityOrThrow();
  let records = readProcessedGroupEvents(identity);
  for (const record of records) {
    if (record.plaintext?.type !== PRODUCT_DELETE) continue;
    removeProcessedGroupEvent(identity, record.groupId, record.plaintext.messageId);
    removeLocalE2eeAttachmentDirectory(record.plaintext.messageId);
  }
  records = readProcessedGroupEvents(identity);
  return records.map((record) => {
    if (record.plaintext?.type !== PRODUCT_MESSAGE || !record.wire) return record;
    const keys = record.plaintext.body?.attachments || [];
    const attachments = record.wire.attachments || [];
    return {
      ...record,
      plaintext: {
        ...record.plaintext,
        body: {
          ...record.plaintext.body,
          attachmentMetadata: decryptAttachmentMetadata(record.eventId, keys, attachments),
        },
      },
    };
  });
}

function project(records, identity) {
  const ordered = [...records].sort((a, b) =>
    String(a.plaintext?.authoredAt).localeCompare(String(b.plaintext?.authoredAt)) || a.eventId.localeCompare(b.eventId));
  const messages = new Map();
  const receipts = new Map();
  for (const record of ordered) {
    const { plaintext } = record;
    if (plaintext?.type === PRODUCT_MESSAGE && plaintext.body?.version === 1) {
      messages.set(plaintext.messageId, {
        ...record,
        body: { ...plaintext.body },
        updatedAt: plaintext.authoredAt,
        editedAt: plaintext.body.historyImportEdited ? plaintext.authoredAt : null,
        deletedAt: plaintext.body.historyImportDeleted ? plaintext.authoredAt : null,
        reactions: new Map(),
      });
      continue;
    }
    const target = messages.get(plaintext?.messageId);
    if (!target) continue;
    if (plaintext.type === PRODUCT_EDIT && plaintext.senderUserId === target.plaintext.senderUserId) {
      if (plaintext.body?.forHuman !== undefined) target.body.forHuman = String(plaintext.body.forHuman || "");
      if (plaintext.body?.forAgent !== undefined) target.body.forAgent = String(plaintext.body.forAgent || "");
      target.editedAt = plaintext.authoredAt;
      target.updatedAt = plaintext.authoredAt;
    } else if (plaintext.type === PRODUCT_DELETE && plaintext.senderUserId === target.plaintext.senderUserId) {
      target.deletedAt = plaintext.authoredAt;
      target.updatedAt = plaintext.authoredAt;
    } else if (plaintext.type === PRODUCT_REACTION) {
      const emoji = String(plaintext.body?.emoji || "");
      const key = `${plaintext.senderUserId}\n${emoji}`;
      if (plaintext.body?.action === "add") target.reactions.set(key, { emoji, senderUserId: plaintext.senderUserId });
      else target.reactions.delete(key);
    } else if (plaintext.type === PRODUCT_RECEIPT) {
      const current = receipts.get(plaintext.messageId) || new Map();
      current.set(plaintext.senderUserId, { state: plaintext.body?.state, at: plaintext.authoredAt });
      receipts.set(plaintext.messageId, current);
    }
  }
  return [...messages.values()].map((message) => {
    const inbound = message.plaintext.senderUserId !== identity.userId;
    const ownReceipt = receipts.get(message.eventId)?.get(identity.userId);
    const aggregates = new Map();
    for (const reaction of message.reactions.values()) {
      const aggregate = aggregates.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, reactedByMe: false, actors: [] };
      aggregate.count += 1;
      aggregate.reactedByMe ||= reaction.senderUserId === identity.userId;
      aggregate.actors.push({ relayUserId: reaction.senderUserId, name: reaction.senderUserId === identity.userId ? "You" : "Group member", self: reaction.senderUserId === identity.userId });
      aggregates.set(reaction.emoji, aggregate);
    }
    const readReceipts = inbound ? [] : [...(receipts.get(message.eventId)?.entries() || [])]
      .filter(([userId, receipt]) => userId !== identity.userId && receipt.state === "read")
      .map(([userId, receipt]) => ({ name: userId, seen: true, readAt: receipt.at }));
    const item = {
      relayId: message.eventId,
      state: message.plaintext.historyImport ? "acknowledged" : ownReceipt?.state === "read" ? "read" : "delivered",
      createdAt: message.plaintext.authoredAt,
      updatedAt: message.updatedAt,
      ...(message.editedAt ? { editedAt: message.editedAt } : {}),
      ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
      kind: message.body.kind || "message",
      ...(message.body.title ? { title: message.body.title, displayTitle: message.body.title } : {}),
      sender: message.wire?.sender || { relayUserId: message.plaintext.senderUserId, name: inbound ? "Group member" : "You" },
      preview: message.deletedAt ? "Message deleted" : message.body.forHuman,
      forHuman: message.deletedAt ? "Message deleted" : message.body.forHuman,
      forAgent: message.body.forAgent || "",
      ...(message.body.source ? { source: message.body.source } : {}),
      ...(message.body.relayType ? { type: message.body.relayType } : {}),
      ...(message.plaintext.conversation?.replyToMessageId ? { inReplyToRelayId: message.plaintext.conversation.replyToMessageId } : {}),
      threadId: message.plaintext.conversation?.threadId || message.eventId,
      groupSendId: message.eventId,
      hasAttachments: (message.body.attachmentMetadata || []).length > 0,
      attachments: (message.body.attachmentMetadata || []).map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        bytes: attachment.bytes,
        sha256: attachment.sha256,
        openUrl: attachment.downloadUrl || `relay-e2ee://attachment/${message.eventId}/${attachment.id}`,
      })),
      reactions: { aggregates: [...aggregates.values()], events: [] },
      direction: inbound ? "inbound" : "outbound",
      ...(message.plaintext.historyImport ? { historyImported: true } : {}),
      readReceipts,
      e2ee: { protocol: "mls10", cipherSuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", senderDeviceId: message.plaintext.senderDeviceId },
    };
    return { ...message, item };
  });
}

export async function e2eeGroupOpenedRecords(client) {
  const identity = identityOrThrow();
  return project(await syncE2eeGroupProduct(client), identity);
}

function participantId(value) {
  return `e2eeparty_${createHash("sha256").update(`relay-e2ee-chat-participant-v1${value}`).digest("hex").slice(0, 24)}`;
}

export async function e2eeGroupChats(client) {
  const identity = identityOrThrow();
  const [records, response] = await Promise.all([e2eeGroupOpenedRecords(client), client.groups()]);
  const groups = response.groups || [];
  return groups.map((group) => {
    const messages = records.filter((record) => record.groupId === group.id)
      .sort((a, b) => String(a.item.createdAt).localeCompare(String(b.item.createdAt)));
    const newest = messages.at(-1)?.item;
    const participants = [
      { id: participantId(identity.userId), name: "You", self: true },
      ...(group.owner && group.owner.userId !== identity.userId
        ? [{ id: participantId(group.owner.userId), name: group.owner.name || "Group owner", self: false }]
        : []),
      ...group.members
        .filter((member) => member.email !== group.owner?.email)
        .map((member) => ({ id: participantId(member.contactId), name: member.name, self: false })),
    ];
    return {
      chatId: group.id,
      title: group.name,
      kind: "group",
      participants,
      group: {
        groupId: group.id,
        name: group.name,
        owned: Boolean(group.owned),
        archived: Boolean(group.archivedAt),
        membershipStatus: group.owned ? "owner" : "active",
        canPost: !group.archivedAt,
      },
      threadIds: [...new Set(messages.map((record) => record.item.threadId || record.eventId))],
      messageCount: messages.length,
      unreadCount: messages.filter((record) => record.item.direction === "inbound" && record.item.state === "delivered").length,
      ...(newest ? { lastMessage: {
        relayId: newest.relayId,
        ...(newest.title ? { title: newest.title } : {}),
        preview: newest.preview,
        senderName: newest.direction === "outbound" ? "You" : newest.sender.name,
        createdAt: newest.createdAt,
        direction: newest.direction,
      } } : {}),
      updatedAt: newest?.createdAt || group.updatedAt || group.createdAt,
      items: messages.map((record) => record.item),
      hasMoreMessages: false,
    };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function e2eeGroupChat(client, groupId) {
  return (await e2eeGroupChats(client)).find((chat) => chat.chatId === groupId);
}

export async function e2eeGroupChatForThread(client, threadId) {
  return (await e2eeGroupChats(client)).find((chat) =>
    chat.items.some((item) => item.threadId === threadId || item.relayId === threadId));
}

export async function e2eeGroupPacket(record, groupName = "Relay group") {
  const materialized = await materializeE2eeAttachments(record.eventId, record.body.attachmentMetadata || []);
  return {
    packet: {
      schemaVersion: 3,
      id: record.eventId,
      relayId: record.eventId,
      createdAt: record.item.createdAt,
      kind: record.item.kind,
      ...(record.item.type ? { type: record.item.type } : {}),
      ...(record.item.title ? { title: record.item.title, displayTitle: record.item.title } : {}),
      forHuman: record.item.forHuman,
      forAgent: record.item.forAgent,
      source: record.item.source || { host: "relay-companion" },
      targetSurfaces: record.body.targetSurfaces || [],
      sender: record.item.sender,
      recipient: { name: groupName },
      ...(record.item.inReplyToRelayId ? { inReplyToRelayId: record.item.inReplyToRelayId } : {}),
      threadId: record.item.threadId,
      groupSendId: record.eventId,
      reactions: record.item.reactions,
      attachments: materialized,
      e2ee: record.item.e2ee,
      ...(record.item.historyImported ? { historyImported: true } : {}),
    },
    attachmentUrls: {},
  };
}

export const E2EE_GROUP_PRODUCT_EVENTS = {
  edit: PRODUCT_EDIT,
  delete: PRODUCT_DELETE,
  reaction: PRODUCT_REACTION,
  receipt: PRODUCT_RECEIPT,
};
