import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentUser, readConfig, taskLedgerPath, webUrl } from "./config.js";
import { migrateContentValue } from "./content-field-migration.js";
import { withJsonLock, withJsonLockStrict } from "./state-lock.cjs";
import atomicJson from "./atomic-json.cjs";
import localTrace from "./local-trace.cjs";
import inboxItemIds from "./inbox-item-id.cjs";

const { canonicalInboxItemId } = inboxItemIds;
const { atomicWriteJsonSync } = atomicJson;
const { appendLocalTrace } = localTrace;

const DEFAULT_COMPANION_STATE = {
  version: 1,
  profile: {
    name: "",
    handle: "",
    email: "",
    inboxDir: "",
    contactCardRoots: [],
    transport: { type: "filesystem" },
  },
  contacts: [],
  packets: {},
  meetingNotes: {},
  setup: {},
  emailThreads: {},
  chats: {},
};

function absoluteActionUrl(pathOrUrl) {
  if (!pathOrUrl) return webUrl();
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${webUrl()}${path}`;
}

export function notificationActionUrl(notification) {
  return notification.actionUrl || absoluteActionUrl(notification.url);
}

function actionForNotification(notification) {
  if (notification.kind === "task_request") {
    return {
      type: "task_request",
      taskId: notification.taskId,
      participantId: notification.participantId,
      url: notificationActionUrl(notification),
      actions: [
        { id: "accept", label: "Accept", method: "accept_task_invitation" },
        { id: "reject", label: "Reject", method: "reject_task_invitation" },
      ],
    };
  }
  if (notification.kind === "share_approval") {
    return {
      type: "review_share_approval",
      taskId: notification.taskId,
      url: notificationActionUrl(notification),
      actions: [
        { id: "send", label: "Send", method: "approve_share" },
        { id: "decline", label: "Decline", method: "decline_share" },
      ],
    };
  }
  return {
    type: "open",
    url: notificationActionUrl(notification),
  };
}

function participantForUser(task, user) {
  return (task.participants || []).find((participant) => (
    participant.userId === user?.id || participant.email === user?.email
  ));
}

function taskNotification(task, kind, title, body, url, extra = {}) {
  // Identity is stable on the CONDITION, not the volatile updatedAt (which re-minted
  // every poll and staged duplicate rows). `idDiscriminator` lets a caller re-notify
  // when the condition genuinely changes (e.g. a rising approval count) without
  // reintroducing timestamp spam. Never leaks into the row payload.
  const { idDiscriminator, ...rest } = extra;
  const base = {
    id: idDiscriminator != null ? `${kind}:${task.id}:${idDiscriminator}` : `${kind}:${task.id}`,
    kind,
    title,
    body,
    url,
    taskId: task.id,
    createdAt: task.updatedAt || task.createdAt || null,
    ...rest,
  };
  return {
    ...base,
    action: actionForNotification(base),
  };
}

export function buildHumanNotifications({ user, tasks = [], relays = [], connectors = [], inboxState = {} } = {}) {
  const notifications = [];
  for (const task of tasks) {
    const participant = participantForUser(task, user);
    if (
      task.viewerRole === "participant" &&
      participant &&
      ["created", "delivered"].includes(participant.invitationState) &&
      task.state === "inviting"
    ) {
      notifications.push(taskNotification(
        task,
        "task_request",
        "Relay task request",
        `${task.title}: ${task.objective}`,
        `/app/tasks/${task.id}`,
        { participantId: participant.id },
      ));
    }
    if (task.pendingApprovalCount > 0) {
      notifications.push(taskNotification(
        task,
        "share_approval",
        "Relay approval needed",
        `${task.pendingApprovalCount} outbound share approval${task.pendingApprovalCount === 1 ? "" : "s"} waiting for ${task.title}.`,
        `/app/tasks/${task.id}`,
        // A rising approval count is genuinely new work, so it must re-notify — but a
        // steady count must NOT re-stage every poll. Fold the count into the id.
        { idDiscriminator: task.pendingApprovalCount },
      ));
    }
    if (task.state === "completed") {
      notifications.push(taskNotification(task, "task_completed", "Relay task completed", task.title, `/app/tasks/${task.id}`));
    }
    if (task.state === "cancelled" || task.state === "failed") {
      notifications.push(taskNotification(task, `task_${task.state}`, `Relay task ${task.state}`, task.title, `/app/tasks/${task.id}`));
    }
  }

  for (const connector of connectors) {
    if (!["expired", "reconnect_required", "admin_consent_required", "error"].includes(connector.status)) continue;
    const notification = {
      // Stable on (provider, status) — the connector is re-polled every cycle, so a
      // lastCheckedAt suffix minted a fresh id (and a duplicate unread pill row) on
      // EVERY poll while the connector stayed broken.
      id: `connector:${connector.provider}:${connector.status}`,
      kind: "connector_reauth",
      title: `${connector.displayName} needs attention`,
      body: connector.errorMessage || `${connector.displayName} is ${connector.status.replaceAll("_", " ")}.`,
      url: "/app/connectors",
      provider: connector.provider,
      createdAt: connector.lastCheckedAt || null,
    };
    notifications.push({ ...notification, action: actionForNotification(notification) });
  }
  const suppressed = new Set(inboxState.suppressedItemIds || []);
  const restoredAtByItemId = inboxState.restoredAtByItemId || {};
  const readAllAtMs = inboxState.readAllAt ? new Date(inboxState.readAllAt).getTime() : Number.NaN;
  return notifications
    .filter((notification) => !suppressed.has(notification.id))
    .map((notification) => {
      const deliveryVersion = restoredAtByItemId[notification.id] || "";
      const deliveryReferenceAt = deliveryVersion || notification.createdAt || "";
      const deliveryMs = new Date(deliveryReferenceAt).getTime();
      return {
        ...notification,
        deliveryVersion,
        deliveryReferenceAt,
        read: Number.isFinite(readAllAtMs) && Number.isFinite(deliveryMs) && deliveryMs <= readAllAtMs,
      };
    });
}

export function freshNotifications(ledger, notifications) {
  const seen = ledger.notifications || {};
  return notifications.filter((notification) => {
    const previous = seen[notification.id];
    return !previous || (notification.deliveryVersion || "") !== (previous.deliveryVersion || "");
  });
}

export function markNotificationsProcessed(ledger, notifications) {
  ledger.notifications ||= {};
  const processedAt = new Date().toISOString();
  for (const notification of notifications) {
    ledger.notifications[notification.id] = {
      kind: notification.kind,
      deliveryVersion: notification.deliveryVersion || "",
      processedAt,
    };
  }
}

export function companionHome() {
  return process.env.RELAY_HOME || process.env.RELAY_COMPANION_HOME || path.join(os.homedir(), ".relay-companion");
}

export function companionStatePath(dir = companionHome()) {
  return path.join(dir, "state.json");
}

function readCompanionState(statePath) {
  try {
    return {
      ...structuredClone(DEFAULT_COMPANION_STATE),
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
    };
  } catch {
    return structuredClone(DEFAULT_COMPANION_STATE);
  }
}

function writeCompanionState(statePath, state) {
  atomicWriteJsonSync(statePath, state, { mode: 0o600 });
}

/** Apply server tombstones to rows already staged by this companion. */
export function removeSuppressedCompanionItems(itemIds, { statePath = companionStatePath() } = {}) {
  const suppressed = new Set((itemIds || []).filter(Boolean).map(String));
  if (!suppressed.size) return 0;
  return withJsonLock(statePath, () => {
    const state = readCompanionState(statePath);
    state.packets ||= {};
    let removed = 0;
    for (const [id, row] of Object.entries(state.packets)) {
      if (!suppressed.has(canonicalInboxItemId(id, row))) continue;
      delete state.packets[id];
      removed += 1;
    }
    if (removed) writeCompanionState(statePath, state);
    return removed;
  });
}

/** Reconcile an account-wide mark-all-read watermark onto already-staged rows. */
export function markCompanionItemsReadThrough(readAllAt, { statePath = companionStatePath() } = {}) {
  const cutoffMs = new Date(readAllAt || "").getTime();
  if (!Number.isFinite(cutoffMs)) return 0;
  return withJsonLock(statePath, () => {
    const state = readCompanionState(statePath);
    state.packets ||= {};
    let changed = 0;
    for (const row of Object.values(state.packets)) {
      if (!row || row.direction !== "inbound" || row.state === "read") continue;
      const reference = row.deliveryReferenceAt ||
        (row.relayNotificationKind === "plain_relay" ? row.updatedAt : row.createdAt);
      const referenceMs = new Date(reference || "").getTime();
      if (!Number.isFinite(referenceMs) || referenceMs > cutoffMs) continue;
      row.state = "read";
      changed += 1;
    }
    if (changed) writeCompanionState(statePath, state);
    return changed;
  });
}

function accountMarker({ user = currentUser(), deviceId = readConfig().deviceId || "" } = {}) {
  return {
    userId: user?.id || "",
    email: user?.email || "",
    deviceId: deviceId || "",
  };
}

function stateBelongsToAccount(state, marker) {
  if (!marker.userId && !marker.email) return true;
  const account = state.account || {};
  if (!account.userId && !account.email) return false;
  if (account.userId && marker.userId && account.userId !== marker.userId) return false;
  if (account.email && marker.email && account.email !== marker.email) return false;
  return true;
}

export function resetCompanionStateForAccount(
  { user = currentUser(), deviceId = readConfig().deviceId || "", force = false } = {},
  { statePath = companionStatePath() } = {},
) {
  const marker = accountMarker({ user, deviceId });
  return withJsonLock(statePath, () => {
    const existing = readCompanionState(statePath);
    if (!force && stateBelongsToAccount(existing, marker)) {
      if (!existing.account) {
        existing.account = { ...marker, resetAt: null };
        writeCompanionState(statePath, existing);
      }
      return { reset: false, statePath };
    }
    const next = {
      ...structuredClone(DEFAULT_COMPANION_STATE),
      account: { ...marker, resetAt: new Date().toISOString() },
      profile: {
        ...structuredClone(DEFAULT_COMPANION_STATE.profile),
        transport: { type: "relay_api" },
      },
    };
    writeCompanionState(statePath, next);
    // The staging ledger belongs to the store that was just destroyed. Left
    // intact, its dedupe would permanently block re-staging every relay the
    // reset wiped, leaving the inbox empty while the server still has them.
    try {
      const ledgerFile = taskLedgerPath();
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) || {};
      ledger.plainRelays = {};
      fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    } catch {}
    return { reset: true, statePath };
  });
}

function notificationUrgency(kind) {
  if (kind === "task_request" || kind === "share_approval") return "action_required";
  if (kind === "connector_reauth") return "attention";
  if (kind === "task_failed" || kind === "task_cancelled") return "problem";
  return "normal";
}

function senderForNotification(notification) {
  // Always prefer the real sender carried on the notification (e.g. the question's
  // TaskMessage.senderLabel or the other person's name). Never surface the brand word
  // "Relay" as if it were a person.
  if (notification.senderName) return notification.senderName;
  // task_request / share_approval are workflow notices, not people; label them as the
  // automation, not as "Relay" the person. (These are filtered out of the Relays list
  // anyway via RELAY_HIDDEN_KINDS, but the staged senderName must still be coherent.)
  if (notification.kind === "task_request") return "Your agent";
  if (notification.kind === "share_approval") return "Your agent";
  // Task lifecycle notices (completed/cancelled/failed) are the agent run reporting
  // back, not a person — label them as the automation, never "Someone".
  if (notification.kind === "task_completed") return "Your agent";
  if (notification.kind === "task_cancelled") return "Your agent";
  if (notification.kind === "task_failed") return "Your agent";
  if (notification.kind === "connector_reauth") return "Relay connectors";
  return "Someone";
}

function subjectForNotification(notification) {
  if (notification.kind === "task_request" && notification.body) return notification.body;
  if (notification.kind === "share_approval" && notification.body) return notification.body;
  return notification.title || notification.body || "Relay";
}

function notificationSender(notification) {
  return {
    name: senderForNotification(notification),
    handle: "relay",
    email: "",
    host: "relay",
  };
}

function notificationRecipient() {
  return {
    name: "You",
    handle: "you",
    email: "",
    ai: "codex",
  };
}

function packetMarkdownForNotification(notification) {
  const lines = [
    notification.body || notification.title || "Relay needs your attention.",
    "",
    "---",
    `Relay attention item: ${notification.kind || "relay"}`,
  ];
  if (notification.taskId) lines.push(`Task id: \`${notification.taskId}\``);
  if (notification.messageId) lines.push(`Message id: \`${notification.messageId}\``);
  if (notification.participantId) lines.push(`Participant id: \`${notification.participantId}\``);
  if (notification.provider) lines.push(`Connector: \`${notification.provider}\``);
  if (notification.kind === "task_request") {
    lines.push("");
    lines.push("This is a Relay task request. The human must accept or reject before their agent participates.");
  } else if (notification.kind === "share_approval") {
    lines.push("");
    lines.push("This is a Relay share approval. No cross-person information has been sent yet.");
  }
  return lines.join("\n");
}

