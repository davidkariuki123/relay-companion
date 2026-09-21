import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RELAY_TASK_START_GUIDE } from "../src/agent-instructions.js";
import { renderRelayOpenSeed, renderRelayRowSeed } from "../src/relay-briefing.js";
import { toolsForAccount } from "../src/mcp.js";
import { createAgentToolSurface } from "../src/agent-tool-surface.js";

test("Task start guidance survives every agent entry path on both channels", async () => {
  for (const host of ["claude_code", "codex"]) {
    const tool = toolsForAccount({ requests: true }, host).find(t => t.name === "relay_task_start");
    assert.ok(tool.description.includes(RELAY_TASK_START_GUIDE), host);
  }
  for (const file of ["../skill/relay/SKILL.md", "../skill/variants/SKILL.dev.md", "../../../apps/web/public/llm_guide.md"]) {
    assert.ok((await readFile(new URL(file, import.meta.url), "utf8")).includes(RELAY_TASK_START_GUIDE), file);
  }
  const task = { id: "relay_investigation", kind: "task", relayNotificationKind: "task", title: "Investigate the launcher", forHuman: "Find why it fails." };
  for (const render of [renderRelayOpenSeed, renderRelayRowSeed]) {
    const seed = render(task);
    assert.ok(seed.operatorNote.includes(RELAY_TASK_START_GUIDE));
    assert.match(seed.operatorNote, /relay_task_start with taskRelayId relay_investigation/);
    assert.doesNotMatch(seed.visible, /relay_task_start|Started means/);
  }
  assert.ok(!renderRelayOpenSeed({ ...task, outbound: true }).operatorNote.includes(RELAY_TASK_START_GUIDE));
  const ordinary = renderRelayOpenSeed({ id: "relay_message", kind: "message", title: "An update", forHuman: "Here is the news." });
  assert.ok(!ordinary.operatorNote.includes(RELAY_TASK_START_GUIDE), "opening an ordinary message does not carry Task execution guidance");
});

test("start errors reach the agent without a success receipt or automatic retry", async () => {
  let attempts = 0;
  const surface = createAgentToolSurface({ taskStarted: async () => { attempts++; throw new Error("Task status service unavailable"); } }, {
    featuresReader: async () => ({ requests: true }),
  });
  const result = await surface.call("relay_task_start", { taskRelayId: "relay_investigation", idempotencyKey: "investigation-start-test" }, { host: "codex", nativeId: "fixture" });
  assert.equal(attempts, 1);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Task status service unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /"state":"working"/);
});
