// Open-in-current-chat plumbing for the Codex (ChatGPT desktop) host.
//
// The Claude host stages an injection file that a settings hook consumes from
// inside the live session (src/claude-inject.cjs). Codex has no hook runtime,
// but it has two native levers this module feeds:
//
//   1. The CDP/inspector bridge (src/codex-desktop.js) can resume the user's
//      current thread in the primary ChatGPT window and start a real turn in it
//      ("start-turn-for-host"). That is the live tier.
//   2. The app's own automations: ~/.codex/automations/<id>/automation.toml
//      with kind="heartbeat" + target_thread_id injects a prompt into an
//      existing thread when its RRULE fires — proven native behavior. Writing a
//      near-now, COUNT=1 heartbeat is the fallback tier when the bridge is
//      unavailable or the submit fails.
//
// There is no codex-side rendezvous: the rollout files under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ARE the registry. The newest
// active rollout (recency = max(session_index.jsonl updated_at, rollout mtime),
// within 6h) is the user's "current chat"; its tail says whether a turn is open
// (event_msg task_started with no later task_complete / turn_aborted).
//
// The injection instruction is the SAME builder as the Claude path
// (claude-inject.cjs buildInjectionInstruction): the relay body is never
// inlined — the model fetches it via the Relay MCP tools (installed into
// ~/.codex/config.toml as [mcp_servers.relay]), preserving the
// untrusted-content discipline in relay-briefing.js.

import fs from "node:fs";
import path from "node:path";
import claudeInject from "./claude-inject.cjs";
import { codexHome } from "./host-paths.js";

const { buildInjectionInstruction } = claudeInject;

export const THREAD_MAX_AGE_MS = 6 * 60 * 60 * 1000; // a "current" thread was active within 6h
export const OPEN_AUTOMATION_PREFIX = "relay-open-";
export const OPEN_AUTOMATION_MAX_AGE_MS = 60 * 60 * 1000; // self-clean automations older than 1h
// Exclusive-next-occurrence hazard: the app computes nextRunAt for a NEW
// automation file on its next directory scan via rrule .after(now). If the
// single COUNT=1 occurrence has already passed by that first scan, the
// automation silently never fires. 90s (rounded up to a whole minute) gives the
// scheduler comfortable room; RELAY_CODEX_AUTOMATION_DELAY_MS overrides.
export const DEFAULT_OPEN_AUTOMATION_DELAY_MS = 90 * 1000;
// A single Codex turn can append hundreds of megabytes of tool output. In that
// case the opening task_started row falls outside our bounded tail read even
// though the rollout is still receiving token/progress records. Treat a tail
// with no lifecycle marker as active while the native file is still moving.
// A real task_complete/turn_aborted in the tail always wins immediately.
export const RECENT_ROLLOUT_ACTIVITY_MS = 90 * 1000;

const ROLLOUT_TAIL_BYTES = 256 * 1024;
const ROLLOUT_HEAD_BYTES = 96 * 1024;
const INDEX_TAIL_BYTES = 256 * 1024;
const ROLLOUT_UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

// Codex can continue one visible task in a new rollout file whose filename is
// `<root-thread-id>_<continuation-id>.jsonl`. The provider-native address is
// still the FIRST UUID. Treating only the final UUID as the task id hides the
// live continuation and leaves an old, idle root row in the session picker.
function rolloutThreadIdFromName(name) {
  if (!/^rollout-.*\.jsonl$/.test(name)) return "";
  return String(name).match(ROLLOUT_UUID_RE)?.[0] || "";
}

export { buildInjectionInstruction };

function defaultCodexHome() {
  return codexHome();
}

// ---- rollout parsing --------------------------------------------------------

function readFileSlice(filePath, { fromEnd = null, fromStart = null }) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, fromEnd ?? fromStart ?? size);
    if (length <= 0) return { text: "", truncatedHead: false };
    const position = fromEnd != null ? size - length : 0;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, position);
    return { text: buffer.toString("utf8"), truncatedHead: fromEnd != null && size > length };
  } catch {
    return { text: "", truncatedHead: false };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function parseJsonLines(text, { dropFirst = false } = {}) {
  const lines = String(text || "").split("\n");
  if (dropFirst && lines.length) lines.shift(); // partial first line of a tail read
  const rows = [];
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;
    try {
      rows.push(JSON.parse(clean));
    } catch {
      // malformed line (mid-write, corruption): carries no signal, skip it
    }
  }
  return rows;
}

