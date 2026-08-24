import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import e2eeIdentity from "../src/e2ee-identity.cjs";
import {
  canonicalKeyPackageProof,
  canonicalMlsCredential,
  canonicalTransparencyChain,
  canonicalTransparencyEntry,
  E2EE_TRANSPARENCY_EMPTY_HASH,
  cachePlaintext,
  e2eeOutboxPath,
  e2eeImportedHistoryPath,
  importE2eeHistoryRecords,
  readCachedPlaintext,
  readImportedE2eeHistoryRecord,
  readPendingE2eeOutbox,
  removeCachedPlaintext,
  removeImportedE2eeHistoryRecord,
  removeLocalE2eeAttachmentDirectory,
} from "../src/e2ee-state.js";
import {
  decryptE2eeWireMessage,
  e2eeInboxItem,
  e2eePacket,
  encryptE2eeMessage,
  ensureE2eeKeyPackages,
  verifiedE2eeStatus,
} from "../src/e2ee-mls.js";
import { e2eeChat, e2eeChatList } from "../src/e2ee-sync.js";
import { offerE2eeDeviceHistory, syncE2eeDeviceHistory } from "../src/e2ee-device-history.js";

const { createDeviceCrossSignature, createPairingIdentity, persistPairedIdentity } = e2eeIdentity;

