import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHumanNotifications,
  companionStatePath,
  freshNotifications,
  markNotificationsProcessed,
  markCompanionItemsReadThrough,
  notificationActionUrl,
  removeSuppressedCompanionItems,
  resetCompanionStateForAccount,
  stagePlainRelayItem,
  stageRelayCompanionItem,
  stageSentRelayItem,
} from "../src/notifications.js";
import { pollTaskRuntimeOnce } from "../src/task-daemon.js";

test("buildHumanNotifications emits task, approval, question, and connector notifications", () => {
  const notifications = buildHumanNotifications({
    user: { id: "usr_1", email: "sven@example.com" },
    tasks: [
      {
        id: "task_1",
        title: "Coffee",
        objective: "Find a time for coffee",
        state: "inviting",
        viewerRole: "participant",
        updatedAt: "2026-06-29T10:00:00.000Z",
        pendingApprovalCount: 0,
        participants: [{ id: "tpart_1", userId: "usr_1", email: "sven@example.com", invitationState: "delivered" }],
      },
      {
        id: "task_2",
        title: "Dinner",
        objective: "Coordinate dinner",
        state: "active",
        viewerRole: "creator",
        updatedAt: "2026-06-29T10:01:00.000Z",
        pendingApprovalCount: 1,
        participants: [],
      },
    ],
    relays: [
      {
        requiresAnswer: true,
        task: { id: "task_2", title: "Dinner" },
        message: {
          id: "tmsg_1",
          updatedAt: "2026-06-29T10:02:00.000Z",
          forHuman: "Which slot?",
          humanResponse: { question: "Which slot?" },
        },
      },
    ],
    connectors: [
      {
        provider: "gmail",
        displayName: "Gmail",
        status: "reconnect_required",
        lastCheckedAt: "2026-06-29T10:03:00.000Z",
        errorMessage: null,
      },
    ],
  });

  assert.deepEqual(
    notifications.map((notification) => notification.kind),
    ["task_request", "share_approval", "connector_reauth"],
  );
  // The retired question flow mints nothing: a requiresAnswer relay in the feed
  // (still served for historical rows) produces no notification and no reply box.
  assert.equal(notifications.some((notification) => notification.kind === "human_question"), false);
});

test("notification action URLs use the configured Relay web URL", () => {
  process.env.RELAY_WEB_URL = "https://relay.example.com";
  const url = notificationActionUrl({ url: "/app/tasks/task_1" });
  assert.equal(url, "https://relay.example.com/app/tasks/task_1");
  delete process.env.RELAY_WEB_URL;
});

test("stageRelayCompanionItem writes an unread Relay pill-compatible row with action metadata", () => {
  process.env.RELAY_WEB_URL = "https://relay.example.com";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-test-"));
  const statePath = companionStatePath(dir);
  const result = stageRelayCompanionItem(
    {
      id: "share_approval:task_1",
      title: "Relay approval needed",
      body: "Review the payload.",
      url: "/app/tasks/task_1",
      kind: "share_approval",
      taskId: "task_1",
    },
    { statePath },
  );
  assert.equal(result.transport, "relay_companion");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const row = state.packets["share_approval:task_1"];
  assert.equal(row.state, "unread");
  assert.equal(row.direction, "inbound");
  assert.equal(row.kind, "message");
  assert.equal(row.relayNotificationKind, "share_approval");
  assert.equal(row.actionUrl, "https://relay.example.com/app/tasks/task_1");
  assert.equal(row.action.type, "review_share_approval");
  assert.equal(row.contentPath, result.contentPath);
  const packet = JSON.parse(fs.readFileSync(result.contentPath, "utf8"));
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.id, "share_approval:task_1");
  assert.match(packet.briefingMarkdown, /No cross-person information has been sent yet/);
  delete process.env.RELAY_WEB_URL;
});

