import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import atomicJson from "./atomic-json.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { writeDeviceToken, readDeviceToken, deleteDeviceToken } = createRequire(import.meta.url)("./credential-store.cjs");
export const NATIVE_CREDENTIAL_STORE = "native-v1";
export const LOCAL_CREDENTIAL_STORE = "local-v2";
export const LEGACY_DEVICE_CREDENTIAL_ACCOUNT = "device-token";
export const CREDENTIAL_STATUS_AVAILABLE = "available";
export const CREDENTIAL_STATUS_UNPAIRED = "unpaired";
export const CREDENTIAL_STATUS_UNAVAILABLE = "unavailable";
export const CREDENTIAL_STATUS_MISSING = "missing";
export const CREDENTIAL_STATUS_CORRUPT = "corrupt";
function localCredentialStorePlatform(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export function nativeCredentialAccessAllowed(env = process.env, platform = process.platform, homeDir = os.homedir()) {
  // The macOS store follows the selected config directory, so a sandbox stays
  // inside its sandbox. Windows Credential Manager is machine-global; keep its
  // explicit opt-in for custom config paths so tests cannot touch real entries.
  if (localCredentialStorePlatform(platform)) return true;
  if (env.RELAY_NATIVE_CREDENTIALS_WITH_CUSTOM_CONFIG === "1") return true;
  if (env.RELAY_CONFIG) return false;
  // The shared MCP broker is launched with RELAY_CONFIG_DIR pinned to the
  // default directory so every host resolves the same state. That is not a
  // custom path: refusing it left every Windows MCP tool call without a token
  // (missing_authorization) while the daemon and pill authenticated fine.
  if (!env.RELAY_CONFIG_DIR) return true;
  return path.resolve(String(env.RELAY_CONFIG_DIR)) === path.resolve(path.join(homeDir, ".relay"));
}
const nativeCredentialBackend = {
  writeDeviceToken: (token, options) => nativeCredentialAccessAllowed()
    ? writeDeviceToken(token, options)
    : { ok: false, detail: "native credentials disabled for custom config path" },
  readDeviceToken: (options) => nativeCredentialAccessAllowed()
    ? readDeviceToken(options)
    : { ok: false, value: "", detail: "native credentials disabled for custom config path" },
  deleteDeviceToken: (options) => nativeCredentialAccessAllowed()
    ? deleteDeviceToken(options)
    : { ok: false, value: "", detail: "native credentials disabled for custom config path" },
};

function credentialStoreKind() {
  return localCredentialStorePlatform() ? LOCAL_CREDENTIAL_STORE : NATIVE_CREDENTIAL_STORE;
}

function usesCredentialStore(value) {
  return value === NATIVE_CREDENTIAL_STORE || value === LOCAL_CREDENTIAL_STORE;
}

export const DEFAULT_API_URL = "https://api.sendrelays.com";
export const DEFAULT_WEB_URL = "https://sendrelays.com";
// The dev API (DEPLOY.md "Dev backend"): same accounts, same inboxes, newer
// server code — the RelayDevApi App Runner service, deployed 2026-08-14.
// `relay env dev` flips a machine here with no flags.
export const DEFAULT_DEV_API_URL = "https://dev-api.sendrelays.com";
// Staging is intentionally dormant until its App Runner service is provisioned.
// `relay env staging --api https://...` can persist the assigned URL once it
// exists; a later stock build may bake it here after the endpoint is stable.
export const DEFAULT_STAGING_API_URL = "";
// 0.1.439 briefly persisted these raw dev/staging reader origins as the
// account web origin. Production Clerk cannot authenticate either hostname,
// so later runtimes must keep repairing the bad durable value even after the
// one-off recovery bridge is no longer the current release.
export const AUTH_INCOMPATIBLE_WEB_URLS = [
  "https://ujvrds7yxv.us-east-1.awsapprunner.com",
  "https://8epdrqim29.us-east-1.awsapprunner.com",
];

/**
 * Origins the fleet was pointed at before api.sendrelays.com existed. Every
 * install from that era persisted the raw App Runner hostname into config.json
 * at pairing, and the stored value outranks DEFAULT_API_URL forever — so
 * changing the default reached nobody already paired. Worse, that hostname is
 * AWS-generated: recreate the service and it changes, stranding every such
 * device with no way to receive the fix (auto-update reaches the API through
 * this same URL).
 *
 * apiUrl() therefore maps a stored legacy origin to the canonical one at read
 * time (correct immediately, even on a read-only disk) and heals the stored
 * value once per process (correct durably, so the pill and future processes
 * read a healthy file). The legacy host must stay routable until the
 * `legacyApiHost` counter on relay-api's /health shows the fleet has stopped
 * dialing it — retiring it earlier orphans every device this code has not
 * reached yet.
 */
export const LEGACY_API_URLS = [
  "https://aia6vj5pgp.us-east-1.awsapprunner.com",
  // The first Dev API was exposed through its raw App Runner hostname. Dev
  // installs persisted it before dev-api.sendrelays.com became canonical, so
  // changing DEFAULT_DEV_API_URL alone left paired machines on the retired
  // service forever. Stable installs heal this to production; the dev-channel
  // resolution below then advances Dev installs to DEFAULT_DEV_API_URL.
  "https://q9dpgb9fzb.us-east-1.awsapprunner.com",
];

const LEGACY_API_ORIGINS = new Set(LEGACY_API_URLS.map((url) => normalizeOrigin(url)));

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Map a stored legacy API origin to the canonical URL; any other value passes through. */
export function canonicalizeApiUrl(value) {
  if (!value) return value;
  return LEGACY_API_ORIGINS.has(normalizeOrigin(value)) ? DEFAULT_API_URL : value;
}
/**
 * Release channels. "stable" follows npm's `latest` dist-tag (every user's
 * default); "dev" and "staging" follow their matching dist-tags, each advanced
 * only by a deliberate promotion of an immutable build. Staging is a
 * production-like release candidate: selecting its update channel must never
 * enable developer-only product capabilities.
 * Unknown stored values normalize to stable so a corrupt or future config value
 * can never strand a machine on an unknown tag.
 */
export const UPDATE_CHANNEL_STABLE = "stable";
export const UPDATE_CHANNEL_DEV = "dev";
export const UPDATE_CHANNEL_STAGING = "staging";

export function normalizeUpdateChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === UPDATE_CHANNEL_DEV) return UPDATE_CHANNEL_DEV;
  if (normalized === UPDATE_CHANNEL_STAGING) return UPDATE_CHANNEL_STAGING;
  return UPDATE_CHANNEL_STABLE;
}

