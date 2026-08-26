import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import atomicJson from "./atomic-json.cjs";
import { persistPairedAccount } from "./account.js";
import {
  apiUrl,
  configPath,
  CREDENTIAL_STATUS_CORRUPT,
  CREDENTIAL_STATUS_MISSING,
  CREDENTIAL_STATUS_UNAVAILABLE,
  DEFAULT_WEB_URL,
  readConfigState,
} from "./config.js";

const { atomicWriteJsonSync } = atomicJson;
const { writeCredential, readCredential, deleteCredential } = createRequire(import.meta.url)("./credential-store.cjs");

export const INSTALLATION_AUTHORIZATION_FILE = "installation-authorization.json";
export const INSTALLATION_CREDENTIAL_SERVICE = "work.relay.companion.installation";
export const INSTALLATION_CREDENTIAL_ACCOUNT = "authorization";
export const INSTALLATION_CREDENTIAL_PROBE_ACCOUNT = "availability-probe";
const INSTALLATION_CREDENTIAL_ACCOUNTS = Object.freeze({
  authorizationId: "authorization-id",
  clientSecret: "client-secret",
  codeVerifier: "code-verifier",
  activationToken: "activation-token",
});
const AUTHORIZATION_STATUSES = new Set([
  "pending_identity",
  "pending_approval",
  "approved",
  "consumed",
  "expired",
]);
const RESUMABLE_STATUSES = new Set(["pending_identity", "pending_approval", "approved", "consumed"]);
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