// Notification ids carry a colon by construction — `share_approval:task_9`,
// `connector:claude:degraded` — and a colon cannot appear in
// a Windows filename: it is the alternate-data-stream separator. Writing the id
// straight through meant every packet write on Windows died with EINVAL, so no
// notification could ever be staged there.
//
// Clean the name for the filesystem and keep a short digest of the EXACT id, so two
// ids that clean to the same string can never share a file. Same id always yields
// the same name, which is what lets a re-stage overwrite in place. Readers follow
// the contentPath recorded in state, so this only has to be stable, not pretty.
function packetFileName(id) {
  const raw = String(id || "");
  const clean = raw.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^[.]+/, "").slice(0, 80) || "packet";
  return `${clean}.${createHash("sha256").update(raw).digest("hex").slice(0, 8)}.json`;
}

function writeNotificationPacketContent(notification, packet, statePath) {
  const dir = path.join(path.dirname(statePath), "packets");
  const contentPath = path.join(dir, packetFileName(packet.id));
  atomicWriteJsonSync(contentPath, packet, { mode: 0o600 });
  return contentPath;
}

function relayPacketFromNotification(notification, { now = new Date().toISOString() } = {}) {
  const subject = subjectForNotification(notification);
  const sender = notificationSender(notification);
  return {
    schemaVersion: 1,
    id: notification.id,
    createdAt: notification.createdAt || now,
    updatedAt: now,
    state: notification.read ? "read" : "unread",
    sender,
    recipient: notificationRecipient(),
    source: {
      host: "relay",
      surface: "relay_companion",
      threadId: null,
      cwd: process.cwd(),
    },
    kind: "message",
    title: subject,
    displayTitle: subject,
    // THE AGENT LANE. This was hardcoded empty, so every inbound relay lost its
    // second document at staging and the reader's folder — "For you" / "For
    // <their agent app>" — could never appear, however carefully the sender
    // split it (David, live: "where's the folder stuff?"). The tabs are gated
    // on this string being non-empty.
    forAgent: String(notification.forAgent || ""), // notification path keeps its own source
    includeDefaultTranscript: false,
    briefingMarkdown: packetMarkdownForNotification(notification),
    attachments: [],
    delivery: {
      transport: "relay_task",
      targetSurfaces: ["codex", "claude_code"],
      recipientInboxDir: "",
      outboxPath: null,
      inboxPath: null,
    },
  };
}

