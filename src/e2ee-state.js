import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import atomicJson from "./atomic-json.cjs";
import stateLock from "./state-lock.cjs";
import e2eeIdentity from "./e2ee-identity.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { withJsonLockStrict } = stateLock;
const { identityPath } = e2eeIdentity;

export const E2EE_TRANSPARENCY_EMPTY_CONTEXT = "relay-key-transparency-empty-v1";
export const E2EE_TRANSPARENCY_ENTRY_CONTEXT = "relay-key-transparency-entry-v1";
export const E2EE_TRANSPARENCY_CHAIN_CONTEXT = "relay-key-transparency-chain-v1";
export const E2EE_KEY_PACKAGE_PROOF_CONTEXT = "relay-e2ee-key-package-v1";
export const E2EE_MLS_CREDENTIAL_CONTEXT = "relay-e2ee-mls-credential-v1";
const E2EE_OUTBOX_COMPLETED_LIMIT = 2_000;
export const E2EE_TRANSPARENCY_EMPTY_HASH = createHash("sha256")
  .update(E2EE_TRANSPARENCY_EMPTY_CONTEXT)
  .digest("base64url");

function statePath(name, options = {}) {
  return path.join(path.dirname(identityPath(options)), name);
}

export function e2eeKeyPackagesPath(options = {}) {
  return statePath("e2ee-key-packages.json", options);
}

export function e2eeTransparencyPath(options = {}) {
  return statePath("e2ee-transparency.json", options);
}

export function e2eeMessageCachePath(options = {}) {
  return statePath("e2ee-message-cache.json", options);
}

export function e2eeOutboxPath(options = {}) {
  return statePath("e2ee-outbox.json", options);
}

export function e2eeGroupStatesPath(options = {}) {
  return statePath("e2ee-group-states.json", options);
}

export function e2eeImportedHistoryPath(options = {}) {
  return statePath("e2ee-imported-history.json", options);
}

export function e2eeDeviceTrustPath(options = {}) {
  return statePath("e2ee-device-trust.json", options);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalizeJson(item));
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalizeJson(value[key]);
    }
    return result;
  }
  return value;
}

/** Stable local binding between an idempotency key and the content it means. */
export function e2eeRequestHash(context, value) {
  return createHash("sha256")
    .update(String(context))
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("base64url");
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function canonicalTransparencyEntry(input) {
  return JSON.stringify([
    E2EE_TRANSPARENCY_ENTRY_CONTEXT,
    input.sequence,
    input.type,
    input.relayUserId,
    input.deviceId,
    input.protocol,
    input.cipherSuite,
    input.signaturePublicKey,
    input.fingerprint,
    input.deviceExpiresAt,
    input.createdAt,
  ]);
}

export function canonicalTransparencyChain(priorHeadHash, entryHash) {
  return JSON.stringify([E2EE_TRANSPARENCY_CHAIN_CONTEXT, priorHeadHash, entryHash]);
}

export function canonicalKeyPackageProof(input) {
  return JSON.stringify([
    E2EE_KEY_PACKAGE_PROOF_CONTEXT,
    input.deviceId,
    input.packageRef,
    input.keyPackage,
    input.expiresAt,
  ]);
}

export function canonicalMlsCredential(input) {
  return JSON.stringify({
    version: 1,
    context: E2EE_MLS_CREDENTIAL_CONTEXT,
    relayUserId: input.relayUserId,
    deviceId: input.deviceId,
    fingerprint: input.fingerprint,
  });
}

export function parseMlsCredential(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (
      parsed?.version !== 1 ||
      parsed?.context !== E2EE_MLS_CREDENTIAL_CONTEXT ||
      !parsed.relayUserId ||
      !parsed.deviceId ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(parsed.fingerprint || ""))
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function freshTransparencyState(identity) {
  return {
    version: 1,
    userId: identity.userId,
    deviceId: identity.deviceId,
    checkpoint: { size: "0", headHash: E2EE_TRANSPARENCY_EMPTY_HASH },
    heads: { "0": E2EE_TRANSPARENCY_EMPTY_HASH },
    users: {},
    highestE2eeMode: "off",
  };
}

const E2EE_MODE_RANK = { off: 0, optional: 1, required: 2 };

export function readTransparencyState(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeTransparencyPath(options), "utf8"));
    if (
      state?.version === 1 &&
      state.userId === identity.userId &&
      state.deviceId === identity.deviceId &&
      /^(0|[1-9][0-9]*)$/.test(String(state.checkpoint?.size || "")) &&
      /^[A-Za-z0-9_-]{43}$/.test(String(state.checkpoint?.headHash || "")) &&
      state.heads &&
      state.users
    ) {
      if (!Object.hasOwn(E2EE_MODE_RANK, state.highestE2eeMode)) state.highestE2eeMode = "off";
      return state;
    }
  } catch {}
  return freshTransparencyState(identity);
}

