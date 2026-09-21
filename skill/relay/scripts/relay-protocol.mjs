#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareOrdinaryRelayAttachments } from "./relay-attachments.mjs";
import { readLocalDescriptor, localRequest, LOCAL_TOOL_TIMEOUT_MS } from "./relay-local.mjs";
import { spawnSync } from "node:child_process";

const DEFAULT_CONFIG = path.join(os.homedir(), ".relay", "agent-protocol.json");
const DEFAULT_PENDING = path.join(os.homedir(), ".relay", "agent-authorization.json");
const TRUSTED_RELAY_HOSTS = new Map([
  ["https://api.sendrelays.com", "https://sendrelays.com"],
  ["https://dev-api.sendrelays.com", "https://dev.sendrelays.com"],
  ["https://cti37jd7vx.us-east-1.awsapprunner.com", "https://8epdrqim29.us-east-1.awsapprunner.com"],
]);
const TUTORIAL_HUMAN = "Hi — I’ve just joined you on Relay.";
const TUTORIAL_AGENT = "This is my first Relay after joining from your invite. Help the person reply if they want to welcome me.";
let transport = "auto";
let lastTransport = "";
const DIRECT_RECOVERY = "To renew browser approval, use connect-start <approved-api-origin> <invite-token> codex|claude_code, approve the returned URL in your browser, then connect-finish. Your own invitation from the Relay website can be used; no Companion or device enrollment is needed.";
const SAFE_GET = [
  /^\/v1\/share-links\/[A-Za-z0-9_-]+\/stats(?:\?.*)?$/,
  /^\/v1\/contact-groups$/,
  /^\/v1\/chats(?:\?.*)?$/,
  /^\/v1\/chats\/[A-Za-z0-9_-]+(?:\?.*)?$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9_-]+\/download-url$/,
  /^\/v1\/me$/,
  /^\/v1\/inbox(?:\?.*)?$/,
  /^\/v1\/sent(?:\?.*)?$/,
  /^\/v1\/contacts\/search\?q=.+$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+$/,
  /^\/v1\/threads\/[A-Za-z0-9_-]+$/,
  /^\/v1\/share-links\/[A-Za-z0-9_-]+$/,
];
const SAFE_POST = [
  /^\/v1\/share-links\/[A-Za-z0-9_-]+\/placements$/,
  /^\/v1\/relays$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+\/forward$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+\/read$/,
  /^\/v1\/invite-link$/,
  /^\/v1\/invites-v2\/link$/,
  /^\/v1\/share-links$/,
];
// A person may correct a message they sent, or take back a link they minted
// or a message they sent, from the same conversation. Both are sender-only on
// the server and converge on an exact retry.
const SAFE_PUT = [/^\/v1\/share-links\/[A-Za-z0-9_-]+\/placements\/[A-Za-z0-9_-]+\/snapshot$/];
const SAFE_PATCH = [
  /^\/v1\/messages\/[A-Za-z0-9_-]+$/,
];
const SAFE_DELETE = [
  /^\/v1\/share-links\/[A-Za-z0-9_-]+$/,
  /^\/v1\/messages\/[A-Za-z0-9_-]+$/,
];

function configPath(env = process.env) {
  return env.RELAY_AGENT_CONFIG || (env.RELAY_CONFIG_DIR ? path.join(env.RELAY_CONFIG_DIR, "agent-protocol.json") : DEFAULT_CONFIG);
}

function pendingPath(env = process.env) {
  return env.RELAY_AGENT_AUTHORIZATION || (env.RELAY_CONFIG_DIR ? path.join(env.RELAY_CONFIG_DIR, "agent-authorization.json") : DEFAULT_PENDING);
}

function currentSkillTarget(env = process.env) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    { host: "codex", target: "primary", directory: path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "relay") },
    { host: "codex", target: "compatibility", directory: path.join(os.homedir(), ".agents", "skills", "relay") },
    { host: "claude", target: "primary", directory: path.join(env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "skills", "relay") },
  ];
  return candidates.find((candidate) => path.resolve(candidate.directory) === root) || null;
}

function skillFileNames(root, current = root, prefix = "", output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!prefix && entry.name === ".relay-managed.json") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) skillFileNames(root, path.join(current, entry.name), relative, output);
    else output.push(relative);
  }
  return output;
}

function managedSkillTelemetryHeader(env = process.env) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(root, ".relay-managed.json"), "utf8")); } catch {}
    const recordedTarget = ["codex", "claude"].includes(state?.host) && ["primary", "compatibility"].includes(state?.target)
      ? { host: state.host, target: state.target }
      : null;
    const target = recordedTarget || currentSkillTarget(env);
    if (!target) return "";
    const managed = state?.schemaVersion === 1 && state?.name === "relay" && Array.isArray(state.files);
    let modified = false;
    if (managed) {
      const expected = new Set(state.files.map((entry) => String(entry?.path || "").replace(/\\/g, "/")));
      const actual = new Set(skillFileNames(root));
      if (expected.size !== actual.size || [...expected].some((relative) => !actual.has(relative))) modified = true;
      for (const entry of state.files) {
        const relative = String(entry?.path || "").replace(/\\/g, "/");
        if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
          modified = true;
          break;
        }
        try {
          const bytes = fs.readFileSync(path.join(root, ...relative.split("/")));
          if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) modified = true;
        } catch { modified = true; }
      }
    }
    const installedAt = typeof state?.installedAt === "string" && Number.isFinite(Date.parse(state.installedAt))
      ? new Date(state.installedAt).toISOString()
      : null;
    const payload = {
      name: "relay",
      host: target.host,
      target: target.target,
      ...(managed && /^ski_[A-Za-z0-9_-]{20,80}$/.test(String(state.installationId || "")) ? { installationId: state.installationId } : {}),
      version: managed && /^\d+\.\d+\.\d+$/.test(String(state.version || "")) ? state.version : null,
      consentVersion: managed && Number.isSafeInteger(state.consentVersion) && state.consentVersion > 0 ? state.consentVersion : null,
      status: !managed ? "unmanaged" : modified ? "modified" : "managed",
      installedAt,
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  } catch {
    return "";
  }
}

function relayApiOrigin(value, env = process.env) {
  const parsed = new URL(String(value || ""));
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Relay requires one clean API origin.");
  }
  if (TRUSTED_RELAY_HOSTS.has(parsed.origin)) return parsed.origin;
  if (loopback && env.RELAY_AGENT_ALLOW_LOOPBACK === "1" && ["http:", "https:"].includes(parsed.protocol)) return parsed.origin;
  throw new Error("Relay requires the production or development Relay API host, or the approved staging API host.");
}

