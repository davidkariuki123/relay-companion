// WHAT IS CONNECTED ON THIS COMPUTER (Setup, 2026-10-07).
//
// One read-only answer for the pill's Setup page: for every AI app a person
// might use here, is it installed, is Relay registered in the config that app
// reads, does that registration point at something that exists, and is it
// working right now. "Connected" is only ever said from evidence:
//
//   registered  the app's own config names Relay (the same files setup writes)
//   valid       the command that entry runs exists on disk
//   live        a Relay MCP bridge is running under that app at this moment
//   started     (Claude app) its own mcp.log says Relay started after launch
//
// The Claude app reads its config once, at launch, so a registration it has
// not loaded yet is "restart", not "connected". Codex (the ChatGPT app and the
// CLI) and Claude Code start their tools per chat, so a new chat picks a fresh
// registration up and there is no restart to ask for.
//
// Nothing here writes. Connecting goes through install.js (connectAgentHost),
// the same registration code setup and repair use.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCliPath, codexCliPath } from "./capabilities.js";
import { claudeDesktopConfigDirs, claudeDesktopConfigPathIn } from "./desktop-hosts.js";

export const AGENT_HOST_IDS = Object.freeze(["claude-app", "chatgpt-app", "claude-code", "codex", "conductor"]);

/** A bridge started this long after the app is still "starting", not missing. */
const CLAUDE_STARTUP_GRACE_MS = 20_000;
const LOG_TAIL_BYTES = 512 * 1024;

function exists(file) {
  try { return Boolean(file) && fs.existsSync(file); } catch { return false; }
}

function findApp(roots, names) {
  for (const root of roots) for (const name of names) {
    const candidate = path.join(root, `${name}.app`);
    if (exists(candidate)) return candidate;
  }
  return "";
}

/** The command an MCP entry runs, and whether every file it names exists. */
export function entryValidity(entry) {
  if (!entry || typeof entry !== "object") return { command: "", valid: false };
  const command = String(entry.command || "").trim();
  if (!command) return { command, valid: false };
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  // Absolute commands must exist; a bare one ("npx") cannot be checked and
  // the GUI apps cannot find it on their curated PATH, so it is not valid.
  if (!path.isAbsolute(command) || !exists(command)) return { command, valid: false };
  const scripts = args.filter((arg) => path.isAbsolute(arg) && /\.(c|m)?js$/.test(arg));
  return { command, valid: scripts.every(exists) };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function jsonRelayEntry(file) {
  const config = readJson(file);
  const servers = config && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : null;
  return servers?.relay && typeof servers.relay === "object" ? servers.relay : null;
}

/** [mcp_servers.relay] from a config.toml, as { command, args }. */
export function tomlRelayEntry(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.relay]");
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const table = lines.slice(start + 1, end).join("\n");
  const command = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(table)?.[1]?.replace(/\\(.)/g, "$1") || "";
  const argsText = /^\s*args\s*=\s*\[([\s\S]*?)\]/m.exec(table)?.[1] || "";
  const args = [...argsText.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
  return { command, args };
}

/** `ps` rows: owner, pid, parent, start time and command line. */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[4]);
    rows.push({ uid: Number(match[1]), pid: Number(match[2]), ppid: Number(match[3]), startedAt: Number.isFinite(startedAt) ? startedAt : 0, command: match[5] });
  }
  return rows;
}

