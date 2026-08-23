import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CLAUDE_OAUTH_REDIRECT_URIS,
  createE2eeMcpOAuth,
  createMemoryE2eeMcpOAuthStateStore,
} from "../src/e2ee-mcp-oauth.js";
import { createNativeE2eeMcpOAuthStateStore } from "../src/e2ee-mcp-oauth-state.js";
import { E2EE_REMOTE_TOOL_NAMES } from "../src/mcp.js";
import { startE2eeRemoteMcpHttpServer } from "../src/e2ee-remote-mcp.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signaturePublicKey = publicKey.export({ format: "jwk" }).x;
  return {
    userId: "user_oauth",
    deviceId: "device_oauth",
    fingerprint: createHash("sha256").update(Buffer.from(signaturePublicKey, "base64url")).digest("base64url"),
    signaturePublicKey,
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  };
}

function fakeClient() {
  return {
    identity: { userId: "user_oauth", deviceId: "device_oauth", deviceToken: "device-token" },
    accountDrift() { return { status: "same", bound: this.identity, current: this.identity }; },
    async ensureE2eeReady() {},
  };
}

const readiness = {
  identityAvailable: () => true,
  statusReader: async () => ({ mode: "required" }),
};

function oauthFor(testIdentity, options = {}) {
  return createE2eeMcpOAuth({
    publicOrigin: "https://device.example.test",
    identity: testIdentity,
    stateStore: createMemoryE2eeMcpOAuthStateStore(),
    ...options,
  });
}

function pkce(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function register(runtime, body) {
  return fetch(new URL("/oauth/register", runtime.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function completeAuthorization(runtime, oauth, clientId, verifier) {
  const authorize = new URL("/oauth/authorize", runtime.url);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URIS[0],
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
    scope: "relay",
    resource: oauth.resource,
    state: "claude-state",
  });
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  const requestToken = (await consent.text()).match(/name="request" value="([^"]+)"/)?.[1];
  assert.ok(requestToken);
  const approved = await fetch(new URL("/oauth/authorize", runtime.url), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestToken, decision: "allow" }),
  });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, CLAUDE_OAUTH_REDIRECT_URIS[0]);
  assert.equal(callback.searchParams.get("state"), "claude-state");
  return callback.searchParams.get("code");
}

