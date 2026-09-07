import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, handleCall, toolsForAccount } from "../src/mcp.js";

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
  const tool = toolsForAccount({ requests: true, aiSessions: true, connectors: true }, "codex")
    .find((t) => t.name === "relay_send");
  const skill = readFileSync(new URL("../skill/relay/SKILL.md", import.meta.url), "utf8");
  assert.match(tool.description, /Read the installed Relay skill/);
  assert.match(skill, /Compose the complete\s+`forAgent` first, then write `forHuman`/);
  assert.match(skill, /Stay under 95\s+words by default/);
  assert.match(skill, /a ceiling, never a target/);
  assert.match(skill, /a small update is usually\s+a line or two/);
  assert.match(skill, /Under-sending\s+here is worse than over-sending/);
  assert.match(skill, /preserve that orientation when cutting/);
  assert.match(tool.inputSchema.properties.forHuman.description, /enough background for someone arriving fresh/);
  assert.match(tool.inputSchema.properties.forHuman.description, /put supporting detail in forAgent/);
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