export function relayCompanionRowFromNotification(
  notification,
  { now = new Date().toISOString(), contentPath = null } = {},
) {
  const actionUrl = notificationActionUrl(notification);
  const subject = subjectForNotification(notification);
  return {
    id: notification.id,
    direction: "inbound",
    state: notification.read ? "read" : "unread",
    kind: "message",
    // Default unknown notification kinds to a neutral "message", never "task_completed"
    // (which would falsely mark an unknown row as a finished task). main.cjs readRelays
    // also defaults to "task_completed"; staging a real kind here keeps that fallback unused.
    relayNotificationKind: notification.kind || "message",
    urgency: notificationUrgency(notification.kind),
    senderName: senderForNotification(notification),
    title: subject,
    displayTitle: subject,
    briefingMarkdown: packetMarkdownForNotification(notification),
    forHuman: notification.body || notification.title || "",
    createdAt: notification.createdAt || now,
    deliveryReferenceAt: notification.deliveryReferenceAt || notification.createdAt || now,
    updatedAt: now,
    stagedAt: now,
    actionUrl,
    action: notification.action || actionForNotification(notification),
    taskId: notification.taskId || null,
    participantId: notification.participantId || null,
    messageId: notification.messageId || null,
    provider: notification.provider || null,
    contentPath,
    filePath: contentPath,
    attachments: [],
    materializationDeferredReason: "relay_pill",
    materializedSurfaces: { codex: false, claudeCode: false, claudeCowork: false },
  };
}

