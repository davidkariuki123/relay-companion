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

test("setup handoffs carry only an opaque intent and trusted origin", () => {
  const id = "dsi_abcdefghijklmnopqrstuvwxyz";
  assert.deepEqual(parseRelayDeepLink(`relay://setup?intent=${id}&origin=https%3A%2F%2Fsendrelays.com`), { setupIntent:id, origin:"https://sendrelays.com" });
  for (const url of ["relay://setup?intent=short&origin=https://sendrelays.com",`relay://setup?intent=${id}&origin=https://evil.example`,`relay://setup?intent=${id}&origin=http://sendrelays.com`,`relay://user:pass@setup?intent=${id}&origin=https://sendrelays.com`]) assert.equal(parseRelayDeepLink(url),null);
});

test("a Slack card click by this account opens the Relay in the pill, once, whatever browser Slack used", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/client.js", import.meta.url), "utf8");
  assert.match(client, /claimSlackOpenRequests\(\) \{\s*return this\.#req\("POST", "\/v1\/slack\/open-requests\/claim", \{\}\);/);
  // Claimed at boot and on every account-change wake, through the relay:// queue.
  assert.match(main, /claimSlackOpens\(\);\s*sentLiveWake = startSentLiveWake\(/);
  assert.match(main, /onChange: async \(\) => \{\s*claimSlackOpens\(\);/);
  assert.match(main, /queueRelayDeepLink\(\{ messageId: String\(request\.messageId\), host: request\.host, viaSlack: true/);
  // Claude Code and Codex too, opened from their chat (a channel message has no legacy packet).
  assert.match(main, /\["relay", "conductor", "claude", "codex"\]\.includes\(request\.host\)/);
  assert.match(main, /parsed\.host === "relay" \|\| parsed\.host === "conductor" \|\| parsed\.viaSlack\) \{/);
  assert.match(main, /\.\.\.\(parsed\.host !== "relay" \? \{ app: parsed\.host \} : \{\}\)/);
  // The browser's relay:// link and the server's word are one click: the second only answers the browser.
  assert.match(main, /\["relay", "conductor", "claude", "codex"\]\.includes\(parsed\.host\) && !freshRelayOpen\(parsed\)/);
  assert.match(main, /const RELAY_OPEN_DEDUPE_MS = 15_000;/);
});

test("after sleep or unlock the pill reopens its account-change wait at once and claims waiting Slack clicks", () => {
  // A held request can be a dead socket after sleep; David's Slack click was claimed four minutes late.
  assert.match(overlay, /function restartSentLiveWake\(\) \{\s*if \(sentLiveWake\) \{ sentLiveWake\.stop\(\); sentLiveWake = null; \}\s*sentLiveWakeToken = "";/);
  assert.match(overlay, /powerMonitor\.on\("resume", \(\) => \{\s*systemSuspended = false;\s*restartSentLiveWake\(\);/);
  assert.match(overlay, /powerMonitor\.on\("unlock-screen", \(\) => \{\s*screenLocked = false;\s*restartSentLiveWake\(\);/);
  // Reopening runs the reconcile, which claims before it waits.
  assert.match(overlay, /claimSlackOpens\(\);\s*sentLiveWake = startSentLiveWake\(/);
});

test("a chat or channel message hands off to Claude Code / Codex: staged from the server when this device never received it", () => {
  assert.match(overlay, /async function stageServerRelayForDelivery\(id\) \{[\s\S]*?client\.fetchRelay\(id\)[\s\S]*?state: "read"[\s\S]*?return rowById\(id\);/);
  assert.match(overlay, /const row = rowById\(id\) \|\| await stageServerRelayForDelivery\(id\)\.catch\(\(\) => null\);\s*if \(!row\) throw new Error\("That Relay is no longer available on this device"\);/);
});
