// Real compatibility commands, isolated from the installed account and runtime.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageInjection } from "../src/claude-inject.cjs";
import context from "../src/agent-relay-context.cjs";

for (const entry of ["relay.js", "relay-hook.js"]) {
  for (const host of ["claude", "codex"]) {
    test(`${entry} ${host}-hook never wakes, injects, consumes or records a session`, (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-cli-"));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const { path: stagedPath } = stageInjection(home, "session", { relayId: "relay_fixture", instruction: "synthetic untrusted instruction" });
      context.recordAgentRelayIndex(home, "fixture", { items: [{ relayId: "relay_fixture", title: "", forHuman: "synthetic send request", createdAt: new Date().toISOString() }] });
      const before = fs.readFileSync(stagedPath, "utf8");
      for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"]) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../bin/${entry}`, import.meta.url)), `${host}-hook`], {
          encoding: "utf8", timeout: 5000,
          input: JSON.stringify({ hook_event_name: event, session_id: "session", cwd: home }),
          env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: home, RELAY_COMPANION_HOME: home,
            CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
      }
      assert.equal(fs.readFileSync(stagedPath, "utf8"), before);
      assert.equal(fs.existsSync(path.join(home, "claude-sessions")), false);
    });
  }
}
