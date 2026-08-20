export const RELAY_AI_SESSION_MCP_CATALOG_VERSION = 2;

const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);

/**
 * Relay-started Claude sessions default to AUTO.
 *
 * The consent gate is Start: a human reads the request and presses it. Auto is
 * the mode that honours that without handing over the whole machine — and it is
 * the default because it is PROVEN to complete a request unattended here: two
 * live runs on 2026-08-13 finished end to end under auto (43s and 47s), doing
 * shell work and sending their completion relay with no prompt in the way.
 * The Codex lane has no equivalent middle mode, so it runs at full access —
 * the same as a session the user starts in that app themselves.
 *
 * The reader can change this per vendor in Settings, and an explicitly
 * configured env mode still wins over both.
 */
export function relayClaudePermissionMode(env = process.env) {
  const configured = String(env.RELAY_CLAUDE_PERMISSION_MODE || "").trim();
  if (configured) {
    if (!CLAUDE_PERMISSION_MODES.has(configured)) {
      throw new Error(`Unsupported RELAY_CLAUDE_PERMISSION_MODE: ${configured}`);
    }
    return configured;
  }
  // An isolated cloud cell has nothing of the user's to protect: it is a fresh
  // machine that exists for this run alone, so prompts there would stall a run nobody is watching.
  const isolatedCloud = env.RELAY_SESSION_PLACEMENT === "cloud";
  if (isolatedCloud || env.RELAY_SESSION_FULL_ACCESS === "1") return "bypassPermissions";
  return "auto";
}

export function claudeCatalogIsCurrent(session, version = RELAY_AI_SESSION_MCP_CATALOG_VERSION) {
  return Number(session?.relayMcpCatalogVersion || 0) >= Number(version);
}
