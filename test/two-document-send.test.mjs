import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handleCall } from "../src/mcp.js";

// Product species: a Relay has forHuman + a non-empty forAgent, composed
// separately; a human-only send is plain text. These tests pin that two Relay
// lanes survive composition, and that an omitted text-message agent lane is
// declared as the API's empty-string default.

const send = (args) => {
  let payload;
  const fakeClient = {
    async sendRelay(input) {
      payload = input;
      return { relayId: "relay_test", deliveredVia: "device" };
    },
  };
  return handleCall(fakeClient, "relay_send", args, { mode: "full" }).then(() => payload);
};

test("both documents survive composition verbatim, threading intact", async () => {
  const forHuman = "Shane — the fix landed.\n\nSay the word and I'll release it.";
  const forAgent = [
    "## What changed",
    "- `overlay/inbox.html`: scroll chrome removed (`display:none`)",
    "",
    "```bash",
    "node --test test/*.test.mjs",
    "```",
  ].join("\n");
  const payload = await send({
    recipient: { email: "shane@example.com" },
    kind: "task",
    title: "Scrollbar fix ready",
    forHuman,
    forAgent,
    inReplyToRelayId: "relay_20260814000847203_6e9f125840bd",
    idempotencyKey: "idem_two_doc_1",
  });
  // Verbatim: no trimming, no merging, no summarising between the lanes.
  assert.equal(payload.forHuman, forHuman);
  assert.equal(payload.forAgent, forAgent);
  assert.equal(payload.kind, "task");
  assert.equal(payload.inReplyToRelayId, "relay_20260814000847203_6e9f125840bd");
});

test("a plain text message sends a declared empty forAgent", async () => {
  const payload = await send({
    recipient: { email: "shane@example.com" },
    kind: "message",
    title: "Quick demo check-in",
    forHuman: "How did the demo land?",
    idempotencyKey: "idem_two_doc_2",
  });
  // The shared wire shape is declared, not implied: a text's absent agent
  // document travels as "" (the API's own default), never undefined.
  assert.equal(payload.forAgent, "");
  assert.equal(payload.kind, "message");
  // Threading is opt-in: no inReplyToRelayId key at all when none was given.
  assert.equal("inReplyToRelayId" in payload, false);
});

test("the concise human document is derived from a complete unlimited agent document", () => {
  // Sven, on catching reasons that lived only in the letter: "agent should
  // be getting everything to replicate the work, continue from a handoff or
  // fix a bug... more is better for the agent, simple is better for the
  // human, almost like text messages." Measured on this account's own
  // outbound mail: six of six high-context sends carried 2,700-13,000 chars
  // of headings, code and receipts in the LETTER and zero in the folder —
  // the detail crossed, in the lane the human reads. These pins keep the
  // rule taught on all three surfaces of relay_send.
  const tool = TOOLS.find((t) => t.name === "relay_send");
  assert.match(tool.description, /compose the complete forAgent document first/i);
  assert.match(tool.description, /derive forHuman as the concise message/i);
  assert.match(tool.description, /fewest words that faithfully preserve the message, not the most allowed/i);
  assert.match(tool.description, /1-3 normally sized sentences/i);
  assert.match(tool.description, /45 words or fewer/i);
  assert.match(tool.description, /60 words is only Relay's mandatory-review threshold, never a target, budget/i);
  assert.match(tool.description, /stops an over-threshold first attempt for review/i);
  assert.match(tool.description, /message history teaches voice and relationship register, not a default word count/i);
  assert.match(tool.description, /under-sending to the recipient's agent is worse than over-sending/i);
  assert.match(tool.inputSchema.properties.forHuman.description, /USE THE FEWEST WORDS THAT FAITHFULLY PRESERVE IT/);
  assert.match(tool.inputSchema.properties.forHuman.description, /NOT A TARGET OR BUDGET/);
  assert.match(tool.inputSchema.properties.longForHumanConfirmed.description, /already rejected this exact over-60-word draft/i);
  assert.match(tool.inputSchema.properties.forAgent.description, /complete .*document/i);
  assert.match(tool.inputSchema.properties.forAgent.description, /may be as long and detailed as necessary/i);
});

test("relay_send requires the model to classify message versus Request", async () => {
  await assert.rejects(
    send({
      recipient: { email: "shane@example.com" },
      title: "Quick demo check-in",
      forHuman: "How did the demo land?",
      idempotencyKey: "idem_two_doc_missing_kind",
    }),
    /kind is required/i,
  );
});

test("the retired handoff kind is gone from the tool contract for new sends", () => {
  const tool = TOOLS.find((t) => t.name === "relay_send");
  // Machine detail belongs in forAgent, not in a separate message ontology.
  // (The TRANSPORT still tolerates historical "handoff" packets during rolling
  // deploys — that tolerance is pinned on the API side; this contract is what
  // new agents are taught.)
  assert.deepEqual(tool.inputSchema.properties.kind.enum, ["message", "task"]);
  assert.match(tool.inputSchema.properties.kind.description, /old 'handoff' kind no longer exists/i);
  // Both documents are declared, and only the human one is required.
  assert.ok(tool.inputSchema.properties.forHuman);
  assert.ok(tool.inputSchema.properties.forAgent);
  assert.equal(tool.inputSchema.required.includes("forHuman"), true);
  assert.equal(tool.inputSchema.required.includes("forAgent"), false);
});
