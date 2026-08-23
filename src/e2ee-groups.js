import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  joinGroup,
  processMessage,
  processPrivateMessage,
  zeroOutUint8Array,
} from "ts-mls";
import { getGroupMembers } from "ts-mls/clientState.js";
import { decodeRatchetTree, encodeRatchetTree } from "ts-mls/ratchetTree.js";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import {
  assertE2eeRecipientDevicesTrusted,
  assertE2eeSenderDeviceTrusted,
} from "./e2ee-device-trust.js";
import {
  b64,
  cipherSuite,
  clientConfigFor,
  decodeExact,
  ensureE2eeKeyPackages,
  generatePackage,
  identityOrThrow,
  decryptAttachmentMetadata,
  importE2eeAttachmentPlaintexts,
  materializeE2eeAttachments,
  privatePackageFromJson,
} from "./e2ee-mls.js";
import {
  activeDeviceFromTransparency,
  assertKnownCheckpoint,
  completeGroupOutbox,
  completeGroupTransition,
  e2eeRequestHash,
  mutateKeyPackageState,
  readEncryptedGroupState,
  readKeyPackageState,
  readPendingGroupOutbox,
  readPendingGroupTransition,
  readProcessedGroupEvent,
  readProcessedGroupEvents,
  rollbackPendingGroupTransition,
  parseMlsCredential,
  syncTransparency,
  writeEncryptedGroupState,
} from "./e2ee-state.js";

const { E2EE_PROTOCOL } = e2eeIdentityModule;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const GROUP_EVENT_CONTEXT = "relay-e2ee-group-event-v1";
const GROUP_TRANSITION_CONTEXT = "relay-e2ee-group-transition-v1";
const HISTORY_ARCHIVE_CONTEXT = "relay-e2ee-history-archive-v1";
const HISTORY_ARCHIVE_WIRE_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function groupEpoch(state) {
  return state.groupContext.epoch.toString();
}

function persistGroup(identity, groupId, membershipRevision, state, expectedStateRevision, changes = {}) {
  writeEncryptedGroupState(identity, groupId, {
    bytes: encodeGroupState(state),
    epoch: groupEpoch(state),
    membershipRevision,
    ...(expectedStateRevision !== undefined ? { expectedStateRevision } : {}),
    ...(changes.processedEvent ? { processedEvent: changes.processedEvent } : {}),
    ...(changes.pendingOutbox ? { pendingOutbox: changes.pendingOutbox } : {}),
    ...(changes.pendingTransition ? { pendingTransition: changes.pendingTransition } : {}),
  });
}

function groupEventIdentity(identity, input) {
  const eventId = String(input.eventId || `egmsg_${createHash("sha256")
    .update("relay-e2ee-group-message-id-v1")
    .update(input.groupId)
    .update(identity.deviceId)
    .update(String(input.idempotencyKey || ""))
    .digest("base64url")}`);
  const requestHash = e2eeRequestHash("relay-e2ee-group-send-request-v1", {
    eventId,
    groupId: String(input.groupId || ""),
    membershipRevision: String(input.membershipRevision || ""),
    type: input.type,
    body: input.body,
    attachments: (input.attachments || []).map((attachment) => ({
      attachmentId: attachment.attachmentId,
      encryptedMetadata: attachment.encryptedMetadata,
      ciphertextSize: attachment.ciphertextSize,
      ciphertextSha256: attachment.ciphertextSha256,
    })),
    historyImport: input.historyImport === true,
    createdAt: input.createdAt || null,
    idempotencyKey: String(input.idempotencyKey || ""),
  });
  return { eventId, requestHash };
}

function groupTransitionIdentity(identity, input) {
  const transitionId = `egtransition_${createHash("sha256")
    .update("relay-e2ee-group-transition-id-v1")
    .update(String(input.groupId || ""))
    .update(identity.deviceId)
    .update(String(input.idempotencyKey || ""))
    .digest("base64url")}`;
  const requestHash = e2eeRequestHash("relay-e2ee-group-transition-request-v1", {
    groupId: String(input.groupId || ""),
    idempotencyKey: String(input.idempotencyKey || ""),
  });
  return { transitionId, requestHash };
}

function groupTransitionAuthenticatedData(input) {
  return textEncoder.encode(JSON.stringify([
    GROUP_TRANSITION_CONTEXT,
    input.groupId,
    String(input.previousEpoch),
    String(input.epoch),
    input.previousMembershipRevision,
    input.membershipRevision,
    [...input.participantUserIds].sort(),
    [...input.memberDeviceIds].sort(),
    input.senderCheckpoint.size,
    input.senderCheckpoint.headHash,
  ]));
}

function loadGroup(identity, groupId, transparency, checkpoint = null) {
  const stored = readEncryptedGroupState(identity, groupId);
  if (!stored) throw new Error(`This device has not joined encrypted group ${groupId}.`);
  const decoded = decodeExact(decodeGroupState, b64(stored.bytes), "local MLS GroupState");
  return {
    ...stored,
    groupId,
    state: { ...decoded, clientConfig: clientConfigFor(transparency, checkpoint) },
  };
}

