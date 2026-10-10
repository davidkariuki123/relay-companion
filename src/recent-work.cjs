"use strict";
// What the person worked on lately, for the first-Relay ideas (2026-10-10).
//
// Read-only and short: for each Codex thread and Claude Code session of the
// last week, its title and the person's first ask, newest first, capped. It
// never returns file contents, tool output or anything the AI wrote, and only
// the project folder's name, not its path.
//
// Codex keeps thread metadata in state_5.sqlite (read with the system sqlite3,
// as codex-state.js does); without it, the rollouts under sessions/ are read
// from their first few kilobytes. Claude Code keeps one JSONL per session
// under projects/; only its head is read.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 100;
const ASK_MAX = 180;
const HEAD_BYTES = 256 * 1024;
const MAX_FILES_PER_SOURCE = 80;

// Relay's own setup prompts, and wrappers hosts put around a typed message.
const SKIP_ASKS = [
  /^set up relay with me\b/i,
  /^help me connect the relay app i installed\b/i,
  /^help me (get started with|send my first) relay\b/i,
  /^read relay[’']s local getting-started guide\b/i,
  /^the local relay user clicked\b/i,
  // A compacted conversation restarts with a summary, not an ask.
  /^this session is being continued from a previous conversation\b/i,
];

function oneLine(text, max) {
  let value = String(text || "");
  // Codex desktop wraps attachments: keep only what the person typed.
  const mine = value.match(/##\s*My request:\s*([\s\S]*)$/i);
  if (mine) value = mine[1];
  value = value.replace(/\*\*/g, "").replace(/`{3}[\s\S]*?`{3}/g, " ").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
function usableAsk(text) {
  const value = String(text || "").trim();
  if (!value || /^</.test(value) || /^caveat:/i.test(value) || /^#\s*(agents|claude)\.md/i.test(value)) return false;
  return !SKIP_ASKS.some((pattern) => pattern.test(oneLine(value, 400)));
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text"].includes(part.type)).map((part) => part.text || "").join("\n");
}
function readHead(file, bytes = HEAD_BYTES, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fsImpl.readSync(fd, buffer, 0, bytes, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    // Drop a line cut off by the byte limit.
    return read === bytes ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  } catch { return ""; }
  finally { if (fd !== undefined) try { fsImpl.closeSync(fd); } catch {} }
}
function jsonLines(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
function project(cwd) {
  const clean = String(cwd || "").replace(/[\\/]+$/, "");
  return clean ? path.basename(clean) : "";
}

function codexFromDatabase(dbPath, since, spawn = spawnSync) {
  const filter = "archived = 0 AND (thread_source IS NULL OR thread_source IN ('', 'user')) AND source IN ('cli', 'vscode')";
  const queries = [
    `SELECT COALESCE(name, '') AS name, title, first_user_message AS ask, cwd, recency_at_ms AS at FROM threads WHERE ${filter} AND recency_at_ms > ${Math.floor(since)} ORDER BY recency_at_ms DESC LIMIT ${MAX_FILES_PER_SOURCE};`,
    // Older Codex state databases have no recency or name columns.
    `SELECT '' AS name, title, first_user_message AS ask, cwd, updated_at * 1000 AS at FROM threads WHERE archived = 0 AND updated_at > ${Math.floor(since / 1000)} ORDER BY updated_at DESC LIMIT ${MAX_FILES_PER_SOURCE};`,
  ];
  // A live WAL database opens read-only when its -shm is writable; immutable
  // reads the main file alone when it is not, missing only the newest writes.
  const targets = [["-readonly", dbPath], ["-readonly", `file:${dbPath}?immutable=1`]];
  for (const [flag, target] of targets) {
    for (const sql of queries) {
      const result = spawn("sqlite3", [flag, "-json", target, sql], { encoding: "utf8", timeout: 5000 });
      if (result.status !== 0 || result.error) continue;
      try {
        const rows = JSON.parse(result.stdout || "[]");
        return rows.map((row) => ({
          app: "Codex",
          title: oneLine(row.name || row.title, TITLE_MAX),
          ask: oneLine(row.ask || row.title, ASK_MAX),
          rawAsk: String(row.ask || row.title || ""),
          project: project(row.cwd),
          at: Number(row.at) || 0,
        }));
      } catch { continue; }
    }
  }
  return null;
}

function codexFromRollouts(codexHome, since, now, fsImpl = fs) {
  const items = [];
  const files = [];
  for (let at = now; at >= since - DAY_MS; at -= DAY_MS) {
    const day = new Date(at);
    const dir = path.join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of names) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name));
  }
  const recent = files.map((file) => { try { return { file, mtime: fsImpl.statSync(file).mtimeMs }; } catch { return null; } })
    .filter((entry) => entry && entry.mtime > since).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES_PER_SOURCE);
  for (const { file, mtime } of recent) {
    let cwd = "", ask = "", subagent = false;
    for (const line of jsonLines(readHead(file, 64 * 1024, fsImpl))) {
      const payload = line.payload || {};
      if (line.type === "session_meta") {
        cwd = payload.cwd || "";
        if (payload.thread_source && !["user", ""].includes(payload.thread_source)) subagent = true;
        if (payload.source === "exec" || typeof payload.source === "object") subagent = true;
      }
      if (!ask && line.type === "event_msg" && payload.type === "user_message" && usableAsk(payload.message)) ask = payload.message;
      if (!ask && line.type === "response_item" && payload.type === "message" && payload.role === "user" && usableAsk(textOf(payload.content))) ask = textOf(payload.content);
      if (ask && cwd) break;
    }
    if (subagent || !ask) continue;
    items.push({ app: "Codex", title: oneLine(ask, TITLE_MAX), ask: oneLine(ask, ASK_MAX), rawAsk: ask, project: project(cwd), at: mtime });
  }
  return items;
}

function claudeSessions(projectsDir, since, fsImpl = fs) {
  const files = [];
  let dirs = [];
  try { dirs = fsImpl.readdirSync(projectsDir); } catch { return []; }
  for (const dir of dirs) {
    const full = path.join(projectsDir, dir);
    let names = [];
    try { names = fsImpl.readdirSync(full); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(full, name);
      try { const stat = fsImpl.statSync(file); if (stat.isFile() && stat.mtimeMs > since) files.push({ file, mtime: stat.mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const items = [];
  for (const { file, mtime } of files.slice(0, MAX_FILES_PER_SOURCE)) {
    let title = "", ask = "", cwd = "", headless = false;
    for (const line of jsonLines(readHead(file, HEAD_BYTES, fsImpl))) {
      if (line.type === "custom-title" && line.customTitle) title = line.customTitle;
      else if (line.type === "summary" && line.summary && !title) title = line.summary;
      else if (line.type === "user" && !ask && !line.isMeta && !line.isSidechain) {
        if (/^sdk-/.test(String(line.entrypoint || ""))) headless = true;
        const text = textOf(line.message?.content);
        if (usableAsk(text)) { ask = text; cwd = line.cwd || cwd; }
      }
      if (title && ask) break;
    }
    if (headless || !ask) continue;
    items.push({ app: "Claude Code", title: oneLine(title || ask, TITLE_MAX), ask: oneLine(ask, ASK_MAX), rawAsk: ask, project: project(cwd), at: mtime });
  }
  return items;
}

/**
 * @returns {{ days: number, items: Array<{ app: string, title: string, ask: string, project: string, at: string }>, sources: object }}
 */
function recentWork({ codexHome, codexStateDb, claudeProjectsDir, now = Date.now(), days = 7, limit = 30, spawn = spawnSync, fsImpl = fs } = {}) {
  const since = now - days * DAY_MS;
  const sources = { codex: "none", claudeCode: "none" };
  let codex = [];
  if (codexHome || codexStateDb) {
    const db = codexStateDb || path.join(codexHome, "state_5.sqlite");
    const fromDb = fsImpl.existsSync(db) ? codexFromDatabase(db, since, spawn) : null;
    if (fromDb) { codex = fromDb; sources.codex = "threads"; }
    else if (codexHome) { codex = codexFromRollouts(codexHome, since, now, fsImpl); sources.codex = codex.length ? "sessions" : "none"; }
  }
  const claude = claudeProjectsDir ? claudeSessions(claudeProjectsDir, since, fsImpl) : [];
  if (claude.length) sources.claudeCode = "sessions";
  const seen = new Set();
  const items = [...codex, ...claude]
    .filter((item) => item.ask && usableAsk(item.rawAsk))
    .sort((a, b) => b.at - a.at)
    .filter((item) => { const key = item.ask.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 30)))
    .map(({ app, title, ask, project: folder, at }) => ({ app, title: title === ask ? "" : title, ask, ...(folder ? { project: folder } : {}), at: new Date(at).toISOString() }));
  return { days, items, sources };
}

module.exports = { recentWork, usableAsk, oneLine };
