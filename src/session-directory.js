import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexHome, claudeDesktopSessionsDir, claudeHome, storeDir } from "./host-paths.js";
import {
  RECENT_ROLLOUT_ACTIVITY_MS,
  THREAD_MAX_AGE_MS,
  listRecentRollouts,
  parseSessionIndex,
  readRolloutActivity,
  readRolloutMeta,
} from "./codex-inject.js";
import { discoverTerminalSessionBindings } from "./terminal-sessions.js";

const MAX_SESSIONS_PER_PROVIDER = 250;
export const OPEN_TURN_STALE_MS = 30 * 60 * 1000;
const CLAUDE_DESKTOP_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

function anonymousSessionKeys() {
  const rows = readJson(path.join(storeDir(), "anonymous-sessions.json"));
  return new Set((Array.isArray(rows?.sessions) ? rows.sessions : []).map((row) => `${row.provider}:${row.nativeId}`));
}

/** Keep one-shot chat invocations out of the user-visible AI-session directory. */
export function recordAnonymousSession(provider, nativeId) {
  if (!provider || !nativeId) return;
  const filePath = path.join(storeDir(), "anonymous-sessions.json");
  const current = readJson(filePath);
  const rows = (Array.isArray(current?.sessions) ? current.sessions : [])
    .filter((row) => `${row.provider}:${row.nativeId}` !== `${provider}:${nativeId}`);
  rows.push({ provider, nativeId, recordedAt: Date.now() });
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ sessions: rows.slice(-1000) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

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

export function claudeTranscriptPath(configDir, cwd, sessionId) {
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
  const anonymous = anonymousSessionKeys();
  const index = indexRows(homeDir);
  const rollouts = listRecentRollouts(path.join(homeDir, "sessions"), { nowMs, dayLookback: 90 });
  const rows = [];
  for (const rollout of rollouts.values()) {
    if (anonymous.has(`codex:${rollout.threadId}`)) continue;
    const meta = readRolloutMeta(rollout.sessionPath);
    if (!meta || meta.subagent) continue;
    const activity = readRolloutActivity(rollout.sessionPath);
    const recentlyLive = nowMs - Math.max(rollout.mtimeMs, activity.lastEventAt || 0) <= THREAD_MAX_AGE_MS;
    // A live turn keeps writing (token counts, items). An open task_started whose
    // rollout has been silent for longer than any real model turn is a turn that
    // died with its owner (a killed app-server, a crash): idle, not "working now".
    const openTurnFresh = nowMs - Math.max(rollout.mtimeMs, activity.lastEventAt || 0) <= OPEN_TURN_STALE_MS;
    const busy = (activity.busy && recentlyLive && openTurnFresh) || (
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
      lastMessageAt: new Date(activity.lastMessageAt || lastActiveAt || nowMs).toISOString(),
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

// Claude Desktop 1.40609.0 keeps its live registry addressable but no longer
// writes `status` or `updatedAt`. The transcript is the authoritative turn
// lifecycle in that build: a user/tool-result or unfinished assistant row is
// active; an assistant end_turn is idle. Ignore metadata rows after the turn.
export function readClaudeTranscriptActivity(transcriptPath, { tailBytes = 1024 * 1024 } = {}) {
  const filePath = String(transcriptPath || "").trim();
  if (!filePath) return { state: "unknown", lastEventAt: null, lastMessageAt: null };
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, tailBytes);
    if (!length) return { state: "unknown", lastEventAt: null, lastMessageAt: null };
    const buffer = Buffer.alloc(length);
    const position = size - length;
    fs.readSync(handle, buffer, 0, length, position);
    const lines = buffer.toString("utf8").split("\n");
    if (position > 0) lines.shift();
    let state = "unknown";
    let lastEventAt = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const role = String(row?.message?.role || "");
      if (row?.type === "user" || role === "user") {
        state = "active";
      } else if (row?.type === "assistant" || role === "assistant") {
        const stopReason = String(row?.message?.stop_reason || "").toLowerCase();
        state = stopReason && stopReason !== "tool_use" ? "idle" : "active";
      } else {
        continue;
      }
      const at = Date.parse(row.timestamp || row.createdAt || 0);
      if (Number.isFinite(at)) lastEventAt = Math.max(lastEventAt || 0, at);
    }
    return { state, lastEventAt, lastMessageAt: lastEventAt };
  } catch {
    return { state: "unknown", lastEventAt: null, lastMessageAt: null };
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch {}
    }
  }
}