function assertPreparedGroupTargets(identity, transparency, preparation) {
  const participants = new Set(preparation.participantUserIds || []);
  if (!participants.has(identity.userId)) throw new Error("The encrypted group preparation omitted its creator.");
  const expected = [];
  for (const relayUserId of participants) {
    for (const [deviceId, device] of Object.entries(transparency.users?.[relayUserId]?.devices || {})) {
      if (device.revokedAt || (device.expiresAt && Date.parse(device.expiresAt) <= Date.now())) continue;
      if (relayUserId === identity.userId && deviceId === identity.deviceId) continue;
      expected.push(`${relayUserId}:${deviceId}`);
    }
  }
  const actual = [];
  for (const target of preparation.targets || []) {
    const key = `${target.relayUserId}:${target.device.deviceId}`;
    if (actual.includes(key)) throw new Error("Relay returned a duplicate encrypted group device.");
    const known = activeDeviceFromTransparency(transparency, target.relayUserId, target.device.deviceId);
    if (
      !known ||
      known.protocol !== target.device.protocol ||
      known.cipherSuite !== target.device.cipherSuite ||
      known.signaturePublicKey !== target.device.signaturePublicKey ||
      known.fingerprint !== target.device.fingerprint
    ) throw new Error("Relay's group KeyPackage does not match the verified device directory.");
    actual.push(key);
  }
  expected.sort();
  actual.sort();
  if (!expected.length || expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error("Relay omitted or added a device relative to the verified group participant directory.");
  }
}

async function assertGroupParticipantsTrusted(client, identity, participantUserIds) {
  for (const relayUserId of [...new Set(participantUserIds || [])]) {
    await assertE2eeRecipientDevicesTrusted(client, relayUserId, { identity });
  }
}

function assertJoinedGroupMembers(identity, state, wire) {
  if (!Buffer.from(state.groupContext.groupId).equals(Buffer.from(`relay-group:${wire.groupId}`, "utf8"))) {
    throw new Error("Encrypted group Welcome is bound to a different Relay room.");
  }
  const members = getGroupMembers(state).map((leaf) => {
    if (leaf.credential?.credentialType !== "basic") throw new Error("Encrypted group contains a non-basic credential.");
    const parsed = parseMlsCredential(textDecoder.decode(leaf.credential.identity));
    if (!parsed) throw new Error("Encrypted group contains an invalid Relay device credential.");
    return parsed;
  });
  const actualDevices = members.map((member) => member.deviceId).sort();
  const expectedDevices = [...wire.memberDeviceIds].sort();
  const actualUsers = [...new Set(members.map((member) => member.relayUserId))].sort();
  const expectedUsers = [...new Set(wire.participantUserIds)].sort();
  const selfExpected = expectedDevices.includes(identity.deviceId);
  if (
    actualDevices.includes(identity.deviceId) !== selfExpected ||
    actualDevices.length !== expectedDevices.length ||
    actualDevices.some((deviceId, index) => deviceId !== expectedDevices[index]) ||
    actualUsers.length !== expectedUsers.length ||
    actualUsers.some((userId, index) => userId !== expectedUsers[index])
  ) throw new Error("Encrypted group membership does not match the announced room roster.");
}

function indexedGroupMembers(state) {
  const members = [];
  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex += 2) {
    const node = state.ratchetTree[nodeIndex];
    if (!node || node.nodeType !== "leaf") continue;
    if (node.leaf.credential?.credentialType !== "basic") {
      throw new Error("Encrypted group contains a non-basic credential.");
    }
    const credential = parseMlsCredential(textDecoder.decode(node.leaf.credential.identity));
    if (!credential) throw new Error("Encrypted group contains an invalid Relay device credential.");
    members.push({ ...credential, leafIndex: nodeIndex / 2 });
  }
  return members;
}

function preparedTransitionProposals(identity, transparency, loaded, preparation) {
  if (
    preparation.groupId !== loaded.groupId ||
    String(preparation.baseEpoch) !== loaded.epoch ||
    preparation.previousMembershipRevision !== loaded.membershipRevision
  ) throw new Error("Encrypted group preparation does not start from this device's current epoch.");
  const currentMembers = indexedGroupMembers(loaded.state);
  const currentByDevice = new Map(currentMembers.map((member) => [member.deviceId, member]));
  if (!currentByDevice.has(identity.deviceId)) {
    throw new Error("This device is not a member of the encrypted group's current epoch.");
  }
  const finalDeviceIds = [...new Set(preparation.memberDeviceIds || [])].sort();
  if (finalDeviceIds.length !== (preparation.memberDeviceIds || []).length || !finalDeviceIds.includes(identity.deviceId)) {
    throw new Error("Encrypted group preparation has an invalid final device roster.");
  }
  const addedDeviceIds = finalDeviceIds.filter((deviceId) => !currentByDevice.has(deviceId));
  const removedMembers = currentMembers.filter((member) => !finalDeviceIds.includes(member.deviceId));
  const announcedRemoved = [...new Set(preparation.removedDeviceIds || [])].sort();
  const actualRemoved = removedMembers.map((member) => member.deviceId).sort();
  if (
    announcedRemoved.length !== actualRemoved.length ||
    announcedRemoved.some((deviceId, index) => deviceId !== actualRemoved[index])
  ) throw new Error("Relay's encrypted group removal set does not match the current MLS leaves.");

  const targets = new Map();
  const addProposals = [];
  for (const target of preparation.addedTargets || []) {
    const deviceId = target.device?.deviceId;
    if (!deviceId || targets.has(deviceId)) throw new Error("Relay returned a duplicate added group device.");
    const known = activeDeviceFromTransparency(transparency, target.relayUserId, deviceId);
    if (
      !known ||
      known.protocol !== target.device.protocol ||
      known.cipherSuite !== target.device.cipherSuite ||
      known.signaturePublicKey !== target.device.signaturePublicKey ||
      known.fingerprint !== target.device.fingerprint
    ) throw new Error("Relay's added group KeyPackage does not match the verified device directory.");
    const decoded = decodeExact(decodeMlsMessage, target.keyPackage, "added group MLS KeyPackage");
    if (decoded.wireformat !== "mls_key_package") throw new Error("Expected an added-device MLS KeyPackage.");
    targets.set(deviceId, target);
    addProposals.push({ proposalType: "add", add: { keyPackage: decoded.keyPackage } });
  }
  const actualAdded = [...targets.keys()].sort();
  if (
    actualAdded.length !== addedDeviceIds.length ||
    actualAdded.some((deviceId, index) => deviceId !== addedDeviceIds[index])
  ) throw new Error("Relay's added KeyPackages do not match the final encrypted group roster.");

  const finalUsers = [...new Set([
    ...currentMembers.filter((member) => finalDeviceIds.includes(member.deviceId)).map((member) => member.relayUserId),
    ...(preparation.addedTargets || []).map((target) => target.relayUserId),
  ])].sort();
  const announcedUsers = [...new Set(preparation.participantUserIds || [])].sort();
  if (
    finalUsers.length !== announcedUsers.length ||
    finalUsers.some((userId, index) => userId !== announcedUsers[index])
  ) throw new Error("Encrypted group preparation's participant accounts do not match its device roster.");
  return {
    proposals: [
      ...removedMembers.map((member) => ({ proposalType: "remove", remove: { removed: member.leafIndex } })),
      ...addProposals,
    ],
    addedDeviceIds,
  };
}