test("an authenticated deletion can scrub Companion-managed local message data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-delete-local-"));
  const options = { env: { RELAY_CONFIG_DIR: root }, homeDir: root };
  const messageId = "erelay_local_delete_123456789";
  try {
    const identity = enrolledIdentity(root, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
    const plaintext = { eventId: messageId, forHuman: "erase me" };
    const wire = { relayId: messageId };
    cachePlaintext(identity, messageId, plaintext, options);
    importE2eeHistoryRecords(identity, [{ wire, plaintext }], options);
    const attachmentRoot = path.join(path.dirname(e2eeImportedHistoryPath(options)), "attachments", messageId);
    fs.mkdirSync(attachmentRoot, { recursive: true });
    fs.writeFileSync(path.join(attachmentRoot, "secret.bin"), "secret");

    assert.equal(removeCachedPlaintext(identity, messageId, options), true);
    assert.equal(removeImportedE2eeHistoryRecord(identity, messageId, options), true);
    removeLocalE2eeAttachmentDirectory(messageId, options);
    assert.equal(readCachedPlaintext(identity, messageId, options), null);
    assert.equal(readImportedE2eeHistoryRecord(identity, messageId, options), null);
    assert.equal(fs.existsSync(attachmentRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Companion canonical E2EE values match the published wire contract", () => {
  assert.equal(
    canonicalTransparencyEntry({
      sequence: "1",
      type: "device_enrolled",
      relayUserId: "usr_alice",
      deviceId: "dev_alice",
      protocol: "mls10",
      cipherSuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      signaturePublicKey: "public-key",
      fingerprint: "fingerprint",
      deviceExpiresAt: "2027-08-20T12:00:00.000Z",
      createdAt: "2026-08-20T12:00:00.000Z",
    }),
    '["relay-key-transparency-entry-v1","1","device_enrolled","usr_alice","dev_alice","mls10","MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519","public-key","fingerprint","2027-08-20T12:00:00.000Z","2026-08-20T12:00:00.000Z"]',
  );
  assert.equal(
    canonicalKeyPackageProof({ deviceId: "dev_alice", packageRef: "ref", keyPackage: "package", expiresAt: "expiry" }),
    '["relay-e2ee-key-package-v1","dev_alice","ref","package","expiry"]',
  );
  assert.equal(
    canonicalMlsCredential({ relayUserId: "usr_alice", deviceId: "dev_alice", fingerprint: "fingerprint" }),
    '{"version":1,"context":"relay-e2ee-mls-credential-v1","relayUserId":"usr_alice","deviceId":"dev_alice","fingerprint":"fingerprint"}',
  );
});

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function enrolledIdentity(root, { userId, deviceId, name }) {
  const pairingCode = "ABCDEFGH";
  const generated = createPairingIdentity({ pairingCode, name, platform: "test" });
  persistPairedIdentity(generated.state, {
    deviceId,
    user: { id: userId },
    e2ee: { fingerprint: generated.state.fingerprint },
  }, { env: { RELAY_CONFIG_DIR: root }, homeDir: root });
  return { ...generated.state, userId, deviceId, name };
}

function transparencyLog(identities) {
  let priorHeadHash = E2EE_TRANSPARENCY_EMPTY_HASH;
  const heads = [priorHeadHash];
  const entries = identities.map((identity, index) => {
    const input = {
      sequence: String(index + 1),
      type: "device_enrolled",
      relayUserId: identity.userId,
      deviceId: identity.deviceId,
      protocol: identity.protocol,
      cipherSuite: identity.cipherSuite,
      signaturePublicKey: identity.signaturePublicKey,
      fingerprint: identity.fingerprint,
      deviceExpiresAt: "2027-08-20T12:00:00.000Z",
      createdAt: new Date(Date.UTC(2026, 7, 20, 12, 0, index)).toISOString(),
    };
    const entryHash = digest(canonicalTransparencyEntry(input));
    const headHash = digest(canonicalTransparencyChain(priorHeadHash, entryHash));
    const entry = { ...input, priorHeadHash, entryHash, headHash };
    priorHeadHash = headHash;
    heads.push(headHash);
    return entry;
  });
  return { entries, heads };
}

function appendTransparencyEvent(log, identity, type) {
  const sequence = String(log.entries.length + 1);
  const priorHeadHash = log.heads.at(-1);
  const input = {
    sequence,
    type,
    relayUserId: identity.userId,
    deviceId: identity.deviceId,
    protocol: identity.protocol,
    cipherSuite: identity.cipherSuite,
    signaturePublicKey: identity.signaturePublicKey,
    fingerprint: identity.fingerprint,
    deviceExpiresAt: "2027-08-20T12:00:00.000Z",
    createdAt: new Date(Date.UTC(2026, 7, 20, 13, 0, log.entries.length)).toISOString(),
  };
  const entryHash = digest(canonicalTransparencyEntry(input));
  const headHash = digest(canonicalTransparencyChain(priorHeadHash, entryHash));
  log.entries.push({ ...input, priorHeadHash, entryHash, headHash });
  log.heads.push(headHash);
}

class FakeE2eeService {
  constructor(identities) {
    this.identities = new Map(identities.map((identity) => [identity.deviceId, identity]));
    this.log = transparencyLog(identities);
    this.packages = new Map();
    this.preparations = new Map();
    this.messages = [];
    this.mode = "required";
    this.prepareCalls = 0;
    this.sendAttempts = [];
    this.failAfterAcceptedSends = 0;
    this.crossSignatures = [];
    this.historyPreparations = new Map();
    this.historyTransfers = [];
  }

  client(identity) {
    const service = this;
    return {
      async e2eeStatus() {
        return { mode: service.mode, protocol: identity.protocol, cipherSuite: identity.cipherSuite };
      },
      async e2eeTransparencySync({ afterSize, limit }) {
        const after = Number(afterSize);
        const entries = service.log.entries.slice(after, after + limit);
        const size = String(after + entries.length);
        return {
          from: { size: String(after), headHash: service.log.heads[after] },
          checkpoint: { size, headHash: service.log.heads[Number(size)] },
          entries,
          complete: Number(size) === service.log.entries.length,
        };
      },
      async e2eeKeyPackageStatus() {
        const available = (service.packages.get(identity.deviceId) || []).filter((item) => !item.claimed).length;
        return { available, target: 3 };
      },
      async e2eeDirectory(relayUserId) {
        const activeDeviceIds = new Set(
          [...service.identities.values()]
            .filter((candidate) => candidate.userId === relayUserId)
            .filter((candidate) => {
              const events = service.log.entries.filter((entry) => entry.deviceId === candidate.deviceId);
              return events.at(-1)?.type === "device_enrolled";
            })
            .map((candidate) => candidate.deviceId),
        );
        const devices = [...service.identities.values()]
          .filter((candidate) => candidate.userId === relayUserId && activeDeviceIds.has(candidate.deviceId))
          .map((device) => ({
            deviceId: device.deviceId,
            protocol: device.protocol,
            cipherSuite: device.cipherSuite,
            signaturePublicKey: device.signaturePublicKey,
            fingerprint: device.fingerprint,
            enrolledAt: service.log.entries.find((entry) => entry.deviceId === device.deviceId).createdAt,
          }));
        return {
          relayUserId,
          revision: "test-directory",
          devices,
          crossSignatures: service.crossSignatures.filter((proof) => proof.relayUserId === relayUserId),
        };
      },
      async e2eeUploadKeyPackages(packages) {
        const current = service.packages.get(identity.deviceId) || [];
        for (const item of packages) {
          if (!current.some((known) => known.packageRef === item.packageRef)) current.push({ ...item, claimed: false });
        }
        service.packages.set(identity.deviceId, current);
        return {
          accepted: packages.map((item) => item.packageRef),
          available: current.filter((item) => !item.claimed).length,
        };
      },
      async e2eePrepareSend(request) {
        service.prepareCalls += 1;
        const recipientDevices = [...service.identities.values()]
          .filter((candidate) => candidate.userId === request.recipient.relayUserId);
        const senderDevices = [...service.identities.values()]
          .filter((candidate) => candidate.userId === identity.userId);
        const targets = [...recipientDevices, ...senderDevices].map((device) => {
          const chosen = (service.packages.get(device.deviceId) || []).find((item) => !item.claimed);
          if (!chosen) throw new Error("recipient package exhausted");
          chosen.claimed = true;
          return {
            relayUserId: device.userId,
            deliveryKind: device.userId === identity.userId ? "sender_copy" : "recipient",
            device: {
              deviceId: device.deviceId,
              protocol: device.protocol,
              cipherSuite: device.cipherSuite,
              signaturePublicKey: device.signaturePublicKey,
              fingerprint: device.fingerprint,
              enrolledAt: service.log.entries.find((entry) => entry.deviceId === device.deviceId).createdAt,
            },
            keyPackageId: `kp:${chosen.packageRef}`,
            packageRef: chosen.packageRef,
            keyPackage: chosen.keyPackage,
          };
        });
        const preparationId = `prep:${request.idempotencyKey}`;
        service.preparations.set(preparationId, { request, recipientDevices, targets });
        return {
          preparationId,
          recipient: { relayUserId: request.recipient.relayUserId, name: recipientDevices[0].name },
          targets,
          checkpoint: {
            size: String(service.log.entries.length),
            headHash: service.log.heads.at(-1),
          },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
      async e2eeSendMessage(payload) {
        const prep = service.preparations.get(payload.preparationId);
        const createdAt = new Date().toISOString();
        service.sendAttempts.push(JSON.parse(JSON.stringify(payload)));
        if (!service.messages.some((message) => message.relayId === payload.messageId)) {
          for (const target of prep.targets) {
            service.messages.push({
              relayId: payload.messageId,
              state: "delivered",
              createdAt,
              updatedAt: createdAt,
              sender: { relayUserId: identity.userId, deviceId: identity.deviceId, name: identity.name },
              recipient: {
                relayUserId: prep.recipientDevices[0].userId,
                deviceId: target.device.deviceId,
                name: prep.recipientDevices[0].name,
              },
              delivery: {
                kind: target.deliveryKind,
                ownerUserId: target.relayUserId,
                deviceId: target.device.deviceId,
              },
              keyPackageRef: target.packageRef,
              welcome: payload.welcome,
              ratchetTree: payload.ratchetTree,
              ciphertext: payload.ciphertext,
              attachments: (payload.attachments || []).map(({ ciphertext: attachmentCiphertext, ...attachment }) => ({
                ...attachment,
                downloadUrl: `data:application/octet-stream;base64,${Buffer.from(attachmentCiphertext, "base64url").toString("base64")}`,
              })),
              senderCheckpoint: payload.senderCheckpoint,
              ...(prep.request.inReplyToRelayId ? { inReplyToRelayId: prep.request.inReplyToRelayId } : {}),
            });
          }
        }
        const response = {
          relayId: payload.messageId,
          state: "delivered",
          deliveredVia: "device",
          recipient: { relayUserId: prep.recipientDevices[0].userId, name: prep.recipientDevices[0].name, onRelay: true },
        };
        if (service.failAfterAcceptedSends > 0) {
          service.failAfterAcceptedSends -= 1;
          throw new Error("connection closed after the service committed the ciphertext");
        }
        return response;
      },
      async e2eeInbox() {
        return { items: service.messages.filter((message) =>
          message.delivery.deviceId === identity.deviceId && message.delivery.kind === "recipient") };
      },
      async e2eeSent() {
        return { items: service.messages.filter((message) =>
          message.delivery.deviceId === identity.deviceId && message.delivery.kind === "sender_copy") };
      },
      async e2eeSync() {
        return { items: service.messages.filter((message) => message.delivery.deviceId === identity.deviceId) };
      },
      async e2eeFetchMessages(ids) {
        return {
          packets: Object.fromEntries(service.messages
            .filter((message) => message.delivery.deviceId === identity.deviceId && ids.includes(message.relayId))
            .map((message) => [message.relayId, message])),
        };
      },
      async e2eePrepareDeviceHistory(request) {
        const target = service.identities.get(request.targetDeviceId);
        if (!target || target.userId !== identity.userId) throw new Error("untrusted history target");
        const chosen = (service.packages.get(target.deviceId) || []).find((item) => !item.claimed);
        if (!chosen) throw new Error("history target package exhausted");
        chosen.claimed = true;
        const transferId = `edhist_${digest(`${identity.deviceId}:${request.idempotencyKey}`).slice(0, 24)}`;
        service.historyPreparations.set(transferId, { source: identity, target, chosen });
        return {
          transferId,
          target: {
            relayUserId: target.userId,
            device: {
              deviceId: target.deviceId,
              protocol: target.protocol,
              cipherSuite: target.cipherSuite,
              signaturePublicKey: target.signaturePublicKey,
              fingerprint: target.fingerprint,
              enrolledAt: service.log.entries.find((entry) => entry.deviceId === target.deviceId).createdAt,
            },
            keyPackageId: `kp:${chosen.packageRef}`,
            packageRef: chosen.packageRef,
            keyPackage: chosen.keyPackage,
          },
          checkpoint: { size: String(service.log.entries.length), headHash: service.log.heads.at(-1) },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
      async e2eeUploadDeviceHistory(payload) {
        const preparation = service.historyPreparations.get(payload.transferId);
        if (!preparation || preparation.source.deviceId !== identity.deviceId) throw new Error("unknown history transfer");
        if (!service.historyTransfers.some((item) => item.transferId === payload.transferId)) {
          service.historyTransfers.push({
            ...payload,
            source: { relayUserId: identity.userId, deviceId: identity.deviceId, name: identity.name },
            targetDeviceId: preparation.target.deviceId,
            keyPackageRef: preparation.chosen.packageRef,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }
        return { transferId: payload.transferId, state: "available" };
      },
      async e2eeDeviceHistory() {
        return { items: service.historyTransfers.filter((item) => item.targetDeviceId === identity.deviceId) };
      },
      async e2eeAcknowledgeDeviceHistory(transferId) {
        service.historyTransfers = service.historyTransfers.filter((item) => item.transferId !== transferId);
        return { ok: true, transferId };
      },
    };
  }
}

test("enrolled Companions exchange one-to-one text while the service stores ciphertext only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-one-to-one-"));
  const aliceRoot = path.join(root, "alice");
  const bobRoot = path.join(root, "bob");
  const alice = enrolledIdentity(aliceRoot, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([alice, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    const bobClient = service.client(bob);
    await ensureE2eeKeyPackages(bobClient);

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const aliceClient = service.client(alice);
    const sent = await encryptE2eeMessage(aliceClient, {
      recipient: { relayUserId: bob.userId },
      title: "Weekend",
      forHuman: "The picnic starts at eleven.",
      forAgent: "Bring the blue blanket.",
      attachments: [{
        id: "att_picnic",
        name: "picnic-plan.txt",
        contentType: "text/plain",
        bytes: 27,
        sha256: createHash("sha256").update("Blue blanket, fruit, water.").digest("hex"),
        contentBase64: Buffer.from("Blue blanket, fruit, water.").toString("base64"),
      }],
      idempotencyKey: "e2ee-test-send-1",
    });
    assert.match(sent.relayId, /^erelay_/);
    assert.equal(JSON.stringify(service.messages).includes("The picnic starts at eleven."), false);
    assert.equal(JSON.stringify(service.messages).includes("Bring the blue blanket."), false);
    assert.equal(JSON.stringify(service.messages).includes("picnic-plan.txt"), false);
    assert.equal(JSON.stringify(service.messages).includes("Blue blanket, fruit, water."), false);

    const [senderWire] = (await aliceClient.e2eeSent()).items;
    const senderOpened = await decryptE2eeWireMessage(aliceClient, senderWire);
    assert.equal(senderOpened.version, 2);
    assert.equal(senderOpened.eventType, "message.created");
    assert.equal(senderOpened.eventId, sent.relayId);
    assert.equal(senderOpened.messageId, sent.relayId);
    assert.equal(senderOpened.conversation.threadId, sent.relayId);
    assert.equal(senderOpened.forHuman, "The picnic starts at eleven.");
    const senderChats = await e2eeChatList(aliceClient, (await aliceClient.e2eeSync()).items);
    assert.equal(senderChats.chats.length, 1);
    assert.equal(senderChats.chats[0].lastMessage.direction, "outbound");
    const senderChat = await e2eeChat(aliceClient, (await aliceClient.e2eeSync()).items, senderChats.chats[0].chatId);
    assert.equal(senderChat.items[0].direction, "outbound");

    // Revoking the sender later must not invalidate a message that authenticated
    // the device at its earlier transparency checkpoint.
    appendTransparencyEvent(service.log, alice, "device_revoked");

    process.env.RELAY_CONFIG_DIR = bobRoot;
    const [wire] = (await bobClient.e2eeInbox()).items;
    const opened = await decryptE2eeWireMessage(bobClient, wire);
    assert.equal(opened.title, "Weekend");
    assert.equal(opened.forHuman, "The picnic starts at eleven.");
    assert.equal(opened.forAgent, "Bring the blue blanket.");
    assert.equal(opened.senderUserId, alice.userId);
    assert.equal(opened.attachmentMetadata[0].name, "picnic-plan.txt");
    const packet = await e2eePacket(wire, opened);
    assert.equal(packet.packet.attachments.length, 1);
    assert.equal(fs.readFileSync(packet.packet.attachments[0].localPath, "utf8"), "Blue blanket, fruit, water.");
    const tampered = structuredClone(wire);
    tampered.attachments[0].ciphertextSha256 = "A".repeat(43);
    await assert.rejects(
      decryptE2eeWireMessage(bobClient, tampered),
      /attachment metadata could not be authenticated/,
    );

    // The one-time private package is erased only after an authenticated local cache is durable.
    const openedAgain = await decryptE2eeWireMessage(bobClient, wire);
    assert.deepEqual(openedAgain, opened);

    service.mode = "off";
    await assert.rejects(
      verifiedE2eeStatus(bobClient),
      /attempted to downgrade this device from required E2EE mode to off/,
    );
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a history import authenticates its quiet marker and keeps an old Task inert", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-history-marker-"));
  const aliceRoot = path.join(root, "alice");
  const bobRoot = path.join(root, "bob");
  const alice = enrolledIdentity(aliceRoot, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([alice, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    const bobClient = service.client(bob);
    await ensureE2eeKeyPackages(bobClient);
    process.env.RELAY_CONFIG_DIR = aliceRoot;
    await encryptE2eeMessage(service.client(alice), {
      recipient: { relayUserId: bob.userId },
      kind: "task",
      forHuman: "An earlier Task that must not run again.",
      forAgent: "Historical agent instructions.",
      idempotencyKey: "history-import-marker-1",
      historyImport: true,
      historyImportEdited: true,
      historyImportDeleted: false,
      historyImportTaskState: "completed",
    });
    assert.equal(service.sendAttempts[0].historyImport, true);
    assert.equal(JSON.stringify(service.sendAttempts).includes("must not run again"), false);

    process.env.RELAY_CONFIG_DIR = bobRoot;
    const [wire] = (await bobClient.e2eeInbox()).items;
    const opened = await decryptE2eeWireMessage(bobClient, wire);
    const item = e2eeInboxItem(wire, opened);
    assert.deepEqual(opened.historyImport, { version: 1 });
    assert.equal(opened.task.state, "completed");
    assert.equal(opened.editedAt, opened.authoredAt);
    assert.equal(item.historyImported, true);
    assert.equal(item.state, "acknowledged");
    assert.equal(item.taskState, "completed");
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("threading, edits, deletion, reactions, and read state stay inside encrypted events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-metadata-events-"));
  const aliceRoot = path.join(root, "alice");
  const bobRoot = path.join(root, "bob");
  const alice = enrolledIdentity(aliceRoot, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([alice, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    const bobClient = service.client(bob);
    await ensureE2eeKeyPackages(bobClient);
    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const aliceClient = service.client(alice);
    const created = await encryptE2eeMessage(aliceClient, {
      recipient: { relayUserId: bob.userId },
      forHuman: "Original private message.",
      forAgent: "",
      idempotencyKey: "metadata-create-1",
    });
    await encryptE2eeMessage(aliceClient, {
      recipient: {},
      forHuman: "Edited private message.",
      idempotencyKey: "metadata-edit-1",
      e2eeEvent: { type: "message.edited", targetRelayId: created.relayId },
    });

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    await ensureE2eeKeyPackages(aliceClient);
    process.env.RELAY_CONFIG_DIR = bobRoot;
    await encryptE2eeMessage(bobClient, {
      recipient: {},
      forHuman: "",
      idempotencyKey: "metadata-reaction-1",
      e2eeEvent: { type: "reaction.changed", targetRelayId: created.relayId, emoji: "👍", action: "add" },
    });

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    await ensureE2eeKeyPackages(aliceClient);
    process.env.RELAY_CONFIG_DIR = bobRoot;
    await encryptE2eeMessage(bobClient, {
      recipient: {},
      forHuman: "",
      idempotencyKey: "metadata-read-1",
      e2eeEvent: { type: "receipt.changed", targetRelayId: created.relayId, state: "read" },
    });

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    await ensureE2eeKeyPackages(aliceClient);
    process.env.RELAY_CONFIG_DIR = bobRoot;
    const reply = await encryptE2eeMessage(bobClient, {
      recipient: {},
      inReplyToRelayId: created.relayId,
      forHuman: "Private threaded reply.",
      forAgent: "",
      idempotencyKey: "metadata-reply-1",
    });

    assert.ok([...service.preparations.values()].every((entry) => !("inReplyToRelayId" in entry.request)));
    assert.equal(JSON.stringify(service.messages).includes("Edited private message."), false);
    assert.equal(JSON.stringify(service.messages).includes("Private threaded reply."), false);
    assert.equal(JSON.stringify(service.messages).includes("👍"), false);

    const openedReply = await decryptE2eeWireMessage(
      bobClient,
      service.messages.find((message) => message.relayId === reply.relayId && message.delivery.deviceId === bob.deviceId),
    );
    assert.equal(openedReply.conversation.replyToMessageId, created.relayId);
    assert.equal(openedReply.conversation.threadId, created.relayId);

    const chats = await e2eeChatList(bobClient, (await bobClient.e2eeSync()).items);
    const chat = await e2eeChat(bobClient, (await bobClient.e2eeSync()).items, chats.chats[0].chatId);
    const original = chat.items.find((item) => item.relayId === created.relayId);
    assert.equal(original.forHuman, "Edited private message.");
    assert.equal(original.reactions.aggregates[0].emoji, "👍");
    assert.equal(original.reactions.aggregates[0].count, 1);
    assert.equal(chat.items.find((item) => item.relayId === reply.relayId).inReplyToRelayId, created.relayId);

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const aliceChat = await e2eeChat(aliceClient, (await aliceClient.e2eeSync()).items, chats.chats[0].chatId);
    assert.match(aliceChat.items.find((item) => item.relayId === created.relayId).readAt, /^\d{4}-/);
    assert.equal(aliceChat.items.find((item) => item.relayId === created.relayId).readReceipts[0].seen, true);

    await encryptE2eeMessage(aliceClient, {
      recipient: {},
      forHuman: "",
      idempotencyKey: "metadata-delete-1",
      e2eeEvent: { type: "message.deleted", targetRelayId: created.relayId },
    });
    const deletedChat = await e2eeChat(aliceClient, (await aliceClient.e2eeSync()).items, chats.chats[0].chatId);
    const deleted = deletedChat.items.find((item) => item.relayId === created.relayId);
    assert.equal(deleted.forHuman, "Message deleted");
    assert.ok(deleted.deletedAt);
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one-to-one retries resend the exact durable ciphertext after an ambiguous failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-direct-outbox-"));
  const aliceRoot = path.join(root, "alice");
  const bobRoot = path.join(root, "bob");
  const alice = enrolledIdentity(aliceRoot, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([alice, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  const input = {
    messageId: "erelay_retry_exact_wire",
    recipient: { relayUserId: bob.userId },
    forHuman: "Retry this exact private sentence.",
    forAgent: "",
    attachments: [{
      id: "att_retry",
      name: "retry-secret.txt",
      contentType: "text/plain",
      bytes: 25,
      sha256: createHash("sha256").update("Retry attachment payload.").digest("hex"),
      contentBase64: Buffer.from("Retry attachment payload.").toString("base64"),
    }],
    idempotencyKey: "e2ee-direct-retry-1",
  };
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    await ensureE2eeKeyPackages(service.client(bob));
    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const client = service.client(alice);
    service.failAfterAcceptedSends = 1;
    await assert.rejects(
      encryptE2eeMessage(client, input),
      /connection closed after the service committed/,
    );

    const entryId = `direct:${input.messageId}`;
    const pending = readPendingE2eeOutbox(alice, entryId);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.wire, service.sendAttempts[0]);
    const localBytes = fs.readFileSync(e2eeOutboxPath(), "utf8");
    assert.equal(localBytes.includes(input.forHuman), false, "the durable outbox remains encrypted at rest");
    assert.equal(localBytes.includes("retry-secret.txt"), false, "attachment metadata remains encrypted at rest");

    const sent = await encryptE2eeMessage(client, input);
    assert.equal(sent.relayId, input.messageId);
    assert.equal(service.prepareCalls, 1, "retry does not reserve another recipient KeyPackage");
    assert.equal(service.messages.length, 2, "the idempotent service stores one delivery per participant device");
    assert.equal(service.sendAttempts.length, 2);
    assert.deepEqual(service.sendAttempts[1], service.sendAttempts[0], "retry resends identical MLS bytes");

    const completed = readPendingE2eeOutbox(alice, entryId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(await encryptE2eeMessage(client, input), sent);
    assert.equal(service.sendAttempts.length, 2, "a completed duplicate is answered locally without re-encryption");
    await assert.rejects(
      encryptE2eeMessage(client, { ...input, forHuman: "Different content." }),
      /already bound to different content/,
    );
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cross-signed new device imports prior messages and attachments without server plaintext", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-new-device-history-"));
  const desktopRoot = path.join(root, "desktop");
  const mobileRoot = path.join(root, "mobile");
  const bobRoot = path.join(root, "bob");
  const desktop = enrolledIdentity(desktopRoot, { userId: "usr_alice", deviceId: "dev_alice_desktop", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([desktop, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    await ensureE2eeKeyPackages(service.client(bob));
    process.env.RELAY_CONFIG_DIR = desktopRoot;
    const desktopClient = service.client(desktop);
    await encryptE2eeMessage(desktopClient, {
      recipient: { relayUserId: bob.userId },
      forHuman: "This existed before the phone was paired.",
      forAgent: "",
      attachments: [{
        id: "att_before_mobile",
        name: "before-mobile.txt",
        contentType: "text/plain",
        bytes: 25,
        sha256: createHash("sha256").update("Attachment before mobile.").digest("hex"),
        contentBase64: Buffer.from("Attachment before mobile.").toString("base64"),
      }],
      idempotencyKey: "history-source-message-1",
    });

    const mobile = enrolledIdentity(mobileRoot, {
      userId: desktop.userId,
      deviceId: "dev_alice_mobile",
      name: "Alice mobile",
    });
    service.identities.set(mobile.deviceId, mobile);
    appendTransparencyEvent(service.log, mobile, "device_enrolled");
    const approval = createDeviceCrossSignature(desktop, mobile);
    service.crossSignatures.push({
      relayUserId: desktop.userId,
      signerDeviceId: desktop.deviceId,
      signerFingerprint: desktop.fingerprint,
      ...approval,
    });
    process.env.RELAY_CONFIG_DIR = mobileRoot;
    const mobileClient = service.client(mobile);
    await ensureE2eeKeyPackages(mobileClient);

    process.env.RELAY_CONFIG_DIR = desktopRoot;
    const offered = await offerE2eeDeviceHistory(desktopClient, mobile.deviceId, {
      idempotencyKey: "alice-mobile-history-1",
    });
    assert.equal(offered.messageCount, 1);
    assert.equal(JSON.stringify(service.historyTransfers).includes("This existed before"), false);
    assert.equal(JSON.stringify(service.historyTransfers).includes("Attachment before mobile"), false);

    process.env.RELAY_CONFIG_DIR = mobileRoot;
    const synced = await syncE2eeDeviceHistory(mobileClient);
    assert.equal(synced.imported, 1);
    assert.equal(service.historyTransfers.length, 0, "acknowledgement erases the temporary server transfer");
    const chats = await e2eeChatList(mobileClient, (await mobileClient.e2eeSync()).items);
    assert.equal(chats.chats.length, 1);
    assert.equal(chats.chats[0].lastMessage.preview, "This existed before the phone was paired.");
    const encryptedLocalHistory = fs.readFileSync(e2eeImportedHistoryPath(), "utf8");
    assert.equal(encryptedLocalHistory.includes("This existed before"), false);
    assert.equal(encryptedLocalHistory.includes("before-mobile.txt"), false);
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Tasks, start receipts, and completion results stay end-to-end encrypted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-request-"));
  const aliceRoot = path.join(root, "alice");
  const bobRoot = path.join(root, "bob");
  const alice = enrolledIdentity(aliceRoot, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(bobRoot, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const service = new FakeE2eeService([alice, bob]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    process.env.RELAY_CONFIG_DIR = bobRoot;
    const bobClient = service.client(bob);
    await ensureE2eeKeyPackages(bobClient);

    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const aliceClient = service.client(alice);
    const request = await encryptE2eeMessage(aliceClient, {
      recipient: { relayUserId: bob.userId },
      kind: "task",
      title: "Review the launch checklist",
      forHuman: "Please check the launch list and tell me what is missing.",
      forAgent: "Read the repository checklist, run its verification commands, and return a concise result.",
      targetSurfaces: ["codex"],
      source: {
        host: "relay-mcp",
        cwd: "C:/Users/Alice/private/path",
        workspace: { kind: "name", key: "relay", label: "Relay" },
      },
      idempotencyKey: "e2ee-request-send-1",
    });
    const opaqueServiceState = JSON.stringify(service.messages);
    assert.equal(opaqueServiceState.includes("launch checklist"), false);
    assert.equal(opaqueServiceState.includes("verification commands"), false);
    assert.equal(opaqueServiceState.includes("private/path"), false);

    process.env.RELAY_CONFIG_DIR = bobRoot;
    const bobSummary = await e2eeChatList(bobClient, (await bobClient.e2eeSync()).items);
    const bobChat = await e2eeChat(bobClient, (await bobClient.e2eeSync()).items, bobSummary.chats[0].chatId);
    const received = bobChat.items.find((item) => item.relayId === request.relayId);
    assert.equal(received.kind, "task");
    assert.equal(received.taskId, request.relayId);
    assert.equal(received.taskStartedAt, undefined);
    assert.deepEqual(received.targetSurfaces, ["codex"]);
    assert.equal(received.source.workspace.key, "relay");
    assert.equal("cwd" in received.source, false, "a sender's local path is never encrypted onto the wire");

    await encryptE2eeMessage(bobClient, {
      kind: "message",
      recipient: {},
      forHuman: "",
      idempotencyKey: "e2ee-request-accepted-1",
      e2eeEvent: { type: "task.changed", targetRelayId: request.relayId, taskId: request.relayId, state: "accepted" },
    });
    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const acceptedSummary = await e2eeChatList(aliceClient, (await aliceClient.e2eeSync()).items);
    const acceptedChat = await e2eeChat(aliceClient, (await aliceClient.e2eeSync()).items, acceptedSummary.chats[0].chatId);
    const acceptedRequest = acceptedChat.items.find((item) => item.relayId === request.relayId);
    assert.equal(acceptedRequest.taskState, "accepted");
    assert.ok(acceptedRequest.taskAcceptedAt);
    assert.equal(acceptedRequest.taskStartedAt, undefined, "consent is not a claim that the provider began");
    await ensureE2eeKeyPackages(aliceClient);

    process.env.RELAY_CONFIG_DIR = bobRoot;
    await encryptE2eeMessage(bobClient, {
      kind: "message",
      recipient: {},
      forHuman: "",
      idempotencyKey: "e2ee-request-started-1",
      e2eeEvent: {
        type: "task.changed",
        targetRelayId: request.relayId,
        taskId: request.relayId,
        state: "started",
        taskRunOwner: { kind: "external_mcp", provider: "codex", nativeSessionId: "codex-thread-1" },
      },
    });
    const completion = await encryptE2eeMessage(bobClient, {
      kind: "message",
      type: "completion",
      recipient: {},
      forHuman: "The checklist is complete; the missing rollback owner is now named.",
      forAgent: "",
      inReplyToRelayId: request.relayId,
      idempotencyKey: "e2ee-request-completion-1",
    });
    process.env.RELAY_CONFIG_DIR = aliceRoot;
    const aliceSummary = await e2eeChatList(aliceClient, (await aliceClient.e2eeSync()).items);
    const aliceChat = await e2eeChat(aliceClient, (await aliceClient.e2eeSync()).items, aliceSummary.chats[0].chatId);
    const sentRequest = aliceChat.items.find((item) => item.relayId === request.relayId);
    const result = aliceChat.items.find((item) => item.relayId === completion.relayId);
    assert.ok(sentRequest.taskStartedAt);
    assert.deepEqual(sentRequest.taskRunOwner, {
      kind: "external_mcp",
      provider: "codex",
      nativeSessionId: "codex-thread-1",
    });
    assert.ok(sentRequest.taskCompletedAt);
    assert.equal(result.type, "completion");
    assert.equal(result.forHuman, "The checklist is complete; the missing rollback owner is now named.");
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
