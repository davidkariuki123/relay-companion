// Codex thread state writers. Ported faithfully from
// granular/tools/relay-companion/src/codex-state.js (paths -> host-paths.js,
// writeJsonAtomic -> host-json.js). Sets danger-full-access permissions in the
// Codex global-state atom and writes the threads-table row (title/preview/cwd/
// recency) into Codex's sqlite state DB so the thread shows in the recents rail.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { codexGlobalStatePath, codexStateDbPath } from "./host-paths.js";
import { writeJsonAtomic } from "./host-json.js";

// A materialized relay thread opens with content authored by ANOTHER person/agent
// (untrusted). Granting danger-full-access + approvalPolicy:"never" meant an injected
// instruction could auto-execute any command with no sandbox and no approval. Default
// materialized threads to Codex's usable-but-safe profile (workspace-write sandbox,
// on-request approvals) so injected content cannot silently run destructive commands.
// RELAY_CODEX_FULL_ACCESS=1 restores the old always-full-access behavior for users who
// deliberately want it.
const SAFE_THREAD_PERMISSIONS = {
  activePermissionProfile: { id: ":workspace-write", extends: null },
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "workspaceWrite" },
};
const FULL_ACCESS_THREAD_PERMISSIONS = {
  activePermissionProfile: { id: ":danger-full-access", extends: null },
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "dangerFullAccess" },
};
function defaultThreadPermissions() {
  return process.env.RELAY_CODEX_FULL_ACCESS === "1" ? FULL_ACCESS_THREAD_PERMISSIONS : SAFE_THREAD_PERMISSIONS;
}

export function finalizeCodexThreadState({ threadId, title, cwd, preview }) {
  if (!threadId) throw new Error("threadId is required");
  const permissions = ensureCodexThreadPermissions(threadId);
  const stateDb = updateCodexThreadStateDb({ threadId, title, cwd, preview });
  return { permissions, stateDb };
}

export function ensureCodexThreadPermissions(threadId) {
  const filePath = codexGlobalStatePath();
  // Guard the read/parse of Codex Desktop's large live global-state file: an
  // unguarded JSON.parse on a mid-write/corrupt read would throw and abort the whole
  // open. On any read failure, do nothing rather than clobbering host state.
  let state;
  try {
    if (!fs.existsSync(filePath)) {
      state = {};
    } else {
      state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (error) {
    return { attempted: false, reason: "unreadable-state", filePath };
  }
  const atom = (state["electron-persisted-atom-state"] ||= {});
  const byId = (atom["heartbeat-thread-permissions-by-id"] ||= {});
  // Skip the write entirely when this thread already has a permission entry — the
  // ||= below would be a no-op, and rewriting ~350KB of live host state on every
  // open is both wasteful and a needless corruption window.
  if (byId[threadId]) return { attempted: false, reason: "already-present", filePath };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  byId[threadId] = defaultThreadPermissions();
  writeJsonAtomic(filePath, state);
  return { attempted: true, filePath };
}

export function updateCodexThreadStateDb({ threadId, title, cwd, preview }) {
  const dbPath = codexStateDbPath();
  if (!fs.existsSync(dbPath)) return { attempted: false, reason: "missing-state-db", dbPath };
  const cleanTitle = String(title || "").trim();
  const cleanPreview = String(preview || "").trim();
  const cleanCwd = cwd ? path.resolve(String(cwd)) : "";
  const updates = ["updated_at = strftime('%s','now')", "updated_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000"];
  if (cleanTitle) {
    updates.push(`title = ${sqlString(cleanTitle)}`);
  }
  if (cleanPreview) {
    updates.push(`preview = ${sqlString(cleanPreview)}`);
  }
  if (cleanCwd) {
    updates.push(`cwd = ${sqlString(cleanCwd)}`);
  }
  updates.push("recency_at = strftime('%s','now')");
  updates.push("recency_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000");

  const sql = `UPDATE threads SET ${updates.join(", ")} WHERE id = ${sqlString(threadId)};`;
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    return {
      attempted: true,
      ok: false,
      dbPath,
      error: result.stderr || result.stdout || "sqlite3 update failed",
    };
  }
  return { attempted: true, ok: true, dbPath };
}

// thread/start persists the threads row asynchronously after thread/name/set. Callers that stop a
// short-lived app-server must wait for this row before handing the thread id to the desktop app.
export function codexThreadRowExists(threadId) {
  const dbPath = codexStateDbPath();
  if (!threadId || !fs.existsSync(dbPath)) return false;
  const result = spawnSync("sqlite3", [dbPath, `SELECT count(*) FROM threads WHERE id = ${sqlString(threadId)};`], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && String(result.stdout || "").trim() !== "0";
}

// Cloud-row adapter: the original read packet.sender/briefingMarkdown/kind. The
// cloud companion row carries senderName + forHuman/briefingMarkdown +
// (optionally) kind, so derive the same preview line from whichever is present.
export function relayThreadPreview(row) {
  // Never surface the brand word "Relay" or the placeholder "Someone" as if it were
  // a person; the viewer's own agent is "Your agent".
  const rawSender = String(row.senderName || row.sender?.name || row.sender?.handle || "").trim();
  const sender = rawSender && !/^(relay|someone)$/i.test(rawSender) ? rawSender : "Your agent";
  const body = stripMarkdown(row.forHuman || row.briefingMarkdown || "");
  const kind = String(row.kind || row.relayNotificationKind || "").toLowerCase();
  const prefix = kind === "message" ? `${sender} sent this Relay message:` : `Relay from ${sender}:`;
  return truncatePreview(`${prefix} ${body}`.trim());
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/^#+\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncatePreview(value, maxLength = 1200) {
  const clean = String(value || "").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}