function applyTransparencyEntry(state, entry) {
  const expectedSequence = (BigInt(state.checkpoint.size) + 1n).toString();
  if (entry.sequence !== expectedSequence || entry.priorHeadHash !== state.checkpoint.headHash) {
    throw new Error("Relay key transparency history is inconsistent with this device's saved checkpoint.");
  }
  const entryHash = sha256Base64Url(canonicalTransparencyEntry(entry));
  const headHash = sha256Base64Url(canonicalTransparencyChain(entry.priorHeadHash, entryHash));
  if (entry.entryHash !== entryHash || entry.headHash !== headHash) {
    throw new Error("Relay key transparency history failed cryptographic verification.");
  }
  const user = state.users[entry.relayUserId] || { devices: {} };
  if (entry.type === "device_enrolled") {
    const existing = user.devices[entry.deviceId];
    if (existing && (
      existing.signaturePublicKey !== entry.signaturePublicKey ||
      existing.fingerprint !== entry.fingerprint ||
      existing.protocol !== entry.protocol ||
      existing.cipherSuite !== entry.cipherSuite ||
      String(existing.expiresAt || "") !== String(entry.deviceExpiresAt || "")
    )) {
      throw new Error("Relay key transparency history attempted to replace an enrolled device identity.");
    }
    user.devices[entry.deviceId] = {
      protocol: entry.protocol,
      cipherSuite: entry.cipherSuite,
      signaturePublicKey: entry.signaturePublicKey,
      fingerprint: entry.fingerprint,
      enrollmentSequence: entry.sequence,
      enrolledAt: entry.createdAt,
      expiresAt: entry.deviceExpiresAt,
      revocationSequence: null,
      revokedAt: null,
    };
  } else {
    const existing = user.devices[entry.deviceId];
    if (
      !existing ||
      existing.signaturePublicKey !== entry.signaturePublicKey ||
      existing.fingerprint !== entry.fingerprint ||
      existing.protocol !== entry.protocol ||
      existing.cipherSuite !== entry.cipherSuite ||
      String(existing.expiresAt || "") !== String(entry.deviceExpiresAt || "")
    ) {
      throw new Error("Relay key transparency history revoked an unknown device identity.");
    }
    existing.revocationSequence = entry.sequence;
    existing.revokedAt = entry.createdAt;
  }
  state.users[entry.relayUserId] = user;
  state.checkpoint = { size: entry.sequence, headHash: entry.headHash };
  state.heads[entry.sequence] = entry.headHash;
}

function persistTransparencyAdvance(identity, before, after, options = {}) {
  const file = e2eeTransparencyPath(options);
  const locked = withJsonLockStrict(file, () => {
    const current = readTransparencyState(identity, options);
    if (
      current.checkpoint.size !== before.size ||
      current.checkpoint.headHash !== before.headHash
    ) return false;
    if (E2EE_MODE_RANK[current.highestE2eeMode] > E2EE_MODE_RANK[after.highestE2eeMode]) {
      after.highestE2eeMode = current.highestE2eeMode;
    }
    atomicWriteJsonSync(file, after, { mode: 0o600 });
    return true;
  });
  if (!locked.ok) throw new Error("Relay could not lock its local key transparency state; retry safely.");
  return locked.value;
}

/** Once an enrolled device has used E2EE, a server response cannot silently move it back to plaintext. */
export function assertAndPinE2eeMode(identity, mode, options = {}) {
  if (!Object.hasOwn(E2EE_MODE_RANK, mode)) throw new Error("Relay returned an unknown E2EE mode.");
  const file = e2eeTransparencyPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readTransparencyState(identity, options);
    if (E2EE_MODE_RANK[mode] < E2EE_MODE_RANK[state.highestE2eeMode]) {
      throw new Error(
        `Relay attempted to downgrade this device from ${state.highestE2eeMode} E2EE mode to ${mode}. Nothing was sent or opened.`,
      );
    }
    if (E2EE_MODE_RANK[mode] > E2EE_MODE_RANK[state.highestE2eeMode]) {
      state.highestE2eeMode = mode;
      atomicWriteJsonSync(file, state, { mode: 0o600 });
    }
    return mode;
  });
  if (!locked.ok) throw new Error("Relay could not lock its local E2EE downgrade policy; retry safely.");
  return locked.value;
}

