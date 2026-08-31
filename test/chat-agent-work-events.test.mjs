import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chatAgentSessionToWorkEvents } from "../src/chat-agent-work-events.js";
import {
  createWorkConversation,
  replayWorkEvents,
  workPresentationSnapshot,
} from "../src/work-conversation.js";

function presentation(input) {
  const events = chatAgentSessionToWorkEvents(input);
  const state = replayWorkEvents(events, createWorkConversation({
    provider:input.session.provider,
    sessionId:input.session.id,
  }));
  return { events, value:workPresentationSnapshot(state, Date.parse("2026-08-25T16:01:00.000Z")) };
}

test("tagged Codex Work enters the canonical reducer without exposing its controller prompt", () => {
  const result = presentation({
    session:{
      id:"ras_codex", relaySessionId:"rsess_codex", triggerRelayId:"relay_trigger",
      provider:"codex", state:"completed", instruction:"Count to thirty",
      createdAt:"2026-08-25T16:00:00.000Z", completedAt:"2026-08-25T16:00:30.000Z",
    },
    records:[
      { type:"progress", text:"task complete", at:"2026-08-25T16:00:30.000Z" },
      { type:"message", role:"assistant", text:"DONE", at:"2026-08-25T16:00:29.000Z" },
      { type:"tool_result", output:"secret tool output", at:"2026-08-25T16:00:28.000Z" },
      { type:"tool_call", tool:"exec", input:"{\"command\":\"secret internal command\"}", at:"2026-08-25T16:00:01.000Z" },
      { type:"message", role:"user", text:"INTERNAL CONTROLLER PROMPT", at:"2026-08-25T16:00:00.500Z" },
    ],
    events:[{ id:"done", sequence:3, type:"agent.completed", occurredAt:"2026-08-25T16:00:30.000Z", payload:{ forHuman:"DONE" } }],
  });
  const turn = result.value.turns[0];
  assert.equal(result.value.provider, "codex");
  assert.equal(result.value.sessionId, "ras_codex");
  assert.equal(turn.units[0].text, "Count to thirty");
  assert.equal(turn.units[0].clientMessageId, "trigger:relay_trigger");
  assert.equal(turn.final.text, "DONE");
  assert.equal(turn.canCollapse, true);
  assert.equal(turn.units.find((unit) => unit.type === "activity").activity.kind, "command");
  assert.doesNotMatch(JSON.stringify(result.value), /INTERNAL CONTROLLER PROMPT|secret internal command|secret tool output/);
});

test("accepted follow-ups retain client identity and become ordered canonical turns", () => {
  const result = presentation({
    session:{
      id:"ras_follow", provider:"codex", state:"running", instruction:"First turn",
      createdAt:"2026-08-25T16:00:00.000Z", updatedAt:"2026-08-25T16:00:11.000Z",
    },
    events:[
      { id:"first", type:"agent.completed", sequence:3, occurredAt:"2026-08-25T16:00:05.000Z", payload:{ forHuman:"FIRST" } },
      { id:"follow", type:"user.turn.accepted", sequence:4, occurredAt:"2026-08-25T16:00:10.000Z", payload:{ message:"Second turn", clientMessageId:"client-message-2" } },
    ],
    records:[
      { type:"message", role:"assistant", text:"Working on the second turn", at:"2026-08-25T16:00:11.000Z" },
      { type:"message", role:"assistant", text:"FIRST", at:"2026-08-25T16:00:04.000Z" },
    ],
  });
  assert.equal(result.value.turns.length, 2);
  assert.equal(result.value.turns[0].settled, true);
  assert.equal(result.value.turns[0].final.text, "FIRST");
  assert.equal(result.value.turns[1].units[0].text, "Second turn");
  assert.equal(result.value.turns[1].units[0].clientMessageId, "client-message-2");
  assert.equal(result.value.turns[1].active, true);
  assert.equal(result.value.turns[1].final, null);
});

test("provider availability is independent of turn activity", () => {
  const result = presentation({
    session:{
      id:"ras_reconnect", provider:"claude", state:"reconnecting", instruction:"Investigate",
      createdAt:"2026-08-25T16:00:00.000Z", updatedAt:"2026-08-25T16:00:08.000Z",
    },
  });
  const turn = result.value.turns[0];
  assert.equal(turn.active, true);
  assert.equal(turn.providerState, "reconnecting");
  assert.equal(turn.providerLabel, "Reconnecting");
});

test("tagged Work uses the shared feed, reducer and renderer paths", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const watch = main.slice(main.indexOf('ipcMain.handle("relay:runFeed:watch"'), main.indexOf('ipcMain.on("relay:runFeed:unwatch"'));
  assert.match(main, /kind:"chat-agent"/);
  assert.match(main, /chatAgentSessionToWorkEvents/);
  assert.match(main, /createCanonicalWorkPushBridge/);
  assert.doesNotMatch(watch, /isTaggedAgentWorkRow|setInterval|taskRunFeed/);
  assert.equal(fs.existsSync(new URL("../src/chat-agent-work-presentation.js", import.meta.url)), false);
});

test("tagged Work follow-ups use the same stable identity through API transport", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const steer = main.slice(main.indexOf("async function previewTaskSteer(input)"), main.indexOf("function installActiveSpaceWatcher"));
  assert.match(steer, /const clientMessageId =/);
  assert.match(steer, /chatAgentSessionTurn\([\s\S]*?clientMessageId/);
});
