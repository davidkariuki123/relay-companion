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
// And, per PLACE a person opens (2026-10-09, `places`): Claude Code in the
// Claude app and in Terminal share one config but are two places, as are the
// ChatGPT app and the Codex CLI. A place is green only from proof that Relay
// worked THERE: a bridge under it now, a session it opened (host-evidence.js),
// or its own transcripts (host-history.js). Registered and never seen is
// "unproven", not connected. For Codex, the binary each place runs is asked to
// read the config itself (`codex mcp get relay --json`): an older Codex that
// cannot parse it (Conductor's bundled one, measured) is broken there,
// whatever the file says.
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
import { HOST_PLACES, placeOfAncestry, readHostEvidence } from "./host-evidence.js";
import { readHostHistory } from "./host-history.js";

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
  // Proof, per place (see the header). null = not read yet.
  evidence = null,
  history = null,
  hostChecks = null,
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
  // place -> when its oldest running Relay session started.
  const livePlaces = new Map();
  const apps = { claude: claudeApp, chatgpt: chatgptApp, conductor: conductorApp };
  // A bridge of this home's Relay (~/.relay/bin), or Relay's own CLI.
  const ownBridge = (command) => BRIDGE.test(command)
    && (!/[/\\]\.relay[/\\]bin[/\\]/.test(command) || command.includes(path.join(homeDir, ".relay", "bin")));
  for (const row of table) {
    if (!ownBridge(row.command)) continue;
    const chain = [];
    for (let cursor = byPid.get(row.ppid), depth = 0; cursor && depth < 16; depth += 1, cursor = byPid.get(cursor.ppid)) {
      chain.push(cursor.command);
      if (cursor.pid <= 1) break;
    }
    const place = placeOfAncestry(chain, { apps });
    if (place) livePlaces.set(place, Math.min(livePlaces.get(place) ?? Infinity, row.startedAt || 0));
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

  // PLACES: what a person opens. Each says one thing, Connected or not, and
  // says Connected only when that place's own app confirms Relay (its own
  // `mcp get relay`, or the Claude app's own log) and nothing has failed
  // there since. Past tool calls and the API refusing Relay's tools are kept
  // underneath as the evidence; the person never has to read them.
  const conductorBin = (name) => path.join(homeDir, "Library", "Application Support", "com.conductor.app", "bin", name);
  const claudeHost = hosts[0];
  const code = { registered: Boolean(codeEntry), valid: codeValid };
  const codex = { registered: Boolean(codexEntry), valid: codexValid };
  const defs = {
    "claude-chat": { installed: Boolean(claudeApp), registered: Boolean(desktopEntry), valid: desktopValid, host: "claude-app" },
    "claude-code:app": { installed: exists(claudeDesktopCode), ...code, host: "claude-code" },
    "claude-code:terminal": { installed: Boolean(claudeCli), ...code, host: "claude-code" },
    "claude-code:conductor": { installed: Boolean(conductorApp) && exists(conductorBin("claude")), ...code, host: "conductor" },
    "codex:chatgpt-app": { installed: Boolean(chatgptApp), ...codex, host: "chatgpt-app" },
    "codex:terminal": { installed: Boolean(codexCli), ...codex, host: "codex" },
    "codex:conductor": { installed: Boolean(conductorApp) && exists(conductorBin("codex")), ...codex, host: "conductor" },
  };
  const places = {};
  for (const place of HOST_PLACES) {
    const def = defs[place];
    const record = evidence?.[place] || null;
    const past = history?.[place] || null;
    const usedAt = Math.max(Number(record?.calledAt) || 0, Number(past?.usedAt) || 0);
    const refusedAt = Number(past?.refusedAt) || 0;
    const check = hostChecks?.[place];
    // connected: true | false | null (not known yet; never a guess)
    let connected = false;
    let action = "";
    let reason = "";
    if (!def.installed) { connected = false; }
    else if (!def.registered) { action = "connect"; }
    else if (!def.valid) { action = "fix"; reason = "registration_missing_files"; }
    else if (place === "claude-chat" && claudeHost.state === "restart") { action = "restart"; reason = claudeHost.stopped ? "stopped" : "not_loaded"; }
    else if (place === "claude-chat" && claudeHost.state === "broken") { action = "fix"; reason = "failed_to_start"; }
    else if (check?.ok === false) { action = "fix"; reason = check.reason || "app_check_failed"; }
    // Measured: Claude Code 2.1.156's API refused Relay's tool list; nothing
    // Relay can rewrite fixes an old app, so the words say what will.
    else if (refusedAt > usedAt) { reason = "app_too_old"; }
    else if (check?.ok === true || (place === "claude-chat" && claudeHost.state === "connected")) { connected = true; }
    // The app has not answered yet: a Relay call in a session open right now
    // is proof enough; otherwise wait rather than guess.
    else if (livePlaces.has(place) && usedAt > 0 && usedAt >= livePlaces.get(place) - 60_000) { connected = true; }
    else { connected = null; }
    places[place] = {
      installed: def.installed,
      host: def.host,
      connected,
      ...(action ? { action } : {}),
      ...(reason ? { reason } : {}),
      ...(check?.detail ? { detail: check.detail } : {}),
      ...(check?.version || (reason === "app_too_old" && past?.refusedVersion) ? { version: check?.version || past.refusedVersion } : {}),
      live: livePlaces.has(place),
      usedAt,
    };
  }
  return { hosts, places, scannedAt: now };
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
  const store = evidenceHome(env, homeDir);
  const appsDir = options.appsDir ?? env.RELAY_OVERLAY_TEST_APPS_DIR ?? "";
  let history = options.history !== undefined ? options.history : historyFor({ homeDir, store, now });
  let checks = options.hostChecks !== undefined ? { results: options.hostChecks, pending: [] }
    : hostChecksFor({ homeDir, env, appsDir, cli: cliCache.value, now });
  // The first scan waits for the apps' answers (the page says "Looking…"
  // meanwhile), so no row ever shows a provisional state; later scans use
  // what is known and refresh in the background.
  if (!primed && (checks.pending.length || (history === null && historyState.pending))) {
    const cap = new Promise((resolve) => setTimeout(resolve, FIRST_SCAN_WAIT_MS).unref?.());
    await Promise.race([Promise.all([...checks.pending, historyState.pending].filter(Boolean)), cap]);
    if (options.history === undefined) history = historyState.value;
    if (options.hostChecks === undefined) checks = hostChecksFor({ homeDir, env, appsDir, cli: cliCache.value, now: Date.now() });
  }
  primed = true;
  const evidence = options.evidence !== undefined ? options.evidence : readHostEvidence(store);
  return inspectAgentHosts({ ...options, processes, cli: cliCache.value, evidence, history, hostChecks: checks.results });
}