/** Replay and pin the append-only device directory. The raw directory endpoint is never trusted here. */
export async function syncTransparency(client, identity, options = {}) {
  for (;;) {
    const state = readTransparencyState(identity, options);
    const before = { ...state.checkpoint };
    const page = await client.e2eeTransparencySync({ afterSize: before.size, limit: 500 });
    if (page.from.size !== before.size || page.from.headHash !== before.headHash) {
      throw new Error("Relay presented a different key transparency history to this device.");
    }
    for (const entry of page.entries || []) applyTransparencyEntry(state, entry);
    if (
      state.checkpoint.size !== page.checkpoint.size ||
      state.checkpoint.headHash !== page.checkpoint.headHash
    ) throw new Error("Relay key transparency page ended at an unverified checkpoint.");
    if (!persistTransparencyAdvance(identity, before, state, options)) continue;
    if (page.complete) return readTransparencyState(identity, options);
  }
}

export function assertKnownCheckpoint(state, checkpoint) {
  const known = state.heads[String(checkpoint?.size || "")];
  if (!known || known !== checkpoint?.headHash) {
    throw new Error("Relay presented conflicting key transparency checkpoints. Nothing was sent or opened.");
  }
}

export function activeDeviceFromTransparency(state, relayUserId, deviceId) {
  const device = state.users?.[relayUserId]?.devices?.[deviceId];
  const unexpired = device && (!device.expiresAt || Date.parse(device.expiresAt) > Date.now());
  return unexpired && !device.revokedAt ? device : null;
}

/** Resolve a credential at the checkpoint authenticated inside its message. */
export function deviceAtTransparencyCheckpoint(state, relayUserId, deviceId, checkpointSize) {
  const device = state.users?.[relayUserId]?.devices?.[deviceId];
  if (!device) return null;
  try {
    const at = BigInt(checkpointSize);
    const enrolled = BigInt(device.enrollmentSequence || "0");
    const revoked = device.revocationSequence ? BigInt(device.revocationSequence) : null;
    return enrolled > 0n && enrolled <= at && (revoked === null || revoked > at) ? device : null;
  } catch {
    return null;
  }
}

function freshDeviceTrustState(identity) {
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, users: {} };
}

/** Local TOFU/cross-signing pins. The service can route public proofs, but it cannot rewrite this trust anchor. */
export function readE2eeDeviceTrust(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeDeviceTrustPath(options), "utf8"));
    if (
      state?.version === 1 &&
      state.userId === identity.userId &&
      state.deviceId === identity.deviceId &&
      state.users &&
      typeof state.users === "object"
    ) return state;
  } catch {}
  return freshDeviceTrustState(identity);
}

export function mutateE2eeDeviceTrust(identity, mutate, options = {}) {
  const file = e2eeDeviceTrustPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readE2eeDeviceTrust(identity, options);
    const value = mutate(state);
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return value;
  });
  if (!locked.ok) throw new Error("Relay could not lock its device trust state; retry safely.");
  return locked.value;
}

function freshKeyPackageState(identity) {
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, packages: {} };
}

export function readKeyPackageState(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeKeyPackagesPath(options), "utf8"));
    if (state?.version === 1 && state.userId === identity.userId && state.deviceId === identity.deviceId && state.packages) {
      return state;
    }
  } catch {}
  return freshKeyPackageState(identity);
}

export function mutateKeyPackageState(identity, mutate, options = {}) {
  const file = e2eeKeyPackagesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readKeyPackageState(identity, options);
    const value = mutate(state);
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return value;
  });
  if (!locked.ok) throw new Error("Relay could not lock its local MLS KeyPackages; retry safely.");
  return locked.value;
}

function messageCacheKey(identity) {
  return createHash("sha256")
    .update("relay-e2ee-local-message-cache-v1")
    .update(Buffer.from(String(identity.privateKeyJwk?.d || ""), "base64url"))
    .digest();
}

function outboxKey(identity) {
  return createHash("sha256")
    .update("relay-e2ee-local-outbox-v1")
    .update(Buffer.from(String(identity.privateKeyJwk?.d || ""), "base64url"))
    .digest();
}

function groupStateKey(identity) {
  return createHash("sha256")
    .update("relay-e2ee-local-group-state-v1")
    .update(Buffer.from(String(identity.privateKeyJwk?.d || ""), "base64url"))
    .digest();
}

function groupStateAad(identity, groupId) {
  return Buffer.from(JSON.stringify([
    "relay-e2ee-local-group-state-v1",
    identity.userId,
    identity.deviceId,
    groupId,
  ]), "utf8");
}

function groupEventAad(identity, groupId, eventId) {
  return Buffer.from(JSON.stringify([
    "relay-e2ee-local-group-event-v1",
    identity.userId,
    identity.deviceId,
    groupId,
    eventId,
  ]), "utf8");
}

