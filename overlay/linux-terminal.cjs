"use strict";

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

function commandAvailable(command, { env = process.env, run = spawnSync } = {}) {
  const value = String(command || "").trim();
  if (!value) return false;
  if (value.includes("/")) {
    try {
      fs.accessSync(value, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = run("/usr/bin/which", [value], { encoding: "utf8", env, timeout: 2000 });
  return !result?.error && result?.status === 0 && Boolean(String(result.stdout || "").trim());
}

function terminalCandidates(env = process.env) {
  const configured = String(env.RELAY_TERMINAL || env.TERMINAL || "").trim();
  return [
    ...(configured && !/\s/.test(configured) ? [{ command: configured, prefix: ["-e"] }] : []),
    { command: "xdg-terminal-exec", prefix: ["--"] },
    { command: "kgx", prefix: ["--"] },
    { command: "gnome-terminal", prefix: ["--"] },
    { command: "konsole", prefix: ["-e"] },
    { command: "xfce4-terminal", prefix: ["-x"] },
    { command: "xterm", prefix: ["-e"] },
  ];
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
  available = (candidate) => commandAvailable(candidate, { env }),
} = {}) {
  if (!available(command)) return null;
  const terminal = terminalCandidates(env).find((candidate) => available(candidate.command));
  return terminal
    ? { command: terminal.command, args: [...terminal.prefix, command, ...args] }
    : null;
}

function launchLinuxAgentTerminal({
  url,
  host,
  cwd,
  env = process.env,
  spawnImpl = spawn,
  available = (command) => commandAvailable(command, { env }),
} = {}) {
  const resume = linuxAgentResume(url, host, env);
  if (!resume) return { ok: false, reason: "resume-target-invalid" };
  if (!available(resume.command)) return { ok: false, reason: `${host}-cli-not-found` };
  const invocation = linuxTerminalInvocation(resume.command, resume.args, { env, available });
  if (!invocation) return { ok: false, reason: "terminal-not-found" };
  try {
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: cwd || undefined,
      env,
      detached: true,
      stdio: "ignore",
    });
    child?.unref?.();
    return { ok: true, terminal: invocation.command, command: resume.command, args: resume.args };
  } catch (error) {
    return { ok: false, reason: "terminal-launch-failed", detail: error?.message || String(error) };
  }
}

module.exports = {
  commandAvailable,
  launchLinuxAgentTerminal,
  linuxAgentResume,
  linuxTerminalInvocation,
  terminalCandidates,
};