test("stagePlainRelayItem writes an ordinary relay row for the existing pill UI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plain-row-test-"));
  const statePath = companionStatePath(dir);
  const result = stagePlainRelayItem(
    {
      item: {
        relayId: "relay_1",
        state: "delivered",
        kind: "message",
        title: "Checking in",
        preview: "How are you doing?",
        sender: { name: "Sven", email: "sven@example.com" },
        createdAt: "2026-06-29T10:00:00.000Z",
        updatedAt: "2026-06-29T10:00:01.000Z",
      },
      packet: {
        schemaVersion: 2,
        id: "relay_1",
        createdAt: "2026-06-29T10:00:00.000Z",
        kind: "message",
        title: "Checking in",
        displayTitle: "From Sven: Checking in",
        forHuman: "How are you doing?",
        forAgent: "",
        sender: { name: "Sven", email: "sven@example.com" },
        recipient: { name: "David", email: "david@example.com" },
        source: { host: "relay-mcp" },
        targetSurfaces: ["codex"],
        attachments: [],
        e2ee: {
          protocol: "mls10",
          cipherSuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
          senderDeviceId: "dev_sven",
        },
      },
    },
    { statePath },
  );

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const row = state.packets.relay_1;
  assert.equal(result.itemId, "relay_1");
  assert.equal(row.relayNotificationKind, "plain_relay");
  assert.equal(row.direction, "inbound");
  assert.equal(row.state, "unread");
  assert.equal(row.senderName, "Sven");
  assert.equal(row.title, "Checking in");
  assert.equal(row.forHuman, "How are you doing?");
  assert.equal(row.e2ee.senderDeviceId, "dev_sven");
  const packet = JSON.parse(fs.readFileSync(result.contentPath, "utf8"));
  assert.equal(packet.schemaVersion, 2);
  assert.equal(packet.delivery.transport, "relay_api");
});

test("an acknowledged history import is staged as read and remains visibly non-runnable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-history-row-test-"));
  const statePath = companionStatePath(dir);
  stagePlainRelayItem({
    item: {
      relayId: "erelay_imported_1",
      state: "acknowledged",
      kind: "task",
      taskState: "completed",
      historyImported: true,
      preview: "An earlier Request.",
      sender: { name: "David" },
    },
    packet: {
      schemaVersion: 3,
      id: "erelay_imported_1",
      kind: "task",
      taskState: "completed",
      historyImported: true,
      forHuman: "An earlier Request.",
      forAgent: "Historical agent payload.",
      sender: { name: "David" },
      recipient: { name: "Shane" },
      targetSurfaces: [],
      attachments: [],
    },
  }, { statePath });
  const row = JSON.parse(fs.readFileSync(statePath, "utf8")).packets.erelay_imported_1;
  assert.equal(row.state, "read");
  assert.equal(row.historyImported, true);
  assert.equal(row.taskState, "completed");
});

test("stagePlainRelayItem canonicalizes a mixed-version packet on every ingest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ingress-fields-test-"));
  const statePath = companionStatePath(dir);
  const oldHuman = "body" + "Markdown";
  const oldAgent = "user" + "Instructions";
  const result = stagePlainRelayItem(
    {
      item: {
        relayId: "relay_mixed_1",
        state: "delivered",
        kind: "message",
        title: "Complete documents survive",
        preview: "short preview…",
        sender: { name: "Sven", email: "sven@example.com" },
      },
      packet: {
        schemaVersion: 2,
        id: "relay_mixed_1",
        title: "Complete documents survive",
        [oldHuman]: "the complete human document",
        [oldAgent]: "the complete agent document",
      },
    },
    { statePath },
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const packet = JSON.parse(fs.readFileSync(result.contentPath, "utf8"));
  assert.equal(state.packets.relay_mixed_1.forHuman, "the complete human document");
  assert.equal(state.packets.relay_mixed_1.forAgent, "the complete agent document");
  assert.equal(packet.forHuman, "the complete human document");
  assert.equal(packet.forAgent, "the complete agent document");
  assert.equal(JSON.stringify({ state, packet }).includes(oldHuman), false);
  assert.equal(JSON.stringify({ state, packet }).includes(oldAgent), false);
});