function groupOutboxAad(identity, groupId, eventId) {
  return Buffer.from(JSON.stringify([
    "relay-e2ee-local-group-outbox-v1",
    identity.userId,
    identity.deviceId,
    groupId,
    eventId,
  ]), "utf8");
}

function encryptGroupEvent(identity, groupId, eventId, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", groupStateKey(identity), iv);
  cipher.setAAD(groupEventAad(identity, groupId, eventId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function encryptGroupOutbox(identity, groupId, eventId, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", groupStateKey(identity), iv);
  cipher.setAAD(groupOutboxAad(identity, groupId, eventId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")),
    cipher.final(),
  ]);
  return {
    updatedAt: new Date().toISOString(),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptGroupOutbox(identity, groupId, eventId, item) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", groupStateKey(identity), Buffer.from(item.iv, "base64url"));
    decipher.setAAD(groupOutboxAad(identity, groupId, eventId));
    decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
    const value = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    if (
      !value?.requestHash ||
      !["pending", "completed"].includes(value.status) ||
      (value.status === "pending" && !value.wire) ||
      (value.status === "completed" && !value.response)
    ) throw new Error("invalid outbox value");
    return value;
  } catch {
    throw new Error("Relay's encrypted local group outbox could not be authenticated.");
  }
}

function freshGroupState(identity) {
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, groups: {} };
}

function readGroupStateFile(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeGroupStatesPath(options), "utf8"));
    if (state?.version === 1 && state.userId === identity.userId && state.deviceId === identity.deviceId && state.groups) {
      return state;
    }
  } catch {}
  return freshGroupState(identity);
}

/** Read one MLS GroupState. Its serialized secrets are authenticated and encrypted at rest. */
export function readEncryptedGroupState(identity, groupId, options = {}) {
  const item = readGroupStateFile(identity, options).groups[groupId];
  if (!item) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", groupStateKey(identity), Buffer.from(item.iv, "base64url"));
    decipher.setAAD(groupStateAad(identity, groupId));
    decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return {
      bytes: new Uint8Array(plaintext),
      epoch: String(item.epoch),
      membershipRevision: String(item.membershipRevision),
      stateRevision: Number(item.stateRevision || 0),
      updatedAt: String(item.updatedAt),
    };
  } catch {
    throw new Error("Relay's encrypted local MLS group state could not be authenticated.");
  }
}

/** A processed event is committed in the same atomic JSON replacement as the advanced MLS ratchet. */
export function readProcessedGroupEvent(identity, groupId, eventId, options = {}) {
  const item = readGroupStateFile(identity, options).groups[groupId]?.processedEvents?.[eventId];
  if (!item) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", groupStateKey(identity), Buffer.from(item.iv, "base64url"));
    decipher.setAAD(groupEventAad(identity, groupId, eventId));
    decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
    const value = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    // v1 cached the plaintext directly. Product-integrated group messages also
    // retain their opaque wire metadata so an acknowledged message can still
    // be rendered after a restart without asking the service for ciphertext it
    // is free to retire.
    return value?.plaintext || value;
  } catch {
    throw new Error("Relay's encrypted local group-event cache could not be authenticated.");
  }
}

/** Every durable group event available to the local product projection. */
export function readProcessedGroupEvents(identity, options = {}) {
  const state = readGroupStateFile(identity, options);
  const opened = [];
  for (const [groupId, group] of Object.entries(state.groups || {})) {
    for (const [eventId, item] of Object.entries(group.processedEvents || {})) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", groupStateKey(identity), Buffer.from(item.iv, "base64url"));
        decipher.setAAD(groupEventAad(identity, groupId, eventId));
        decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
        const value = JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(item.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8"));
        opened.push({
          groupId,
          eventId,
          plaintext: value?.plaintext || value,
          ...(value?.wire ? { wire: value.wire } : {}),
        });
      } catch {
        throw new Error("Relay's encrypted local group-event cache could not be authenticated.");
      }
    }
  }
  return opened;
}

/** Exact wire bytes waiting for an idempotent group-send acknowledgement. */
export function readPendingGroupOutbox(identity, groupId, eventId, options = {}) {
  const item = readGroupStateFile(identity, options).groups[groupId]?.pendingOutbox?.[eventId];
  return item ? decryptGroupOutbox(identity, groupId, eventId, item) : null;
}

/** The one MLS epoch transition this group must finish or roll back before sending. */
export function readPendingGroupTransition(identity, groupId, options = {}) {
  const item = readGroupStateFile(identity, options).groups[groupId]?.pendingTransition;
  if (!item) return null;
  if (!item.transitionId) throw new Error("Relay's encrypted local group transition is malformed.");
  return {
    transitionId: item.transitionId,
    ...decryptGroupOutbox(identity, groupId, item.transitionId, item),
  };
}

