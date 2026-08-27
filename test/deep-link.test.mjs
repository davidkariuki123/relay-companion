import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseRelayDeepLink, relayDeepLinkFromArgv } = require("../overlay/deep-link.cjs");

test("Relay deep links name one message and one supported host", () => {
  assert.deepEqual(parseRelayDeepLink("relay://open?message=msg_123&host=codex"), {
    messageId: "msg_123",
    host: "codex",
  });
  assert.deepEqual(parseRelayDeepLink("relay://open?message=relay_123&host=claude"), {
    messageId: "relay_123",
    host: "claude",
  });
  assert.deepEqual(parseRelayDeepLink("relay://open?message=msg_456&host=relay"), {
    messageId: "msg_456",
    host: "relay",
  });
  assert.deepEqual(parseRelayDeepLink("relay://open?message=msg_456&host=relay&chat=chat_abc123"), {
    messageId: "msg_456",
    host: "relay",
    chatId: "chat_abc123",
  });
});

test("Relay deep links fail closed", () => {
  for (const input of [
    "https://sendrelays.com/open?message=msg_1&host=codex",
    "relay://settings?message=msg_1&host=codex",
    "relay://open?message=../secret&host=codex",
    "relay://open?message=msg_1&host=cowork",
    "relay://open?message=msg_1&host=relay&chat=../../secret",
    "relay://open?message=&host=codex",
  ]) assert.equal(parseRelayDeepLink(input), null, input);
});

test("argv parser ignores unrelated process arguments", () => {
  assert.deepEqual(
    relayDeepLinkFromArgv(["Relay", "--flag", "relay://open?message=msg_9&host=codex"]),
    { url: "relay://open?message=msg_9&host=codex", messageId: "msg_9", host: "codex" },
  );
});
