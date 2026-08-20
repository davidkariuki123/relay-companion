import fs from "node:fs";
import path from "node:path";

const PROVIDER_IDS = ["claude", "codex"];
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_RETRY_MS = 30 * 1_000;

function cleanText(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function cleanName(value) {
  return cleanText(value, 80).replace(/[^a-zA-Z0-9 ._+-]/g, "");
}

function cleanEntry(value) {
  const source = value?.source === "account" ? "account" : "local";
  const name = cleanName(typeof value === "string" ? value : value?.name);
  if (!name) return null;
  return {
    name,
    status: cleanText(typeof value === "object" ? value?.status : "Configured", 80) || "Configured",
    source,
  };
}

function cleanList(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 200)
    .map(cleanEntry)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sanitizeProviderInventory(value) {
  const input = value?.providers && typeof value.providers === "object" ? value.providers : value;
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const integrations = input?.[id]?.integrations || input?.[id] || {};
    providers[id] = {
      integrations: {
        mcpServers: cleanList(integrations?.mcpServers),
        apps: cleanList(integrations?.apps),
      },
    };
  }
  return providers;
}

function readSnapshot(cacheFile) {
  if (!cacheFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const checkedAt = cleanText(parsed?.checkedAt, 64);
    if (parsed?.version !== 1 || !Number.isFinite(Date.parse(checkedAt))) return null;
    return { version: 1, checkedAt, providers: sanitizeProviderInventory(parsed) };
  } catch {
    return null;
  }
}

function writeSnapshot(cacheFile, snapshot) {
  if (!cacheFile) return;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, cacheFile);
  try { fs.chmodSync(cacheFile, 0o600); } catch {}
}

function errorMessage(error) {
  return cleanText(error?.message || error || "Could not refresh integrations.", 300);
}

export function createProviderInventoryCache({
  cacheFile = "",
  loadFresh,
  fallbackProviders = {},
  ttlMs = DEFAULT_TTL_MS,
  retryMs = DEFAULT_RETRY_MS,
  now = Date.now,
} = {}) {
  if (typeof loadFresh !== "function") throw new TypeError("loadFresh is required");
  const fallback = sanitizeProviderInventory(fallbackProviders);
  let cached = readSnapshot(cacheFile);
  let inFlight = null;
  let retryAt = 0;

  const isFresh = () => {
    if (!cached) return false;
    const age = now() - Date.parse(cached.checkedAt);
    return age >= 0 && age < Math.max(0, Number(ttlMs) || 0);
  };
  const current = ({ refreshing = Boolean(inFlight) } = {}) => ({
    ok: true,
    providers: cached?.providers || fallback,
    checkedAt: cached?.checkedAt || null,
    stale: !isFresh(),
    refreshing,
  });

  async function refresh({ force = false } = {}) {
    if (!force && isFresh()) return current({ refreshing: false });
    if (inFlight) return inFlight;
    if (!force && now() < retryAt) {
      return { ...current({ refreshing: false }), retryAt: new Date(retryAt).toISOString() };
    }
    inFlight = (async () => {
      try {
        const result = await loadFresh();
        if (result?.ok === false) throw new Error(result.error || "Could not refresh integrations.");
        cached = {
          version: 1,
          checkedAt: new Date(now()).toISOString(),
          providers: sanitizeProviderInventory(result),
        };
        writeSnapshot(cacheFile, cached);
        retryAt = 0;
        return current({ refreshing: false });
      } catch (error) {
        retryAt = now() + Math.max(0, Number(retryMs) || 0);
        return {
          ...current({ refreshing: false }),
          error: errorMessage(error),
          retryAt: new Date(retryAt).toISOString(),
        };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function invalidate() {
    retryAt = 0;
    if (!cached) return;
    cached = { ...cached, checkedAt: new Date(0).toISOString() };
    try { writeSnapshot(cacheFile, cached); } catch {}
  }

  return { current, refresh, invalidate };
}

export const _test = { readSnapshot, writeSnapshot };