/**
 * Create one durable MLS group for a stable Relay room. This is intentionally
 * separate from the existing group-send path until membership commits and UI
 * recovery are integrated end to end.
 */
export async function createE2eeGroupBootstrap(client, preparation) {
  const identity = identityOrThrow();
  await ensureE2eeKeyPackages(client);
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, preparation.checkpoint);
  await assertGroupParticipantsTrusted(client, identity, preparation.participantUserIds);
  assertPreparedGroupTargets(identity, transparency, preparation);

  const cs = await cipherSuite();
  const senderPackage = await generatePackage(identity, cs);
  const senderMessage = decodeExact(decodeMlsMessage, senderPackage.keyPackage, "sender MLS KeyPackage");
  if (senderMessage.wireformat !== "mls_key_package") throw new Error("Expected a sender MLS KeyPackage.");
  let state = await createGroup(
    textEncoder.encode(`relay-group:${preparation.groupId}`),
    senderMessage.keyPackage,
    privatePackageFromJson(senderPackage.privatePackage),
    [],
    cs,
    clientConfigFor(transparency, preparation.checkpoint),
  );
  const proposals = preparation.targets.map((target) => {
    const decoded = decodeExact(decodeMlsMessage, target.keyPackage, "group member MLS KeyPackage");
    if (decoded.wireformat !== "mls_key_package") throw new Error("Expected a group member MLS KeyPackage.");
    return { proposalType: "add", add: { keyPackage: decoded.keyPackage } };
  });
  const committed = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals: proposals, ratchetTreeExtension: true },
  );
  if (!committed.welcome) throw new Error("MLS did not create a Welcome for the group devices.");
  state = committed.newState;
  committed.consumed.forEach(zeroOutUint8Array);
  assertJoinedGroupMembers(identity, state, {
    groupId: preparation.groupId,
    participantUserIds: preparation.participantUserIds,
    memberDeviceIds: [identity.deviceId, ...preparation.targets.map((target) => target.device.deviceId)],
  });
  persistGroup(identity, preparation.groupId, preparation.membershipRevision, state);
  return {
    preparationId: preparation.preparationId,
    groupId: preparation.groupId,
    membershipRevision: preparation.membershipRevision,
    participantUserIds: [...preparation.participantUserIds],
    memberDeviceIds: [identity.deviceId, ...preparation.targets.map((target) => target.device.deviceId)].sort(),
    epoch: groupEpoch(state),
    welcome: b64(encodeMlsMessage({ version: E2EE_PROTOCOL, wireformat: "mls_welcome", welcome: committed.welcome })),
    ratchetTree: b64(encodeRatchetTree(state.ratchetTree)),
    senderCheckpoint: { ...preparation.checkpoint },
  };
}

/** Join from a Welcome exactly once, then erase the consumed private KeyPackage. */
export async function joinE2eeGroupWelcome(client, wire) {
  const identity = identityOrThrow();
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, wire.senderCheckpoint);
  await assertE2eeSenderDeviceTrusted(client, wire.sender.relayUserId, wire.sender.deviceId, { identity });
  const existing = readEncryptedGroupState(identity, wire.groupId);
  if (
    existing &&
    existing.epoch === String(wire.epoch) &&
    existing.membershipRevision === wire.membershipRevision
  ) {
    mutateKeyPackageState(identity, (packages) => { delete packages.packages[wire.keyPackageRef]; });
    return { groupId: wire.groupId, epoch: existing.epoch, membershipRevision: existing.membershipRevision };
  }
  const localPackage = readKeyPackageState(identity).packages[wire.keyPackageRef];
  if (!localPackage) throw new Error("This device no longer has the one-time MLS KeyPackage needed to join the group.");
  const packageMessage = decodeExact(decodeMlsMessage, localPackage.keyPackage, "local MLS KeyPackage");
  const welcomeMessage = decodeExact(decodeMlsMessage, wire.welcome, "group MLS Welcome");
  const ratchetTree = decodeExact(decodeRatchetTree, wire.ratchetTree, "group MLS ratchet tree");
  if (packageMessage.wireformat !== "mls_key_package" || welcomeMessage.wireformat !== "mls_welcome") {
    throw new Error("Encrypted group Welcome contains the wrong MLS wire formats.");
  }
  const state = await joinGroup(
    welcomeMessage.welcome,
    packageMessage.keyPackage,
    privatePackageFromJson(localPackage.privatePackage),
    emptyPskIndex,
    await cipherSuite(),
    ratchetTree,
    undefined,
    clientConfigFor(transparency, wire.senderCheckpoint),
  );
  if (groupEpoch(state) !== String(wire.epoch)) throw new Error("Encrypted group Welcome announced the wrong epoch.");
  assertJoinedGroupMembers(identity, state, wire);
  persistGroup(identity, wire.groupId, wire.membershipRevision, state);
  mutateKeyPackageState(identity, (packages) => { delete packages.packages[wire.keyPackageRef]; });
  return { groupId: wire.groupId, epoch: groupEpoch(state), membershipRevision: wire.membershipRevision };
}