async function exchange(runtime, body) {
  return fetch(new URL("/oauth/token", runtime.url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

test("device OAuth publishes MCP discovery without opening enrollment", async (t) => {
  const oauth = oauthFor(identity());
  const runtime = await startE2eeRemoteMcpHttpServer({
    client: fakeClient(), features: { requests: true }, readiness, oauth,
  });
  t.after(() => runtime.close());

  const resource = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", runtime.url));
  assert.equal(resource.status, 200);
  assert.deepEqual((await resource.json()).authorization_servers, [oauth.origin]);

  const discovery = await fetch(new URL("/.well-known/oauth-authorization-server", runtime.url));
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json();
  assert.equal(metadata.registration_endpoint, `${oauth.origin}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);

  const denied = await register(runtime, {
    client_name: "Claude",
    redirect_uris: [CLAUDE_OAUTH_REDIRECT_URIS[0]],
  });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error_description, /Open Relay/i);
});

test("device OAuth only registers Claude's official callbacks during a user-opened window", async (t) => {
  const oauth = oauthFor(identity());
  oauth.openEnrollmentWindow();
  const runtime = await startE2eeRemoteMcpHttpServer({
    client: fakeClient(), features: { requests: true }, readiness, oauth,
  });
  t.after(() => runtime.close());

  const rejected = await register(runtime, {
    client_name: "Not Claude",
    redirect_uris: ["https://attacker.example/callback"],
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "invalid_redirect_uri");

  const accepted = await register(runtime, {
    client_name: "Claude",
    redirect_uris: [...CLAUDE_OAUTH_REDIRECT_URIS],
    token_endpoint_auth_method: "none",
  });
  const clientRegistration = await accepted.json();
  assert.equal(accepted.status, 201, JSON.stringify(clientRegistration));
  assert.match(clientRegistration.client_id, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(clientRegistration.redirect_uris, CLAUDE_OAUTH_REDIRECT_URIS);
});

test("Claude authorization uses PKCE, one-time codes, rotating refresh tokens, and MCP bearer access", async (t) => {
  const oauth = oauthFor(identity());
  oauth.openEnrollmentWindow();
  const runtime = await startE2eeRemoteMcpHttpServer({
    client: fakeClient(), features: { requests: true }, readiness, oauth,
  });
  t.after(() => runtime.close());

  const registration = await register(runtime, {
    client_name: "Claude",
    redirect_uris: [CLAUDE_OAUTH_REDIRECT_URIS[0]],
  });
  const { client_id: clientId } = await registration.json();
  const verifier = "relay-claude-pkce-verifier-that-is-more-than-forty-three-characters";
  const code = await completeAuthorization(runtime, oauth, clientId, verifier);
  assert.ok(code);
  assert.equal(oauth.enrollmentOpen(), false);

  const wrongPkce = await exchange(runtime, {
    grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URIS[0], code_verifier: `${verifier}wrong`,
  });
  assert.equal(wrongPkce.status, 401);

  const exchanged = await exchange(runtime, {
    grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URIS[0], code_verifier: verifier,
  });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 600);

  const reused = await exchange(runtime, {
    grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URIS[0], code_verifier: verifier,
  });
  assert.equal(reused.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL(runtime.url), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  const mcp = new Client({ name: "claude-ai", version: "test" });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  const listed = await mcp.listTools();
  assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), E2EE_REMOTE_TOOL_NAMES);

  const refreshed = await exchange(runtime, {
    grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  const reusedRefresh = await exchange(runtime, {
    grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
  });
  assert.equal(reusedRefresh.status, 401);

  const revoked = await fetch(new URL("/oauth/revoke", runtime.url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: rotated.access_token }),
  });
  assert.equal(revoked.status, 200);
  await assert.rejects(oauth.verifyAccessToken(rotated.access_token), /revoked/i);
});

test("device-signed access tokens remain verifiable by another trusted runtime", async () => {
  const firstIdentity = identity();
  const secondIdentity = identity();
  secondIdentity.userId = firstIdentity.userId;
  secondIdentity.deviceId = "device_oauth_second";
  let issuedAccess;
  const first = oauthFor(firstIdentity);
  first.openEnrollmentWindow();

  // Exercise the token signer directly through the normal browser flow using
  // the first runtime, then verify on a second trusted runtime.
  const runtime = await startE2eeRemoteMcpHttpServer({
    client: fakeClient(), features: { requests: true }, readiness, oauth: first,
  });
  const registration = await register(runtime, {
    client_name: "Claude", redirect_uris: [CLAUDE_OAUTH_REDIRECT_URIS[0]],
  });
  const { client_id: clientId } = await registration.json();
  const verifier = "trusted-device-verifier-that-is-definitely-forty-three-characters";
  const code = await completeAuthorization(runtime, first, clientId, verifier);
  const exchanged = await exchange(runtime, {
    grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URIS[0], code_verifier: verifier,
  });
  issuedAccess = (await exchanged.json()).access_token;
  await runtime.close();

  const second = oauthFor(secondIdentity, {
    trustedDeviceKey: async (issuer) => {
      assert.equal(issuer.deviceId, firstIdentity.deviceId);
      assert.equal(issuer.fingerprint, firstIdentity.fingerprint);
      return createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: firstIdentity.signaturePublicKey },
        format: "jwk",
      });
    },
  });
  const grant = await second.verifyAccessToken(issuedAccess);
  assert.equal(grant.device_id, firstIdentity.deviceId);

  const otherIdentity = identity();
  otherIdentity.userId = "user_other";
  const otherAccount = oauthFor(otherIdentity, {
    trustedDeviceKey: async () => createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: firstIdentity.signaturePublicKey },
      format: "jwk",
    }),
  });
  await assert.rejects(otherAccount.verifyAccessToken(issuedAccess), /another Relay account/i);
});

test("native OAuth replay and revocation state is encrypted with a credential-store key", () => {
  const testIdentity = identity();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2ee-oauth-"));
  const file = path.join(root, "state.json");
  let credential = "";
  const credentials = {
    readCredential: () => credential ? { ok: true, value: credential } : { ok: false, detail: "missing" },
    writeCredential: (value) => { credential = value; return { ok: true }; },
    deleteCredential: () => { credential = ""; return { ok: true }; },
  };
  const store = createNativeE2eeMcpOAuthStateStore(testIdentity, { file, credentials });
  store.markCodeRedeemed("secret-code-id", Date.now() + 60_000, Date.now());
  store.revokeToken("secret-token-id", Date.now() + 60_000, Date.now());
  const disk = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(disk, /secret-code-id|secret-token-id|user_oauth|device_oauth/);
  assert.equal(Buffer.from(credential, "base64url").length, 32);

  const reopened = createNativeE2eeMcpOAuthStateStore(testIdentity, { file, credentials });
  assert.equal(reopened.isCodeRedeemed("secret-code-id", Date.now()), true);
  assert.equal(reopened.isTokenRevoked("secret-token-id", Date.now()), true);
});
