import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processPrivateMessage,
  zeroOutUint8Array,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import { decodeRatchetTree, encodeRatchetTree } from "ts-mls/ratchetTree.js";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import {
  assertE2eeRecipientDevicesTrusted,
  assertE2eeSenderDeviceTrusted,
} from "./e2ee-device-trust.js";
import {
  activeDeviceFromTransparency,
  assertAndPinE2eeMode,
  assertKnownCheckpoint,
  cachePlaintext,
  canonicalKeyPackageProof,
  canonicalMlsCredential,
  completeE2eeOutbox,
  deviceAtTransparencyCheckpoint,
  e2eeRequestHash,
  mutateKeyPackageState,
  parseMlsCredential,
  readCachedPlaintext,
  readImportedE2eeHistoryRecord,
  readKeyPackageState,
  readPendingE2eeOutbox,
  syncTransparency,
  writePendingE2eeOutbox,
} from "./e2ee-state.js";

const {
  E2EE_CIPHER_SUITE,
  E2EE_PROTOCOL,
  identityPath,
  readPairedIdentity,
  verifyDeviceCrossSignature,
} = e2eeIdentityModule;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const KEY_PACKAGE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const E2EE_ATTACHMENT_TOTAL_CIPHERTEXT_BYTES = 12 * 1024 * 1024;
const ATTACHMENT_FILE_CONTEXT = "relay-e2ee-attachment-file-v1";
const ATTACHMENT_METADATA_CONTEXT = "relay-e2ee-attachment-metadata-v1";

export function b64(value) {
  return Buffer.from(value).toString("base64url");
}

export function unb64(value) {
  return new Uint8Array(Buffer.from(String(value || ""), "base64url"));
}

export function decodeExact(decoder, value, label) {
  const bytes = unb64(value);
  const decoded = decoder(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) throw new Error(`Invalid ${label} encoding.`);
  return decoded[0];
}

export async function cipherSuite() {
  return getCiphersuiteImpl(getCiphersuiteFromName(E2EE_CIPHER_SUITE));
}

export function identityOrThrow() {
  const identity = readPairedIdentity();
  if (!identity) {
    throw new Error("This Companion has no enrolled E2EE identity. Re-pair it before encrypted messaging.");
  }
  return identity;
}

export function localE2eeIdentityAvailable() {
  return Boolean(readPairedIdentity());
}

function directConversationId(leftUserId, rightUserId) {
  const users = [...new Set([String(leftUserId), String(rightUserId)])].sort();
  return `econv_${createHash("sha256")
    .update("relay-e2ee-direct-conversation-v1")
    .update(users.join("\n"))
    .digest("hex")
    .slice(0, 32)}`;
}

const E2EE_TARGET_SURFACES = new Set(["codex", "claude_code", "claude_desktop", "claude_cowork"]);

function encryptedTargetSurfaces(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || ""))
    .filter((item) => E2EE_TARGET_SURFACES.has(item)))].slice(0, 4);
}

/** Keep portable provenance inside the ciphertext without leaking a local cwd. */
function encryptedSource(source) {
  if (!source || typeof source !== "object") return null;
  const result = { host: String(source.host || "unknown") };
  if (E2EE_TARGET_SURFACES.has(String(source.surface || ""))) result.surface = String(source.surface);
  if (source.workspace && typeof source.workspace === "object") {
    const workspace = {
      kind: String(source.workspace.kind || ""),
      key: String(source.workspace.key || ""),
      ...(source.workspace.label ? { label: String(source.workspace.label) } : {}),
      ...(source.workspace.branch ? { branch: String(source.workspace.branch) } : {}),
      ...(source.workspace.rootCommit ? { rootCommit: String(source.workspace.rootCommit) } : {}),
    };
    if (["git", "name"].includes(workspace.kind) && workspace.key) result.workspace = workspace;
  }
  if (source.repo && typeof source.repo === "object") {
    const repo = Object.fromEntries(["name", "originKey", "branch", "rootCommit"]
      .filter((key) => source.repo[key])
      .map((key) => [key, String(source.repo[key])]));
    if (Object.keys(repo).length) result.repo = repo;
  }
  return result;
}

async function encryptedRecord(client, relayId) {
  const identity = identityOrThrow();
  const imported = readImportedE2eeHistoryRecord(identity, relayId);
  if (imported) return imported;
  const result = await client.e2eeFetchMessages([relayId]);
  const wire = result?.packets?.[relayId];
  if (!wire) throw new Error("That encrypted message is not available to this device.");
  return { wire, plaintext: await decryptE2eeWireMessage(client, wire) };
}

function otherParticipant(identity, wire) {
  if (wire.sender.relayUserId === identity.userId) return wire.recipient.relayUserId;
  if (wire.recipient.relayUserId === identity.userId) return wire.sender.relayUserId;
  throw new Error("That encrypted message is not part of this account's conversation.");
}

export async function verifiedE2eeStatus(client) {
  const status = await client.e2eeStatus();
  const identity = readPairedIdentity();
  if (identity) assertAndPinE2eeMode(identity, status.mode);
  return status;
}

function credentialFor(identity) {
  return {
    credentialType: "basic",
    identity: textEncoder.encode(canonicalMlsCredential({
      relayUserId: identity.userId,
      deviceId: identity.deviceId,
      fingerprint: identity.fingerprint,
    })),
  };
}

function pinnedCapabilities() {
  return {
    ...defaultCapabilities(),
    versions: [E2EE_PROTOCOL],
    ciphersuites: [E2EE_CIPHER_SUITE],
    credentials: ["basic"],
  };
}

function packageLifetime() {
  const now = Math.floor(Date.now() / 1000);
  return { notBefore: BigInt(now - 60), notAfter: BigInt(now + KEY_PACKAGE_LIFETIME_SECONDS) };
}

function privatePackageToJson(value) {
  return {
    initPrivateKey: b64(value.initPrivateKey),
    hpkePrivateKey: b64(value.hpkePrivateKey),
    signaturePrivateKey: b64(value.signaturePrivateKey),
  };
}

export function privatePackageFromJson(value) {
  return {
    initPrivateKey: unb64(value.initPrivateKey),
    hpkePrivateKey: unb64(value.hpkePrivateKey),
    signaturePrivateKey: unb64(value.signaturePrivateKey),
  };
}

