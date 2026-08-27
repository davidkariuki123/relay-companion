import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import e2eeIdentity from "../src/e2ee-identity.cjs";
import {
  applyE2eeGroupEpochUpdate,
  createE2eeGroupBootstrap,
  createE2eeHistoryArchive,
  decryptE2eeGroupEvent,
  joinE2eeGroupWelcome,
  openE2eeHistoryArchive,
  sendE2eeGroupEvent,
  syncE2eeGroupEpochUpdates,
  updateE2eeGroupMembership,
} from "../src/e2ee-groups.js";
import { e2eeGroupOpenedRecords, sendE2eeGroupRelay } from "../src/e2ee-group-product.js";
import {
  canonicalTransparencyChain,
  canonicalTransparencyEntry,
  E2EE_TRANSPARENCY_EMPTY_HASH,
  e2eeGroupStatesPath,
  readEncryptedGroupState,
  readPendingGroupOutbox,
  readPendingGroupTransition,
  writeEncryptedGroupState,
} from "../src/e2ee-state.js";
import { ensureE2eeKeyPackages } from "../src/e2ee-mls.js";

const { createPairingIdentity, persistPairedIdentity } = e2eeIdentity;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function enrolledIdentity(root, { userId, deviceId, name }) {
  const generated = createPairingIdentity({ pairingCode: "ABCDEFGH", name, platform: "test" });
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
    priorHeadHash = headHash;
    heads.push(headHash);
    return { ...input, priorHeadHash: entriesPriorHead(heads, index), entryHash, headHash };
  });
  return { entries, heads };
}

function entriesPriorHead(heads, index) {
  return heads[index];
}

class FakeGroupDirectory {
  constructor(identities) {
    this.identities = identities;
    this.log = transparencyLog(identities);
    this.packages = new Map();
    this.groupMessages = new Map();
    this.taskClaims = new Map();
    this.groupSendAttempts = [];
    this.failAfterAcceptedGroupSends = 0;
    this.groupTransitions = new Map();
    this.groupTransitionAttempts = [];
    this.groupEpochUpdates = new Map();
    this.rekeyPreparations = new Map();
    this.failAfterAcceptedGroupTransitions = 0;
    this.rejectNextGroupTransitionAsConflict = false;
    this.currentGroup = null;
    this.nextParticipants = null;
  }