export function updateChannel() {
  return normalizeUpdateChannel(process.env.RELAY_UPDATE_CHANNEL || readConfig().updateChannel);
}

/**
 * Companion configuration lives in ~/.relay/config.json. New macOS/Linux/Windows
 * installs keep only non-secret account metadata here; the device token lives in
 * Relay's owner-only local store on macOS/Linux or Credential Manager on Windows.
 * Legacy plaintext and macOS Keychain tokens migrate on first read.
 * Environment variables override the file for local/staging testing.
 */
export function configDir() {
  return process.env.RELAY_CONFIG_DIR || path.join(os.homedir(), ".relay");
}

export function configPath() {
  // RELAY_CONFIG (a full file path) matches the overlay's readConfigFile
  // resolution, so a sandboxed pill and these helpers agree on ONE file.
  return process.env.RELAY_CONFIG || path.join(configDir(), "config.json");
}

function readConfigRawState() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { config: {}, status: "absent" };
    return { config: {}, status: "unavailable", code: "config_unavailable" };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config shape");
    return { config: parsed, status: "ok" };
  } catch (error) {
    // The file exists but is corrupt (crash mid-write on the old non-atomic path).
    // Preserve it for inspection instead of silently treating the device as unpaired
    // and letting the daemon crash-loop — but do NOT delete: a paired token may be
    // partially recoverable. One backup per process: the daemon now re-reads this
    // file every poll (accountIdentity), and a corrupt file must not become a
    // new backup every 4 seconds.
    if (!backedUpCorruptConfig) {
      backedUpCorruptConfig = true;
      try {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.copyFileSync(file, backup);
        // eslint-disable-next-line no-console
        console.error(`[relay] config.json is corrupt; backed up to ${backup}`);
      } catch {}
    }
    return { config: {}, status: "corrupt", code: "config_corrupt" };
  }
}

