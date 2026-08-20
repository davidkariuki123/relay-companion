import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import atomicJson from "./atomic-json.cjs";
import { persistPairedAccount } from "./account.js";
import { apiUrl, configPath, DEFAULT_WEB_URL, readConfig } from "./config.js";

const { atomicWriteJsonSync } = atomicJson;
const { writeCredential, readCredential, deleteCredential } = createRequire(import.meta.url)("./credential-store.cjs");

export const INSTALLATION_AUTHORIZATION_FILE = "installation-authorization.json";
export const INSTALLATION_CREDENTIAL_SERVICE = "work.relay.companion.installation";
export const INSTALLATION_CREDENTIAL_ACCOUNT = "authorization";
const AUTHORIZATION_STATUSES = new Set([
  "pending_identity",
  "pending_approval",
  "approved",
  "consumed",
  "expired",
]);
const ACTIVE_STATUSES = new Set(["pending_identity", "pending_approval", "approved"]);
const REQUEST_TIMEOUT_MS = 20_000;

function statePath() {
  return path.join(path.dirname(configPath()), INSTALLATION_AUTHORIZATION_FILE);
}

function defaultStateStore(file = statePath()) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new Error("Relay setup state could not be read. Cancel setup and start again.");
      }
    },
    write(value) {
      atomicWriteJsonSync(file, value, { mode: 0o600 });
    },
    remove() {
      try { fs.rmSync(file, { force: true }); } catch (error) {
        throw new Error(`Relay setup state could not be removed (${error?.code || "filesystem error"}).`);
      }
    },
  };
}

function defaultSecretStore() {
  const options = {
    service: INSTALLATION_CREDENTIAL_SERVICE,
    account: INSTALLATION_CREDENTIAL_ACCOUNT,
  };
  return {
    write(value) { return writeCredential(JSON.stringify(value), options); },
    read() {
      const result = readCredential(options);
      if (!result.ok) return result;
      try { return { ok: true, value: JSON.parse(result.value) }; }
      catch { return { ok: false, detail: "stored authorization is invalid" }; }
    },
    delete() { return deleteCredential(options); },
  };
}

function validDate(value) {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
}

function accountSummary(value) {
  if (!value || typeof value !== "object") return undefined;
  const email = String(value.email || "").trim();
  const displayName = String(value.displayName || value.name || email).trim();
  if (!email || !displayName) return undefined;
  return { email, displayName };
}

function validateDurableState(value) {
  if (!value || typeof value !== "object") return null;
  const authorizationId = String(value.authorizationId || "");
  const expiresAt = validDate(value.expiresAt);
  const status = String(value.status || "");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(authorizationId) || !expiresAt || !AUTHORIZATION_STATUSES.has(status)) {
    throw new Error("Relay setup state is invalid. Cancel setup and start again.");
  }
  return {
    schemaVersion: 1,
    authorizationId,
    expiresAt,
    status,
    ...(accountSummary(value.account) ? { account: accountSummary(value.account) } : {}),
  };
}

function validateSecret(value, authorizationId, trustedWebOrigin) {
  if (!value || typeof value !== "object") throw new Error("Relay setup authorization is unavailable. Cancel setup and start again.");
  const secret = {
    authorizationId: String(value.authorizationId || ""),
    clientSecret: String(value.clientSecret || ""),
    codeVerifier: String(value.codeVerifier || ""),
    activationUrl: String(value.activationUrl || ""),
  };
  if (
    secret.authorizationId !== authorizationId ||
    secret.clientSecret.length < 32 ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(secret.codeVerifier)
  ) {
    throw new Error("Relay setup authorization is unavailable. Cancel setup and start again.");
  }
  let activationUrl;
  try { activationUrl = new URL(secret.activationUrl); } catch {
    throw new Error("Relay setup authorization is unavailable. Cancel setup and start again.");
  }
  const expectedPath = `/activate/${encodeURIComponent(authorizationId)}`;
  const activationFragment = new URLSearchParams(activationUrl.hash.slice(1));
  if (
    activationUrl.origin !== trustedWebOrigin ||
    activationUrl.pathname !== expectedPath ||
    !activationFragment.get("activationToken")
  ) {
    throw new Error("Relay refused an untrusted setup destination.");
  }
  return { ...secret, activationUrl: activationUrl.toString() };
}

function publicState(state) {
  if (!state) return { status: "idle" };
  return {
    status: state.status,
    expiresAt: state.expiresAt,
    ...(accountSummary(state.account) ? { account: accountSummary(state.account) } : {}),
  };
}

function pkcePair() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

class InstallationRequestError extends Error {
  constructor(code, status) {
    super(`Relay setup request failed (${code || `HTTP ${status}`}).`);
    this.code = code || "request_failed";
    this.status = status;
  }
}

async function postJson(fetchImpl, base, route, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new InstallationRequestError("request_timeout", 0);
    throw new InstallationRequestError("network_unavailable", 0);
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const code = typeof payload?.error === "string" && /^[a-z0-9_]{1,80}$/i.test(payload.error)
      ? payload.error
      : "request_failed";
    throw new InstallationRequestError(code, response.status);
  }
  if (!payload || typeof payload !== "object") throw new InstallationRequestError("invalid_response", response.status);
  return payload;
}

