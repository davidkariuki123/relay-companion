"use strict";
// What the person is in the middle of, for the first-Relay ideas.
//
// 2026-10-10, first version: titles and FIRST asks. David's real run showed why
// that fails: a chat's first message is how it started, and its live open loop
// (the review someone owes, the answer the person is waiting for, the deadline)
// is at its END. Ideas built from first asks came out generic.
//
// Now, for each recent Codex thread and Claude Code session (the last 72 hours
// first, then the rest of the week), newest first and capped: its title, the
// project folder's name, when it was last active, how many messages it has,
// the person's last few messages and the last lines of the AI's last reply,
// all trimmed, plus the people named in that tail. Read-only and local: it
// never returns tool output or file contents, never a path, and it skips
// Relay's own setup chats and automated sessions.
//
// Codex keeps thread metadata, including each thread's rollout file, in
// state_5.sqlite (read with the system sqlite3, as codex-state.js does);
// without it the rollouts under sessions/ are found by date. Claude Code keeps
// one JSONL per session under projects/. Only a file's head (how it started)
// and tail (where it is now) are read.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOT_MS = 72 * 60 * 60 * 1000;
const TITLE_MAX = 100;
const USER_MAX = 280;
const ASSISTANT_MAX = 420;
const LAST_USER_COUNT = 3;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;
const MAX_CANDIDATES_PER_SOURCE = 60;
const MAX_THREADS = 20;
const MAX_PEOPLE = 5;