export async function generatePackage(identity, cs) {
  const lifetime = packageLifetime();
  const generated = await generateKeyPackageWithKey(
    credentialFor(identity),
    pinnedCapabilities(),
    lifetime,
    [],
    {
      signKey: unb64(identity.privateKeyJwk.d),
      publicKey: unb64(identity.signaturePublicKey),
    },
    cs,
  );
  const encoded = encodeMlsMessage({
    version: E2EE_PROTOCOL,
    wireformat: "mls_key_package",
    keyPackage: generated.publicPackage,
  });
  const packageRef = createHash("sha256").update(encoded).digest("base64url");
  const keyPackage = b64(encoded);
  const expiresAt = new Date(Number(lifetime.notAfter) * 1000).toISOString();
  const proof = sign(
    null,
    Buffer.from(canonicalKeyPackageProof({
      deviceId: identity.deviceId,
      packageRef,
      keyPackage,
      expiresAt,
    }), "utf8"),
    createPrivateKey({ key: identity.privateKeyJwk, format: "jwk" }),
  ).toString("base64url");
  return {
    packageRef,
    keyPackage,
    proof,
    expiresAt,
    uploaded: false,
    privatePackage: privatePackageToJson(generated.privatePackage),
  };
}

/** Ensure the server has a replenishable pool without ever uploading private key material. */
export async function ensureE2eeKeyPackages(client, knownStatus) {
  const status = knownStatus || await verifiedE2eeStatus(client);
  if (status.mode === "off") return status;
  if (status.protocol !== E2EE_PROTOCOL || status.cipherSuite !== E2EE_CIPHER_SUITE) {
    throw new Error("Relay's E2EE protocol does not match this Companion; refusing a downgrade or suite change.");
  }
  const identity = identityOrThrow();
  await syncTransparency(client, identity);
  const packageStatus = await client.e2eeKeyPackageStatus();
  const needed = Math.max(0, packageStatus.target - packageStatus.available);
  if (!needed) return status;

  const cs = await cipherSuite();
  const now = Date.now() + 60 * 60 * 1000;
  let local = readKeyPackageState(identity);
  let candidates = Object.values(local.packages)
    .filter((item) => !item.uploaded && Date.parse(item.expiresAt) > now)
    .slice(0, needed);
  const generated = [];
  while (candidates.length + generated.length < needed) generated.push(await generatePackage(identity, cs));
  if (generated.length) {
    mutateKeyPackageState(identity, (state) => {
      for (const item of generated) state.packages[item.packageRef] = item;
    });
  }
  local = readKeyPackageState(identity);
  candidates = Object.values(local.packages)
    .filter((item) => !item.uploaded && Date.parse(item.expiresAt) > now)
    .slice(0, needed);
  const response = await client.e2eeUploadKeyPackages(candidates.map(({ keyPackage, packageRef, proof, expiresAt }) => ({
    keyPackage,
    packageRef,
    proof,
    expiresAt,
  })));
  const accepted = new Set(response.accepted || []);
  mutateKeyPackageState(identity, (state) => {
    for (const packageRef of accepted) {
      if (state.packages[packageRef]) state.packages[packageRef].uploaded = true;
    }
  });
  return status;
}

export function clientConfigFor(transparency, checkpoint = null) {
  return {
    ...defaultClientConfig,
    lifetimeConfig: {
      maximumTotalLifetime: BigInt(KEY_PACKAGE_LIFETIME_SECONDS + 120),
      validateLifetimeOnReceive: true,
    },
    authService: {
      async validateCredential(credential, signaturePublicKey) {
        if (credential?.credentialType !== "basic") return false;
        let parsed;
        try { parsed = parseMlsCredential(textDecoder.decode(credential.identity)); } catch { return false; }
        if (!parsed) return false;
        const device = checkpoint
          ? deviceAtTransparencyCheckpoint(transparency, parsed.relayUserId, parsed.deviceId, checkpoint.size)
          : activeDeviceFromTransparency(transparency, parsed.relayUserId, parsed.deviceId);
        if (!device || device.fingerprint !== parsed.fingerprint) return false;
        return Buffer.from(signaturePublicKey).equals(Buffer.from(device.signaturePublicKey, "base64url"));
      },
    },
  };
}

async function assertPreparedTargets(client, identity, transparency, preparation) {
  const recipientSeen = new Set();
  const senderSeen = new Set();
  for (const target of preparation.targets) {
    if (recipientSeen.has(target.device.deviceId) || senderSeen.has(target.device.deviceId)) {
      throw new Error("Relay returned a duplicate encrypted delivery device.");
    }
    if (target.deliveryKind === "recipient") recipientSeen.add(target.device.deviceId);
    else if (target.deliveryKind === "sender_copy") senderSeen.add(target.device.deviceId);
    else throw new Error("Relay returned an unknown encrypted delivery kind.");
    const known = activeDeviceFromTransparency(
      transparency,
      target.relayUserId,
      target.device.deviceId,
    );
    if (
      !known ||
      known.protocol !== E2EE_PROTOCOL ||
      known.cipherSuite !== E2EE_CIPHER_SUITE ||
      known.signaturePublicKey !== target.device.signaturePublicKey ||
      known.fingerprint !== target.device.fingerprint
    ) throw new Error("Relay's recipient KeyPackage does not match the verified device directory.");
  }
  const expected = Object.entries(transparency.users?.[preparation.recipient.relayUserId]?.devices || {})
    .filter(([, device]) => !device.revokedAt && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now()))
    .map(([deviceId]) => deviceId)
    .sort();
  const actual = [...recipientSeen].sort();
  if (!expected.length || expected.length !== actual.length || expected.some((deviceId, index) => deviceId !== actual[index])) {
    throw new Error("Relay omitted or added a recipient device relative to the verified E2EE directory.");
  }

  const directory = await client.e2eeDirectory(identity.userId);
  const activeSenderDevices = Object.fromEntries(
    Object.entries(transparency.users?.[identity.userId]?.devices || {})
      .filter(([, device]) => !device.revokedAt && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now())),
  );
  const directoryById = new Map((directory.devices || []).map((device) => [device.deviceId, device]));
  const expectedDirectoryIds = Object.keys(activeSenderDevices).sort();
  const actualDirectoryIds = [...directoryById.keys()].sort();
  if (
    directory.relayUserId !== identity.userId ||
    expectedDirectoryIds.length !== actualDirectoryIds.length ||
    expectedDirectoryIds.some((deviceId, index) => deviceId !== actualDirectoryIds[index])
  ) throw new Error("Relay's sender device directory does not match key transparency.");
  for (const [deviceId, device] of directoryById) {
    const known = activeSenderDevices[deviceId];
    if (
      !known ||
      known.signaturePublicKey !== device.signaturePublicKey ||
      known.fingerprint !== device.fingerprint
    ) throw new Error("Relay's sender device identity does not match key transparency.");
  }

  const edges = [];
  for (const proof of directory.crossSignatures || []) {
    const signer = directoryById.get(proof.signerDeviceId);
    const subject = directoryById.get(proof.subjectDeviceId);
    if (!signer || !subject) continue;
    if (
      subject.fingerprint !== proof.subjectFingerprint ||
      !verifyDeviceCrossSignature({ relayUserId: identity.userId, signer, proof })
    ) throw new Error("Relay returned an invalid sender device approval proof.");
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
  const expectedSenderCopies = [...trusted].sort();
  const actualSenderCopies = [...senderSeen].sort();
  if (
    expectedSenderCopies.length !== actualSenderCopies.length ||
    expectedSenderCopies.some((deviceId, index) => deviceId !== actualSenderCopies[index])
  ) throw new Error("Relay omitted or added a sender-copy device relative to the cross-signed trust graph.");
}

