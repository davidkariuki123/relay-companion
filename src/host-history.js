// WHERE RELAY WORKED BEFORE THIS RECORD EXISTED (2026-10-09).
//
// host-evidence.js records every session from now on. Before that, each app
// kept its own account of using Relay, and those accounts are evidence too:
//
//   Claude Code   ~/.claude/projects/*/<session>.jsonl: `entrypoint` says
//                 where it ran (claude-desktop = the Claude app's Code tab,
//                 cli = Terminal); a tool_use named mcp__relay__* is Relay
//                 answering inside it. An API error refusing a tool schema
//                 ("input_schema does not support oneOf, allOf, or anyOf…",
//                 measured from Claude Code 2.1.156 in Conductor) is that host
//                 unable to use Relay at all, until a later call says otherwise.
//   Codex         ~/.codex/sessions/**/rollout-*.jsonl: the first line's
//                 `originator` says where (Codex Desktop = the ChatGPT app,
//                 codex_cli_rs / codex_exec = Terminal); an McpToolCall item
//                 with server "relay" and status "completed" is Relay working.
//   Claude chats  ~/Library/Logs/Claude/mcp.log: Relay answering tools/list,
//                 which proves Relay LOADED there, not that it was used.
//   Conductor     its workspaces live under ~/conductor, so a session above
//                 whose cwd is there ran in Conductor.
//
// Reading transcripts must never thrash the disk (a full grep of them once
// made this Mac crawl): only files touched in the last 30 days, at most a few
// hundred, read from the end in small chunks, and each file's answer cached
// by its size and mtime so an unchanged file is never read twice.

import fs from "node:fs";
import path from "node:path";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FILES = 300;
const HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const SCHEMA_REFUSAL = /input_schema does not support (oneOf|allOf|anyOf)/;