function trustedApprovalUrl(value, apiUrl, authorizationId, env = process.env) {
  const parsed = new URL(String(value || ""));
  const expectedPath = `/connect-agent/${encodeURIComponent(authorizationId)}`;
  const approvalToken = new URLSearchParams(parsed.hash.slice(1)).get("approvalToken");
  if (parsed.username || parsed.password || parsed.search || parsed.pathname !== expectedPath || !approvalToken) {
    throw new Error("Relay returned an unsafe approval URL.");
  }
  const expectedWebOrigin = TRUSTED_RELAY_HOSTS.get(apiUrl);
  if (expectedWebOrigin) {
    if (parsed.protocol !== "https:" || parsed.origin !== expectedWebOrigin) throw new Error("Relay returned an approval URL for the wrong host.");
  } else if (!(env.RELAY_AGENT_ALLOW_LOOPBACK === "1" && parsed.origin === apiUrl)) {
    throw new Error("Relay returned an approval URL for the wrong host.");
  }
  return parsed.href;
}

function readConfig(file = configPath(), { direct = transport === "https" } = {}) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") {
      if (direct) throw new Error(`No independent Relay authorization is saved. ${DIRECT_RECOVERY}`);
      const local = readLocalDescriptor();
      if (!local) throw new Error("Relay is not connected in this agent yet. Complete the browser approval first.");
      if (!/^usr_[A-Za-z0-9_-]+$/.test(String(local.accountId || ""))) throw new Error("Relay's local account is invalid. Reopen Companion.");
      value = { local: true, consentVersion: 2, apiUrl: local.apiUrl, account: { relayUserId: local.accountId } };
    } else {
      throw new Error("Relay's agent credential file could not be read.");
    }
  }
  const apiUrl = relayApiOrigin(value?.apiUrl);
  const accessToken = String(value?.accessToken || "");
  if ((!value.local || direct) && (!accessToken.startsWith("web_") || accessToken.length < 20)) throw new Error(`Relay's independent credential is missing or invalid. ${DIRECT_RECOVERY}`);
  if ((!value.local || direct) && value.expiresAt && (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())) throw new Error(`Relay's agent authorization expired or has an invalid expiry. ${DIRECT_RECOVERY}`);
  return { ...value, apiUrl, accessToken };
}

