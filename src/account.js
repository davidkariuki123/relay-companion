import os from "node:os";
import { createRequire } from "node:module";
import { readConfig, withoutDeprecatedCapabilityConfig, writeConfigObject } from "./config.js";

const { deleteDeviceToken, readDeviceToken } = createRequire(import.meta.url)("./credential-store.cjs");

/**
 * Account lifecycle for the companion: the ONE config-write shape shared by
 * `relay pair` (bin/relay.js cmdPair) and the pill's Settings tab, so switching
 * accounts from either surface persists identical credentials. The pure shapes
 * are exported separately from the fs-touching persist helpers for unit tests.
 */

/**
 * Pairing codes are 8 chars from an unambiguous uppercase alphabet
 * (services/devices.ts). The server only trims + uppercases, so typed
 * "abcd-efgh" / "ABCD EFGH" variants are folded here before the request.
 */
export function normalizePairingCode(raw) {
  return String(raw ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

/** The device name a re-pair should register: the remembered one, else the hostname. */
export function deviceNameForPairing(config = readConfig()) {
  const stored = String((config && config.deviceName) || "").trim();
  return stored || os.hostname();
}

/**
 * The post-registration config: everything the old config had, plus the fresh
 * credentials. apiUrl/webUrl/deviceName are only written when explicitly given
 * (the pill switches accounts without touching the URLs it was launched with).
 */
export function pairedAccountConfig(existing, { apiUrl, webUrl, deviceName, registration } = {}) {
  const res = registration || {};
  const next = {
    ...(existing || {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(webUrl ? { webUrl } : {}),
    ...(deviceName ? { deviceName } : {}),
    deviceToken: res.deviceToken || "",
    deviceId: res.deviceId || "",
    user: res.user || null,
  };
  // Which machine issued this credential (src/installation-key.cjs). A later
  // re-pair or sign-out revokes the credential only when it was issued here,
  // never one that arrived in a copied home folder from another computer.
  if (res.installationKey) next.installationKey = res.installationKey;
  else delete next.installationKey;
  return withoutDeprecatedCapabilityConfig(next);
}

/**
 * The credential a pairing is about to replace. Read it BEFORE persisting the
 * new registration: afterwards the old token is gone from protected storage
 * and its device could only be revoked from the web.
 */
export function replacedDeviceCredential(config) {
  try {
    const current = config === undefined ? readConfig() : config;
    const deviceToken = String(current?.deviceToken || "");
    if (!deviceToken.startsWith("dev_")) return null;
    return {
      deviceToken,
      deviceId: String(current.deviceId || ""),
      apiUrl: String(current.apiUrl || ""),
      installationKey: String(current.installationKey || ""),
    };
  } catch {
    return null;
  }
}

async function defaultDeviceClient(url, token) {
  const { RelayClient } = await import("./client.js");
  return new RelayClient({ ...(url ? { url } : {}), token });
}

async function revokeWithOwnToken(credential, makeClient, timeoutMs, { reason } = {}) {
  try {
    const client = await makeClient(credential.apiUrl, credential.deviceToken);
    await client.revokeSelf({ timeoutMs, ...(reason ? { reason } : {}) });
    return "revoked";
  } catch (error) {
    // A token the server no longer accepts is already retired (the server
    // replaces a same-installation device itself when the new one registers).
    return Number(error?.status) === 401 ? "already_revoked" : "failed";
  }
}

/**
 * Retire the device a pairing just replaced, using that device's own token.
 *
 * Only a credential issued on this same installation is revoked: its stored
 * installation key must equal the new registration's. That covers a re-pair
 * and Switch Account on this computer, and it refuses a credential copied in
 * from another machine (a cloned VM, a restored home folder), whose device is
 * still live elsewhere. Credentials from before installation keys existed are
 * left alone. Best effort: never throws and never blocks the new pairing.
 */
export async function revokeReplacedDevice(previous, registration, {
  makeClient = defaultDeviceClient,
  timeoutMs = 5000,
} = {}) {
  if (!previous?.deviceToken) return "none";
  if (previous.deviceToken === registration?.deviceToken) return "same_device";
  if (previous.deviceId && previous.deviceId === registration?.deviceId) return "same_device";
  if (!previous.installationKey || previous.installationKey !== registration?.installationKey) return "not_this_installation";
  return revokeWithOwnToken(previous, makeClient, timeoutMs);
}

/**
 * Revoke this computer's device before its credential is deleted on sign-out,
 * so signing out does not leave a live token and a stale device behind. The
 * server is told this was a sign-out, so the fleet keeps the computer listed
 * as signed out. "failed" means the server was not reached: pass the result to
 * persistSignedOutAccount, which keeps the credential for a later retry.
 *
 * Unlike a re-pair, a sign-out is not limited to credentials issued on this
 * installation. The person asked to sign out, the credential names exactly one
 * device, and credentials from before installation keys existed could
 * otherwise never be signed out: their devices stayed in the fleet for good.
 * The cost is a copied home folder: signing out on the copy signs the
 * original out too, and that computer signs in again.
 */
export async function revokeSignedOutDevice(config, {
  makeClient = defaultDeviceClient,
  timeoutMs = 5000,
} = {}) {
  const credential = replacedDeviceCredential(config);
  if (!credential) return "none";
  return revokeWithOwnToken(credential, makeClient, timeoutMs, { reason: "sign_out" });
}

/**
 * Tell the server Relay was removed from this computer while the sign-in is
 * kept, so the fleet stops listing it. Nothing is revoked: a reinstall resumes
 * the same device. Best effort and never throws. "unsupported" is a server
 * that predates the report.
 */
export async function reportUninstalledDevice(config, {
  makeClient = defaultDeviceClient,
  timeoutMs = 5000,
} = {}) {
  const credential = replacedDeviceCredential(config);
  if (!credential) return "none";
  try {
    const client = await makeClient(credential.apiUrl, credential.deviceToken);
    await client.reportUninstalled({ timeoutMs });
    return "reported";
  } catch (error) {
    const status = Number(error?.status);
    return status === 401 ? "already_revoked" : status === 404 ? "unsupported" : "failed";
  }
}

/**
 * Sign-out clears the credential set — user, deviceToken, and the deviceId that
 * belongs to that token — while preserving apiUrl/webUrl, the device name, the
 * and any other current settings on the file.
 */
export function signedOutAccountConfig(existing) {
  const next = { ...(existing || {}) };
  delete next.user;
  delete next.deviceToken;
  delete next.deviceId;
  delete next.installationKey;
  delete next.credentialStore;
  delete next.credentialVersion;
  delete next.credentialAccount;
  return withoutDeprecatedCapabilityConfig(next);
}

export function persistPairedAccount({
  apiUrl,
  webUrl,
  deviceName,
  registration,
  requireNativeCredential = false,
  credentialBackend,
} = {}) {
  const existing = readConfig();
  return writeConfigObject(
    pairedAccountConfig(existing, { apiUrl, webUrl, deviceName, registration }),
    { requireNativeCredential, ...(credentialBackend ? { credentialBackend } : {}) },
  );
}

/**
 * revokeResult is what revokeSignedOutDevice returned. When it is "failed" the
 * server never heard about the sign-out (offline, timed out), so the device
 * would stay live there with a token this computer had already deleted.
 * Instead the credential stays in protected storage, no longer the account's
 * credential, and config.json records where it is so flushPendingSignOuts can
 * finish the sign-out later. It is used for nothing but that revocation.
 * Only a credential held in protected storage is kept; a plaintext one is
 * deleted as before.
 */
export function persistSignedOutAccount({ credentialBackend = { deleteDeviceToken }, revokeResult } = {}) {
  const config = readConfig();
  const next = signedOutAccountConfig(config);
  const keep = revokeResult === "failed" && config.credentialStore && config.credentialAccount;
  if (keep) {
    next.pendingSignOuts = [
      ...pendingSignOuts(config).filter((entry) => entry.credentialAccount !== config.credentialAccount),
      {
        credentialAccount: String(config.credentialAccount),
        deviceId: String(config.deviceId || ""),
        apiUrl: String(config.apiUrl || ""),
        signedOutAt: new Date().toISOString(),
      },
    ].slice(-MAX_PENDING_SIGN_OUTS);
  } else if (config.credentialStore) {
    const removed = credentialBackend.deleteDeviceToken({ account: config.credentialAccount || "device-token" });
    if (!removed.ok) throw new Error(`Could not remove Relay credential from protected storage (${removed.detail || "unknown error"}).`);
  }
  return writeConfigObject(next);
}

const MAX_PENDING_SIGN_OUTS = 8;

function pendingSignOuts(config) {
  return (Array.isArray(config?.pendingSignOuts) ? config.pendingSignOuts : [])
    .filter((entry) => entry && typeof entry.credentialAccount === "string" && entry.credentialAccount);
}

/**
 * Finish sign-outs the server never heard about. Each kept credential revokes
 * its own device and is then deleted; one the server no longer accepts is
 * already retired. An entry stays only while the server cannot be reached.
 * Best effort: never throws.
 */
export async function flushPendingSignOuts({
  makeClient = defaultDeviceClient,
  credentialBackend = { deleteDeviceToken, readDeviceToken },
  timeoutMs = 5000,
} = {}) {
  const outcome = { revoked: 0, remaining: 0 };
  try {
    const pending = pendingSignOuts(readConfig());
    if (!pending.length) return outcome;
    const finished = new Set();
    for (const entry of pending) {
      const stored = credentialBackend.readDeviceToken({ account: entry.credentialAccount });
      const token = stored?.ok ? String(stored.value || "") : "";
      // Nothing left to revoke with: the entry can never succeed.
      const result = token.startsWith("dev_")
        ? await revokeWithOwnToken({ apiUrl: entry.apiUrl, deviceToken: token }, makeClient, timeoutMs, { reason: "sign_out" })
        : stored?.ok || stored?.code === "credential_not_found" ? "gone" : "failed";
      if (result === "failed") continue;
      try { credentialBackend.deleteDeviceToken({ account: entry.credentialAccount }); } catch {}
      finished.add(entry.credentialAccount);
      if (result === "revoked") outcome.revoked += 1;
    }
    // Re-read: a pairing or another sign-out may have written since.
    const current = readConfig();
    const remaining = pendingSignOuts(current).filter((entry) => !finished.has(entry.credentialAccount));
    outcome.remaining = remaining.length;
    if (finished.size) {
      const next = { ...current };
      if (remaining.length) next.pendingSignOuts = remaining;
      else delete next.pendingSignOuts;
      writeConfigObject(next);
    }
  } catch {}
  return outcome;
}

/**
 * How the account on disk relates to the one a long-lived process bound at
 * startup. Every Relay process that outlives a pairing — the daemon, and the
 * `relay mcp` server inside each agent session — captures its identity once
 * and asks this before acting again, because config.json is rewritten by
 * `relay pair`, the pill's Switch Account, and Sign Out while they run.
 *
 *   same       nothing moved
 *   rotated    same person, new credential (re-pair, token rotation) or a
 *              first pairing on a process that started unpaired — safe to
 *              adopt in place; nothing already read becomes someone else's
 *   changed    a DIFFERENT person is signed in now
 *   signed_out the device holds no credential any more
 *
 * "changed" and "signed_out" are the cases a caller must not paper over: an
 * agent session that quietly followed the switch would blend two people's
 * correspondence in one conversation, and a daemon that kept polling with
 * the old token would stage the previous account's Relays into the store the
 * pill just wiped for the new one (observed 2026-08-18: the survived-a-restart
 * daemon re-staged the old account's welcome Relay five seconds after the
 * switch).
 */
export function compareAccountIdentity(bound, current) {
  const was = bound || {};
  const now = current || {};
  const wasToken = String(was.deviceToken || "");
  const nowToken = String(now.deviceToken || "");
  const wasUser = String(was.userId || "");
  const nowUser = String(now.userId || "");
  if (wasToken && !nowToken) return "signed_out";
  if (wasUser && nowUser && wasUser !== nowUser) return "changed";
  if (wasToken !== nowToken || String(was.deviceId || "") !== String(now.deviceId || "")) return "rotated";
  return "same";
}

/**
 * The refusal an agent-facing surface returns once its process is bound to an
 * account this computer no longer holds. Names both accounts so the human
 * understands why a tool that worked a minute ago now declines, and says the
 * one thing that fixes it: Relay cannot restart a session it did not start.
 */
export function accountDriftMessage(status, { bound = {}, current = {} } = {}) {
  const was = bound.email || bound.userId || "the previous account";
  if (status === "signed_out") {
    return (
      `Relay is signed out on this computer. This agent session's Relay tools were bound to ${was}, ` +
      "and that credential is gone. Sign in to Relay again, then restart this agent session " +
      "(Claude Code / Codex) so its Relay tools pick up the account. Nothing was sent or read."
    );
  }
  const now = current.email || current.userId || "a different account";
  return (
    `Relay's account on this computer changed: this agent session's Relay tools are bound to ${was}, ` +
    `but Relay is now signed in as ${now}. Nothing was sent or read. Use the installed Relay skill helper ` +
    "(relay-protocol.mjs) now: it follows the current account, so run its status and request GET /v1/me, " +
    "then continue through it when the account matches. Otherwise restart this agent session " +
    "(Claude Code / Codex) so its Relay tools use the current account. Never read or copy the credential file."
  );
}