/** Join and acknowledge every pending Welcome in order. */
export async function syncE2eeGroupWelcomes(client) {
  const response = await client.e2eeGroupWelcomes();
  const joined = [];
  for (const welcome of response.items || []) {
    if (welcome.acknowledgedAt) continue;
    joined.push(await joinE2eeGroupWelcome(client, welcome));
    await client.e2eeAcknowledgeGroupWelcome(welcome.groupId, welcome.epoch);
  }
  return joined;
}

async function deliverPendingGroupTransition(client, identity, groupId, pending) {
  try {
    const response = await client.e2eeCommitGroupRekey(pending.wire);
    return completeGroupTransition(
      identity,
      groupId,
      pending.transitionId,
      pending.requestHash,
      response,
    );
  } catch (error) {
    if (error?.body?.error === "group_epoch_conflict") {
      rollbackPendingGroupTransition(
        identity,
        groupId,
        pending.transitionId,
        pending.requestHash,
      );
      error.message = "Another device advanced this encrypted group first. Relay restored the prior local epoch; sync and retry.";
      error.localE2eeStateRolledBack = true;
    }
    throw error;
  }
}

/** Create, durably persist, and publish one exact MLS add/remove membership Commit. */
export async function updateE2eeGroupMembership(client, input) {
  if (!input?.groupId || !input?.idempotencyKey) {
    throw new Error("Encrypted group membership updates require a group id and idempotency key.");
  }
  const identity = identityOrThrow();
  const { transitionId, requestHash } = groupTransitionIdentity(identity, input);
  const existing = readPendingGroupTransition(identity, input.groupId);
  if (existing) {
    if (existing.transitionId === transitionId) {
      if (existing.requestHash !== requestHash) {
        throw new Error("That encrypted group transition idempotency key is bound to different content.");
      }
      if (existing.status === "completed") return existing.response;
      return deliverPendingGroupTransition(client, identity, input.groupId, existing);
    }
    if (existing.status === "pending") {
      throw new Error("Another encrypted group membership transition is still pending.");
    }
  }

  let transparency = await syncTransparency(client, identity);
  let loaded = loadGroup(identity, input.groupId, transparency);
  const preparation = await client.e2eePrepareGroupRekey({
    groupId: input.groupId,
    expectedEpoch: loaded.epoch,
    expectedMembershipRevision: loaded.membershipRevision,
    idempotencyKey: input.idempotencyKey,
  });
  transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, preparation.checkpoint);
  await assertGroupParticipantsTrusted(client, identity, preparation.participantUserIds);
  loaded = loadGroup(identity, input.groupId, transparency, preparation.checkpoint);
  const { proposals, addedDeviceIds } = preparedTransitionProposals(identity, transparency, loaded, preparation);
  const cs = await cipherSuite();
  const committed = await createCommit(
    { state: loaded.state, cipherSuite: cs },
    {
      extraProposals: proposals,
      ratchetTreeExtension: true,
      authenticatedData: groupTransitionAuthenticatedData({
        groupId: input.groupId,
        previousEpoch: loaded.epoch,
        epoch: (BigInt(loaded.epoch) + 1n).toString(),
        previousMembershipRevision: loaded.membershipRevision,
        membershipRevision: preparation.membershipRevision,
        participantUserIds: preparation.participantUserIds,
        memberDeviceIds: preparation.memberDeviceIds,
        senderCheckpoint: preparation.checkpoint,
      }),
    },
  );
  const nextEpoch = (BigInt(loaded.epoch) + 1n).toString();
  if (groupEpoch(committed.newState) !== nextEpoch) throw new Error("MLS produced the wrong next group epoch.");
  if (Boolean(committed.welcome) !== (addedDeviceIds.length > 0)) {
    throw new Error("MLS Welcome creation did not match the devices added by this transition.");
  }
  assertJoinedGroupMembers(identity, committed.newState, {
    groupId: input.groupId,
    participantUserIds: preparation.participantUserIds,
    memberDeviceIds: preparation.memberDeviceIds,
  });
  const wire = {
    preparationId: preparation.preparationId,
    groupId: input.groupId,
    previousEpoch: loaded.epoch,
    epoch: nextEpoch,
    previousMembershipRevision: loaded.membershipRevision,
    membershipRevision: preparation.membershipRevision,
    commitCiphertext: b64(encodeMlsMessage(committed.commit)),
    ...(committed.welcome ? {
      welcome: b64(encodeMlsMessage({ version: E2EE_PROTOCOL, wireformat: "mls_welcome", welcome: committed.welcome })),
      ratchetTree: b64(encodeRatchetTree(committed.newState.ratchetTree)),
    } : {}),
    senderCheckpoint: { ...preparation.checkpoint },
    idempotencyKey: input.idempotencyKey,
  };
  try {
    persistGroup(
      identity,
      input.groupId,
      preparation.membershipRevision,
      committed.newState,
      loaded.stateRevision,
      {
        pendingTransition: {
          transitionId,
          requestHash,
          wire,
          rollbackState: {
            bytes: b64(loaded.bytes),
            epoch: loaded.epoch,
            membershipRevision: loaded.membershipRevision,
          },
        },
      },
    );
  } finally {
    committed.consumed.forEach(zeroOutUint8Array);
  }
  const pending = readPendingGroupTransition(identity, input.groupId);
  if (!pending || pending.transitionId !== transitionId || pending.requestHash !== requestHash) {
    throw new Error("Relay could not recover the durable encrypted group transition; nothing was sent.");
  }
  const response = await deliverPendingGroupTransition(client, identity, input.groupId, pending);
  return { ...response, addedDeviceIds };
}

