#!/usr/bin/env node

// Dedicated hook entrypoint: unlike the user-facing CLI, this does not import
// setup, updater, Electron, MCP, or daemon modules on every agent event.
const hook = process.argv[2];

try {
  if (hook === "claude-hook") {
    const { runClaudeHook } = await import("../src/claude-hook.js");
    await runClaudeHook();
  } else if (hook === "codex-hook") {
    const { runCodexHook } = await import("../src/codex-hook.js");
    await runCodexHook();
  }
} catch {
  // Hook context is advisory. It must never block or visibly break the host.
  process.exitCode = 0;
}