/** Where Relay's own record lives: the companion store (host-paths.storeDir). */
function evidenceHome(env, homeDir) {
  return env.RELAY_HOME || env.RELAY_COMPANION_HOME || path.join(homeDir, ".relay-companion");
}

// The apps' own transcripts, read in the background at most once a minute
// (awaited only by the first scan): they say where Relay was last used, and
// where an app's API refused Relay's tools.
const HISTORY_TTL_MS = 60_000;
const FIRST_SCAN_WAIT_MS = 12_000;
let primed = false;
const historyState = { at: 0, value: null, pending: null, files: null, home: "" };
function historyFor({ homeDir, store, now }) {
  if (historyState.home !== homeDir) Object.assign(historyState, { at: 0, value: null, pending: null, files: null, home: homeDir });
  const cacheFile = path.join(store, "host-evidence", "history-cache.json");
  if (!historyState.files) historyState.files = readJson(cacheFile) || {};
  if (!historyState.pending && (!historyState.value || now - historyState.at > HISTORY_TTL_MS)) {
    historyState.pending = readHostHistory({ homeDir, now, cache: historyState.files })
      .then((value) => {
        Object.assign(historyState, { value, at: Date.now() });
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
          fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(historyState.files), { mode: 0o600 });
          fs.renameSync(`${cacheFile}.tmp`, cacheFile);
        } catch {}
      })
      .catch(() => {})
      .finally(() => { historyState.pending = null; });
  }
  return historyState.value;
}

