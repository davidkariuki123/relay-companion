"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LINUX_TERMINAL_ENV_NAMES = Object.freeze([
  "HOME", "PATH", "SHELL", "USER", "LOGNAME",
  "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "PROGRAMFILES", "ProgramFiles(x86)",
  "LANG", "LANGUAGE", "TERM", "COLORTERM",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "SSH_AUTH_SOCK", "TMPDIR", "TMP", "TEMP",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SETTINGS", "CODEX_HOME",
  "CLAUDE_CLI_PATH", "CODEX_CLI_PATH", "RELAY_TERMINAL", "TERMINAL",
]);

function safeProxyValue(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return parsed.username || parsed.password ? "" : text;
  } catch {
    return text.includes("@") ? "" : text;
  }
}

function linuxTerminalEnvironment(env = process.env) {
  const next = {};
  for (const name of LINUX_TERMINAL_ENV_NAMES) {
    const value = env?.[name];
    if (value == null || value === "" || /\0|\r|\n/.test(String(value))) continue;
    if (/_proxy$/i.test(name)) {
      const safe = safeProxyValue(value);
      if (safe) next[name] = safe;
    } else {
      next[name] = String(value);
    }
  }
  for (const [name, value] of Object.entries(env || {})) {
    if (/^LC_[A-Z0-9_]+$/i.test(name) && value != null && value !== "" && !/\0|\r|\n/.test(String(value))) {
      next[name] = String(value);
    }
  }
  return next;
}

function commandPath(command, { env = process.env, fsImpl = fs } = {}) {
  const value = String(command || "").trim();
  if (!value) return "";
  if (/[\\/]/.test(value)) {
    const candidate = path.resolve(value);
    try {
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      return fsImpl.statSync(candidate).isFile() ? candidate : "";
    } catch {
      return "";
    }
  }
  const searchPath = String(env.PATH || "");
  if (!searchPath) return "";
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory || ".", value);
    try {
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      if (fsImpl.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return "";
}

function commandAvailable(command, options = {}) {
  return Boolean(commandPath(command, options));
}

function terminalCandidates(env = process.env) {
  const configured = String(env.RELAY_TERMINAL || env.TERMINAL || "").trim();
  const known = [
    { command: "xdg-terminal-exec", prefix: ["--"] },
    { command: "ptyxis", prefix: ["--"] },
    { command: "kgx", prefix: ["-e"] },
    { command: "gnome-terminal", prefix: ["--"] },
    { command: "konsole", prefix: ["-e"] },
    { command: "xfce4-terminal", prefix: ["-x"] },
    { command: "xterm", prefix: ["-e"] },
  ];
  if (!configured || /\s/.test(configured)) return known;
  const configuredPrefix = known.find(({ command }) => command === path.basename(configured))?.prefix || ["-e"];
  return [{ command: configured, prefix: configuredPrefix }, ...known];
}

function linuxAgentResume(url, host, env = process.env) {
  const value = String(url || "");
  if (host === "claude") {
    const sessionId = /^claude:\/\/resume\?session=([^&]+)/.exec(value)?.[1];
    return sessionId
      ? { command: env.CLAUDE_CLI_PATH || "claude", args: ["--resume", decodeURIComponent(sessionId)] }
      : null;
  }
  if (host === "codex") {
    const threadId = /^codex:\/\/threads\/([^/?#]+)/.exec(value)?.[1];
    return threadId
      ? { command: env.CODEX_CLI_PATH || "codex", args: ["resume", decodeURIComponent(threadId)] }
      : null;
  }
  return null;
}

function linuxTerminalInvocation(command, args = [], {
  env = process.env,
  resolveCommand = (candidate) => commandPath(candidate, { env }),
  available = (candidate) => Boolean(resolveCommand(candidate)),
} = {}) {
  const resolvedCommand = resolveCommand(command);
  if (!resolvedCommand && !available(command)) return null;
  const terminal = terminalCandidates(env).find((candidate) => available(candidate.command));
  return terminal
    ? {
        command: resolveCommand(terminal.command) || terminal.command,
        args: [...terminal.prefix, resolvedCommand || command, ...args],
      }
    : null;
}

async function launchLinuxAgentTerminal({
  url,
  host,
  cwd,
  env = process.env,
  spawnImpl = spawn,
  resolveCommand = (command) => commandPath(command, { env }),
  available = (command) => Boolean(resolveCommand(command)),
} = {}) {
  const resume = linuxAgentResume(url, host, env);
  if (!resume) return { ok: false, reason: "resume-target-invalid" };
  const resolvedCommand = resolveCommand(resume.command);
  if (!resolvedCommand && !available(resume.command)) return { ok: false, reason: `${host}-cli-not-found` };
  resume.command = resolvedCommand || resume.command;
  const invocation = linuxTerminalInvocation(resume.command, resume.args, { env, resolveCommand, available });
  if (!invocation) return { ok: false, reason: "terminal-not-found" };
  try {
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: cwd || undefined,
      env: linuxTerminalEnvironment(env),
      detached: true,
      stdio: "ignore",
    });
    if (typeof child?.once === "function") {
      const launched = await new Promise((resolve) => {
        child.once("spawn", () => resolve({ ok: true }));
        child.once("error", (error) => resolve({
          ok: false,
          reason: "terminal-launch-failed",
          detail: error?.message || String(error),
        }));
      });
      if (!launched.ok) return launched;
    }
    child?.unref?.();
    return { ok: true, terminal: invocation.command, command: resume.command, args: resume.args };
  } catch (error) {
    return { ok: false, reason: "terminal-launch-failed", detail: error?.message || String(error) };
  }
}

module.exports = {
  commandAvailable,
  commandPath,
  launchLinuxAgentTerminal,
  linuxAgentResume,
  linuxTerminalEnvironment,
  linuxTerminalInvocation,
  terminalCandidates,
};
