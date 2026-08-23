// Registering Relay into the DESKTOP apps — Claude Desktop and the Codex app.
//
// Most people who are sent a relay have a desktop app and no CLI. Until now
// `installClaudeCode` wrote ~/.claude.json (the Claude *Code* CLI's file, which
// the desktop app never reads) and refused to create it when absent, so a
// desktop-only user was told "Claude Code was not found here, so it was skipped"
// and ended up with nothing registered anywhere.
//
// Writing claude_desktop_config.json is the only unattended path that exists:
// there is no CLI for Claude Desktop (`claude mcp add --scope` only ever writes
// Claude Code's config) and no install deep link. `.mcpb` Desktop Extensions
// cannot be installed without a human clicking "Install Extension?", so they are
// a convenience, never a substitute.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every directory that might hold claude_desktop_config.json on this machine.
 *
 * Order matters only for reporting; we write to every candidate whose parent
 * already exists, because on Windows the app READS a virtualised MSIX path while
 * its own "Edit Config" button OPENS %APPDATA% — the two never sync, and picking
 * one silently registers nothing for half of users.
 */
export function claudeDesktopConfigDirs({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  // An explicit override wins and is used verbatim — the app appends no app-name
  // suffix when CLAUDE_USER_DATA_DIR is set.
  if (env.CLAUDE_USER_DATA_DIR) return [env.CLAUDE_USER_DATA_DIR];

  const home = env.HOME || os.homedir();
  if (platform === "darwin") {
    const base = path.posix.join(home, "Library", "Application Support");
    // Claude-3p is the enterprise/partner build; it has its own userData dir.
    return [path.posix.join(base, "Claude"), path.posix.join(base, "Claude-3p")].filter((dir) => exists(dir));
  }

  if (platform === "win32") {
    const dirs = [];
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      const packages = path.win32.join(localAppData, "Packages");
      // The MSIX package family name carries a hash, so glob rather than pin it.
      try {
        for (const entry of fs.readdirSync(packages)) {
          if (!/^Claude_/.test(entry)) continue;
          const dir = path.win32.join(packages, entry, "LocalCache", "Roaming", "Claude");
          if (exists(dir)) dirs.push(dir);
        }
      } catch {
        // No Packages dir: not an MSIX install.
      }
      const thirdParty = path.win32.join(localAppData, "Claude-3p");
      if (exists(thirdParty)) dirs.push(thirdParty);
    }
    if (env.APPDATA) {
      const roaming = path.win32.join(env.APPDATA, "Claude");
      if (exists(roaming)) dirs.push(roaming);
    }
    return dirs;
  }

  // Anthropic ships no documented Linux desktop build; guessing a path would
  // write a file nothing reads and report success.
  return [];
}

export function claudeDesktopConfigPathIn(dir) {
  return path.join(dir, "claude_desktop_config.json");
}

/**
 * The entry Claude Desktop accepts, and nothing else.
 *
 * Its schema is exactly `command` (required), `args`, `env`, and an internal
 * `extensionId`. A `url`, `type` or `transport` key is not merely ignored — it
 * can make the app rewrite the file and drop the whole mcpServers section,
 * taking other tools' servers with it.
 */
export function claudeDesktopEntry({ node, script, relayHome, maxOldSpaceMb = 96 }) {
  const entry = {
    command: node,
    args: [`--max-old-space-size=${maxOldSpaceMb}`, script, "mcp"],
  };
  if (relayHome) entry.env = { RELAY_HOME: relayHome };
  return entry;
}

/**
 * An entry this installer wrote whose target no longer exists.
 *
 * Claude Desktop validates the schema, not the filesystem, so a stale entry
 * spawns and dies on every single app launch. David's machine has exactly this:
 * a hand-written `relay_companion` pointing at a deleted checkout, crash-looping
 * with MODULE_NOT_FOUND. Self-heal it rather than leaving a permanently broken
 * server in someone's config.
 */
