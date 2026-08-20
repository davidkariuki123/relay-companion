// Host filesystem paths used by the lazy-open session-materialization engine.
//
// Ported faithfully from granular/tools/relay-companion/src/paths.js (the subset
// the open path needs: Codex home/state + Claude home/projects/desktop sessions).
// Same env-var override names, same default locations, same behavior. Named
// host-paths.js so it doesn't collide with any other path helper in this package.

import os from "node:os";
import path from "node:path";

export const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
export const DEFAULT_CODEX_GLOBAL_STATE = path.join(DEFAULT_CODEX_HOME, ".codex-global-state.json");
export const DEFAULT_CODEX_STATE_DB = path.join(DEFAULT_CODEX_HOME, "state_5.sqlite");
export const DEFAULT_CLAUDE_HOME = path.join(os.homedir(), ".claude");

function defaultWindowsAppData({ env = process.env, homedir = os.homedir() } = {}) {
  return env.APPDATA || path.win32.join(homedir, "AppData", "Roaming");
}

export function defaultClaudeDesktopBaseDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === "win32") return path.win32.join(defaultWindowsAppData({ env, homedir }), "Claude");
  if (platform === "darwin") return path.join(homedir, "Library", "Application Support", "Claude");
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "Claude");
}

export function defaultClaudeDesktopConfigPath(options = {}) {
  const pathLib = options.platform === "win32" ? path.win32 : path;
  return pathLib.join(defaultClaudeDesktopBaseDir(options), "claude_desktop_config.json");
}

export function defaultClaudeDesktopSessionsDir(options = {}) {
  const pathLib = options.platform === "win32" ? path.win32 : path;
  return pathLib.join(defaultClaudeDesktopBaseDir(options), "claude-code-sessions");
}

export const DEFAULT_CLAUDE_DESKTOP_CONFIG = defaultClaudeDesktopConfigPath();
export const DEFAULT_CLAUDE_DESKTOP_SESSIONS = defaultClaudeDesktopSessionsDir();

// Durable companion store dir. The cloud companion stages packets + state under
// RELAY_HOME/RELAY_COMPANION_HOME (see notifications.companionHome()); the engine
// writes its own snapshot copies under <store>/packets too.
export function storeDir() {
  return (
    process.env.RELAY_HOME ||
    process.env.RELAY_COMPANION_HOME ||
    path.join(os.homedir(), ".relay-companion")
  );
}

export function codexHome() {
  return process.env.CODEX_HOME || DEFAULT_CODEX_HOME;
}

export function codexGlobalStatePath() {
  return process.env.CODEX_GLOBAL_STATE || path.join(codexHome(), ".codex-global-state.json");
}

export function codexStateDbPath() {
  return process.env.CODEX_STATE_DB || path.join(codexHome(), "state_5.sqlite");
}

export function claudeHome() {
  return process.env.CLAUDE_HOME || DEFAULT_CLAUDE_HOME;
}

export function claudeProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(claudeHome(), "projects");
}

export function claudeDesktopConfigPath(options = {}) {
  const env = options.env || process.env;
  return env.CLAUDE_DESKTOP_CONFIG || defaultClaudeDesktopConfigPath({ env, ...options });
}

export function claudeDesktopSessionsDir(options = {}) {
  const env = options.env || process.env;
  return env.CLAUDE_DESKTOP_SESSIONS_DIR || defaultClaudeDesktopSessionsDir({ env, ...options });
}