export function stageRelayCompanionItem(notification, { statePath = companionStatePath() } = {}) {
  // Locked read-modify-write: the pill acks rows into the same file concurrently.
  return withJsonLock(statePath, () => {
    const state = readCompanionState(statePath);
    state.packets ||= {};
    state.chats ||= {};
    const existing = state.packets[notification.id] || {};
    const packet = relayPacketFromNotification(notification);
    const contentPath = writeNotificationPacketContent(notification, packet, statePath);
    const item = {
      ...existing,
      ...relayCompanionRowFromNotification(notification, { contentPath }),
      state: existing.state === "read" || packet.state === "read" ? "read" : "unread",
    };
    state.packets[item.id] = item;
    writeCompanionState(statePath, state);
    return {
      ok: true,
      transport: "relay_companion",
      statePath,
      itemId: item.id,
      actionUrl: item.actionUrl,
      contentPath,
    };
  });
}

export function defaultStageRelayCompanionItem(notification) {
  return stageRelayCompanionItem(notification);
}


/**
 * Patch a staged row's attachments in place (the ingest prefetch writes the
 * acquired localPath values back after download). Deliberately writes ONLY the
 * attachments array — never the materialization-signature keys, which are
 * open-time state owned by the materializer.
 */
export function updateStagedRelayAttachments(relayId, attachments, { statePath = companionStatePath() } = {}) {
  if (!relayId || !Array.isArray(attachments)) return false;
  return withJsonLock(statePath, () => {
    const state = readCompanionState(statePath);
    const row = state.packets && state.packets[relayId];
    if (!row) return false;
    row.attachments = attachments;
    writeCompanionState(statePath, state);
    return true;
  });
}

