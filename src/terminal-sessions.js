import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexCliPath, claudeCliPath } from "./capabilities.js";
import { storeDir } from "./host-paths.js";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function run(command, args, options = {}) {
  try {
    return String(execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      ...options,
    }) || "");
  } catch {
    return "";
  }
}

export function terminalProcessState(pid, { runImpl = run, platform = process.platform, isAlive = processAlive } = {}) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return { alive: false, pid: value, tty: "", state: "" };
  // Windows has no job-control states: a console process is alive or gone.
  if (platform === "win32") return { alive: isAlive(value), suspended: false, zombie: false, pid: value, state: "", tty: "" };
  const output = runImpl("/bin/ps", ["-p", String(value), "-o", "state=", "-o", "tty="]);
  const match = String(output || "").trim().match(/^(\S+)\s+(\S+)$/);
  if (!match) return { alive: false, pid: value, tty: "", state: "" };
  const state = match[1];
  return {
    alive: !/^Z/i.test(state),
    suspended: /^T/i.test(state),
    zombie: /^Z/i.test(state),
    pid: value,
    state,
    tty: match[2] === "??" ? "" : match[2],
  };
}

function terminalAppForBundle(bundle) {
  if (bundle === "com.googlecode.iterm2") return "iTerm2";
  if (bundle === "com.apple.Terminal") return "Terminal";
  return "";
}

function parseInventory(text, frontmostApp) {
  return String(text || "").split(/\r?\n/).map((line) => {
    const [app, windowIndex, tabIndex, selected, frontWindow, tty] = line.split("\t");
    if (!app || !tty) return null;
    return {
      app,
      windowIndex: Number(windowIndex),
      tabIndex: Number(tabIndex),
      tty: tty.replace(/^\/dev\//, ""),
      selectedInWindow: selected === "true",
      keyboardFocused: app === frontmostApp && frontWindow === "true" && selected === "true",
    };
  }).filter(Boolean);
}

export function macTerminalInventory({ runImpl = run, platform = process.platform } = {}) {
  if (platform !== "darwin") return [];
  const inventoryScript = `
set outputRows to {}
set sep to ASCII character 9
set frontBundle to ""
try
  tell application "System Events" to set frontBundle to bundle identifier of first application process whose frontmost is true
end try
if application "Terminal" is running then
 tell application "Terminal"
  set frontId to -1
  try
    set frontId to id of front window
  end try
  repeat with wi from 1 to count of windows
    set w to window wi
    set frontFlag to ((id of w) is frontId)
    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      set selectedFlag to (selected tab of w is t)
      set end of outputRows to "Terminal" & sep & wi & sep & ti & sep & selectedFlag & sep & frontFlag & sep & (tty of t)
    end repeat
  end repeat
 end tell
end if
if application "iTerm2" is running then
 tell application "iTerm2"
  repeat with wi from 1 to count of windows
    set w to window wi
    set frontFlag to (wi is 1)
    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      set selectedFlag to (current tab of w is t)
      set s to current session of t
      set end of outputRows to "iTerm2" & sep & wi & sep & ti & sep & selectedFlag & sep & frontFlag & sep & (tty of s)
    end repeat
  end repeat
 end tell
end if
set AppleScript's text item delimiters to linefeed
return ("Frontmost" & sep & frontBundle & linefeed & (outputRows as text))`;
  const lines = runImpl("/usr/bin/osascript", ["-e", inventoryScript]).split(/\r?\n/);
  const header = lines.shift()?.split("\t") || [];
  const frontmost = terminalAppForBundle(header[0] === "Frontmost" ? header[1] : "");
  return parseInventory(lines.join("\n"), frontmost);
}

function terminalProcesses(runImpl = run) {
  const output = runImpl("/bin/ps", ["-axo", "pid=,tty=,state=,pgid=,tpgid=,command="]);
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s+(.+)$/);
    if (!match || match[2] === "??") continue;
    const command = match[6];
    const executable = path.basename(command.trim().split(/\s+/, 1)[0] || "").toLowerCase();
    const provider = executable === "claude" ? "claude" : executable === "codex" ? "codex" : "";
    if (!provider) continue;
    rows.push({
      provider,
      pid: Number(match[1]),
      tty: match[2].replace(/^\/dev\//, ""),
      state: match[3],
      processGroupId: Number(match[4]),
      foregroundProcessGroupId: Number(match[5]),
      foreground: Number(match[4]) === Number(match[5]),
      command,
    });
  }
  return rows;
}

