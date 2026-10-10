// The DESKTOP apps — the Claude app and the Codex app — as Relay finds them.
//
// The Claude app's chats use Relay through its hosted Relay CONNECTOR
// (claude.ai / the Claude app → Settings → Connectors), never a local MCP
// server (David, 2026-10-10). The Claude app starts local servers only when it
// launches and never restarts one, so every Relay update left its chats with a
// dead Relay ("Relay stopped in Claude's chats — Restart"); and a person who
// also had the connector got two Relay tool sets, possibly for two different
// accounts. So Relay no longer writes claude_desktop_config.json at all, and
// every install, repair and update takes out the entry it once wrote there
// (retireRelayFromClaudeDesktopConfig). Claude Code (~/.claude.json) is a
// different product and keeps its local registration.

import path from "node:path";
import installedApps from "./installed-apps.cjs";

/**
 * Every directory that might hold claude_desktop_config.json on this machine.
 *
 * Order matters only for reporting; Relay clears its old entry from every
 * candidate, because on Windows the app READS a virtualised MSIX path while its
 * own "Edit Config" button OPENS %APPDATA% — the two never sync. The list is
 * installed-apps.cjs's, the one place Relay finds the AI apps (2026-10-09).
 */
export function claudeDesktopConfigDirs(options = {}) {
  return installedApps.claudeDesktopDirs(options);
}

export function claudeDesktopConfigPathIn(dir) {
  return path.join(dir, "claude_desktop_config.json");
}

// What Relay itself wrote into claude_desktop_config.json, in every shape it
// ever wrote: the native bridge (~/.relay/bin/mcp-bridge[-<fingerprint>][.exe]),
// Node running the stable launcher (~/.relay/bin/mcp-launcher.cjs), Node
// running a package's or a checkout's bin/relay.js, or npx relay-companion. Only under the two
// names Relay used. Anything else in that file is someone else's.
const RELAY_BRIDGE_COMMAND = /[/\\]\.relay[/\\]bin[/\\]mcp-bridge(?:-[0-9a-f]{16})?(?:\.exe)?$/i;
const RELAY_SCRIPT_ARG = /(?:[/\\]\.relay[/\\]bin[/\\]mcp-launcher\.cjs|(?:relay[^/\\]*|[/\\]companion)[/\\]bin[/\\]relay\.js)$/;
const RELAY_PACKAGE_ARG = /^relay-companion(?:@\S*)?$/;

/** Is this mcpServers entry one Relay wrote? Name AND command must both say so. */
export function isRelayOwnedDesktopEntry(name, entry) {
  if (name !== "relay" && name !== "relay_companion") return false;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return RELAY_BRIDGE_COMMAND.test(String(entry.command || ""))
    || args.some((arg) => RELAY_SCRIPT_ARG.test(arg) || RELAY_PACKAGE_ARG.test(arg));
}

/**
 * Take Relay's own entries out of a claude_desktop_config.json text, touching
 * nothing else: every other server, `preferences`, `coworkUserFilesPath` and
 * any key Relay does not know stay exactly as they were.
 *
 * @returns {{ text: string|null, removed: string[] }} text is null when there
 *   is nothing of Relay's to remove (so the caller writes nothing at all).
 * @throws when the text is not a JSON object: never guessed at, never clobbered.
 */
export function retireRelayFromClaudeDesktopConfig(existingText) {
  const raw = String(existingText || "").trim();
  if (!raw) return { text: null, removed: [] };
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (error) {
    throw new Error(`refusing to rewrite malformed claude_desktop_config.json: ${error.message}`);
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("refusing to rewrite: claude_desktop_config.json is not a JSON object");
  }
  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { text: null, removed: [] };
  const removed = Object.keys(servers).filter((name) => isRelayOwnedDesktopEntry(name, servers[name]));
  if (!removed.length) return { text: null, removed };
  const kept = {};
  for (const [name, value] of Object.entries(servers)) if (!removed.includes(name)) kept[name] = value;
  cfg.mcpServers = kept;
  return { text: `${JSON.stringify(cfg, null, 2)}\n`, removed };
}

/** True when the Claude app is installed, whether or not a CLI is. */
export function claudeDesktopPresent(options = {}) {
  return Boolean(installedApps.claudeAppPath(options));
}

/**
 * Is a Codex desktop host installed?
 *
 * The Codex desktop experience ships inside the ChatGPT app rather than a
 * separate bundle, and it reads the same ~/.codex/config.toml as the CLI — so
 * finding the app is enough to know a Codex host exists, even before ~/.codex
 * has been created by a first run. On Windows that is the Store app.
 */
export function codexAppPresent(options = {}) {
  return Boolean(installedApps.chatgptAppPath(options));
}