/** Apply one server-routed MLS Commit or added-device Welcome and persist before acknowledgement. */
export async function applyE2eeGroupEpochUpdate(client, wire) {
  const identity = identityOrThrow();
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, wire.senderCheckpoint);
  await assertE2eeSenderDeviceTrusted(client, wire.sender.relayUserId, wire.sender.deviceId, { identity });
  const existing = readEncryptedGroupState(identity, wire.groupId);
  if (
    existing &&
    existing.epoch === String(wire.epoch) &&
    existing.membershipRevision === wire.membershipRevision
  ) {
    if (wire.kind === "welcome") {
      mutateKeyPackageState(identity, (packages) => { delete packages.packages[wire.keyPackageRef]; });
    }
    return { groupId: wire.groupId, epoch: existing.epoch, membershipRevision: existing.membershipRevision };
  }
  if (existing && BigInt(existing.epoch) > BigInt(wire.epoch)) {
    return { groupId: wire.groupId, epoch: existing.epoch, membershipRevision: existing.membershipRevision };
  }

  const cs = await cipherSuite();
  if (wire.kind === "welcome") {
    const localPackage = readKeyPackageState(identity).packages[wire.keyPackageRef];
    if (!localPackage) throw new Error("This device no longer has the one-time MLS KeyPackage needed to join the updated group.");
    const packageMessage = decodeExact(decodeMlsMessage, localPackage.keyPackage, "local MLS KeyPackage");
    const welcomeMessage = decodeExact(decodeMlsMessage, wire.welcome, "group MLS update Welcome");
    const ratchetTree = decodeExact(decodeRatchetTree, wire.ratchetTree, "group MLS update ratchet tree");
    if (packageMessage.wireformat !== "mls_key_package" || welcomeMessage.wireformat !== "mls_welcome") {
      throw new Error("Encrypted group update Welcome contains the wrong MLS wire formats.");
    }
    const state = await joinGroup(
      welcomeMessage.welcome,
      packageMessage.keyPackage,
      privatePackageFromJson(localPackage.privatePackage),
      emptyPskIndex,
      cs,
      ratchetTree,
      undefined,
      clientConfigFor(transparency, wire.senderCheckpoint),
    );
    if (groupEpoch(state) !== String(wire.epoch)) throw new Error("Encrypted group update Welcome announced the wrong epoch.");
    assertJoinedGroupMembers(identity, state, wire);
    persistGroup(identity, wire.groupId, wire.membershipRevision, state);
    mutateKeyPackageState(identity, (packages) => { delete packages.packages[wire.keyPackageRef]; });
    return { groupId: wire.groupId, epoch: groupEpoch(state), membershipRevision: wire.membershipRevision };
  }

  if (!existing) throw new Error(`This device has not joined encrypted group ${wire.groupId}.`);
  if (
    existing.epoch !== String(wire.previousEpoch) ||
    existing.membershipRevision !== wire.previousMembershipRevision
  ) throw new Error("Encrypted group Commit does not continue this device's current epoch.");
  const loaded = loadGroup(identity, wire.groupId, transparency, wire.senderCheckpoint);
  const message = decodeExact(decodeMlsMessage, wire.commitCiphertext, "group MLS Commit");
  if (message.wireformat !== "mls_private_message" && message.wireformat !== "mls_public_message") {
    throw new Error("Encrypted group epoch update did not contain an MLS Commit.");
  }
  const authenticatedData = message.wireformat === "mls_private_message"
    ? message.privateMessage.authenticatedData
    : message.publicMessage.content.authenticatedData;
  if (!Buffer.from(authenticatedData).equals(Buffer.from(groupTransitionAuthenticatedData(wire)))) {
    throw new Error("Encrypted group Commit metadata does not match its authenticated MLS envelope.");
  }
  const processed = await processMessage(message, loaded.state, emptyPskIndex, acceptAll, cs);
  if (processed.kind !== "newState") throw new Error("Encrypted group epoch update was not an MLS Commit.");
  try {
    if (groupEpoch(processed.newState) !== String(wire.epoch)) {
      throw new Error("Encrypted group Commit produced the wrong epoch.");
    }
    assertJoinedGroupMembers(identity, processed.newState, wire);
    persistGroup(
      identity,
      wire.groupId,
      wire.membershipRevision,
      processed.newState,
      loaded.stateRevision,
    );
  } finally {
    processed.consumed.forEach(zeroOutUint8Array);
  }
  return { groupId: wire.groupId, epoch: String(wire.epoch), membershipRevision: wire.membershipRevision };
}

