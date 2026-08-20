import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexHome, claudeDesktopSessionsDir, claudeHome, storeDir } from "./host-paths.js";
import {
  RECENT_ROLLOUT_ACTIVITY_MS,
  listRecentRollouts,
  parseSessionIndex,
  readRolloutActivity,
  readRolloutMeta,
} from "./codex-inject.js";

const MAX_SESSIONS_PER_PROVIDER = 250;
const CLAUDE_DESKTOP_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function basenameProject(cwd) {
  const value = String(cwd || "").replace(/\/+$/, "");
  return value ? path.basename(value) : "";
}

function claudeProjectKey(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeTranscriptPath(configDir, cwd, sessionId) {
  const direct = path.join(configDir, "projects", claudeProjectKey(cwd), `${sessionId}.jsonl`);
  if (cwd && fs.existsSync(direct)) return direct;
  // Desktop metadata occasionally outlives a project rename. Fall back to an
  // exact filename search so a recoverable idle chat never appears offline.
  const matches = collectFiles(
    path.join(configDir, "projects"),
    (name) => name === `${sessionId}.jsonl`,
    { maxDepth: 2, maxFiles: 1 },
  );
  return matches[0] || "";
}

export function sessionPlacement() {
  return process.env.RELAY_SESSION_PLACEMENT === "cloud" ? "cloud" : "local";
}

export function sessionPlacementId() {
  return String(process.env.RELAY_PLACEMENT_ID || process.env.RELAY_CLOUD_ENVIRONMENT_ID || os.hostname());
}

function collectFiles(root, accept, { maxDepth = 4, maxFiles = 4000 } = {}) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath, depth + 1);
      else if (entry.isFile() && accept(entry.name, filePath)) found.push(filePath);
    }
  };
  visit(root, 0);
  return found;
}

function indexRows(homeDir) {
  try {
    return parseSessionIndex(fs.readFileSync(path.join(homeDir, "session_index.jsonl"), "utf8"));
  } catch {
    return new Map();
  }
}

export function discoverCodexSessions({ homeDir = codexHome(), nowMs = Date.now() } = {}) {
  const index = indexRows(homeDir);
  const rollouts = listRecentRollouts(path.join(homeDir, "sessions"), { nowMs, dayLookback: 90 });
  const rows = [];
  for (const rollout of rollouts.values()) {
    const meta = readRolloutMeta(rollout.sessionPath);
    if (!meta || meta.subagent) continue;
    const activity = readRolloutActivity(rollout.sessionPath);
    const busy = activity.busy || (
      !activity.lifecycleObserved && nowMs - rollout.mtimeMs <= RECENT_ROLLOUT_ACTIVITY_MS
    );
    const indexed = index.get(rollout.threadId);
    const lastActiveAt = Math.max(rollout.mtimeMs, indexed?.updatedAtMs || 0, activity.lastEventAt || 0);
    rows.push({
      provider: "codex",
      placement: sessionPlacement(),
      placementId: sessionPlacementId(),
      nativeId: rollout.threadId,
      title: indexed?.threadName || `Codex ${rollout.threadId.slice(0, 8)}`,
      projectName: basenameProject(meta.cwd),
      cwd: meta.cwd,
      state: busy ? "active" : "idle",
      lastActiveAt: new Date(lastActiveAt || nowMs).toISOString(),
      nativeRef: {
        threadId: rollout.threadId,
        sessionPath: rollout.sessionPath,
        ...(activity.openTurnId ? { openTurnId: activity.openTurnId } : {}),
      },
      capabilities: { send: true, start: true, nativeUi: true },
    });
  }
  return rows.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)).slice(0, MAX_SESSIONS_PER_PROVIDER);
}

// Exported for the task preview's session face: it needs "is this forged
// session live, and through which socket" without the full directory sweep.
export function liveClaudeRegistrations(configDir = process.env.CLAUDE_CONFIG_DIR || claudeHome()) {
  const dir = process.env.RELAY_CLAUDE_SESSION_REGISTRY_DIR || path.join(configDir, "sessions");
  const bySession = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return bySession;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const row = readJson(path.join(dir, name));
    if (!row?.sessionId) continue;
    const socketPath = String(row.messagingSocketPath || "");
    // Unix leaves the socket file behind if a provider worker exits abruptly.
    // A pathname is not a live session; the exact registered pid must exist.
    const socketLive = Boolean(socketPath && fs.existsSync(socketPath) && processIsAlive(row.pid || row.cliPid));
    const updatedAt = Number(row.updatedAt || row.startedAt || 0);
    const existing = bySession.get(row.sessionId);
    if (!existing || updatedAt >= existing.updatedAt) bySession.set(row.sessionId, { ...row, socketLive, updatedAt });
  }
  return bySession;
}

export function claudeState(registration) {
  if (!registration?.socketLive) return "offline";
  const status = String(registration.status || "").toLowerCase();
  if (["running", "busy", "working", "active"].includes(status)) return "active";
  if (["waiting", "needs_input", "permission", "approval"].includes(status)) return "needs_input";
  if (["failed", "error"].includes(status)) return "failed";
  return "idle";
}