function liveClaudeState(registration, transcriptPath, recoverable) {
  const registryState = registration ? claudeState(registration) : recoverable ? "idle" : "offline";
  // A transcript can refine a LIVE registry's missing busy flag. It cannot
  // make a dead process active: a crashed turn often ends on a user/tool row.
  if (!registration?.socketLive || registryState !== "idle") return registryState;
  const transcriptState = readClaudeTranscriptActivity(transcriptPath).state;
  return transcriptState === "active" ? "active" : registryState;
}

export function discoverClaudeSessions({
  configDir = process.env.CLAUDE_CONFIG_DIR || claudeHome(),
  desktopDir = claudeDesktopSessionsDir(),
  nowMs = Date.now(),
} = {}) {
  const anonymous = anonymousSessionKeys();
  const live = liveClaudeRegistrations(configDir);
  const byId = new Map();
  const metadataFiles = collectFiles(desktopDir, (name) => /^local_.*\.json$/.test(name));
  for (const filePath of metadataFiles) {
    const row = readJson(filePath);
    const nativeId = String(row?.cliSessionId || "").trim();
    if (!nativeId || anonymous.has(`claude:${nativeId}`) || row.isArchived || row.transcriptUnavailable) continue;
    const lastActiveAt = Number(row.lastActivityAt || row.lastFocusedAt || row.createdAt || 0);
    if (!lastActiveAt || nowMs - lastActiveAt > CLAUDE_DESKTOP_LOOKBACK_MS) continue;
    const registration = live.get(nativeId);
    const cwd = String(row.cwd || "");
    const transcriptPath = claudeTranscriptPath(configDir, cwd, nativeId);
    const transcriptActivity = readClaudeTranscriptActivity(transcriptPath);
    const recoverable = Boolean(transcriptPath);
    byId.set(nativeId, {
      provider: "claude",
      placement: sessionPlacement(),
      placementId: sessionPlacementId(),
      nativeId,
      title: String(row.title || `Claude ${nativeId.slice(0, 8)}`),
      projectName: basenameProject(cwd),
      cwd,
      state: liveClaudeState(registration, transcriptPath, recoverable),
      lastActiveAt: new Date(Math.max(lastActiveAt, registration?.updatedAt || 0)).toISOString(),
      lastMessageAt: new Date(transcriptActivity.lastMessageAt || lastActiveAt).toISOString(),
      nativeRef: {
        sessionId: nativeId,
        desktopSessionId: row.sessionId,
        metadataPath: filePath,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(registration?.messagingSocketPath ? { messagingSocketPath: registration.messagingSocketPath } : {}),
        ...(registration?.pid || registration?.cliPid ? { pid: registration.pid || registration.cliPid } : {}),
      },
      capabilities: { send: recoverable || Boolean(registration?.socketLive), start: true, nativeUi: true },
    });
  }
  // CLI/background sessions may have no Desktop metadata. The official live
  // registry is authoritative for their address and state.
  for (const [nativeId, registration] of live) {
    if (anonymous.has(`claude:${nativeId}`) || byId.has(nativeId)) continue;
    const cwd = String(registration.cwd || "");
    const transcriptPath = claudeTranscriptPath(configDir, cwd, nativeId);
    const transcriptActivity = readClaudeTranscriptActivity(transcriptPath);
    byId.set(nativeId, {
      provider: "claude",
      placement: sessionPlacement(),
      placementId: sessionPlacementId(),
      nativeId,
      title: String(registration.name || registration.title || `Claude ${nativeId.slice(0, 8)}`),
      projectName: basenameProject(cwd),
      cwd,
      state: liveClaudeState(registration, transcriptPath, Boolean(transcriptPath)),
      lastActiveAt: new Date(registration.updatedAt || registration.startedAt || nowMs).toISOString(),
      lastMessageAt: new Date(transcriptActivity.lastMessageAt || registration.updatedAt || registration.startedAt || nowMs).toISOString(),
      nativeRef: {
        sessionId: nativeId,
        ...(transcriptPath ? { transcriptPath } : {}),
        messagingSocketPath: registration.messagingSocketPath,
        ...(registration.pid || registration.cliPid ? { pid: registration.pid || registration.cliPid } : {}),
      },
      capabilities: { send: Boolean(registration.socketLive), start: true, nativeUi: true },
    });
  }
  const controlled = readJson(path.join(storeDir(), "controlled-sessions.json"));
  for (const saved of Array.isArray(controlled?.sessions) ? controlled.sessions : []) {
    if (saved?.provider !== "claude" || !saved.nativeId || anonymous.has(`claude:${saved.nativeId}`) || byId.has(saved.nativeId)) continue;
    const registration = live.get(saved.nativeId);
    const transcriptPath = String(saved.transcriptPath || "");
    const transcriptActivity = readClaudeTranscriptActivity(transcriptPath);
    const recoverable = Boolean(transcriptPath && fs.existsSync(transcriptPath));
    byId.set(saved.nativeId, {
      provider: "claude",
      placement: saved.placement || sessionPlacement(),
      placementId: saved.placementId || sessionPlacementId(),
      nativeId: saved.nativeId,
      title: saved.title || `Claude ${String(saved.nativeId).slice(0, 8)}`,
      projectName: basenameProject(saved.cwd),
      cwd: saved.cwd || "",
      state: liveClaudeState(registration, transcriptPath, recoverable),
      lastActiveAt: new Date(Math.max(Number(saved.lastActiveAt || 0), registration?.updatedAt || 0)).toISOString(),
      lastMessageAt: new Date(transcriptActivity.lastMessageAt || Number(saved.lastActiveAt || 0) || registration?.updatedAt || nowMs).toISOString(),
      nativeRef: {
        sessionId: saved.nativeId,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(registration?.messagingSocketPath ? { messagingSocketPath: registration.messagingSocketPath } : {}),
        ...(registration?.pid || registration?.cliPid ? { pid: registration.pid || registration.cliPid } : {}),
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

export function enrichTerminalSessions(sessions, terminalBindings = new Map()) {
  return sessions.map((session) => {
    const terminalRef = terminalBindings.get(`${session.provider}:${session.nativeId}`)
      || terminalBindings.get(`pid:${session.nativeRef?.pid || ""}`);
    if (!terminalRef) return session;
    return {
      ...session,
      surface: "terminal",
      terminalRef,
      nativeRef: { ...session.nativeRef, terminalRef },
      capabilities: session.provider === "codex" && !terminalRef.managedRemote
        ? {
            ...session.capabilities,
            send: false,
            unavailableReason: "Restart this Codex task through Relay once so Relay and Terminal can share its supported remote owner.",
          }
        : session.capabilities,
    };
  });
}

export function discoverSessions(options = {}) {
  const terminalBindings = options.terminalBindings || discoverTerminalSessionBindings(options.terminal);
  const sessions = options.provider === "codex"
    ? discoverCodexSessions(options.codex)
    : options.provider === "claude"
      ? discoverClaudeSessions(options.claude)
      : [...discoverCodexSessions(options.codex), ...discoverClaudeSessions(options.claude)];
  return enrichTerminalSessions(sessions, terminalBindings);
}

export { discoverTerminalSessionBindings };

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
