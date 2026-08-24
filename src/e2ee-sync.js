import { createHash } from "node:crypto";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import { decryptE2eeWireMessage, e2eeThreadItem } from "./e2ee-mls.js";
import {
  readImportedE2eeHistory,
  removeCachedPlaintext,
  removeImportedE2eeHistoryRecord,
  removeLocalE2eeAttachmentDirectory,
  removePendingE2eeOutbox,
} from "./e2ee-state.js";

const { readPairedIdentity } = e2eeIdentityModule;

function directChatId(leftUserId, rightUserId) {
  const keys = [...new Set([`u:${leftUserId}`, `u:${rightUserId}`])].sort();
  const digest = createHash("sha256").update(keys.join("\n")).digest("hex");
  return `chat_${digest.slice(0, 24)}`;
}

function participantId(relayUserId) {
  return `e2eeparty_${createHash("sha256")
    .update("relay-e2ee-chat-participant-v1")
    .update(String(relayUserId))
    .digest("hex")
    .slice(0, 24)}`;
}

function authorizedTaskChange(change, root) {
  if (root.kind !== "task" || change.task?.taskId !== root.messageId) return false;
  const recipientStates = new Set(["accepted", "started", "completed", "failed", "declined"]);
  if (recipientStates.has(change.task.state)) return change.senderUserId === root.recipientUserId;
  if (change.task.state === "cancelled") return change.senderUserId === root.senderUserId;
  return false;
}

export async function e2eeOpenedRecords(client, wires) {
  const identity = readPairedIdentity();
  if (!identity) throw new Error("This Companion has no enrolled E2EE identity.");
  const byId = new Map();
  for (const imported of readImportedE2eeHistory(identity)) {
    byId.set(imported.wire.relayId, {
      ...imported,
      item: e2eeThreadItem(imported.wire, imported.plaintext),
      imported: true,
    });
  }
  for (const wire of wires || []) {
    const plaintext = await decryptE2eeWireMessage(client, wire);
    byId.set(wire.relayId, { wire, plaintext, item: e2eeThreadItem(wire, plaintext), imported: false });
  }
  const events = [...byId.values()].sort((left, right) =>
    String(left.plaintext.authoredAt).localeCompare(String(right.plaintext.authoredAt)) ||
    String(left.wire.relayId).localeCompare(String(right.wire.relayId)));
  const byMessage = new Map();
  for (const event of events) {
    const current = byMessage.get(event.plaintext.messageId) || [];
    current.push(event);
    byMessage.set(event.plaintext.messageId, current);
  }
  const opened = [];
  for (const messageEvents of byMessage.values()) {
    const created = messageEvents.find((entry) => entry.plaintext.eventType === "message.created");
    if (!created) continue;
    const root = created.plaintext;
    const projection = {
      ...root,
      createdAt: root.authoredAt,
      updatedAt: root.authoredAt,
      reactions: { aggregates: [], events: [] },
    };
    const activeReactions = new Map();
    const reactionHistory = [];
    for (const event of messageEvents) {
      const value = event.plaintext;
      if (value.eventId === root.eventId) continue;
      if (
        value.conversation?.conversationId !== root.conversation?.conversationId ||
        value.senderUserId !== root.senderUserId && value.senderUserId !== root.recipientUserId
      ) continue;
      if (value.eventType === "message.edited" && value.senderUserId === root.senderUserId) {
        projection.forHuman = value.forHuman;
        if (value.forAgent !== undefined) projection.forAgent = value.forAgent;
        if (value.title !== undefined) {
          if (value.title === null) delete projection.title;
          else projection.title = value.title;
        }
        projection.revision = Math.max(projection.revision, value.revision);
        projection.editedAt = value.editedAt;
        projection.updatedAt = value.editedAt;
      } else if (value.eventType === "message.deleted" && value.senderUserId === root.senderUserId) {
        projection.revision = Math.max(projection.revision, value.revision);
        projection.deletedAt = value.deletedAt;
        projection.updatedAt = value.deletedAt;
      } else if (value.eventType === "reaction.changed") {
        const key = `${value.senderUserId}\n${value.reaction.emoji}`;
        const reactionEvent = {
          id: value.eventId,
          relayId: root.messageId,
          actor: {
            relayUserId: value.senderUserId,
            name: event.wire.sender.name,
            self: value.senderUserId === identity.userId,
          },
          emoji: value.reaction.emoji,
          action: value.reaction.action,
          at: value.reaction.reactedAt,
        };
        reactionHistory.push(reactionEvent);
        if (value.reaction.action === "add") {
          activeReactions.set(key, reactionEvent);
        } else {
          activeReactions.delete(key);
        }
        projection.updatedAt = value.reaction.reactedAt;
      } else if (value.eventType === "receipt.changed") {
        if (value.senderUserId === root.recipientUserId) {
          projection.recipientReceiptState = value.receipt.state;
          if (value.receipt.state === "read") projection.recipientReadAt = value.receipt.occurredAt;
        }
        if (value.senderUserId === identity.userId) projection.localReceiptState = value.receipt.state;
      } else if (value.eventType === "task.changed") {
        if (!authorizedTaskChange(value, root)) continue;
        projection.task = value.task;
        projection.taskState = value.task.state;
        if (value.task.state === "accepted" && !projection.taskAcceptedAt) {
          projection.taskAcceptedAt = value.task.occurredAt;
        }
        if (["started", "completed"].includes(value.task.state) && !projection.taskStartedAt) {
          projection.taskStartedAt = value.task.occurredAt;
        }
        if (value.task.taskRunOwner && !projection.taskRunOwner) {
          projection.taskRunOwner = value.task.taskRunOwner;
        }
        if (value.task.state === "completed") projection.taskCompletedAt = value.task.occurredAt;
        projection.updatedAt = value.task.occurredAt;
      }
    }
    const reactionEvents = [...activeReactions.values()];
    const aggregateMap = new Map();
    for (const event of reactionEvents) {
      const aggregate = aggregateMap.get(event.emoji) || {
        emoji: event.emoji,
        count: 0,
        reactedByMe: false,
        actors: [],
      };
      aggregate.count += 1;
      aggregate.reactedByMe ||= event.actor.self;
      aggregate.actors.push(event.actor);
      aggregateMap.set(event.emoji, aggregate);
    }
    projection.reactions = { aggregates: [...aggregateMap.values()], events: reactionHistory };
    opened.push({ ...created, plaintext: projection, item: e2eeThreadItem(created.wire, projection) });
  }
  for (const event of events) {
    if (event.plaintext.eventType !== "message.deleted") continue;
    const messageId = event.plaintext.messageId;
    removeCachedPlaintext(identity, messageId);
    removeImportedE2eeHistoryRecord(identity, messageId);
    removePendingE2eeOutbox(identity, `direct:${messageId}`);
    removeLocalE2eeAttachmentDirectory(messageId);
  }
  // A provider's encrypted completion reply is also the Task's Done
  // receipt. Derive that relationship locally from authenticated participants
  // and reply metadata instead of sending a second server-readable task call.
  const projectedByMessageId = new Map(opened.map((entry) => [entry.plaintext.messageId, entry]));
  for (const result of opened) {
    if (result.plaintext.type !== "completion") continue;
    const target = projectedByMessageId.get(result.plaintext.conversation?.replyToMessageId);
    if (
      !target ||
      target.plaintext.kind !== "task" ||
      result.plaintext.senderUserId !== target.plaintext.recipientUserId ||
      result.plaintext.recipientUserId !== target.plaintext.senderUserId
    ) continue;
    target.plaintext.task = {
      taskId: target.plaintext.messageId,
      state: "completed",
      occurredAt: result.plaintext.authoredAt,
      resultMessageId: result.plaintext.messageId,
    };
    target.plaintext.taskState = "completed";
    target.plaintext.taskStartedAt ||= result.plaintext.authoredAt;
    target.plaintext.taskCompletedAt = result.plaintext.authoredAt;
    target.plaintext.updatedAt = result.plaintext.authoredAt;
    target.item = e2eeThreadItem(target.wire, target.plaintext);
  }
  opened.sort((left, right) =>
    String(left.plaintext.createdAt).localeCompare(String(right.plaintext.createdAt)) ||
    String(left.wire.relayId).localeCompare(String(right.wire.relayId)));
  return { identity, opened, events };
}

