import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  emptyPskIndex,
  encodeMlsMessage,
  joinGroup,
  processPrivateMessage,
  zeroOutUint8Array,
} from "ts-mls";
import { decodeRatchetTree, encodeRatchetTree } from "ts-mls/ratchetTree.js";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import {
  b64,
  cipherSuite,
  clientConfigFor,
  decodeExact,
  decryptE2eeWireMessage,
  e2eePacket,
  ensureE2eeKeyPackages,
  generatePackage,
  importE2eeAttachmentPlaintexts,
  identityOrThrow,
  privatePackageFromJson,
  unb64,
} from "./e2ee-mls.js";
import {
  assertKnownCheckpoint,
  completeE2eeOutbox,
  e2eeRequestHash,
  importE2eeHistoryRecords,
  mutateKeyPackageState,
  readImportedE2eeHistory,
  readKeyPackageState,
  readPendingE2eeOutbox,
  syncTransparency,
  writePendingE2eeOutbox,
} from "./e2ee-state.js";

const { E2EE_PROTOCOL, readPairedIdentity, verifyDeviceCrossSignature } = e2eeIdentityModule;
const HISTORY_CONTEXT = "relay-e2ee-device-history-v1";
const HISTORY_KEY_CONTEXT = "relay-e2ee-device-history-key-v1";
const ARCHIVE_VERSION = 1;
const MAX_ARCHIVE_PLAINTEXT_BYTES = 15_000_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function historyAad(userId, transferId) {
  return Buffer.from(JSON.stringify([HISTORY_CONTEXT, userId, transferId]), "utf8");
}