function readProcesses() {
  try {
    return parseProcessTable(execFileSync("/bin/ps", ["-axo", "uid=,pid=,ppid=,lstart=,command="], {
      encoding: "utf8", timeout: 4000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch { return []; }
}

const BRIDGE = /[/\\]\.relay[/\\]bin[/\\]mcp-(bridge|launcher)|[/\\]bin[/\\]relay\.js\s+mcp\b/;

/** The Claude app's own account of Relay's server since a given time. */
export function claudeRelayLog(text, since = 0) {
  let started = 0;
  let failed = 0;
  for (const line of String(text || "").split("\n")) {
    if (!line.includes("[relay]")) continue;
    const at = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(at) || at < since) continue;
    if (/Server started and connected successfully/.test(line)) started = Math.max(started, at);
    else if (/\[error\]/.test(line) || /Server disconnected|failed|ENOENT|MODULE_NOT_FOUND/i.test(line)) failed = Math.max(failed, at);
  }
  return { started, failed };
}

function tail(file, bytes = LOG_TAIL_BYTES) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

/**
 * @returns {{ hosts: Array<{ id: string, installed: boolean, where: string, registered: boolean, valid: boolean,
 *   running: boolean, live: boolean, state: "absent"|"available"|"broken"|"restart"|"connected", configPath: string,
 *   startedAt: number }>, scannedAt: number }}
 */
export function inspectAgentHosts({
  env = process.env,
  platform = process.platform,
  homeDir = env.HOME || os.homedir(),
  // Test seams: a sandbox Applications folder and bin folder stand in for the
  // real ones, so a sandboxed pill never reads this Mac's own apps.
  appsDir = env.RELAY_OVERLAY_TEST_APPS_DIR || "",
  binDir = env.RELAY_OVERLAY_TEST_BIN_DIR || "",
  processes = null,
  // { claude, codex }: CLI paths found ahead of time (inspectAgentHostsAsync).
  cli = null,
  now = Date.now(),
} = {}) {
  const mac = platform === "darwin";
  const roots = appsDir ? [appsDir] : mac ? ["/Applications", path.join(homeDir, "Applications")] : [];
  const claudeApp = mac ? findApp(roots, ["Claude"]) : "";
  const chatgptApp = mac ? findApp(roots, ["ChatGPT", "Codex"]) : "";
  const conductorApp = mac ? findApp(roots, ["Conductor"]) : "";
  const cliEnv = { ...env, HOME: homeDir };
  const insideApp = (file) => /\.app[/\\]/.test(file);
  const claudeCli = appsDir || binDir
    ? (binDir && exists(path.join(binDir, "claude")) ? path.join(binDir, "claude") : "")
    : cli ? String(cli.claude || "") : claudeCliPath({ env: cliEnv, homedir: homeDir });
  const codexCliFound = appsDir || binDir
    ? (binDir && exists(path.join(binDir, "codex")) ? path.join(binDir, "codex") : "")
    : cli ? String(cli.codex || "") : codexCliPath({ env: cliEnv });
  const codexCli = codexCliFound && !insideApp(codexCliFound) ? codexCliFound : "";
  const claudeDesktopCode = path.join(homeDir, "Library", "Application Support", "Claude", "claude-code");

  // Registrations, from the same files setup writes.
  const desktopDirs = mac || platform === "win32"
    ? claudeDesktopConfigDirs({ env: { ...env, HOME: homeDir }, platform, exists: (dir) => exists(dir) })
    : [];
  const desktopConfig = desktopDirs.length
    ? desktopDirs.map(claudeDesktopConfigPathIn).find(exists) || claudeDesktopConfigPathIn(desktopDirs[0])
    : claudeApp ? path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json") : "";
  const claudeCodeConfig = env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json");
  const codexConfig = env.CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml");
  let codexText = "";
  try { codexText = fs.readFileSync(codexConfig, "utf8"); } catch {}
  const desktopEntry = desktopConfig ? jsonRelayEntry(desktopConfig) : null;
  const codeEntry = jsonRelayEntry(claudeCodeConfig);
  const codexEntry = tomlRelayEntry(codexText);

  // What is running, and which app each live Relay bridge belongs to.
  // Only this person's processes: on a shared Mac, someone else's Claude is
  // not this person's Claude.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const table = (Array.isArray(processes) ? processes : readProcesses())
    .filter((row) => uid === null || row.uid === undefined || row.uid === uid);
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const under = (app) => (row) => Boolean(app) && row.command.startsWith(`${app}/Contents/`);
  const mainOf = (app) => (app ? table.find((row) => row.command.startsWith(`${app}/Contents/MacOS/`) && !/\s--type=/.test(row.command)
    && !(byPid.get(row.ppid)?.command || "").startsWith(`${app}/Contents/MacOS/`)) : null) || null;
  const isClaudeCode = (row) => /[/\\]claude-code[/\\]/.test(row.command)
    || (claudeCli && row.command.split(/\s+/)[0] === claudeCli) || /(^|[/\\])claude(\s|$)/.test(row.command.split(/\s+/)[0] || "");
  const isCodexCli = (row) => {
    const head = row.command.split(/\s+/)[0] || "";
    return !insideApp(head) && /(^|[/\\])codex$/.test(head);
  };
  const live = new Set();
  // A bridge of this home's Relay (~/.relay/bin), or Relay's own CLI.
  const ownBridge = (command) => BRIDGE.test(command)
    && (!/[/\\]\.relay[/\\]bin[/\\]/.test(command) || command.includes(path.join(homeDir, ".relay", "bin")));
  for (const row of table) {
    if (!ownBridge(row.command)) continue;
    let nearest = "";
    let cursor = byPid.get(row.ppid);
    for (let depth = 0; cursor && depth < 16; depth += 1, cursor = byPid.get(cursor.ppid)) {
      if (!nearest) {
        if (isClaudeCode(cursor)) nearest = "claude-code";
        else if (under(chatgptApp)(cursor)) nearest = "chatgpt-app";
        else if (isCodexCli(cursor)) nearest = "codex";
        else if (under(claudeApp)(cursor)) nearest = "claude-app";
        if (nearest) live.add(nearest);
      }
      if (under(conductorApp)(cursor)) { live.add("conductor"); break; }
      if (cursor.pid <= 1) break;
    }
  }

  const desktopValid = entryValidity(desktopEntry).valid;
  const codeValid = entryValidity(codeEntry).valid;
  const codexValid = entryValidity(codexEntry).valid;

  const claudeMain = mainOf(claudeApp);
  const chatgptMain = mainOf(chatgptApp);
  const conductorMain = mainOf(conductorApp);

  const hosts = [];
  // THE CLAUDE APP. Chats and Cowork read claude_desktop_config.json at launch.
  {
    const installed = Boolean(claudeApp);
    const running = Boolean(claudeMain);
    const startedAt = claudeMain?.startedAt || 0;
    let state = !installed ? "absent" : !desktopEntry ? "available" : !desktopValid ? "broken" : "connected";
    let stoppedAfterStart = false;
    if (state === "connected" && running && !live.has("claude-app")) {
      const log = claudeRelayLog(tail(path.join(homeDir, "Library", "Logs", "Claude", "mcp.log")), startedAt);
      // Claude starts every server it knows at launch and keeps it running,
      // so a registration with no Relay bridge under the app and no start in
      // its log since launch is one it has not loaded. (Its config file's
      // date says nothing: Claude rewrites that file itself all the time.)
      // Started, then stopped (a Relay update restarts its service, and the
      // Claude app never starts a server twice): a restart brings it back.
      // Failed without ever starting since launch: the registration itself
      // is the problem.
      if (log.failed > log.started && !log.started) state = "broken";
      else if (log.failed > log.started) { state = "restart"; stoppedAfterStart = true; }
      else if (!log.started && now - startedAt > CLAUDE_STARTUP_GRACE_MS) state = "restart";
    }
    hosts.push({ id: "claude-app", installed, where: claudeApp, registered: Boolean(desktopEntry), valid: desktopValid,
      running, live: live.has("claude-app"), state, stopped: state === "restart" && stoppedAfterStart, configPath: desktopConfig, startedAt, pid: claudeMain?.pid || 0 });
  }
  // THE CHATGPT APP, which is also Codex's desktop app: ~/.codex/config.toml.
  {
    const installed = Boolean(chatgptApp);
    const state = !installed ? "absent" : !codexEntry ? "available" : !codexValid ? "broken" : "connected";
    hosts.push({ id: "chatgpt-app", installed, where: chatgptApp, registered: Boolean(codexEntry), valid: codexValid,
      running: Boolean(chatgptMain), live: live.has("chatgpt-app"), state, configPath: codexConfig, startedAt: chatgptMain?.startedAt || 0 });
  }
  // CLAUDE CODE, in Terminal or inside the Claude app: ~/.claude.json.
  {
    const where = claudeCli || (exists(claudeDesktopCode) ? claudeDesktopCode : "");
    const installed = Boolean(where) || (!appsDir && exists(claudeCodeConfig));
    const state = !installed ? "absent" : !codeEntry ? "available" : !codeValid ? "broken" : "connected";
    hosts.push({ id: "claude-code", installed, where: claudeCli ? "terminal" : where ? "claude-app" : "", registered: Boolean(codeEntry), valid: codeValid,
      running: table.some(isClaudeCode), live: live.has("claude-code"), state, configPath: claudeCodeConfig, startedAt: 0 });
  }
  // THE CODEX CLI, which shares the ChatGPT app's config.
  {
    const installed = Boolean(codexCli);
    const state = !installed ? "absent" : !codexEntry ? "available" : !codexValid ? "broken" : "connected";
    hosts.push({ id: "codex", installed, where: codexCli ? "terminal" : "", registered: Boolean(codexEntry), valid: codexValid,
      running: table.some(isCodexCli), live: live.has("codex"), state, configPath: codexConfig, startedAt: 0 });
  }
  // CONDUCTOR runs Claude Code and Codex in workspaces of its own, so it has
  // Relay exactly when either of their registrations is good.
  {
    const installed = Boolean(conductorApp);
    const registered = Boolean(codeEntry || codexEntry);
    const valid = (Boolean(codeEntry) && codeValid) || (Boolean(codexEntry) && codexValid);
    const state = !installed ? "absent" : !registered ? "available" : !valid ? "broken" : "connected";
    hosts.push({ id: "conductor", installed, where: conductorApp, registered, valid,
      running: Boolean(conductorMain), live: live.has("conductor"), state, configPath: "", startedAt: conductorMain?.startedAt || 0 });
  }
  return { hosts, scannedAt: now };
}

// The pill's main process must never block on a child process (a frozen pill
// is worse than a stale row): the same answer, with `ps` and the CLI lookups
// run asynchronously, and the CLIs looked up at most once a minute.
const CLI_TTL_MS = 60_000;
let cliCache = { at: 0, value: null };
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 4000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout || "")));
  });
}
async function findCli(name, candidates, env) {
  const hit = candidates.find(exists);
  if (hit) return hit;
  return (await run("/usr/bin/which", [name])).trim().split("\n")[0] || "";
}
export async function inspectAgentHostsAsync(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || env.HOME || os.homedir();
  const now = options.now || Date.now();
  if (!cliCache.value || now - cliCache.at > CLI_TTL_MS) {
    const [claude, codex] = await Promise.all([
      String(env.RELAY_CLAUDE_CLI_PATH || "").trim() || findCli("claude", [path.join(homeDir, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"], env),
      String(env.CODEX_CLI_PATH || "").trim() || findCli("codex", ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"], env),
    ]);
    cliCache = { at: now, value: { claude, codex } };
  }
  const processes = (options.platform || process.platform) === "win32" ? [] : parseProcessTable(await run("/bin/ps", ["-axo", "uid=,pid=,ppid=,lstart=,command="]));
  return inspectAgentHosts({ ...options, processes, cli: cliCache.value });
}