function readConfigRaw() {
  return readConfigRawState().config;
}
let backedUpCorruptConfig = false;

let cachedCredentialVersion = null;
let cachedDeviceToken = "";

function newCredentialIdentity() {
  const credentialVersion = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return { credentialVersion, credentialAccount: `${LEGACY_DEVICE_CREDENTIAL_ACCOUNT}-${credentialVersion}` };
}

function credentialAccountFor(config) {
  return String(config?.credentialAccount || LEGACY_DEVICE_CREDENTIAL_ACCOUNT);
}

/**
 * Hydrate the device credential from protected storage. A legacy plaintext
 * token migrates only after the protected write succeeds; if either the
 * credential store or the atomic config rewrite fails, the plaintext remains as a
 * rollback-safe fallback and the user is never forced to authenticate again.
 */
export function readConfigState({ credentialBackend = nativeCredentialBackend } = {}) {
  const rawState = readConfigRawState();
  const raw = rawState.config;
  if (process.env.RELAY_DEVICE_TOKEN) {
    return { config: raw, credential: { status: CREDENTIAL_STATUS_AVAILABLE } };
  }
  if (rawState.status === "unavailable") {
    return {
      config: raw,
      credential: { status: CREDENTIAL_STATUS_UNAVAILABLE, code: rawState.code },
    };
  }
  if (rawState.status === "corrupt") {
    return {
      config: raw,
      credential: { status: CREDENTIAL_STATUS_CORRUPT, code: rawState.code },
    };
  }
  if (raw.deviceToken) {
    const identity = newCredentialIdentity();
    const stored = credentialBackend.writeDeviceToken(raw.deviceToken, { account: identity.credentialAccount });
    if (!stored.ok) {
      return { config: raw, credential: { status: CREDENTIAL_STATUS_AVAILABLE } };
    }
    const next = { ...raw, credentialStore: credentialStoreKind(), ...identity };
    const token = next.deviceToken;
    delete next.deviceToken;
    try {
      atomicWriteJsonSync(configPath(), withoutDeprecatedCapabilityConfig(next), { mode: 0o600 });
      cachedCredentialVersion = next.credentialVersion;
      cachedDeviceToken = token;
      return {
        config: { ...next, deviceToken: token },
        credential: { status: CREDENTIAL_STATUS_AVAILABLE },
      };
    } catch {
      try { credentialBackend.deleteDeviceToken?.({ account: identity.credentialAccount }); } catch {}
      return { config: raw, credential: { status: CREDENTIAL_STATUS_AVAILABLE } };
    }
  }
  if (usesCredentialStore(raw.credentialStore)) {
    const credentialVersion = raw.credentialVersion || "native";
    if (credentialVersion === cachedCredentialVersion && cachedDeviceToken) {
      return {
        config: { ...raw, deviceToken: cachedDeviceToken },
        credential: { status: CREDENTIAL_STATUS_AVAILABLE },
      };
    }
    const stored = credentialBackend.readDeviceToken({
      account: credentialAccountFor(raw),
      allowLegacyMigration: raw.credentialStore === NATIVE_CREDENTIAL_STORE,
    });
    if (stored.ok && stored.value) {
      const migratedPointer = localCredentialStorePlatform() && raw.credentialStore === NATIVE_CREDENTIAL_STORE
        ? { ...raw, credentialStore: LOCAL_CREDENTIAL_STORE }
        : raw;
      if (migratedPointer !== raw) {
        try { atomicWriteJsonSync(configPath(), withoutDeprecatedCapabilityConfig(migratedPointer), { mode: 0o600 }); }
        catch {}
      }
      cachedCredentialVersion = credentialVersion;
      cachedDeviceToken = stored.value;
      return {
        config: { ...migratedPointer, deviceToken: stored.value },
        credential: { status: CREDENTIAL_STATUS_AVAILABLE },
      };
    }
    if (stored.ok) {
      return {
        config: raw,
        credential: { status: CREDENTIAL_STATUS_CORRUPT, code: "credential_empty" },
      };
    }
    if (localCredentialStorePlatform() && raw.credentialStore === NATIVE_CREDENTIAL_STORE) {
      // The bridge installer deliberately remains npm's `latest` catch-up rail.
      // Older bridge builds wrote a Keychain pointer that current macOS builds
      // no longer use. A failed one-time legacy read must therefore lead to a
      // clean reconnect, not an unrecoverable retry loop.
      const healed = { ...raw, credentialStore: LOCAL_CREDENTIAL_STORE };
      try { atomicWriteJsonSync(configPath(), withoutDeprecatedCapabilityConfig(healed), { mode: 0o600 }); }
      catch {}
      return {
        config: healed,
        credential: {
          status: CREDENTIAL_STATUS_MISSING,
          code: stored.code || "legacy_credential_unavailable",
        },
      };
    }
    const missing = stored.code === "credential_not_found";
    return {
      config: raw,
      credential: {
        status: missing ? CREDENTIAL_STATUS_MISSING : CREDENTIAL_STATUS_UNAVAILABLE,
        code: stored.code || "credential_store_error",
      },
    };
  }
  return { config: raw, credential: { status: CREDENTIAL_STATUS_UNPAIRED } };
}

