// WHERE RELAY HAS ACTUALLY WORKED (2026-10-09).
//
// A config file that names Relay says the app was asked to load it, never
// that it did. The proof is the app itself talking to Relay: its MCP
// `initialize` (which names the client), its `tools/list`, and its tool calls.
// Every one of those reaches a Relay MCP session, so the session writes down
// where it is running, and the Setup page reads these records instead of
// inferring a connection from files.
//
// "Where" is a place a person opens, not a config file: Claude Code in the
// Claude app's Code tab and Claude Code in Terminal share ~/.claude.json, and
// the ChatGPT app and the Codex CLI share ~/.codex/config.toml, but each can
// work or not on its own. A place is read from the session's process
// ancestry (and Conductor's own client name), never guessed from the config.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOST_PLACES = Object.freeze([
  "claude-chat",
  "claude-code:app",
  "claude-code:terminal",
  "claude-code:conductor",
  "codex:chatgpt-app",
  "codex:terminal",
  "codex:conductor",
]);

// Conductor's Codex names itself in the handshake (measured: see mcp.js).
const CONDUCTOR_CLIENTS = new Set(["codex-local"]);

const CLAUDE_CLI = /[/\\]claude-code[/\\]|(^|[/\\])claude(\s|$)/;
const CODEX_CLI = /(^|[/\\])codex(\s|$)|[/\\]@openai[/\\]codex[/\\]/;
const CONDUCTOR_DATA = /[/\\]com\.conductor\.app[/\\]/;
const CLAUDE_APP_CODE = /[/\\]Application Support[/\\]Claude[/\\]claude-code[/\\]/;
// Relay's own processes between a host and its session.
const RELAY_WRAPPER = /[/\\]\.relay[/\\]bin[/\\]mcp-(bridge|launcher)|mcp-launcher\.c?js|[/\\]relay\.js\s+mcp\b/;

/** The app bundles that own each place, where they are installed. */
export function hostApps({ appsDir = "", homeDir = os.homedir(), platform = process.platform } = {}) {
  if (platform !== "darwin" && !appsDir) return { claude: "", chatgpt: "", conductor: "" };
  const roots = appsDir ? [appsDir] : ["/Applications", path.join(homeDir, "Applications")];
  const find = (names) => {
    for (const root of roots) for (const name of names) {
      const candidate = path.join(root, `${name}.app`);
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
    return "";
  };
  return { claude: find(["Claude"]), chatgpt: find(["ChatGPT", "Codex"]), conductor: find(["Conductor"]) };
}

/**
 * The place a Relay session runs in, from its ancestors' command lines (the
 * nearest first) and the client name its host sent. "" when it is none of the
 * places the Setup page shows (a test runner, Relay's own runs): unknown is
 * never filed under a place.
 */
export function placeOfAncestry(chain, { apps = {}, clientName = "" } = {}) {
  const commands = (Array.isArray(chain) ? chain : []).map((command) => String(command || ""));
  const under = (app) => (command) => Boolean(app) && command.startsWith(`${app}/Contents/`);
  // An app starts its MCP servers as its own children, so the host is the
  // session's parent (past Relay's own launcher). Anything further up is not
  // the host: tests run from a Claude Code terminal are not Claude Code.
  const at = commands.findIndex((command) => !RELAY_WRAPPER.test(command));
  const host = at < 0 ? "" : commands[at];
  const above = at < 0 ? "" : commands[at + 1] || "";
  const inConductor = CONDUCTOR_CLIENTS.has(clientName)
    || commands.some((command) => under(apps.conductor)(command) || CONDUCTOR_DATA.test(command));
  // The ChatGPT app's own codex lives inside its bundle; check it first.
  if (under(apps.chatgpt)(host)) return inConductor ? "codex:conductor" : "codex:chatgpt-app";
  if (CODEX_CLI.test(host)) return inConductor ? "codex:conductor" : "codex:terminal";
  if (CLAUDE_CLI.test(host)) {
    if (inConductor) return "claude-code:conductor";
    // The Code tab's CLI is the one the Claude app downloaded, started by the
    // app itself. A `claude` typed in a shell is Terminal, wherever the shell is.
    if (CLAUDE_APP_CODE.test(host) || under(apps.claude)(above)) return "claude-code:app";
    return "claude-code:terminal";
  }
  // The Claude app itself (its helper) starting Relay: its chats.
  if (under(apps.claude)(host)) return "claude-chat";
  return "";
}

/** The command lines above a process, nearest first, from a `ps` table. */
export function ancestryOf(pid, table) {
  const byPid = new Map((Array.isArray(table) ? table : []).map((row) => [row.pid, row]));
  const self = byPid.get(pid);
  const chain = [];
  let cursor = self ? byPid.get(self.ppid) : null;
  for (let depth = 0; cursor && depth < 24; depth += 1, cursor = byPid.get(cursor.ppid)) {
    chain.push(cursor.command);
    if (cursor.pid <= 1) break;
  }
  return { command: self?.command || "", chain };
}

function readProcessTable() {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve([]);
    execFile("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 4000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      const rows = [];
      for (const line of String(stdout || "").split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
      }
      resolve(rows);
    });
  });
}