/** Apply and acknowledge every pending epoch update in server order. */
export async function syncE2eeGroupEpochUpdates(client) {
  const response = await client.e2eeGroupEpochUpdates();
  const applied = [];
  for (const update of response.items || []) {
    if (update.acknowledgedAt) continue;
    applied.push(await applyE2eeGroupEpochUpdate(client, update));
    await client.e2eeAcknowledgeGroupWelcome(update.groupId, update.epoch);
  }
  return applied;
}

/** Encrypt any authenticated group event while advancing the local MLS send ratchet. */
export async function encryptE2eeGroupEvent(client, input) {
  const identity = identityOrThrow();
  const transition = readPendingGroupTransition(identity, input.groupId);
  if (transition?.status === "pending") {
    throw new Error("Finish the pending encrypted group membership transition before sending messages.");
  }
  const { eventId, requestHash } = groupEventIdentity(identity, input);
  const existingOutbox = readPendingGroupOutbox(identity, input.groupId, eventId);
  if (existingOutbox) {
    if (existingOutbox.requestHash !== requestHash) {
      throw new Error("That encrypted group idempotency key is already bound to different content.");
    }
    if (existingOutbox.status === "completed") {
      throw new Error("That encrypted group event was already delivered.");
    }
    return existingOutbox.wire;
  }
  const transparency = await syncTransparency(client, identity);
  const loaded = loadGroup(identity, input.groupId, transparency);
  if (loaded.membershipRevision !== input.membershipRevision) {
    throw new Error("The group roster changed; create and apply an MLS membership commit before sending.");
  }
  const plaintext = {
    version: 2,
    context: GROUP_EVENT_CONTEXT,
    eventId,
    eventType: input.type,
    messageId: input.messageId || eventId,
    groupId: input.groupId,
    epoch: loaded.epoch,
    membershipRevision: loaded.membershipRevision,
    senderUserId: identity.userId,
    senderDeviceId: identity.deviceId,
    authoredAt: input.authoredAt || input.createdAt || new Date().toISOString(),
    conversation: {
      conversationId: input.groupId,
      threadId: input.threadId || input.messageId || eventId,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      groupId: input.groupId,
      ...(input.groupSendId ? { groupSendId: input.groupSendId } : {}),
    },
    transparencyCheckpoint: { ...transparency.checkpoint },
    ...(input.historyImport ? { historyImport: { version: 1 } } : {}),
    type: input.type,
    body: input.body,
  };
  const encrypted = await createApplicationMessage(
    loaded.state,
    textEncoder.encode(JSON.stringify(plaintext)),
    await cipherSuite(),
  );
  encrypted.consumed.forEach(zeroOutUint8Array);
  const wire = {
    eventId,
    groupId: input.groupId,
    epoch: loaded.epoch,
    membershipRevision: loaded.membershipRevision,
    ciphertext: b64(encodeMlsMessage({
      version: E2EE_PROTOCOL,
      wireformat: "mls_private_message",
      privateMessage: encrypted.privateMessage,
    })),
    attachments: input.attachments || [],
    senderCheckpoint: { ...transparency.checkpoint },
    idempotencyKey: input.idempotencyKey,
    ...(input.historyImport ? { historyImport: true } : {}),
  };
  persistGroup(
    identity,
    input.groupId,
    loaded.membershipRevision,
    encrypted.newState,
    loaded.stateRevision,
    {
      pendingOutbox: { eventId, requestHash, wire },
      // The author never consumes its own MLS Welcome. Cache the authenticated
      // event beside the advanced send ratchet so Sent and chat history survive
      // restarts exactly like recipient history.
      processedEvent: {
        eventId,
        plaintext,
        wire: {
          ...wire,
          sender: { relayUserId: identity.userId, deviceId: identity.deviceId, name: "You" },
          createdAt: plaintext.authoredAt,
          updatedAt: plaintext.authoredAt,
        },
      },
    },
  );
  return readPendingGroupOutbox(identity, input.groupId, eventId).wire;
}

/** Send only a durable exact-wire event, retaining it across ambiguous failures. */
export async function sendE2eeGroupEvent(client, input) {
  const identity = identityOrThrow();
  const { eventId, requestHash } = groupEventIdentity(identity, input);
  const existing = readPendingGroupOutbox(identity, input.groupId, eventId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new Error("That encrypted group idempotency key is already bound to different content.");
    }
    if (existing.status === "completed") return existing.response;
    const response = await client.e2eeSendGroupMessage(existing.wire);
    return completeGroupOutbox(identity, input.groupId, eventId, requestHash, response);
  }
  const wire = await encryptE2eeGroupEvent(client, input);
  const outbox = readPendingGroupOutbox(identity, input.groupId, eventId);
  if (!outbox || outbox.requestHash !== requestHash) {
    throw new Error("Relay could not recover the durable encrypted group event; nothing was sent.");
  }
  if (outbox.status === "completed") return outbox.response;
  const response = await client.e2eeSendGroupMessage(wire);
  return completeGroupOutbox(identity, input.groupId, eventId, requestHash, response);
}