// Busy/idle + open turn id from a rollout tail. A turn is OPEN after an
// event_msg task_started with no later task_complete / turn_aborted for the
// same turn. Close events are matched by turn_id when both sides carry one:
// mis-reading "busy" as "idle" would double-submit into a running turn, so an
// unmatched close (different turn_id than the open turn) keeps the turn open.
export function parseRolloutActivity(text, { truncatedHead = false } = {}) {
  const rows = parseJsonLines(text, { dropFirst: truncatedHead });
  let open = null;
  let lastEventAt = 0;
  let lastMessageAt = 0;
  let lifecycleObserved = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at)) lastEventAt = Math.max(lastEventAt, at);
    const messageRole = String(row?.payload?.role || row?.payload?.message?.role || "");
    if (row.type === "response_item" && row?.payload?.type === "message"
      && ["user", "assistant"].includes(messageRole) && Number.isFinite(at)) {
      lastMessageAt = Math.max(lastMessageAt, at);
    }
    if (row.type !== "event_msg" || !row.payload || typeof row.payload !== "object") continue;
    const kind = row.payload.type;
    const turnId = typeof row.payload.turn_id === "string" ? row.payload.turn_id : null;
    if (kind === "task_started") {
      lifecycleObserved = true;
      open = { turnId };
    } else if (kind === "task_complete" || kind === "turn_aborted") {
      lifecycleObserved = true;
      if (!open || !turnId || !open.turnId || open.turnId === turnId) open = null;
    }
  }
  return {
    busy: Boolean(open),
    openTurnId: open ? open.turnId : null,
    lastEventAt: lastEventAt || null,
    lastMessageAt: lastMessageAt || null,
    lifecycleObserved,
  };
}

export function readRolloutActivity(sessionPath, { tailBytes = ROLLOUT_TAIL_BYTES } = {}) {
  const { text, truncatedHead } = readFileSlice(sessionPath, { fromEnd: tailBytes });
  return parseRolloutActivity(text, { truncatedHead });
}

// First session_meta line of a rollout: cwd + whether this is a subagent
// rollout (subagent forks share the sessions dir but are not user-facing
// "current chats").
export function readRolloutMeta(sessionPath, { headBytes = ROLLOUT_HEAD_BYTES } = {}) {
  const { text } = readFileSlice(sessionPath, { fromStart: headBytes });
  for (const row of parseJsonLines(text)) {
    if (!row || row.type !== "session_meta" || !row.payload || typeof row.payload !== "object") continue;
    const payload = row.payload;
    return {
      cwd: typeof payload.cwd === "string" ? payload.cwd : "",
      subagent: payload.thread_source === "subagent" || Boolean(payload.source && payload.source.subagent),
    };
  }
  return null;
}

// ---- current-thread resolution ---------------------------------------------

// ~/.codex/session_index.jsonl is append-only ({id, thread_name, updated_at});
// re-appends supersede. Read the tail and keep the newest row per id.
export function parseSessionIndex(text) {
  const byId = new Map();
  for (const row of parseJsonLines(text, { dropFirst: false })) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) continue;
    const updatedAtMs = Date.parse(row.updated_at) || 0;
    const existing = byId.get(row.id);
    if (!existing || updatedAtMs >= existing.updatedAtMs) {
      byId.set(row.id, { threadName: typeof row.thread_name === "string" ? row.thread_name : "", updatedAtMs });
    }
  }
  return byId;
}

function readSessionIndex(homeDir) {
  const { text, truncatedHead } = readFileSlice(path.join(homeDir, "session_index.jsonl"), { fromEnd: INDEX_TAIL_BYTES });
  return parseSessionIndex(truncatedHead ? text.slice(text.indexOf("\n") + 1) : text);
}

