// Real renderer with mocked IPC. An @agent run waits while this computer has
// not allowed Relay to run agents, and its reply carries Allow right there,
// the same question the first Execute asks (Shane, 2026-10-07). Allow leaves
// once it is on; answered runs and other people's agents never show it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");

const fixtureScript = (executionEnabled) => {
  const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const pill = { host: "relay-preview", clientVersion: "0.1.585" };
  const claude = { host: "relay-agent-run", surface: "claude_code" };
  const sven = { senderName: "Sven Wellmann", senderEmail: "sven@example.com" };
  const toSven = { recipient: { name: "Sven Wellmann", email: "sven@example.com" }, state: "delivered" };
  const relays = [
    { id: "relay_r1", threadId: "t1", kind: "message", relayNotificationKind: "plain_relay", title: "Growth slowdown",
      forHuman: "Lower the growth slowdown to about 0.2.", forAgent: "The detail.", ...sven, createdAt: ago(60), unread: false, source: pill },
  ];
  const sent = [
    // Called in the Relay's thread; never started on this computer.
    { relayId: "relay_t1", threadId: "t1", kind: "message", title: "", forHuman: "@my_claude", forAgent: "", ...toSven,
      inReplyToRelayId: "relay_r1", createdAt: ago(50), updatedAt: ago(50), source: pill },
    { relayId: "relay_a1", threadId: "t1", kind: "message", title: "", forHuman: " ", forAgent: "", ...toSven,
      inReplyToRelayId: "relay_t1", createdAt: ago(49), updatedAt: ago(49), source: claude },
    // An earlier run that answered.
    { relayId: "relay_t2", threadId: "t1", kind: "message", title: "", forHuman: "@my_claude summarise", forAgent: "", ...toSven,
      inReplyToRelayId: "relay_r1", createdAt: ago(55), updatedAt: ago(55), source: pill },
    { relayId: "relay_a2", threadId: "t1", kind: "message", title: "", forHuman: "Done: it is a payout change.", forAgent: "Summary.", ...toSven,
      inReplyToRelayId: "relay_t2", createdAt: ago(54), updatedAt: ago(54), source: claude },
    // Called from the room; the daemon has said why it waits.
    { relayId: "relay_m1", threadId: "m1", kind: "message", title: "", forHuman: "@my_claude what is on today?", forAgent: "", ...toSven,
      createdAt: ago(20), updatedAt: ago(20), source: pill },
    { relayId: "relay_a3", threadId: "m1", kind: "message", title: "", forHuman: "Claude is waiting: this computer hasn't allowed Relay to run agents yet.", forAgent: "", ...toSven,
      inReplyToRelayId: "relay_m1", createdAt: ago(19), updatedAt: ago(19), source: claude },
  ];
  window.fixture = { account: { paired: true, userId: "self", name: "Shane", email: "shane@example.com", hasSentRelay: true },
    ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
    features: { replyThreads: true, agentMentions: true, taskExecution: true }, nativeExecutionEnabled: executionEnabled,
    relays, sent, requests: [], chats: [], slackChats: [], outbox: [] };
  window.enableCalls = 0;
  const api = { isTestOverlay: true, refresh: async () => window.fixture, refreshSent: async () => ({ items: window.fixture.sent }),
    contacts: async () => [], groups: async () => ({ ok: true, result: [] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
    sendReply: async () => ({ ok: true }), ackMany: async () => ({ ok: true }),
    executionEnable: async () => { window.enableCalls += 1; return { ok: true }; } };
  window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : async () => ({ ok: true }) });
};

const browser = await chromium.launch({ headless: true });
try {
  const open = async (executionEnabled) => {
    const page = await browser.newPage({ viewport: { width: 750, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(fixtureScript, executionEnabled);
    await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
    await page.locator("#relaysList .relay-arrival").first().click();
    await page.locator('#thRows [data-msg="relay_r1"]').waitFor();
    return { page, errors };
  };

  {
    const { page, errors } = await open(false);
    // In the room: the daemon's words say why, so only the button is added.
    const roomAgent = page.locator('#thRows [data-msg="relay_a3"]');
    assert.equal(await roomAgent.locator(".agent-allow button").count(), 1, "a waiting run in the room offers Allow");
    assert.equal(await roomAgent.locator(".agent-allow span").count(), 0, "the daemon's reply already says why");

    // In the thread: the silent run says why itself and offers Allow.
    await page.locator('[data-msg="relay_r1"] .th-rt-link.strip').click();
    const replies = page.locator("#readerReplies");
    await replies.waitFor();
    const waiting = replies.locator('[data-rd-reply="relay_a1"]');
    assert.match(await waiting.locator(".agent-allow").innerText(), /Claude can't start until this computer allows Relay to run agents/);
    assert.equal(await waiting.locator(".rd-reply-working").count(), 0, "a run waiting for Allow is not shown as working");
    assert.equal(await replies.locator('[data-rd-reply="relay_a2"] .agent-allow').count(), 0, "an answered run has no Allow");

    await waiting.locator(".agent-allow button").click();
    await page.waitForFunction(() => window.enableCalls === 1);
    await page.waitForFunction(() => !document.querySelector(".agent-allow"));
    assert.equal(await page.evaluate(() => window.enableCalls), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    const { page, errors } = await open(true);
    assert.equal(await page.locator(".agent-allow").count(), 0, "nothing to allow once this computer allows agent runs");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: a waiting @agent run offers Allow in place, which asks once and then leaves.");
} finally { await browser.close(); }