  client(identity) {
    const service = this;
    return {
      async e2eeStatus() {
        return { mode: "required", protocol: identity.protocol, cipherSuite: identity.cipherSuite };
      },
      async e2eeTransparencySync({ afterSize, limit }) {
        const after = Number(afterSize);
        const entries = service.log.entries.slice(after, after + limit);
        const size = after + entries.length;
        return {
          from: { size: String(after), headHash: service.log.heads[after] },
          checkpoint: { size: String(size), headHash: service.log.heads[size] },
          entries,
          complete: size === service.log.entries.length,
        };
      },
      async e2eeDirectory(relayUserId) {
        return {
          relayUserId,
          revision: "test-directory",
          devices: service.identities
            .filter((candidate) => candidate.userId === relayUserId)
            .map((device) => ({
              deviceId: device.deviceId,
              protocol: device.protocol,
              cipherSuite: device.cipherSuite,
              signaturePublicKey: device.signaturePublicKey,
              fingerprint: device.fingerprint,
              enrolledAt: service.log.entries.find((entry) => entry.deviceId === device.deviceId).createdAt,
            })),
          crossSignatures: [],
        };
      },
      async e2eeKeyPackageStatus() {
        const available = (service.packages.get(identity.deviceId) || []).filter((item) => !item.claimed).length;
        return { available, target: 3 };
      },
      async e2eeUploadKeyPackages(packages) {
        const current = service.packages.get(identity.deviceId) || [];
        for (const item of packages) current.push({ ...item, claimed: false });
        service.packages.set(identity.deviceId, current);
        return { accepted: packages.map((item) => item.packageRef), available: current.length };
      },
      async e2eeSendGroupMessage(payload) {
        service.groupSendAttempts.push(JSON.parse(JSON.stringify(payload)));
        const existing = service.groupMessages.get(payload.eventId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(payload)) {
          throw new Error("idempotency conflict: group ciphertext changed");
        }
        if (!existing) {
          service.groupMessages.set(payload.eventId, JSON.parse(JSON.stringify(payload)));
        }
        const response = { eventId: payload.eventId, groupId: payload.groupId, state: "delivered" };
        if (service.failAfterAcceptedGroupSends > 0) {
          service.failAfterAcceptedGroupSends -= 1;
          throw new Error("connection closed after the group ciphertext committed");
        }
        return response;
      },
      async e2eeGroupWelcomes() { return { items: [] }; },
      async e2eeGroupMessages() {
        return { items: [...service.groupMessages.values()]
          .filter((item) => item.senderDeviceId !== identity.deviceId)
          .map((item) => ({ ...item, sender: item.sender || { relayUserId: "usr_alice", deviceId: "dev_alice", name: "Alice" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })) };
      },
      async e2eeGroupTaskClaims(ids) {
        return {
          claims: Object.fromEntries(ids.flatMap((id) => service.taskClaims.has(id)
            ? [[id, service.taskClaims.get(id)]]
            : [])),
        };
      },
      async e2eeAcknowledgeGroupMessage() { return { ok: true }; },
      async e2eeHistoryArchives() { return { items: [] }; },
      async groups() {
        return { groups: [{ id: "grp_friends", name: "Friends", owned: identity.userId === "usr_alice", archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), members: [], memberCount: 2 }] };
      },
      async e2eePrepareGroupRekey(payload) {
        return service.rekeyPreparation(identity, payload);
      },
      async e2eeCommitGroupRekey(payload) {
        service.groupTransitionAttempts.push(JSON.parse(JSON.stringify(payload)));
        if (service.rejectNextGroupTransitionAsConflict) {
          service.rejectNextGroupTransitionAsConflict = false;
          const error = new Error("another device committed first");
          error.body = { error: "group_epoch_conflict" };
          throw error;
        }
        const preparation = service.rekeyPreparations.get(payload.preparationId);
        if (!preparation) throw new Error("unknown group transition preparation");
        const existing = service.groupTransitions.get(payload.idempotencyKey);
        if (existing && JSON.stringify(existing.wire) !== JSON.stringify(payload)) {
          throw new Error("idempotency conflict: group transition changed");
        }
        const response = {
          groupId: payload.groupId,
          epoch: payload.epoch,
          membershipRevision: payload.membershipRevision,
          state: "updated",
        };
        if (!existing) {
          service.groupTransitions.set(payload.idempotencyKey, {
            wire: JSON.parse(JSON.stringify(payload)),
            response,
          });
          const common = {
            groupId: payload.groupId,
            previousEpoch: payload.previousEpoch,
            epoch: payload.epoch,
            previousMembershipRevision: payload.previousMembershipRevision,
            membershipRevision: payload.membershipRevision,
            participantUserIds: preparation.participantUserIds,
            memberDeviceIds: preparation.memberDeviceIds,
            sender: { relayUserId: identity.userId, deviceId: identity.deviceId },
            senderCheckpoint: payload.senderCheckpoint,
            createdAt: new Date().toISOString(),
          };
          for (const member of preparation.previousParticipants) {
            if (member.deviceId === identity.deviceId) continue;
            const queue = service.groupEpochUpdates.get(member.deviceId) || [];
            queue.push({ ...common, kind: "commit", commitCiphertext: payload.commitCiphertext });
            service.groupEpochUpdates.set(member.deviceId, queue);
          }
          for (const target of preparation.addedTargets) {
            const queue = service.groupEpochUpdates.get(target.device.deviceId) || [];
            queue.push({
              ...common,
              kind: "welcome",
              keyPackageRef: target.packageRef,
              welcome: payload.welcome,
              ratchetTree: payload.ratchetTree,
            });
            service.groupEpochUpdates.set(target.device.deviceId, queue);
          }
          service.currentGroup = {
            groupId: payload.groupId,
            epoch: payload.epoch,
            membershipRevision: payload.membershipRevision,
            participants: preparation.participants,
          };
        }
        if (service.failAfterAcceptedGroupTransitions > 0) {
          service.failAfterAcceptedGroupTransitions -= 1;
          throw new Error("connection closed after the group transition committed");
        }
        return response;
      },
      async e2eeGroupEpochUpdates() {
        return { items: (service.groupEpochUpdates.get(identity.deviceId) || []).filter((item) => !item.acknowledgedAt) };
      },
      async e2eeAcknowledgeGroupWelcome(groupId, epoch) {
        const item = (service.groupEpochUpdates.get(identity.deviceId) || [])
          .find((candidate) => candidate.groupId === groupId && candidate.epoch === epoch);
        if (!item) throw new Error("group epoch delivery not found");
        item.acknowledgedAt = new Date().toISOString();
        return { ok: true, groupId, epoch };
      },
    };
  }

