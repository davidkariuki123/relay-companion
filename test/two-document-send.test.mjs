import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handleCall } from "../src/mcp.js";

// Product species: relay_send always creates a Relay with separately composed
// forHuman and non-empty forAgent documents. Explicit plain text uses
// relay_chat_send instead.

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
    "  ## What changed",
    "- `overlay/inbox.html`: scroll chrome removed (`display:none`)",
    "",
    "```bash",
    "node --test test/*.test.mjs",
    "```  ",
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

test("relay_send rejects an omitted, empty, or whitespace-only forAgent", async () => {
  const base = {
    recipient: { email: "shane@example.com" },
    kind: "message",
    title: "Quick demo check-in",
    forHuman: "How did the demo land?",
    idempotencyKey: "idem_two_doc_2",
  };
  for (const forAgent of [undefined, "", " \n\t "]) {
    await assert.rejects(
      send({ ...base, ...(forAgent === undefined ? {} : { forAgent }) }),
      /forAgent is required and must be non-empty/i,
    );
  }
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
  assert.match(tool.description, /then write forHuman for the person/i);
  assert.match(tool.description, /Keep forHuman under 95 words/i);
  assert.match(tool.description, /a small update is a line or two/i);
  assert.match(tool.description, /ceiling, not a target/i);
  assert.match(tool.description, /under-sending to the recipient's agent is worse than over-sending/i);
  assert.match(tool.inputSchema.properties.forHuman.description, /OPEN FROM THE TOP/i);
  assert.match(tool.inputSchema.properties.forHuman.description, /opening background survives every cut/i);
  assert.match(tool.inputSchema.properties.forHuman.description, /Clarification before sending is uncommon/i);
  assert.match(tool.inputSchema.properties.longForHumanConfirmed.description, /already rejected this exact draft/i);
  assert.match(tool.inputSchema.properties.forAgent.description, /complete .*document/i);
  assert.match(tool.inputSchema.properties.forAgent.description, /may be as long and detailed as necessary/i);
});

test("relay_send requires the model to classify message versus Task", async () => {
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
  // Both Relay documents are declared and required.
  assert.ok(tool.inputSchema.properties.forHuman);
  assert.ok(tool.inputSchema.properties.forAgent);
  assert.equal(tool.inputSchema.required.includes("forHuman"), true);
  assert.equal(tool.inputSchema.required.includes("forAgent"), true);
});
