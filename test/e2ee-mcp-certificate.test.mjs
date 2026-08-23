import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  e2eeMcpAcmeDnsValue,
  ensureE2eeMcpCertificate,
  validateE2eeMcpEndpoint,
} from "../src/e2ee-mcp-certificate.js";
import { createE2eeMcpCertificateStore } from "../src/e2ee-mcp-certificate-store.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signaturePublicKey = publicKey.export({ format: "jwk" }).x;
  return {
    userId: "user_certificate",
    deviceId: "device_certificate",
    fingerprint: createHash("sha256").update(Buffer.from(signaturePublicKey, "base64url")).digest("base64url"),
    signaturePublicKey,
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  };
}

function memoryStore(initial = null) {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; return next; }, value: () => value };
}

test("certificate setup keeps private keys local and publishes only a DNS digest", async () => {
  const calls = [];
  const client = {
    async provisionE2eeRemoteEndpoint() {
      return { endpoint: {
        endpointId: "abc123abc123abc123",
        url: "https://abc123abc123abc123.mcp.test/mcp",
      } };
    },
    async publishE2eeRemoteDnsChallenge(value) { calls.push(["publish", value]); },
    async removeE2eeRemoteDnsChallenge(value) { calls.push(["remove", value]); },
  };
  const acmeModule = {
    crypto: {
      async createPrivateEcdsaKey() { return Buffer.from("LOCAL ACME ACCOUNT KEY"); },
      async createCsr(input) {
        calls.push(["csr", input]);
        return [Buffer.from("LOCAL CERTIFICATE KEY"), Buffer.from("PUBLIC CSR")];
      },
      readCertificateInfo() {
        return {
          domains: { commonName: "abc123abc123abc123.mcp.test", altNames: ["abc123abc123abc123.mcp.test"] },
          notAfter: new Date("2027-01-01T00:00:00.000Z"),
        };
      },
    },
    Client: class {
      constructor(options) { calls.push(["acme-client", options]); }
      async auto(options) {
        assert.deepEqual(options.challengePriority, ["dns-01"]);
        await options.challengeCreateFn({}, { type: "dns-01" }, "secret-key-authorization");
        await options.challengeRemoveFn();
        return "PUBLIC CERTIFICATE";
      }
    },
  };
  const store = memoryStore();
  const result = await ensureE2eeMcpCertificate(client, {
    identity: identity(),
    store,
    acmeModule,
    directoryUrl: "https://acme.test/directory",
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  const digest = e2eeMcpAcmeDnsValue("secret-key-authorization");
  assert.deepEqual(calls.filter(([name]) => name === "publish" || name === "remove"), [
    ["publish", digest], ["remove", digest],
  ]);
  assert.equal(result.key, "LOCAL CERTIFICATE KEY");
  assert.equal(result.cert, "PUBLIC CERTIFICATE");
  assert.equal(result.renewed, true);
  assert.match(store.value().accountKey, /LOCAL ACME ACCOUNT KEY/);
  assert.equal(JSON.stringify(calls).includes("LOCAL CERTIFICATE KEY"), false, "certificate key never enters an API call");
  const localAcmeOptions = calls.find(([name]) => name === "acme-client")?.[1];
  assert.equal(Buffer.from(localAcmeOptions.accountKey).toString("utf8"), "LOCAL ACME ACCOUNT KEY");
});

test("a healthy stored certificate skips ACME issuance", async () => {
  const stored = {
    accountKey: "account-key",
    certificateKey: "certificate-key",
    certificate: "certificate",
    hostname: "abc123abc123abc123.mcp.test",
    expiresAt: "2027-01-01T00:00:00.000Z",
    issuedAt: "2026-08-01T00:00:00.000Z",
    directoryUrl: "https://acme.test/directory",
  };
  const result = await ensureE2eeMcpCertificate({
    async provisionE2eeRemoteEndpoint() {
      return { endpoint: {
        endpointId: "abc123abc123abc123",
        url: "https://abc123abc123abc123.mcp.test/mcp",
      } };
    },
  }, {
    identity: identity(),
    store: memoryStore(stored),
    acmeModule: { directory: { letsencrypt: { production: "unused" } } },
    directoryUrl: "https://acme.test/directory",
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  assert.equal(result.renewed, false);
  assert.equal(result.key, "certificate-key");
});

test("endpoint validation cannot redirect certificate issuance outside Relay's assigned host", () => {
  assert.throws(() => validateE2eeMcpEndpoint({
    endpointId: "abc123abc123abc123",
    url: "https://attacker.example/mcp",
  }), /invalid encrypted Claude endpoint/i);
  assert.throws(() => validateE2eeMcpEndpoint({
    endpointId: "abc123abc123abc123",
    url: "http://abc123abc123abc123.mcp.test/mcp",
  }), /invalid encrypted Claude endpoint/i);
});

test("certificate state is encrypted at rest with a native credential-store key", () => {
  const testIdentity = identity();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-cert-"));
  const file = path.join(root, "certificate.json");
  let credential = "";
  const credentials = {
    readCredential: () => credential ? { ok: true, value: credential } : { ok: false, detail: "missing" },
    writeCredential: (value) => { credential = value; return { ok: true }; },
    deleteCredential: () => { credential = ""; return { ok: true }; },
  };
  const store = createE2eeMcpCertificateStore(testIdentity, { file, credentials });
  store.write({
    accountKey: "PRIVATE ACME KEY",
    certificateKey: "PRIVATE TLS KEY",
    certificate: "PUBLIC CERTIFICATE",
    hostname: "abc123abc123abc123.mcp.test",
    expiresAt: "2027-01-01T00:00:00.000Z",
    issuedAt: "2026-08-01T00:00:00.000Z",
    directoryUrl: "https://acme.test/directory",
  });
  const disk = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(disk, /PRIVATE|PUBLIC CERTIFICATE|mcp\.test|user_certificate|device_certificate/);
  assert.equal(Buffer.from(credential, "base64url").length, 32);
  assert.equal(createE2eeMcpCertificateStore(testIdentity, { file, credentials }).read().certificateKey, "PRIVATE TLS KEY");
});
