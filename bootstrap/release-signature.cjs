"use strict";

const crypto = require("node:crypto");

const RELEASE_ALGORITHM = "ED25519_SHA_512";
const RELEASE_KEY_ID = /^relay-runtime-release-v\d+$/;

function validatePublicKey(publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
  } catch {
    throw new Error("Relay release trust keyring contains an invalid Ed25519 public key");
  }
}

function releaseKeys(trustStore) {
  if (trustStore?.schema === 2 && Array.isArray(trustStore.keys)) {
    if (
      !RELEASE_KEY_ID.test(String(trustStore.activeKeyId || "")) ||
      trustStore.keys.length < 1 ||
      trustStore.keys.length > 2
    ) {
      throw new Error("Relay release trust keyring is invalid");
    }
    const seen = new Set();
    const keys = trustStore.keys.map((entry) => {
      const keyId = String(entry?.keyId || "");
      const algorithm = String(entry?.algorithm || "");
      const publicKeyPem = String(entry?.publicKeyPem || "");
      if (!RELEASE_KEY_ID.test(keyId) || seen.has(keyId) || algorithm !== RELEASE_ALGORITHM) {
        throw new Error("Relay release trust keyring is invalid");
      }
      validatePublicKey(publicKeyPem);
      seen.add(keyId);
      return { keyId, algorithm, publicKeyPem };
    });
    if (!seen.has(trustStore.activeKeyId)) throw new Error("Relay release trust keyring has no active key");
    return keys;
  }
  // Transitional compatibility for a release already carrying the original
  // single-key trust document. New exports always emit schema 2.
  if (trustStore?.schema === 1 && RELEASE_KEY_ID.test(String(trustStore.keyId || "")) && trustStore.publicKeyPem) {
    validatePublicKey(trustStore.publicKeyPem);
    return [{ keyId: trustStore.keyId, algorithm: RELEASE_ALGORITHM, publicKeyPem: trustStore.publicKeyPem }];
  }
  throw new Error("Relay release trust keyring is missing");
}

function verifyReleaseEnvelope(envelope, trustStore) {
  if (
    envelope?.schema !== 1 ||
    envelope?.algorithm !== RELEASE_ALGORITHM ||
    !envelope?.keyId ||
    !envelope?.payload ||
    !envelope?.signature
  ) {
    throw new Error("Relay release manifest has an unsupported signed-envelope format");
  }
  const key = releaseKeys(trustStore).find((entry) => entry.keyId === envelope.keyId);
  if (!key) throw new Error(`Relay release manifest uses unknown key ${envelope.keyId}`);
  const payloadBytes = Buffer.from(String(envelope.payload), "base64");
  const signature = Buffer.from(String(envelope.signature), "base64");
  if (
    payloadBytes.length < 1 ||
    signature.length !== 64 ||
    payloadBytes.toString("base64") !== envelope.payload ||
    signature.toString("base64") !== envelope.signature
  ) {
    throw new Error("Relay release manifest has malformed signed bytes");
  }
  if (!crypto.verify(null, payloadBytes, key.publicKeyPem, signature)) {
    throw new Error("Relay release manifest signature is invalid");
  }
  return payloadBytes;
}

module.exports = { RELEASE_ALGORITHM, releaseKeys, verifyReleaseEnvelope };
