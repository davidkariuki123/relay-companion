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

export function terminalProcessState(pid, { runImpl = run } = {}) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return { alive: false, pid: value, tty: "", state: "" };
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

export function focusTerminalSession(terminalRef, { runImpl = run } = {}) {
  if (process.platform !== "darwin" || !terminalRef?.tty) return { ok: false, reason: "terminal-session-unavailable" };
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
