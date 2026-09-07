// A governor-free, live, injectable Claude Code session.
//
// The breakthrough (David + Claude, 2026-09-04, proven live): Claude Desktop
// caps the ENGINES it spawns (max(6, RAM/3GiB) — prewarms and previews
// included), so a Relay session opened by a link is a "warm" spawn Desktop
// yields at the cap. But an engine RELAY spawns itself never touches that
// governor. Spawned with the cross-session-messaging env var set, that engine
// registers in ~/.claude/sessions and binds its inbox socket at
// /tmp/cc-socks/<pid>.sock. Posting one JSON line to that socket wakes the
// idle session into a real turn — Claude's own message system, not a forged
// user bubble. Desktop then imports the SAME session id to display it.
//
// Two traps that made earlier attempts fail, both handled here:
//   1. The registry publishes the socket only when CLAUDE_CODE_MESSAGING_SOCKET
//      is set (the --messaging-socket-path FLAG binds a file but never
//      registers, so nothing can route to it).
//   2. A child spawned from a live Claude session inherits
//      CLAUDE_CODE_CHILD_SESSION, which silently disables registration and
//      transcript saving. The whole Claude/Anthropic env must be scrubbed.
//
// The engine needs a PTY to stay interactive; macOS `/usr/bin/script` supplies
// one without a native pty addon.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedCliVersions, cliBinaryPath } from "./desktop-wake.js";
import { liveClaudeRegistrations } from "./session-directory.js";
import { storeDir } from "./host-paths.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One live engine per Relay session. The child is Relay-owned and detached, so
// it outlives the spawn call and keeps the session addressable for follow-ups.
const liveInboxSessions = new Map(); // sessionId -> { pid, child, startedAt }

function claudeBinary() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  // Desktop-only Macs have no `claude` on PATH; Desktop downloads the real CLI.
  try {
    const versions = installedCliVersions();
    const latest = versions[versions.length - 1];
    if (latest) {
      const downloaded = cliBinaryPath(latest);
      if (downloaded && fs.existsSync(downloaded)) return downloaded;
    }
  } catch {}
  for (const c of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(os.homedir(), ".local/bin/claude")]) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return "claude";
}

// The live socket for a session, read from the official registry (empty until
// the engine has registered and its pid is alive).
export function claudeInboxSocketPath(sessionId, registrations = liveClaudeRegistrations) {
  const row = registrations().get(String(sessionId || ""));
  return row?.socketLive ? String(row.messagingSocketPath || "") : "";
}

// A socket appears the moment the engine binds it, seconds before the session
// can accept a turn. Injecting into that window is silently dropped (live,
// 2026-09-04), so readiness is the registry's own status, not the socket file.
function inboxSessionReady(sessionId, registrations) {
  const row = registrations().get(String(sessionId || ""));
  if (!row?.socketLive) return false;
  const status = String(row.status || "").toLowerCase();
  return status === "idle" || status === "ready" || status === "active";
}

export function claudeInboxSessionAlive(sessionId) {
  const entry = liveInboxSessions.get(String(sessionId || ""));
  if (!entry) return false;
  try { process.kill(entry.pid, 0); return true; } catch { return false; }
}

// Env with every inherited Claude/Anthropic var removed (trap #2), plus the
// two vars that turn the messaging socket on and keep the session standalone.
function inboxEnv(socketPath) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) continue;
    env[k] = v;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.CLAUDE_CODE_MESSAGING_SOCKET = socketPath; // trap #1: enables registration
  env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
  return env;
}

/**
 * Ensure a governor-free live engine owns `sessionId` (whose transcript already
 * carries the Relay as its assistant letter) and return the socket to inject
 * the human's turn into. Idempotent: a session already live is reused.
 */
export async function startClaudeInboxSession({
  sessionId,
  cwd,
  model = "claude-opus-5",
  effort = "high",
  permissionMode = "auto",
  timeoutMs = 30_000,
  spawnImpl = spawn,
  registrations = liveClaudeRegistrations,
} = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("startClaudeInboxSession requires a session id");

  const already = claudeInboxSocketPath(sid, registrations);
  if (already && claudeInboxSessionAlive(sid)) return { sessionId: sid, socketPath: already, reused: true };

  // A private, non-symlink directory the CLI accepts for its socket preference.
  const socketDir = path.join(storeDir(), "claude-inbox-sockets");
  try { fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 }); } catch {}
  const preferredSocket = path.join(socketDir, `${sid}.sock`);

  const bin = claudeBinary();
  const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const args = ["-q", "/dev/null", bin, "--resume", sid, "--model", model, "--permission-mode", permissionMode];
  const child = spawnImpl("/usr/bin/script", args, {
    cwd: workDir,
    env: inboxEnv(preferredSocket),
    detached: true,
    stdio: "ignore",
  });
  child.on?.("error", (error) => console.error("[claude-inbox] spawn failed:", sid, error && error.message));
  child.unref?.();
  liveInboxSessions.set(sid, { pid: child.pid, child, startedAt: Date.now() });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socketPath = claudeInboxSocketPath(sid, registrations);
    if (socketPath && inboxSessionReady(sid, registrations)) return { sessionId: sid, socketPath, pid: child.pid };
    if (Date.now() >= deadline) {
      stopClaudeInboxSession(sid);
      const error = new Error(`Claude inbox session ${sid} did not register within ${timeoutMs}ms`);
      error.code = "SESSION_TARGET_UNAVAILABLE";
      throw error;
    }
    await sleep(200);
  }
}

export function stopClaudeInboxSession(sessionId) {
  const sid = String(sessionId || "");
  const entry = liveInboxSessions.get(sid);
  if (!entry) return false;
  liveInboxSessions.delete(sid);
  // Kill the `script` wrapper's whole process group so the claude child dies too.
  try { process.kill(-entry.pid, "SIGTERM"); } catch { try { process.kill(entry.pid, "SIGTERM"); } catch {} }
  return true;
}

export function stopAllClaudeInboxSessions() {
  for (const sid of [...liveInboxSessions.keys()]) stopClaudeInboxSession(sid);
}