function encryptArchive(userId, transferId, records) {
  const archiveKey = randomBytes(32);
  const nonce = randomBytes(12);
  const archive = {
    version: ARCHIVE_VERSION,
    context: HISTORY_CONTEXT,
    ownerUserId: userId,
    transferId,
    createdAt: new Date().toISOString(),
    records,
  };
  const plaintext = Buffer.from(JSON.stringify(archive), "utf8");
  if (plaintext.length > MAX_ARCHIVE_PLAINTEXT_BYTES) {
    throw new Error("One encrypted history batch is too large; split it before transfer.");
  }
  const cipher = createCipheriv("aes-256-gcm", archiveKey, nonce);
  cipher.setAAD(historyAad(userId, transferId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const packed = Buffer.concat([Buffer.from([ARCHIVE_VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
  return {
    archiveKey: archiveKey.toString("base64url"),
    archiveCiphertext: packed.toString("base64url"),
    archiveCiphertextSize: packed.length,
    archiveCiphertextSha256: sha256(packed),
  };
}

function openArchive(wire, archiveKey, identity) {
  const packed = Buffer.from(wire.archiveCiphertext, "base64url");
  if (
    packed.length < 30 ||
    packed[0] !== ARCHIVE_VERSION ||
    packed.length !== wire.archiveCiphertextSize ||
    sha256(packed) !== wire.archiveCiphertextSha256
  ) throw new Error("Encrypted device history failed its ciphertext integrity check.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(archiveKey, "base64url"), packed.subarray(1, 13));
  decipher.setAAD(historyAad(identity.userId, wire.transferId));
  decipher.setAuthTag(packed.subarray(13, 29));
  let archive;
  try {
    archive = JSON.parse(Buffer.concat([
      decipher.update(packed.subarray(29)),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw new Error("Encrypted device history could not be authenticated.");
  }
  if (
    archive?.version !== ARCHIVE_VERSION ||
    archive.context !== HISTORY_CONTEXT ||
    archive.ownerUserId !== identity.userId ||
    archive.transferId !== wire.transferId ||
    !Array.isArray(archive.records)
  ) throw new Error("Encrypted device history metadata did not authenticate.");
  return archive.records;
}

function activeTrustedTarget(directory, transparency, identity, targetDeviceId) {
  if (directory.relayUserId !== identity.userId) return null;
  const devices = new Map((directory.devices || []).map((device) => [device.deviceId, device]));
  for (const [deviceId, device] of devices) {
    const known = transparency.users?.[identity.userId]?.devices?.[deviceId];
    if (
      !known ||
      known.revokedAt ||
      (known.expiresAt && Date.parse(known.expiresAt) <= Date.now()) ||
      known.fingerprint !== device.fingerprint ||
      known.signaturePublicKey !== device.signaturePublicKey
    ) return null;
  }
  const edges = [];
  for (const proof of directory.crossSignatures || []) {
    const signer = devices.get(proof.signerDeviceId);
    const subject = devices.get(proof.subjectDeviceId);
    if (!signer || !subject) continue;
    if (
      subject.fingerprint !== proof.subjectFingerprint ||
      !verifyDeviceCrossSignature({ relayUserId: identity.userId, signer, proof })
    ) return null;
    edges.push([signer.deviceId, subject.deviceId]);
  }
  const trusted = new Set([identity.deviceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of edges) {
      if (trusted.has(left) && !trusted.has(right)) { trusted.add(right); changed = true; }
      if (trusted.has(right) && !trusted.has(left)) { trusted.add(left); changed = true; }
    }
  }
  return trusted.has(targetDeviceId) ? devices.get(targetDeviceId) : null;
}

function historyWire(wire) {
  return {
    relayId: wire.relayId,
    state: wire.state,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    sender: wire.sender,
    recipient: wire.recipient,
    delivery: wire.delivery,
    attachments: (wire.attachments || []).map(({ downloadUrl: _downloadUrl, ...attachment }) => attachment),
    senderCheckpoint: wire.senderCheckpoint,
    ...(wire.acknowledgedAt ? { acknowledgedAt: wire.acknowledgedAt } : {}),
  };
}

async function snapshotRecord(wire, plaintext) {
  const packet = await e2eePacket(wire, plaintext);
  const attachmentContents = (packet.packet.attachments || []).map((attachment) => ({
    attachmentId: attachment.id,
    contentBase64: fs.readFileSync(attachment.localPath).toString("base64"),
  }));
  return {
    wire: historyWire(wire),
    plaintext: {
      ...plaintext,
      attachmentMetadata: (plaintext.attachmentMetadata || []).map(({ downloadUrl: _downloadUrl, ...metadata }) => metadata),
    },
    attachmentContents,
  };
}

async function collectHistory(client, identity) {
  const response = await client.e2eeSync();
  const records = new Map();
  for (const wire of response.items || []) {
    records.set(wire.relayId, await snapshotRecord(wire, await decryptE2eeWireMessage(client, wire)));
  }
  for (const imported of readImportedE2eeHistory(identity)) {
    if (!records.has(imported.wire.relayId)) {
      records.set(imported.wire.relayId, await snapshotRecord(imported.wire, imported.plaintext));
    }
  }
  return [...records.values()].sort((left, right) =>
    String(left.plaintext.authoredAt || left.plaintext.createdAt).localeCompare(String(right.plaintext.authoredAt || right.plaintext.createdAt)) ||
    String(left.wire.relayId).localeCompare(String(right.wire.relayId)));
}

function chunkHistory(records) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const record of records) {
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (bytes > MAX_ARCHIVE_PLAINTEXT_BYTES - 1024) {
      throw new Error(`Encrypted history message ${record.wire.relayId} is too large to transfer.`);
    }
    if (current.length && currentBytes + bytes > MAX_ARCHIVE_PLAINTEXT_BYTES - 1024) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(record);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function buildTransferWire(client, identity, preparation, records, idempotencyKey) {
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, preparation.checkpoint);
  const directory = await client.e2eeDirectory(identity.userId);
  const trustedTarget = activeTrustedTarget(
    directory,
    transparency,
    identity,
    preparation.target.device.deviceId,
  );
  if (
    !trustedTarget ||
    trustedTarget.fingerprint !== preparation.target.device.fingerprint ||
    trustedTarget.signaturePublicKey !== preparation.target.device.signaturePublicKey
  ) throw new Error("Relay's history target is not in this device's cross-signed trust graph.");

  const archive = encryptArchive(identity.userId, preparation.transferId, records);
  const cs = await cipherSuite();
  const sourcePackage = await generatePackage(identity, cs);
  const sourceDecoded = decodeExact(decodeMlsMessage, sourcePackage.keyPackage, "history source KeyPackage");
  const targetDecoded = decodeExact(decodeMlsMessage, preparation.target.keyPackage, "history target KeyPackage");
  if (sourceDecoded.wireformat !== "mls_key_package" || targetDecoded.wireformat !== "mls_key_package") {
    throw new Error("Encrypted device history received the wrong MLS KeyPackage wire format.");
  }
  let state = await createGroup(
    textEncoder.encode(`relay:device-history:${preparation.transferId}`),
    sourceDecoded.keyPackage,
    privatePackageFromJson(sourcePackage.privatePackage),
    [],
    cs,
    clientConfigFor(transparency),
  );
  const committed = await createCommit(
    { state, cipherSuite: cs },
    {
      extraProposals: [{ proposalType: "add", add: { keyPackage: targetDecoded.keyPackage } }],
      ratchetTreeExtension: true,
    },
  );
  if (!committed.welcome) throw new Error("MLS did not create a Welcome for the new device.");
  state = committed.newState;
  committed.consumed.forEach(zeroOutUint8Array);
  const keyPayload = {
    version: 1,
    context: HISTORY_KEY_CONTEXT,
    transferId: preparation.transferId,
    ownerUserId: identity.userId,
    sourceDeviceId: identity.deviceId,
    targetDeviceId: preparation.target.device.deviceId,
    archiveKey: archive.archiveKey,
    archiveCiphertextSize: archive.archiveCiphertextSize,
    archiveCiphertextSha256: archive.archiveCiphertextSha256,
    senderCheckpoint: { ...transparency.checkpoint },
  };
  const encrypted = await createApplicationMessage(state, textEncoder.encode(JSON.stringify(keyPayload)), cs);
  encrypted.consumed.forEach(zeroOutUint8Array);
  return {
    transferId: preparation.transferId,
    welcome: b64(encodeMlsMessage({ version: E2EE_PROTOCOL, wireformat: "mls_welcome", welcome: committed.welcome })),
    ratchetTree: b64(encodeRatchetTree(state.ratchetTree)),
    keyCiphertext: b64(encodeMlsMessage({
      version: E2EE_PROTOCOL,
      wireformat: "mls_private_message",
      privateMessage: encrypted.privateMessage,
    })),
    archiveCiphertext: archive.archiveCiphertext,
    archiveCiphertextSize: archive.archiveCiphertextSize,
    archiveCiphertextSha256: archive.archiveCiphertextSha256,
    senderCheckpoint: { ...transparency.checkpoint },
    idempotencyKey,
  };
}

export async function offerE2eeDeviceHistory(client, targetDeviceId, { idempotencyKey } = {}) {
  const identity = identityOrThrow();
  const baseKey = String(idempotencyKey || "");
  if (baseKey.length < 8) throw new Error("A stable idempotency key is required for device history transfer.");
  await ensureE2eeKeyPackages(client);
  const chunks = chunkHistory(await collectHistory(client, identity));
  const transfers = [];
  for (const [index, records] of chunks.entries()) {
    const batchKey = `${baseKey}:${index + 1}`;
    const preparation = await client.e2eePrepareDeviceHistory({
      targetDeviceId,
      idempotencyKey: `${batchKey}:prepare`,
    });
    const outboxId = `device-history:${preparation.transferId}`;
    const existing = readPendingE2eeOutbox(identity, outboxId);
    if (existing) {
      const response = existing.status === "completed"
        ? existing.response
        : await client.e2eeUploadDeviceHistory(existing.wire);
      transfers.push(existing.status === "completed"
        ? response
        : completeE2eeOutbox(identity, outboxId, existing.requestHash, response));
      continue;
    }
    const wire = await buildTransferWire(client, identity, preparation, records, `${batchKey}:upload`);
    const requestHash = e2eeRequestHash("relay-e2ee-device-history-transfer-v1", wire);
    const durable = writePendingE2eeOutbox(identity, outboxId, { requestHash, wire });
    const response = await client.e2eeUploadDeviceHistory(durable.wire);
    transfers.push(completeE2eeOutbox(identity, outboxId, requestHash, response));
  }
  return { targetDeviceId, messageCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0), transfers };
}

function validateImportedRecord(record, wire, identity) {
  if (
    !record?.wire?.relayId ||
    record.wire.relayId !== record?.plaintext?.messageId ||
    record.wire.sender?.relayUserId !== record.plaintext.senderUserId ||
    record.wire.sender?.deviceId !== record.plaintext.senderDeviceId ||
    record.wire.recipient?.relayUserId !== record.plaintext.recipientUserId ||
    (record.plaintext.senderUserId !== identity.userId && record.plaintext.recipientUserId !== identity.userId) ||
    !Array.isArray(record.attachmentContents || [])
  ) throw new Error("Encrypted device history contains an invalid message record.");
  const kind = record.plaintext.senderUserId === identity.userId ? "sender_copy" : "recipient";
  return {
    wire: {
      ...record.wire,
      delivery: { kind, ownerUserId: identity.userId, deviceId: identity.deviceId },
      recipient: { ...record.wire.recipient, deviceId: identity.deviceId },
    },
    plaintext: record.plaintext,
    attachmentContents: record.attachmentContents,
  };
}

async function openTransfer(client, wire, identity) {
  if (wire.targetDeviceId !== identity.deviceId || wire.source.relayUserId !== identity.userId) {
    throw new Error("Encrypted device history was routed to the wrong account or device.");
  }
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, wire.senderCheckpoint);
  const localPackage = readKeyPackageState(identity).packages[wire.keyPackageRef];
  if (!localPackage) throw new Error("This device no longer has the MLS KeyPackage needed to open its history.");
  const cs = await cipherSuite();
  const packageMessage = decodeExact(decodeMlsMessage, localPackage.keyPackage, "history target KeyPackage");
  const welcomeMessage = decodeExact(decodeMlsMessage, wire.welcome, "history Welcome");
  const keyMessage = decodeExact(decodeMlsMessage, wire.keyCiphertext, "history key ciphertext");
  const ratchetTree = decodeExact(decodeRatchetTree, wire.ratchetTree, "history ratchet tree");
  if (
    packageMessage.wireformat !== "mls_key_package" ||
    welcomeMessage.wireformat !== "mls_welcome" ||
    keyMessage.wireformat !== "mls_private_message"
  ) throw new Error("Encrypted device history contains the wrong MLS wire formats.");
  const group = await joinGroup(
    welcomeMessage.welcome,
    packageMessage.keyPackage,
    privatePackageFromJson(localPackage.privatePackage),
    emptyPskIndex,
    cs,
    ratchetTree,
    undefined,
    clientConfigFor(transparency, wire.senderCheckpoint),
  );
  const opened = await processPrivateMessage(group, keyMessage.privateMessage, emptyPskIndex, cs);
  if (opened.kind !== "applicationMessage") throw new Error("Encrypted device history did not contain an MLS key message.");
  let keyPayload;
  try { keyPayload = JSON.parse(textDecoder.decode(opened.message)); } finally {
    opened.consumed.forEach(zeroOutUint8Array);
  }
  if (
    keyPayload?.version !== 1 ||
    keyPayload.context !== HISTORY_KEY_CONTEXT ||
    keyPayload.transferId !== wire.transferId ||
    keyPayload.ownerUserId !== identity.userId ||
    keyPayload.sourceDeviceId !== wire.source.deviceId ||
    keyPayload.targetDeviceId !== identity.deviceId ||
    keyPayload.archiveCiphertextSize !== wire.archiveCiphertextSize ||
    keyPayload.archiveCiphertextSha256 !== wire.archiveCiphertextSha256 ||
    keyPayload.senderCheckpoint?.size !== wire.senderCheckpoint.size ||
    keyPayload.senderCheckpoint?.headHash !== wire.senderCheckpoint.headHash ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(keyPayload.archiveKey || ""))
  ) throw new Error("Encrypted device history key metadata did not authenticate.");
  const records = openArchive(wire, keyPayload.archiveKey, identity)
    .map((record) => validateImportedRecord(record, wire, identity));
  for (const record of records) {
    importE2eeAttachmentPlaintexts(
      record.wire.relayId,
      record.plaintext.attachmentMetadata || [],
      record.attachmentContents,
    );
  }
  importE2eeHistoryRecords(identity, records.map(({ attachmentContents: _contents, ...record }) => record));
  mutateKeyPackageState(identity, (state) => { delete state.packages[wire.keyPackageRef]; });
  return records.length;
}

export async function syncE2eeDeviceHistory(client) {
  const identity = readPairedIdentity();
  if (!identity) throw new Error("This Companion has no enrolled E2EE identity.");
  await ensureE2eeKeyPackages(client);
  const response = await client.e2eeDeviceHistory();
  let imported = 0;
  const transferIds = [];
  for (const wire of response.items || []) {
    imported += await openTransfer(client, wire, identity);
    await client.e2eeAcknowledgeDeviceHistory(wire.transferId);
    transferIds.push(wire.transferId);
  }
  return { imported, transferIds };
}