/** Atomically replace one MLS GroupState after every ratchet or epoch advance. */
export function writeEncryptedGroupState(identity, groupId, value, options = {}) {
  const file = e2eeGroupStatesPath(options);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", groupStateKey(identity), iv);
  cipher.setAAD(groupStateAad(identity, groupId));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value.bytes)), cipher.final()]);
  const encryptedItem = {
    epoch: String(value.epoch),
    membershipRevision: String(value.membershipRevision),
    updatedAt: new Date().toISOString(),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
  };
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const current = state.groups[groupId];
    if (current && BigInt(current.epoch) > BigInt(encryptedItem.epoch)) {
      throw new Error("Relay refused to overwrite a newer local MLS group epoch.");
    }
    const currentRevision = Number(current?.stateRevision || 0);
    if (value.expectedStateRevision !== undefined && currentRevision !== value.expectedStateRevision) {
      throw new Error("Relay detected a concurrent MLS group-state advance. Nothing was sent or acknowledged; retry safely.");
    }
    const stateRevision = currentRevision + 1;
    const processedEvents = { ...(current?.processedEvents || {}) };
    if (value.processedEvent) {
      processedEvents[value.processedEvent.eventId] = encryptGroupEvent(
        identity,
        groupId,
        value.processedEvent.eventId,
        value.processedEvent.wire
          ? { plaintext: value.processedEvent.plaintext, wire: value.processedEvent.wire }
          : value.processedEvent.plaintext,
      );
      const ids = Object.keys(processedEvents);
      for (const eventId of ids.slice(0, Math.max(0, ids.length - 2_000))) delete processedEvents[eventId];
    }
    const pendingOutbox = { ...(current?.pendingOutbox || {}) };
    if (value.pendingOutbox) {
      const eventId = value.pendingOutbox.eventId;
      const existing = pendingOutbox[eventId]
        ? decryptGroupOutbox(identity, groupId, eventId, pendingOutbox[eventId])
        : null;
      if (existing && existing.requestHash !== value.pendingOutbox.requestHash) {
        throw new Error("That encrypted group idempotency key is already bound to different content.");
      }
      if (!existing) {
        pendingOutbox[eventId] = encryptGroupOutbox(identity, groupId, eventId, {
          status: "pending",
          requestHash: value.pendingOutbox.requestHash,
          wire: value.pendingOutbox.wire,
        });
      }
    }
    let pendingTransition = current?.pendingTransition;
    if (value.pendingTransition) {
      const transitionId = value.pendingTransition.transitionId;
      const existing = pendingTransition
        ? decryptGroupOutbox(identity, groupId, pendingTransition.transitionId, pendingTransition)
        : null;
      if (existing?.status === "pending") {
        if (
          pendingTransition.transitionId !== transitionId ||
          existing.requestHash !== value.pendingTransition.requestHash
        ) throw new Error("Another encrypted group membership transition is still pending.");
        throw new Error("That encrypted group membership transition is already pending.");
      }
      pendingTransition = {
        transitionId,
        ...encryptGroupOutbox(identity, groupId, transitionId, {
          status: "pending",
          requestHash: value.pendingTransition.requestHash,
          wire: value.pendingTransition.wire,
          rollbackState: value.pendingTransition.rollbackState,
          appliedStateRevision: stateRevision,
        }),
      };
    }
    state.groups[groupId] = {
      ...encryptedItem,
      stateRevision,
      processedEvents,
      pendingOutbox,
      ...(pendingTransition ? { pendingTransition } : {}),
    };
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return stateRevision;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
  return locked.value;
}

/** Mark the exact epoch transition accepted without touching the already-advanced MLS state. */
export function completeGroupTransition(
  identity,
  groupId,
  transitionId,
  expectedRequestHash,
  response,
  options = {},
) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const group = state.groups[groupId];
    const item = group?.pendingTransition;
    if (!item || item.transitionId !== transitionId) {
      throw new Error("Relay could not find the encrypted group transition it just delivered.");
    }
    const value = decryptGroupOutbox(identity, groupId, transitionId, item);
    if (value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to complete a different encrypted group transition.");
    }
    if (value.status === "completed") return value.response;
    state.groups[groupId] = {
      ...group,
      pendingTransition: {
        transitionId,
        ...encryptGroupOutbox(identity, groupId, transitionId, {
          status: "completed",
          requestHash: value.requestHash,
          response,
          completedAt: new Date().toISOString(),
        }),
      },
    };
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return response;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
  return locked.value;
}