function attachmentAad(context, messageId, attachmentId) {
  return Buffer.from(JSON.stringify([context, messageId, attachmentId]), "utf8");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function encryptAesGcm(key, iv, plaintext, aad) {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decryptAesGcm(key, iv, ciphertextAndTag, aad) {
  if (ciphertextAndTag.length < 17) throw new Error("Encrypted attachment envelope is too short.");
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const tag = ciphertextAndTag.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function attachmentInputs(payload) {
  const items = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (items.length > 20) throw new Error("Encrypted messages support at most 20 attachments.");
  let totalCiphertext = 0;
  return items.map((attachment, index) => {
    const encoded = String(attachment?.contentBase64 || "");
    if (!encoded) {
      throw new Error("Encrypted attachments must include their bytes on the sending device; nothing was sent.");
    }
    let body;
    try { body = Buffer.from(encoded, "base64"); } catch { body = null; }
    if (!body?.length || body.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("An encrypted attachment did not contain valid base64 file bytes.");
    }
    totalCiphertext += body.length + 16;
    if (totalCiphertext > E2EE_ATTACHMENT_TOTAL_CIPHERTEXT_BYTES) {
      throw new Error("Encrypted attachments are limited to 12 MiB total in the first release; nothing was sent.");
    }
    const name = String(attachment.name || `attachment-${index + 1}`).trim();
    const contentType = String(attachment.contentType || "application/octet-stream").trim();
    if (!name || name.length > 255 || !contentType || contentType.length > 255) {
      throw new Error("An encrypted attachment has an invalid filename or content type.");
    }
    const plaintextSha256 = sha256Hex(body);
    if (attachment.bytes !== undefined && Number(attachment.bytes) !== body.length) {
      throw new Error(`Attachment ${name} did not match its declared size.`);
    }
    if (attachment.sha256 && String(attachment.sha256).toLowerCase() !== plaintextSha256) {
      throw new Error(`Attachment ${name} did not match its declared SHA-256 hash.`);
    }
    return { name, contentType, body, plaintextSha256 };
  });
}

export function attachmentRequestBindings(items) {
  return items.map((item) => ({
    name: item.name,
    contentType: item.contentType,
    bytes: item.body.length,
    sha256: item.plaintextSha256,
  }));
}

export function encryptAttachments(messageId, inputs) {
  return inputs.map((input, index) => {
    const attachmentId = `eatt_${createHash("sha256")
      .update("relay-e2ee-attachment-id-v1")
      .update(messageId)
      .update(String(index))
      .update(input.plaintextSha256)
      .digest("base64url")}`;
    const key = randomBytes(32);
    const fileIv = randomBytes(12);
    const fileCiphertext = encryptAesGcm(
      key,
      fileIv,
      input.body,
      attachmentAad(ATTACHMENT_FILE_CONTEXT, messageId, attachmentId),
    );
    const ciphertextSha256 = sha256Base64Url(fileCiphertext);
    const metadata = {
      version: 1,
      attachmentId,
      name: input.name,
      contentType: input.contentType,
      plaintextSize: input.body.length,
      plaintextSha256: input.plaintextSha256,
      fileIv: fileIv.toString("base64url"),
      ciphertextSize: fileCiphertext.length,
      ciphertextSha256,
    };
    const metadataIv = randomBytes(12);
    const metadataCiphertext = encryptAesGcm(
      key,
      metadataIv,
      Buffer.from(JSON.stringify(metadata), "utf8"),
      attachmentAad(ATTACHMENT_METADATA_CONTEXT, messageId, attachmentId),
    );
    return {
      key: { attachmentId, key: key.toString("base64url") },
      wire: {
        attachmentId,
        encryptedMetadata: Buffer.concat([metadataIv, metadataCiphertext]).toString("base64url"),
        ciphertext: fileCiphertext.toString("base64url"),
        ciphertextSize: fileCiphertext.length,
        ciphertextSha256,
      },
    };
  });
}

export function decryptAttachmentMetadata(messageId, attachmentKeys, wireAttachments) {
  const keys = new Map();
  for (const item of attachmentKeys || []) {
    if (!item?.attachmentId || keys.has(item.attachmentId)) {
      throw new Error("Encrypted Relay contains invalid attachment key references.");
    }
    const key = Buffer.from(String(item.key || ""), "base64url");
    if (key.length !== 32 || key.toString("base64url") !== item.key) {
      throw new Error("Encrypted Relay contains an invalid attachment key.");
    }
    keys.set(item.attachmentId, key);
  }
  const wires = Array.isArray(wireAttachments) ? wireAttachments : [];
  if (wires.length !== keys.size) throw new Error("Encrypted Relay attachment routing does not match its MLS plaintext.");
  const seen = new Set();
  return wires.map((wire) => {
    if (!wire?.attachmentId || seen.has(wire.attachmentId) || !keys.has(wire.attachmentId)) {
      throw new Error("Encrypted Relay attachment routing does not match its MLS plaintext.");
    }
    seen.add(wire.attachmentId);
    try {
      const envelope = Buffer.from(wire.encryptedMetadata, "base64url");
      const metadataIv = envelope.subarray(0, 12);
      const metadata = JSON.parse(decryptAesGcm(
        keys.get(wire.attachmentId),
        metadataIv,
        envelope.subarray(12),
        attachmentAad(ATTACHMENT_METADATA_CONTEXT, messageId, wire.attachmentId),
      ).toString("utf8"));
      if (
        metadata.version !== 1 ||
        metadata.attachmentId !== wire.attachmentId ||
        typeof metadata.name !== "string" || !metadata.name || metadata.name.length > 255 ||
        typeof metadata.contentType !== "string" || !metadata.contentType || metadata.contentType.length > 255 ||
        !Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0 ||
        !/^[a-f0-9]{64}$/.test(metadata.plaintextSha256) ||
        !/^[A-Za-z0-9_-]{16}$/.test(metadata.fileIv) ||
        metadata.ciphertextSize !== wire.ciphertextSize ||
        metadata.ciphertextSha256 !== wire.ciphertextSha256
      ) throw new Error("metadata mismatch");
      return {
        id: wire.attachmentId,
        name: metadata.name,
        contentType: metadata.contentType,
        bytes: metadata.plaintextSize,
        sha256: metadata.plaintextSha256,
        key: keys.get(wire.attachmentId).toString("base64url"),
        fileIv: metadata.fileIv,
        ciphertextSize: wire.ciphertextSize,
        ciphertextSha256: wire.ciphertextSha256,
        downloadUrl: wire.downloadUrl,
      };
    } catch (error) {
      if (/Encrypted Relay/.test(String(error?.message || ""))) throw error;
      throw new Error("Encrypted Relay attachment metadata could not be authenticated.");
    }
  });
}

function safeAttachmentFilename(name, index, attachmentId) {
  const clean = path.basename(String(name || "attachment")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "attachment";
  return `${String(index + 1).padStart(2, "0")}-${attachmentId.slice(-10)}-${clean}`;
}

export async function materializeE2eeAttachments(messageId, metadata) {
  if (!metadata.length) return [];
  const root = path.join(path.dirname(identityPath()), "attachments", messageId.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const materialized = [];
  for (const [index, attachment] of metadata.entries()) {
    const filePath = path.join(root, safeAttachmentFilename(attachment.name, index, attachment.id));
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath);
      if (existing.length === attachment.bytes && sha256Hex(existing) === attachment.sha256) {
        materialized.push({ ...attachment, localPath: filePath });
        continue;
      }
    }
    const response = await fetch(attachment.downloadUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Encrypted attachment download failed with HTTP ${response.status}.`);
    const ciphertext = Buffer.from(await response.arrayBuffer());
    if (
      ciphertext.length !== attachment.ciphertextSize ||
      ciphertext.length > E2EE_ATTACHMENT_TOTAL_CIPHERTEXT_BYTES ||
      sha256Base64Url(ciphertext) !== attachment.ciphertextSha256
    ) throw new Error("Encrypted attachment bytes failed their ciphertext integrity check.");
    let plaintext;
    try {
      plaintext = decryptAesGcm(
        Buffer.from(attachment.key, "base64url"),
        Buffer.from(attachment.fileIv, "base64url"),
        ciphertext,
        attachmentAad(ATTACHMENT_FILE_CONTEXT, messageId, attachment.id),
      );
    } catch {
      throw new Error("Encrypted attachment bytes could not be authenticated.");
    }
    if (plaintext.length !== attachment.bytes || sha256Hex(plaintext) !== attachment.sha256) {
      throw new Error("Encrypted attachment plaintext failed its authenticated size or hash.");
    }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, plaintext, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    materialized.push({ ...attachment, localPath: filePath });
  }
  return materialized.map(({ key: _key, fileIv: _fileIv, ciphertextSize: _size, ciphertextSha256: _hash, downloadUrl: _url, ...safe }) => safe);
}

/** Preserve an author's plaintext files in the same encrypted-state-adjacent cache used after downloads. */
export function cacheE2eeAttachmentInputs(messageId, inputs, metadata) {
  if (!inputs.length) return;
  const root = path.join(path.dirname(identityPath()), "attachments", messageId.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [index, attachment] of metadata.entries()) {
    const input = inputs[index];
    if (!input || input.body.length !== attachment.bytes || input.plaintextSha256 !== attachment.sha256) {
      throw new Error("Encrypted attachment cache input did not match its authenticated metadata.");
    }
    const filePath = path.join(root, safeAttachmentFilename(attachment.name, index, attachment.id));
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, input.body, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
}

export function importE2eeAttachmentPlaintexts(messageId, metadata, contents) {
  const byId = new Map((contents || []).map((item) => [item.attachmentId, item]));
  const root = path.join(path.dirname(identityPath()), "attachments", messageId.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [index, attachment] of (metadata || []).entries()) {
    const content = byId.get(attachment.id);
    if (!content || typeof content.contentBase64 !== "string") {
      throw new Error("Encrypted device history omitted an attachment body.");
    }
    const bytes = Buffer.from(content.contentBase64, "base64");
    if (bytes.length !== attachment.bytes || sha256Hex(bytes) !== attachment.sha256) {
      throw new Error("Encrypted device history attachment failed its size or hash check.");
    }
    const filePath = path.join(root, safeAttachmentFilename(attachment.name, index, attachment.id));
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
  if (byId.size !== (metadata || []).length) {
    throw new Error("Encrypted device history contains unexpected attachment bodies.");
  }
}

export async function encryptE2eeMessage(client, payload, knownStatus) {
  const eventInput = payload.e2eeEvent || null;
  const kind = eventInput ? "message" : (payload.kind || "message");
  if (!["message", "task"].includes(kind)) throw new Error("Encrypted Relay supports messages and direct Requests only.");
  if ((payload.files || []).length) throw new Error("Encrypted file paths must be prepared locally before sending.");
  if (payload.recipient?.groupId) throw new Error("Encrypted group messages are not available yet; nothing was sent.");
  const identity = identityOrThrow();
  const eventId = String(payload.messageId || `erelay_${createHash("sha256")
    .update("relay-e2ee-message-id-v1")
    .update(identity.deviceId)
    .update(String(payload.idempotencyKey || ""))
    .digest("base64url")}`);
  let recipient = payload.recipient || {};
  let conversation = null;
  let logicalMessageId = eventId;
  if (eventInput?.targetRelayId) {
    const target = await encryptedRecord(client, String(eventInput.targetRelayId));
    logicalMessageId = target.plaintext.messageId;
    conversation = target.plaintext.conversation;
    recipient = { relayUserId: otherParticipant(identity, target.wire) };
    if (
      (eventInput.type === "message.edited" || eventInput.type === "message.deleted") &&
      target.plaintext.senderUserId !== identity.userId
    ) throw new Error("Only the sender can edit or delete an encrypted message.");
  } else if (payload.inReplyToRelayId) {
    const target = await encryptedRecord(client, String(payload.inReplyToRelayId));
    recipient = { relayUserId: otherParticipant(identity, target.wire) };
    conversation = {
      ...target.plaintext.conversation,
      replyToMessageId: target.plaintext.messageId,
    };
  }
  const outboxId = `direct:${eventId}`;
  const inputAttachments = attachmentInputs(payload);
  const requestHash = e2eeRequestHash("relay-e2ee-direct-send-request-v1", {
    eventId,
    recipient,
    title: String(payload.title || "").trim() || null,
    forHuman: String(payload.forHuman || ""),
    forAgent: String(payload.forAgent || ""),
    kind,
    type: payload.type || null,
    targetSurfaces: encryptedTargetSurfaces(payload.targetSurfaces),
    source: encryptedSource(payload.source),
    attachments: attachmentRequestBindings(inputAttachments),
    historyImport: payload.historyImport === true,
    historyImportEdited: payload.historyImportEdited === true,
    historyImportDeleted: payload.historyImportDeleted === true,
    historyImportTaskState: payload.historyImportTaskState || null,
    conversation,
    eventInput,
    idempotencyKey: String(payload.idempotencyKey || ""),
  });
  const existingOutbox = readPendingE2eeOutbox(identity, outboxId);
  if (existingOutbox) {
    if (existingOutbox.requestHash !== requestHash) {
      throw new Error("That encrypted idempotency key is already bound to different content.");
    }
    if (existingOutbox.status === "completed") return existingOutbox.response;
    const response = await client.e2eeSendMessage(existingOutbox.wire);
    const completed = completeE2eeOutbox(identity, outboxId, requestHash, response);
    if (existingOutbox.currentSenderPackageRef) {
      mutateKeyPackageState(identity, (state) => { delete state.packages[existingOutbox.currentSenderPackageRef]; });
    }
    return completed;
  }
  await ensureE2eeKeyPackages(client, knownStatus);
  const preparation = await client.e2eePrepareSend({
    recipient,
    idempotencyKey: `${payload.idempotencyKey}:prepare`,
  });
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, preparation.checkpoint);
  await assertE2eeRecipientDevicesTrusted(client, preparation.recipient.relayUserId, { identity });
  await assertPreparedTargets(client, identity, transparency, preparation);

  const cs = await cipherSuite();
  const senderPackage = await generatePackage(identity, cs);
  const senderDecoded = decodeExact(decodeMlsMessage, senderPackage.keyPackage, "sender MLS KeyPackage");
  if (senderDecoded.wireformat !== "mls_key_package") throw new Error("Expected an MLS KeyPackage for the sender.");
  let state = await createGroup(
    textEncoder.encode(`relay:${eventId}`),
    senderDecoded.keyPackage,
    privatePackageFromJson(senderPackage.privatePackage),
    [],
    cs,
    clientConfigFor(transparency),
  );
  const currentSenderTarget = preparation.targets.find((target) =>
    target.deliveryKind === "sender_copy" && target.device.deviceId === identity.deviceId);
  if (!currentSenderTarget) throw new Error("Relay did not prepare a synchronized copy for this sending device.");
  const proposals = preparation.targets
    .filter((target) => target.device.deviceId !== identity.deviceId)
    .map((target) => {
    const decoded = decodeExact(decodeMlsMessage, target.keyPackage, "recipient MLS KeyPackage");
    if (decoded.wireformat !== "mls_key_package") throw new Error("Expected a recipient MLS KeyPackage.");
    return { proposalType: "add", add: { keyPackage: decoded.keyPackage } };
  });
  const committed = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals: proposals, ratchetTreeExtension: true },
  );
  if (!committed.welcome) throw new Error("MLS did not create a Welcome for the recipient devices.");
  state = committed.newState;
  committed.consumed.forEach(zeroOutUint8Array);

  const authoredAt = new Date().toISOString();
  const attachmentEnvelopes = encryptAttachments(eventId, inputAttachments);
  const eventBase = {
    version: 2,
    eventId,
    messageId: logicalMessageId,
    senderUserId: identity.userId,
    senderDeviceId: identity.deviceId,
    recipientUserId: preparation.recipient.relayUserId,
    recipientDeviceIds: preparation.targets
      .filter((target) => target.deliveryKind === "recipient")
      .map((target) => target.device.deviceId)
      .sort(),
    senderDeviceIds: preparation.targets
      .filter((target) => target.deliveryKind === "sender_copy")
      .map((target) => target.device.deviceId)
      .sort(),
    authoredAt,
    conversation: conversation || {
      conversationId: directConversationId(identity.userId, preparation.recipient.relayUserId),
      threadId: eventId,
    },
    transparencyCheckpoint: { ...transparency.checkpoint },
    ...(payload.historyImport ? { historyImport: { version: 1 } } : {}),
  };
  let plaintext;
  switch (eventInput?.type || "message.created") {
    case "message.edited":
      plaintext = {
        ...eventBase,
        eventType: "message.edited",
        revision: Math.max(2, Number(eventInput.revision || 2)),
        forHuman: String(payload.forHuman || ""),
        ...(payload.forAgent !== undefined ? { forAgent: String(payload.forAgent || "") } : {}),
        ...(payload.title !== undefined ? { title: String(payload.title || "").trim() || null } : {}),
        editedAt: authoredAt,
      };
      break;
    case "message.deleted":
      plaintext = {
        ...eventBase,
        eventType: "message.deleted",
        revision: Math.max(2, Number(eventInput.revision || 2)),
        deletedAt: authoredAt,
      };
      break;
    case "reaction.changed":
      plaintext = {
        ...eventBase,
        eventType: "reaction.changed",
        reaction: {
          reactionId: `ereact_${createHash("sha256")
            .update("relay-e2ee-reaction-v1")
            .update(logicalMessageId)
            .update(identity.userId)
            .update(String(eventInput.emoji || ""))
            .digest("base64url")}`,
          emoji: String(eventInput.emoji || ""),
          action: eventInput.action,
          reactedAt: authoredAt,
        },
      };
      break;
    case "receipt.changed":
      plaintext = {
        ...eventBase,
        eventType: "receipt.changed",
        receipt: { state: eventInput.state, occurredAt: authoredAt },
      };
      break;
    case "task.changed":
      plaintext = {
        ...eventBase,
        eventType: "task.changed",
        task: {
          taskId: String(eventInput.taskId || logicalMessageId),
          state: eventInput.state,
          occurredAt: authoredAt,
          ...(eventInput.resultMessageId ? { resultMessageId: String(eventInput.resultMessageId) } : {}),
        },
      };
      break;
    default:
      plaintext = {
        ...eventBase,
        eventType: "message.created",
        revision: 1,
        kind,
        ...(payload.type ? { type: payload.type } : {}),
        ...(String(payload.title || "").trim() ? { title: String(payload.title).trim() } : {}),
        forHuman: String(payload.forHuman || ""),
        forAgent: String(payload.forAgent || ""),
        targetSurfaces: encryptedTargetSurfaces(payload.targetSurfaces),
        ...(encryptedSource(payload.source) ? { source: encryptedSource(payload.source) } : {}),
        ...(kind === "task" ? {
          task: {
            taskId: eventId,
            state: payload.historyImport && payload.historyImportTaskState
              ? payload.historyImportTaskState
              : "requested",
            occurredAt: authoredAt,
          },
        } : {}),
        ...(payload.historyImport && payload.historyImportEdited ? { editedAt: authoredAt } : {}),
        ...(payload.historyImport && payload.historyImportDeleted ? { deletedAt: authoredAt } : {}),
        attachments: attachmentEnvelopes.map((attachment) => attachment.key),
      };
  }
  if (!plaintext.eventId || (plaintext.eventType === "message.created" && !plaintext.forHuman)) {
    throw new Error("Encrypted text requires an event id and human-facing body.");
  }
  const encrypted = await createApplicationMessage(state, textEncoder.encode(JSON.stringify(plaintext)), cs);
  encrypted.consumed.forEach(zeroOutUint8Array);
  const welcome = encodeMlsMessage({ version: E2EE_PROTOCOL, wireformat: "mls_welcome", welcome: committed.welcome });
  const ratchetTree = encodeRatchetTree(state.ratchetTree);
  const ciphertext = encodeMlsMessage({
    version: E2EE_PROTOCOL,
    wireformat: "mls_private_message",
    privateMessage: encrypted.privateMessage,
  });
  const wire = {
    preparationId: preparation.preparationId,
    messageId: eventId,
    welcome: b64(welcome),
    ratchetTree: b64(ratchetTree),
    ciphertext: b64(ciphertext),
    attachments: attachmentEnvelopes.map((attachment) => attachment.wire),
    senderCheckpoint: { ...transparency.checkpoint },
    idempotencyKey: payload.idempotencyKey,
    ...(payload.historyImport ? { historyImport: true } : {}),
  };
  // The MLS creator is already a group member, so it cannot consume its own
  // Welcome. Persist its authenticated plaintext in the encrypted local cache;
  // the server still exposes a sender-copy delivery marker, and every sibling
  // sender device receives a normal Welcome.
  cachePlaintext(identity, eventId, plaintext);
  const durable = writePendingE2eeOutbox(identity, outboxId, {
    requestHash,
    wire,
    currentSenderPackageRef: currentSenderTarget.packageRef,
  });
  if (durable.status === "completed") return durable.response;
  const response = await client.e2eeSendMessage(durable.wire);
  const completed = completeE2eeOutbox(identity, outboxId, requestHash, response);
  mutateKeyPackageState(identity, (state) => { delete state.packages[currentSenderTarget.packageRef]; });
  return completed;
}

function validateDecryptedPlaintext(plaintext, wire, identity, transparency) {
  const authoredAt = typeof plaintext?.authoredAt === "string" ? new Date(plaintext.authoredAt) : null;
  const eventTypes = new Set([
    "message.created",
    "message.edited",
    "message.deleted",
    "reaction.changed",
    "receipt.changed",
    "task.changed",
  ]);
  if (
    plaintext?.version !== 2 ||
    plaintext.eventId !== wire.relayId ||
    typeof plaintext.messageId !== "string" ||
    !eventTypes.has(plaintext.eventType) ||
    plaintext.senderUserId !== wire.sender.relayUserId ||
    plaintext.senderDeviceId !== wire.sender.deviceId ||
    plaintext.recipientUserId !== wire.recipient.relayUserId ||
    !Array.isArray(plaintext.recipientDeviceIds) ||
    !Array.isArray(plaintext.senderDeviceIds) ||
    wire.delivery?.deviceId !== identity.deviceId ||
    wire.delivery?.ownerUserId !== identity.userId ||
    (
      wire.delivery?.kind === "recipient"
        ? plaintext.recipientUserId !== identity.userId || !plaintext.recipientDeviceIds.includes(identity.deviceId)
        : wire.delivery?.kind === "sender_copy"
          ? plaintext.senderUserId !== identity.userId || !plaintext.senderDeviceIds.includes(identity.deviceId)
          : true
    ) ||
    !authoredAt ||
    !Number.isFinite(authoredAt.getTime()) ||
    authoredAt.toISOString() !== plaintext.authoredAt ||
    typeof plaintext.conversation?.conversationId !== "string" ||
    typeof plaintext.conversation?.threadId !== "string" ||
    (plaintext.historyImport !== undefined && plaintext.historyImport?.version !== 1) ||
    plaintext.transparencyCheckpoint?.size !== wire.senderCheckpoint.size ||
    plaintext.transparencyCheckpoint?.headHash !== wire.senderCheckpoint.headHash ||
    (plaintext.eventType === "message.created" && (
      plaintext.messageId !== plaintext.eventId ||
      plaintext.revision !== 1 ||
      !["message", "task"].includes(plaintext.kind || "message") ||
      (plaintext.type !== undefined && !["question", "completion"].includes(plaintext.type)) ||
      typeof plaintext.forHuman !== "string" ||
      !plaintext.forHuman ||
      typeof plaintext.forAgent !== "string" ||
      !Array.isArray(plaintext.targetSurfaces || []) ||
      (plaintext.kind === "task" && (
        plaintext.task?.taskId !== plaintext.eventId ||
        (!plaintext.historyImport && plaintext.task?.state !== "requested") ||
        !["requested", "accepted", "started", "completed", "failed", "declined", "cancelled"].includes(plaintext.task?.state) ||
        plaintext.task?.occurredAt !== plaintext.authoredAt
      )) ||
      (plaintext.kind !== "task" && plaintext.task !== undefined) ||
      ((plaintext.editedAt !== undefined || plaintext.deletedAt !== undefined) && !plaintext.historyImport) ||
      (plaintext.editedAt !== undefined && plaintext.editedAt !== plaintext.authoredAt) ||
      (plaintext.deletedAt !== undefined && plaintext.deletedAt !== plaintext.authoredAt) ||
      !Array.isArray(plaintext.attachments || [])
    )) ||
    (plaintext.eventType === "message.edited" && (
      !Number.isInteger(plaintext.revision) || plaintext.revision < 2 ||
      typeof plaintext.forHuman !== "string" || !plaintext.forHuman ||
      plaintext.editedAt !== plaintext.authoredAt
    )) ||
    (plaintext.eventType === "message.deleted" && (
      !Number.isInteger(plaintext.revision) || plaintext.revision < 2 ||
      plaintext.deletedAt !== plaintext.authoredAt
    )) ||
    (plaintext.eventType === "reaction.changed" && (
      typeof plaintext.reaction?.reactionId !== "string" ||
      typeof plaintext.reaction?.emoji !== "string" || !plaintext.reaction.emoji ||
      !["add", "remove"].includes(plaintext.reaction?.action) ||
      plaintext.reaction?.reactedAt !== plaintext.authoredAt
    )) ||
    (plaintext.eventType === "receipt.changed" && (
      !["delivered", "read", "acknowledged"].includes(plaintext.receipt?.state) ||
      plaintext.receipt?.occurredAt !== plaintext.authoredAt
    )) ||
    (plaintext.eventType === "task.changed" && (
      typeof plaintext.task?.taskId !== "string" ||
      !["requested", "accepted", "started", "completed", "failed", "declined", "cancelled"].includes(plaintext.task?.state) ||
      plaintext.task?.occurredAt !== plaintext.authoredAt
    ))
  ) throw new Error("Encrypted Relay metadata did not authenticate against its MLS plaintext.");
  assertKnownCheckpoint(transparency, plaintext.transparencyCheckpoint);
  const attachmentKeys = ["message.created", "message.edited"].includes(plaintext.eventType)
    ? plaintext.attachments || []
    : [];
  return {
    ...plaintext,
    attachments: attachmentKeys,
    attachmentMetadata: decryptAttachmentMetadata(
      plaintext.eventId,
      attachmentKeys,
      wire.attachments || [],
    ),
  };
}

export async function decryptE2eeWireMessage(client, wire) {
  const identity = identityOrThrow();
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, wire.senderCheckpoint);
  await assertE2eeSenderDeviceTrusted(client, wire.sender.relayUserId, wire.sender.deviceId, { identity });
  const cached = readCachedPlaintext(identity, wire.relayId);
  if (cached) return validateDecryptedPlaintext(cached, wire, identity, transparency);

  const packageState = readKeyPackageState(identity);
  const localPackage = packageState.packages[wire.keyPackageRef];
  if (!localPackage) {
    throw new Error("This device no longer has the one-time MLS KeyPackage needed to open this Relay.");
  }
  const cs = await cipherSuite();
  const keyPackageMessage = decodeExact(decodeMlsMessage, localPackage.keyPackage, "local MLS KeyPackage");
  const welcomeMessage = decodeExact(decodeMlsMessage, wire.welcome, "MLS Welcome");
  const privateMessage = decodeExact(decodeMlsMessage, wire.ciphertext, "MLS ciphertext");
  const ratchetTree = decodeExact(decodeRatchetTree, wire.ratchetTree, "MLS ratchet tree");
  if (
    keyPackageMessage.wireformat !== "mls_key_package" ||
    welcomeMessage.wireformat !== "mls_welcome" ||
    privateMessage.wireformat !== "mls_private_message"
  ) throw new Error("Encrypted Relay contains the wrong MLS wire formats.");
  const group = await joinGroup(
    welcomeMessage.welcome,
    keyPackageMessage.keyPackage,
    privatePackageFromJson(localPackage.privatePackage),
    emptyPskIndex,
    cs,
    ratchetTree,
    undefined,
    clientConfigFor(transparency, wire.senderCheckpoint),
  );
  const opened = await processPrivateMessage(group, privateMessage.privateMessage, emptyPskIndex, cs);
  if (opened.kind !== "applicationMessage") throw new Error("Encrypted Relay did not contain an MLS application message.");
  let plaintext;
  try { plaintext = JSON.parse(textDecoder.decode(opened.message)); } catch {
    throw new Error("Encrypted Relay plaintext is not valid UTF-8 JSON.");
  } finally {
    opened.consumed.forEach(zeroOutUint8Array);
  }
  plaintext = validateDecryptedPlaintext(plaintext, wire, identity, transparency);
  cachePlaintext(identity, wire.relayId, plaintext);
  mutateKeyPackageState(identity, (state) => { delete state.packages[wire.keyPackageRef]; });
  return plaintext;
}

function taskReceiptFields(plaintext) {
  if ((plaintext.kind || "message") !== "task" || !plaintext.task) return {};
  const state = plaintext.task.state;
  return {
    taskId: plaintext.task.taskId,
    taskState: plaintext.taskState || state,
    ...(plaintext.taskAcceptedAt || state === "accepted"
      ? { taskAcceptedAt: plaintext.taskAcceptedAt || plaintext.task.occurredAt }
      : {}),
    ...(plaintext.taskStartedAt || ["started", "completed"].includes(state)
      ? { taskStartedAt: plaintext.taskStartedAt || plaintext.task.occurredAt }
      : {}),
    ...(plaintext.taskCompletedAt || state === "completed"
      ? { taskCompletedAt: plaintext.taskCompletedAt || plaintext.task.occurredAt }
      : {}),
  };
}

function encryptedItemFields(plaintext) {
  return {
    kind: plaintext.kind || "message",
    ...(plaintext.type ? { type: plaintext.type } : {}),
    source: plaintext.source || { host: "relay-companion" },
    targetSurfaces: plaintext.targetSurfaces || [],
    ...(plaintext.historyImport ? { historyImported: true } : {}),
    ...taskReceiptFields(plaintext),
  };
}

export function e2eeInboxItem(wire, plaintext) {
  const attachments = (plaintext.attachmentMetadata || []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    bytes: attachment.bytes,
    sha256: attachment.sha256,
    openUrl: attachment.downloadUrl,
  }));
  return {
    relayId: wire.relayId,
    state: plaintext.historyImport ? "acknowledged" : plaintext.localReceiptState || wire.state,
    createdAt: plaintext.createdAt || plaintext.authoredAt,
    updatedAt: plaintext.updatedAt || wire.updatedAt,
    ...encryptedItemFields(plaintext),
    ...(plaintext.title ? { title: plaintext.title, displayTitle: plaintext.title } : {}),
    sender: { relayUserId: wire.sender.relayUserId, name: wire.sender.name },
    preview: plaintext.deletedAt ? "Message deleted" : plaintext.forHuman,
    forHuman: plaintext.deletedAt ? "Message deleted" : plaintext.forHuman,
    forAgent: plaintext.forAgent || "",
    ...(plaintext.conversation?.replyToMessageId ? { inReplyToRelayId: plaintext.conversation.replyToMessageId } : {}),
    threadId: plaintext.conversation?.threadId || wire.relayId,
    ...(plaintext.editedAt ? { editedAt: plaintext.editedAt } : {}),
    ...(plaintext.deletedAt ? { deletedAt: plaintext.deletedAt } : {}),
    hasAttachments: attachments.length > 0,
    attachments,
    reactions: plaintext.reactions || { aggregates: [], events: [] },
    e2ee: { protocol: E2EE_PROTOCOL, cipherSuite: E2EE_CIPHER_SUITE, senderDeviceId: wire.sender.deviceId },
  };
}

export function e2eeSentItem(wire, plaintext) {
  const attachments = (plaintext.attachmentMetadata || []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    bytes: attachment.bytes,
    sha256: attachment.sha256,
    openUrl: attachment.downloadUrl,
  }));
  return {
    relayId: wire.relayId,
    state: plaintext.recipientReceiptState || "delivered",
    createdAt: plaintext.createdAt || plaintext.authoredAt,
    updatedAt: plaintext.updatedAt || wire.updatedAt,
    ...(plaintext.recipientReadAt ? { readAt: plaintext.recipientReadAt } : {}),
    ...encryptedItemFields(plaintext),
    ...(plaintext.title ? { title: plaintext.title, displayTitle: plaintext.title } : {}),
    recipient: { name: wire.recipient.name, onRelay: true },
    preview: plaintext.deletedAt ? "Message deleted" : plaintext.forHuman,
    forHuman: plaintext.deletedAt ? "Message deleted" : plaintext.forHuman,
    forAgent: plaintext.forAgent || "",
    ...(plaintext.conversation?.replyToMessageId ? { inReplyToRelayId: plaintext.conversation.replyToMessageId } : {}),
    threadId: plaintext.conversation?.threadId || wire.relayId,
    ...(plaintext.editedAt ? { editedAt: plaintext.editedAt } : {}),
    ...(plaintext.deletedAt ? { deletedAt: plaintext.deletedAt } : {}),
    delivery: {
      channel: "device",
      state: plaintext.recipientReceiptState || "delivered",
      sentAt: wire.createdAt,
      ...(plaintext.recipientReadAt ? { openedAt: plaintext.recipientReadAt } : {}),
    },
    hasAttachments: attachments.length > 0,
    attachments,
    reactions: plaintext.reactions || { aggregates: [], events: [] },
    e2ee: { protocol: E2EE_PROTOCOL, cipherSuite: E2EE_CIPHER_SUITE, senderDeviceId: wire.sender.deviceId },
  };
}

export function e2eeThreadItem(wire, plaintext) {
  const outbound = wire.delivery.kind === "sender_copy";
  return {
    ...(outbound ? e2eeSentItem(wire, plaintext) : e2eeInboxItem(wire, plaintext)),
    sender: { relayUserId: wire.sender.relayUserId, name: wire.sender.name },
    recipient: { relayUserId: wire.recipient.relayUserId, name: wire.recipient.name, onRelay: true },
    direction: outbound ? "outbound" : "inbound",
    readReceipts: outbound
      ? [{ name: wire.recipient.name, seen: Boolean(plaintext.recipientReadAt), ...(plaintext.recipientReadAt ? { readAt: plaintext.recipientReadAt } : {}) }]
      : [],
  };
}

export async function e2eePacket(wire, plaintext) {
  const attachments = await materializeE2eeAttachments(wire.relayId, plaintext.attachmentMetadata || []);
  return {
    packet: {
      schemaVersion: 3,
      id: wire.relayId,
      relayId: wire.relayId,
      createdAt: plaintext.createdAt || plaintext.authoredAt,
      ...encryptedItemFields(plaintext),
      ...(plaintext.title ? { title: plaintext.title, displayTitle: plaintext.title } : {}),
      forHuman: plaintext.deletedAt ? "Message deleted" : plaintext.forHuman,
      forAgent: plaintext.forAgent || "",
      sender: { relayUserId: wire.sender.relayUserId, name: wire.sender.name },
      recipient: { relayUserId: wire.recipient.relayUserId, name: "You" },
      ...(plaintext.conversation?.replyToMessageId ? { inReplyToRelayId: plaintext.conversation.replyToMessageId } : {}),
      threadId: plaintext.conversation?.threadId || wire.relayId,
      ...(plaintext.editedAt ? { editedAt: plaintext.editedAt } : {}),
      ...(plaintext.deletedAt ? { deletedAt: plaintext.deletedAt } : {}),
      reactions: plaintext.reactions || { aggregates: [], events: [] },
      attachments,
      e2ee: { protocol: E2EE_PROTOCOL, cipherSuite: E2EE_CIPHER_SUITE, senderDeviceId: wire.sender.deviceId },
    },
    attachmentUrls: {},
  };
}

export function newE2eeMessageId() {
  return `erelay_${randomBytes(18).toString("base64url")}`;
}
