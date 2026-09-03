import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseRelayDeepLink, relayDeepLinkFromArgv, relayDeepLinkFailureStatus, safeAckOrigin } = require("../overlay/deep-link.cjs");
const overlay = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

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
  assert.deepEqual(parseRelayDeepLink("relay://open?message=msg_456&host=codex&handoff=handoff_12345678"), {
    messageId: "msg_456",
    host: "codex",
    handoffId: "handoff_12345678",
  });
  assert.deepEqual(parseRelayDeepLink("relay://open?message=msg_456&host=codex&handoff=handoff_12345678&ack=https%3A%2F%2Frelay-web-dev.us-east-1.awsapprunner.com"), {
    messageId: "msg_456",
    host: "codex",
    handoffId: "handoff_12345678",
    ackOrigin: "https://relay-web-dev.us-east-1.awsapprunner.com",
  });
});

test("Relay deep links fail closed", () => {
  for (const input of [
    "https://sendrelays.com/open?message=msg_1&host=codex",
    "relay://settings?message=msg_1&host=codex",
    "relay://open?message=../secret&host=codex",
    "relay://open?message=msg_1&host=cowork",
    "relay://open?message=msg_1&host=relay&chat=../../secret",
    "relay://open?message=msg_1&host=relay&handoff=short",
    "relay://open?message=msg_1&host=relay&handoff=../../secret",
    "relay://open?message=msg_1&host=relay&ack=https%3A%2F%2Fevil.example",
    "relay://open?message=&host=codex",
  ]) assert.equal(parseRelayDeepLink(input), null, input);
});

test("handoff acknowledgements return only to a trusted reader origin", () => {
  assert.equal(safeAckOrigin("https://sendrelays.com"), "https://sendrelays.com");
  assert.equal(safeAckOrigin("https://reader.us-east-1.awsapprunner.com"), "https://reader.us-east-1.awsapprunner.com");
  assert.equal(safeAckOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(safeAckOrigin("https://reader.us-east-1.awsapprunner.com/path"), "");
  assert.equal(safeAckOrigin("https://evil.example"), "");
  assert.match(overlay, /new URL\("\/open\/relay\/ack", parsed\.ackOrigin \|\| webBase\(\)\)/);
});

test("every desktop protocol route preserves the browser handoff acknowledgement", () => {
  const queueStart = overlay.indexOf("function queueRelayDeepLink(");
  const queueEnd = overlay.indexOf("function registerRelayProtocol(", queueStart);
  assert.notEqual(queueStart, -1);
  assert.notEqual(queueEnd, -1);
  const queue = overlay.slice(queueStart, queueEnd);
  assert.match(queue, /handoffId: parsed\.handoffId/);
  assert.match(queue, /ackOrigin: parsed\.ackOrigin/);

  const openUrlStart = overlay.indexOf('app.on("open-url"');
  const openUrlEnd = overlay.indexOf("const {", openUrlStart);
  const secondStart = overlay.indexOf('app.on("second-instance"');
  const secondEnd = overlay.indexOf('app.on("activate"', secondStart);
  const readyStart = overlay.indexOf("app.whenReady().then");
  const readyEnd = overlay.indexOf("relayDeepLinksReady = true", readyStart);
  assert.match(overlay.slice(openUrlStart, openUrlEnd), /queueRelayDeepLink\(parseRelayDeepLink\(url\)\)/);
  assert.match(overlay.slice(secondStart, secondEnd), /queueRelayDeepLink\(deepLink\)/);
  assert.match(overlay.slice(readyStart, readyEnd), /queueRelayDeepLink\(initialDeepLink\)/);
});

test("argv parser ignores unrelated process arguments", () => {
  assert.deepEqual(
    relayDeepLinkFromArgv(["Relay", "--flag", "relay://open?message=msg_9&host=codex"]),
    { url: "relay://open?message=msg_9&host=codex", messageId: "msg_9", host: "codex" },
  );
});

test("desktop handoff failures distinguish account mismatch from a transient unavailable computer", () => {
  assert.equal(relayDeepLinkFailureStatus({ status: 401 }), "account_required");
  assert.equal(relayDeepLinkFailureStatus({ statusCode: 404 }), "account_required");
  assert.equal(relayDeepLinkFailureStatus({ code: "credential_missing" }), "account_required");
  assert.equal(relayDeepLinkFailureStatus(new Error("network reset")), "unavailable");
});