export function readConfig(options) {
  return readConfigState(options).config;
}

/**
 * Replace config.json with exactly `next` (no merge). This is the primitive that
 * lets sign-out REMOVE keys — writeConfig's patch merge can only add or overwrite.
 */
export function writeConfigObject(
  next,
  { credentialBackend = nativeCredentialBackend, requireNativeCredential = false, atomicWrite = atomicWriteJsonSync } = {},
) {
  const file = configPath();
  const cleaned = withoutDeprecatedCapabilityConfig(next);
  const previous = readConfigRaw();
  const previousCredentialAccount = usesCredentialStore(previous.credentialStore)
    ? credentialAccountFor(previous)
    : "";
  let storedNativeCredential = false;
  let nextCredentialAccount = "";
  let tokenForCache = "";
  if (cleaned.deviceToken) {
    const token = String(cleaned.deviceToken);
    const identity = newCredentialIdentity();
    const stored = credentialBackend.writeDeviceToken(token, { account: identity.credentialAccount });
    if (stored.ok) {
      storedNativeCredential = true;
      nextCredentialAccount = identity.credentialAccount;
      tokenForCache = token;
      delete cleaned.deviceToken;
      cleaned.credentialStore = credentialStoreKind();
      cleaned.credentialVersion = identity.credentialVersion;
      cleaned.credentialAccount = identity.credentialAccount;
    } else {
      if (requireNativeCredential) {
        throw new Error(`Could not store Relay's device credential securely (${stored.detail || "credential store unavailable"}).`);
      }
      delete cleaned.credentialStore;
      delete cleaned.credentialVersion;
      delete cleaned.credentialAccount;
    }
  }
  // Atomic write: a crash mid-write must not truncate config.json and wipe the
  // device token. Windows rename retries cover short-lived scanner/read locks.
  try {
    atomicWrite(file, cleaned, { mode: 0o600 });
  } catch (error) {
    // A first-time authorization must never leave a credential active without
    // matching account metadata. Best-effort rollback keeps the previous
    // config authoritative if its atomic replacement failed.
    if (storedNativeCredential) {
      try { credentialBackend.deleteDeviceToken?.({ account: nextCredentialAccount }); } catch {}
    }
    throw error;
  }
  if (storedNativeCredential) {
    cachedCredentialVersion = cleaned.credentialVersion;
    cachedDeviceToken = tokenForCache;
    // The config commit is the credential pointer commit. Only now can the old
    // vault target be deleted; a failure leaves a harmless orphan, never a
    // missing credential behind the still-authoritative old config.
    if (previousCredentialAccount && previousCredentialAccount !== nextCredentialAccount) {
      try { credentialBackend.deleteDeviceToken?.({ account: previousCredentialAccount }); } catch {}
    }
  }
  return cleaned;
}

export function withoutDeprecatedCapabilityConfig(next) {
  // Task capability is server-owned. Remove the local switches older
  // companions persisted whenever we next touch the config so stale settings
  // cannot look authoritative to operators or future code.
  const cleaned = { ...next };
  delete cleaned.companionMode;
  if (cleaned.features && typeof cleaned.features === "object") {
    const features = { ...cleaned.features };
    delete features.requests;
    if (Object.keys(features).length) cleaned.features = features;
    else delete cleaned.features;
  }
  return cleaned;
}

