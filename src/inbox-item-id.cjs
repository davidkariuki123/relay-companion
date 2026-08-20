"use strict";

/**
 * Old companion releases staged task notifications with a timestamp suffix.
 * The API intentionally uses the stable condition id, so normalize both old
 * and current rows before deleting, suppressing, or comparing them.
 */
function canonicalInboxItemId(packetId, row = {}) {
  const kind = String(row.relayNotificationKind || "");
  // Retired question flow: nothing mints these rows anymore, but one staged by
  // an old build must still normalize so deleting it tombstones correctly.
  if (kind === "human_question" && row.messageId) {
    return `human_question:${row.messageId}`;
  }
  if (["task_completed", "task_cancelled", "task_failed"].includes(kind) && row.taskId) {
    return `${kind}:${row.taskId}`;
  }
  return String(packetId || "");
}

function packetIdsForCanonicalItem(packets, canonicalItemId) {
  return Object.entries(packets || {})
    .filter(([packetId, row]) => canonicalInboxItemId(packetId, row) === canonicalItemId)
    .map(([packetId]) => packetId);
}

module.exports = { canonicalInboxItemId, packetIdsForCanonicalItem };