export function stagePlainRelayItem(
  { item, packet, attachmentUrls = {} },
  { statePath = companionStatePath(), forceUnread = false } = {},
) {
  if (!item?.relayId) throw new Error("stagePlainRelayItem requires an inbox item with relayId");
  // A rolling API deploy may briefly return a pre-v3 packet to a v3+ client.
  // Normalize at the wire boundary on every ingest so retired field names can
  // never overwrite the canonical two-document store after its one-time sweep.
  packet = packet && typeof packet === "object" ? structuredClone(packet) : {};
  migrateContentValue(packet);
  // STRICT lock: an unlocked stage racing a pill write can be clobbered by the
  // last-writer-wins rename, and the daemon's ledger would never re-stage the
  // relay — a permanently invisible message. Failing the poll and retrying in
  // 4s is strictly better. Throwing keeps the caller's no-ledger-on-error path.
  const strict = withJsonLockStrict(statePath, () => {
  const state = readCompanionState(statePath);
  state.packets ||= {};
  state.chats ||= {};
  const now = new Date().toISOString();
  const existing = state.packets[item.relayId] || {};
  const content = {
    ...(packet || {}),
    id: item.relayId,
    briefingMarkdown: packet?.forHuman || item.preview || "",
    attachmentUrls,
    delivery: {
      transport: "relay_api",
      targetSurfaces: packet?.targetSurfaces || ["codex", "claude_code"],
      recipientInboxDir: "",
      outboxPath: null,
      inboxPath: null,
    },
  };
  const contentPath = writeNotificationPacketContent({ id: item.relayId }, content, statePath);
  const preserveSetupUnread = existing.setupImportedUnread === true && existing.state === "unread";
  const readState = forceUnread || preserveSetupUnread ? "unread" : existing.state === "read" || item.state === "read" ? "read" : "unread";
  const row = {
    ...existing,
    id: item.relayId,
    direction: "inbound",
    state: readState,
    kind: item.kind || packet?.kind || "message",
    // A task is still an ordinary relay on the wire; the notification kind is
    // what gives it the Task chip and the Start verb in the pill. Distinct from
    // the legacy (hidden) "task_request" protocol kind on purpose.
    relayNotificationKind: (item.kind || packet?.kind) === "task" ? "task" : "plain_relay",
    urgency: "normal",
    // Task receipt timestamps, present only on kind "task" items. The server
    // is authoritative once it has them; until then keep a locally stamped
    // value (the preview writes one at Start) instead of reverting to null.
    taskStartedAt: item.taskStartedAt || existing.taskStartedAt || null,
    taskCompletedAt: item.taskCompletedAt || existing.taskCompletedAt || null,
    // The completion species has to survive staging or the pill cannot tell an
    // agent's report from correspondence, and it lands in the chat with a
    // person (David, twice). packet.type is the sender's declared type.
    type: packet?.type || item.type || existing.type || null,
    senderName: item.sender?.name || packet?.sender?.name || "Someone",
    // The address is what lets the pill show a contact-book name instead of an
    // account handle: a Relay account is named by whatever the person signed up
    // with, which is usually their email prefix.
    senderEmail: item.sender?.email || packet?.sender?.email || "",
    // An untitled relay is a typed text: staging must NOT manufacture a title
    // ("Relay", or the preview promoted to a subject) or every downstream
    // body-first fallback is defeated and the pill shows the word "Relay"
    // instead of the message.
    title: item.title || packet?.title || "",
    displayTitle: item.title || packet?.title || item.displayTitle || "",
    briefingMarkdown: packet?.forHuman || item.preview || "",
    forHuman: packet?.forHuman || item.preview || "",
    // THE AGENT LANE — the relay's second document. It rides the PACKET (the
    // inbox list item carries only a preview), and staging never copied it, so
    // the reader's folder — "For you" / "For <their agent app>" — could not
    // render however carefully the sender split the relay (David, live:
    // "where's the folder stuff?"). The tabs are gated on this being non-empty.
    forAgent: packet?.forAgent || "",
    createdAt: item.createdAt || packet?.createdAt || now,
    updatedAt: item.updatedAt || now,
    editedAt: item.editedAt || packet?.editedAt || null,
    deletedAt: item.deletedAt || packet?.deletedAt || null,
    // Thread identity travels with the staged row so the pill can group an
    // exchange and keep its unread counting stable per thread.
    inReplyToRelayId: item.inReplyToRelayId || packet?.inReplyToRelayId || null,
    threadId: item.threadId || packet?.threadId || item.relayId,
    // The conversation's name, carried on every item by the API so the pill can
    // label a thread without fetching it.
    threadTitle: item.threadTitle || packet?.threadTitle || null,
    // Stable group facts must survive local staging. Without these, a group
    // with only one person speaking looked like a 1:1 chat with that person.
    groupSendId: item.groupSendId || packet?.groupSendId || null,
    recipientGroupId: item.recipientGroupId || packet?.recipientGroupId || null,
    recipientGroupName: item.recipientGroupName || packet?.recipientGroupName || null,
    // A restoration is a fresh inbox delivery even when the underlying relay was
    // read before deletion. Use that timestamp so an older account read-all
    // cutoff cannot immediately collapse the restored row back to read.
    deliveryReferenceAt: item.restoredAt || item.updatedAt || item.createdAt || now,
    stagedAt: now,
    actionUrl: "/app/relays",
    action: { type: "open", url: "/app/relays" },
    taskId: null,
    participantId: null,
    messageId: null,
    provider: null,
    // The WORKSPACE PASSPORT rides with the row: it is how the open path routes
    // a relay to the repo it belongs to (cwd-select.js). Dropping it here is why
    // every relay landed in the default folder — the sender's passport survived
    // the API in packet.source and died at staging (David's live report).
    source: packet?.source || item.source || null,
    contentPath,
    filePath: contentPath,
    attachments: packet?.attachments || [],
    attachmentUrls,
    materializationDeferredReason: "relay_pill",
    materializedSurfaces: existing.materializedSurfaces || { codex: false, claudeCode: false, claudeCowork: false },
    setupImportedUnread: forceUnread || preserveSetupUnread || undefined,
  };
  state.packets[item.relayId] = row;
  writeCompanionState(statePath, state);
  // Verified read-back before the caller may ledger this item: the row must
  // actually be on disk, or the ledger would permanently swallow the relay.
  const persisted = readCompanionState(statePath);
  if (!persisted.packets || !persisted.packets[item.relayId]) {
    throw new Error(`staged relay ${item.relayId} missing on read-back`);
  }
  return {
    ok: true,
    transport: "relay_companion",
    statePath,
    itemId: item.relayId,
    stagedState: row.state,
    actionUrl: row.actionUrl,
    contentPath,
  };
  });
  if (!strict.ok) throw new Error(`state lock unavailable (${strict.reason}); relay ${item.relayId} not staged`);
  appendLocalTrace({
    event: "relay_staged",
    relayId: item.relayId,
    surface: "relay_pill",
    state: strict.value?.stagedState || "unknown",
    restored: Boolean(forceUnread || item.restoredAt),
  }, { home: path.dirname(statePath) });
  return strict.value;
}