export function createNativeInstallationSecretStore({
  webBase = DEFAULT_WEB_URL,
  service = INSTALLATION_CREDENTIAL_SERVICE,
  writeCredentialImpl = writeCredential,
  readCredentialImpl = readCredential,
  deleteCredentialImpl = deleteCredential,
} = {}) {
  const options = (account) => ({ service, account });
  const accounts = Object.values(INSTALLATION_CREDENTIAL_ACCOUNTS);
  const sentinelAccount = INSTALLATION_CREDENTIAL_ACCOUNTS.authorizationId;
  const removeSentinelLast = (targetAccounts) => {
    const ordered = [
      ...targetAccounts.filter((account) => account !== sentinelAccount),
      ...(targetAccounts.includes(sentinelAccount) ? [sentinelAccount] : []),
    ];
    for (const account of ordered) {
      const result = deleteCredentialImpl(options(account));
      // The sentinel must remain whenever an earlier field could not be
      // removed, so a later Begin still detects the interrupted capability.
      if (!result?.ok) return result;
    }
    return { ok: true, value: "", detail: "" };
  };
  const removeAccounts = () => removeSentinelLast([...accounts, INSTALLATION_CREDENTIAL_ACCOUNT]);
  return {
    inspect() {
      // authorization-id is written first and rolled back last, so it is the
      // bounded sentinel for a complete or interrupted split-field commit.
      const current = readCredentialImpl(options(INSTALLATION_CREDENTIAL_ACCOUNTS.authorizationId));
      if (current?.ok) return { ok: true, present: true, value: "", detail: "" };
      if (current?.code !== "credential_not_found") return current;
      // Do not inspect the legacy envelope here. Without matching durable
      // state it is unusable and harmless, while touching it on a fresh start
      // would add a second Windows vault read. Durable legacy setup uses
      // read() below for its one migration.
      return { ok: true, present: false, value: "", detail: "" };
    },
    probe() {
      const probe = randomBytes(24).toString("base64url");
      const target = options(INSTALLATION_CREDENTIAL_PROBE_ACCOUNT);
      const written = writeCredentialImpl(probe, target);
      if (!written?.ok) return written;
      const verified = readCredentialImpl(target);
      const removed = deleteCredentialImpl(target);
      if (!verified?.ok) return verified;
      if (verified.value !== probe) {
        return { ok: false, value: "", detail: "credential verification failed", code: "credential_verification_failed" };
      }
      return removed?.ok ? { ok: true, value: "", detail: "" } : removed;
    },
    write(value) {
      let activationUrl;
      try { activationUrl = new URL(String(value?.activationUrl || "")); }
      catch { return { ok: false, detail: "invalid activation URL" }; }
      const activationToken = new URLSearchParams(activationUrl.hash.slice(1)).get("activationToken") || "";
      const fields = {
        authorizationId: String(value?.authorizationId || ""),
        clientSecret: String(value?.clientSecret || ""),
        codeVerifier: String(value?.codeVerifier || ""),
        activationToken,
      };
      if (Object.values(fields).some((field) => !field)) {
        return { ok: false, detail: "installation authorization is incomplete" };
      }
      const written = [];
      for (const [field, account] of Object.entries(INSTALLATION_CREDENTIAL_ACCOUNTS)) {
        const result = writeCredentialImpl(fields[field], options(account));
        if (!result?.ok) {
          removeSentinelLast(written);
          return result;
        }
        written.push(account);
      }
      deleteCredentialImpl(options(INSTALLATION_CREDENTIAL_ACCOUNT));
      return { ok: true, value: "", detail: "" };
    },
    read() {
      const values = {};
      let missing = null;
      for (const [field, account] of Object.entries(INSTALLATION_CREDENTIAL_ACCOUNTS)) {
        // These split fields have only ever existed in the local-v2 store. Do
        // not probe the legacy login Keychain for accounts no released build
        // ever wrote there. The one old envelope is handled once below.
        const result = readCredentialImpl(options(account));
        if (!result?.ok) { missing = result; break; }
        values[field] = result.value;
      }
      if (!missing) {
        const target = new URL(`/activate/${encodeURIComponent(values.authorizationId)}`, normalizeWebOrigin(webBase));
        target.hash = new URLSearchParams({ activationToken: values.activationToken }).toString();
        return { ok: true, value: {
          authorizationId: values.authorizationId,
          clientSecret: values.clientSecret,
          codeVerifier: values.codeVerifier,
          activationUrl: target.toString(),
        } };
      }
      const legacy = readCredentialImpl({ ...options(INSTALLATION_CREDENTIAL_ACCOUNT), allowLegacyMigration: true });
      if (!legacy.ok) return missing;
      try { return { ok: true, value: JSON.parse(legacy.value) }; }
      catch { return { ok: false, detail: "stored authorization is invalid" }; }
    },
    delete() { return removeAccounts(); },
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

function credentialError(message, code = "credential_store_error") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultIsPaired() {
  const { config, credential } = readConfigState();
  if ([CREDENTIAL_STATUS_UNAVAILABLE, CREDENTIAL_STATUS_MISSING, CREDENTIAL_STATUS_CORRUPT].includes(credential.status)) {
    throw credentialError(
      "Relay cannot access this computer's saved account credential. Recover the account credential before starting setup.",
      credential.code || `credential_${credential.status}`,
    );
  }
  return Boolean(process.env.RELAY_DEVICE_TOKEN || config.deviceToken);
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
  secretStore = createNativeInstallationSecretStore({ webBase }),
  now = () => Date.now(),
  isPaired = defaultIsPaired,
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
  let resumeInFlight = null;
  let operationQueue = Promise.resolve();

  // Authorization actions cross three commit boundaries (server capability,
  // protected secret storage, and durable public state). Keep those actions in
  // one local order so a poll cannot rewrite state after Cancel/Restart and a
  // second click cannot delete the capability while consume is persisting the
  // paired account.
  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  async function readDurable() {
    return validateDurableState(await durableStore.read());
  }

  async function readSecret(state) {
    const result = await secretStore.read();
    if (!result?.ok) throw new Error("Relay setup authorization is unavailable. Cancel setup and start again.");
    return validateSecret(result.value, state.authorizationId, trustedWebOrigin);
  }

  async function removeAuthorization() {
    const removed = await secretStore.delete();
    if (!removed?.ok) {
      throw new Error("Relay could not remove the one-time setup authorization from protected storage.");
    }
    await durableStore.remove();
  }

  async function expire(state) {
    const expired = { ...state, status: "expired" };
    await durableStore.write(expired);
    // Keep the public tombstone after deleting the one-time secret. It is what
    // makes replacement an explicit Restart even across a renderer/process
    // restart; it contains no capability material.
    await secretStore.delete();
    return publicState(expired);
  }

  async function activeContext({ create = false } = {}) {
    let state = await readDurable();
    if (state && Date.parse(state.expiresAt) <= now()) {
      await expire(state);
      throw new InstallationRequestError("authorization_expired", 410);
    }
    if (!state && create) {
      await beginInternal();
      state = await readDurable();
    }
    if (!state) throw new Error("Start Relay account setup first.");
    if (state.status === "expired") throw new InstallationRequestError("authorization_expired", 410);
    return { state, secret: await readSecret(state) };
  }

  async function beginInternal() {
    if (await isPaired()) throw new Error("Relay is already connected on this computer.");
    const existing = await readDurable();
    if (existing && Date.parse(existing.expiresAt) > now() && RESUMABLE_STATUSES.has(existing.status)) {
      await readSecret(existing);
      return publicState(existing);
    }
    // Beginning setup never destroys an old capability. An expired/inactive
    // authorization is replaced only by the separate, explicit Restart act,
    // whose secret deletion must succeed before a new server record is minted.
    if (existing) {
      if (existing.status !== "expired") return expire(existing);
      return publicState(existing);
    }

    // A secret without its public state is an interrupted prior commit, not a
    // fresh machine. Only explicit Restart may delete that authorization-only
    // residue before a replacement is created.
    const canInspectResidue = typeof secretStore.inspect === "function";
    const residue = canInspectResidue ? await secretStore.inspect() : await secretStore.read();
    if (residue?.ok && (canInspectResidue ? residue.present === true : true)) {
      throw credentialError(
        "Relay found an unfinished one-time setup authorization. Restart setup to replace it safely.",
        "setup_restart_required",
      );
    }
    if (residue && !residue.ok && residue.code && residue.code !== "credential_not_found") {
      throw credentialError(
        "Relay cannot inspect protected credential storage. Check its permissions, then try setup again.",
        residue.code || "credential_store_error",
      );
    }

    const available = await secretStore.probe?.();
    if (available && !available.ok) {
      throw credentialError(
        "Relay cannot access protected credential storage. Check its permissions, then try setup again.",
        available.code || "credential_store_error",
      );
    }

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
    if (!stored?.ok) {
      throw credentialError(
        "Relay could not protect the one-time setup authorization in protected storage.",
        stored?.code || "credential_store_error",
      );
    }
    try {
      await durableStore.write(state);
    } catch (error) {
      let removed;
      try { removed = await secretStore.delete(); } catch (cleanupError) {
        throw credentialError(
          "Relay could not roll back the one-time setup authorization in protected storage.",
          cleanupError?.code || "credential_store_error",
        );
      }
      if (!removed?.ok) {
        throw credentialError(
          "Relay could not roll back the one-time setup authorization in protected storage.",
          removed?.code || "credential_store_error",
        );
      }
      throw error;
    }
    return publicState(state);
  }

  function begin() {
    if (!beginInFlight) {
      beginInFlight = serialize(beginInternal).finally(() => { beginInFlight = null; });
    }
    return beginInFlight;
  }

  async function stateInternal() {
    const durable = await readDurable();
    if (!durable) return { status: "idle" };
    if (durable.status === "expired") return publicState(durable);
    if (Date.parse(durable.expiresAt) <= now()) return expire(durable);
    if (durable.status === "consumed") return publicState(durable);
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

  function state() {
    return serialize(stateInternal);
  }

  async function googleInternal({ forceAccountSelection = false } = {}) {
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

  function google(options) {
    return serialize(() => googleInternal(options));
  }

  async function emailStartInternal(email) {
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

  function emailStart(email) {
    return serialize(() => emailStartInternal(email));
  }

  async function emailVerifyInternal(code) {
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

  function emailVerify(code) {
    return serialize(() => emailVerifyInternal(code));
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
      consumeInFlight = serialize(approveAndConsume).finally(() => { consumeInFlight = null; });
    }
    return consumeInFlight;
  }

  async function resumeInternal() {
    if (await isPaired()) {
      const pairedState = await readDurable();
      if (pairedState?.status === "consumed") {
        await removeAuthorization();
        return publicState(pairedState);
      }
      throw new Error("Relay is already connected on this computer.");
    }
    let durable = await readDurable();
    if (!durable) return { status: "idle" };
    if (Date.parse(durable.expiresAt) <= now()) return expire(durable);
    if (durable.status === "approved" || durable.status === "consumed") {
      return approveAndConsume();
    }

    // A local response may have been lost after the server committed approval.
    // Refresh first, then use only the idempotent consume recovery path. A
    // merely pending_approval authorization still requires the human button.
    const refreshed = await stateInternal();
    if (refreshed.status === "expired") return refreshed;
    durable = await readDurable();
    if (durable?.status === "approved" || durable?.status === "consumed") {
      return approveAndConsume();
    }
    return publicState(durable);
  }

  function resume() {
    if (!resumeInFlight) {
      resumeInFlight = serialize(resumeInternal).finally(() => { resumeInFlight = null; });
    }
    return resumeInFlight;
  }

  async function cancelInternal() {
    // Delete the authorization-only namespace even if its public state file is
    // absent (for example, after a state commit failed following secret write).
    await removeAuthorization();
    return { status: "idle" };
  }

  function cancel() {
    return serialize(cancelInternal);
  }

  async function restartInternal() {
    if (await isPaired()) throw new Error("Relay is already connected on this computer.");
    // This touches only the one-time installation-authorization namespace. It
    // never signs out, revokes a device, or removes account/E2EE/message state.
    await removeAuthorization();
    return beginInternal();
  }

  function restart() {
    return serialize(restartInternal);
  }

  return { state, begin, resume, restart, google, emailStart, emailVerify, approve, cancel };
}
