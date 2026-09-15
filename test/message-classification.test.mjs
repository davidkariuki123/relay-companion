import assert from "node:assert/strict";
import test from "node:test";
import { classificationArguments, classificationToolProperties } from "../src/message-classification.js";
import { handleCall, toolsForAccount } from "../src/mcp.js";

test("ordinary accounts can classify a Relay without acquiring Topic or Task capabilities", async () => {
  const features = { requests: false, topics: false, todo: false, aiSessions: false, connectors: false, messageMutations: false };
  const tools = toolsForAccount(features);
  const send = tools.find((tool) => tool.name === "relay_send");
  assert.deepEqual(send.inputSchema.properties.nature, classificationToolProperties.nature);
  assert.deepEqual(send.inputSchema.properties.asks, classificationToolProperties.asks);
  assert.match(send.inputSchema.properties.nature.description, /including production/);
  assert.match(send.inputSchema.properties.asks.description, /silently supply/);
  assert.equal(tools.some((tool) => tool.name === "relay_topic_post"), false);
  let body;
  await handleCall({ async sendRelay(value) { body = value; return { relayId: "relay_labels" }; } }, "relay_send", {
    recipient: { self: true }, kind: "message", title: "Review this plan", forHuman: "Here is the plan. What would you change?",
    forAgent: "A plan and a request for feedback.", nature: ["plan", "question"], asks: ["feedback"], idempotencyKey: "labels-send-ordinary",
  }, { features });
  assert.deepEqual(body.nature, ["plan", "question"]);
  assert.deepEqual(body.asks, ["feedback"]);
  assert.equal(body.kind, "message");
  assert.equal(body.forHuman, "Here is the plan. What would you change?");
});

test("Topic posting transports every nature and ask unchanged", async () => {
  let body;
  await handleCall({ async createTopicPost(id, value) { body = value; return { post: { id, ...value } }; } }, "relay_topic_post", {
    topicId: "tpc_labels", nature: ["event", "finding"], asks: ["action"], title: "Please verify the release",
    forAgent: "The release happened. The cause is our finding. Please test it.", idempotencyKey: "labels-topic-post",
  });
  assert.deepEqual(body.nature, ["event", "finding"]);
  assert.deepEqual(body.asks, ["action"]);
});

test("invalid labels fail before any client call rather than being silently dropped", async () => {
  let calls = 0;
  await assert.rejects(handleCall({ async sendRelay() { calls++; } }, "relay_send", {
    recipient: { self: true }, kind: "message", title: "Testing invalid message labels", forHuman: "Hello", forAgent: "Context", nature: ["plan", "plan"], idempotencyKey: "labels-invalid-send",
  }), /unique supported labels/);
  assert.equal(calls, 0);
  assert.deepEqual(classificationArguments({ nature: "question", asks: [] }), { nature: "question", asks: [] });
  assert.deepEqual(classificationArguments({}), {});
});
