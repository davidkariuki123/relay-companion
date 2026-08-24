import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import atomicJson from "./atomic-json.cjs";
import e2eeIdentityModule from "./e2ee-identity.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { identityPath } = e2eeIdentityModule;
const { writeCredential, readCredential, deleteCredential } = createRequire(import.meta.url)("./credential-store.cjs");

export const E2EE_MCP_OAUTH_CREDENTIAL_SERVICE = "work.relay.companion.e2ee-mcp-oauth";
const STATE_CONTEXT = "relay-e2ee-mcp-oauth-state-v1";
const STATE_VERSION = 1;

function account(identity) {
  return createHash("sha256")
    .update(`${identity.userId}\n${identity.deviceId}`)
    .digest("base64url")
    .slice(0, 32);
}

function statePath(identity, options = {}) {
  return path.join(path.dirname(identityPath(options)), `e2ee-mcp-oauth-${account(identity)}.json`);
}

function aad(identity) {
  return Buffer.from(JSON.stringify([STATE_CONTEXT, identity.userId, identity.deviceId]), "utf8");
}

function emptyState(identity) {
  return {
    version: STATE_VERSION,
    context: STATE_CONTEXT,
    userId: identity.userId,
    deviceId: identity.deviceId,
    redeemedCodes: {},
    revokedTokens: {},
  };
}

function prune(state, now) {
  for (const field of ["redeemedCodes", "revokedTokens"]) {
    for (const [id, expiresAt] of Object.entries(state[field] || {})) {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) delete state[field][id];
    }
  }
  return state;
}

function validateState(value, identity) {
  if (
    value?.version !== STATE_VERSION
    || value.context !== STATE_CONTEXT
    || value.userId !== identity.userId
    || value.deviceId !== identity.deviceId
    || !value.redeemedCodes || typeof value.redeemedCodes !== "object" || Array.isArray(value.redeemedCodes)
    || !value.revokedTokens || typeof value.revokedTokens !== "object" || Array.isArray(value.revokedTokens)
  ) throw new Error("Stored E2EE MCP authorization state is invalid");
  return value;
}

function nativeMasterKey(identity, {
  credentialService = E2EE_MCP_OAUTH_CREDENTIAL_SERVICE,
  credentials = { writeCredential, readCredential, deleteCredential },
  allowLegacyMigration = false,
} = {}) {
  const options = { service: credentialService, account: account(identity) };
  const existing = credentials.readCredential({ ...options, allowLegacyMigration });
  if (existing?.ok) {
    const key = Buffer.from(String(existing.value || ""), "base64url");
    if (key.length !== 32) throw new Error("The native E2EE MCP authorization key is invalid");
    return key;
  }
  const key = randomBytes(32);
  const written = credentials.writeCredential(key.toString("base64url"), options);
  if (!written?.ok) {
    throw new Error(`Relay cannot protect Claude authorization state in this device's credential store (${written?.detail || "unavailable"}).`);
  }
  const verified = credentials.readCredential(options);
  if (!verified?.ok || verified.value !== key.toString("base64url")) {
    credentials.deleteCredential(options);
    throw new Error("Relay could not verify the native key protecting Claude authorization state.");
  }
  return key;
}

export function createNativeE2eeMcpOAuthStateStore(identity, options = {}) {
  const file = options.file || statePath(identity, options);
  const key = nativeMasterKey(identity, { ...options, allowLegacyMigration: fs.existsSync(file) });

  const read = () => {
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyState(identity);
      throw new Error("Relay could not read its protected Claude authorization state.");
    }
    if (
      envelope?.version !== STATE_VERSION
      || !/^[A-Za-z0-9_-]{16}$/.test(String(envelope.iv || ""))
      || !/^[A-Za-z0-9_-]{22}$/.test(String(envelope.tag || ""))
      || typeof envelope.ciphertext !== "string"
    ) throw new Error("Stored E2EE MCP authorization state is invalid");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(aad(identity));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      return validateState(JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")), identity);
    } catch {
      throw new Error("Stored E2EE MCP authorization state could not be authenticated");
    }
  };

  const write = (state) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(identity));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    atomicWriteJsonSync(file, {
      version: STATE_VERSION,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    }, { mode: 0o600 });
  };

  const mutate = (change, now) => {
    const state = prune(read(), now);
    change(state);
    write(state);
  };
  return {
    isCodeRedeemed(jti, now) { return Number(read().redeemedCodes?.[jti] || 0) > now; },
    markCodeRedeemed(jti, expiresAt, now) {
      mutate((state) => { state.redeemedCodes[jti] = expiresAt; }, now);
    },
    isTokenRevoked(jti, now) { return Number(read().revokedTokens?.[jti] || 0) > now; },
    revokeToken(jti, expiresAt, now) {
      mutate((state) => { state.revokedTokens[jti] = expiresAt; }, now);
    },
  };
}

export function createMemoryE2eeMcpOAuthStateStore() {
  const redeemedCodes = new Map();
  const revokedTokens = new Map();
  const pruneMap = (map, now) => {
    for (const [key, expiresAt] of map) if (expiresAt <= now) map.delete(key);
  };
  return {
    isCodeRedeemed(jti, now) { pruneMap(redeemedCodes, now); return redeemedCodes.has(jti); },
    markCodeRedeemed(jti, expiresAt, now) { pruneMap(redeemedCodes, now); redeemedCodes.set(jti, expiresAt); },
    isTokenRevoked(jti, now) { pruneMap(revokedTokens, now); return revokedTokens.has(jti); },
    revokeToken(jti, expiresAt, now) { pruneMap(revokedTokens, now); revokedTokens.set(jti, expiresAt); },
  };
}