export function isDeadRelayEntry(name, entry, exists = fs.existsSync) {
  if (!entry || typeof entry !== "object") return false;
  if (!/relay/i.test(String(name))) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const script = args.find((a) => typeof a === "string" && /relay[^/\\]*[/\\]bin[/\\]relay\.js$/.test(a));
  if (!script) return false;
  return !exists(script);
}

/**
 * A live entry under the pre-rename server name. Unlike a dead entry it spawns
 * fine — which is worse: it is a full duplicate of `relay`, so every Desktop
 * session carries the whole toolset twice and the doubled count helps push the
 * tools behind ToolSearch deferral. Installing under the current name is the
 * moment to retire it, existing target or not.
 */
export function isLegacyRelayCompanionEntry(name, entry) {
  if (name !== "relay_companion") return false;
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.some(
    (a) => typeof a === "string" && /relay[^/\\]*[/\\]bin[/\\](relay\.js|mcp-launcher\.cjs)$/.test(a),
  );
}

/**
 * Merge our server into an existing config, touching nothing else.
 *
 * The live file holds `coworkUserFilesPath` and a `preferences` object with the
 * paired browser-extension device id, per-folder permission modes and consent
 * grants. The MCP docs say to "replace the contents of the configuration file";
 * for an installer that is destructive, so this merges and refuses to guess when
 * the JSON is unparseable.
 */
export function mergeClaudeDesktopConfig(existingText, entry, { name = "relay", exists = fs.existsSync } = {}) {
  let cfg = {};
  const raw = (existingText || "").trim();
  if (raw) {
    try {
      cfg = JSON.parse(raw);
    } catch (error) {
      throw new Error(`refusing to overwrite malformed claude_desktop_config.json: ${error.message}`);
    }
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("refusing to write: claude_desktop_config.json is not a JSON object");
  }

  const servers = cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
    ? { ...cfg.mcpServers }
    : {};

  const removed = [];
  for (const [key, value] of Object.entries(servers)) {
    if (key !== name && (isDeadRelayEntry(key, value, exists) || isLegacyRelayCompanionEntry(key, value))) {
      delete servers[key];
      removed.push(key);
    }
  }

  // Always overwrite our own key. No-oping when it already exists is what lets a
  // stale path survive upgrades forever.
  servers[name] = entry;
  cfg.mcpServers = servers;
  return { text: `${JSON.stringify(cfg, null, 2)}\n`, removed };
}

/**
 * Claude Desktop launches servers from a GUI context with a curated PATH that
 * contains no nvm/fnm/volta shims, so "npx" or a shim path resolves to nothing
 * and the server dies silently. Prefer a stable absolute node that resolves to
 * the same binary we are running, over the version-pinned Cellar path.
 */
export function stableNodeCandidates() {
  return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
}

export function resolveStableNode({
  execPath = process.execPath,
  candidates = stableNodeCandidates(),
  realpath = (p) => fs.realpathSync(p),
  exists = fs.existsSync,
} = {}) {
  let target;
  try {
    target = realpath(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    try {
      if (realpath(candidate) === target) return candidate;
    } catch {
      // Unreadable symlink; try the next one.
    }
  }
  return execPath;
}

/**
 * A desktop-only Codex user still has a full codex binary — it ships inside the
 * ChatGPT app, it just is not on PATH. Preferring it means we can use the
 * supported `codex mcp add` rather than hand-editing TOML.
 */
export function codexBinaryCandidates({ env = process.env, platform = process.platform } = {}) {
  const home = env.HOME || os.homedir();
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ];
  }
  return [];
}

/** True when a Claude Desktop install is present, whether or not a CLI is. */
export function claudeDesktopPresent(options = {}) {
  return claudeDesktopConfigDirs(options).length > 0;
}

/**
 * Is a Codex desktop host installed?
 *
 * The Codex desktop experience ships inside the ChatGPT app rather than a
 * separate bundle, and it reads the same ~/.codex/config.toml as the CLI — so
 * finding the app is enough to know a Codex host exists, even before ~/.codex
 * has been created by a first run.
 */
export function codexAppPresent({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== "darwin") return false;
  return codexBinaryCandidates({ env, platform }).some((candidate) => exists(candidate));
}
