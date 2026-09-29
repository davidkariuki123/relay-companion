"use strict";

// The native application needs a small, read-only account of the registrations
// setup just made. Keep this independent from the runtime so the outer shell
// never claims an integration succeeded merely because Relay itself started.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function claudeConfigPath({ homeDir, env }) {
  return env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json");
}

function codexConfigPath({ homeDir, env }) {
  if (env.CODEX_CONFIG) return env.CODEX_CONFIG;
  return path.join(env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml");
}

function claudeConnected(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(config?.mcpServers && typeof config.mcpServers === "object" && config.mcpServers.relay);
  } catch {
    return false;
  }
}

function codexConnected(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).some((line) => line.trim() === "[mcp_servers.relay]");
  } catch {
    return false;
  }
}

function integrationStatus({ homeDir = os.homedir(), env = process.env } = {}) {
  const claude = claudeConnected(claudeConfigPath({ homeDir, env }));
  const codex = codexConnected(codexConfigPath({ homeDir, env }));
  return {
    claude: { connected: claude },
    codex: { connected: codex },
    restartRequired: claude || codex,
  };
}

module.exports = { integrationStatus, claudeConfigPath, codexConfigPath };