  preparation(groupId, creator, participants) {
    const targets = participants
      .filter((identity) => identity.deviceId !== creator.deviceId)
      .map((identity) => {
        const item = this.packages.get(identity.deviceId).find((candidate) => !candidate.claimed);
        item.claimed = true;
        return {
          relayUserId: identity.userId,
          device: {
            deviceId: identity.deviceId,
            protocol: identity.protocol,
            cipherSuite: identity.cipherSuite,
            signaturePublicKey: identity.signaturePublicKey,
            fingerprint: identity.fingerprint,
            enrolledAt: this.log.entries.find((entry) => entry.deviceId === identity.deviceId).createdAt,
          },
          keyPackageId: `kp:${item.packageRef}`,
          packageRef: item.packageRef,
          keyPackage: item.keyPackage,
        };
      });
    const preparation = {
      preparationId: "egprep_test",
      groupId,
      membershipRevision: digest("alice:bob:carol"),
      participantUserIds: [...new Set(participants.map((identity) => identity.userId))].sort(),
      targets,
      checkpoint: { size: String(this.log.entries.length), headHash: this.log.heads.at(-1) },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    this.currentGroup = {
      groupId,
      epoch: "1",
      membershipRevision: preparation.membershipRevision,
      participants: [...participants],
    };
    return preparation;
  }

  setNextParticipants(participants) {
    this.nextParticipants = [...participants];
  }

  rekeyPreparation(creator, payload) {
    const group = this.currentGroup;
    if (
      !group ||
      payload.groupId !== group.groupId ||
      payload.expectedEpoch !== group.epoch ||
      payload.expectedMembershipRevision !== group.membershipRevision
    ) {
      const error = new Error("stale group epoch");
      error.body = { error: "group_epoch_conflict" };
      throw error;
    }
    const participants = this.nextParticipants || group.participants;
    if (!this.nextParticipants && participants.length === group.participants.length && participants.every((item, index) => item.deviceId === group.participants[index].deviceId)) {
      const error = new Error("group current");
      error.body = { error: "group_current" };
      throw error;
    }
    const previousIds = new Set(group.participants.map((item) => item.deviceId));
    const nextIds = new Set(participants.map((item) => item.deviceId));
    const addedTargets = participants
      .filter((item) => !previousIds.has(item.deviceId))
      .map((item) => {
        const keyPackage = this.packages.get(item.deviceId).find((candidate) => !candidate.claimed);
        if (!keyPackage) throw new Error("added device has no MLS KeyPackage");
        keyPackage.claimed = true;
        return {
          relayUserId: item.userId,
          device: {
            deviceId: item.deviceId,
            protocol: item.protocol,
            cipherSuite: item.cipherSuite,
            signaturePublicKey: item.signaturePublicKey,
            fingerprint: item.fingerprint,
            enrolledAt: this.log.entries.find((entry) => entry.deviceId === item.deviceId).createdAt,
          },
          keyPackageId: `kp:${keyPackage.packageRef}`,
          packageRef: keyPackage.packageRef,
          keyPackage: keyPackage.keyPackage,
        };
      });
    const membershipRevision = digest(participants
      .map((item) => `${item.userId}:${item.deviceId}:${item.fingerprint}`)
      .sort()
      .join("|"));
    const preparation = {
      preparationId: `egprep_rekey_${this.rekeyPreparations.size + 1}`,
      groupId: group.groupId,
      baseEpoch: group.epoch,
      previousMembershipRevision: group.membershipRevision,
      membershipRevision,
      participantUserIds: [...new Set(participants.map((item) => item.userId))].sort(),
      memberDeviceIds: participants.map((item) => item.deviceId).sort(),
      addedTargets,
      removedDeviceIds: group.participants
        .filter((item) => !nextIds.has(item.deviceId))
        .map((item) => item.deviceId)
        .sort(),
      checkpoint: { size: String(this.log.entries.length), headHash: this.log.heads.at(-1) },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      previousParticipants: [...group.participants],
      participants: [...participants],
      creator,
    };
    this.rekeyPreparations.set(preparation.preparationId, preparation);
    return preparation;
  }
}

test("persistent MLS group ciphertext survives restarts and opens for every enrolled member device", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-groups-"));
  const roots = {
    alice: path.join(root, "alice"),
    bob: path.join(root, "bob"),
    carol: path.join(root, "carol"),
    dave: path.join(root, "dave"),
  };
  const alice = enrolledIdentity(roots.alice, { userId: "usr_alice", deviceId: "dev_alice", name: "Alice" });
  const bob = enrolledIdentity(roots.bob, { userId: "usr_bob", deviceId: "dev_bob", name: "Bob" });
  const carol = enrolledIdentity(roots.carol, { userId: "usr_carol", deviceId: "dev_carol", name: "Carol" });
  const dave = enrolledIdentity(roots.dave, { userId: "usr_dave", deviceId: "dev_dave", name: "Dave" });
  const participants = [alice, bob, carol];
  const service = new FakeGroupDirectory([...participants, dave]);
  const priorConfigDir = process.env.RELAY_CONFIG_DIR;
  try {
    for (const [name, identity] of [["alice", alice], ["bob", bob], ["carol", carol], ["dave", dave]]) {
      process.env.RELAY_CONFIG_DIR = roots[name];
      await ensureE2eeKeyPackages(service.client(identity));
    }
    const preparation = service.preparation("grp_friends", alice, participants);

    process.env.RELAY_CONFIG_DIR = roots.alice;
    const bootstrap = await createE2eeGroupBootstrap(service.client(alice), preparation);
    assert.equal(bootstrap.epoch, "1");

    for (const [name, identity] of [["bob", bob], ["carol", carol]]) {
      const target = preparation.targets.find((item) => item.device.deviceId === identity.deviceId);
      process.env.RELAY_CONFIG_DIR = roots[name];
      if (name === "bob") {
        await assert.rejects(
          joinE2eeGroupWelcome(service.client(identity), {
            ...bootstrap,
            sender: { relayUserId: alice.userId, deviceId: alice.deviceId, name: alice.name },
            memberDeviceIds: bootstrap.memberDeviceIds.filter((deviceId) => deviceId !== carol.deviceId),
            keyPackageRef: target.packageRef,
          }),
          /membership does not match/,
          "the authenticated MLS leaf set cannot be hidden or expanded by outer server metadata",
        );
      }
      await joinE2eeGroupWelcome(service.client(identity), {
        ...bootstrap,
        sender: { relayUserId: alice.userId, deviceId: alice.deviceId, name: alice.name },
        keyPackageRef: target.packageRef,
      });
    }

    process.env.RELAY_CONFIG_DIR = roots.alice;
    const productSent = await sendE2eeGroupRelay(service.client(alice), {
      recipient: { groupId: preparation.groupId },
      kind: "message",
      forHuman: "This is a normal encrypted group chat message.",
      forAgent: "",
      idempotencyKey: "group-product-send-1",
    });
    assert.match(productSent.relayId, /^egmsg_/);
    assert.equal(productSent.recipient.name, "Friends");
    const productRecords = await e2eeGroupOpenedRecords(service.client(alice));
    const productRecord = productRecords.find((record) => record.eventId === productSent.relayId);
    assert.equal(productRecord?.item.direction, "outbound");
    assert.equal(productRecord?.item.forHuman, "This is a normal encrypted group chat message.");
    assert.equal(JSON.stringify(service.groupMessages.get(productSent.relayId)).includes("normal encrypted group"), false);

    const encryptedTask = await sendE2eeGroupRelay(service.client(alice), {
      recipient: { groupId: preparation.groupId },
      kind: "task",
      title: "Verify encrypted ownership",
      forHuman: "Please verify the encrypted claim projection.",
      forAgent: "Check ownership without exposing this instruction to the server.",
      idempotencyKey: "group-product-task-1",
    });
    service.taskClaims.set(encryptedTask.relayId, {
      scope: "channel",
      state: "claimed",
      workState: "idle",
      version: 1,
      claimant: { relayUserId: alice.userId, name: alice.name, self: true },
      claimedAt: "2026-08-27T12:00:00.000Z",
      createdBy: { relayUserId: alice.userId, name: alice.name, self: true },
      channel: { id: preparation.groupId, name: "Friends" },
      capabilities: { canClaim: false, canUnclaim: true, canStart: true },
    });
    const encryptedTaskRecord = (await e2eeGroupOpenedRecords(service.client(alice)))
      .find((record) => record.eventId === encryptedTask.relayId);
    assert.equal(encryptedTaskRecord?.item.taskClaim?.claimant?.name, "Alice");
    assert.equal(encryptedTaskRecord?.item.recipientGroupName, "Friends");
    assert.equal(JSON.stringify(service.groupMessages.get(encryptedTask.relayId)).includes("encrypted claim projection"), false);
    assert.equal(JSON.stringify(service.taskClaims.get(encryptedTask.relayId)).includes("without exposing"), false);

    const importedGroup = await sendE2eeGroupRelay(service.client(alice), {
      recipient: { groupId: preparation.groupId },
      kind: "message",
      forHuman: "An earlier deleted group message.",
      forAgent: "",
      historyImport: true,
      historyImportDeleted: true,
      idempotencyKey: "group-product-history-import-1",
    });
    const importedRecord = (await e2eeGroupOpenedRecords(service.client(alice)))
      .find((record) => record.eventId === importedGroup.relayId);
    assert.equal(importedRecord?.item.historyImported, true);
    assert.equal(importedRecord?.item.state, "acknowledged");
    assert.equal(importedRecord?.item.forHuman, "Message deleted");
    assert.equal(service.groupMessages.get(importedGroup.relayId).historyImport, true);
    assert.equal(JSON.stringify(service.groupMessages.get(importedGroup.relayId)).includes("earlier deleted"), false);

    process.env.RELAY_CONFIG_DIR = roots.alice;
    const sent = await sendE2eeGroupEvent(service.client(alice), {
      groupId: preparation.groupId,
      membershipRevision: preparation.membershipRevision,
      type: "message",
      body: { forHuman: "Meet beside the old oak tree." },
      idempotencyKey: "group-message-test-1",
    });
    const encrypted = service.groupMessages.get(sent.eventId);
    const wire = {
      ...encrypted,
      sender: { relayUserId: alice.userId, deviceId: alice.deviceId, name: alice.name },
    };
    assert.equal(JSON.stringify(wire).includes("old oak tree"), false);

    for (const [name, identity] of [["bob", bob], ["carol", carol]]) {
      process.env.RELAY_CONFIG_DIR = roots[name];
      const opened = await decryptE2eeGroupEvent(service.client(identity), wire);
      assert.equal(opened.body.forHuman, "Meet beside the old oak tree.");
      assert.equal(opened.senderDeviceId, alice.deviceId);
      assert.deepEqual(
        await decryptE2eeGroupEvent(service.client(identity), wire),
        opened,
        "a crash after ratchet persistence can safely replay from the same atomic encrypted cache",
      );
    }

    const localState = fs.readFileSync(e2eeGroupStatesPath({ env: { RELAY_CONFIG_DIR: roots.alice } }), "utf8");
    assert.equal(localState.includes("old oak tree"), false);
    assert.equal(localState.includes(preparation.membershipRevision), true);

    process.env.RELAY_CONFIG_DIR = roots.alice;
    const retryInput = {
      eventId: "egmsg_retry_exact_wire",
      groupId: preparation.groupId,
      membershipRevision: preparation.membershipRevision,
      type: "message",
      body: { forHuman: "This group event must survive a lost response." },
      idempotencyKey: "group-message-retry-1",
    };
    const stateBeforeRetry = readEncryptedGroupState(alice, preparation.groupId);
    service.failAfterAcceptedGroupSends = 1;
    await assert.rejects(
      sendE2eeGroupEvent(service.client(alice), retryInput),
      /connection closed after the group ciphertext committed/,
    );
    const pending = readPendingGroupOutbox(alice, preparation.groupId, retryInput.eventId);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.wire, service.groupSendAttempts.at(-1));
    const retryLocalState = fs.readFileSync(e2eeGroupStatesPath(), "utf8");
    assert.equal(retryLocalState.includes(retryInput.body.forHuman), false);
    const stateAfterFailure = readEncryptedGroupState(alice, preparation.groupId);
    assert.equal(stateAfterFailure.stateRevision, stateBeforeRetry.stateRevision + 1);

    const firstAttempt = service.groupSendAttempts.at(-1);
    const retried = await sendE2eeGroupEvent(service.client(alice), retryInput);
    assert.equal(retried.eventId, retryInput.eventId);
    assert.deepEqual(service.groupSendAttempts.at(-1), firstAttempt, "retry resends identical MLS bytes");
    assert.equal(service.groupMessages.size, 5, "the service retains one row per logical group event");
    const stateAfterSuccess = readEncryptedGroupState(alice, preparation.groupId);
    assert.equal(stateAfterSuccess.stateRevision, stateAfterFailure.stateRevision, "acknowledgement never advances MLS again");
    assert.equal(readPendingGroupOutbox(alice, preparation.groupId, retryInput.eventId).status, "completed");
    const attemptsAfterSuccess = service.groupSendAttempts.length;
    assert.deepEqual(await sendE2eeGroupEvent(service.client(alice), retryInput), retried);
    assert.equal(service.groupSendAttempts.length, attemptsAfterSuccess, "completed retries are answered locally");
    assert.equal(readEncryptedGroupState(alice, preparation.groupId).stateRevision, stateAfterSuccess.stateRevision);
    await assert.rejects(
      sendE2eeGroupEvent(service.client(alice), {
        ...retryInput,
        body: { forHuman: "Different group content." },
      }),
      /already bound to different content/,
    );

    service.setNextParticipants([alice, bob]);
    service.rejectNextGroupTransitionAsConflict = true;
    await assert.rejects(
      updateE2eeGroupMembership(service.client(alice), {
        groupId: preparation.groupId,
        idempotencyKey: "group-remove-conflict",
      }),
      (error) => error.localE2eeStateRolledBack === true,
      "a losing concurrent Commit restores the exact pre-Commit MLS state",
    );
    assert.equal(readEncryptedGroupState(alice, preparation.groupId).epoch, "1");
    assert.equal(readPendingGroupTransition(alice, preparation.groupId), null);

    service.failAfterAcceptedGroupTransitions = 1;
    const removalInput = {
      groupId: preparation.groupId,
      idempotencyKey: "group-remove-carol",
    };
    await assert.rejects(
      updateE2eeGroupMembership(service.client(alice), removalInput),
      /connection closed after the group transition committed/,
    );
    const pendingRemoval = readPendingGroupTransition(alice, preparation.groupId);
    assert.equal(pendingRemoval.status, "pending");
    assert.equal(pendingRemoval.wire.previousEpoch, "1");
    assert.equal(pendingRemoval.wire.epoch, "2");
    assert.deepEqual(pendingRemoval.wire, service.groupTransitionAttempts.at(-1));
    const transitionFile = fs.readFileSync(e2eeGroupStatesPath(), "utf8");
    assert.equal(transitionFile.includes(pendingRemoval.wire.commitCiphertext), false);
    assert.equal(transitionFile.includes("rollbackState"), false);
    const stateAfterRemovalFailure = readEncryptedGroupState(alice, preparation.groupId);
    assert.equal(stateAfterRemovalFailure.epoch, "2");
    await assert.rejects(
      sendE2eeGroupEvent(service.client(alice), {
        groupId: preparation.groupId,
        membershipRevision: pendingRemoval.wire.membershipRevision,
        type: "message",
        body: { forHuman: "Do not advance while membership delivery is uncertain." },
        idempotencyKey: "message-during-pending-transition",
      }),
      /Finish the pending encrypted group membership transition/,
    );
    const firstRemovalAttempt = service.groupTransitionAttempts.at(-1);
    const removed = await updateE2eeGroupMembership(service.client(alice), removalInput);
    assert.equal(removed.epoch, "2");
    assert.deepEqual(service.groupTransitionAttempts.at(-1), firstRemovalAttempt);
    assert.equal(readPendingGroupTransition(alice, preparation.groupId).status, "completed");
    const removalAttemptCount = service.groupTransitionAttempts.length;
    assert.deepEqual(await updateE2eeGroupMembership(service.client(alice), removalInput), removed);
    assert.equal(service.groupTransitionAttempts.length, removalAttemptCount);

    process.env.RELAY_CONFIG_DIR = roots.bob;
    const bobRemovalWire = (service.groupEpochUpdates.get(bob.deviceId) || []).find((item) => !item.acknowledgedAt);
    await assert.rejects(
      applyE2eeGroupEpochUpdate(service.client(bob), {
        ...bobRemovalWire,
        memberDeviceIds: [alice.deviceId],
      }),
      /metadata does not match its authenticated MLS envelope/,
      "the server cannot alter the roster outside the sender-authenticated Commit",
    );
    assert.equal(readEncryptedGroupState(bob, preparation.groupId).epoch, "1");

    for (const [name, identity] of [["bob", bob], ["carol", carol]]) {
      process.env.RELAY_CONFIG_DIR = roots[name];
      const applied = await syncE2eeGroupEpochUpdates(service.client(identity));
      assert.equal(applied[0].epoch, "2");
      assert.equal(readEncryptedGroupState(identity, preparation.groupId).epoch, "2");
    }
    process.env.RELAY_CONFIG_DIR = roots.carol;
    await assert.rejects(
      sendE2eeGroupEvent(service.client(carol), {
        groupId: preparation.groupId,
        membershipRevision: removed.membershipRevision,
        type: "message",
        body: { forHuman: "A removed member cannot send into the next epoch." },
        idempotencyKey: "removed-member-send",
      }),
      /removed|active|member/i,
    );

    service.setNextParticipants([alice, bob, dave]);
    process.env.RELAY_CONFIG_DIR = roots.alice;
    const added = await updateE2eeGroupMembership(service.client(alice), {
      groupId: preparation.groupId,
      idempotencyKey: "group-add-dave",
    });
    assert.equal(added.epoch, "3");
    for (const [name, identity] of [["bob", bob], ["dave", dave]]) {
      process.env.RELAY_CONFIG_DIR = roots[name];
      const applied = await syncE2eeGroupEpochUpdates(service.client(identity));
      assert.equal(applied[0].epoch, "3");
      const local = readEncryptedGroupState(identity, preparation.groupId);
      assert.equal(local.epoch, "3");
      assert.equal(local.membershipRevision, added.membershipRevision);
    }
    assert.equal((service.groupEpochUpdates.get(carol.deviceId) || []).filter((item) => !item.acknowledgedAt).length, 0);

    process.env.RELAY_CONFIG_DIR = roots.alice;
    const afterAddition = await sendE2eeGroupEvent(service.client(alice), {
      groupId: preparation.groupId,
      membershipRevision: added.membershipRevision,
      type: "message",
      body: { forHuman: "Dave can open the current group epoch." },
      idempotencyKey: "group-message-after-addition",
    });
    const afterAdditionWire = {
      ...service.groupMessages.get(afterAddition.eventId),
      sender: { relayUserId: alice.userId, deviceId: alice.deviceId, name: alice.name },
    };
    for (const [name, identity] of [["bob", bob], ["dave", dave]]) {
      process.env.RELAY_CONFIG_DIR = roots[name];
      const opened = await decryptE2eeGroupEvent(service.client(identity), afterAdditionWire);
      assert.equal(opened.body.forHuman, "Dave can open the current group epoch.");
    }

    // Two processes may derive a message from the same MLS ratchet state. The
    // second persistence must fail rather than silently losing the first.
    process.env.RELAY_CONFIG_DIR = roots.alice;
    const aliceOptions = { env: { RELAY_CONFIG_DIR: roots.alice }, homeDir: roots.alice };
    const saved = readEncryptedGroupState(alice, preparation.groupId, aliceOptions);
    writeEncryptedGroupState(alice, preparation.groupId, {
      bytes: saved.bytes,
      epoch: saved.epoch,
      membershipRevision: saved.membershipRevision,
      expectedStateRevision: saved.stateRevision,
    }, aliceOptions);
    assert.throws(() => writeEncryptedGroupState(alice, preparation.groupId, {
      bytes: saved.bytes,
      epoch: saved.epoch,
      membershipRevision: saved.membershipRevision,
      expectedStateRevision: saved.stateRevision,
    }, aliceOptions), /concurrent MLS group-state advance/);
  } finally {
    if (priorConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = priorConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history transfer is a temporary independently encrypted snapshot", () => {
  const secret = "The first private group message.";
  const archive = createE2eeHistoryArchive({
    groupId: "grp_friends",
    messages: [{ messageId: "egmsg_old", forHuman: secret }],
  });
  const serverRow = JSON.stringify({
    archiveId: archive.archiveId,
    groupId: archive.groupId,
    ciphertext: archive.ciphertext,
    ciphertextSha256: archive.ciphertextSha256,
    ciphertextSize: archive.ciphertextSize,
    expiresAt: archive.expiresAt,
  });
  assert.equal(serverRow.includes(secret), false);
  assert.equal(serverRow.includes(archive.archiveKey), false);
  const opened = openE2eeHistoryArchive(archive);
  assert.equal(opened.messages[0].forHuman, secret);

  const tampered = Buffer.from(archive.ciphertext, "base64url");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => openE2eeHistoryArchive({ ...archive, ciphertext: tampered.toString("base64url") }),
    /integrity|authenticated/,
  );
});
