import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import atomicJson from "./atomic-json.cjs";
import e2eeIdentityModule from "./e2ee-identity.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { identityPath } = e2eeIdentityModule;
const { writeCredential, readCredential, deleteCredential } = createRequire(import.meta.url)("./credential-store.cjs");

export const E2EE_MCP_CERTIFICATE_CREDENTIAL_SERVICE = "work.relay.companion.e2ee-mcp-certificate";
const CONTEXT = "relay-e2ee-mcp-certificate-v1";

function account(identity) {
  return createHash("sha256").update(`${identity.userId}\n${identity.deviceId}`).digest("base64url").slice(0, 32);
}

function aad(identity) {
  return Buffer.from(JSON.stringify([CONTEXT, identity.userId, identity.deviceId]), "utf8");
}

function masterKey(identity, {
  credentialService = E2EE_MCP_CERTIFICATE_CREDENTIAL_SERVICE,
  credentials = { writeCredential, readCredential, deleteCredential },
} = {}) {
  const options = { service: credentialService, account: account(identity) };
  const existing = credentials.readCredential(options);
  if (existing?.ok) {
    const key = Buffer.from(String(existing.value || ""), "base64url");
    if (key.length !== 32) throw new Error("The native E2EE certificate key is invalid");
    return key;
  }
  const key = randomBytes(32);
  const encoded = key.toString("base64url");
  const written = credentials.writeCredential(encoded, options);
  if (!written?.ok) {
    throw new Error(`Relay cannot protect its Claude certificate in this device's native credential store (${written?.detail || "unavailable"}).`);
  }
  const verified = credentials.readCredential(options);
  if (!verified?.ok || verified.value !== encoded) {
    credentials.deleteCredential(options);
    throw new Error("Relay could not verify the native key protecting its Claude certificate.");
  }
  return key;
}

function validate(value, identity) {
  if (
    value?.version !== 1
    || value.context !== CONTEXT
    || value.userId !== identity.userId
    || value.deviceId !== identity.deviceId
    || typeof value.accountKey !== "string"
    || typeof value.certificateKey !== "string"
    || typeof value.certificate !== "string"
    || typeof value.hostname !== "string"
    || typeof value.expiresAt !== "string"
    || typeof value.directoryUrl !== "string"
  ) throw new Error("Stored E2EE Claude certificate is invalid");
  return value;
}

export function createE2eeMcpCertificateStore(identity, options = {}) {
  const file = options.file || path.join(
    path.dirname(identityPath(options)),
    `e2ee-mcp-certificate-${account(identity)}.json`,
  );
  const key = masterKey(identity, options);
  return {
    file,
    read() {
      let envelope;
      try { envelope = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new Error("Relay could not read its protected Claude certificate.");
      }
      try {
        const iv = Buffer.from(String(envelope.iv || ""), "base64url");
        const tag = Buffer.from(String(envelope.tag || ""), "base64url");
        if (envelope.version !== 1 || iv.length !== 12 || tag.length !== 16 || typeof envelope.ciphertext !== "string") {
          throw new Error("invalid envelope");
        }
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad(identity));
        decipher.setAuthTag(tag);
        return validate(JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8")), identity);
      } catch {
        throw new Error("Stored E2EE Claude certificate could not be authenticated");
      }
    },
    write(value) {
      const state = validate({
        ...value,
        version: 1,
        context: CONTEXT,
        userId: identity.userId,
        deviceId: identity.deviceId,
      }, identity);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(identity));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
      atomicWriteJsonSync(file, {
        version: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      }, { mode: 0o600 });
      return state;
    },
  };
}