function protectOwnerOnly(file, env = process.env) {
  if (process.platform === "win32") {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const options = { encoding: "utf8", windowsHide: true, timeout: 20_000, env };
    const whoami = spawnSync(path.join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], options);
    const sid = String(whoami.stdout || "").match(/S-\d-(?:\d+-)+\d+/)?.[0];
    if (whoami.error || whoami.status !== 0 || !sid) throw new Error("Relay could not identify this Windows account to protect its credential.");
    const icacls = path.join(systemRoot, "System32", "icacls.exe");
    const hardened = spawnSync(icacls, [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`], options);
    const verified = hardened.status === 0 ? spawnSync(icacls, [file, "/verify"], options) : hardened;
    if (verified.error || verified.status !== 0) throw new Error("Relay could not apply an owner-only Windows ACL to its credential.");
    return;
  }
  fs.chmodSync(file, 0o600);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Relay could not protect its credential file.");
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try { protectOwnerOnly(temporary); }
    catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function allowed(method, requestPath) {
  const list = method === "PUT" ? SAFE_PUT : method === "GET" ? SAFE_GET : method === "POST" ? SAFE_POST : method === "PATCH" ? SAFE_PATCH : method === "DELETE" ? SAFE_DELETE : [];
  return list.some((pattern) => pattern.test(requestPath));
}

async function authenticatedRequest(apiUrl, accessToken, method, requestPath, body) {
  const skillTelemetry = managedSkillTelemetryHeader();
  let response;
  try { response = await fetch(`${apiUrl}${requestPath}`, {
    method,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Relay-Client": "relay-agent-skill",
      "X-Relay-Send-Contract": "2",
      ...(skillTelemetry ? { "X-Relay-Skill-Telemetry": skillTelemetry } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  }); } catch (error) {
    throw Object.assign(new Error(`Direct HTTPS could not reach ${apiUrl} (${error.cause?.code || error.name || "network_error"}). No response was confirmed; preserve the original body and idempotency key for any retry.`), { code: error.cause?.code || error.name || "network_error" });
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Relay returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const message = payload.message || payload.error || `Relay request failed (${response.status}).`;
    const error = new Error(response.status === 401 ? `${message}. ${DIRECT_RECOVERY}` : message);
    error.status = response.status;
    error.code = payload.error || "";
    error.body = payload;
    throw error;
  }
  try {
    const healthRoot = path.join(os.homedir(), ".relay", "transport-health");
    fs.mkdirSync(healthRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(healthRoot, "https.json"), JSON.stringify({ at: Date.now() }), { mode: 0o600 });
  } catch { /* Diagnostics must not change the outcome of a successful request. */ }
  return payload;
}

/**
 * Classify the local Companion descriptor against this connection's approved
 * account and origin. A different person is an identity conflict and is never
 * bypassed. The same person on another Relay environment leaves Companion
 * unusable for this credential; scoped HTTPS may still answer after the direct
 * account check, and every message names both origins so the agent can report
 * exactly what differs instead of asking the human to restart.
 */
function companionAvailability(config, local) {
  if (!local || (config.consentVersion ?? 1) < 2) return { status: "absent" };
  if (local.accountId !== config.account?.relayUserId) {
    return { status: "other_account", message: "Companion is connected to a different Relay account. Nothing was sent or read." };
  }
  if (local.apiUrl !== config.apiUrl) {
    return {
      status: "other_environment",
      message: `Companion is signed in to ${local.apiUrl} while this connection was approved on ${config.apiUrl}. Companion-only commands are unavailable until they match; scoped requests read from ${config.apiUrl} directly.`,
    };
  }
  return { status: "ready" };
}

async function request(method, requestPath, body) {
  const verb = String(method || "GET").toUpperCase();
  const cleanPath = String(requestPath || "");
  if (!cleanPath.startsWith("/") || cleanPath.startsWith("//") || !allowed(verb, cleanPath)) {
    throw new Error(`Relay agent protocol does not allow ${verb} ${cleanPath || "<missing path>"}.`);
  }
  const config = readConfig();
  const local = transport === "https" ? null : readLocalDescriptor();
  const companion = companionAvailability(config, local);
  if (companion.status === "other_account") throw new Error(companion.message);
  if (companion.status === "other_environment") {
    // Same person, different Relay environment (for example Companion on the
    // staging channel while this browser approval was granted on dev). The
    // approved credential still names one exact origin, and the direct path
    // below re-verifies the account against it, so this is a Companion outage
    // for this connection rather than an identity conflict. Say which origin
    // answers so the human is never silently reading a different environment.
    process.stderr.write(`${companion.message}\n`);
  } else if (companion.status === "ready") {
    // Retain the browser-approved credential independently of Companion. Record
    // the local attempt before dispatch so a lost response still requires the
    // encryption/account checks on a later direct retry.
    if (!config.local) { config.local = true; atomicWrite(configPath(), config); }
    try {
      const result = await localRequest(local, { method: verb, path: cleanPath, body, accountId: config.account.relayUserId });
      lastTransport = "local";
      return result;
    } catch (error) {
      const stableMutation = replaySafe(verb, cleanPath, body);
      // Permission and application refusals are authoritative; an expired local
      // authentication can use the separately approved direct credential.
      // An uncertain mutation can only cross transports with the same body
      // and stable deduplication key.
      if (transport === "local" || !localUnavailable(error) || (error.possiblySent && verb !== "GET" && !stableMutation)) throw error;
    }
  }
  if (transport === "local") throw new Error("The matching Relay Companion is unavailable; local transport was explicitly selected.");
  if (!config.accessToken.startsWith("web_") || config.accessToken.length < 20) {
    throw new Error(`This connection has no direct Relay credential. ${DIRECT_RECOVERY}`);
  }
  if (config.expiresAt && (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= Date.now())) throw new Error(`Relay's direct authorization expired or has an invalid expiry. ${DIRECT_RECOVERY}`);
  if (transport === "https" || config.local || companion.status === "other_environment") {
    const me = await authenticatedRequest(config.apiUrl, config.accessToken, "GET", "/v1/me");
    if (!config.account?.relayUserId || me.user?.id !== config.account.relayUserId) throw new Error("Direct Relay is connected to a different account. Nothing was sent or read.");
    lastTransport = "https";
    if (verb === "GET" && cleanPath === "/v1/me") return me;
  }
  lastTransport = "https";
  try { return await authenticatedRequest(config.apiUrl, config.accessToken, verb, cleanPath, body); }
  catch (error) {
    if (verb !== "POST" || cleanPath !== "/v1/relays" || body?.longForHumanConfirmed !== true || error.code !== "human_message_review_required" || !error.body?.reviewToken) throw error;
    return authenticatedRequest(config.apiUrl, config.accessToken, verb, cleanPath, { ...body, longForHumanReviewToken: error.body.reviewToken });
  }
}

function replaySafe(method, route, body) {
  // Only these operations have server-backed deduplication. An arbitrary key
  // on another mutation is not proof that replay is safe.
  const keyed = typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim().length >= 8;
  if (method === "GET") return true;
  if (method === "POST") return keyed && (route === "/v1/relays" || route === "/v1/share-links" || /^\/v1\/relays\/[A-Za-z0-9_-]+\/forward$/.test(route));
  // An exact edit or delete of a sent message converges on the server: the same
  // content is a no-op and an already-deleted message reports its tombstone.
  return keyed && (method === "PATCH" || method === "DELETE") && /^\/v1\/messages\/[A-Za-z0-9_-]+$/.test(route);
}

function localUnavailable(error) {
  return error.localTransportFailure || error.status === 401
    || (error.status === 404 && error.code === "local_route_unavailable");
}

function parseJson(value, label = "JSON body") {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is not valid JSON.`); }
}

async function publicRequest(apiUrl, requestPath, body) {
  const trustedApiUrl = relayApiOrigin(apiUrl);
  const response = await fetch(`${trustedApiUrl}${requestPath}`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", "X-Relay-Client": "relay-agent-skill" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Relay returned an unreadable authorization response (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Relay authorization failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error || "";
    throw error;
  }
  return payload;
}

async function connectStart(apiUrl, inviteToken, surface) {
  const cleanSurface = surface === "codex" ? "codex" : surface === "claude_code" ? "claude_code" : "";
  if (!cleanSurface) throw new Error("Relay connect-start requires surface claude_code or codex.");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(inviteToken || ""))) throw new Error("Relay invite token is invalid.");
  const verifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const trustedApiUrl = relayApiOrigin(apiUrl);
  const response = await publicRequest(trustedApiUrl, "/v1/agent/authorizations", {
    inviteToken,
    consentVersion: 2,
    clientName: cleanSurface === "codex" ? "Relay for Codex" : "Relay for Claude Code",
    surface: cleanSurface,
    codeChallenge,
    codeChallengeMethod: "S256",
  });
  const authorizationId = String(response.authorizationId || "");
  if (!/^[A-Za-z0-9_-]+$/.test(authorizationId)) throw new Error("Relay returned an invalid authorization id.");
  const pending = {
    version: 1,
    apiUrl: trustedApiUrl,
    authorizationId,
    clientSecret: String(response.clientSecret || ""),
    codeVerifier: verifier,
    approvalUrl: trustedApprovalUrl(response.approvalUrl, trustedApiUrl, authorizationId),
    expiresAt: String(response.expiresAt || ""),
  };
  if (!pending.authorizationId || pending.clientSecret.length < 32) {
    throw new Error("Relay returned an incomplete authorization.");
  }
  atomicWrite(pendingPath(), pending);
  return { ok: true, approvalUrl: pending.approvalUrl, expiresAt: pending.expiresAt };
}

async function connectFinish() {
  let pending;
  try { pending = JSON.parse(fs.readFileSync(pendingPath(), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("No Relay browser approval is waiting. Start the connection again.");
    throw new Error("Relay's pending authorization could not be read.");
  }
  let response;
  try {
    response = await publicRequest(
      pending.apiUrl,
      `/v1/agent/authorizations/${encodeURIComponent(pending.authorizationId)}/consume`,
      { clientSecret: pending.clientSecret, codeVerifier: pending.codeVerifier },
    );
  } catch (error) {
    if (Number(error?.status) === 409 && error?.code === "authorization_pending") {
      throw new Error("Relay is still waiting for browser approval.");
    }
    if (Number(error?.status) === 409 && error?.code === "authorization_approved") {
      throw new Error("Relay approved the identity and is still finishing the invite connection. Try again shortly.");
    }
    if (Number(error?.status) === 409 && error?.code === "authorization_consumed") {
      throw new Error("This Relay connection request was already consumed. Start a new connection request.");
    }
    if (Number(error?.status) === 409 && error?.code === "authorization_cancelled") {
      throw new Error("This Relay connection request was cancelled. Start again if the person still wants to connect.");
    }
    throw error;
  }
  const record = await configureFromResponse(response, { expectedApiUrl: pending.apiUrl });
  fs.rmSync(pendingPath(), { force: true });
  return {
    ok: true,
    connected: true,
    account: record.account,
    inviter: record.inviter,
    org: record.org,
    invite: record.invite,
    tutorial: record.tutorial,
    expiresAt: record.expiresAt,
  };
}

function requiredOrgIdentity(value) {
  const name = String(value?.name || "").trim();
  const groupId = String(value?.groupId || "").trim();
  if (!name || !/^grp_[A-Za-z0-9_-]+$/.test(groupId)) throw new Error("Relay authorization did not contain a valid organisation identity.");
  return { name, groupId };
}

function requiredRelayIdentity(value, label, { requireName = true } = {}) {
  const name = String(value?.name || "").trim();
  const relayUserId = String(value?.relayUserId || value?.id || "").trim();
  if ((requireName && !name) || !/^[A-Za-z0-9_-]+$/.test(relayUserId)) throw new Error(`Relay authorization did not contain a valid ${label} identity.`);
  return { name, relayUserId };
}

async function configureFromResponse(input, { expectedApiUrl } = {}) {
  const apiUrl = relayApiOrigin(input.apiUrl);
  if (expectedApiUrl && apiUrl !== relayApiOrigin(expectedApiUrl)) throw new Error("Relay authorization changed API hosts unexpectedly.");
  const accessToken = String(input.accessToken || "");
  if (!accessToken.startsWith("web_") || accessToken.length < 20) throw new Error("Relay authorization did not contain a valid access token.");
  const org = input.org ? requiredOrgIdentity(input.org) : undefined;
  const inviter = org ? undefined : requiredRelayIdentity(input.inviter, "inviter");
  // Prove which account the new bearer credential represents before persisting
  // anything or consuming the recoverable pending authorization file.
  const me = await authenticatedRequest(apiUrl, accessToken, "GET", "/v1/me");
  const own = requiredRelayIdentity(me?.user, "account", { requireName: false });
  const selfInvite = own.relayUserId === inviter?.relayUserId;
  let existing = null;
  try { existing = readConfig(); } catch {}
  const sameConnection = existing?.apiUrl === apiUrl
    && existing?.account?.relayUserId === own.relayUserId
    && existing?.inviter?.relayUserId === inviter?.relayUserId
    && existing?.org?.groupId === org?.groupId;
  const record = {
    version: 1,
    consentVersion: input.consentVersion ?? 1,
    apiUrl,
    accessToken,
    expiresAt: String(input.expiresAt || ""),
    account: { ...(input.account && typeof input.account === "object" ? input.account : {}), relayUserId: own.relayUserId },
    inviter,
    org,
    invite: input.invite && typeof input.invite === "object" ? input.invite : undefined,
    tutorial: sameConnection && existing?.tutorial
      ? existing.tutorial
      : selfInvite
        ? { state: "skipped_self", idempotencyKey: "", relayId: "", responseState: "", updatedAt: new Date().toISOString() }
        : { state: "pending", idempotencyKey: randomUUID(), relayId: "", responseState: "", updatedAt: new Date().toISOString() },
    ...(sameConnection && existing?.lastSend ? { lastSend: existing.lastSend } : {}),
    connectedAt: sameConnection && existing?.connectedAt ? existing.connectedAt : new Date().toISOString(),
  };
  atomicWrite(configPath(), record);
  return record;
}

async function prepareSendBody(body) {
  if (!body || typeof body !== "object") throw new Error("Relay send requires a message body.");
  const { files, trustedLocalRoot, ...rest } = body;
  return { ...rest, attachments: await prepareOrdinaryRelayAttachments({ ...body, trustedLocalRoot: "" }) };
}

function sendBodyHash(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

async function sendPersisted(body) {
  body = await prepareSendBody(body);
  const key = String(body?.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 200) throw new Error("Relay send requires a caller-supplied idempotencyKey of at least eight characters.");
  const config = readConfig();
  const bodyHash = sendBodyHash(body);
  if (config.lastSend?.idempotencyKey === key && config.lastSend?.bodyHash !== bodyHash) {
    throw new Error("Relay refused to reuse an idempotency key with a different message body.");
  }
  if (config.lastSend?.idempotencyKey === key && config.lastSend?.state === "accepted" && config.lastSend?.relayId) {
    return { ok: true, status: "already_accepted", relayId: config.lastSend.relayId, state: config.lastSend.responseState || "" };
  }
  config.lastSend = {
    idempotencyKey: key,
    bodyHash,
    state: "attempting",
    relayId: "",
    responseState: "",
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(configPath(), config);
  try {
    const result = await request("POST", "/v1/relays", body);
    const latest = readConfig();
    latest.lastSend = {
      ...latest.lastSend,
      idempotencyKey: key,
      bodyHash,
      state: "accepted",
      relayId: String(result?.relayId || ""),
      responseState: String(result?.state || ""),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(configPath(), latest);
    return result;
  } catch (error) {
    if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
      const latest = readConfig();
      latest.lastSend = { ...latest.lastSend, state: "rejected", updatedAt: new Date().toISOString() };
      atomicWrite(configPath(), latest);
    }
    throw error;
  }
}

async function sendTutorial(approved, draft) {
  if (!approved) throw new Error("Relay tutorial send requires --approved after the person explicitly approves both payloads.");
  const config = readConfig();
  const tutorial = config.tutorial || {};
  if (["skipped_self", "skipped"].includes(tutorial.state)) return { ok: true, status: tutorial.state };
  if (tutorial.state === "accepted" && tutorial.relayId) {
    return { ok: true, status: "already_accepted", relayId: tutorial.relayId, state: tutorial.responseState || "" };
  }
  const org = config.org ? requiredOrgIdentity(config.org) : undefined;
  const inviter = org ? undefined : requiredRelayIdentity(config.inviter, "inviter");
  const key = String(tutorial.idempotencyKey || "");
  if (key.length < 8) throw new Error("Relay tutorial state is missing its stable idempotency key. Connect again.");
  if (draft && (typeof draft.forHuman !== "string" || !draft.forHuman.trim()
    || typeof draft.forAgent !== "string" || !draft.forAgent.trim()
    || Object.keys(draft).some((key) => !["forHuman", "forAgent"].includes(key)))) {
    throw new Error("The tutorial draft must contain only the two approved, non-empty forHuman and forAgent fields.");
  }
  const proposed = {
    recipient: org ? { groupId: org.groupId } : { relayUserId: inviter.relayUserId },
    kind: "message",
    forHuman: draft?.forHuman ?? (org ? "Hi everyone — I’ve just joined our organisation on Relay." : TUTORIAL_HUMAN),
    forAgent: draft?.forAgent ?? (org ? "This is my first Relay after joining our organisation group. Help the people in the group reply if they want to welcome me." : TUTORIAL_AGENT),
    idempotencyKey: key,
  };
  if (tutorial.payload && draft && JSON.stringify(proposed) !== JSON.stringify(tutorial.payload)) {
    throw new Error("This tutorial send was already attempted. Retry its exact approved payload; do not change it after an uncertain result.");
  }
  // Older attempts used the fixed hello. Preserve that payload across upgrades.
  if (!tutorial.payload && ["attempting", "rejected"].includes(tutorial.state) && draft
    && (draft.forHuman !== TUTORIAL_HUMAN || draft.forAgent !== TUTORIAL_AGENT)) {
    throw new Error("Retry the original tutorial hello without changing its payload.");
  }
  const body = tutorial.payload || proposed;
  config.tutorial = { ...tutorial, payload: body, recipient: body.recipient, state: "attempting", updatedAt: new Date().toISOString() };
  atomicWrite(configPath(), config);
  try {
    const result = await request("POST", "/v1/relays", body);
    const latest = readConfig();
    latest.tutorial = {
      ...latest.tutorial,
      state: "accepted",
      relayId: String(result?.relayId || ""),
      responseState: String(result?.state || ""),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(configPath(), latest);
    return result;
  } catch (error) {
    if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
      const latest = readConfig();
      latest.tutorial = { ...latest.tutorial, state: "rejected", updatedAt: new Date().toISOString() };
      atomicWrite(configPath(), latest);
    }
    throw error;
  }
}

// The tutorial's second half (2026-09-13): a Relay for someone who is not on
// Relay. Like the hello, the approved draft and one idempotency key are frozen
// before the mint, so an uncertain result is retried with the identical body
// and nothing is minted twice. The result carries the url and shareText: the
// person's own message, then the one sentence the recipient needs.
const SHARE_DRAFT_FIELDS = ["recipientName", "title", "forHuman", "forAgent", "kind"];
async function shareLinkTutorial(rest) {
  const config = readConfig();
  const tutorial = config.tutorial || {};
  const share = tutorial.share || {};
  const now = () => new Date().toISOString();
  if (rest.includes("--skip")) {
    if (["attempting", "minted"].includes(share.state)) throw new Error("The first link was already attempted. Check its outcome before skipping.");
    config.tutorial = { ...tutorial, share: { ...share, state: "skipped", updatedAt: now() } };
    atomicWrite(configPath(), config);
    return { ok: true, status: "skipped" };
  }
  if (share.state === "skipped") return { ok: true, status: "skipped" };
  if (share.state === "minted" && share.url) {
    return { ok: true, status: "already_minted", relayId: share.relayId || "", url: share.url, shareText: share.shareText || "" };
  }
  if (!rest.includes("--approved")) throw new Error("Relay's first link requires --approved after the person explicitly approves the exact draft.");
  const draft = rest.includes("--draft-stdin") ? parseJson(await readStdin(), "Relay link draft") : null;
  if (draft && (typeof draft !== "object" || Array.isArray(draft) || typeof draft.forHuman !== "string" || !draft.forHuman.trim()
    || Object.keys(draft).some((key) => !SHARE_DRAFT_FIELDS.includes(key))
    || Object.entries(draft).some(([key, value]) => key !== "forHuman" && typeof value !== "string"))) {
    throw new Error("The link draft must contain the approved non-empty forHuman and only recipientName, title, forAgent or kind besides it.");
  }
  if (!draft && !share.payload) throw new Error("Relay's first link needs the approved draft: pass --draft-stdin with its JSON.");
  const key = String(share.idempotencyKey || "").length >= 8 ? share.idempotencyKey : randomUUID();
  const proposed = draft ? { ...draft, idempotencyKey: key } : null;
  if (share.payload && proposed && JSON.stringify(proposed) !== JSON.stringify(share.payload)) {
    throw new Error("This first link was already attempted. Retry its exact approved draft; do not change it after an uncertain result.");
  }
  const body = share.payload || proposed;
  config.tutorial = { ...tutorial, share: { ...share, idempotencyKey: key, payload: body, state: "attempting", updatedAt: now() } };
  atomicWrite(configPath(), config);
  try {
    const result = await request("POST", "/v1/share-links", body);
    const latest = readConfig();
    latest.tutorial = { ...latest.tutorial, share: {
      ...latest.tutorial?.share, state: "minted",
      relayId: String(result?.relayId || ""), url: String(result?.url || ""), shareText: String(result?.shareText || ""), updatedAt: now(),
    } };
    atomicWrite(configPath(), latest);
    return result;
  } catch (error) {
    if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
      const latest = readConfig();
      latest.tutorial = { ...latest.tutorial, share: { ...latest.tutorial?.share, state: "rejected", updatedAt: now() } };
      atomicWrite(configPath(), latest);
    }
    throw error;
  }
}

const stringField = { type: "string", minLength: 1 };
const idField = { type: "string", pattern: "^[A-Za-z0-9_-]+$" };
function directTool(description, properties, required = [], { full = false, readOnly = true } = {}) {
  return { description, inputSchema: { type: "object", properties, required, additionalProperties: false }, full, readOnly };
}
// This is a bounded client adapter for the existing scoped HTTP routes, not a
// new authorization surface. The server still checks every operation and grant.
const DIRECT_TOOLS = {
  relay_contacts_search: directTool("Search this account's contacts. Resolve recipients before sending.", { query: stringField }, ["query"]),
  relay_groups_list: directTool("List this account's existing channels.", {}, [], { full: true }),
  relay_chats_list: directTool("List this account's conversations without changing read state.", {}, [], { full: true }),
  relay_chat_fetch: directTool("Read a page of one chat without receipts. Defaults to the newest 25, oldest first. HTTPS requires chatId. Continue with nextBeforeCursor or nextAfterCursor; a page is not the full history.", { chatId: idField, limit: { type: "integer", minimum: 1, maximum: 200 }, beforeCursor: { type: "string" }, afterCursor: { type: "string" } }, ["chatId"], { full: true }),
  relay_thread_fetch: directTool("Read related Relays by their internal threadId without receipts.", { threadId: idField }, ["threadId"]),
  relay_inbox_list: directTool("Read recent inbox metadata, or up to 20 exact Relay packet envelopes in items [{relayId, ...response}]. Does not send receipts. Todo queries require Companion.", { relayIds: { type: "array", items: idField, minItems: 1, maxItems: 20 } }),
  relay_share_stats: directTool("Read owner-only share statistics. Separates legacy opens, estimated external browsers, button attempts, successful copies, agent fetches and account outcomes. Does not mark read. Browser estimates are not people; owner/test events are excluded. Optional from/to are ISO timestamps.", {"relayId": {"type": "string", "minLength": 1}, "from": {"type": "string"}, "to": {"type": "string"}}, ["relayId"], { full: true, readOnly: true }),
  relay_share_placement: directTool("Create an attributed URL for an existing share link. This sends nothing. Use separate placements for X replies and internal previews; test=true excludes that placement from acquisition. Reuse the same idempotency key on retries.", {"relayId": {"type": "string", "minLength": 1}, "idempotencyKey": {"type": "string", "minLength": 8}, "label": {"type": "string", "maxLength": 120}, "source": {"type": "string", "enum": ["x", "relay", "internal", "other"]}, "postId": {"type": "string", "pattern": "^[0-9]{1,30}$"}, "test": {"type": "boolean"}}, ["relayId", "idempotencyKey", "label", "source"], { full: true, readOnly: false }),
  relay_share_snapshot: directTool("Save a manually observed X analytics snapshot for an X placement. Keep X aggregate impressions and link clicks separate from Relay visits; never infer unique people or subtract guessed self clicks.", {"relayId": {"type": "string", "minLength": 1}, "placementId": {"type": "string"}, "observedAt": {"type": "string"}, "impressions": {"type": "integer", "minimum": 0}, "linkClicks": {"type": "integer", "minimum": 0}}, ["relayId", "placementId", "observedAt", "impressions", "linkClicks"], { full: true, readOnly: false }),
  relay_sent_list: directTool("Read sent history. Optional recipient matches a name or address.", { recipient: stringField, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  relay_mark_read: directTool("Send a read receipt only when the person requested reading this exact Relay and you present it.", { relayId: idField, idempotencyKey: stringField }, ["relayId", "idempotencyKey"], { readOnly: false }),
  relay_send: directTool("Send authorized correspondence or a Task using a resolved recipient, a title and both documents. Preserve the exact body and idempotency key on retry. HTTPS cannot send to unresolved names or email addresses; resolve an existing contact first or mint a link.", {
    recipient: { type: "object", properties: { contactId: idField, relayUserId: idField, groupId: idField, chatId: idField, self: { type: "boolean" } }, additionalProperties: false },
    kind: { type: "string", enum: ["message", "task"] }, title: stringField, forHuman: stringField, forAgent: stringField,
    idempotencyKey: { type: "string", minLength: 8 }, replyToRelayId: idField, repo: stringField,
    nature: { anyOf: [{ type: "string" }, { type: "array", items: stringField }] }, asks: { type: "array", items: stringField },
    files: { type: "array", items: stringField }, attachments: { type: "array", items: { type: "object" } }, longForHumanConfirmed: { type: "boolean" },
  }, ["recipient", "kind", "title", "forHuman", "forAgent", "idempotencyKey"], { full: true, readOnly: false }),
  relay_forward: directTool("Forward an exact Relay only when asked. The server copies its documents and attachments; note is the person's own message.", { relayId: idField, recipient: { type: "object" }, note: stringField, idempotencyKey: { type: "string", minLength: 8 } }, ["relayId", "recipient", "idempotencyKey"], { full: true, readOnly: false }),
  relay_message_edit: directTool("Edit the human message, the agent document, or both on a message this person sent, when they ask for the change. Sender-only; only ordinary messages can be edited; one published at a share link keeps its url and the page shows the new text. Every recipient sees the edit and it counts as unread for them again. Omit a field to leave it unchanged; an empty forAgent removes the agent document. A group message is updated for every recipient at once.", {
    relayId: idField, forHuman: stringField, forAgent: { type: "string" }, expectedUpdatedAt: stringField,
    nature: { anyOf: [{ type: "string" }, { type: "array", items: stringField }] }, asks: { type: "array", items: stringField },
    idempotencyKey: { type: "string", minLength: 8 }, longForHumanConfirmed: { type: "boolean" },
  }, ["relayId", "idempotencyKey"], { full: true, readOnly: false }),
  relay_message_delete: directTool("Delete for everyone a message this person sent, leaving a durable 'Message deleted' tombstone. Sender-only; only ordinary messages can be deleted. Use only when the person explicitly asks to delete the sent message.", {
    relayId: idField, expectedUpdatedAt: stringField, idempotencyKey: { type: "string", minLength: 8 },
  }, ["relayId", "idempotencyKey"], { full: true, readOnly: false }),
  relay_share_link: directTool("Mint an authorized Relay as a link for the person to paste; nothing is delivered or emailed. Revoke only the exact relayId of a link the person asked to revoke. Guests can reply using their existing HTTP tools without installing this helper.", {
    action: { type: "string", enum: ["mint", "revoke"] }, relayId: idField,
    kind: { type: "string", enum: ["message", "task"] }, title: stringField, recipientName: stringField, forHuman: stringField, forAgent: { type: "string" }, repo: stringField,
    files: { type: "array", items: stringField }, idempotencyKey: { type: "string", minLength: 8 }, longForHumanConfirmed: { type: "boolean" },
    nature: { anyOf: [{ type: "string" }, { type: "array", items: stringField }] }, asks: { type: "array", items: stringField },
  }, ["idempotencyKey"], { full: true, readOnly: false }),
};

function validateDirectArguments(args, schema, label = "arguments") {
  if (schema.anyOf) {
    if (!schema.anyOf.some((candidate) => { try { validateDirectArguments(args, candidate, label); return true; } catch { return false; } })) throw new Error(`Invalid ${label}.`);
    return;
  }
  const matches = schema.type === "array" ? Array.isArray(args) : schema.type === "integer" ? Number.isInteger(args)
    : schema.type === "object" ? args !== null && typeof args === "object" && !Array.isArray(args) : typeof args === schema.type;
  if (!matches || (schema.enum && !schema.enum.includes(args))) throw new Error(`Invalid ${label}.`);
  if (schema.type === "object") {
    for (const field of schema.required || []) if (!Object.hasOwn(args, field)) throw new Error(`${label}.${field} is required.`);
    for (const [key, value] of Object.entries(args)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, key)) throw new Error(`${label}.${key} is not supported over direct HTTPS. Run tools for its scoped schema.`);
      if (schema.properties?.[key]) validateDirectArguments(value, schema.properties[key], `${label}.${key}`);
    }
  }
  if (schema.type === "array") {
    if (args.length < (schema.minItems ?? 0) || args.length > (schema.maxItems ?? Infinity)) throw new Error(`Invalid ${label} length.`);
    for (const item of args) validateDirectArguments(item, schema.items, label);
  }
  if (schema.type === "string" && (args.trim().length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(args)))) throw new Error(`Invalid ${label}.`);
  if (schema.type === "integer" && (args < (schema.minimum ?? -Infinity) || args > (schema.maximum ?? Infinity))) throw new Error(`Invalid ${label}.`);
}

async function directToolCommand(command, body, config) {
  transport = "https";
  // Explicit HTTPS verifies the independent credential and account. It never
  // consults the local descriptor, including on validation or renewal failure.
  await request("GET", "/v1/me");
  const names = Object.keys(DIRECT_TOOLS).filter((name) => !DIRECT_TOOLS[name].full || (config.consentVersion ?? 1) >= 2);
  if (command === "tools") return {
    transport: "https", apiUrl: config.apiUrl, account: config.account, scope: "browser-approved member",
    serverAuthorizationRequired: true,
    tools: names.map((name) => ({ name, description: DIRECT_TOOLS[name].description, inputSchema: DIRECT_TOOLS[name].inputSchema })),
    limitations: "Scoped messaging only. Use request for the remaining allowlisted HTTP routes. Topics, connectors, device queues and native sessions require Companion. Guest conversation keys use their link's HTTP instructions, not this member credential.",
  };
  const { name, arguments: args } = body;
  if (!names.includes(name)) throw new Error(`${name} is unavailable over direct HTTPS for this authorization. Run tools for the scoped catalog; broader operations require Companion.`);
  validateDirectArguments(args, DIRECT_TOOLS[name].inputSchema);
  let value;
  if (name === "relay_contacts_search") value = await request("GET", `/v1/contacts/search?q=${encodeURIComponent(args.query)}`);
  else if (name === "relay_groups_list") value = await request("GET", "/v1/contact-groups");
  else if (name === "relay_chats_list") value = await request("GET", "/v1/chats");
  else if (name === "relay_chat_fetch") {
    if (args.beforeCursor && args.afterCursor) throw new Error("Pass beforeCursor or afterCursor, not both.");
    const page = new URLSearchParams({ surface: "relay", limit: String(args.limit ?? 25) });
    for (const key of ["beforeCursor", "afterCursor"]) if (args[key]) page.set(key, args[key]);
    value = await request("GET", `/v1/chats/${encodeURIComponent(args.chatId)}?${page}`);
  }
  else if (name === "relay_thread_fetch") value = await request("GET", `/v1/threads/${args.threadId}`);
  else if (name === "relay_inbox_list") {
    if (args.relayIds) {
      const items = [];
      for (const relayId of new Set(args.relayIds)) items.push({ relayId, ...await request("GET", `/v1/relays/${relayId}`) });
      value = { items, readStateChanged: false, readReceiptsSent: false };
    } else value = await request("GET", "/v1/inbox?view=summary");
  } else if (name === "relay_share_stats") {
    const query = new URLSearchParams(Object.entries({ from: args.from, to: args.to }).filter(([, v]) => v !== undefined));
    value = await request("GET", `/v1/share-links/${encodeURIComponent(args.relayId)}/stats?${query}`);
  } else if (name === "relay_share_placement") {
    const { relayId, ...body } = args;
    value = await request("POST", `/v1/share-links/${encodeURIComponent(relayId)}/placements`, body);
  } else if (name === "relay_share_snapshot") {
    const { relayId, placementId, ...body } = args;
    value = await request("PUT", `/v1/share-links/${encodeURIComponent(relayId)}/placements/${encodeURIComponent(placementId)}/snapshot`, body);
  } else if (name === "relay_sent_list") {
    const result = await request("GET", "/v1/sent?limit=100");
    const needle = String(args.recipient || "").toLowerCase();
    const matched = (result.items || []).filter((item) => !needle || [item.recipient?.name, item.recipient?.email, item.recipientGroupName].filter(Boolean).join(" ").toLowerCase().includes(needle));
    value = { ...result, items: matched.slice(0, args.limit || 20), recipientFilter: args.recipient, searchedRecentLimit: 100 };
  }
  else if (name === "relay_mark_read") value = await request("POST", `/v1/relays/${args.relayId}/read`, { idempotencyKey: args.idempotencyKey });
  else if (name === "relay_send") {
    const { replyToRelayId, ...draft } = args;
    value = await sendPersisted({ ...draft, ...(replyToRelayId ? { inReplyToRelayId: replyToRelayId } : {}) });
  }
  else if (name === "relay_forward") {
    const { relayId, ...forward } = args;
    value = await request("POST", `/v1/relays/${relayId}/forward`, forward);
  } else if (name === "relay_message_edit") {
    const { relayId, longForHumanConfirmed, ...edit } = args;
    if (edit.forHuman === undefined && edit.forAgent === undefined && edit.nature === undefined && edit.asks === undefined) throw new Error("Editing a message requires forHuman, forAgent, nature or asks.");
    value = await request("PATCH", `/v1/messages/${relayId}`, edit);
  } else if (name === "relay_message_delete") {
    const { relayId, ...remove } = args;
    value = await request("DELETE", `/v1/messages/${relayId}`, remove);
  } else if (name === "relay_share_link") {
    const { action = "mint", relayId, ...draft } = args;
    if (action === "revoke") {
      if (!relayId) throw new Error("Revoking a share link requires its exact relayId.");
      if (Object.keys(draft).some((key) => key !== "idempotencyKey")) throw new Error("Revocation accepts only action, relayId and idempotencyKey.");
      value = await request("DELETE", `/v1/share-links/${relayId}`);
    } else {
      if (!draft.forHuman || relayId) throw new Error("Minting a share link requires forHuman and no relayId.");
      value = await request("POST", "/v1/share-links", await prepareSendBody(draft));
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0]?.startsWith("--transport=")) transport = argv.shift().slice("--transport=".length);
  else transport = process.env.RELAY_AGENT_TRANSPORT || "auto";
  if (!["auto", "https", "local"].includes(transport)) throw new Error("Choose --transport=auto, --transport=https or --transport=local before the command.");
  const [command, ...rest] = argv;
  if (command === "connect-start") return connectStart(rest[0], rest[1], rest[2]);
  if (command === "connect-finish") return connectFinish();
  if (command === "disconnect") {
    fs.rmSync(configPath(), { force: true });
    return { ok: true, disconnected: true };
  }
  if (command === "status") {
    try {
      const config = readConfig();
      const me = await request("GET", "/v1/me");
      if (me.user?.id !== config.account?.relayUserId) throw new Error("Relay returned a different account. Connection is unverified.");
      return { ok: true, connected: true, transport: lastTransport, apiUrl: config.apiUrl, account: config.account || {}, inviter: config.inviter, org: config.org, invite: config.invite, tutorial: config.tutorial, lastSend: config.lastSend, expiresAt: config.expiresAt || "", independentAuthorizationSaved: config.accessToken.startsWith("web_") };
    } catch (error) {
      process.exitCode = 1;
      return { ok: false, connected: false, transport: transport === "auto" ? lastTransport || "unresolved" : transport, error: error.code || "connection_unverified", message: error.message, ...(error.status ? { status: error.status } : {}) };
    }
  }
  if (command === "groups") return request("GET", "/v1/contact-groups");
  if (command === "tools" || command === "call") {
    const config = readConfig();
    const local = transport === "https" ? null : readLocalDescriptor();
    const companion = companionAvailability(config, local);
    if (companion.status === "other_account") throw new Error(companion.message);
    if (command === "call" && !rest[0]) throw new Error("call requires an exact tool name from tools; pass its JSON arguments on stdin.");
    const body = command === "call" ? { name: rest[0], arguments: parseJson(await readStdin() || "{}", "Tool arguments") } : undefined;
    if (companion.status !== "ready" || local.toolCatalogVersion !== 1) {
      if (transport === "local") throw new Error("The complete tool catalog requires an updated, matching Relay Companion.");
      return directToolCommand(command, body, config);
    }
    const target = currentSkillTarget(process.env);
    const host = process.env.CODEX_THREAD_ID ? "codex" : process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID ? "claude_code" : target?.host === "codex" ? "codex" : target?.host === "claude" ? "claude_code" : "";
    const caller = { cwd: process.cwd(), host, nativeId: host === "codex" ? process.env.CODEX_THREAD_ID || "" : process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "" };
    try {
      const result = await localRequest(local, { method: command === "tools" ? "GET" : "POST", path: command === "tools" ? "/local/tools" : "/local/tools/call", body, caller, accountId: config.account.relayUserId }, { timeoutMs: LOCAL_TOOL_TIMEOUT_MS });
      if (result?.isError) process.exitCode = 1;
      return result;
    } catch (error) {
      // Tool handlers can perform several writes. Never replay a dispatched
      // mutation through a different handler, even when an argument has a key.
      const readOnly = command === "tools" || DIRECT_TOOLS[body?.name]?.readOnly;
      if (transport === "local" || !localUnavailable(error) || (error.possiblySent && !readOnly)) throw error;
      return directToolCommand(command, body, config);
    }
  }
  if (command === "chats") return request("GET", "/v1/chats");
  if (command === "chat") return request("GET", `/v1/chats/${encodeURIComponent(rest[0] || "")}`);
  if (command === "thread") return request("GET", `/v1/threads/${encodeURIComponent(rest[0] || "")}`);
  if (command === "destinations" || command === "deliver" || command === "outbox") {
    if (transport === "https") throw new Error("Local destinations, delivery and the device outbox require Companion; they are unavailable over direct HTTPS.");
    const config = readConfig();
    const local = readLocalDescriptor();
    const companion = companionAvailability(config, local);
    if (companion.status === "absent") throw new Error("Local agent targeting requires Companion connected to this Relay account.");
    if (companion.status !== "ready") throw new Error(`${companion.message} Local agent targeting requires Companion on the approved account and environment.`);
    const retry = command === "outbox" && rest[0] === "retry";
    if (retry && !rest[1]) throw new Error("outbox retry requires the original idempotency key.");
    const body = command === "deliver" ? parseJson(await readStdin()) : retry ? { idempotencyKey: rest[1] } : undefined;
    return localRequest(local, { method: command === "deliver" || retry ? "POST" : "GET", path: command === "deliver" ? "/local/deliver" : retry ? "/local/outbox/retry" : command === "outbox" ? "/local/outbox" : `/local/destinations/${rest[0] || ""}`, body, accountId: config.account.relayUserId });
  }
  if (command === "wait-reply") {
    if (!rest[0]) throw new Error("wait-reply requires the sent Relay id.");
    const seconds = rest[1] === undefined ? 30 : Number(rest[1]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 45) throw new Error("Choose a wait of 0 to 45 seconds.");
    const sentList = await request("GET", "/v1/sent");
    const sent = (sentList.items || []).find((item) => (item.id || item.relayId) === rest[0]);
    if (!sent) throw new Error("That send is not in the recent sent list. Open its conversation to check for replies.");
    const threadId = sent.threadId || rest[0];
    const thread = await request("GET", `/v1/threads/${encodeURIComponent(threadId)}`);
    const chatId = thread.chatId || thread.chat?.id;
    const deadline = Date.now() + seconds * 1000;
    do {
      const result = chatId
        ? await request("GET", `/v1/chats/${encodeURIComponent(chatId)}`)
        : await request("GET", `/v1/threads/${encodeURIComponent(threadId)}`);
      const replies = (result.items || result.relays || result.chat?.items || []).filter((item) =>
        item.direction === "inbound" && Date.parse(item.createdAt) >= Date.parse(sent.createdAt));
      if (replies.length) return { status: "reply_available", items: replies };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, deadline - Date.now())));
    } while (true);
    return { status: "no_reply_yet", message: "No reply in this check. No ongoing monitoring was scheduled." };
  }
  if (command === "attachment") return request("GET", `/v1/relays/${encodeURIComponent(rest[0] || "")}/attachments/${encodeURIComponent(rest[1] || "")}/download-url`);
  if (command === "inbox") return request("GET", "/v1/inbox");
  if (command === "sent") return request("GET", "/v1/sent");
  if (command === "contacts") return request("GET", `/v1/contacts/search?q=${encodeURIComponent(rest.join(" "))}`);
  if (command === "invite-link") {
    try { return await request("POST", "/v1/invite-link", {}); }
    catch (error) {
      if (![404, 405].includes(Number(error?.status))) throw error;
      return request("POST", "/v1/invites-v2/link", {});
    }
  }
  if (command === "read") {
    if (!rest[0]) throw new Error("Relay read requires a relay id.");
    return request("GET", `/v1/relays/${encodeURIComponent(rest[0])}`);
  }
  if (command === "mark-read") {
    if (!rest[0]) throw new Error("Relay mark-read requires a relay id.");
    return request("POST", `/v1/relays/${encodeURIComponent(rest[0])}/read`, { idempotencyKey: rest[1] || randomUUID() });
  }
  if (command === "send") {
    const body = parseJson(await readStdin(), "Relay message");
    return sendPersisted(body);
  }
  if (command === "forward") {
    if (!rest[0]) throw new Error("Relay forward requires the exact id of the relay to forward.");
    const body = parseJson(await readStdin(), "Relay forward");
    if (!body?.recipient) throw new Error("Relay forward requires a recipient in the JSON body.");
    if (String(body.idempotencyKey || "").length < 8) throw new Error("Relay forward requires an idempotencyKey of at least 8 characters.");
    return request("POST", `/v1/relays/${encodeURIComponent(rest[0])}/forward`, body);
  }
  if (command === "tutorial-send") return sendTutorial(rest.includes("--approved"), rest.includes("--draft-stdin") ? parseJson(await readStdin()) : undefined);
  if (command === "share-link") return shareLinkTutorial(rest);
  if (command === "tutorial-skip") {
    const config = readConfig();
    if (["attempting", "accepted"].includes(config.tutorial?.state)) throw new Error("The first Relay was already attempted. Check its outcome before skipping.");
    config.tutorial = { ...config.tutorial, state: "skipped", updatedAt: new Date().toISOString() };
    atomicWrite(configPath(), config);
    return { ok: true, status: "skipped" };
  }
  if (command === "opening-preference") {
    const [surface, provider] = rest;
    if (!["desktop", "terminal", "other"].includes(surface) || (provider && !["claude", "codex"].includes(provider))) throw new Error("Choose desktop, terminal, or other; optionally name claude or codex.");
    const config = readConfig();
    config.openingPreference = { surface, ...(provider ? { provider } : {}) };
    atomicWrite(configPath(), config);
    return { ok: true, openingPreference: config.openingPreference };
  }
  if (command === "request") {
    const method = String(rest.shift() || "GET").toUpperCase();
    const requestPath = String(rest.shift() || "");
    const body = method === "GET" ? undefined : parseJson(await readStdin() || "{}", "Relay request body");
    if (method === "POST" && requestPath === "/v1/relays") return sendPersisted(body);
    return request(method, requestPath, body);
  }
  return {
    usage: [
      "relay-protocol connect-start <api-origin> <invite-token> claude_code|codex",
      "relay-protocol connect-finish   # run after approving the returned browser URL",
      "relay-protocol [--transport=auto|https|local] <command> # https never reads or contacts Companion",
      "relay-protocol --transport=https status # live check of browser-approved identity and API reachability",
      "relay-protocol tools            # current transport's catalog; HTTPS covers scoped messaging only",
      "relay-protocol call <tool-name> # JSON arguments on stdin; discover the transport-specific schema with tools",
      "relay-protocol inbox | sent | groups | chats | outbox",
      "relay-protocol outbox retry <original-idempotency-key>",
      "relay-protocol wait-reply <sent-relay-id> [seconds:0-45]",
      "relay-protocol chat <id> | thread <id> | attachment <relay-id> <attachment-id>",
      "relay-protocol destinations claude|codex | deliver # JSON exact relayId and target, approved:true",
      "relay-protocol contacts <name-or-email>",
      "relay-protocol read <relay-id>",
      "relay-protocol mark-read <relay-id> [idempotency-key]",
      "relay-protocol tutorial-send --approved [--draft-stdin] # optional JSON: exact approved forHuman and forAgent",
      "relay-protocol tutorial-skip",
      "relay-protocol share-link --approved --draft-stdin # JSON: exact approved forHuman, optional recipientName, title, forAgent; returns url and shareText, minted once",
      "relay-protocol share-link --skip",
      "relay-protocol opening-preference desktop|terminal|other [claude|codex]",
      "relay-protocol send             # read body with stable idempotencyKey from stdin",
      "relay-protocol forward <relay-id> # JSON on stdin: exact recipient, optional note, stable idempotencyKey; the server copies the original",
      "relay-protocol invite-link",
      "relay-protocol disconnect",
    ],
  };
}

export { allowed, authenticatedRequest, readConfig, configPath, atomicWrite, protectOwnerOnly };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}

}
