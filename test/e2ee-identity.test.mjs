import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import identity from "../src/e2ee-identity.cjs";

const {
  createDeviceCrossSignature,
  createPairingIdentity,
  deviceCrossSignatureStatement,
  enrollmentStatement,
  identityPath,
  persistPairedIdentity,
  readPairedIdentity,
  removePairedIdentity,
  verifyDeviceCrossSignature,
} = identity;

function inTempIdentity(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-identity-"));
  const options = { env: { RELAY_CONFIG_DIR: root }, homeDir: root };
  try {
    return fn(options);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("pairing creates a fresh Ed25519 identity and proof without touching disk", () => {
  inTempIdentity((options) => {
    const pairing = createPairingIdentity({ pairingCode: "abcd-efgh", name: "Laptop", platform: "darwin" });
    assert.match(pairing.request.signaturePublicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(pairing.request.proof, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(fs.existsSync(identityPath(options)), false);

    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pairing.request.signaturePublicKey, "base64url"),
    ]);
    const statement = enrollmentStatement({
      pairingCode: "ABCD-EFGH",
      name: "Laptop",
      platform: "darwin",
      signaturePublicKey: pairing.request.signaturePublicKey,
    });
    assert.equal(
      verify(
        null,
        statement,
        createPublicKey({ key: spki, format: "der", type: "spki" }),
        Buffer.from(pairing.request.proof, "base64url"),
      ),
      true,
    );
  });
});

test("the private identity is saved only after the API confirms the matching fingerprint", () => {
  inTempIdentity((options) => {
    const pairing = createPairingIdentity({ pairingCode: "ABCDEFGH", name: "Laptop", platform: "win32" });
    const registration = {
      deviceId: "dev_one",
      user: { id: "usr_one" },
      e2ee: {
        protocol: pairing.state.protocol,
        cipherSuite: pairing.state.cipherSuite,
        fingerprint: pairing.state.fingerprint,
      },
    };
    persistPairedIdentity(pairing.state, registration, options);
    const stored = readPairedIdentity(options);
    assert.equal(stored.deviceId, "dev_one");
    assert.equal(stored.userId, "usr_one");
    assert.ok(stored.privateKeyJwk.d, "the private key remains local");

    removePairedIdentity(options);
    assert.equal(readPairedIdentity(options), null);
  });
});

test("a mismatched server identity is refused and never written", () => {
  inTempIdentity((options) => {
    const pairing = createPairingIdentity({ pairingCode: "ABCDEFGH", name: "Laptop", platform: "linux" });
    assert.throws(
      () => persistPairedIdentity(pairing.state, {
        deviceId: "dev_one",
        user: { id: "usr_one" },
        e2ee: { fingerprint: "A".repeat(43) },
      }, options),
      /did not confirm/i,
    );
    assert.equal(readPairedIdentity(options), null);
  });
});

test("an explicit config file keeps the private identity in the same directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-explicit-config-"));
  try {
    const explicitConfig = path.join(root, "custom", "config.json");
    assert.equal(
      identityPath({ env: { RELAY_CONFIG: explicitConfig }, homeDir: root }),
      path.join(root, "custom", "e2ee-device-identity.json"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing private identity can approve a new device and contacts can verify the proof", () => {
  const signerPairing = createPairingIdentity({ pairingCode: "ABCDEFGH", name: "Phone", platform: "ios" });
  const subjectPairing = createPairingIdentity({ pairingCode: "IJKLMNOP", name: "Laptop", platform: "win32" });
  const signer = {
    ...signerPairing.state,
    userId: "usr_bob",
    deviceId: "dev_phone",
  };
  const signedAt = new Date("2026-08-21T08:00:00.000Z");
  const request = createDeviceCrossSignature(
    signer,
    { deviceId: "dev_laptop", fingerprint: subjectPairing.state.fingerprint },
    { now: signedAt },
  );
  const proof = {
    signerDeviceId: signer.deviceId,
    signerFingerprint: signer.fingerprint,
    ...request,
  };

  assert.equal(
    verifyDeviceCrossSignature({
      relayUserId: signer.userId,
      signer: {
        deviceId: signer.deviceId,
        fingerprint: signer.fingerprint,
        signaturePublicKey: signer.signaturePublicKey,
      },
      proof,
    }),
    true,
  );
  assert.equal(
    verifyDeviceCrossSignature({
      relayUserId: signer.userId,
      signer: {
        deviceId: signer.deviceId,
        fingerprint: signer.fingerprint,
        signaturePublicKey: signer.signaturePublicKey,
      },
      proof: { ...proof, subjectDeviceId: "dev_attacker" },
    }),
    false,
  );
  assert.deepEqual(
    JSON.parse(deviceCrossSignatureStatement({
      relayUserId: signer.userId,
      signerDeviceId: signer.deviceId,
      signerFingerprint: signer.fingerprint,
      subjectDeviceId: proof.subjectDeviceId,
      subjectFingerprint: proof.subjectFingerprint,
      signedAt: proof.signedAt,
    }).toString("utf8")),
    [
      "relay-e2ee-device-cross-signature-v1",
      signer.userId,
      signer.deviceId,
      signer.fingerprint,
      proof.subjectDeviceId,
      proof.subjectFingerprint,
      proof.signedAt,
    ],
  );
});