// Each place's own app, asked whether it has Relay, the way it will be when a
// chat starts there. Claude Code's `mcp get relay` really connects to Relay
// ("Status: ✔ Connected"); Codex's `mcp get relay --json` parses the whole
// config (measured: Conductor's old Codex could not) and says if Relay is on.
// Asked in the background, again when the app or its Relay entry changes, and
// every few minutes, since a connection can stop working with nothing edited.
const HOST_CHECK_TTL_MS = 5 * 60_000;
const hostCheckCache = new Map(); // key -> { result, at } | { pending }
function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
export function codexCheckFromOutput(code, stdout, stderr) {
  if (code === 0) {
    try {
      const entry = JSON.parse(stdout);
      if (entry?.enabled === false) return { ok: false, reason: "turned_off", detail: String(entry?.disabled_reason || "") };
      return { ok: true };
    } catch { return null; }
  }
  const text = `${stderr}\n${stdout}`;
  if (/failed to load configuration|error loading config|invalid type|unknown variant|unknown field/i.test(text)) {
    const line = text.split("\n").map((entry) => entry.trim().replace(/^\d+:\s*/, "")).find((entry) => /invalid|unknown|expected/i.test(entry)) || "";
    // "<path>:497:1: invalid type…" → "line 497: invalid type…"
    return { ok: false, reason: "settings_unreadable", detail: line.replace(/^.*?config\.toml:(\d+):\d+:\s*/, "line $1: ").slice(0, 200) };
  }
  // A Codex too old for --json, or no answer: not known, never assumed.
  return null;
}
export function claudeCheckFromOutput(code, stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const status = /Status:\s*(.+)/.exec(text)?.[1]?.trim() || "";
  if (/✔|connected/i.test(status) && !/fail|not connected|✘|✗/i.test(status)) return { ok: true };
  if (status) return { ok: false, reason: "app_check_failed", detail: status.replace(/^[✘✗]\s*/, "").slice(0, 200) };
  return null;
}
/** The Claude Code the Claude app's Code tab runs: the newest one it downloaded. */
function claudeAppCli(homeDir) {
  const root = path.join(homeDir, "Library", "Application Support", "Claude", "claude-code");
  let versions = [];
  try { versions = fs.readdirSync(root).filter((name) => /^\d+\.\d+\.\d+/.test(name)); } catch { return ""; }
  const order = (a, b) => a.split(/[.-]/).map(Number).reduce((diff, part, i) => diff || part - (Number(b.split(/[.-]/)[i]) || 0), 0);
  for (const version of versions.sort(order).reverse()) {
    let builds = [];
    try { builds = fs.readdirSync(path.join(root, version)); } catch {}
    for (const build of builds) {
      const bin = path.join(root, version, build, "claude.app", "Contents", "MacOS", "claude");
      if (exists(bin)) return bin;
    }
  }
  return "";
}
function hostChecksFor({ homeDir, env, appsDir, cli, now }) {
  if (appsDir) return { results: {}, pending: [] };
  const support = path.join(homeDir, "Library", "Application Support");
  const chatgpt = ["ChatGPT", "Codex"].map((name) => path.join("/Applications", `${name}.app`, "Contents", "Resources", "codex")).find(exists) || "";
  const codexConfig = env.CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml");
  const claudeConfig = env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json");
  // Claude rewrites ~/.claude.json constantly; only its Relay entry matters.
  const claudeEntry = JSON.stringify(jsonRelayEntry(claudeConfig) || null);
  const checks = {
    "claude-code:app": { bin: claudeAppCli(homeDir), kind: "claude" },
    "claude-code:terminal": { bin: cli?.claude || "", kind: "claude" },
    "claude-code:conductor": { bin: path.join(support, "com.conductor.app", "bin", "claude"), kind: "claude" },
    "codex:chatgpt-app": { bin: chatgpt, kind: "codex" },
    "codex:terminal": { bin: cli?.codex && !/\.app[/\\]/.test(cli.codex) ? cli.codex : "", kind: "codex" },
    "codex:conductor": { bin: path.join(support, "com.conductor.app", "bin", "codex"), kind: "codex" },
  };
  // A clean environment: never a Claude session's own variables.
  const childEnv = { ...env, HOME: homeDir };
  for (const key of Object.keys(childEnv)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_SESSION_ID|ANTHROPIC_BASE_URL)/.test(key)) delete childEnv[key];
  const results = {};
  const pending = [];
  for (const [place, { bin, kind }] of Object.entries(checks)) {
    if (!bin || !exists(bin)) continue;
    let real = bin;
    try { real = fs.realpathSync(bin); } catch {}
    const key = kind === "codex"
      ? `${real}|${statMtime(real)}|${codexConfig}|${statMtime(codexConfig)}`
      : `${real}|${statMtime(real)}|${claudeEntry}`;
    const known = hostCheckCache.get(key);
    if (known?.result) results[place] = known.result;
    if (known?.pending) { pending.push(known.pending); continue; }
    if (known?.result && now - known.at < HOST_CHECK_TTL_MS) continue;
    const version = /[/\\](?:codex|claude)(?:-code)?[/\\](\d+\.\d+\.\d+[^/\\]*)[/\\]/.exec(real)?.[1] || "";
    const args = kind === "codex" ? ["mcp", "get", "relay", "--json"] : ["mcp", "get", "relay"];
    const promise = new Promise((resolve) => {
      execFile(bin, args, { encoding: "utf8", timeout: 20_000, cwd: homeDir, env: childEnv }, (error, stdout, stderr) => {
        if (error?.killed) return resolve(null);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const parse = kind === "codex" ? codexCheckFromOutput : claudeCheckFromOutput;
        const result = parse(code, String(stdout || ""), String(stderr || ""));
        resolve(result ? { ...result, ...(version ? { version } : {}) } : null);
      });
    }).then((result) => {
      if (result) hostCheckCache.set(key, { result, at: Date.now() });
      else if (known?.result) hostCheckCache.set(key, known);
      else hostCheckCache.delete(key);
    });
    hostCheckCache.set(key, { ...(known?.result ? { result: known.result, at: known.at } : {}), pending: promise });
    pending.push(promise);
  }
  return { results, pending };
}