test("stagePlainRelayItem persists thread identity onto the staged row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thread-stage-test-"));
  const statePath = companionStatePath(dir);

  // A reply carries both its parent pointer and the thread root.
  stagePlainRelayItem(
    {
      item: {
        relayId: "relay_reply_1",
        state: "delivered",
        kind: "message",
        title: "Re: Checking in",
        preview: "Doing well, you?",
        sender: { name: "Sven", email: "sven@example.com" },
        createdAt: "2026-06-29T10:05:00.000Z",
        updatedAt: "2026-06-29T10:05:01.000Z",
        inReplyToRelayId: "relay_root_1",
        threadId: "relay_root_1",
      },
      packet: {
        schemaVersion: 2,
        id: "relay_reply_1",
        createdAt: "2026-06-29T10:05:00.000Z",
        kind: "message",
        title: "Re: Checking in",
        displayTitle: "From Sven: Re: Checking in",
        forHuman: "Doing well, you?",
        forAgent: "",
        sender: { name: "Sven", email: "sven@example.com" },
        recipient: { name: "David", email: "david@example.com" },
        source: { host: "relay-mcp" },
        targetSurfaces: [],
        attachments: [],
        inReplyToRelayId: "relay_root_1",
        threadId: "relay_root_1",
      },
    },
    { statePath },
  );
  const reply = JSON.parse(fs.readFileSync(statePath, "utf8")).packets.relay_reply_1;
  assert.equal(reply.threadId, "relay_root_1");
  assert.equal(reply.inReplyToRelayId, "relay_root_1");

  // A standalone item from an older server (no threadId on the wire) roots its
  // own thread so pill-side grouping always has a key.
  stagePlainRelayItem(
    {
      item: {
        relayId: "relay_solo_1",
        state: "delivered",
        kind: "message",
        title: "Standalone",
        preview: "No thread fields on this one.",
        sender: { name: "Sven", email: "sven@example.com" },
        createdAt: "2026-06-29T11:00:00.000Z",
        updatedAt: "2026-06-29T11:00:01.000Z",
      },
    },
    { statePath },
  );
  const solo = JSON.parse(fs.readFileSync(statePath, "utf8")).packets.relay_solo_1;
  assert.equal(solo.threadId, "relay_solo_1");
  assert.equal(solo.inReplyToRelayId, null);
});