/** Restore the exact pre-Commit state after the server proves another Commit won the epoch CAS. */
export function rollbackPendingGroupTransition(
  identity,
  groupId,
  transitionId,
  expectedRequestHash,
  options = {},
) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const group = state.groups[groupId];
    const item = group?.pendingTransition;
    if (!item || item.transitionId !== transitionId) return false;
    const value = decryptGroupOutbox(identity, groupId, transitionId, item);
    if (value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to roll back a different encrypted group transition.");
    }
    if (value.status !== "pending" || !value.rollbackState?.bytes) {
      throw new Error("Relay cannot roll back an acknowledged encrypted group transition.");
    }
    const currentRevision = Number(group.stateRevision || 0);
    if (
      currentRevision !== Number(value.appliedStateRevision) ||
      String(group.epoch) !== String(value.wire?.epoch)
    ) throw new Error("Relay refused to roll back because local MLS state advanced after the pending transition.");

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", groupStateKey(identity), iv);
    cipher.setAAD(groupStateAad(identity, groupId));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(value.rollbackState.bytes, "base64url")),
      cipher.final(),
    ]);
    state.groups[groupId] = {
      epoch: String(value.rollbackState.epoch),
      membershipRevision: String(value.rollbackState.membershipRevision),
      stateRevision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: encrypted.toString("base64url"),
      processedEvents: { ...(group.processedEvents || {}) },
      pendingOutbox: { ...(group.pendingOutbox || {}) },
    };
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return true;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
  return locked.value;
}

/** Record the acknowledged response so later duplicate calls never ratchet again. */
export function completeGroupOutbox(identity, groupId, eventId, expectedRequestHash, response, options = {}) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const group = state.groups[groupId];
    const item = group?.pendingOutbox?.[eventId];
    if (!item) throw new Error("Relay could not find the encrypted group outbox entry it just delivered.");
    const value = decryptGroupOutbox(identity, groupId, eventId, item);
    if (value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to complete a different encrypted group outbox entry.");
    }
    if (value.status === "completed") return value.response;
    const pendingOutbox = { ...group.pendingOutbox };
    pendingOutbox[eventId] = encryptGroupOutbox(identity, groupId, eventId, {
      status: "completed",
      requestHash: value.requestHash,
      response,
      completedAt: new Date().toISOString(),
    });
    const completed = Object.entries(pendingOutbox)
      .map(([id, encrypted]) => [id, encrypted, decryptGroupOutbox(identity, groupId, id, encrypted)])
      .filter(([, , entry]) => entry.status === "completed")
      .sort((a, b) => String(a[2].completedAt).localeCompare(String(b[2].completedAt)));
    for (const [id] of completed.slice(0, Math.max(0, completed.length - E2EE_OUTBOX_COMPLETED_LIMIT))) {
      delete pendingOutbox[id];
    }
    state.groups[groupId] = { ...group, pendingOutbox };
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return response;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
  return locked.value;
}

/** Remove an acknowledged wire payload without advancing or rolling back MLS. */
export function removePendingGroupOutbox(identity, groupId, eventId, expectedRequestHash, options = {}) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const group = state.groups[groupId];
    const item = group?.pendingOutbox?.[eventId];
    if (!item) return false;
    const value = decryptGroupOutbox(identity, groupId, eventId, item);
    if (expectedRequestHash && value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to clear a different encrypted group outbox entry.");
    }
    const pendingOutbox = { ...group.pendingOutbox };
    delete pendingOutbox[eventId];
    state.groups[groupId] = { ...group, pendingOutbox };
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return true;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
  return locked.value;
}

export function removeEncryptedGroupState(identity, groupId, options = {}) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    if (!Object.hasOwn(state.groups, groupId)) return;
    delete state.groups[groupId];
    atomicWriteJsonSync(file, state, { mode: 0o600 });
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local MLS group state; retry safely.");
}

function readMessageCache(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeMessageCachePath(options), "utf8"));
    if (state?.version === 1 && state.userId === identity.userId && state.deviceId === identity.deviceId && state.items) {
      return state;
    }
  } catch {}
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, items: {} };
}

function outboxAad(identity, entryId) {
  return Buffer.from(JSON.stringify([
    "relay-e2ee-local-outbox-v1",
    identity.userId,
    identity.deviceId,
    entryId,
  ]), "utf8");
}

