import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chatAgentWorkPresentation } from "../src/chat-agent-work-presentation.js";

test("tagged Codex Work uses the Task runner contract without exposing its controller prompt", () => {
  const session = {
    id:"ras_codex", relaySessionId:"rsess_codex", provider:"codex", state:"completed",
    instruction:"Count to thirty", createdAt:"2026-08-25T16:00:00.000Z", completedAt:"2026-08-25T16:00:30.000Z",
  };
  const records = [
    { type:"progress", text:"task complete", at:"2026-08-25T16:00:30.000Z" },
    { type:"message", role:"assistant", text:"DONE", at:"2026-08-25T16:00:29.000Z" },
    { type:"tool_result", output:"ok", at:"2026-08-25T16:00:28.000Z" },
    { type:"tool_call", tool:"exec", input:"{\"command\":\"secret internal command\"}", at:"2026-08-25T16:00:01.000Z" },
    { type:"message", role:"user", text:"INTERNAL CONTROLLER PROMPT", at:"2026-08-25T16:00:00.500Z" },
  ];
  const events = [{ type:"agent.completed", occurredAt:"2026-08-25T16:00:30.000Z", payload:{ forHuman:"DONE" } }];
  const presentation = chatAgentWorkPresentation({ session, events, records });
  assert.equal(presentation.provider, "codex");
  assert.equal(presentation.sessionId, "rsess_codex");
  assert.equal(presentation.turns.length, 1);
  assert.equal(presentation.turns[0].units[0].text, "Count to thirty");
  assert.equal(presentation.turns[0].final.text, "DONE");
  assert.equal(presentation.turns[0].canCollapse, true);
  assert.equal(presentation.turns[0].units.find((unit) => unit.type === "activity").activity.kind, "command");
  assert.doesNotMatch(JSON.stringify(presentation), /INTERNAL CONTROLLER PROMPT|secret internal command/);
});

test("accepted follow-ups become separate turns in the same Work session", () => {
  const presentation = chatAgentWorkPresentation({
    session:{
      id:"ras_follow", relaySessionId:"rsess_follow", provider:"codex", state:"running",
      instruction:"First turn", createdAt:"2026-08-25T16:00:00.000Z",
    },
    events:[
      { type:"agent.completed", occurredAt:"2026-08-25T16:00:05.000Z", payload:{ forHuman:"FIRST" } },
      { type:"user.turn.accepted", sequence:4, occurredAt:"2026-08-25T16:00:10.000Z", payload:{ message:"Second turn" } },
    ],
    records:[
      { type:"message", role:"assistant", text:"Working on the second turn", at:"2026-08-25T16:00:11.000Z" },
      { type:"message", role:"assistant", text:"FIRST", at:"2026-08-25T16:00:04.000Z" },
    ],
  });
  assert.equal(presentation.turns.length, 2);
  assert.equal(presentation.turns[0].settled, true);
  assert.equal(presentation.turns[0].final.text, "FIRST");
  assert.equal(presentation.turns[1].units[0].text, "Second turn");
  assert.equal(presentation.turns[1].active, true);
  assert.equal(presentation.turns[1].final, null);
});

test("the pill labels tagged Work from its actual provider before feed hydration", () => {
  const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const start = inbox.indexOf("function runAppName(id)");
  const end = inbox.indexOf("// Which app is actually doing the work", start);
  const appName = inbox.slice(start, end);
  assert.match(appName, /row\?\.source\?\.host === "relay-agent-run"/);
  assert.match(appName, /row\.source\.surface === "codex"\) return "Codex"/);
  assert.match(appName, /row\.source\.surface === "claude_code"\) return "Claude Code"/);
});

test("tagged Work can send follow-ups through the existing Task runner", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const helperStart = main.indexOf("function isTaggedAgentWorkRow(row)");
  const helperEnd = main.indexOf("function agentWorkEnabledForRow", helperStart);
  const helper = main.slice(helperStart, helperEnd);
  assert.match(helper, /row\?\.source\?\.host === "relay-agent-run"/);
  assert.match(helper, /row\?\.source\?\.agentSessionId/);

  const steerStart = main.indexOf("async function previewTaskSteer(input)");
  const steerEnd = main.indexOf("function installActiveSpaceWatcher", steerStart);
  const steer = main.slice(steerStart, steerEnd);
  assert.match(steer, /const isLocalWork =[^;]+\|\| isTaggedAgentWorkRow\(row\);/s);
  assert.ok(
    steer.indexOf("isTaggedAgentWorkRow(row)") < steer.indexOf('No local agent work exists for this Relay.'),
    "tagged Work must pass eligibility before the follow-up rejection gate",
  );
  assert.match(steer, /chatAgentSessionTurn\(/);
});