test("stageSentRelayItem creates a durable outbound materialization row and preserves an existing session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sent-row-test-"));
  const statePath = companionStatePath(dir);
  fs.writeFileSync(statePath, JSON.stringify({
    packets: {
      sent_relay_sent_1: {
        id: "sent_relay_sent_1",
        threadId: "thread_existing",
        attachments: [{ id: "att_1", name: "launch-note.pdf", localPath: "/tmp/relay/launch-note.pdf" }],
        materializedSurfaces: { codex: true, claudeCode: false, claudeCowork: false },
      },
    },
  }));

  const result = stageSentRelayItem(
    {
      sender: { name: "David", email: "david@example.com" },
      item: {
        relayId: "relay_sent_1",
        state: "delivered",
        createdAt: "2026-07-09T12:00:00.000Z",
        updatedAt: "2026-07-09T12:01:00.000Z",
        kind: "message",
        title: "Launch note",
        displayTitle: "From David: Launch note",
        recipient: { name: "Sven", email: "sven@example.com", onRelay: true },
        preview: "Please review the launch note.",
        forHuman: "Please review the launch note before Friday.",
        forAgent: "Check the launch gates and annotate any risks.",
        source: {
          host: "relay-mcp",
          workspace: { kind: "git", key: "github.com/acme/relay", label: "relay" },
          repo: { name: "relay", originKey: "github.com/acme/relay" },
        },
        delivery: { channel: "device", state: "delivered" },
        hasAttachments: true,
        attachments: [
          {
            id: "att_1",
            name: "launch-note.pdf",
            contentType: "application/pdf",
            bytes: 2048,
            openUrl: "https://api.sendrelays.test/storage/launch-note.pdf?sig=test",
          },
        ],
      },
    },
    { statePath },
  );

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const row = state.packets.sent_relay_sent_1;
  assert.equal(result.itemId, "sent_relay_sent_1");
  assert.equal(result.relayId, "relay_sent_1");
  assert.equal(row.sourceRelayId, "relay_sent_1");
  assert.equal(row.direction, "outbound");
  assert.equal(row.relayNotificationKind, "sent_relay");
  assert.equal(row.recipient.name, "Sven");
  assert.equal(row.forHuman, "Please review the launch note before Friday.");
  assert.equal(row.forAgent, "Check the launch gates and annotate any risks.");
  assert.equal(row.attachmentUrls.att_1, "https://api.sendrelays.test/storage/launch-note.pdf?sig=test");
  assert.equal(row.attachments[0].localPath, "/tmp/relay/launch-note.pdf");
  assert.equal(row.source.workspace.key, "github.com/acme/relay");
  assert.equal(row.threadId, "thread_existing");
  assert.equal(row.materializedSurfaces.codex, true);
  const content = JSON.parse(fs.readFileSync(result.contentPath, "utf8"));
  assert.equal(content.displayTitle, "Launch note");
  assert.equal(content.forAgent, "Check the launch gates and annotate any risks.");
  assert.equal(content.recipient.email, "sven@example.com");
  assert.equal(content.source.workspace.key, "github.com/acme/relay");
  assert.equal(state.packets.relay_sent_1, undefined);
});

test("notification ledger dedupes repeated human notifications", () => {
  const ledger = {};
  const notifications = [{ id: "share_approval:task_2", kind: "share_approval" }];
  assert.equal(freshNotifications(ledger, notifications).length, 1);
  markNotificationsProcessed(ledger, notifications);
  assert.equal(freshNotifications(ledger, notifications).length, 0);
});

test("server tombstones remove already-staged rows deleted on the website or through MCP", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-suppressed-test-"));
  const statePath = companionStatePath(dir);
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    packets: {
      relay_deleted: { id: "relay_deleted", state: "unread" },
      relay_kept: { id: "relay_kept", state: "unread" },
      "task_cancelled:task_old:2026-07-07T15:37:51.741Z": {
        id: "task_cancelled:task_old:2026-07-07T15:37:51.741Z",
        relayNotificationKind: "task_cancelled",
        taskId: "task_old",
        state: "unread",
      },
    },
  }));
  assert.equal(removeSuppressedCompanionItems(["relay_deleted", "task_cancelled:task_old", "missing"], { statePath }), 2);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.packets.relay_deleted, undefined);
  assert.equal(state.packets["task_cancelled:task_old:2026-07-07T15:37:51.741Z"], undefined);
  assert.equal(state.packets.relay_kept.id, "relay_kept");
  assert.equal(removeSuppressedCompanionItems(["relay_deleted"], { statePath }), 0);
});

test("account read watermark marks only deliveries at or before the cutoff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-read-through-test-"));
  const statePath = companionStatePath(dir);
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    packets: {
      old_task: {
        id: "old_task",
        direction: "inbound",
        state: "unread",
        relayNotificationKind: "task_completed",
        createdAt: "2026-07-14T09:00:00.000Z",
      },
      new_task: {
        id: "new_task",
        direction: "inbound",
        state: "unread",
        relayNotificationKind: "task_completed",
        deliveryReferenceAt: "2026-07-14T11:00:00.000Z",
        createdAt: "2026-07-13T09:00:00.000Z",
      },
      outbound: { id: "outbound", direction: "outbound", state: "unread", createdAt: "2026-07-13T09:00:00.000Z" },
    },
  }));
  assert.equal(markCompanionItemsReadThrough("2026-07-14T10:00:00.000Z", { statePath }), 1);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.packets.old_task.state, "read");
  assert.equal(state.packets.new_task.state, "unread");
  assert.equal(state.packets.outbound.state, "unread");
});