function dateDirParts(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    // Rollout day-directories are named from local wall-clock time, but clock
    // and zone drift make that untrustworthy: cover local AND UTC calendars.
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`,
  ];
}

// Newest rollout file per thread id across the last few day-directories. mtime
// is the liveness signal: every rollout event touches the file.
export function listRecentRollouts(sessionsRoot, { nowMs = Date.now(), dayLookback = 3 } = {}) {
  const dirs = new Set();
  for (let back = 0; back < dayLookback; back += 1) {
    for (const part of dateDirParts(new Date(nowMs - back * 24 * 60 * 60 * 1000))) {
      dirs.add(path.join(sessionsRoot, part));
    }
  }
  const byId = new Map();
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const threadId = rolloutThreadIdFromName(name);
      if (!threadId) continue;
      const filePath = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const existing = byId.get(threadId);
      if (!existing || mtimeMs > existing.mtimeMs) byId.set(threadId, { threadId, sessionPath: filePath, mtimeMs });
    }
  }
  return byId;
}

// The user's CURRENT Codex thread: the most recently ACTIVE rollout (recency =
// max(session_index updated_at, rollout mtime)) within maxAgeMs whose rollout
// exists and is not a subagent fork. Returns
//   { threadId, sessionPath, cwd, threadName, lastActiveAt, busy, openTurnId }
// or null. Mirrors claude-inject.findCurrentClaudeSession.
export function resolveCurrentCodexThread({
  homeDir = defaultCodexHome(),
  nowMs = Date.now(),
  maxAgeMs = THREAD_MAX_AGE_MS,
} = {}) {
  const index = readSessionIndex(homeDir);
  const rollouts = listRecentRollouts(path.join(homeDir, "sessions"), { nowMs });
  const candidates = [];
  for (const rollout of rollouts.values()) {
    const indexed = index.get(rollout.threadId);
    const lastActiveAt = Math.max(rollout.mtimeMs, indexed ? indexed.updatedAtMs : 0);
    if (!(lastActiveAt > 0) || nowMs - lastActiveAt > maxAgeMs) continue;
    candidates.push({ ...rollout, threadName: indexed ? indexed.threadName : "", lastActiveAt });
  }
  candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const candidate of candidates) {
    const meta = readRolloutMeta(candidate.sessionPath);
    if (!meta || meta.subagent) continue;
    const activity = readRolloutActivity(candidate.sessionPath);
    return {
      threadId: candidate.threadId,
      sessionPath: candidate.sessionPath,
      cwd: meta.cwd,
      threadName: candidate.threadName,
      lastActiveAt: candidate.lastActiveAt,
      busy: activity.busy,
      openTurnId: activity.openTurnId,
    };
  }
  return null;
}

// Poll the rollout tail until the open turn closes (task_complete /
// turn_aborted) or the deadline passes. The conservative busy path queues the
// submit behind idle instead of interrupting the user's running turn.
export async function waitForCodexIdle(sessionPath, { timeoutMs = 30000, pollMs = 1000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const activity = readRolloutActivity(sessionPath);
    if (!activity.busy) return { idle: true, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) return { idle: false, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Post-submit verification for the bridge tier: a landed turn appends events
// to the rollout within moments. Baseline the size before the submit, then
// poll for growth. No growth inside the window means the submit cannot be
// CONFIRMED — the caller treats it as failed and falls back.
export function rolloutSize(sessionPath) {
  try {
    return fs.statSync(sessionPath).size;
  } catch {
    return -1;
  }
}

export async function waitForRolloutGrowth(sessionPath, baselineSize, { timeoutMs = 8000, pollMs = 500 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const size = rolloutSize(sessionPath);
    if (size > baselineSize) return { grew: true, size, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) return { grew: false, size, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---- near-now heartbeat automation (fallback tier) --------------------------

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

export function openAutomationId(relayId) {
  const slug = slugify(relayId);
  return `${OPEN_AUTOMATION_PREFIX}${slug || "relay"}`;
}

// TOML basic-string escaping, byte-for-byte the app's own automation writer
// (backslash, newline, carriage return, tab, double quote), plus a defensive
// sweep of remaining C0 controls which would make the file unparseable.
function tomlString(value) {
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, " ");
  return `"${escaped}"`;
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function wallClockParts(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) parts[part.type] = part.value;
  const hour = parts.hour === "24" ? "00" : parts.hour; // some ICU builds render midnight as 24
  return {
    stamp: `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`,
    hour: Number(hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// One occurrence, delayMs from now, rounded UP to a whole minute (the app's
// own automations fire on whole minutes; BYSECOND=0 matches its scheduler's
// fast paths). Returns the rrule string exactly like the app's writer stores
// it — a real newline between DTSTART and RRULE, escaped by tomlString.
export function buildNearNowHeartbeatRrule({
  nowMs = Date.now(),
  delayMs = DEFAULT_OPEN_AUTOMATION_DELAY_MS,
  timeZone = localTimeZone(),
} = {}) {
  const fireAtMs = Math.ceil((nowMs + delayMs) / 60000) * 60000;
  const { stamp, hour, minute } = wallClockParts(fireAtMs, timeZone);
  return {
    fireAtMs,
    rrule: `DTSTART;TZID=${timeZone}:${stamp}\nRRULE:FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0;COUNT=1`,
  };
}

// Exact automation.toml shape (field order + escaping) of the app's own
// heartbeat writer. The id MUST equal the directory name or the app's loader
// rejects the file.
export function buildOpenAutomationToml({ id, name, prompt, rrule, targetThreadId, createdAt, updatedAt }) {
  return [
    "version = 1",
    `id = ${tomlString(id)}`,
    `kind = ${tomlString("heartbeat")}`,
    `name = ${tomlString(name)}`,
    `prompt = ${tomlString(prompt)}`,
    `status = ${tomlString("ACTIVE")}`,
    `rrule = ${tomlString(rrule)}`,
    `target_thread_id = ${tomlString(targetThreadId)}`,
    `created_at = ${createdAt}`,
    `updated_at = ${updatedAt}`,
    "",
  ].join("\n");
}

function automationsDir(homeDir) {
  return path.join(homeDir, "automations");
}

function readAutomationFields(tomlPath) {
  let text = "";
  try {
    text = fs.readFileSync(tomlPath, "utf8");
  } catch {
    return null;
  }
  const field = (name) => {
    const match = new RegExp(`^${name} = "((?:[^"\\\\]|\\\\.)*)"`, "m").exec(text);
    return match ? match[1] : null;
  };
  const createdMatch = /^created_at = (\d+)/m.exec(text);
  return {
    targetThreadId: field("target_thread_id"),
    createdAtMs: createdMatch ? Number(createdMatch[1]) : null,
  };
}

