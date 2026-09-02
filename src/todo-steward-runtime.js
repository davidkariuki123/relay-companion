// The steward's provider lane: how one run actually reaches Codex or Claude
// Code on this machine. Kept apart from todo-steward.js so the decision
// logic stays importable without the CLI-facing modules behind it.

import fs from "node:fs";
import path from "node:path";
import { defaultCodexCommand } from "./codex-app-server.js";
import { runCodexOneShot } from "./codex-one-shot.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";
import { claudeCommand, commandAvailable } from "./session-controller.js";
import { relayMcpLaunchSpec } from "./runtime.js";
import { storeDir } from "./host-paths.js";
import {
  claudeStewardArgs,
  ensureStewardOutputSchema,
  runClaudeSteward,
  runTodoStewardOnce,
  stewardWorkDir,
} from "./todo-steward.js";

let cachedProviders = null;
let cachedProvidersAt = 0;

/** Which agents are installed; refreshed every minute so a new install is noticed without a restart. */
export function stewardProviders({ nowMs = Date.now() } = {}) {
  if (!cachedProviders || nowMs - cachedProvidersAt > 60_000) {
    cachedProviders = {
      codex: commandAvailable(defaultCodexCommand()),
      claude: commandAvailable(claudeCommand()),
    };
    cachedProvidersAt = nowMs;
  }
  return cachedProviders;
}

/** Codex config layers pinning the Relay MCP server, the same way Task runs do in runtime.js. */
export function codexStewardConfigOverrides(launch = relayMcpLaunchSpec()) {
  const overrides = {
    "mcp_servers.relay.command": JSON.stringify(launch.command),
    "mcp_servers.relay.args": JSON.stringify(launch.args),
    "mcp_servers.relay.startup_timeout_sec": "30",
    "mcp_servers.relay.tool_timeout_sec": "300",
  };
  for (const [key, value] of Object.entries(launch.env || {})) {
    overrides[`mcp_servers.relay.env.${key}`] = JSON.stringify(value);
  }
  return overrides;
}

/** A Claude MCP config naming only Relay, so the run has the tools it needs whatever the user's own config says. */
function stewardMcpConfigPath(baseDir) {
  const launch = relayMcpLaunchSpec();
  const filePath = path.join(stewardWorkDir(baseDir), "claude-mcp.json");
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { relay: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2), { mode: 0o600 });
  return filePath;
}

/** Run the brief on the chosen provider and return its final text. */
export async function runStewardProvider({ route, prompt, heartbeat = () => {}, baseDir = storeDir() }) {
  const cwd = stewardWorkDir(baseDir);
  if (route.provider === "codex") {
    return runCodexOneShot({
      command: defaultCodexCommand(),
      cwd,
      prompt,
      model: route.model,
      effort: route.effort,
      schemaPath: ensureStewardOutputSchema(baseDir),
      configOverrides: codexStewardConfigOverrides(),
      runTimeoutMs: 15 * 60 * 1000,
      stallTimeoutMs: 4 * 60 * 1000,
      // Structured-output drafts arrive as agent messages; a JSON blob is not a phase.
      onEvent: (_event, status) => { if (status && !/^\s*\{/.test(status)) heartbeat(status); },
    });
  }
  const permissionMode = relayClaudePermissionMode();
  return runClaudeSteward({
    command: claudeCommand(),
    cwd,
    prompt,
    args: claudeStewardArgs({
      model: route.model,
      effort: route.effort,
      permissionMode,
      mcpConfigPath: stewardMcpConfigPath(baseDir),
    }),
    onHeartbeat: () => heartbeat(),
  });
}

/** The daemon's per-tick entry point. Never throws; the daemon loop must stay up. */
export async function todoStewardTick({ client, features, user, log = () => {} } = {}) {
  try {
    return await runTodoStewardOnce({
      client,
      features,
      user,
      log,
      providers: stewardProviders(),
      runProvider: runStewardProvider,
    });
  } catch (error) {
    log(`todo steward tick failed: ${error?.message || error}`);
    return { ran: false, reason: "error", error: String(error?.message || error) };
  }
}
