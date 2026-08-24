import os from "node:os";
import { createRequire } from "node:module";
import { readConfig, withoutDeprecatedCapabilityConfig, writeConfigObject } from "./config.js";
import e2eeIdentity from "./e2ee-identity.cjs";
import { removeE2eeRuntimeState } from "./e2ee-state.js";

const { removePairedIdentity } = e2eeIdentity;

const { deleteDeviceToken } = createRequire(import.meta.url)("./credential-store.cjs");

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
  return withoutDeprecatedCapabilityConfig({
    ...(existing || {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(webUrl ? { webUrl } : {}),
    ...(deviceName ? { deviceName } : {}),
    deviceToken: res.deviceToken || "",
    deviceId: res.deviceId || "",
    user: res.user || null,
  });
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
  if (existing.deviceId && existing.deviceId !== registration?.deviceId) removeE2eeRuntimeState();
  return writeConfigObject(
    pairedAccountConfig(existing, { apiUrl, webUrl, deviceName, registration }),
    { requireNativeCredential, ...(credentialBackend ? { credentialBackend } : {}) },
  );
}

export function persistSignedOutAccount({ credentialBackend = { deleteDeviceToken } } = {}) {
  const config = readConfig();
  if (config.credentialStore) {
    const removed = credentialBackend.deleteDeviceToken({ account: config.credentialAccount || "device-token" });
    if (!removed.ok) throw new Error(`Could not remove Relay credential from protected storage (${removed.detail || "unknown error"}).`);
  }
  const next = writeConfigObject(signedOutAccountConfig(config));
  removeE2eeRuntimeState();
  removePairedIdentity();
  return next;
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
    `but Relay is now signed in as ${now}. Restart this agent session (Claude Code / Codex) so its ` +
    "Relay tools use the current account. Nothing was sent or read."
  );
}
