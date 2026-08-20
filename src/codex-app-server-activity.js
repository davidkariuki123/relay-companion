import fs from "node:fs";
import { createWorkConversation, replayWorkEvents, turnPresentation } from "./work-conversation.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const OUTPUT_BUFFER_CHARS = 8 * 1024;
const OUTPUT_PREVIEW_CHARS = 240;

function isoFromMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function safeJson(value) {
  const seen = new WeakSet();
  const scrub = (item, key = "") => {
    if (/token|secret|password|authorization|cookie|api[-_]?key/i.test(key)) return "[redacted]";
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => scrub(child));
    return Object.fromEntries(Object.entries(item).slice(0, 100).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
  };
  try { return JSON.stringify(scrub(value)); }
  catch { return "{}"; }
}

function safeOutputPreview(value) {
  const lines = String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const useful = lines.filter((line) => !/^[\[\]{},]+$/.test(line));
  const progress = useful.findLast((line) => /\b(?:status|progress|running|waiting|complete|failed|success|deploying|digest|update_in_progress)\b/i.test(line));
  return (progress || useful.at(-1) || lines.at(-1))
    .replace(/((?:token|secret|password|authorization|cookie|api[-_]?key|credential)[\w.-]*)\s*([:=])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
    .slice(0, OUTPUT_PREVIEW_CHARS);
}

function appendOutput(entry, value, at) {
  const delta = String(value || "");
  if (!delta) return;
  entry.outputBuffer = `${entry.outputBuffer || ""}${delta}`.slice(-OUTPUT_BUFFER_CHARS);
  entry.outputPreview = safeOutputPreview(entry.outputBuffer);
  entry.outputAt = isoFromMs(at) || entry.outputAt || null;
}

function commandActivity(item) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const action = actions.at(-1) || {};
  const path = String(action.path || action.name || "").trim();
  if (action.type === "read") {
    return { tool: "Read", input: { file_path: path || "a file" } };
  }
  if (action.type === "listFiles") {
    return { tool: "ListFiles", input: { path: path || "files" } };
  }
  if (action.type === "search") {
    return { tool: "Grep", input: { pattern: String(action.query || action.pattern || "files").trim() } };
  }
  return { tool: "shell", input: { command: String(action.command || item.command || "a command").trim() } };
}

function fileChangeActivity(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes.map((change) => String(change?.path || change?.filePath || "").trim()).filter(Boolean);
  const direct = String(item.path || item.filePath || "").trim();
  return { tool: "apply_patch", input: { path: paths[0] || direct || "files", count: paths.length || (direct ? 1 : 0) } };
}

function activityFor(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "commandExecution") return commandActivity(item);
  if (item.type === "mcpToolCall") {
    const server = String(item.server || "mcp").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    const tool = String(item.tool || "tool").trim();
    return { tool: `mcp__${server}__${tool}`, input: item.arguments || {} };
  }
  if (item.type === "fileChange") return fileChangeActivity(item);
  if (item.type === "webSearch") {
    return { tool: "WebSearch", input: { query: String(item.query || item.action?.query || "the web").trim() } };
  }
  return null;
}

function readJsonLinesFromTail(logPath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    const lines = buffer.toString("utf8").split("\n");
    if (offset > 0) lines.shift();
    return lines.flatMap((line) => {
      try { return [JSON.parse(line)]; }
      catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Bounded raw hydration source for the main-process Work reducer. These events
 * stay in main; renderers receive only workPresentationSnapshot projections.
 */
export function readCodexAppServerEvents(logPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  return readJsonLinesFromTail(logPath, maxBytes).filter(
    (message) => message && typeof message === "object" && typeof message.method === "string",
  );
}

/**
 * Project Codex app-server notifications into the same safe activity records
 * used by Relay's Claude transcript reader. The outer rollout records every
 * code-mode host call as a bare `exec`; these native items preserve the exact
 * command action and MCP tool names that Codex Desktop itself renders.
 */
export function codexAppServerActivity(logPath, { turnId = "", maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!logPath || !fs.existsSync(logPath)) {
    return { records: [], startedAt: null, terminalAt: null, terminalStatus: "", presentation: null };
  }
  const wantedTurn = String(turnId || "");
  const messages = readJsonLinesFromTail(logPath, maxBytes).filter((message) => {
    if (!message || typeof message !== "object") return false;
    const params = message.params || {};
    const rowTurnId = String(params.turnId || params.turn?.id || "");
    return !wantedTurn || !rowTurnId || rowTurnId === wantedTurn;
  });
  const state = replayWorkEvents(messages, createWorkConversation({ provider: "codex" }));
  const selectedId = wantedTurn || state.turnOrder.at(-1) || "";
  const turn = state.turns[selectedId];
  if (!turn) return { records: [], startedAt: null, terminalAt: null, terminalStatus: "", presentation: null };
  const outputByItem = new Map();
  for (const message of messages) {
    const params = message.params || {};
    const id = String(params.itemId || params.item?.id || "");
    if (!id) continue;
    const entry = outputByItem.get(id) || { outputBuffer: "", outputPreview: "", outputAt: null };
    if (message.method === "item/commandExecution/outputDelta") appendOutput(entry, params.delta, message.emittedAtMs);
    if (message.method === "item/completed" && !entry.outputPreview) {
      appendOutput(entry, params.item?.aggregatedOutput, params.completedAtMs || message.emittedAtMs);
    }
    outputByItem.set(id, entry);
  }
  const items = turn.itemOrder.flatMap((id) => {
    const item = turn.items[id];
    const activity = activityFor(item?.raw);
    if (!activity) return [];
    const output = outputByItem.get(id) || {};
    return [{
      id,
      activity,
      startedAt: isoFromMs(item.startedAtMs),
      completedAt: isoFromMs(item.completedAtMs),
      failed: Boolean(item.raw?.error) || ["failed", "error"].includes(String(item.status || "").toLowerCase()),
      outputPreview: output.outputPreview || "",
      outputAt: output.outputAt || null,
    }];
  });

  const records = items.flatMap((entry) => {
    const call = {
      type: "tool_call",
      tool: entry.activity.tool,
      input: safeJson(entry.activity.input),
      at: entry.startedAt || entry.completedAt,
      nativeItemId: entry.id,
      ...(entry.outputPreview ? { outputPreview: entry.outputPreview, outputAt: entry.outputAt } : {}),
    };
    if (!entry.completedAt) return [call];
    return [{
      type: "tool_result",
      output: entry.failed ? "Failed" : "Completed",
      isError: entry.failed,
      at: entry.completedAt,
      nativeItemId: entry.id,
    }, call];
  }).sort((left, right) => {
    const byTime = Date.parse(String(right.at || "")) - Date.parse(String(left.at || ""));
    if (Number.isFinite(byTime) && byTime) return byTime;
    if (left.type === right.type) return 0;
    return left.type === "tool_result" ? -1 : 1;
  });

  return {
    records,
    startedAt: isoFromMs(turn.startedAtMs),
    terminalAt: isoFromMs(turn.completedAtMs),
    terminalStatus: turn.completedAtMs != null ? turn.status : "",
    presentation: turnPresentation(turn),
  };
}