const CLAUDE_PLACE = { "claude-desktop": "claude-code:app", cli: "claude-code:terminal" };
const CODEX_PLACE = { "Codex Desktop": "codex:chatgpt-app", codex_work_desktop: "codex:chatgpt-app", codex_cli_rs: "codex:terminal", codex_exec: "codex:terminal" };

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** The last line in a file that passes `match`, read backwards in chunks. */
export async function lastMatchingLine(file, match, { maxBytes = MAX_TAIL_BYTES } = {}) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    let end = size;
    let carry = "";
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const text = (await readAt(handle, start, end - start)) + carry;
      const lines = text.split("\n");
      // The first piece may be a partial line; keep it for the next chunk.
      carry = start > 0 ? lines.shift() : "";
      for (let i = lines.length - 1; i >= 0; i -= 1) if (match(lines[i])) return lines[i];
      end = start;
    }
    return carry && match(carry) ? carry : "";
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function head(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    return await readAt(handle, 0, HEAD_BYTES);
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The record's own top-level time, never one quoted inside its content.
function timestampOf(line) {
  let at = NaN;
  try { at = Date.parse(JSON.parse(line).timestamp); } catch {}
  return Number.isFinite(at) ? at : 0;
}

async function recentFiles(roots, { now, depth }) {
  const found = [];
  const walk = async (dir, level) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.promises.stat(full);
          if (now - stat.mtimeMs <= WINDOW_MS) found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

/** What one Claude Code transcript says: where it ran, and Relay's last call. */
export async function claudeTranscriptFacts(file) {
  const first = (await head(file)).split("\n").find((line) => line.includes("\"entrypoint\"")) || "";
  let entrypoint = "";
  let cwd = "";
  try { ({ entrypoint = "", cwd = "" } = JSON.parse(first)); } catch {}
  const line = await lastMatchingLine(file, (text) => text.includes("\"name\":\"mcp__relay__") && text.includes("\"tool_use\""));
  const refused = await lastMatchingLine(file, (text) => text.includes("\"isApiErrorMessage\":true") && SCHEMA_REFUSAL.test(text));
  let version = "";
  try { version = String(JSON.parse(refused).version || ""); } catch {}
  return { entrypoint, cwd, usedAt: line ? timestampOf(line) : 0, ...(refused ? { refusedAt: timestampOf(refused), version } : {}) };
}

/** What one Codex rollout says: where it ran, and Relay's last completed call. */
export async function codexRolloutFacts(file) {
  let originator = "";
  let cwd = "";
  try { ({ originator = "", cwd = "" } = JSON.parse((await head(file)).split("\n")[0]).payload || {}); } catch {}
  const line = await lastMatchingLine(file, (text) => text.includes("\"server\":\"relay\"") && text.includes("\"status\":\"completed\""));
  return { originator, cwd, usedAt: line ? timestampOf(line) : 0 };
}

export function claudePlace({ entrypoint, cwd }, { conductorRoot }) {
  if (conductorRoot && String(cwd || "").startsWith(conductorRoot)) return "claude-code:conductor";
  return CLAUDE_PLACE[entrypoint] || "";
}

export function codexPlace({ originator, cwd }, { conductorRoot }) {
  if (conductorRoot && String(cwd || "").startsWith(conductorRoot)) return "codex:conductor";
  return CODEX_PLACE[originator] || "";
}

/** The Claude app's chats: the last time Relay answered its tools/list. */
export async function claudeChatListedAt(homeDir) {
  const log = path.join(homeDir, "Library", "Logs", "Claude", "mcp.log");
  let listed = false;
  const line = await lastMatchingLine(log, (text) => {
    if (!text.includes("[relay]")) return false;
    // Reading backwards, the server's answer comes before the request.
    if (/Message from client: method="tools\/list"/.test(text)) return listed;
    if (/Message from server: id=\S+ result/.test(text)) listed = true;
    return false;
  }, { maxBytes: 2 * 1024 * 1024 });
  const at = Date.parse(line.slice(0, 24));
  return Number.isFinite(at) ? at : 0;
}

/**
 * The newest past use of Relay in each place, from the apps' own records.
 * `cache` (a plain object the caller keeps) holds each file's answer by size
 * and mtime between scans.
 */
export async function readHostHistory({ homeDir, now = Date.now(), cache = {} } = {}) {
  const conductorRoot = path.join(homeDir, "conductor") + path.sep;
  const out = {};
  const note = (place, at, source, field = "usedAt") => {
    if (!place) return;
    if (!out[place]) out[place] = { usedAt: 0, loadedAt: 0, refusedAt: 0, source: "" };
    if (!at) return;
    const known = out[place] || (out[place] = { usedAt: 0, loadedAt: 0, refusedAt: 0, source: "" });
    if (at > known[field]) {
      known[field] = at;
      if (field === "usedAt") known.source = source;
    }
  };
  const cached = async (file, read) => {
    const key = `${file.file}`;
    const hit = cache[key];
    if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.facts;
    const facts = await read(file.file);
    cache[key] = { size: file.size, mtimeMs: file.mtimeMs, facts };
    return facts;
  };
  for (const file of await recentFiles([path.join(homeDir, ".claude", "projects")], { now, depth: 1 })) {
    const facts = await cached(file, claudeTranscriptFacts);
    const place = claudePlace(facts, { conductorRoot });
    note(place, facts.usedAt, "transcript");
    if (place && facts.refusedAt && facts.refusedAt > (out[place]?.refusedAt || 0)) {
      out[place].refusedAt = facts.refusedAt;
      out[place].refusedVersion = facts.version || "";
    }
  }
  for (const file of await recentFiles([path.join(homeDir, ".codex", "sessions")], { now, depth: 3 })) {
    const facts = await cached(file, codexRolloutFacts);
    note(codexPlace(facts, { conductorRoot }), facts.usedAt, "transcript");
  }
  note("claude-chat", await claudeChatListedAt(homeDir), "app log", "loadedAt");
  return out;
}