/** Authenticate, decrypt, validate, and advance the local MLS receive ratchet. */
export async function decryptE2eeGroupEvent(client, wire) {
  const identity = identityOrThrow();
  const transparency = await syncTransparency(client, identity);
  assertKnownCheckpoint(transparency, wire.senderCheckpoint);
  await assertE2eeSenderDeviceTrusted(client, wire.sender.relayUserId, wire.sender.deviceId, { identity });
  const cached = readProcessedGroupEvent(identity, wire.groupId, wire.eventId);
  if (cached) return validateGroupPlaintext(cached, wire);
  const loaded = loadGroup(identity, wire.groupId, transparency, wire.senderCheckpoint);
  if (loaded.epoch !== String(wire.epoch) || loaded.membershipRevision !== wire.membershipRevision) {
    throw new Error("Encrypted group event does not match this device's roster epoch.");
  }
  const message = decodeExact(decodeMlsMessage, wire.ciphertext, "group MLS ciphertext");
  if (message.wireformat !== "mls_private_message") throw new Error("Expected an MLS private group message.");
  const opened = await processPrivateMessage(loaded.state, message.privateMessage, emptyPskIndex, await cipherSuite());
  if (opened.kind !== "applicationMessage") throw new Error("Encrypted group event did not contain application data.");
  let plaintext;
  try { plaintext = JSON.parse(textDecoder.decode(opened.message)); } catch {
    throw new Error("Encrypted group event is not valid UTF-8 JSON.");
  } finally {
    opened.consumed.forEach(zeroOutUint8Array);
  }
  validateGroupPlaintext(plaintext, wire);
  persistGroup(
    identity,
    wire.groupId,
    loaded.membershipRevision,
    opened.newState,
    loaded.stateRevision,
    { processedEvent: { eventId: wire.eventId, plaintext, wire } },
  );
  return plaintext;
}

function validateGroupPlaintext(plaintext, wire) {
  if (
    plaintext?.version !== 2 ||
    plaintext.context !== GROUP_EVENT_CONTEXT ||
    plaintext.eventId !== wire.eventId ||
    typeof plaintext.eventType !== "string" ||
    typeof plaintext.messageId !== "string" ||
    typeof plaintext.authoredAt !== "string" ||
    plaintext.conversation?.groupId !== wire.groupId ||
    plaintext.conversation?.conversationId !== wire.groupId ||
    typeof plaintext.conversation?.threadId !== "string" ||
    plaintext.groupId !== wire.groupId ||
    plaintext.epoch !== String(wire.epoch) ||
    plaintext.membershipRevision !== wire.membershipRevision ||
    plaintext.senderUserId !== wire.sender.relayUserId ||
    plaintext.senderDeviceId !== wire.sender.deviceId ||
    (plaintext.historyImport !== undefined && plaintext.historyImport?.version !== 1) ||
    plaintext.transparencyCheckpoint?.size !== wire.senderCheckpoint.size ||
    plaintext.transparencyCheckpoint?.headHash !== wire.senderCheckpoint.headHash
  ) throw new Error("Encrypted group routing metadata did not authenticate against its MLS plaintext.");
  return plaintext;
}

/** Decrypt and acknowledge queued group events only after local MLS state is durable. */
export async function syncE2eeGroupEvents(client) {
  await syncE2eeGroupWelcomes(client);
  await syncE2eeGroupEpochUpdates(client);
  const response = await client.e2eeGroupMessages();
  const opened = [];
  for (const wire of response.items || []) {
    if (wire.acknowledgedAt) continue;
    opened.push(await decryptE2eeGroupEvent(client, wire));
    await client.e2eeAcknowledgeGroupMessage(wire.eventId);
  }
  return opened;
}

/**
 * Share the locally retained product history with devices added to the newest
 * epoch. The one-time archive key travels only inside an MLS application
 * message; the service receives ciphertext and routing device ids.
 */
export async function shareE2eeGroupHistory(client, input) {
  const identity = identityOrThrow();
  const recipientDeviceIds = [...new Set(input.recipientDeviceIds || [])]
    .filter((deviceId) => deviceId && deviceId !== identity.deviceId)
    .sort();
  if (!recipientDeviceIds.length) return null;
  const fresh = await client.e2eeGroupMessages();
  const freshWires = new Map((fresh.items || []).map((wire) => [wire.eventId, wire]));
  const selected = readProcessedGroupEvents(identity)
    .filter((record) => record.groupId === input.groupId && record.wire && record.plaintext?.type !== "history.key")
    .sort((left, right) => String(left.plaintext?.authoredAt).localeCompare(String(right.plaintext?.authoredAt)));
  const messages = [];
  for (const record of selected) {
    const wire = freshWires.get(record.eventId) || record.wire;
    const keys = record.plaintext?.body?.attachments || [];
    const metadata = decryptAttachmentMetadata(record.eventId, keys, wire.attachments || []);
    const files = await materializeE2eeAttachments(record.eventId, metadata);
    messages.push({
      wire,
      plaintext: record.plaintext,
      attachmentContents: files.map((attachment) => ({
        attachmentId: attachment.id,
        contentBase64: fs.readFileSync(attachment.localPath).toString("base64"),
      })),
    });
  }
  if (!messages.length) return null;
  const archive = createE2eeHistoryArchive({ groupId: input.groupId, messages });
  const group = readEncryptedGroupState(identity, input.groupId);
  if (!group) throw new Error(`This device has not joined encrypted group ${input.groupId}.`);
  const keyEvent = await sendE2eeGroupEvent(client, {
    groupId: input.groupId,
    membershipRevision: group.membershipRevision,
    type: "history.key",
    body: {
      archiveId: archive.archiveId,
      archiveKey: archive.archiveKey,
      ciphertextSha256: archive.ciphertextSha256,
      ciphertextSize: archive.ciphertextSize,
      expiresAt: archive.expiresAt,
      recipientDeviceIds,
    },
    idempotencyKey: `${input.idempotencyKey}:key`,
  });
  await client.e2eeUploadHistoryArchive({
    archiveId: archive.archiveId,
    groupId: input.groupId,
    ciphertext: archive.ciphertext,
    ciphertextSize: archive.ciphertextSize,
    ciphertextSha256: archive.ciphertextSha256,
    expiresAt: archive.expiresAt,
    recipientDeviceIds,
    keyMessageId: keyEvent.eventId,
  });
  return { archiveId: archive.archiveId, keyMessageId: keyEvent.eventId, recipientDeviceIds };
}