function buildChats(identity, opened) {
  const byChat = new Map();
  for (const message of opened) {
    const otherUserId = message.wire.sender.relayUserId === identity.userId
      ? message.wire.recipient.relayUserId
      : message.wire.sender.relayUserId;
    const otherName = message.wire.sender.relayUserId === identity.userId
      ? message.wire.recipient.name
      : message.wire.sender.name;
    const chatId = directChatId(identity.userId, otherUserId);
    const current = byChat.get(chatId) || { chatId, otherUserId, otherName, messages: [] };
    current.otherName = otherName || current.otherName;
    current.messages.push(message);
    byChat.set(chatId, current);
  }
  return [...byChat.values()].map((chat) => {
    chat.messages.sort((a, b) =>
      String(a.plaintext.createdAt).localeCompare(String(b.plaintext.createdAt)) ||
      String(a.wire.relayId).localeCompare(String(b.wire.relayId)));
    const newest = chat.messages.at(-1);
    const items = chat.messages.map((message) => message.item);
    return {
      chatId: chat.chatId,
      title: chat.otherName || "Relay user",
      kind: "direct",
      participants: [
        { id: participantId(identity.userId), name: "You", self: true },
        { id: participantId(chat.otherUserId), name: chat.otherName || "Relay user", self: false },
      ],
      threadIds: [...new Set(items.map((item) => item.threadId || item.relayId))],
      messageCount: items.length,
      unreadCount: items.filter((item) => item.direction === "inbound" && item.state === "delivered").length,
      lastMessage: newest ? {
        relayId: newest.wire.relayId,
        ...(newest.plaintext.title ? { title: newest.plaintext.title } : {}),
        preview: newest.plaintext.deletedAt ? "Message deleted" : newest.plaintext.forHuman,
        senderName: newest.item.direction === "outbound" ? "You" : newest.wire.sender.name,
        createdAt: newest.plaintext.createdAt,
        direction: newest.item.direction,
      } : undefined,
      updatedAt: newest?.plaintext.createdAt || new Date(0).toISOString(),
      items,
      hasMoreMessages: false,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function e2eeChatList(client, wires) {
  const { identity, opened } = await e2eeOpenedRecords(client, wires);
  return { chats: buildChats(identity, opened).map(({ items: _items, hasMoreMessages: _more, ...summary }) => summary) };
}

export async function e2eeChat(client, wires, chatId) {
  const { identity, opened } = await e2eeOpenedRecords(client, wires);
  return buildChats(identity, opened).find((chat) => chat.chatId === chatId);
}

export async function e2eeChatForThread(client, wires, threadId) {
  const { identity, opened } = await e2eeOpenedRecords(client, wires);
  return buildChats(identity, opened).find((chat) =>
    chat.items.some((item) => item.threadId === threadId || item.relayId === threadId));
}
