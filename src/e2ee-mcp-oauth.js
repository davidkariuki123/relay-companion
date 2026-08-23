import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import e2eeIdentityModule from "./e2ee-identity.cjs";
import { assertE2eeSenderDeviceTrusted } from "./e2ee-device-trust.js";
import {
  createMemoryE2eeMcpOAuthStateStore,
  createNativeE2eeMcpOAuthStateStore,
} from "./e2ee-mcp-oauth-state.js";

const { readPairedIdentity } = e2eeIdentityModule;

export const E2EE_MCP_SCOPE = "relay";
export const CLAUDE_OAUTH_REDIRECT_URIS = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

const ALLOWED_REDIRECTS = new Set(CLAUDE_OAUTH_REDIRECT_URIS);
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export class E2eeMcpOAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64Json(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new E2eeMcpOAuthError("invalid_request", "Invalid signed credential", 401); }
}

function identityPublicKey(identity) {
  const raw = Buffer.from(String(identity.signaturePublicKey || ""), "base64url");
  if (raw.length !== 32) throw new Error("This Relay device has an invalid signing identity.");
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function issuerIdentity(payload) {
  return {
    userId: String(payload?.iss || ""),
    deviceId: String(payload?.device_id || ""),
    fingerprint: String(payload?.device_fingerprint || ""),
  };
}

function signEnvelope(type, claims, identity) {
  const header = base64Json({ alg: "EdDSA", typ: type, v: 1 });
  const payload = base64Json({
    ...claims,
    iss: identity.userId,
    device_id: identity.deviceId,
    device_fingerprint: identity.fingerprint,
  });
  const body = `${header}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(body, "utf8"),
    createPrivateKey({ key: identity.privateKeyJwk, format: "jwk" }),
  ).toString("base64url");
  return `${body}.${signature}`;
}

function unsignedEnvelope(token, type) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new E2eeMcpOAuthError("invalid_request", "Invalid signed credential", 401);
  const header = parseBase64Json(parts[0]);
  const payload = parseBase64Json(parts[1]);
  if (header?.v !== 1 || header.alg !== "EdDSA" || header.typ !== type) {
    throw new E2eeMcpOAuthError("invalid_request", `Invalid ${type} credential`, 401);
  }
  return { parts, payload, body: `${parts[0]}.${parts[1]}` };
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanOrigin(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("The E2EE Claude endpoint must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The E2EE Claude endpoint origin is invalid.");
  return url.origin;
}

function redirectUris(value) {
  if (!Array.isArray(value) || !value.length || value.length > 2) {
    throw new E2eeMcpOAuthError("invalid_client_metadata", "Claude redirect_uris are required");
  }
  const normalized = [...new Set(value.map((item) => {
    const uri = String(item || "").trim().replace(/\/$/, "");
    if (!ALLOWED_REDIRECTS.has(uri)) {
      throw new E2eeMcpOAuthError("invalid_redirect_uri", "Only Claude's official callback is accepted");
    }
    return uri;
  }))];
  return normalized;
}

function normalizeScope(value) {
  if (String(value || E2EE_MCP_SCOPE).trim() !== E2EE_MCP_SCOPE) {
    throw new E2eeMcpOAuthError("invalid_scope", `Supported scope: ${E2EE_MCP_SCOPE}`);
  }
  return E2EE_MCP_SCOPE;
}

function pkceS256(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function tokenId(token) {
  return createHash("sha256").update(token).digest("base64url");
}

async function bodyParams(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new E2eeMcpOAuthError("invalid_request", "OAuth request is too large", 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    try { return record(JSON.parse(text || "{}")); }
    catch { throw new E2eeMcpOAuthError("invalid_request", "OAuth JSON is invalid"); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function json(res, status, value, headers = {}) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function html(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(value),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

function oauthError(res, error) {
  const value = error instanceof E2eeMcpOAuthError
    ? error
    : new E2eeMcpOAuthError("server_error", error?.message || "OAuth request failed", 500);
  json(res, value.status, { error: value.code, error_description: value.message });
}

/**
 * Device-owned OAuth for normal Claude custom connectors. Every durable
 * credential is signed by an enrolled Relay device; Relay's blind gateway can
 * route the TLS connection but cannot mint or read these credentials.
 */
export function createE2eeMcpOAuth({
  publicOrigin,
  client,
  identity = readPairedIdentity(),
  stateStore,
  now = () => Date.now(),
  trustedDeviceKey,
} = {}) {
  if (!identity?.userId || !identity?.deviceId || !identity?.fingerprint || !identity?.privateKeyJwk) {
    throw new Error("This Relay runtime is not an enrolled E2EE device.");
  }
  const origin = cleanOrigin(publicOrigin);
  const resource = `${origin}/mcp`;
  const store = stateStore || createNativeE2eeMcpOAuthStateStore(identity);
  let enrollmentExpiresAt = 0;

  const resolveTrustedKey = trustedDeviceKey || (async ({ userId, deviceId, fingerprint }) => {
    if (userId === identity.userId && deviceId === identity.deviceId && fingerprint === identity.fingerprint) {
      return identityPublicKey(identity);
    }
    if (!client) throw new E2eeMcpOAuthError("invalid_token", "The issuing Relay device cannot be verified", 401);
    const trust = await assertE2eeSenderDeviceTrusted(client, userId, deviceId, { identity });
    const device = trust.directory.devices.find((item) => item.deviceId === deviceId);
    if (!device || device.fingerprint !== fingerprint) {
      throw new E2eeMcpOAuthError("invalid_token", "The issuing Relay device identity changed", 401);
    }
    const raw = Buffer.from(String(device.signaturePublicKey || ""), "base64url");
    if (raw.length !== 32) throw new E2eeMcpOAuthError("invalid_token", "The issuing Relay device key is invalid", 401);
    return createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
  });

  const decode = async (token, type, { expiredCode = "invalid_request" } = {}) => {
    const envelope = unsignedEnvelope(token, type);
    const issuer = issuerIdentity(envelope.payload);
    if (!issuer.userId || !issuer.deviceId || !issuer.fingerprint) {
      throw new E2eeMcpOAuthError(expiredCode, "Signed credential has no device identity", 401);
    }
    if (issuer.userId !== identity.userId) {
      throw new E2eeMcpOAuthError(expiredCode, "Signed credential belongs to another Relay account", 401);
    }
    const key = await resolveTrustedKey(issuer);
    if (!verify(null, Buffer.from(envelope.body, "utf8"), key, Buffer.from(envelope.parts[2], "base64url"))) {
      throw new E2eeMcpOAuthError(expiredCode, "Signed credential could not be verified", 401);
    }
    if (!Number.isSafeInteger(envelope.payload.exp) || envelope.payload.exp <= now()) {
      throw new E2eeMcpOAuthError(expiredCode, "Signed credential has expired", 401);
    }
    if (envelope.payload.aud !== resource) {
      throw new E2eeMcpOAuthError(expiredCode, "Signed credential belongs to another Relay endpoint", 401);
    }
    return envelope.payload;
  };

  const issue = (type, claims, ttlMs) => signEnvelope(type, {
    ...claims,
    aud: resource,
    iat: now(),
    exp: now() + ttlMs,
    jti: randomBytes(24).toString("base64url"),
  }, identity);

  const readClient = async (clientId) => {
    const payload = await decode(clientId, "relay-mcp-client");
    return {
      clientId,
      clientName: String(payload.client_name || "Claude"),
      redirectUris: redirectUris(payload.redirect_uris),
    };
  };

  const validateAuthorization = async (query) => {
    if (query.response_type !== "code") {
      throw new E2eeMcpOAuthError("unsupported_response_type", "response_type must be code");
    }
    const oauthClient = await readClient(String(query.client_id || ""));
    const redirectUri = String(query.redirect_uri || "").replace(/\/$/, "");
    if (!oauthClient.redirectUris.includes(redirectUri)) {
      throw new E2eeMcpOAuthError("invalid_redirect_uri", "redirect_uri is not registered for this client");
    }
    const challenge = String(query.code_challenge || "");
    if (query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      throw new E2eeMcpOAuthError("invalid_request", "A valid S256 PKCE challenge is required");
    }
    if (String(query.resource || resource).replace(/\/$/, "") !== resource) {
      throw new E2eeMcpOAuthError("invalid_target", "This authorization is for another resource");
    }
    return {
      clientId: oauthClient.clientId,
      clientName: oauthClient.clientName,
      redirectUri,
      codeChallenge: challenge,
      state: String(query.state || "").slice(0, 2000),
      scope: normalizeScope(query.scope),
    };
  };

  const tokenResponse = (clientId) => ({
    access_token: issue("relay-mcp-access", {
      client_hash: tokenId(clientId),
      scope: E2EE_MCP_SCOPE,
    }, ACCESS_TTL_MS),
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: issue("relay-mcp-refresh", {
      client_hash: tokenId(clientId),
      scope: E2EE_MCP_SCOPE,
    }, REFRESH_TTL_MS),
    scope: E2EE_MCP_SCOPE,
  });

  const api = {
    origin,
    resource,
    protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    openEnrollmentWindow({ durationMs = 15 * 60 * 1000 } = {}) {
      const bounded = Math.min(Math.max(Number(durationMs) || 0, 60_000), 30 * 60 * 1000);
      enrollmentExpiresAt = now() + bounded;
      return { expiresAt: new Date(enrollmentExpiresAt).toISOString() };
    },
    closeEnrollmentWindow() { enrollmentExpiresAt = 0; },
    enrollmentOpen() { return enrollmentExpiresAt > now(); },
    async verifyAccessToken(token) {
      const payload = await decode(token, "relay-mcp-access", { expiredCode: "invalid_token" });
      if (store.isTokenRevoked(tokenId(token), now())) {
        throw new E2eeMcpOAuthError("invalid_token", "Access token was revoked", 401);
      }
      return payload;
    },
    async handleHttpRequest(req, res, url) {
      const pathname = url.pathname;
      if (req.method === "GET" && [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(pathname)) {
        json(res, 200, {
          resource,
          resource_name: "Relay E2EE device",
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
          scopes_supported: [E2EE_MCP_SCOPE],
        }, { "Cache-Control": "public, max-age=300" });
        return true;
      }
      if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [E2EE_MCP_SCOPE],
        }, { "Cache-Control": "public, max-age=300" });
        return true;
      }
      if (req.method === "POST" && pathname === "/oauth/register") {
        try {
          if (!api.enrollmentOpen()) {
            throw new E2eeMcpOAuthError("access_denied", "Open Relay and choose Connect Claude before registering", 403);
          }
          const body = await bodyParams(req);
          if (String(body.token_endpoint_auth_method || "none") !== "none") {
            throw new E2eeMcpOAuthError("invalid_client_metadata", "Relay supports public PKCE clients only");
          }
          const uris = redirectUris(body.redirect_uris);
          const name = String(body.client_name || "Claude").trim().slice(0, 120) || "Claude";
          const clientId = issue("relay-mcp-client", { client_name: name, redirect_uris: uris }, CLIENT_TTL_MS);
          json(res, 201, {
            client_id: clientId,
            client_id_issued_at: Math.floor(now() / 1000),
            client_name: name,
            redirect_uris: uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          });
        } catch (error) { oauthError(res, error); }
        return true;
      }
      if (req.method === "GET" && pathname === "/oauth/authorize") {
        try {
          if (!api.enrollmentOpen()) {
            throw new E2eeMcpOAuthError("access_denied", "Open Relay and choose Connect Claude to approve this connection", 403);
          }
          const request = await validateAuthorization(Object.fromEntries(url.searchParams));
          const requestToken = issue("relay-mcp-request", request, REQUEST_TTL_MS);
          html(res, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Claude to Relay</title><style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:1rem;line-height:1.5}button{font:inherit;padding:.7rem 1rem}</style><h1>Connect Claude to Relay?</h1><p>Claude will be able to read and send your encrypted Relays while this device is available. Relay's servers still cannot read them.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(requestToken)}"><button name="decision" value="allow">Allow Claude</button> <button name="decision" value="deny">Cancel</button></form></html>`);
        } catch (error) { oauthError(res, error); }
        return true;
      }
      if (req.method === "POST" && pathname === "/oauth/authorize") {
        try {
          if (!api.enrollmentOpen()) throw new E2eeMcpOAuthError("access_denied", "The Claude connection window expired", 403);
          const body = await bodyParams(req);
          const request = await decode(String(body.request || ""), "relay-mcp-request");
          const clientDetails = await readClient(String(request.clientId || ""));
          if (!clientDetails.redirectUris.includes(String(request.redirectUri || ""))) {
            throw new E2eeMcpOAuthError("invalid_redirect_uri", "The Claude callback changed");
          }
          const destination = new URL(request.redirectUri);
          if (String(body.decision || "") !== "allow") {
            destination.searchParams.set("error", "access_denied");
            destination.searchParams.set("error_description", "The user declined this connection");
          } else {
            destination.searchParams.set("code", issue("relay-mcp-code", {
              client_id: request.clientId,
              redirect_uri: request.redirectUri,
              code_challenge: request.codeChallenge,
              scope: request.scope,
            }, CODE_TTL_MS));
            api.closeEnrollmentWindow();
          }
          if (request.state) destination.searchParams.set("state", request.state);
          res.writeHead(302, { Location: destination.toString(), "Cache-Control": "no-store" });
          res.end();
        } catch (error) { oauthError(res, error); }
        return true;
      }
      if (req.method === "POST" && pathname === "/oauth/token") {
        try {
          const body = await bodyParams(req);
          const clientId = String(body.client_id || "");
          await readClient(clientId);
          if (body.grant_type === "authorization_code") {
            const code = String(body.code || "");
            const grant = await decode(code, "relay-mcp-code", { expiredCode: "invalid_grant" });
            if (grant.client_id !== clientId || grant.redirect_uri !== String(body.redirect_uri || "")) {
              throw new E2eeMcpOAuthError("invalid_grant", "Authorization code does not match this client", 401);
            }
            const verifier = String(body.code_verifier || "");
            if (verifier.length < 43 || verifier.length > 128 || !equalText(pkceS256(verifier), grant.code_challenge)) {
              throw new E2eeMcpOAuthError("invalid_grant", "PKCE verification failed", 401);
            }
            const id = tokenId(code);
            if (store.isCodeRedeemed(id, now())) throw new E2eeMcpOAuthError("invalid_grant", "Authorization code was already used", 401);
            store.markCodeRedeemed(id, grant.exp, now());
            json(res, 200, tokenResponse(clientId), { Pragma: "no-cache" });
          } else if (body.grant_type === "refresh_token") {
            const refresh = String(body.refresh_token || "");
            const grant = await decode(refresh, "relay-mcp-refresh", { expiredCode: "invalid_grant" });
            if (grant.client_hash !== tokenId(clientId) || store.isTokenRevoked(tokenId(refresh), now())) {
              throw new E2eeMcpOAuthError("invalid_grant", "Refresh token is invalid", 401);
            }
            store.revokeToken(tokenId(refresh), grant.exp, now());
            json(res, 200, tokenResponse(clientId), { Pragma: "no-cache" });
          } else {
            throw new E2eeMcpOAuthError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token");
          }
        } catch (error) { oauthError(res, error); }
        return true;
      }
      if (req.method === "POST" && pathname === "/oauth/revoke") {
        try {
          const body = await bodyParams(req);
          const token = String(body.token || "");
          let grant = null;
          for (const type of ["relay-mcp-access", "relay-mcp-refresh"]) {
            try { grant = await decode(token, type, { expiredCode: "invalid_token" }); break; }
            catch {}
          }
          if (grant) store.revokeToken(tokenId(token), grant.exp, now());
          json(res, 200, {});
        } catch (error) { oauthError(res, error); }
        return true;
      }
      return false;
    },
  };
  return api;
}

export { createMemoryE2eeMcpOAuthStateStore };
