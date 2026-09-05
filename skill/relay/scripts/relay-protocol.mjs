#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareOrdinaryRelayAttachments } from "./relay-attachments.mjs";
import { readLocalDescriptor, localRequest } from "./relay-local.mjs";
import { spawnSync } from "node:child_process";

const DEFAULT_CONFIG = path.join(os.homedir(), ".relay", "agent-protocol.json");
const DEFAULT_PENDING = path.join(os.homedir(), ".relay", "agent-authorization.json");
const TRUSTED_RELAY_HOSTS = new Map([
  ["https://api.sendrelays.com", "https://sendrelays.com"],
  ["https://dev-api.sendrelays.com", "https://dev.sendrelays.com"],
]);
const TUTORIAL_HUMAN = "Hi — I’ve just joined you on Relay.";
const TUTORIAL_AGENT = "This is my first Relay after joining from your invite. Help the person reply if they want to welcome me.";
const SAFE_GET = [
  /^\/v1\/contact-groups$/,
  /^\/v1\/chats(?:\?.*)?$/,
  /^\/v1\/chats\/[A-Za-z0-9_-]+$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9_-]+\/download-url$/,
  /^\/v1\/me$/,
  /^\/v1\/inbox(?:\?.*)?$/,
  /^\/v1\/sent(?:\?.*)?$/,
  /^\/v1\/contacts\/search\?q=.+$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+$/,
  /^\/v1\/threads\/[A-Za-z0-9_-]+$/,
];
const SAFE_POST = [
  /^\/v1\/relays$/,
  /^\/v1\/relays\/[A-Za-z0-9_-]+\/read$/,
  /^\/v1\/invite-link$/,
  /^\/v1\/invites-v2\/link$/,
];

function configPath(env = process.env) {
  return env.RELAY_AGENT_CONFIG || DEFAULT_CONFIG;
}

function pendingPath(env = process.env) {
  return env.RELAY_AGENT_AUTHORIZATION || DEFAULT_PENDING;
}

function relayApiOrigin(value, env = process.env) {
  const parsed = new URL(String(value || ""));
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Relay requires one clean API origin.");
  }
  if (TRUSTED_RELAY_HOSTS.has(parsed.origin)) return parsed.origin;
  if (loopback && env.RELAY_AGENT_ALLOW_LOOPBACK === "1" && ["http:", "https:"].includes(parsed.protocol)) return parsed.origin;
  throw new Error("Relay requires the production or development Relay API host.");
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

function readConfig(file = configPath()) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("Relay is not connected in this agent yet. Complete the browser approval first.");
    throw new Error("Relay's agent credential file could not be read.");
  }
  const apiUrl = relayApiOrigin(value?.apiUrl);
  const accessToken = String(value?.accessToken || "");
  if (!value.local && (!accessToken.startsWith("web_") || accessToken.length < 20)) throw new Error("Relay's agent credential is invalid. Connect Relay again.");
  if (!value.local && value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) throw new Error("Relay's agent authorization expired. Connect Relay again.");
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
  const list = method === "GET" ? SAFE_GET : method === "POST" ? SAFE_POST : [];
  return list.some((pattern) => pattern.test(requestPath));
}

async function authenticatedRequest(apiUrl, accessToken, method, requestPath, body) {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Relay-Client": "relay-agent-skill",
      "X-Relay-Send-Contract": "2",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Relay returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Relay request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error || "";
    error.body = payload;
    throw error;
  }
  return payload;
}

async function request(method, requestPath, body) {
  const verb = String(method || "GET").toUpperCase();
  const cleanPath = String(requestPath || "");
  if (!cleanPath.startsWith("/") || cleanPath.startsWith("//") || !allowed(verb, cleanPath)) {
    throw new Error(`Relay agent protocol does not allow ${verb} ${cleanPath || "<missing path>"}.`);
  }
  const config = readConfig();
  const local = readLocalDescriptor();
  if (local && (config.consentVersion ?? 1) >= 2) {
    if (local.accountId !== config.account?.relayUserId || local.apiUrl !== config.apiUrl) throw new Error("Companion is connected to a different Relay account or environment. Nothing was sent or read.");
    const result = await localRequest(local, { method: verb, path: cleanPath, body, accountId: config.account.relayUserId });
    // Only retire the standalone credential after the daemon has answered as
    // the exact account. Future failures must not bypass local encryption.
    if (!config.local) { config.local = true; delete config.accessToken; atomicWrite(configPath(), config); }
    return result;
  }
  if (config.local) throw new Error("Reopen Relay Companion to use this connection. No agent restart is needed.");
  try { return await authenticatedRequest(config.apiUrl, config.accessToken, verb, cleanPath, body); }
  catch (error) {
    if (verb !== "POST" || cleanPath !== "/v1/relays" || body?.longForHumanConfirmed !== true || error.code !== "human_message_review_required" || !error.body?.reviewToken) throw error;
    return authenticatedRequest(config.apiUrl, config.accessToken, verb, cleanPath, { ...body, longForHumanReviewToken: error.body.reviewToken });
  }
}

