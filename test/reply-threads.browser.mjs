// Real renderer with mocked IPC. Reply threads (developers on dev, Shane
// 2026-10-01): a typed reply someone chose to make folds under the message it
// answers; a Relay's thread reads in its reader, a text's opens as the room's
// subview; inside a thread a reply is a quote, never another thread.
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
    const pill = { host: "relay-preview", clientVersion: "0.1.570" };
    const sven = { senderName: "Sven Wellmann", senderEmail: "sven@example.com" };
    const toSven = { recipient: { name: "Sven Wellmann", email: "sven@example.com" }, state: "delivered" };
    const relays = [
      { id: "relay_r1", threadId: "t1", kind: "message", relayNotificationKind: "plain_relay", title: "Conductor support research",
        forHuman: "Relay already works in Conductor.", forAgent: "The detail.", ...sven, createdAt: ago(60), unread: false, source: pill },
      { id: "relay_t2", threadId: "t1", kind: "message", title: "", forHuman: "Yes, it's only a link.", forAgent: "", ...sven,
        inReplyToRelayId: "relay_t1", createdAt: ago(40), unread: true, source: pill },
      { id: "relay_t3", threadId: "t3", kind: "message", title: "", forHuman: "Nice. Are we demoing Thursday?", forAgent: "", ...sven,
        createdAt: ago(30), unread: false, source: pill },
      // An older client anchored every send to the message above it: no thread.
      { id: "relay_t5", threadId: "t3", kind: "message", title: "", forHuman: "Sent from an old pill.", forAgent: "", ...sven,
        inReplyToRelayId: "relay_t4", createdAt: ago(10), unread: false, source: { host: "relay-preview", clientVersion: "0.1.200" } },
    ];
    const sent = [
      { relayId: "relay_t1", threadId: "t1", kind: "message", title: "", forHuman: "Can we ship it this week?", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_r1", createdAt: ago(50), updatedAt: ago(50), source: pill },
      { relayId: "relay_t4", threadId: "t3", kind: "message", title: "", forHuman: "Yes. Checklist coming.", forAgent: "", ...toSven,
        inReplyToRelayId: "relay_t3", createdAt: ago(20), updatedAt: ago(20), source: pill },
      // A full Relay sent as a reply stays in the room with its quote.
      { relayId: "relay_r2", threadId: "t3", kind: "message", title: "Execute demo checklist", forHuman: "Here is the list.", forAgent: "The detail.", ...toSven,
        inReplyToRelayId: "relay_t3", createdAt: ago(5), updatedAt: ago(5), source: pill },
    ];
    window.fixture = { account: { paired: true, userId: "self", name: "Shane", email: "shane@example.com", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
      features: { replyThreads: true }, relays, sent, requests: [], chats: [], slackChats: [], outbox: [] };
    window.sends = [];
    window.acks = [];
    const api = { isTestOverlay: true, refresh: async () => window.fixture, refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => [], groups: async () => ({ ok: true, result: [] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      sendReply: async (request) => { window.sends.push(request); return { ok: true }; },
      ackMany: async (ids) => { window.acks.push(...ids); return { ok: true }; } };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  const present = async (id) => page.locator(`#thRows [data-msg="${id}"]`).count();
  const openRoom = async () => {
    await page.locator("#relaysList .relay-arrival").first().click();
    await page.locator('#thRows [data-msg="relay_r1"]').waitFor();
  };

  // The room: each message once, its typed replies folded under it.
  await openRoom();
  for (const id of ["relay_r1", "relay_t3", "relay_t5", "relay_r2"]) assert.equal(await present(id), 1, `${id} stays in the room`);
  for (const id of ["relay_t1", "relay_t2", "relay_t4"]) assert.equal(await present(id), 0, `${id} folds into its thread`);
  const strip = page.locator('[data-msg="relay_r1"] .th-rt-link.strip');
  assert.match(await strip.innerText(), /2 replies/, "a reply to a reply joins the same thread");
  assert.match(await strip.innerText(), /1 new/);
  assert.match(await page.locator('.th-rt-link[data-reply-thread-open="relay_t3"]').innerText(), /1 reply/);
  assert.equal(await page.locator('[data-msg="relay_r2"] .th-reply-ref').count(), 1, "the full Relay keeps its quote");
  assert.equal(await page.locator('[data-msg="relay_t5"] .th-reply-ref').count(), 0, "a legacy anchor is not a reply");
  assert.ok(!(await page.evaluate(() => window.acks)).includes("relay_t2"), "a folded reply is not read by opening the room");
  assert.equal(await page.locator('[data-msg="relay_r1"] [data-reply-to="relay_r1"]').innerText().catch(() => ""), "reply in thread");

  // A text's thread opens as the room's subview; its composer answers the text.
  await page.locator('.th-rt-link[data-reply-thread-open="relay_t3"]').click();
  await page.locator('#thRows [data-msg="relay_t4"]').waitFor();
  assert.equal(await present("relay_r1"), 0);
  assert.equal(await page.locator("#thDetailMeta").innerText(), "Thread");
  assert.match(await page.locator("#thRows .th-rt-divider").innerText(), /1 reply/i);
  assert.equal(await page.locator("#thQrInput").getAttribute("data-placeholder"), "Reply in thread…");
  assert.equal(await page.locator('[data-reply-to="relay_t4"]').innerText().catch(() => ""), "reply", "inside a thread Reply quotes");
  await page.locator("#thQrInput").fill("Tuesday works too.");
  await page.locator("#thQrSend").click();
  await page.waitForFunction(() => window.sends.length === 1);
  assert.equal((await page.evaluate(() => window.sends))[0].inReplyToRelayId, "relay_t3");
  // Back leaves the thread, not the room.
  await page.locator("#thBack").click();
  await page.locator('#thRows [data-msg="relay_r1"]').waitFor();

  // A Relay's thread reads in its reader, under Details, and reading it there
  // marks the new reply read. A reply may quote another reply.
  await strip.click();
  const replies = page.locator("#readerReplies");
  await replies.waitFor();
  assert.equal(await replies.locator(".rd-reply").count(), 2);
  assert.match(await replies.locator(".rd-replies-new").innerText(), /1 new/i);
  assert.equal(await replies.locator('[data-rd-reply="relay_t2"] .rd-reply-quote').count(), 1, "the reply to a reply shows what it quotes");
  assert.equal(await replies.locator('[data-rd-reply="relay_t1"] .rd-reply-quote').count(), 0, "a reply to the Relay needs no quote");
  const order = await page.evaluate(() => {
    const details = document.querySelector(".rd-details"), section = document.getElementById("readerReplies"), actions = document.getElementById("readerActions");
    const before = (x, y) => Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before(details, section) && before(section, actions);
  });
  assert.ok(order, "Replies sit between Details and the Open in bar");
  await page.waitForFunction(() => window.acks.includes("relay_t2"));
  assert.equal(await page.locator("#qrInput").getAttribute("placeholder"), "Reply in thread…");
  await replies.locator('[data-rd-quote="relay_t2"]').click();
  assert.match(await page.locator("#readerComposer .th-reply-target").innerText(), /Replying to Sven/);
  await page.locator("#qrInput").fill("Paid only, then.");
  await page.locator("#qrSend").click();
  await page.waitForFunction(() => window.sends.length === 2);
  assert.equal((await page.evaluate(() => window.sends))[1].inReplyToRelayId, "relay_t2");
  assert.equal(await page.locator("#readerComposer .th-reply-target").count(), 0, "the quote clears after the send");

  // Without the developer row nothing changes: every reply in the room.
  await page.evaluate(() => { window.fixture = { ...window.fixture, features: {} }; onPayload(window.fixture); closeReader(); });
  await page.locator('#thRows [data-msg="relay_t2"]').waitFor();
  for (const id of ["relay_t1", "relay_t2", "relay_t4"]) assert.equal(await present(id), 1, `${id} is in the room without the row`);
  assert.equal(await page.locator("#thRows .th-rt-link").count(), 0);
  await page.locator('#thRows [data-msg="relay_r1"]').click();
  await page.locator("#readerBack").waitFor();
  assert.equal(await page.locator("#readerReplies").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: replies fold under their message; a text's thread is a room subview, a Relay's reads in its reader; quotes inside, no nesting; nothing without the row.");
} finally { await browser.close(); }
