import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  finishSetupOpenRelay,
  normalizeSetupHost,
  setupOpenStatus,
  setupOpenRelayToken,
  stageCurrentInbox,
} from "../src/setup-open.js";
import { stagePlainRelayItem } from "../src/notifications.js";
import { pollTaskRuntimeOnce } from "../src/task-daemon.js";

const relay = {
  relayId: "relay_123",
  title: "Investor note",
  kind: "message",
  sender: { name: "Sven" },
  preview: "Please review the updated note.",
  forHuman: "Please review the updated note.",
  attachments: [],
  createdAt: "2026-07-01T10:00:00.000Z",
  recipientEmail: "jordan@example.com",
  recipientOnRelay: true,
};

const packet = {
  schemaVersion: 2,
  id: "relay_123",
  createdAt: relay.createdAt,
  kind: "message",
  title: relay.title,
  displayTitle: "From Sven: Investor note",
  forHuman: relay.forHuman,
  forAgent: "",
  sender: { name: "Sven", email: "sven@example.com" },
  recipient: { name: "Jordan", email: "jordan@example.com" },
  source: { host: "relay-mcp" },
  targetSurfaces: ["codex"],
  attachments: [],
};

test("setup flag helpers normalize public relay open intent", () => {
  assert.equal(setupOpenRelayToken({ "open-relay": "tok_123" }), "tok_123");
  assert.equal(setupOpenRelayToken({ openRelay: "tok_456" }), "tok_456");
  assert.equal(setupOpenRelayToken({}), null);
  assert.equal(normalizeSetupHost("codex"), "codex");
  assert.equal(normalizeSetupHost("claude_code"), "claude");
});

test("stageCurrentInbox fetches and stages every authenticated inbox relay", async () => {
  const staged = [];
  const client = {
    async inbox() {
      return {
        items: [
          {
            relayId: "relay_123",
            state: "delivered",
            kind: "message",
            title: relay.title,
            displayTitle: relay.title,
            sender: relay.sender,
            preview: relay.preview,
            hasAttachments: false,
            createdAt: relay.createdAt,
          },
        ],
      };
    },
    async fetchRelay(id) {
      assert.equal(id, "relay_123");
      return { packet, attachmentUrls: {} };
    },
  };

  const ids = await stageCurrentInbox({
    client,
    stage: ({ item, packet: stagedPacket }) => staged.push({ item, packet: stagedPacket }),
  });

  assert.deepEqual(ids, ["relay_123"]);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].item.relayId, "relay_123");
  assert.equal(staged[0].packet.forHuman, relay.forHuman);
});

test("setup inbox staging can force all imported relays unread", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-unread-test-"));
  const statePath = path.join(dir, "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      packets: {
        relay_123: { id: "relay_123", direction: "inbound", state: "read", title: "Old local state" },
      },
    }),
  );
  const client = {
    async inbox() {
      return {
        items: [
          {
            relayId: "relay_123",
            state: "read",
            kind: "message",
            title: relay.title,
            displayTitle: relay.title,
            sender: relay.sender,
            preview: relay.preview,
            hasAttachments: false,
            createdAt: relay.createdAt,
          },
          {
            relayId: "relay_456",
            state: "delivered",
            kind: "message",
            title: "Second relay",
            displayTitle: "Second relay",
            sender: relay.sender,
            preview: "Second",
            hasAttachments: false,
            createdAt: relay.createdAt,
          },
        ],
      };
    },
    async fetchRelay(id) {
      return {
        packet: { ...packet, id, title: id === "relay_456" ? "Second relay" : packet.title },
        attachmentUrls: {},
      };
    },
  };

  await stageCurrentInbox({
    client,
    forceUnread: true,
    stage: (payload, options) => stagePlainRelayItem(payload, { ...options, statePath }),
  });

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.packets.relay_123.state, "unread");
  assert.equal(state.packets.relay_456.state, "unread");
});

test("daemon polling preserves setup-imported unread relays until local read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-daemon-unread-test-"));
  const statePath = path.join(dir, "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const serverReadItem = {
    relayId: "relay_123",
    state: "read",
    kind: "message",
    title: relay.title,
    displayTitle: relay.title,
    sender: relay.sender,
    preview: relay.preview,
    hasAttachments: false,
    createdAt: relay.createdAt,
    updatedAt: "2026-07-01T10:01:00.000Z",
  };

  stagePlainRelayItem(
    { item: serverReadItem, packet, attachmentUrls: {} },
    { statePath, forceUnread: true },
  );

  const before = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(before.packets.relay_123.state, "unread");
  assert.equal(before.packets.relay_123.setupImportedUnread, true);

  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = dir;
  try {
    const client = {
      async agentInbox() {
        return { messages: [], sessions: [] };
      },
      async inbox() {
        return { items: [serverReadItem] };
      },
      async fetchRelay(id) {
        assert.equal(id, "relay_123");
        return { packet, attachmentUrls: {} };
      },
      async me() {
        return { user: { id: "usr_1", name: "Jordan", email: "jordan@example.com" } };
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

    await pollTaskRuntimeOnce({
      client,
      stageCompanionItem: () => {},
      stagePlainRelay: (payload, options) => stagePlainRelayItem(payload, { ...options, statePath }),
      log: () => {},
    });
  } finally {
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
  }

  const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(after.packets.relay_123.state, "unread");
});

test("finishSetupOpenRelay binds token, stages inbox, and opens the real relay id", async () => {
  const calls = [];
  const client = {
    async bindOpenRelay(token) {
      calls.push(["bind", token]);
      return { ok: true, relay };
    },
    async inbox() {
      calls.push(["inbox"]);
      return {
        items: [
          {
            relayId: "relay_123",
            state: "delivered",
            kind: "message",
            title: relay.title,
            displayTitle: relay.title,
            sender: relay.sender,
            preview: relay.preview,
            hasAttachments: false,
            createdAt: relay.createdAt,
          },
        ],
      };
    },
    async fetchRelay(id) {
      calls.push(["fetch", id]);
      return { packet, attachmentUrls: {} };
    },
  };
  const staged = [];
  const opened = [];

  const result = await finishSetupOpenRelay({
    token: "public_token",
    host: "codex",
    client,
    stage: ({ item }, options) => {
      assert.equal(options.forceUnread, true);
      staged.push(item.relayId);
    },
    openRelayFn: async ({ id, host }) => {
      opened.push({ id, host });
      return { id, host, url: `codex://threads/thread_1` };
    },
  });

  assert.deepEqual(calls, [["bind", "public_token"], ["inbox"], ["fetch", "relay_123"]]);
  assert.deepEqual(staged, ["relay_123"]);
  assert.deepEqual(opened, [{ id: "relay_123", host: "codex" }]);
  assert.equal(result.relayId, "relay_123");
  assert.equal(result.opened.url, "codex://threads/thread_1");
});

test("setup open status uses URL fallback when the host did not foreground directly", () => {
  const openedUrls = [];
  assert.equal(setupOpenStatus({ openedInHost: true, url: "codex://threads/1" }).opened, true);
  assert.deepEqual(
    setupOpenStatus(
      { openedInHost: false, skipExternalOpen: false, url: "codex://threads/1" },
      (url) => {
        openedUrls.push(url);
        return true;
      },
    ),
    { opened: true, fallbackAttempted: true, url: "codex://threads/1" },
  );
  assert.deepEqual(openedUrls, ["codex://threads/1"]);
});
