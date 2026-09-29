"use strict";
// Independently scheduled, upload-only capability; never reads a device token.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const d = require("./diagnostics.cjs");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const { acquireCanonicalLock } = require("./recovery-launcher.cjs");
const ORIGINS = ["https://api.sendrelays.com", "https://dev-api.sendrelays.com", "https://staging-api.sendrelays.com"];
function origin(value) { try { const u = new URL(value); return ORIGINS.includes(u.origin) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash ? u.origin : null; } catch { return null; } }
const files = homeDir => ({ root: path.join(homeDir, ".relay", "diagnostics"), auth: path.join(homeDir, ".relay", "diagnostics", "authorization.json") });
const validExpiry = (value, now) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > now && Date.parse(value) <= now + 31 * 86400000;
function saveAuthorization(value, identity, { homeDir = os.homedir(), now = Date.now } = {}) {
  try {
    const current = d.configIdentity(homeDir);
    if (!current || current.scope !== identity.scope || value.deviceId !== current.deviceId || value.userId !== current.userId
      || !/^dgt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token || "") || value.token.length > 2048
      || !origin(identity.origin) || !validExpiry(value.expiresAt, now())) return false;
    atomicFile(files(homeDir).auth, JSON.stringify({ token: value.token, deviceId: value.deviceId, userId: value.userId, expiresAt: value.expiresAt, origin: identity.origin, scope: current.scope }));
    return true;
  } catch { return false; }
}
async function report({ homeDir = os.homedir(), now = Date.now, fetchImpl = fetch } = {}) {
  const { root, auth } = files(homeDir), lock = path.join(root, "upload.lock");
  let lease, stateFile, state;
  try {
    if (require("./recovery-intent.cjs").stopped(homeDir)) return { status: "intentionally-stopped" };
    const identity = d.configIdentity(homeDir), authorization = d.read(auth);
    if (!identity || authorization?.scope !== identity.scope || authorization.deviceId !== identity.deviceId
      || authorization.userId !== identity.userId || !origin(authorization.origin)
      || origin(identity.config.apiUrl || "https://api.sendrelays.com") !== authorization.origin
      || !validExpiry(authorization.expiresAt, now()) || authorization.token?.length > 2048 || !/^dgt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization.token || "")) return { status: "unauthorized" };
    stateFile = path.join(root, identity.scope, "upload.json"); state = d.read(stateFile);
    if (state?.attemptAt <= now() && now() - state.attemptAt < 5 * 60000) return { status: "cooldown" };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Use the existing process-identity lock protocol on our own file. Never
    // steal a live lease or release a newer uploader's lock after suspension.
    try { lease = acquireCanonicalLock(lock); } catch { return { status: "busy" }; }
    const acceptedIds = Array.isArray(state?.acceptedIds) ? state.acceptedIds.filter(id => /^[a-f0-9-]{36}$/.test(id)).slice(-256) : [];
    atomicFile(stateFile, JSON.stringify({ attemptAt: now(), status: "uploading", acceptedIds, receivedAt: state?.receivedAt || null }));
    const history = d.events(homeDir, identity.scope).filter(item => now() - Date.parse(item.value.at) <= d.MAX_AGE_MS && !acceptedIds.includes(item.value.id)).slice(0, 128).map(item => item.value);
    const body = { schema: 1, snapshot: d.snapshot({ homeDir, now }), events: history };
    if (Buffer.byteLength(JSON.stringify(body)) > 131072) throw Error("report-too-large");
    // Recheck account binding after reading the history, before network I/O.
    if (d.configIdentity(homeDir)?.scope !== identity.scope) return { status: "account-changed" };
    const response = await fetchImpl(`${authorization.origin}/v1/devices/diagnostics`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authorization.token}` }, body: JSON.stringify(body),
    });
    const status = response.ok ? "uploaded" : response.status === 401 ? "authorization-expired" : "upload-rejected";
    // Do not ingest remote body text into local diagnostic records.
    await response.body?.cancel?.();
    atomicFile(stateFile, JSON.stringify({ attemptAt: now(), status,
      acceptedIds: response.ok ? [...new Set([...acceptedIds, ...history.map(e => e.id)])].slice(-256) : acceptedIds,
      receivedAt: response.ok ? new Date(now()).toISOString() : state?.receivedAt || null }));
    if (response.status === 401 && d.read(auth)?.token === authorization.token) fs.unlinkSync(auth);
    return { status };
  } catch (error) {
    try { if (lease && stateFile) atomicFile(stateFile, JSON.stringify({ attemptAt: now(), status: "upload-failed", error: d.errorCode(error),
      acceptedIds: Array.isArray(state?.acceptedIds) ? state.acceptedIds.slice(-256) : [], receivedAt: state?.receivedAt || null })); } catch {}
    return { status: "upload-failed" };
  } finally { try { lease?.release(); } catch {} }
}
module.exports = { report, saveAuthorization, origin, files };
if (require.main === module) {
  // A stalled native/network dependency must not leave an orphan forever.
  const deadline = setTimeout(() => process.exit(0), 15000);
  report().finally(() => { clearTimeout(deadline); process.exit(0); });
}