function codexSessionForProcess(row, runImpl = run) {
  const commandId = row.command.match(UUID_RE)?.[0];
  if (commandId) return commandId;
  const names = runImpl("/usr/sbin/lsof", ["-Fn", "-p", String(row.pid)]);
  for (const line of names.split(/\r?\n/)) {
    if (!line.startsWith("n") || !/\/\.codex\/sessions\/.+\.jsonl$/.test(line)) continue;
    const id = path.basename(line.slice(1), ".jsonl").match(UUID_RE)?.[0];
    if (id) return id;
  }
  return "";
}

export function discoverTerminalSessionBindings({ runImpl = run, inventory = null, platform = process.platform } = {}) {
  if (platform === "win32") return discoverWindowsTerminalSessionBindings({ runImpl });
  const bindings = new Map();
  const processes = terminalProcesses(runImpl);
  if (!processes.length) return bindings;
  const terminalByTty = new Map((inventory || macTerminalInventory({ runImpl, platform })).map((row) => [row.tty, row]));
  for (const row of processes) {
    const terminal = terminalByTty.get(row.tty) || {};
    const terminalRef = {
      pid: row.pid,
      tty: row.tty,
      processState: row.state,
      app: terminal.app || "Terminal",
      windowIndex: terminal.windowIndex || null,
      tabIndex: terminal.tabIndex || null,
      selectedInWindow: Boolean(terminal.selectedInWindow),
      // Several suspended/resumable CLIs can share one tab. Only the process
      // group that owns the TTY is receiving its keyboard right now.
      keyboardFocused: Boolean(terminal.keyboardFocused && row.foreground),
      managedRemote: row.provider === "codex" && /(?:^|\s)--remote(?:\s|=)/.test(row.command),
      ...(row.provider === "codex" && row.command.match(/(?:^|\s)--remote(?:=|\s+)(\S+)/)?.[1]
        ? { remoteEndpoint: row.command.match(/(?:^|\s)--remote(?:=|\s+)(\S+)/)[1] }
        : {}),
    };
    bindings.set(`pid:${row.pid}`, terminalRef);
    const nativeId = row.provider === "codex" ? codexSessionForProcess(row, runImpl) : row.command.match(UUID_RE)?.[0] || "";
    if (nativeId) bindings.set(`${row.provider}:${nativeId}`, terminalRef);
  }
  return bindings;
}

