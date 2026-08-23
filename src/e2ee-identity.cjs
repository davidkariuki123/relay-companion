"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } = require("node:crypto");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");

const E2EE_ENROLLMENT_CONTEXT = "relay-e2ee-device-enrollment-v1";
const E2EE_DEVICE_CROSS_SIGNATURE_CONTEXT = "relay-e2ee-device-cross-signature-v1";
const E2EE_PROTOCOL = "mls10";
const E2EE_CIPHER_SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

function identityPath({ env = process.env, homeDir = os.homedir() } = {}) {
  const explicitConfig = String(env.RELAY_CONFIG || "").trim();
  const root = explicitConfig
    ? path.dirname(explicitConfig)
    : env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay");
  return path.join(root, "e2ee-device-identity.json");
}

function enrollmentStatement({ pairingCode, name, platform, signaturePublicKey }) {
  return Buffer.from(
    JSON.stringify([
      E2EE_ENROLLMENT_CONTEXT,
      String(pairingCode || "").trim().toUpperCase(),
      String(name || ""),
      String(platform || ""),
      E2EE_PROTOCOL,
      E2EE_CIPHER_SUITE,
      String(signaturePublicKey || ""),
    ]),
    "utf8",
  );
}

function deviceCrossSignatureStatement({
  relayUserId,
  signerDeviceId,
  signerFingerprint,
  subjectDeviceId,
  subjectFingerprint,
  signedAt,
}) {
  return Buffer.from(
    JSON.stringify([
      E2EE_DEVICE_CROSS_SIGNATURE_CONTEXT,
      String(relayUserId || ""),
      String(signerDeviceId || ""),
      String(signerFingerprint || ""),
      String(subjectDeviceId || ""),
      String(subjectFingerprint || ""),
      String(signedAt || ""),
    ]),
    "utf8",
  );
}

/** Create the proof an already-trusted device sends when approving a new one. */
function createDeviceCrossSignature(identity, subject, { now = new Date() } = {}) {
  if (!identity?.userId || !identity?.deviceId || !identity?.fingerprint || !identity?.privateKeyJwk) {
    throw new Error("This device does not have a complete local encryption identity.");
  }
  if (!subject?.deviceId || !/^[A-Za-z0-9_-]{43}$/.test(String(subject.fingerprint || ""))) {
    throw new Error("The new device does not have a valid encryption identity.");
  }
  if (subject.deviceId === identity.deviceId) {
    throw new Error("A device cannot approve itself.");
  }
  const signedAt = now.toISOString();
  const statement = deviceCrossSignatureStatement({
    relayUserId: identity.userId,
    signerDeviceId: identity.deviceId,
    signerFingerprint: identity.fingerprint,
    subjectDeviceId: subject.deviceId,
    subjectFingerprint: subject.fingerprint,
    signedAt,
  });
  return {
    subjectDeviceId: subject.deviceId,
    subjectFingerprint: subject.fingerprint,
    signedAt,
    signature: sign(
      null,
      statement,
      createPrivateKey({ key: identity.privateKeyJwk, format: "jwk" }),
    ).toString("base64url"),
  };
}

/** Verify a server-returned proof before extending local trust to its subject. */
function verifyDeviceCrossSignature({ relayUserId, signer, proof }) {
  if (
    !signer?.deviceId ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(signer.signaturePublicKey || "")) ||
    proof?.signerDeviceId !== signer.deviceId ||
    proof?.signerFingerprint !== signer.fingerprint
  ) {
    return false;
  }
  try {
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(signer.signaturePublicKey, "base64url"),
    ]);
    const statement = deviceCrossSignatureStatement({
      relayUserId,
      signerDeviceId: proof.signerDeviceId,
      signerFingerprint: proof.signerFingerprint,
      subjectDeviceId: proof.subjectDeviceId,
      subjectFingerprint: proof.subjectFingerprint,
      signedAt: proof.signedAt,
    });
    return verify(
      null,
      statement,
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      Buffer.from(String(proof.signature || ""), "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Generate a fresh identity for one pairing attempt. Nothing is written until
 * the API confirms that it stored the matching public key.
 */
function createPairingIdentity({ pairingCode, name, platform }) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateKeyJwk = privateKey.export({ format: "jwk" });
  const signaturePublicKey = String(publicJwk.x || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(signaturePublicKey)) {
    throw new Error("Relay could not create a valid Ed25519 device identity.");
  }
  const statement = enrollmentStatement({ pairingCode, name, platform, signaturePublicKey });
  const proof = sign(null, statement, privateKey).toString("base64url");
  const fingerprint = createHash("sha256")
    .update(Buffer.from(signaturePublicKey, "base64url"))
    .digest("base64url");

  return {
    request: {
      protocol: E2EE_PROTOCOL,
      cipherSuite: E2EE_CIPHER_SUITE,
      signaturePublicKey,
      proof,
    },
    state: {
      version: 1,
      protocol: E2EE_PROTOCOL,
      cipherSuite: E2EE_CIPHER_SUITE,
      signaturePublicKey,
      fingerprint,
      privateKeyJwk,
      createdAt: new Date().toISOString(),
    },
  };
}

function persistPairedIdentity(state, registration, options = {}) {
  const confirmed = registration && registration.e2ee;
  if (!confirmed || confirmed.fingerprint !== state.fingerprint) {
    throw new Error(
      "Relay's API did not confirm this device's encryption identity. Pairing stopped before saving credentials.",
    );
  }
  const record = {
    ...state,
    deviceId: registration.deviceId,
    userId: registration.user && registration.user.id,
  };
  atomicWriteJsonSync(identityPath(options), record, { mode: 0o600 });
  return record;
}

function readPairedIdentity(options = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(identityPath(options), "utf8"));
    if (
      record &&
      record.version === 1 &&
      record.protocol === E2EE_PROTOCOL &&
      record.cipherSuite === E2EE_CIPHER_SUITE &&
      /^[A-Za-z0-9_-]{43}$/.test(String(record.signaturePublicKey || "")) &&
      record.privateKeyJwk &&
      record.deviceId &&
      record.userId
    ) {
      return record;
    }
  } catch {}
  return null;
}

function removePairedIdentity(options = {}) {
  try {
    fs.rmSync(identityPath(options), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  E2EE_CIPHER_SUITE,
  E2EE_DEVICE_CROSS_SIGNATURE_CONTEXT,
  E2EE_ENROLLMENT_CONTEXT,
  E2EE_PROTOCOL,
  createDeviceCrossSignature,
  createPairingIdentity,
  deviceCrossSignatureStatement,
  enrollmentStatement,
  identityPath,
  persistPairedIdentity,
  readPairedIdentity,
  removePairedIdentity,
  verifyDeviceCrossSignature,
};
