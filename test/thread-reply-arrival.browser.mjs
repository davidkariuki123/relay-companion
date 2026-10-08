// A reply that arrives in a thread (David, Granular, 2026-10-08). Its banner
// says so, its quick reply answers in the thread, and tapping it opens the
// chat ON the reply. Before, the chat opened at its newest message and the
// reply, folded under a Relay further up, sat off screen behind "↑ 1 new".
// Real renderer, mocked IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 820 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    window.sends = [];
    const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
    const pill = { host: "relay-preview", clientVersion: "0.1.596" };
    const room = { recipientGroupId: "grp_granular", recipientGroupName: "Granular" };
    const said = (id, name, words, minutes) => ({ id, threadId: id, kind: "message", relayNotificationKind: "plain_relay", title: "", forHuman: words, forAgent: "",
      senderName: name, senderEmail: `${name.split(" ")[0].toLowerCase()}@example.com`, ...room, createdAt: ago(minutes), state: "read", unread: false, source: pill });
    window.fixture = { account: { paired: true, userId: "self", name: "David Kariuki", email: "david@example.com", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
      features: { replyThreads: true }, requests: [], chats: [], slackChats: [], outbox: [],
      relays: [said("relay_morning", "Sven Wellmann", "Morning", 90), said("relay_green", "Sven Wellmann", "Deploy is green", 40), said("relay_merge", "Shane Acton", "Merging the share fix next", 30)],
      sent: [{ relayId: "relay_question", threadId: "t_q", kind: "message", title: "Thoughts on expanded mode?", forHuman: "What do you think?", forAgent: "Detail.",
        recipient: { name: "Granular" }, state: "delivered", ...room, groupSendId: "gsend_q", createdAt: ago(65), updatedAt: ago(65), source: pill }] };
    const group = { id: "grp_granular", name: "Granular", members: [] };
    const api = { isTestOverlay: true, refresh: async () => structuredClone(window.fixture), refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => [], groups: async () => ({ ok: true, result: [group] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      sendReply: async (request) => { window.sends.push(request); return { ok: true }; } };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; } : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => !!window.events.onNewRelay && !!window.events.onInbox);
  await page.waitForTimeout(300);
  const arrive = async (id, words) => {
    await page.evaluate(() => foldToPill());
    await page.waitForFunction(() => collapsed);
    const reply = { id, threadId: "t_q", kind: "message", relayNotificationKind: "plain_relay", title: "", forHuman: words, forAgent: "",
      senderName: "Shane Acton", senderEmail: "shane@example.com", recipientGroupId: "grp_granular", recipientGroupName: "Granular",
      inReplyToRelayId: "relay_question", createdAt: new Date().toISOString(), state: "delivered", unread: true, source: { host: "relay-preview", clientVersion: "0.1.596" } };
    await page.evaluate((row) => { window.fixture.relays.push(row); window.events.onInbox(structuredClone(window.fixture)); window.events.onNewRelay([row], { sequential: true }); }, reply);
    await page.locator(`.relay-arrival[data-opening-id="${id}"]`).waitFor();
  };

  // The banner names the thread, and its reply goes into the thread.
  await arrive("relay_outline", "The expanded mode needs a subtle outline");
  assert.match(await page.locator(".relay-arrival .th-title").first().innerText(), /^Shane in a thread:/);
  const composer = page.locator(".qr-banner .th-rich-composer");
  assert.equal(await composer.getAttribute("data-placeholder"), "Reply in thread…");
  await composer.click();
  await page.keyboard.type("Good call, adding one");
  await page.locator(".qr-banner-send").click();
  await page.waitForFunction(() => window.sends.length === 1);
  const [send] = await page.evaluate(() => window.sends);
  assert.equal(send.inReplyToRelayId, "relay_outline", "the banner answers in the thread");
  assert.deepEqual(send.recipient, { groupId: "grp_granular" });
  assert.equal(send.chat.threadId, "t_q");

  // A tap on the banner opens the chat on the reply it announced.
  await page.waitForFunction(() => collapsed && !peeking, null, { timeout: 5000 });
  await arrive("relay_fullscreen", "Maybe it should just be a full app");
  await page.locator('.relay-arrival[data-opening-id="relay_fullscreen"] .th-party').click();
  await page.waitForFunction(() => activeView === "threads");
  await page.waitForFunction(() => replyNewsPlacement("relay_fullscreen") === "visible");

  assert.deepEqual(errors, []);
  console.log("thread reply arrival: ok");
} finally {
  await browser.close();
}