/** Import every offered history archive before acknowledging its temporary bytes. */
export async function syncE2eeGroupHistoryArchives(client) {
  const identity = identityOrThrow();
  const response = await client.e2eeHistoryArchives();
  const imported = [];
  for (const wire of response.items || []) {
    const keyEvent = readProcessedGroupEvent(identity, wire.groupId, wire.keyMessageId);
    const key = keyEvent?.type === "history.key" ? keyEvent.body : null;
    if (
      !key || key.archiveId !== wire.archiveId || key.ciphertextSha256 !== wire.ciphertextSha256 ||
      key.ciphertextSize !== wire.ciphertextSize || key.expiresAt !== wire.expiresAt ||
      !Array.isArray(key.recipientDeviceIds) || !key.recipientDeviceIds.includes(identity.deviceId)
    ) throw new Error("Encrypted group history was not authorized by its MLS key event.");
    const archive = openE2eeHistoryArchive({ ...wire, archiveKey: key.archiveKey });
    for (const record of archive.messages) {
      if (
        record?.plaintext?.groupId !== wire.groupId ||
        record?.wire?.groupId !== wire.groupId ||
        record?.wire?.eventId !== record?.plaintext?.eventId
      ) throw new Error("Encrypted group history contains an event for another room.");
      if (readProcessedGroupEvent(identity, wire.groupId, record.wire.eventId)) continue;
      const group = readEncryptedGroupState(identity, wire.groupId);
      if (!group) throw new Error(`This device has not joined encrypted group ${wire.groupId}.`);
      writeEncryptedGroupState(identity, wire.groupId, {
        bytes: group.bytes,
        epoch: group.epoch,
        membershipRevision: group.membershipRevision,
        expectedStateRevision: group.stateRevision,
        processedEvent: { eventId: record.wire.eventId, plaintext: record.plaintext, wire: record.wire },
      });
      if (record.attachmentContents?.length) {
        const metadata = decryptAttachmentMetadata(
          record.wire.eventId,
          record.plaintext?.body?.attachments || [],
          record.wire.attachments || [],
        );
        importE2eeAttachmentPlaintexts(record.wire.eventId, metadata, record.attachmentContents);
      }
    }
    await client.e2eeAcknowledgeHistoryArchive(wire.archiveId);
    imported.push({ archiveId: wire.archiveId, messageCount: archive.messages.length });
  }
  return imported;
}

/**
 * Re-encrypt a selected plaintext history snapshot under a fresh, one-time
 * archive key. The caller shares that key only after the new device has joined
 * the current MLS epoch; the server sees only this temporary ciphertext.
 */
export function createE2eeHistoryArchive(input) {
  const archiveId = String(input.archiveId || `ehist_${randomBytes(18).toString("base64url")}`);
  const archiveKey = randomBytes(32);
  const nonce = randomBytes(12);
  const createdAt = input.createdAt || new Date().toISOString();
  const expiresAt = input.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const archive = {
    version: 1,
    context: HISTORY_ARCHIVE_CONTEXT,
    archiveId,
    groupId: input.groupId,
    createdAt,
    expiresAt,
    messages: input.messages,
  };
  const aad = Buffer.from(JSON.stringify([HISTORY_ARCHIVE_CONTEXT, input.groupId, archiveId]), "utf8");
  const cipher = createCipheriv("aes-256-gcm", archiveKey, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(archive), "utf8")),
    cipher.final(),
  ]);
  const packed = Buffer.concat([Buffer.from([HISTORY_ARCHIVE_WIRE_VERSION]), nonce, cipher.getAuthTag(), encrypted]);
  return {
    archiveId,
    groupId: input.groupId,
    archiveKey: archiveKey.toString("base64url"),
    ciphertext: packed.toString("base64url"),
    ciphertextSha256: sha256(packed),
    ciphertextSize: packed.length,
    expiresAt,
  };
}

export function openE2eeHistoryArchive(input) {
  const packed = Buffer.from(input.ciphertext, "base64url");
  if (packed.length < 30 || packed[0] !== HISTORY_ARCHIVE_WIRE_VERSION) throw new Error("Invalid encrypted history archive.");
  if (input.ciphertextSha256 && sha256(packed) !== input.ciphertextSha256) {
    throw new Error("Encrypted history archive failed its ciphertext integrity check.");
  }
  const nonce = packed.subarray(1, 13);
  const tag = packed.subarray(13, 29);
  const ciphertext = packed.subarray(29);
  const aad = Buffer.from(JSON.stringify([HISTORY_ARCHIVE_CONTEXT, input.groupId, input.archiveId]), "utf8");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(input.archiveKey, "base64url"), nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const archive = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (
      archive?.version !== 1 ||
      archive.context !== HISTORY_ARCHIVE_CONTEXT ||
      archive.archiveId !== input.archiveId ||
      archive.groupId !== input.groupId ||
      (input.expiresAt && archive.expiresAt !== input.expiresAt) ||
      !Number.isFinite(Date.parse(archive.expiresAt)) ||
      Date.parse(archive.expiresAt) <= Date.now() ||
      !Array.isArray(archive.messages)
    ) throw new Error("Encrypted history archive metadata did not authenticate.");
    return archive;
  } catch (error) {
    if (error?.message === "Encrypted history archive metadata did not authenticate.") throw error;
    throw new Error("Encrypted history archive could not be authenticated.");
  }
}