test("read watermark applies to old task notifications but not a later restore", () => {
  const task = {
    id: "task_1",
    state: "completed",
    title: "Finished work",
    objective: "Finish it",
    updatedAt: "2026-07-14T09:00:00.000Z",
  };
  const read = buildHumanNotifications({ tasks: [task], inboxState: { readAllAt: "2026-07-14T10:00:00.000Z" } });
  assert.equal(read[0].read, true);
  const restored = buildHumanNotifications({
    tasks: [task],
    inboxState: {
      readAllAt: "2026-07-14T10:00:00.000Z",
      restoredAtByItemId: { "task_completed:task_1": "2026-07-14T11:00:00.000Z" },
    },
  });
  assert.equal(restored[0].read, false);
});

test("inbox trash suppresses notifications and a restore delivery version re-notifies", () => {
  const task = {
    id: "task_1",
    state: "completed",
    title: "Finished work",
    objective: "Finish it",
    updatedAt: "2026-07-01T10:00:00.000Z",
  };
  const id = "task_completed:task_1";
  assert.deepEqual(
    buildHumanNotifications({ tasks: [task], inboxState: { suppressedItemIds: [id] } }),
    [],
  );

  const restored = buildHumanNotifications({
    tasks: [task],
    inboxState: { restoredAtByItemId: { [id]: "2026-07-14T10:00:00.000Z" } },
  });
  const ledger = { notifications: { [id]: { kind: "task_completed", deliveryVersion: "", processedAt: "earlier" } } };
  assert.equal(restored[0].deliveryVersion, "2026-07-14T10:00:00.000Z");
  assert.equal(freshNotifications(ledger, restored).length, 1);
  markNotificationsProcessed(ledger, restored);
  assert.equal(freshNotifications(ledger, restored).length, 0);
});

test("resetCompanionStateForAccount clears stale rows from a previous account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-account-reset-test-"));
  const statePath = companionStatePath(dir);
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      account: { userId: "usr_old", email: "old@example.com", deviceId: "dev_old" },
      packets: {
        stale: { id: "stale", direction: "inbound", state: "unread", title: "Old relay" },
      },
    }),
  );

  const result = resetCompanionStateForAccount(
    { user: { id: "usr_new", email: "new@example.com" }, deviceId: "dev_new" },
    { statePath },
  );

  assert.equal(result.reset, true);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.account.userId, "usr_new");
  assert.equal(state.account.email, "new@example.com");
  assert.deepEqual(state.packets, {});
});

test("pollTaskRuntimeOnce stages Relay companion items without blocking agent polling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-notify-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const sent = [];
  const client = {
    async agentInbox() {
      return { sessions: [], messages: [] };
    },
    async me() {
      return { user: { id: "usr_1", email: "david@example.com" } };
    },
    async listTasks() {
      return {
        tasks: [
          {
            id: "task_1",
            title: "Coffee",
            objective: "Pick a time",
            state: "active",
            viewerRole: "creator",
            updatedAt: "2026-06-29T10:00:00.000Z",
            pendingApprovalCount: 1,
            participants: [],
          },
        ],
      };
    },
    async listRelays() {
      return { relays: [] };
    },
    async listConnectors() {
      return { connectors: [] };
    },
  };

  const result = await pollTaskRuntimeOnce({ client, stageCompanionItem: (notification) => sent.push(notification), log: () => {} });
  assert.equal(result.notifications.length, 1);
  assert.equal(sent[0].kind, "share_approval");

  const second = await pollTaskRuntimeOnce({ client, stageCompanionItem: (notification) => sent.push(notification), log: () => {} });
  assert.equal(second.notifications.length, 0);
});

