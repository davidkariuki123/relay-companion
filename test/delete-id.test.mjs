import assert from "node:assert/strict";
import test from "node:test";
import deleteIds from "../src/inbox-item-id.cjs";

const { canonicalInboxItemId, packetIdsForCanonicalItem } = deleteIds;

test("normalizes legacy timestamped terminal task notification ids", () => {
  const taskId = "task_123";
  assert.equal(
    canonicalInboxItemId(`task_cancelled:${taskId}:2026-07-07T15:37:51.741Z`, {
      relayNotificationKind: "task_cancelled",
      taskId,
    }),
    `task_cancelled:${taskId}`,
  );
});

test("normalizes a legacy question row using its message id", () => {
  assert.equal(
    canonicalInboxItemId("old-question-packet", {
      relayNotificationKind: "human_question",
      messageId: "message_123",
    }),
    "human_question:message_123",
  );
});

test("keeps ordinary relay ids unchanged", () => {
  assert.equal(
    canonicalInboxItemId("relay_123", { relayNotificationKind: "plain_relay" }),
    "relay_123",
  );
});

test("deleting a canonical task item removes all legacy local aliases", () => {
  const canonical = "task_cancelled:task_123";
  const packets = {
    [canonical]: { relayNotificationKind: "task_cancelled", taskId: "task_123" },
    [`${canonical}:2026-07-07T15:37:51.741Z`]: { relayNotificationKind: "task_cancelled", taskId: "task_123" },
    "relay_456": { relayNotificationKind: "plain_relay" },
  };
  assert.deepEqual(packetIdsForCanonicalItem(packets, canonical).sort(), [
    canonical,
    `${canonical}:2026-07-07T15:37:51.741Z`,
  ].sort());
});
