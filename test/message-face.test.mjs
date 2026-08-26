import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { firstLineOf, isChatMessage, openingFaceFor } = require("../overlay/message-face.cjs");

// A typed text carries no title on the wire; legacy rows may still carry one a
// client synthesized before untitled texts shipped. The face never depends on
// title similarity either way — the agent document is the species line.
const chatMessage = (over = {}) => ({
  threadId: "relay_thread",
  title: "",
  forHuman: "sending!",
  ...over,
});

test("an untitled typed text opens in the conversation", () => {
  assert.equal(openingFaceFor(chatMessage()), "chat");
  assert.equal(openingFaceFor(chatMessage({ forHuman: "on my way\n\nfive minutes out" })), "chat");
  // Legacy rows whose synthesized title survived staging are still texts.
  assert.equal(openingFaceFor(chatMessage({ title: "sending!" })), "chat");
});

test("a two-document Relay opens on the reading face", () => {
  assert.equal(
    openingFaceFor(
      chatMessage({
        title: "Cloudflare: one public hostname on our existing tunnel",
        forHuman: "Hey David — Shane here (via Claude). We're shipping a small new service…",
        forAgent: "Tunnel id, route, verification evidence and rollback steps.",
      }),
    ),
    "message",
  );
});

test("a human-only message stays text even when a legacy sender supplied a subject", () => {
  assert.equal(
    openingFaceFor(chatMessage({ title: "Heads up", forHuman: "Heads up, the deploy queue cancelled your run." })),
    "chat",
  );
});

test("agent and system output keeps the reading face whatever its title says", () => {
  for (const relayNotificationKind of ["human_question", "task_completed", "result", "connector_reauth"]) {
    assert.equal(openingFaceFor(chatMessage({ relayNotificationKind })), "message", relayNotificationKind);
  }
  assert.equal(openingFaceFor(chatMessage({ taskId: "task_1" })), "message", "attached to a task");
  assert.equal(openingFaceFor(chatMessage({ type: "question" })), "chat", "human-only question is text");
  assert.equal(openingFaceFor(chatMessage({ type: "completion" })), "chat", "human-only completion is text");
  assert.equal(
    openingFaceFor(chatMessage({ type: "completion", forAgent: "Agent verification detail" })),
    "message",
    "a two-document completion is a Relay",
  );
  // A plain person-to-person relay is exactly what DOES open in the conversation.
  assert.equal(openingFaceFor(chatMessage({ relayNotificationKind: "plain_relay" })), "chat");
});

test("a message with no conversation to open into keeps the reading face", () => {
  assert.equal(openingFaceFor(chatMessage({ threadId: "" })), "message");
  assert.equal(openingFaceFor(chatMessage({ threadId: "   " })), "message");
});

test("an empty body never counts as a chat message", () => {
  // Otherwise a staged row with a title and no body would open into a
  // conversation to show the reader nothing at all.
  assert.equal(isChatMessage({ threadId: "t", title: "Relay", forHuman: "" }), false);
  assert.equal(isChatMessage({ threadId: "t", title: "", forHuman: "" }), false);
});

test("firstLineOf finds the first line that says something", () => {
  assert.equal(firstLineOf("# A heading first\nthen the rest"), "A heading first");
  assert.equal(firstLineOf("   \n\n  finally something"), "finally something");
  assert.equal(firstLineOf("> quoted opening line\nand more"), "quoted opening line");
  assert.equal(firstLineOf(""), "");
});