// Relay's own setup prompts: a chat that began with one is onboarding, not work.
const SKIP_ASKS = [
  /^set up relay with me\b/i,
  /^help me connect the relay app i installed\b/i,
  /^help me (get started with|send my first) relay\b/i,
  /^read relay[’']s local getting-started guide\b/i,
  /^the local relay user clicked\b/i,
];
// Messages that are not the person typing: host wrappers and restarts.
// Scripted probes and test runs, not the person's work.
const AUTOMATED = [/^(?:reply|respond) with exactly\b/i, /^call the mcp__/i];
const TEMP_DIR = /^(?:\/private)?\/(?:tmp|var\/folders)\//;
const NOT_TYPED = [
  /^</,
  /^caveat:/i,
  /^#\s*(agents|claude)\.md/i,
  /^this session is being continued from a previous conversation\b/i,
  /^\[request interrupted/i,
];

function clean(text) {
  let value = String(text || "");
  // Codex desktop wraps attachments: keep only what the person typed.
  const mine = value.match(/##\s*My request:\s*([\s\S]*)$/i);
  if (mine) value = mine[1];
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/`{3}[\s\S]*?`{3}/g, " [code] ")
    .replace(/\*\*/g, "");
}
function oneLine(text, max) {
  const value = clean(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
/** The end of the AI's last reply: its last few lines, where the open question or next step usually is. */
function lastLines(text, max) {
  const lines = clean(text).split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const kept = [];
  let length = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < 6; i -= 1) {
    if (length + lines[i].length > max && kept.length) break;
    kept.unshift(lines[i]);
    length += lines[i].length + 1;
  }
  return oneLine(kept.join(" / "), max);
}
function typed(text) {
  const value = String(text || "").trim();
  return Boolean(value) && !NOT_TYPED.some((pattern) => pattern.test(value));
}
function onboardingChat(text) {
  const value = oneLine(text, 200);
  return SKIP_ASKS.some((pattern) => pattern.test(value));
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text", "output_text"].includes(part.type)).map((part) => part.text || "").join("\n");
}
function readRange(file, start, bytes, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fsImpl.readSync(fd, buffer, 0, bytes, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch { return ""; }
  finally { if (fd !== undefined) try { fsImpl.closeSync(fd); } catch {} }
}
/** A file's opening lines and closing lines, each cut at a whole line. */
function headAndTail(file, fsImpl = fs) {
  let size = 0;
  try { size = fsImpl.statSync(file).size; } catch { return { head: "", tail: "", whole: false }; }
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    const all = readRange(file, 0, size, fsImpl);
    return { head: all, tail: all, whole: true };
  }
  const head = readRange(file, 0, HEAD_BYTES, fsImpl);
  const tail = readRange(file, size - TAIL_BYTES, TAIL_BYTES, fsImpl);
  return { head: head.slice(0, head.lastIndexOf("\n") + 1), tail: tail.slice(tail.indexOf("\n") + 1), whole: false };
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
  const value = String(cwd || "").replace(/[\\/]+$/, "");
  return value ? path.basename(value) : "";
}

// PEOPLE. Names the person works with show up next to what they ask of them:
// "ask Sam", "waiting on Priya", "send it to Jordan", "@cezar", "Hi Shane,".
// Only names that appear in this thread are returned; nothing is guessed.
const NOT_NAMES = new Set(("I Im Ive Id A An The This That These Those It Its We Our You Your He She They Them Me My Mine Us "
  + "Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December "
  + "Today Tomorrow Yesterday Tonight Please Thanks Thank Hi Hey Hello Dear Yes No Ok Okay Sure Also And But Or So If When Then Now Here There What Why How Who Where "
  + "Relay Codex Claude ChatGPT Conductor Slack Gmail Google GitHub Github Linear Notion Figma Stripe AWS Vercel Docker Mac Windows Linux iOS Android Chrome Safari "
  + "API PR CI QA UI UX MCP CLI JSON HTML CSS SQL PDF URL AI LLM CEO CTO CFO TODO README Dev Prod Staging Main Note Notes Draft Done Fix Add Update Review Send Ask Tell Check Ping Email Message").split(" "));
const NAME = "([A-Z][a-z]{1,14}(?:\\s[A-Z][a-z]{1,14})?)";
// People type names in lower case ("relay it to shane"): after a verb that
// takes a person, a lower-case word counts too, unless it is a common word.
const ANY_NAME = "([A-Za-z][a-z]{1,14})";
const NOT_LOWER_NAMES = new Set(("the a an it its this that these those him her them me us you my our your his their everyone someone anyone "
  + "people team all both each one two back out up over down off in on to for from with about again too also now then here there "
  + "what why how who when where whether if and or but so not no yes ok okay please just only more less some any every other another "
  + "findings results notes summary update status draft link file files doc docs pr code it's that's chat transcript relay relays task tasks message "
  + "know see check fix make send ask tell try run test build ship deploy review main dev prod staging production github slack npm "
  + "claude codex chatgpt conductor cursor git him myself yourself whoever asking telling saying sending checking waiting").split(" "));
// Only strong positions count: a word right after a verb that takes a person.
// Precision over recall: an idea never names someone the thread does not.
const PERSON_VERBS = "ask|asked|asking|tell|told|ping|pinged|remind|reminded|cc|loop\\s+in|follow\\s+up\\s+with|check\\s+with|checking\\s+with|waiting\\s+(?:on|for)|hear\\s+back\\s+from|heard\\s+back\\s+from|sign-?off\\s+from|approval\\s+from|meeting\\s+with|call\\s+with|reply\\s+to|replied\\s+to|review(?:ed)?\\s+by";
const PEOPLE_PATTERNS = [
  new RegExp(`\\b(?:${PERSON_VERBS})\\s+${ANY_NAME}\\b`, "gi"),
  // "send it to Sam", "relay your findings to shane", "hand the fix over to Priya"
  new RegExp(`\\b(?:send|sent|sending|give|gave|forward|forwarded|hand|handed|relay|relayed|email|emailed)(?:\\s+[\\w'’-]+){0,3}?\\s+(?:over\\s+)?to\\s+${ANY_NAME}\\b`, "gi"),
  // "relay shane the transcript", "send Priya the deck"
  new RegExp(`\\b(?:relay|send|email|message|text|ping|give|show)\\s+${ANY_NAME}\\s+(?:the|a|an|my|our|your|this|that|these|those|what|how|whether|about)\\b`, "gi"),
  // "so that Shivani can pick it up", "let Priya review it" (capitalised only)
  new RegExp(`\\b(?:so\\s+that|so|let|have|get|until|once)\\s+${NAME}\\s+(?:can|could|will|would|should|pick|picks|take|takes|review|reviews|sign|signs|has|had)\\b`, "g"),
  // "the call me and sven had"
  new RegExp(`\\b(?:me|i)\\s+and\\s+${ANY_NAME}\\b`, "gi"),
  new RegExp(`(?:^|[\\s(])@${ANY_NAME}`, "g"),
  // "Hi Shane," at the start of a message the person drafted
  new RegExp(`(?:^|\\n|[.!?]\\s+)(?:[Hh]i|[Hh]ey|[Hh]ello|[Dd]ear|[Tt]hanks|[Tt]hank you),?\\s+${NAME}\\s*[,!.]`, "g"),
];
function peopleIn(texts) {
  const counts = new Map();
  for (const text of texts) {
    const value = clean(text);
    for (const pattern of PEOPLE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of value.matchAll(pattern)) {
        for (const group of match.slice(1)) {
          const raw = String(group || "").trim();
          if (!raw || NOT_LOWER_NAMES.has(raw.toLowerCase())) continue;
          const words = raw.split(/\s+/).map((word) => word[0].toUpperCase() + word.slice(1));
          // "Claude Code" is a product, not a person called Code.
          if (words.some((word) => NOT_NAMES.has(word))) continue;
          const name = words.join(" ");
          if (name.length < 2) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    }
  }
  // A first name also seen in a full name is the same person.
  const names = [...counts.keys()];
  for (const name of names) {
    const full = names.find((other) => other !== name && other.startsWith(`${name} `));
    if (full) { counts.set(full, counts.get(full) + counts.get(name)); counts.delete(name); }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PEOPLE).map(([name]) => name);
}

/** The conversation as [{ role, text }] from a Codex rollout's lines. */
function codexMessages(lines) {
  const out = [];
  const push = (role, text) => {
    const last = out[out.length - 1];
    if (last && last.role === role && last.text === text) return; // the same message as an event and an item
    out.push({ role, text });
  };
  for (const line of lines) {
    const payload = line.payload || {};
    if (line.type === "event_msg" && payload.type === "user_message") push("user", String(payload.message || ""));
    else if (line.type === "event_msg" && payload.type === "agent_message") push("assistant", String(payload.message || ""));
    else if (line.type === "response_item" && payload.type === "message" && payload.role === "user") push("user", textOf(payload.content));
    else if (line.type === "response_item" && payload.type === "message" && payload.role === "assistant") push("assistant", textOf(payload.content));
  }
  return out.filter((message) => message.role === "assistant" ? message.text.trim() : typed(message.text));
}
function claudeMessages(lines) {
  const out = [];
  for (const line of lines) {
    if (line.isSidechain || line.isMeta) continue;
    if (line.type === "user") {
      const content = line.message?.content;
      // Tool results ride user lines as arrays of tool_result parts: not the person.
      if (Array.isArray(content) && content.some((part) => part?.type === "tool_result")) continue;
      const text = textOf(content);
      if (typed(text)) out.push({ role: "user", text });
    } else if (line.type === "assistant") {
      const text = textOf(line.message?.content);
      if (text.trim()) out.push({ role: "assistant", text });
    }
  }
  return out;
}

/** One thread's live end, or null when it is not the person's own work. */
function summarize({ app, title, cwd, at, head, tail, whole, parse, firstAsk = "" }) {
  const opening = parse(jsonLines(head));
  const firstUser = firstAsk || opening.find((message) => message.role === "user")?.text || "";
  if (!firstUser || onboardingChat(firstUser)) return null;
  if (TEMP_DIR.test(String(cwd || ""))) return null;
  const messages = parse(jsonLines(tail));
  // The same message twice in a row (resent, or an event and an item) is one.
  const users = messages.filter((message) => message.role === "user")
    .filter((message, index, all) => index === 0 || oneLine(message.text, USER_MAX) !== oneLine(all[index - 1].text, USER_MAX));
  if (!users.length || users.every((message) => AUTOMATED.some((pattern) => pattern.test(message.text.trim())))) return null;
  // Pings and empty probes ("PONG", a zero-width space): nothing anyone is waiting on.
  if (users.every((message) => oneLine(message.text, USER_MAX).replace(/[\u200b-\u200d\ufeff]/g, "").trim().split(/\s+/).filter((word) => /\w/.test(word)).length <= 1)) return null;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const lastUser = users.slice(-LAST_USER_COUNT);
  return {
    app,
    title: oneLine(title || firstUser, TITLE_MAX),
    ...(project(cwd) ? { project: project(cwd) } : {}),
    lastActiveAt: new Date(at).toISOString(),
    messageCount: whole ? messages.length : `${messages.length}+`,
    lastUserMessages: lastUser.map((message) => oneLine(message.text, USER_MAX)).filter(Boolean),
    ...(lastAssistant ? { lastAssistantEnding: lastLines(lastAssistant.text, ASSISTANT_MAX) } : {}),
    people: peopleIn([...lastUser.map((message) => message.text), lastAssistant?.text || "", firstUser]),
  };
}

function codexFromDatabase(dbPath, since, spawn = spawnSync) {
  const filter = "archived = 0 AND (thread_source IS NULL OR thread_source IN ('', 'user')) AND source IN ('cli', 'vscode')";
  const queries = [
    `SELECT COALESCE(name, '') AS name, title, first_user_message AS ask, cwd, rollout_path AS rollout, recency_at_ms AS at FROM threads WHERE ${filter} AND recency_at_ms > ${Math.floor(since)} ORDER BY recency_at_ms DESC LIMIT ${MAX_CANDIDATES_PER_SOURCE};`,
    // Older Codex state databases have no recency or name columns.
    `SELECT '' AS name, title, first_user_message AS ask, cwd, rollout_path AS rollout, updated_at * 1000 AS at FROM threads WHERE archived = 0 AND updated_at > ${Math.floor(since / 1000)} ORDER BY updated_at DESC LIMIT ${MAX_CANDIDATES_PER_SOURCE};`,
  ];
  // A live WAL database opens read-only when its -shm is writable; immutable
  // reads the main file alone when it is not, missing only the newest writes.
  for (const target of [dbPath, `file:${dbPath}?immutable=1`]) {
    for (const sql of queries) {
      const result = spawn("sqlite3", ["-readonly", "-json", target, sql], { encoding: "utf8", timeout: 5000 });
      if (result.status !== 0 || result.error) continue;
      try { return JSON.parse(result.stdout || "[]"); } catch { continue; }
    }
  }
  return null;
}
function codexRolloutFiles(codexHome, since, now, fsImpl = fs) {
  const files = [];
  for (let at = now; at >= since - DAY_MS; at -= DAY_MS) {
    const day = new Date(at);
    const dir = path.join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of names) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name));
  }
  return files;
}
function codexThreads({ codexHome, codexStateDb, since, now, spawn, fsImpl }) {
  const db = codexStateDb || (codexHome ? path.join(codexHome, "state_5.sqlite") : "");
  const rows = db && fsImpl.existsSync(db) ? codexFromDatabase(db, since, spawn) : null;
  const candidates = rows
    ? rows.map((row) => ({ file: row.rollout, title: row.name || row.title, firstAsk: row.ask || "", cwd: row.cwd, at: Number(row.at) || 0 }))
    : (codexHome ? codexRolloutFiles(codexHome, since, now, fsImpl) : []).map((file) => {
      try { return { file, at: fsImpl.statSync(file).mtimeMs }; } catch { return null; }
    }).filter((entry) => entry && entry.at > since).sort((a, b) => b.at - a.at).slice(0, MAX_CANDIDATES_PER_SOURCE);
  const items = [];
  for (const candidate of candidates) {
    if (!candidate.file) continue;
    const { head, tail, whole } = headAndTail(candidate.file, fsImpl);
    if (!head) continue;
    const meta = jsonLines(head).find((line) => line.type === "session_meta")?.payload || {};
    // Subagents, reviewers and `codex exec` runs are not the person's conversations.
    if (meta.thread_source && !["user", ""].includes(meta.thread_source)) continue;
    if (meta.source === "exec" || (meta.source && typeof meta.source === "object")) continue;
    const item = summarize({ app: "Codex", title: candidate.title, cwd: candidate.cwd || meta.cwd, at: candidate.at, head, tail, whole, parse: codexMessages, firstAsk: candidate.firstAsk });
    if (item) items.push({ ...item, at: candidate.at });
  }
  return { items, source: rows ? "threads" : items.length ? "sessions" : "none" };
}
function claudeThreads({ claudeProjectsDir, since, fsImpl }) {
  const files = [];
  let dirs = [];
  try { dirs = fsImpl.readdirSync(claudeProjectsDir); } catch { return []; }
  for (const dir of dirs) {
    const full = path.join(claudeProjectsDir, dir);
    let names = [];
    try { names = fsImpl.readdirSync(full); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(full, name);
      try { const stat = fsImpl.statSync(file); if (stat.isFile() && stat.mtimeMs > since) files.push({ file, at: stat.mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.at - a.at);
  const items = [];
  for (const { file, at } of files.slice(0, MAX_CANDIDATES_PER_SOURCE)) {
    const { head, tail, whole } = headAndTail(file, fsImpl);
    const lines = jsonLines(head);
    // Headless runs (claude -p from scripts and SDKs) are not the person's conversations.
    if (lines.some((line) => line.type === "user" && /^sdk-/.test(String(line.entrypoint || "")))) continue;
    let title = "";
    for (const line of [...lines, ...jsonLines(tail)]) {
      if (line.type === "custom-title" && line.customTitle) title = line.customTitle;
      else if (line.type === "summary" && line.summary && !title) title = line.summary;
    }
    const cwd = lines.find((line) => line.cwd)?.cwd || "";
    // The file's mtime moves when the desktop app touches it; the last message's own time does not.
    const stamped = jsonLines(tail).map((line) => Date.parse(line.timestamp || "")).filter(Number.isFinite);
    const last = stamped.length ? Math.max(...stamped) : at;
    if (last <= since) continue;
    const item = summarize({ app: "Claude Code", title, cwd, at: last, head, tail, whole, parse: claudeMessages });
    if (item) items.push({ ...item, at: last });
  }
  return items;
}

/**
 * @returns {{ days: number, threads: Array<object>, sources: object }}
 */
function recentWork({ codexHome, codexStateDb, claudeProjectsDir, now = Date.now(), days = 7, limit = MAX_THREADS, spawn = spawnSync, fsImpl = fs } = {}) {
  const since = now - days * DAY_MS;
  const codex = (codexHome || codexStateDb) ? codexThreads({ codexHome, codexStateDb, since, now, spawn, fsImpl }) : { items: [], source: "none" };
  const claude = claudeProjectsDir ? claudeThreads({ claudeProjectsDir, since, fsImpl }) : [];
  const all = [...codex.items, ...claude].sort((a, b) => b.at - a.at);
  // The last three days first, then the rest of the week; both newest first.
  const hot = all.filter((item) => item.at > now - HOT_MS);
  const rest = all.filter((item) => item.at <= now - HOT_MS);
  const threads = [...hot, ...rest]
    .slice(0, Math.max(1, Math.min(MAX_THREADS, Number(limit) || MAX_THREADS)))
    .map(({ at, ...item }) => ({ ...item, recent: at > now - HOT_MS }));
  return { days, threads, sources: { codex: codex.source, claudeCode: claude.length ? "sessions" : "none" } };
}

module.exports = { recentWork, peopleIn, oneLine, lastLines };