// Remove relay-open-* automation dirs older than maxAgeMs (they fired — or
// missed — long ago and a lingering ACTIVE heartbeat blocks the app from
// creating a real one on the same thread), plus any relay-open-* automation
// already targeting `supersedeThreadId` (newest click wins, mirroring
// stageInjection's overwrite semantics). Never touches non-relay dirs.
export function cleanupStaleOpenAutomations({
  homeDir = defaultCodexHome(),
  nowMs = Date.now(),
  maxAgeMs = OPEN_AUTOMATION_MAX_AGE_MS,
  supersedeThreadId = null,
} = {}) {
  const dir = automationsDir(homeDir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(OPEN_AUTOMATION_PREFIX)) continue;
    const automationDir = path.join(dir, entry.name);
    const fields = readAutomationFields(path.join(automationDir, "automation.toml"));
    let ageMs = null;
    if (fields && Number.isFinite(fields.createdAtMs)) {
      ageMs = nowMs - fields.createdAtMs;
    } else {
      try {
        ageMs = nowMs - fs.statSync(automationDir).mtimeMs;
      } catch {
        ageMs = Infinity; // unreadable relay-open dir carries no signal
      }
    }
    const supersedes = Boolean(supersedeThreadId && fields && fields.targetThreadId === supersedeThreadId);
    if (ageMs > maxAgeMs || supersedes) {
      try {
        fs.rmSync(automationDir, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {}
    }
  }
  return removed;
}

// Stage the fallback tier: a near-now, single-shot heartbeat automation
// targeting the resolved current thread, prompt = the shared injection
// instruction (never the relay body). Returns { id, dir, path, fireAtMs }.
export function writeOpenAutomation({
  homeDir = defaultCodexHome(),
  relayId,
  threadId,
  instruction,
  nowMs = Date.now(),
  delayMs = Number(process.env.RELAY_CODEX_AUTOMATION_DELAY_MS) || DEFAULT_OPEN_AUTOMATION_DELAY_MS,
  timeZone = localTimeZone(),
} = {}) {
  const cleanThreadId = String(threadId || "").trim();
  if (!cleanThreadId) throw new Error("writeOpenAutomation requires a threadId");
  const prompt = String(instruction || "").trim() || buildInjectionInstruction({ relayId });
  cleanupStaleOpenAutomations({ homeDir, nowMs, supersedeThreadId: cleanThreadId });
  const id = openAutomationId(relayId);
  const { rrule, fireAtMs } = buildNearNowHeartbeatRrule({ nowMs, delayMs, timeZone });
  const toml = buildOpenAutomationToml({
    id,
    name: `Relay open ${String(relayId || "").trim() || "relay"}`,
    prompt,
    rrule,
    targetThreadId: cleanThreadId,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  const dir = path.join(automationsDir(homeDir), id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "automation.toml");
  const tmp = path.join(dir, `.automation.toml.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, toml, "utf8");
  fs.renameSync(tmp, filePath);
  return { id, dir, path: filePath, fireAtMs };
}