function readOutboxFile(identity, options = {}) {
  let raw;
  try {
    raw = fs.readFileSync(e2eeOutboxPath(options), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, userId: identity.userId, deviceId: identity.deviceId, items: {} };
    throw new Error("Relay could not read its encrypted local outbox.");
  }
  try {
    const state = JSON.parse(raw);
    if (state?.version === 1 && state.userId === identity.userId && state.deviceId === identity.deviceId && state.items) {
      return state;
    }
  } catch {}
  throw new Error("Relay's encrypted local outbox is invalid; nothing was sent.");
}

function encryptOutboxValue(identity, entryId, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", outboxKey(identity), iv);
  cipher.setAAD(outboxAad(identity, entryId));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return {
    updatedAt: new Date().toISOString(),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
  };
}

function decryptOutboxValue(identity, entryId, item) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", outboxKey(identity), Buffer.from(item.iv, "base64url"));
    decipher.setAAD(outboxAad(identity, entryId));
    decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
    const value = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    if (
      !value?.requestHash ||
      !["pending", "completed"].includes(value.status) ||
      (value.status === "pending" && !value.wire) ||
      (value.status === "completed" && !value.response)
    ) throw new Error("invalid outbox value");
    return value;
  } catch {
    throw new Error("Relay's encrypted local outbox could not be authenticated.");
  }
}

export function readPendingE2eeOutbox(identity, entryId, options = {}) {
  const item = readOutboxFile(identity, options).items[entryId];
  return item ? decryptOutboxValue(identity, entryId, item) : null;
}

/**
 * Persist the exact request before delivery. Concurrent writers with the same
 * content converge on the first ciphertext; different content is refused.
 */
export function writePendingE2eeOutbox(identity, entryId, value, options = {}) {
  const file = e2eeOutboxPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readOutboxFile(identity, options);
    const existing = state.items[entryId]
      ? decryptOutboxValue(identity, entryId, state.items[entryId])
      : null;
    if (existing) {
      if (existing.requestHash !== value.requestHash) {
        throw new Error("That encrypted idempotency key is already bound to different content.");
      }
      return existing;
    }
    const pending = {
      status: "pending",
      requestHash: value.requestHash,
      wire: value.wire,
      ...(value.currentSenderPackageRef ? { currentSenderPackageRef: value.currentSenderPackageRef } : {}),
    };
    state.items[entryId] = encryptOutboxValue(identity, entryId, pending);
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return pending;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local outbox; retry safely.");
  return locked.value;
}

export function completeE2eeOutbox(identity, entryId, expectedRequestHash, response, options = {}) {
  const file = e2eeOutboxPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readOutboxFile(identity, options);
    const item = state.items[entryId];
    if (!item) throw new Error("Relay could not find the encrypted outbox entry it just delivered.");
    const value = decryptOutboxValue(identity, entryId, item);
    if (value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to complete a different encrypted outbox entry.");
    }
    if (value.status === "completed") return value.response;
    state.items[entryId] = encryptOutboxValue(identity, entryId, {
      status: "completed",
      requestHash: value.requestHash,
      response,
      completedAt: new Date().toISOString(),
    });
    const completed = Object.entries(state.items)
      .map(([id, encrypted]) => [id, encrypted, decryptOutboxValue(identity, id, encrypted)])
      .filter(([, , entry]) => entry.status === "completed")
      .sort((a, b) => String(a[2].completedAt).localeCompare(String(b[2].completedAt)));
    for (const [id] of completed.slice(0, Math.max(0, completed.length - E2EE_OUTBOX_COMPLETED_LIMIT))) {
      delete state.items[id];
    }
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return response;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local outbox; retry safely.");
  return locked.value;
}

export function removePendingE2eeOutbox(identity, entryId, expectedRequestHash, options = {}) {
  const file = e2eeOutboxPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readOutboxFile(identity, options);
    const item = state.items[entryId];
    if (!item) return false;
    const value = decryptOutboxValue(identity, entryId, item);
    if (expectedRequestHash && value.requestHash !== expectedRequestHash) {
      throw new Error("Relay refused to clear a different encrypted outbox entry.");
    }
    delete state.items[entryId];
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return true;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local outbox; retry safely.");
  return locked.value;
}

export function readCachedPlaintext(identity, messageId, options = {}) {
  const item = readMessageCache(identity, options).items[messageId];
  if (!item) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", messageCacheKey(identity), Buffer.from(item.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(item.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Relay's encrypted local message cache could not be authenticated.");
  }
}