export function discoverClaudeSessions({
  configDir = process.env.CLAUDE_CONFIG_DIR || claudeHome(),
  desktopDir = claudeDesktopSessionsDir(),
  nowMs = Date.now(),
} = {}) {
  const live = liveClaudeRegistrations(configDir);
  const byId = new Map();
  const metadataFiles = collectFiles(desktopDir, (name) => /^local_.*\.json$/.test(name));
  for (const filePath of metadataFiles) {
    const row = readJson(filePath);
    const nativeId = String(row?.cliSessionId || "").trim();
    if (!nativeId || row.isArchived || row.transcriptUnavailable) continue;
    const lastActiveAt = Number(row.lastActivityAt || row.lastFocusedAt || row.createdAt || 0);
    if (!lastActiveAt || nowMs - lastActiveAt > CLAUDE_DESKTOP_LOOKBACK_MS) continue;
    const registration = live.get(nativeId);
    const cwd = String(row.cwd || "");
    const transcriptPath = claudeTranscriptPath(configDir, cwd, nativeId);
    const recoverable = Boolean(transcriptPath);
    byId.set(nativeId, {
      provider: "claude",
      placement: sessionPlacement(),
      placementId: sessionPlacementId(),
      nativeId,
      title: String(row.title || `Claude ${nativeId.slice(0, 8)}`),
      projectName: basenameProject(cwd),
      cwd,
      state: registration ? claudeState(registration) : recoverable ? "idle" : "offline",
      lastActiveAt: new Date(Math.max(lastActiveAt, registration?.updatedAt || 0)).toISOString(),
      nativeRef: {
        sessionId: nativeId,
        desktopSessionId: row.sessionId,
        metadataPath: filePath,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(registration?.messagingSocketPath ? { messagingSocketPath: registration.messagingSocketPath } : {}),
      },
      capabilities: { send: recoverable || Boolean(registration?.socketLive), start: true, nativeUi: true },
    });
  }
  // CLI/background sessions may have no Desktop metadata. The official live
  // registry is authoritative for their address and state.
  for (const [nativeId, registration] of live) {
    if (byId.has(nativeId)) continue;
    const cwd = String(registration.cwd || "");
    const transcriptPath = claudeTranscriptPath(configDir, cwd, nativeId);
    byId.set(nativeId, {
      provider: "claude",
      placement: sessionPlacement(),
      placementId: sessionPlacementId(),
      nativeId,
      title: String(registration.name || registration.title || `Claude ${nativeId.slice(0, 8)}`),
      projectName: basenameProject(cwd),
      cwd,
      state: claudeState(registration),
      lastActiveAt: new Date(registration.updatedAt || registration.startedAt || nowMs).toISOString(),
      nativeRef: {
        sessionId: nativeId,
        ...(transcriptPath ? { transcriptPath } : {}),
        messagingSocketPath: registration.messagingSocketPath,
      },
      capabilities: { send: Boolean(registration.socketLive), start: true, nativeUi: true },
    });
  }
  const controlled = readJson(path.join(storeDir(), "controlled-sessions.json"));
  for (const saved of Array.isArray(controlled?.sessions) ? controlled.sessions : []) {
    if (saved?.provider !== "claude" || !saved.nativeId || byId.has(saved.nativeId)) continue;
    const registration = live.get(saved.nativeId);
    const transcriptPath = String(saved.transcriptPath || "");
    const recoverable = Boolean(transcriptPath && fs.existsSync(transcriptPath));
    byId.set(saved.nativeId, {
      provider: "claude",
      placement: saved.placement || sessionPlacement(),
      placementId: saved.placementId || sessionPlacementId(),
      nativeId: saved.nativeId,
      title: saved.title || `Claude ${String(saved.nativeId).slice(0, 8)}`,
      projectName: basenameProject(saved.cwd),
      cwd: saved.cwd || "",
      state: registration ? claudeState(registration) : recoverable ? "idle" : "offline",
      lastActiveAt: new Date(Math.max(Number(saved.lastActiveAt || 0), registration?.updatedAt || 0)).toISOString(),
      nativeRef: {
        sessionId: saved.nativeId,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(registration?.messagingSocketPath ? { messagingSocketPath: registration.messagingSocketPath } : {}),
      },
      capabilities: { send: recoverable || Boolean(registration?.socketLive), start: true, nativeUi: true },
    });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .slice(0, MAX_SESSIONS_PER_PROVIDER);
}

export function recordControlledSession(session) {
  const filePath = path.join(storeDir(), "controlled-sessions.json");
  const current = readJson(filePath);
  const sessions = Array.isArray(current?.sessions) ? current.sessions : [];
  const key = `${session.provider}:${session.placement || sessionPlacement()}:${session.placementId || sessionPlacementId()}:${session.nativeId}`;
  const next = sessions.filter(
    (row) => `${row.provider}:${row.placement}:${row.placementId}:${row.nativeId}` !== key,
  );
  next.push({
    ...session,
    placement: session.placement || sessionPlacement(),
    placementId: session.placementId || sessionPlacementId(),
    lastActiveAt: session.lastActiveAt || Date.now(),
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ sessions: next.slice(-500) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function discoverSessions(options = {}) {
  return [...discoverCodexSessions(options.codex), ...discoverClaudeSessions(options.claude)];
}

export function sessionDirectoryStatePath() {
  return path.join(storeDir(), "session-directory.json");
}

export function cachePublishedSessions(response) {
  const filePath = sessionDirectoryStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(response, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