function normalizeApiBase(value) {
  const parsed = new URL(String(value || ""));
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && local))) {
    throw new Error("Relay setup requires a secure API endpoint.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeWebOrigin(value) {
  const parsed = new URL(String(value || ""));
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && local))) {
    throw new Error("Relay setup requires a secure web endpoint.");
  }
  return parsed.origin;
}

export function createInstallationAuthorizationController({
  apiBase = apiUrl(),
  webBase = DEFAULT_WEB_URL,
  platform = process.platform,
  deviceName = os.hostname(),
  fetchImpl = globalThis.fetch,
  openExternal = async () => false,
  durableStore = defaultStateStore(),
  secretStore = defaultSecretStore(),
  now = () => Date.now(),
  isPaired = () => Boolean(readConfig().deviceToken),
  persistAccount = (registration) => persistPairedAccount({
    apiUrl: normalizeApiBase(apiBase),
    webUrl: webBase,
    deviceName,
    registration,
    requireNativeCredential: true,
  }),
  onConnected = async () => {},
} = {}) {
  const base = normalizeApiBase(apiBase);
  const trustedWebOrigin = normalizeWebOrigin(webBase);
  if (!fetchImpl) throw new Error("Relay setup requires HTTPS support.");
  if (platform !== "darwin" && platform !== "win32") throw new Error("Relay setup supports macOS and Windows.");
  let beginInFlight = null;
  let consumeInFlight = null;

  async function readDurable() {
    return validateDurableState(await durableStore.read());
  }

  async function readSecret(state) {
    const result = await secretStore.read();
    if (!result?.ok) throw new Error("Relay setup authorization is unavailable. Cancel setup and start again.");
    return validateSecret(result.value, state.authorizationId, trustedWebOrigin);
  }

  async function removeAuthorization({ requireSecretRemoval = true } = {}) {
    const removed = await secretStore.delete();
    if (!removed?.ok && requireSecretRemoval) {
      throw new Error("Relay could not remove the one-time setup authorization from the native credential store.");
    }
    await durableStore.remove();
  }

  async function expire(state) {
    const expired = { ...state, status: "expired" };
    await durableStore.write(expired);
    const removed = await secretStore.delete();
    if (removed?.ok) await durableStore.remove();
    return publicState(expired);
  }

  async function activeContext({ create = false } = {}) {
    let state = await readDurable();
    if (state && Date.parse(state.expiresAt) <= now()) {
      await expire(state);
      state = null;
    }
    if (!state && create) {
      await begin();
      state = await readDurable();
    }
    if (!state) throw new Error("Start Relay account setup first.");
    return { state, secret: await readSecret(state) };
  }

  async function beginInternal() {
    if (await isPaired()) throw new Error("Relay is already connected on this computer.");
    const existing = await readDurable();
    if (existing && Date.parse(existing.expiresAt) > now() && ACTIVE_STATUSES.has(existing.status)) {
      await readSecret(existing);
      return publicState(existing);
    }
    if (existing) await removeAuthorization({ requireSecretRemoval: false });

    const { codeVerifier, codeChallenge } = pkcePair();
    const created = await postJson(fetchImpl, base, "/v1/installation-authorizations", {
      deviceName: String(deviceName || "").trim() || "This computer",
      platform,
      codeChallenge,
      codeChallengeMethod: "S256",
    });
    const authorizationId = String(created.authorizationId || "");
    const clientSecret = String(created.clientSecret || "");
    const activationUrl = String(created.activationUrl || "");
    const expiresAt = validDate(created.expiresAt);
    const state = validateDurableState({ authorizationId, expiresAt, status: "pending_identity" });
    validateSecret({ authorizationId, clientSecret, codeVerifier, activationUrl }, authorizationId, trustedWebOrigin);

    const stored = await secretStore.write({ authorizationId, clientSecret, codeVerifier, activationUrl });
    if (!stored?.ok) throw new Error("Relay could not protect the one-time setup authorization in the native credential store.");
    try {
      await durableStore.write(state);
    } catch (error) {
      try { await secretStore.delete(); } catch {}
      throw error;
    }
    return publicState(state);
  }

  function begin() {
    if (!beginInFlight) {
      beginInFlight = beginInternal().finally(() => { beginInFlight = null; });
    }
    return beginInFlight;
  }

  async function state() {
    const durable = await readDurable();
    if (!durable) return { status: "idle" };
    if (Date.parse(durable.expiresAt) <= now()) return expire(durable);
    if (durable.status === "consumed" || durable.status === "expired") return publicState(durable);
    const secret = await readSecret(durable);
    let remote;
    try {
      remote = await postJson(
        fetchImpl,
        base,
        `/v1/installation-authorizations/${encodeURIComponent(durable.authorizationId)}/status`,
        { clientSecret: secret.clientSecret },
      );
    } catch (error) {
      if (error?.code === "authorization_expired") return expire(durable);
      throw error;
    }
    const status = String(remote.status || "");
    const expiresAt = validDate(remote.expiresAt);
    if (!AUTHORIZATION_STATUSES.has(status) || !expiresAt) throw new InstallationRequestError("invalid_response", 200);
    const next = {
      ...durable,
      status,
      expiresAt,
      ...(accountSummary(remote.account) ? { account: accountSummary(remote.account) } : {}),
    };
    await durableStore.write(next);
    if (status === "expired") return expire(next);
    return publicState(next);
  }

  async function google({ forceAccountSelection = false } = {}) {
    const { state: durable, secret } = await activeContext({ create: true });
    const target = new URL(secret.activationUrl);
    if (forceAccountSelection) {
      const fragment = new URLSearchParams(target.hash.slice(1));
      fragment.set("switchAccount", "1");
      target.hash = fragment.toString();
    }
    const opened = await openExternal(target.toString());
    if (opened === false) throw new Error("Relay could not open the secure sign-in page.");
    return publicState(durable);
  }

  async function emailStart(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
      throw new Error("Enter a valid email address.");
    }
    const { state: durable, secret } = await activeContext({ create: true });
    const response = await postJson(
      fetchImpl,
      base,
      `/v1/installation-authorizations/${encodeURIComponent(durable.authorizationId)}/identity/email/start`,
      { clientSecret: secret.clientSecret, email: normalized },
    );
    if (response.status !== "code_sent" || !validDate(response.codeExpiresAt)) {
      throw new InstallationRequestError("invalid_response", 200);
    }
    return { status: "code_sent", codeExpiresAt: validDate(response.codeExpiresAt) };
  }

  async function emailVerify(code) {
    const normalized = String(code || "").trim();
    if (!/^\d{6}$/.test(normalized)) throw new Error("Enter the 6-digit code.");
    const { state: durable, secret } = await activeContext();
    const response = await postJson(
      fetchImpl,
      base,
      `/v1/installation-authorizations/${encodeURIComponent(durable.authorizationId)}/identity/email/verify`,
      { clientSecret: secret.clientSecret, code: normalized },
    );
    const account = accountSummary(response.account);
    if (response.status !== "pending_approval" || !account) throw new InstallationRequestError("invalid_response", 200);
    const next = { ...durable, status: "pending_approval", account };
    await durableStore.write(next);
    return publicState(next);
  }

  async function approveAndConsume() {
    if (await isPaired()) {
      const pairedState = await readDurable();
      if (pairedState?.status === "consumed") {
        await removeAuthorization();
        return publicState(pairedState);
      }
      throw new Error("Relay is already connected on this computer.");
    }
    const { state: durable, secret } = await activeContext();
    // `consumed` can be durable without a local token when the first consume
    // response was lost after the server committed it. The API's idempotent
    // consume recovery is the only safe repair; never re-approve first because
    // that endpoint correctly rejects a consumed authorization.
    if (durable.status !== "approved" && durable.status !== "consumed") {
      const approved = await postJson(
        fetchImpl,
        base,
        `/v1/installation-authorizations/${encodeURIComponent(durable.authorizationId)}/approve`,
        { clientSecret: secret.clientSecret },
      );
      if (approved.status !== "approved") throw new InstallationRequestError("invalid_response", 200);
      durable.status = "approved";
      await durableStore.write(durable);
    }

    const registration = await postJson(
      fetchImpl,
      base,
      `/v1/installation-authorizations/${encodeURIComponent(durable.authorizationId)}/consume`,
      { clientSecret: secret.clientSecret, codeVerifier: secret.codeVerifier },
    );
    if (
      !String(registration.deviceToken || "") ||
      !String(registration.deviceId || "") ||
      !String(registration.user?.id || "") ||
      !String(registration.user?.email || "")
    ) {
      throw new InstallationRequestError("invalid_response", 200);
    }
    const connected = {
      ...durable,
      status: "consumed",
      account: {
        email: registration.user.email,
        displayName: registration.user.name || registration.user.email,
      },
    };
    // Commit the recoverable protocol state before the native account commit.
    // If this write fails the capability remains approved and consume can be
    // retried idempotently. If account persistence fails after it succeeds,
    // durable `consumed` + the PKCE secret is the recovery receipt.
    await durableStore.write(connected);
    await persistAccount(registration);
    const removed = await secretStore.delete();
    if (removed?.ok) await durableStore.remove();
    try { await onConnected(registration); } catch {}
    return publicState(connected);
  }

  function approve() {
    if (!consumeInFlight) {
      consumeInFlight = approveAndConsume().finally(() => { consumeInFlight = null; });
    }
    return consumeInFlight;
  }

  async function cancel() {
    const durable = await readDurable();
    if (!durable) return { status: "idle" };
    await removeAuthorization();
    return { status: "idle" };
  }

  return { state, begin, google, emailStart, emailVerify, approve, cancel };
}
