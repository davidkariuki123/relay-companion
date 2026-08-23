import test from "node:test";
import assert from "node:assert/strict";
import identityModule from "../src/e2ee-identity.cjs";
import { evaluateE2eeDeviceTrust } from "../src/e2ee-device-trust.js";

const { createDeviceCrossSignature, createPairingIdentity } = identityModule;
const ENROLLED_AT = "2026-08-21T08:00:00.000Z";

function enrolled(pairing, userId, deviceId) {
  return {
    identity: { ...pairing.state, userId, deviceId },
    directory: {
      deviceId,
      protocol: pairing.state.protocol,
      cipherSuite: pairing.state.cipherSuite,
      signaturePublicKey: pairing.state.signaturePublicKey,
      fingerprint: pairing.state.fingerprint,
      enrolledAt: ENROLLED_AT,
    },
    transparency: {
      protocol: pairing.state.protocol,
      cipherSuite: pairing.state.cipherSuite,
      signaturePublicKey: pairing.state.signaturePublicKey,
      fingerprint: pairing.state.fingerprint,
      enrollmentSequence: "1",
      enrolledAt: ENROLLED_AT,
      expiresAt: null,
      revocationSequence: null,
      revokedAt: null,
    },
  };
}

function state(identity, users = {}) {
  return { version: 1, userId: identity.userId, deviceId: identity.deviceId, users };
}

function transparency(userId, devices) {
  return { users: { [userId]: { devices: Object.fromEntries(devices.map((item) => [item.directory.deviceId, item.transparency])) } } };
}

function directory(userId, devices, crossSignatures = []) {
  return { relayUserId: userId, revision: "A".repeat(43), devices: devices.map((item) => item.directory), crossSignatures };
}

test("a contact is pinned on first use and an unsigned later device stays pending", () => {
  const alice = enrolled(createPairingIdentity({ pairingCode:"ALICE123", name:"Alice", platform:"darwin" }), "usr_alice", "dev_alice");
  const phone = enrolled(createPairingIdentity({ pairingCode:"BOBPHONE", name:"Bob phone", platform:"ios" }), "usr_bob", "dev_phone");
  const laptop = enrolled(createPairingIdentity({ pairingCode:"BOBLAPTO", name:"Bob laptop", platform:"win32" }), "usr_bob", "dev_laptop");
  const first = evaluateE2eeDeviceTrust({
    identity: alice.identity,
    relayUserId: "usr_bob",
    directory: directory("usr_bob", [phone]),
    transparency: transparency("usr_bob", [phone]),
    stored: state(alice.identity),
    now: new Date(ENROLLED_AT),
  });
  assert.deepEqual(first.trustedDevices.map((item) => item.deviceId), ["dev_phone"]);

  const changed = evaluateE2eeDeviceTrust({
    identity: alice.identity,
    relayUserId: "usr_bob",
    directory: directory("usr_bob", [phone, laptop]),
    transparency: transparency("usr_bob", [phone, laptop]),
    stored: state(alice.identity, { usr_bob: first.nextUser }),
    now: new Date("2026-08-22T08:00:00.000Z"),
  });
  assert.deepEqual(changed.trustedDevices.map((item) => item.deviceId), ["dev_phone"]);
  assert.deepEqual(changed.pendingDevices.map((item) => item.deviceId), ["dev_laptop"]);
});

test("a valid old-device signature extends a contact pin to the new device", () => {
  const alice = enrolled(createPairingIdentity({ pairingCode:"ALICE123", name:"Alice", platform:"darwin" }), "usr_alice", "dev_alice");
  const phone = enrolled(createPairingIdentity({ pairingCode:"BOBPHONE", name:"Bob phone", platform:"ios" }), "usr_bob", "dev_phone");
  const laptop = enrolled(createPairingIdentity({ pairingCode:"BOBLAPTO", name:"Bob laptop", platform:"win32" }), "usr_bob", "dev_laptop");
  const pin = {
    firstSeenAt: ENROLLED_AT,
    devices: { dev_phone: { fingerprint: phone.directory.fingerprint, trustedAt: ENROLLED_AT, via: "first_use" } },
  };
  const request = createDeviceCrossSignature(phone.identity, laptop.directory, { now: new Date("2026-08-22T08:00:00.000Z") });
  const proof = {
    signerDeviceId: phone.identity.deviceId,
    signerFingerprint: phone.identity.fingerprint,
    ...request,
  };
  const result = evaluateE2eeDeviceTrust({
    identity: alice.identity,
    relayUserId: "usr_bob",
    directory: directory("usr_bob", [phone, laptop], [proof]),
    transparency: transparency("usr_bob", [phone, laptop]),
    stored: state(alice.identity, { usr_bob: pin }),
    now: new Date("2026-08-22T09:00:00.000Z"),
  });
  assert.deepEqual(result.trustedDevices.map((item) => item.deviceId).sort(), ["dev_laptop", "dev_phone"]);
  assert.deepEqual(result.pendingDevices, []);
  assert.equal(result.nextUser.devices.dev_laptop.via, "cross_signed");
});

test("another device on the owner's account begins pending until this device approves it", () => {
  const phone = enrolled(createPairingIdentity({ pairingCode:"OWNPHONE", name:"Phone", platform:"ios" }), "usr_owner", "dev_phone");
  const laptop = enrolled(createPairingIdentity({ pairingCode:"OWNLAPTO", name:"Laptop", platform:"darwin" }), "usr_owner", "dev_laptop");
  const first = evaluateE2eeDeviceTrust({
    identity: phone.identity,
    relayUserId: "usr_owner",
    directory: directory("usr_owner", [phone, laptop]),
    transparency: transparency("usr_owner", [phone, laptop]),
    stored: state(phone.identity),
    now: new Date(ENROLLED_AT),
  });
  assert.deepEqual(first.pendingDevices.map((item) => item.deviceId), ["dev_laptop"]);
});