export function focusTerminalSession(terminalRef, { runImpl = run, platform = process.platform } = {}) {
  if (platform === "win32") return focusWindowsTerminalSession(terminalRef, { runImpl });
  if (platform !== "darwin" || !terminalRef?.tty) return { ok: false, reason: "terminal-session-unavailable" };
  const tty = String(terminalRef.tty).replace(/^\/dev\//, "");
  const app = terminalRef.app === "iTerm2" ? "iTerm2" : "Terminal";
  const script = app === "iTerm2" ? `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      set s to current session of t
      if (tty of s) ends with "${tty}" then
        select t
        select w
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell` : `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) ends with "${tty}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell`;
  return runImpl("/usr/bin/osascript", ["-e", script]).trim() === "ok"
    ? { ok: true, app, tty }
    : { ok: false, reason: "terminal-session-not-found" };
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'"'"'`)}'`;
}

export async function launchMacAgentTerminal({
  provider,
  nativeId,
  cwd = process.cwd(),
  remoteEndpoint = "",
  terminalApp = process.env.RELAY_MAC_TERMINAL || "Terminal",
  spawnImpl = spawn,
} = {}) {
  if (process.platform !== "darwin") return { ok: false, reason: "mac-terminal-unavailable" };
  const command = provider === "codex" ? codexCliPath() : claudeCliPath();
  if (!command) return { ok: false, reason: `${provider}-cli-not-found` };
  const args = provider === "codex"
    ? [...(remoteEndpoint ? ["--remote", remoteEndpoint] : []), "resume", nativeId]
    : ["--resume", nativeId];
  const dir = path.join(storeDir(), "terminal-launches");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(dir, `${provider}-${nativeId}-${Date.now()}.command`);
  const script = [
    "#!/bin/zsh",
    `cd -- ${shellQuote(cwd || os.homedir())}`,
    `rm -f -- ${shellQuote(scriptPath)}`,
    `exec ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return new Promise((resolve) => {
    const child = spawnImpl("/usr/bin/open", ["-a", terminalApp, scriptPath], { stdio: "ignore" });
    child.once("error", (error) => resolve({ ok: false, reason: "terminal-launch-failed", detail: error?.message || String(error) }));
    child.once("exit", (code) => resolve(code === 0
      ? { ok: true, app: terminalApp, command, args }
      : { ok: false, reason: "terminal-launch-failed", detail: `open exited ${code}` }));
  });
}

// ---------- WINDOWS (2026-10-09) ----------
// The same three things the macOS code above does, with Windows' own tools:
// find the Claude Code and Codex CLIs running in a console, bring one's
// window forward, and open a new console running `claude --resume <id>` or
// `codex resume <id>`. Windows has no TTY, so a session is known by its
// process id, and only the window (not a Windows Terminal tab) comes forward.

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function powershellPath() {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(script, runImpl) {
  return runImpl(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 6_000, windowsHide: true });
}

// The copies the Claude app (its Code tab) and the Codex app run are theirs,
// not a terminal session: their own folders, the Store's, and Codex's
// app-server. Relay's own headless runs print and exit, so they are not
// sessions either.
const WINDOWS_APP_OWNED = /\\(?:Claude\\claude-code|WindowsApps|Packages)\\|\\OpenAI\\Codex\\bin\\[0-9a-f]{16}\\/i;
const HEADLESS = /(?:^|\s)(?:-p|--print|app-server|exec|mcp)(?:\s|$)|--output-format/;

export function parseWindowsProcessRows(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const [pid, ppid, exe, ...rest] = line.split("\t");
    const command = rest.join("\t").trim();
    const executable = path.win32.basename(String(exe || "")).toLowerCase();
    const provider = executable === "claude.exe" ? "claude" : executable === "codex.exe" ? "codex" : "";
    if (!provider || !Number(pid) || WINDOWS_APP_OWNED.test(exe) || HEADLESS.test(command)) continue;
    rows.push({ provider, pid: Number(pid), parentPid: Number(ppid) || 0, executable: exe, command });
  }
  return rows;
}

function windowsTerminalProcesses(runImpl = run) {
  // A quick look first: most of the time no CLI is running, and PowerShell
  // costs far more than tasklist.
  const quick = runImpl("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq claude.exe"], { windowsHide: true })
    + runImpl("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq codex.exe"], { windowsHide: true });
  if (!/"(?:claude|codex)\.exe"/i.test(quick)) return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='codex.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";
  return parseWindowsProcessRows(runPowerShell(script, runImpl));
}

export function discoverWindowsTerminalSessionBindings({ runImpl = run, processes = null } = {}) {
  const bindings = new Map();
  for (const row of processes || windowsTerminalProcesses(runImpl)) {
    const remoteEndpoint = row.provider === "codex" ? row.command.match(/(?:^|\s)--remote(?:=|\s+)(\S+)/)?.[1] || "" : "";
    const terminalRef = {
      pid: row.pid,
      tty: "",
      processState: "",
      app: "Terminal",
      platform: "win32",
      windowIndex: null,
      tabIndex: null,
      selectedInWindow: false,
      keyboardFocused: false,
      managedRemote: Boolean(remoteEndpoint),
      ...(remoteEndpoint ? { remoteEndpoint } : {}),
    };
    bindings.set(`pid:${row.pid}`, terminalRef);
    const nativeId = row.command.match(UUID_RE)?.[0] || "";
    if (nativeId) bindings.set(`${row.provider}:${nativeId}`, terminalRef);
  }
  return bindings;
}

// Bring the console window that hosts a CLI process to the front. Under
// Windows Terminal the console is a pseudo window owned by the terminal
// window, so its root owner is what comes forward. The Alt tap is what lets
// a background process take the foreground.
export function focusWindowsTerminalSession(terminalRef, { runImpl = run } = {}) {
  const pid = Number(terminalRef?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "terminal-session-unavailable" };
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -Namespace RelayFocus -Name Win -MemberDefinition '" + [
      '[DllImport("kernel32.dll")] public static extern bool FreeConsole();',
      '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);',
      '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);',
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);',
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);',
    ].join(" ") + "'",
    "$h = [IntPtr]::Zero",
    "[RelayFocus.Win]::FreeConsole() | Out-Null",
    `if ([RelayFocus.Win]::AttachConsole(${pid})) { $h = [RelayFocus.Win]::GetConsoleWindow(); [RelayFocus.Win]::FreeConsole() | Out-Null }`,
    "if ($h -ne [IntPtr]::Zero) { $root = [RelayFocus.Win]::GetAncestor($h, 3); if ($root -ne [IntPtr]::Zero) { $h = $root } }",
    `$p = ${pid}`,
    "for ($i = 0; $h -eq [IntPtr]::Zero -and $p -and $i -lt 16; $i++) { $proc = Get-Process -Id $p; if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { $h = $proc.MainWindowHandle; break }; $p = (Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").ParentProcessId }",
    "if ($h -eq [IntPtr]::Zero) { 'none'; exit }",
    "if ([RelayFocus.Win]::IsIconic($h)) { [RelayFocus.Win]::ShowWindowAsync($h, 9) | Out-Null }",
    "[RelayFocus.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [RelayFocus.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)",
    "if ([RelayFocus.Win]::SetForegroundWindow($h)) { 'ok' } else { 'refused' }",
  ].join("\n");
  const answer = runPowerShell(script, runImpl).trim().split(/\r?\n/).pop();
  return answer === "ok"
    ? { ok: true, app: "Terminal", pid }
    : { ok: false, reason: answer === "none" ? "terminal-session-not-found" : "terminal-focus-refused" };
}

// Characters a path may hold that cmd.exe would read as its own syntax.
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

export async function launchWindowsAgentTerminal({
  provider,
  nativeId,
  cwd = process.cwd(),
  remoteEndpoint = "",
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  const command = provider === "codex" ? codexCliPath({ env }) : claudeCliPath({ env });
  if (!command) return { ok: false, reason: `${provider}-cli-not-found` };
  const args = provider === "codex"
    ? [...(remoteEndpoint ? ["--remote", remoteEndpoint] : []), "resume", nativeId]
    : ["--resume", nativeId];
  const dir = cwd || os.homedir();
  if (CMD_UNSAFE.test(command) || CMD_UNSAFE.test(dir) || args.some((arg) => !/^[A-Za-z0-9._:/=-]+$/.test(String(arg)))) {
    return { ok: false, reason: "terminal-launch-unsafe-path" };
  }
  // `start` opens a new console window, and Windows hands it to the
  // person's default terminal app (Windows Terminal, where it is the default).
  // A Claude or Codex session's own variables must not leak into the new one.
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_SESSION_ID|CODEX_THREAD_ID|CODEX_SESSION_ID|ELECTRON_RUN_AS_NODE)/.test(key)) delete childEnv[key];
  }
  const line = `/d /c start "Relay" /D "${dir}" "${command}" ${args.join(" ")}`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(env.ComSpec || "cmd.exe", [line], { cwd: dir, env: childEnv, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, detached: true });
    } catch (error) {
      resolve({ ok: false, reason: "terminal-launch-failed", detail: error?.message || String(error) });
      return;
    }
    child.once("error", (error) => resolve({ ok: false, reason: "terminal-launch-failed", detail: error?.message || String(error) }));
    child.once("exit", (code) => resolve(code === 0
      ? { ok: true, app: "Terminal", command, args }
      : { ok: false, reason: "terminal-launch-failed", detail: `start exited ${code}` }));
    // No unref: `start` exits at once, and its exit is the answer awaited here.
  });
}

/** Open a new terminal session for a native session, on this computer's platform. */
export function launchAgentTerminal(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return launchWindowsAgentTerminal(options);
  return launchMacAgentTerminal(options);
}
