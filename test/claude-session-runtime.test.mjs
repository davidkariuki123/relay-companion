import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeCatalogIsCurrent,
  relayClaudePermissionMode,
  RELAY_AI_SESSION_MCP_CATALOG_VERSION,
} from "../src/claude-session-runtime.js";

test("Relay-started Claude sessions default to auto — proven to finish a request unattended", () => {
  // Two live runs finished end to end under auto on 2026-08-13 (43s and 47s),
  // shell work and completion relay included, with no prompt in the way.
  assert.equal(relayClaudePermissionMode({}), "auto");
});

test("an explicit valid Claude permission mode wins", () => {
  assert.equal(
    relayClaudePermissionMode({ RELAY_CLAUDE_PERMISSION_MODE: "dontAsk" }),
    "dontAsk",
  );
});

test("isolated full-access cells may explicitly use bypassPermissions", () => {
  assert.equal(relayClaudePermissionMode({ RELAY_SESSION_FULL_ACCESS: "1" }), "bypassPermissions");
  assert.equal(relayClaudePermissionMode({ RELAY_SESSION_PLACEMENT: "cloud" }), "bypassPermissions");
});

test("invalid Claude permission modes fail closed", () => {
  assert.throws(
    () => relayClaudePermissionMode({ RELAY_CLAUDE_PERMISSION_MODE: "anything" }),
    /Unsupported RELAY_CLAUDE_PERMISSION_MODE/,
  );
});

test("Relay refreshes only sessions with a stale MCP catalog", () => {
  assert.equal(claudeCatalogIsCurrent(null), false);
  assert.equal(claudeCatalogIsCurrent({ relayMcpCatalogVersion: 1 }), false);
  assert.equal(
    claudeCatalogIsCurrent({ relayMcpCatalogVersion: RELAY_AI_SESSION_MCP_CATALOG_VERSION }),
    true,
  );
});