test("pollTaskRuntimeOnce stages ordinary relays even when task runtime polling fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ordinary-poll-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const staged = [];
  const client = {
    async agentInbox() {
      throw new Error("task runtime unavailable");
    },
    async inbox() {
      return {
        items: [
          {
            relayId: "relay_1",
            state: "delivered",
            title: "Normal relay",
            sender: { name: "Jordan" },
            createdAt: "2026-06-29T10:00:00.000Z",
            updatedAt: "2026-06-29T10:00:01.000Z",
          },
        ],
      };
    },
    async fetchRelay() {
      return {
        packet: {
          schemaVersion: 2,
          id: "relay_1",
          createdAt: "2026-06-29T10:00:00.000Z",
          kind: "message",
          title: "Normal relay",
          forHuman: "Hello.",
          sender: { name: "Jordan" },
          recipient: { name: "David" },
          source: { host: "relay-mcp" },
          targetSurfaces: [],
          attachments: [],
        },
        attachmentUrls: {},
      };
    },
  };

  const result = await pollTaskRuntimeOnce({
    client,
    stagePlainRelay: (relay) => staged.push(relay),
    log: () => {},
  });

  assert.equal(result.ordinaryRelays.length, 1);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].item.relayId, "relay_1");
});

test("pollTaskRuntimeOnce restages a restored ordinary relay as a fresh unread delivery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-restored-ordinary-poll-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const restoredAt = "2026-07-14T11:00:00.000Z";
  const item = {
    relayId: "relay_restored",
    state: "read",
    title: "Restored relay",
    sender: { name: "Jordan" },
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:01.000Z",
    restoredAt,
  };
  const client = {
    async agentInbox() {
      throw new Error("task runtime unavailable");
    },
    async inbox() {
      return { items: [item] };
    },
    async fetchRelay() {
      return {
        packet: {
          schemaVersion: 2,
          id: item.relayId,
          createdAt: item.createdAt,
          kind: "message",
          title: item.title,
          forHuman: "Hello again.",
          sender: item.sender,
          recipient: { name: "David" },
          source: { host: "relay-mcp" },
          targetSurfaces: [],
          attachments: [],
        },
        attachmentUrls: {},
      };
    },
  };
  const staged = [];

  await pollTaskRuntimeOnce({
    client,
    stagePlainRelay: (payload, options) => staged.push({ payload, options }),
    log: () => {},
  });

  assert.equal(staged.length, 1);
  assert.equal(staged[0].options.forceUnread, true);

  staged.length = 0;
  await pollTaskRuntimeOnce({
    client,
    stagePlainRelay: (payload, options) => staged.push({ payload, options }),
    log: () => {},
  });
  assert.equal(staged.length, 0);
});

test("pollTaskRuntimeOnce polls visible task events and dedupes them in the ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-event-poll-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const client = {
    async agentInbox() {
      return { sessions: [], messages: [] };
    },
    async me() {
      return { user: { id: "usr_1", email: "david@example.com" } };
    },
    async listTasks() {
      return {
        tasks: [
          {
            id: "task_1",
            title: "Coffee",
            objective: "Pick a time",
            state: "active",
            viewerRole: "creator",
            updatedAt: "2026-06-29T10:00:00.000Z",
            pendingApprovalCount: 0,
            participants: [],
          },
        ],
      };
    },
    async taskEvents(taskId) {
      return {
        events: [
          {
            id: "tevt_1",
            taskId,
            sequence: 1,
            type: "task_created",
            occurredAt: "2026-06-29T10:00:00.000Z",
          },
          {
            id: "tevt_2",
            taskId,
            sequence: 2,
            type: "task_activated",
            occurredAt: "2026-06-29T10:01:00.000Z",
          },
        ],
      };
    },
    async listRelays() {
      return { relays: [] };
    },
    async listConnectors() {
      return { connectors: [] };
    },
  };

  const first = await pollTaskRuntimeOnce({ client, stageCompanionItem: () => {}, log: () => {} });
  const second = await pollTaskRuntimeOnce({ client, stageCompanionItem: () => {}, log: () => {} });

  assert.deepEqual(first.events.map((event) => event.id), ["tevt_1", "tevt_2"]);
  assert.deepEqual(second.events, []);
});