// ---- The record: one small file per place, written atomically. ----

export function hostEvidenceDir(homeDir) {
  return path.join(homeDir, "host-evidence");
}

const TIME_FIELDS = ["firstSeenAt", "connectedAt", "listedAt", "calledAt", "refusedAt"];

export function readHostEvidence(homeDir) {
  const out = {};
  for (const place of HOST_PLACES) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(hostEvidenceDir(homeDir), `${place.replace(":", "@")}.json`), "utf8"));
      if (record && record.place === place) out[place] = record;
    } catch {}
  }
  return out;
}

/** Merge one observation into a place's record: times only move forward. */
export function writeHostEvidence(homeDir, place, observation, { now = Date.now() } = {}) {
  if (!HOST_PLACES.includes(place)) return null;
  const dir = hostEvidenceDir(homeDir);
  const file = path.join(dir, `${place.replace(":", "@")}.json`);
  let record = {};
  try { record = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const next = { ...record, place };
  for (const key of TIME_FIELDS) {
    const value = Number(observation[key]) || 0;
    if (value > (Number(next[key]) || 0)) next[key] = value;
  }
  if (!next.firstSeenAt) next.firstSeenAt = now;
  if (observation.client?.name) next.client = { name: String(observation.client.name).slice(0, 80), version: String(observation.client.version || "").slice(0, 40) };
  if (observation.bridge) next.bridge = String(observation.bridge).slice(0, 400);
  if (observation.toolCount !== undefined) next.toolCount = Number(observation.toolCount) || 0;
  if (observation.refusal) next.refusal = String(observation.refusal).slice(0, 120);
  if (observation.calledAt && observation.calledAt >= (Number(next.refusedAt) || 0)) delete next.refusal;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
  return next;
}

const CALL_WRITE_INTERVAL_MS = 60_000;

/**
 * One Relay MCP session's witness. The session calls it on initialize, on
 * tools/list and after each tool call; it finds its place once (the process
 * tree, read asynchronously so a call never waits on `ps`) and writes only
 * what moved: a busy session writes a call at most once a minute.
 */
export function createHostWitness({
  homeDir,
  bridgePid = process.pid,
  apps = null,
  processTable = readProcessTable,
  now = () => Date.now(),
  disabled = process.env.RELAY_HOST_EVIDENCE === "0",
} = {}) {
  if (disabled || !homeDir) return { connected() {}, listed() {}, called() {}, refused() {}, place: async () => "" };
  let placePromise = null;
  let client = { name: "", version: "" };
  let lastCallWrite = -Infinity;
  const resolvePlace = () => {
    if (!placePromise) {
      placePromise = (async () => {
        const table = await processTable();
        const { command, chain } = ancestryOf(bridgePid, table);
        const place = placeOfAncestry(chain, { apps: apps || hostApps(), clientName: client.name });
        return { place, bridge: command };
      })().catch(() => ({ place: "", bridge: "" }));
    }
    return placePromise;
  };
  const write = (observation) => {
    void resolvePlace().then(({ place, bridge }) => {
      if (place) writeHostEvidence(homeDir, place, { ...observation, client, bridge });
    });
  };
  return {
    connected(clientInfo) {
      client = { name: String(clientInfo?.name || ""), version: String(clientInfo?.version || "") };
      // Relay's own probe of a registration is not the host using it.
      if (client.name === "relay-probe") { placePromise = Promise.resolve({ place: "", bridge: "" }); return; }
      write({ connectedAt: now() });
    },
    listed(toolCount) { write({ listedAt: now(), toolCount }); },
    called() {
      const at = now();
      if (at - lastCallWrite < CALL_WRITE_INTERVAL_MS) return;
      lastCallWrite = at;
      write({ calledAt: at });
    },
    refused(reason) { write({ refusedAt: now(), refusal: reason }); },
    place: async () => (await resolvePlace()).place,
  };
}