function parseJson(value, label = "JSON body") {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is not valid JSON.`); }
}

async function publicRequest(apiUrl, requestPath, body) {
  const trustedApiUrl = relayApiOrigin(apiUrl);
  const response = await fetch(`${trustedApiUrl}${requestPath}`, {
    method: "POST",
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
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(inviteToken || ""))) throw new Error("Relay invite token is invalid.");
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
    invite: record.invite,
    tutorial: record.tutorial,
    expiresAt: record.expiresAt,
  };
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
  const inviter = requiredRelayIdentity(input.inviter, "inviter");
  // Prove which account the new bearer credential represents before persisting
  // anything or consuming the recoverable pending authorization file.
  const me = await authenticatedRequest(apiUrl, accessToken, "GET", "/v1/me");
  const own = requiredRelayIdentity(me?.user, "account", { requireName: false });
  const selfInvite = own.relayUserId === inviter.relayUserId;
  let existing = null;
  try { existing = readConfig(); } catch {}
  const sameConnection = existing?.apiUrl === apiUrl
    && existing?.account?.relayUserId === own.relayUserId
    && existing?.inviter?.relayUserId === inviter.relayUserId;
  const record = {
    version: 1,
    consentVersion: input.consentVersion ?? 1,
    apiUrl,
    accessToken,
    expiresAt: String(input.expiresAt || ""),
    account: { ...(input.account && typeof input.account === "object" ? input.account : {}), relayUserId: own.relayUserId },
    inviter,
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

async function sendTutorial(approved) {
  if (!approved) throw new Error("Relay tutorial send requires --approved after the person explicitly approves both payloads.");
  const config = readConfig();
  const tutorial = config.tutorial || {};
  if (tutorial.state === "skipped_self") return { ok: true, status: "skipped_self" };
  if (tutorial.state === "accepted" && tutorial.relayId) {
    return { ok: true, status: "already_accepted", relayId: tutorial.relayId, state: tutorial.responseState || "" };
  }
  const inviter = requiredRelayIdentity(config.inviter, "inviter");
  const key = String(tutorial.idempotencyKey || "");
  if (key.length < 8) throw new Error("Relay tutorial state is missing its stable idempotency key. Connect again.");
  config.tutorial = { ...tutorial, state: "attempting", updatedAt: new Date().toISOString() };
  atomicWrite(configPath(), config);
  const body = {
    recipient: { relayUserId: inviter.relayUserId },
    kind: "message",
    forHuman: TUTORIAL_HUMAN,
    forAgent: TUTORIAL_AGENT,
    idempotencyKey: key,
  };
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "connect-start") return connectStart(rest[0], rest[1], rest[2]);
  if (command === "connect-finish") return connectFinish();
  if (command === "disconnect") {
    fs.rmSync(configPath(), { force: true });
    return { ok: true, disconnected: true };
  }
  if (command === "status") {
    const config = readConfig();
    return { ok: true, connected: true, account: config.account || {}, inviter: config.inviter, invite: config.invite, tutorial: config.tutorial, lastSend: config.lastSend, expiresAt: config.expiresAt || "" };
  }
  if (command === "groups") return request("GET", "/v1/contact-groups");
  if (command === "chats") return request("GET", "/v1/chats");
  if (command === "chat") return request("GET", `/v1/chats/${encodeURIComponent(rest[0] || "")}`);
  if (command === "thread") return request("GET", `/v1/threads/${encodeURIComponent(rest[0] || "")}`);
  if (command === "destinations" || command === "deliver" || command === "outbox") {
    const config = readConfig();
    const local = readLocalDescriptor();
    if ((config.consentVersion ?? 1) < 2 || !local || local.accountId !== config.account?.relayUserId || local.apiUrl !== config.apiUrl) throw new Error("Local agent targeting requires Companion connected to this Relay account.");
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
  if (command === "tutorial-send") return sendTutorial(rest.includes("--approved"));
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
      "relay-protocol status",
      "relay-protocol inbox | sent | groups | chats | outbox",
      "relay-protocol outbox retry <original-idempotency-key>",
      "relay-protocol wait-reply <sent-relay-id> [seconds:0-45]",
      "relay-protocol chat <id> | thread <id> | attachment <relay-id> <attachment-id>",
      "relay-protocol destinations claude|codex | deliver # JSON exact relayId and target, approved:true",
      "relay-protocol contacts <name-or-email>",
      "relay-protocol read <relay-id>",
      "relay-protocol mark-read <relay-id> [idempotency-key]",
      "relay-protocol tutorial-send --approved",
      "relay-protocol send             # read body with stable idempotencyKey from stdin",
      "relay-protocol invite-link",
      "relay-protocol disconnect",
    ],
  };
}

export { allowed, authenticatedRequest, readConfig, configPath, atomicWrite, protectOwnerOnly };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}

}