test("pollTaskRuntimeOnce heartbeats the actual runtime state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-notify-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const heartbeats = [];
  const client = {
    async agentInbox() {
      return {
        sessions: [{ id: "tsess_1", taskId: "task_1", host: "codex", state: "queued", sessionRef: {} }],
        messages: [{ id: "tmsg_1", taskId: "task_1", forHuman: "Start" }],
      };
    },
    async heartbeatSession(_sessionId, payload) {
      heartbeats.push(payload);
      return { session: { id: "tsess_1", state: payload.state } };
    },
    async postDaemonEvent() {
      return { ok: true };
    },
    async me() {
      return { user: { id: "usr_1", email: "david@example.com" } };
    },
    async listTasks() {
      return { tasks: [] };
    },
    async listRelays() {
      return { relays: [] };
    },
    async listConnectors() {
      return { connectors: [] };
    },
  };
  const adapters = {
    selectHost() {
      return { kind: "codex", installed: true };
    },
    async launchTurn() {
      return { mode: "fake", runId: "run_1" };
    },
  };

  await pollTaskRuntimeOnce({ client, adapters, stageCompanionItem: () => {}, log: () => {} });

  assert.equal(heartbeats.length, 2);
  assert.equal(heartbeats[0].state, "starting");
  assert.equal(heartbeats[1].state, "running");
});

test("pollTaskRuntimeOnce skips runtime launch when another companion owns the lease", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-notify-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const client = {
    async agentInbox() {
      return {
        sessions: [{ id: "tsess_1", taskId: "task_1", host: "codex", state: "queued", sessionRef: {} }],
        messages: [{ id: "tmsg_1", taskId: "task_1", forHuman: "Start" }],
      };
    },
    async heartbeatSession() {
      const err = new Error("leased");
      err.status = 409;
      err.body = { error: "version_conflict" };
      throw err;
    },
    async me() {
      return { user: { id: "usr_1", email: "david@example.com" } };
    },
    async listTasks() {
      return { tasks: [] };
    },
    async listRelays() {
      return { relays: [] };
    },
    async listConnectors() {
      return { connectors: [] };
    },
  };
  let launched = false;
  const adapters = {
    selectHost() {
      return { kind: "codex", installed: true };
    },
    async launchTurn() {
      launched = true;
      return { mode: "fake", runId: "run_1" };
    },
  };

  const result = await pollTaskRuntimeOnce({ client, adapters, stageCompanionItem: () => {}, log: () => {} });

  assert.equal(launched, false);
  assert.equal(result.sessions.length, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(runtime.readTaskLedger().processedMessages.tmsg_1, undefined);
});

test("pollTaskRuntimeOnce only acks messages after runtime delivery and preserves FIFO input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-notify-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const delivered = [];
  const client = {
    async agentInbox() {
      return {
        sessions: [{ id: "tsess_1", taskId: "task_1", host: "codex", state: "queued", sessionRef: {} }],
        messages: [
          { id: "tmsg_2", taskId: "task_1", kind: "relay_to_agent", createdAt: "2026-06-29T10:02:00.000Z", forHuman: "Second" },
          { id: "tmsg_1", taskId: "task_1", kind: "relay_to_agent", createdAt: "2026-06-29T10:01:00.000Z", forHuman: "First" },
        ],
      };
    },
    async heartbeatSession(_sessionId, payload) {
      return { session: { id: "tsess_1", taskId: "task_1", host: "codex", state: payload.state, sessionRef: payload.sessionRef } };
    },
    async postDaemonEvent() {
      return { ok: true };
    },
    async me() {
      return { user: { id: "usr_1", email: "david@example.com" } };
    },
    async listTasks() {
      return { tasks: [] };
    },
    async listRelays() {
      return { relays: [] };
    },
    async listConnectors() {
      return { connectors: [] };
    },
  };
  const adapters = {
    selectHost() {
      return { kind: "codex", installed: true };
    },
    async launchTurn(input) {
      delivered.push(input.messages.map((message) => message.id));
      return { mode: "fake", runId: "run_1" };
    },
  };

  const result = await pollTaskRuntimeOnce({ client, adapters, stageCompanionItem: () => {}, log: () => {} });

  assert.deepEqual(delivered, [["tmsg_1", "tmsg_2"]]);
  assert.deepEqual(result.messages.map((message) => message.id), ["tmsg_1", "tmsg_2"]);
});