export function cachePlaintext(identity, messageId, plaintext, options = {}) {
  const file = e2eeMessageCachePath(options);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", messageCacheKey(identity), iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")),
    cipher.final(),
  ]);
  const item = {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
  };
  const locked = withJsonLockStrict(file, () => {
    const state = readMessageCache(identity, options);
    state.items[messageId] = item;
    atomicWriteJsonSync(file, state, { mode: 0o600 });
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local message cache; retry safely.");
}

export function removeCachedPlaintext(identity, messageId, options = {}) {
  const file = e2eeMessageCachePath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readMessageCache(identity, options);
    const existed = Boolean(state.items[messageId]);
    delete state.items[messageId];
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return existed;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local message cache; retry safely.");
  return locked.value;
}

export function removeProcessedGroupEvent(identity, groupId, eventId, options = {}) {
  const file = e2eeGroupStatesPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readGroupStateFile(identity, options);
    const group = state.groups[groupId];
    if (!group) return false;
    const existed = Boolean(group.processedEvents?.[eventId]);
    if (group.processedEvents) delete group.processedEvents[eventId];
    if (group.pendingOutbox) delete group.pendingOutbox[eventId];
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return existed;
  });
  if (!locked.ok) throw new Error("Relay could not lock its encrypted local group cache; retry safely.");
  return locked.value;
}

export function removeImportedE2eeHistoryRecord(identity, messageId, options = {}) {
  const file = e2eeImportedHistoryPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readImportedHistoryFile(identity, options);
    const existed = Boolean(state.items[messageId]);
    delete state.items[messageId];
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return existed;
  });
  if (!locked.ok) throw new Error("Relay could not lock its imported E2EE history; retry safely.");
  return locked.value;
}

export function removeLocalE2eeAttachmentDirectory(messageId, options = {}) {
  const root = path.join(path.dirname(identityPath(options)), "attachments", String(messageId).replace(/[^A-Za-z0-9_-]/g, "_"));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function importedHistoryAad(identity, messageId) {
  return Buffer.from(JSON.stringify([
    "relay-e2ee-imported-history-v1",
    identity.userId,
    identity.deviceId,
    messageId,
  ]), "utf8");
}

function readImportedHistoryFile(identity, options = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(e2eeImportedHistoryPath(options), "utf8"));
    if (state?.version === 1 && state.userId === identity.userId && state.deviceId === identity.deviceId && state.items) {
      return state;
    }
  } catch {}
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, items: {} };
}

function encryptImportedHistoryRecord(identity, messageId, record) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", messageCacheKey(identity), iv);
  cipher.setAAD(importedHistoryAad(identity, messageId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(record), "utf8")),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptImportedHistoryRecord(identity, messageId, record) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      messageCacheKey(identity),
      Buffer.from(record.iv, "base64url"),
    );
    decipher.setAAD(importedHistoryAad(identity, messageId));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    const opened = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
    if (opened?.wire?.relayId !== messageId || opened?.plaintext?.eventId !== messageId) {
      throw new Error("invalid imported history record");
    }
    return opened;
  } catch {
    throw new Error("Relay's imported E2EE history could not be authenticated.");
  }
}

export function importE2eeHistoryRecords(identity, records, options = {}) {
  const file = e2eeImportedHistoryPath(options);
  const locked = withJsonLockStrict(file, () => {
    const state = readImportedHistoryFile(identity, options);
    for (const record of records) {
      const messageId = String(record?.wire?.relayId || "");
      if (!messageId || record?.plaintext?.eventId !== messageId) {
        throw new Error("Relay refused an invalid imported E2EE history record.");
      }
      state.items[messageId] = encryptImportedHistoryRecord(identity, messageId, record);
    }
    atomicWriteJsonSync(file, state, { mode: 0o600 });
    return records.length;
  });
  if (!locked.ok) throw new Error("Relay could not lock its imported E2EE history; retry safely.");
  return locked.value;
}

export function readImportedE2eeHistory(identity, options = {}) {
  const state = readImportedHistoryFile(identity, options);
  return Object.entries(state.items)
    .map(([messageId, record]) => decryptImportedHistoryRecord(identity, messageId, record))
    .sort((left, right) =>
      String(left.plaintext.authoredAt || left.plaintext.createdAt).localeCompare(String(right.plaintext.authoredAt || right.plaintext.createdAt)) ||
      String(left.wire.relayId).localeCompare(String(right.wire.relayId)));
}

export function readImportedE2eeHistoryRecord(identity, messageId, options = {}) {
  const record = readImportedHistoryFile(identity, options).items[messageId];
  return record ? decryptImportedHistoryRecord(identity, messageId, record) : null;
}

export function removeE2eeRuntimeState(options = {}) {
  for (const file of [
    e2eeKeyPackagesPath(options),
    e2eeTransparencyPath(options),
    e2eeMessageCachePath(options),
    e2eeOutboxPath(options),
    e2eeGroupStatesPath(options),
    e2eeImportedHistoryPath(options),
    e2eeDeviceTrustPath(options),
  ]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}
