// Codex rollout writer. Ported faithfully from
// granular/tools/relay-companion/src/codex-session-writer.js (only the codexHome
// import points at this package's host-paths.js). Appends a visible assistant
// turn to a thread's .jsonl rollout and inserts the zero-width "index marker"
// user event so Codex Desktop's default local-thread route will index the thread.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./host-paths.js";

const CODEX_THREAD_INDEX_MARKER = "\u200b";
export const DEFAULT_CODEX_OPEN_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_OPEN_EFFORT = "high";

export function appendVisibleAssistantTurn({
  sessionPath,
  text,
  cwd = process.cwd(),
  workspaceRoots = [cwd],
  currentDate = isoDate(),
  timezone = localTimezone(),
  model = DEFAULT_CODEX_OPEN_MODEL,
  effort = DEFAULT_CODEX_OPEN_EFFORT,
}) {
  if (!sessionPath) throw new Error("sessionPath is required");
  if (!text || !String(text).trim()) throw new Error("assistant turn text is required");
  const resolvedPath = path.resolve(sessionPath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Codex session does not exist: ${resolvedPath}`);

  const timestamp = new Date().toISOString();
  const turnId = crypto.randomUUID();
  const messageId = `msg_relay_${crypto.randomBytes(16).toString("hex")}`;
  const cleanText = String(text);
  const cleanModel = String(model || "").trim() || DEFAULT_CODEX_OPEN_MODEL;
  const cleanEffort = String(effort || "").trim() || DEFAULT_CODEX_OPEN_EFFORT;
  const cleanWorkspaceRoots = uniqueWorkspaceRoots(workspaceRoots, cwd);
  const lineEnvelope = {
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      workspace_roots: cleanWorkspaceRoots,
      current_date: currentDate,
      timezone,
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      model: cleanModel,
      personality: "pragmatic",
      collaboration_mode: {
        mode: "default",
        settings: {
          model: cleanModel,
          reasoning_effort: cleanEffort,
          developer_instructions: null,
        },
      },
      multi_agent_version: "v1",
      realtime_active: false,
      effort: cleanEffort,
      summary: "auto",
    },
  };
  const lines = [
    // Codex Desktop's thread loader replays events to reconstruct turn state; a
    // task_complete whose turn never task_started leaves the view stuck on its
    // loading spinner forever. Mirror the native turn envelope exactly.
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        started_at: Math.floor(Date.now() / 1000),
        model_context_window: 258400,
        collaboration_mode_kind: "default",
      },
    },
    lineEnvelope,
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: cleanText,
        phase: "final_answer",
        memory_citation: null,
      },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        id: messageId,
        role: "assistant",
        content: [{ type: "output_text", text: cleanText }],
        phase: "final_answer",
        metadata: { turn_id: turnId },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        last_agent_message: cleanText,
        completed_at: Math.floor(Date.now() / 1000),
        duration_ms: 0,
        time_to_first_token_ms: 0,
      },
    },
  ];

  fs.appendFileSync(resolvedPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { sessionPath: resolvedPath, turnId, messageId };
}

function uniqueWorkspaceRoots(workspaceRoots, cwd) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  const ordered = [cwd, ...roots]
    .map((root) => String(root || "").trim())
    .filter(Boolean);
  const seen = new Set();
  return ordered.filter((root) => {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function ensureCodexThreadIndexMarker({ sessionPath, markerId = "" }) {
  if (!sessionPath) throw new Error("sessionPath is required");
  const resolvedPath = path.resolve(sessionPath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Codex session does not exist: ${resolvedPath}`);

  const clientId = `relay_index_${safeMarkerId(markerId) || crypto.randomBytes(8).toString("hex")}`;
  const text = fs.readFileSync(resolvedPath, "utf8");
  if (text.includes(`"client_id":"${clientId}"`) || text.includes(`"clientId":"${clientId}"`)) {
    return { sessionPath: resolvedPath, inserted: false, clientId };
  }

  const lines = text.trimEnd().split("\n").filter(Boolean);
  const insertAt = lines.findIndex((line) => {
    try {
      return JSON.parse(line)?.type === "session_meta";
    } catch {
      return false;
    }
  });
  // Codex Desktop's default local-thread route ignores assistant-only rollouts.
  // This zero-width user event makes the session indexable without making the Relay body user-authored.
  const marker = {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "user_message",
      client_id: clientId,
      message: CODEX_THREAD_INDEX_MARKER,
      images: [],
      local_images: [],
      text_elements: [],
      metadata: { relaySynthetic: true, indexOnly: true },
    },
  };

  lines.splice(insertAt >= 0 ? insertAt + 1 : 0, 0, JSON.stringify(marker));
  // Atomic rewrite: a plain writeFileSync onto the live rollout can truncate it if
  // the process dies mid-write (or if Codex reads it concurrently), permanently
  // corrupting the thread. Write a sibling temp then rename onto the target.
  const tmp = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`);
  fs.renameSync(tmp, resolvedPath);
  return { sessionPath: resolvedPath, inserted: true, clientId };
}

export function findCodexSessionPath(threadId, sessionsRoot = path.join(codexHome(), "sessions")) {
  if (!threadId || !fs.existsSync(sessionsRoot)) return null;
  const stack = [sessionsRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        return entryPath;
      }
    }
  }
  return null;
}

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function safeMarkerId(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}