export function writeConfig(patch) {
  return writeConfigObject({ ...readConfig(), ...patch });
}

// One heal attempt per process: on a read-only or failing disk, retrying the
// write on every apiUrl() call would add mkdir+rename to each daemon poll for
// no benefit — the read-time mapping below already keeps the process correct.
const attemptedApiUrlHeals = new Set();

export function apiUrl() {
  // An explicit env override is intentional (tests, staging, a local API) and
  // is never rewritten — even when it names the legacy host.
  if (process.env.RELAY_API_URL) return process.env.RELAY_API_URL;
  const config = readConfig();
  const stored = config.apiUrl;
  const canonical = canonicalizeApiUrl(stored) || DEFAULT_API_URL;
  // A Companion on the dev release channel must talk to the dev API. Older
  // setup instructions changed only the npm channel, leaving the persisted API
  // at production. That produced a Dev Slack UI whose server returned a raw
  // route_not_found. Repair only the known incoherent default/legacy pair;
  // explicit local and staging origins remain valid developer choices.
  const devChannel = normalizeUpdateChannel(process.env.RELAY_UPDATE_CHANNEL || config.updateChannel) === UPDATE_CHANNEL_DEV;
  const resolved = devChannel && canonical === DEFAULT_API_URL ? DEFAULT_DEV_API_URL : canonical;
  const healKey = `${configPath()}:${stored || "<default>"}->${resolved}`;
  if (resolved !== (stored || DEFAULT_API_URL) && !attemptedApiUrlHeals.has(healKey)) {
    attemptedApiUrlHeals.add(healKey);
    try {
      writeConfig({
        apiUrl: resolved,
        ...(resolved === DEFAULT_DEV_API_URL ? { devApiUrl: resolved } : {}),
      });
    } catch {
      // The file keeps the incoherent value; this process still uses the canonical
      // URL, and the next process start retries the heal.
    }
  }
  return resolved;
}

const attemptedWebUrlHeals = new Set();

export function webUrl() {
  if (process.env.RELAY_WEB_URL) return process.env.RELAY_WEB_URL.replace(/\/+$/, "");
  const config = readConfig();
  const stored = String(config.webUrl || DEFAULT_WEB_URL).replace(/\/+$/, "");
  const incompatibleOrigins = new Set(AUTH_INCOMPATIBLE_WEB_URLS.map((url) => normalizeOrigin(url)));
  const resolved = incompatibleOrigins.has(normalizeOrigin(stored)) ? DEFAULT_WEB_URL : stored;
  const healKey = `${configPath()}:${stored}->${resolved}`;
  if (resolved !== stored && !attemptedWebUrlHeals.has(healKey)) {
    attemptedWebUrlHeals.add(healKey);
    try {
      writeConfig({ webUrl: resolved });
    } catch {
      // This process still uses the Clerk-capable origin; a later process can
      // retry the durable heal if this disk write was unavailable.
    }
  }
  return resolved;
}

export function deviceToken() {
  return process.env.RELAY_DEVICE_TOKEN || readConfig().deviceToken || "";
}

export function currentUser() {
  return readConfig().user || null;
}

/**
 * The account a process is (or would be) authenticated as RIGHT NOW: who
 * config.json names, and the token it holds. Long-lived processes bind an
 * instance of this at startup and compare against a fresh read later, so a
 * pairing, sign-out, or account switch that lands while they run cannot leave
 * them silently serving the previous person. Honours the RELAY_DEVICE_TOKEN
 * override the same way deviceToken() does.
 */
export function accountIdentity(config = readConfig()) {
  const user = (config && config.user) || null;
  return {
    userId: String((user && user.id) || ""),
    email: String((user && user.email) || ""),
    deviceId: String((config && config.deviceId) || ""),
    deviceToken: process.env.RELAY_DEVICE_TOKEN || String((config && config.deviceToken) || ""),
  };
}

/** Durable local runtime ledger for agent task sessions. */
export function taskLedgerPath() {
  return path.join(configDir(), "task-ledger.json");
}
