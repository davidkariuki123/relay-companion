// Real renderer with mocked IPC. An agent called with @ inside a reply thread
// answers in that thread (Shane, 2026-10-06): its run replies to the message
// that called it, so it joins that message's thread, and a reply to the agent
// stays there too. Called from the room, it answers in the room.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 750, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const pill = { host: "relay-preview", clientVersion: "0.1.580" };
    const claude = { host: "relay-agent-run", surface: "claude_code" };
    const codex = { host: "relay-agent-run", surface: "codex" };
    const sven = { senderName: "Sven Wellmann", senderEmail: "sven@example.com" };
    const toSven = { recipient: { name: "Sven Wellmann", email: "sven@example.com" }, state: "delivered" };
    const relays = [
      { id: "relay_r1", threadId: "t1", kind: "message", relayNotificationKind: "plain_relay", title: "Conductor support research",
        forHuman: "Relay already works in Conductor.", forAgent: "The detail.", ...sven, createdAt: ago(60), unread: false, source: pill },
      { id: "relay_t3", threadId: "t3", kind: "message", title: "", forHuman: "Can someone check the build?", forAgent: "", ...sven,
        createdAt: ago(40), unread: false, source: pill },
    ];
    const sent = [
      // Called inside the Relay's thread: the answer joins that thread.
      { relayId: "relay_t1", threadId: "t1", kind: "message", title: "", forHuman: "@my_claude summarise this for me", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_r1", createdAt: ago(50), updatedAt: ago(50), source: pill },
      { relayId: "relay_a1", threadId: "t1", kind: "message", title: "", forHuman: "It works today; the link version is free.", forAgent: "Full summary.", ...toSven,
        inReplyToRelayId: "relay_t1", createdAt: ago(49), updatedAt: ago(48), source: claude },
      // A reply to the agent stays in the thread too.
      { relayId: "relay_t5", threadId: "t1", kind: "message", title: "", forHuman: "Thanks, that is what I needed.", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_a1", createdAt: ago(47), updatedAt: ago(47), source: pill },
      // Called inside a text's thread, still working.
      { relayId: "relay_t4", threadId: "t3", kind: "message", title: "", forHuman: "@my_codex check the build", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_t3", createdAt: ago(30), updatedAt: ago(30), source: pill },
      { relayId: "relay_a2", threadId: "t3", kind: "message", title: "", forHuman: " ", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_t4", createdAt: ago(29), updatedAt: ago(29), source: codex },
      // Called from the room: the answer stays in the room.
      { relayId: "relay_m1", threadId: "m1", kind: "message", title: "", forHuman: "@my_claude what is on today?", forAgent: "", ...toSven,
        createdAt: ago(20), updatedAt: ago(20), source: pill },
      { relayId: "relay_a3", threadId: "m1", kind: "message", title: "", forHuman: "Two reviews and the deploy.", forAgent: "Agenda.", ...toSven,
        inReplyToRelayId: "relay_m1", createdAt: ago(19), updatedAt: ago(19), source: claude },
    ];
    window.fixture = { account: { paired: true, userId: "self", name: "Shane", email: "shane@example.com", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
      features: { replyThreads: true, agentMentions: true }, relays, sent, requests: [], chats: [], slackChats: [], outbox: [] };
    window.opened = [];
    const api = { isTestOverlay: true, refresh: async () => window.fixture, refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => [], groups: async () => ({ ok: true, result: [] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      sendReply: async () => ({ ok: true }), ackMany: async () => ({ ok: true }) };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  const present = async (id) => page.locator(`#thRows [data-msg="${id}"]`).count();
  await page.locator("#relaysList .relay-arrival").first().click();
  await page.locator('#thRows [data-msg="relay_r1"]').waitFor();

  // The room keeps what was said there, including an agent called from it.
  for (const id of ["relay_r1", "relay_t3", "relay_m1", "relay_a3"]) assert.equal(await present(id), 1, `${id} stays in the room`);
  for (const id of ["relay_t1", "relay_a1", "relay_t5", "relay_t4", "relay_a2"]) assert.equal(await present(id), 0, `${id} answers in its thread`);
  const strip = page.locator('[data-msg="relay_r1"] .th-rt-link.strip');
  assert.match(await strip.innerText(), /3 replies/, "the agent's answer and the reply to it count in the thread");
  assert.match(await page.locator('.th-rt-link[data-reply-thread-open="relay_t3"]').innerText(), /2 replies/);

  // A text's thread shows the agent at work where it was called.
  await page.locator('.th-rt-link[data-reply-thread-open="relay_t3"]').click();
  await page.locator('#thRows [data-msg="relay_a2"]').waitFor();
  assert.equal(await present("relay_t4"), 1);
  assert.equal(await present("relay_r1"), 0);
  await page.locator("#thBack").click();
  await page.locator('#thRows [data-msg="relay_r1"]').waitFor();

  // A Relay's thread names the agent as itself, not "You", and opens its work.
  await strip.click();
  const replies = page.locator("#readerReplies");
  await replies.waitFor();
  assert.equal(await replies.locator(".rd-reply").count(), 3);
  const agentReply = replies.locator('[data-rd-reply="relay_a1"]');
  assert.equal(await agentReply.locator(".rd-reply-head .th-party").innerText(), "My Claude");
  assert.match(await agentReply.locator(".rd-reply-text").innerText(), /link version is free/);
  assert.equal(await agentReply.locator("[data-rd-open-work]").count(), 1, "the agent's answer opens its work");
  assert.equal(await agentReply.locator(".rd-reply-quote").count(), 0, "the agent does not re-quote the message right above it");
  assert.match(await replies.locator('[data-rd-reply="relay_t5"] .rd-reply-quote').innerText(), /My Claude/, "a reply to the agent quotes it by name");
  assert.deepEqual(errors, []);
  console.log("PASS: an agent called in a thread answers in that thread, named as itself; called from the room, it answers in the room.");
} finally { await browser.close(); }
