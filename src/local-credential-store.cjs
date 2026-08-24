"use strict";

// Relay's macOS credential store deliberately uses the same local trust
// boundary as its E2EE device identity: one owner-only file under ~/.relay.
// The legacy login Keychain can be made permanently unavailable by third-party
// SecurityAgent plug-ins. A device-scoped, revocable Relay token must not make
// the whole Companion depend on that shared and interactive global vault.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");
const { withJsonLockStrict } = require("./state-lock.cjs");

const SCHEMA = 1;
const FILENAME = "credentials.v2.json";
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 256 * 1024;
const MAX_CREDENTIALS = 256;

function storePath({ file, env = process.env, homeDir = os.homedir() } = {}) {
  if (file) return path.resolve(String(file));
  const explicitConfig = String(env.RELAY_CONFIG || "").trim();
  const root = explicitConfig
    ? path.dirname(explicitConfig)
    : env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay");
  return path.join(root, FILENAME);
}

function identity(service, account) {
  const normalizedService = String(service || "").trim();
  const normalizedAccount = String(account || "").trim();
  if (
    !normalizedService || !normalizedAccount
    || normalizedService.includes("\u0000") || normalizedAccount.includes("\u0000")
    || normalizedService.length > 300 || normalizedAccount.length > 300
  ) {
    return null;
  }
  return `${normalizedService}\u0000${normalizedAccount}`;
}

function failure(detail, code = "credential_store_error") {
  return { ok: false, value: "", detail, code };
}

function validatePrivateFile(file, stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) return failure("local credential store is not a regular file");
  if (stat.nlink !== 1) return failure("local credential store has unexpected hard links");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return failure("local credential store is owned by another user");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return failure("local credential store permissions are too broad", "credential_store_permissions");
  }
  return null;
}

function readDocument(file, { fsImpl = fs } = {}) {
  let stat;
  try { stat = fsImpl.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") return { ok: true, value: { schema: SCHEMA, credentials: {} } };
    return failure(`local credential store could not be inspected (${error?.code || "filesystem error"})`);
  }
  const unsafe = validatePrivateFile(file, stat);
  if (unsafe) return unsafe;
  if (stat.size > MAX_STORE_BYTES) return failure("local credential store is too large", "credential_store_corrupt");
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== SCHEMA || !parsed.credentials || typeof parsed.credentials !== "object" || Array.isArray(parsed.credentials)) {
      return failure("local credential store is invalid", "credential_store_corrupt");
    }
    const entries = Object.entries(parsed.credentials);
    if (entries.length > MAX_CREDENTIALS) return failure("local credential store is invalid", "credential_store_corrupt");
    for (const [key, value] of entries) {
      if (!key.includes("\u0000") || typeof value !== "string" || !value) {
        return failure("local credential store is invalid", "credential_store_corrupt");
      }
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return failure(
      error instanceof SyntaxError ? "local credential store is invalid" : `local credential store could not be read (${error?.code || "filesystem error"})`,
      error instanceof SyntaxError ? "credential_store_corrupt" : "credential_store_error",
    );
  }
}

function ensurePrivateRoot(file, { fsImpl = fs } = {}) {
  const root = path.dirname(file);
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fsImpl.chmodSync(root, 0o700); } catch {}
  }
}

function operation(action, secret = "", options = {}) {
  const key = identity(options.service, options.account);
  if (!key) return failure("invalid credential identity");
  const file = storePath(options);
  if (action === "read") {
    const document = readDocument(file, options);
    if (!document.ok) return document;
    const value = document.value.credentials[key];
    return value
      ? { ok: true, value, detail: "" }
      : failure("local credential was not found", "credential_not_found");
  }
  try { ensurePrivateRoot(file, options); }
  catch (error) { return failure(`local credential directory is unavailable (${error?.code || "filesystem error"})`); }
  const locked = withJsonLockStrict(file, () => {
    const document = readDocument(file, options);
    if (!document.ok) return document;
    const credentials = { ...document.value.credentials };
    if (action === "write") credentials[key] = String(secret);
    else if (action === "delete") delete credentials[key];
    else return failure("unsupported local credential operation");
    try {
      atomicWriteJsonSync(file, { schema: SCHEMA, credentials }, { mode: 0o600, fsImpl: options.fsImpl || fs });
      if (process.platform !== "win32") {
        try { (options.fsImpl || fs).chmodSync(file, 0o600); } catch {}
      }
      return { ok: true, value: "", detail: "" };
    } catch (error) {
      return failure(`local credential store could not be updated (${error?.code || "filesystem error"})`);
    }
  }, { timeoutMs: 3000, staleMs: 15000 });
  return locked.ok ? locked.value : failure(`local credential store is busy (${locked.reason})`, "credential_store_busy");
}

function writeCredential(secret, options = {}) {
  const value = String(secret || "");
  if (!value) return failure("empty credential");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) return failure("credential is too large");
  return operation("write", value, options);
}

function readCredential(options = {}) { return operation("read", "", options); }
function deleteCredential(options = {}) {
  const result = operation("delete", "", options);
  return result.code === "credential_not_found" ? { ok: true, value: "", detail: "" } : result;
}

module.exports = {
  FILENAME,
  MAX_SECRET_BYTES,
  MAX_STORE_BYTES,
  SCHEMA,
  deleteCredential,
  readCredential,
  storePath,
  writeCredential,
};