test("notification ids are stable so a steady condition does not re-mint duplicates", () => {
  const task = {
    id: "task_dup", title: "T", objective: "O", state: "completed",
    viewerRole: "creator", updatedAt: "2026-07-01T00:00:00.000Z", pendingApprovalCount: 0, participants: [],
  };
  const a = buildHumanNotifications({ user: { id: "u", email: "u@x.com" }, tasks: [task] });
  const later = buildHumanNotifications({ user: { id: "u", email: "u@x.com" }, tasks: [{ ...task, updatedAt: "2026-07-02T00:00:00.000Z" }] });
  const idA = a.find((n) => n.kind === "task_completed").id;
  const idB = later.find((n) => n.kind === "task_completed").id;
  assert.equal(idA, idB, "task_completed id must not change when only updatedAt moves");
});

test("connector notification id is stable across polls (no per-poll duplicate rows)", () => {
  const mk = (lastCheckedAt) => buildHumanNotifications({
    user: { id: "u", email: "u@x.com" },
    connectors: [{ provider: "hubspot", displayName: "HubSpot", status: "expired", lastCheckedAt }],
  }).find((n) => n.kind === "connector_reauth").id;
  assert.equal(mk("2026-07-01T00:00:00.000Z"), mk("2026-07-01T00:05:00.000Z"), "connector id must not include lastCheckedAt");
});

test("a rising share-approval count re-notifies; a steady count does not", () => {
  const mk = (pendingApprovalCount) => buildHumanNotifications({
    user: { id: "u", email: "u@x.com" },
    tasks: [{ id: "task_ap", title: "T", objective: "O", state: "active", viewerRole: "creator", updatedAt: "2026-07-01T00:00:00.000Z", pendingApprovalCount, participants: [] }],
  }).find((n) => n.kind === "share_approval").id;
  assert.equal(mk(1), mk(1), "steady count keeps the same id");
  assert.notEqual(mk(1), mk(2), "a rising count re-notifies with a new id");
});

test("stagePlainRelayItem mints the task notification kind for kind:'task' items", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-task-row-test-"));
  const statePath = companionStatePath(dir);
  stagePlainRelayItem(
    {
      item: {
        relayId: "relay_task_1",
        state: "delivered",
        kind: "task",
        title: "Chase down the poll storm",
        preview: "Brief…",
        sender: { name: "Shane", email: "shane@example.com" },
        createdAt: "2026-08-12T10:00:00.000Z",
        taskState: "started",
        taskAcceptedAt: "2026-08-12T10:04:00.000Z",
        taskStartedAt: "2026-08-12T10:05:00.000Z",
      },
      packet: {
        schemaVersion: 2,
        id: "relay_task_1",
        kind: "task",
        title: "Chase down the poll storm",
        forHuman: "Repro on the VM, then propose a fix.",
        sender: { name: "Shane", email: "shane@example.com" },
        recipient: { name: "David", email: "david@example.com" },
        source: { host: "relay-mcp" },
        attachments: [],
      },
    },
    { statePath },
  );
  const row = JSON.parse(fs.readFileSync(statePath, "utf8")).packets.relay_task_1;
  assert.equal(row.relayNotificationKind, "task");
  assert.equal(row.kind, "task");
  assert.equal(row.taskState, "started");
  assert.equal(row.taskAcceptedAt, "2026-08-12T10:04:00.000Z");
  assert.equal(row.taskStartedAt, "2026-08-12T10:05:00.000Z");
  assert.equal(row.taskCompletedAt, null);
});