// Sent relays normally live only in the API-backed Sent list. Stage a durable,
// non-inbox row on first open so the existing lazy materializer can create (and
// subsequently reuse) the same native Claude/Codex session it creates for an
// inbound relay. `direction: "outbound"` deliberately keeps this synthetic row
// out of the Relays column while preserving its materialization metadata.
export function stageSentRelayItem(
  { item, sender = {} },
  { statePath = companionStatePath() } = {},
) {
  if (!item?.relayId) throw new Error("stageSentRelayItem requires a sent item with relayId");
  return withJsonLock(statePath, () => {
    const state = readCompanionState(statePath);
    state.packets ||= {};
    state.chats ||= {};
    // A self-sent relay can also exist as an inbound packet under item.relayId.
    // Use a distinct, filename-safe key so opening Sent never overwrites or
    // reorients the copy shown in the Relays column.
    const materializationId = `sent_${item.relayId}`;
    const existing = state.packets[materializationId] || {};
    const now = new Date().toISOString();
    const existingAttachments = new Map(
      (Array.isArray(existing.attachments) ? existing.attachments : [])
        .filter((attachment) => attachment?.id)
        .map((attachment) => [attachment.id, attachment]),
    );
    const attachments = (Array.isArray(item.attachments) ? item.attachments : []).map((attachment) => {
      const prior = existingAttachments.get(attachment?.id);
      return prior?.localPath ? { ...attachment, localPath: prior.localPath } : attachment;
    });
    const attachmentUrls = Object.fromEntries(
      attachments
        .filter((attachment) => attachment?.id && attachment?.openUrl)
        .map((attachment) => [attachment.id, attachment.openUrl]),
    );
    const senderName = String(sender.name || sender.email || "You").trim() || "You";
    const recipient = item.recipient || { name: "Recipient" };
    // Same rule as inbound staging: an untitled sent row is a typed text, and
    // manufacturing a subject here defeats every body-first fallback downstream.
    const title = item.title || item.displayTitle || "";
    const forHuman = item.forHuman || item.preview || "";
    const forAgent = item.forAgent || "";
    const content = {
      id: materializationId,
      sourceRelayId: item.relayId,
      createdAt: item.createdAt || now,
      editedAt: item.editedAt || null,
      deletedAt: item.deletedAt || null,
      kind: item.kind || "message",
      title,
      displayTitle: title,
      forHuman,
      // `/v1/sent` carries the complete second Relay document. Keep it in the
      // durable packet as well as the projected row so both providers receive
      // the same two-document handoff when a sent Relay is opened later.
      forAgent,
      source: item.source || { host: "unknown" },
      sender: { name: senderName, ...(sender.email ? { email: sender.email } : {}) },
      recipient,
      attachments,
      attachmentUrls,
      // Thread identity so opening a sent message inside a conversation seeds
      // the whole exchange (materializer attachThreadTranscript), same as the
      // inbound side. An item without one must not clobber a previously staged
      // id (this row is re-staged on every open).
      threadId: item.threadId || existing.threadId || null,
      threadTitle: item.threadTitle || existing.threadTitle || null,
      groupSendId: item.groupSendId || existing.groupSendId || null,
      recipientGroupId: item.recipientGroupId || existing.recipientGroupId || null,
      recipientGroupName: item.recipientGroupName || existing.recipientGroupName || null,
      inReplyToRelayId: item.inReplyToRelayId || existing.inReplyToRelayId || null,
      // A sibling of recipient, not a property of it, so the field-by-field
      // allowlist above drops it unless it is named here. Without this line the
      // sender's own seed can never tell a minted link from an ordinary send.
      shareLink: item.shareLink || existing.shareLink || null,
    };
    const contentPath = writeNotificationPacketContent({ id: materializationId }, content, statePath);
    const row = {
      ...existing,
      ...content,
      direction: "outbound",
      state: "read",
      relayNotificationKind: "sent_relay",
      senderName,
      recipient,
      briefingMarkdown: forHuman,
      updatedAt: item.updatedAt || now,
      stagedAt: existing.stagedAt || now,
      contentPath,
      filePath: contentPath,
      attachmentUrls,
      sentDelivery: item.delivery || null,
      materializationDeferredReason: "sent_relay_pill",
      materializedSurfaces:
        existing.materializedSurfaces || { codex: false, claudeCode: false, claudeCowork: false },
    };
    state.packets[materializationId] = row;
    writeCompanionState(statePath, state);
    return {
      ok: true,
      transport: "relay_companion",
      statePath,
      itemId: materializationId,
      relayId: item.relayId,
      contentPath,
    };
  });
}
