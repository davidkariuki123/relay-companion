// A Relay you send yourself arrives like one from anyone else: one banner
// with its words, and a tap opens the conversation. Its Sent twin carries the
// same relay id and must not add a second row. Real renderer, mocked IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
try {
  const cases = [
    { name: "a quick text", from: "self", kind: "message", title: "", expect: /remember the milk/ },
    { name: "a titled Relay", from: "self", kind: "message", title: "Note to self", expect: /Note to self/ },
    { name: "a Task", from: "self", kind: "task", title: "Check the deploy", expect: /Task/ },
    { name: "a Relay from someone else", from: "sven", kind: "message", title: "Note from Sven", expect: /Note from Sven/ },
  ];
  for (const kase of cases) {
    const page = await browser.newPage({ viewport: { width: 960, height: 820 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((kase) => {
      window.events = {};
      const now = new Date().toISOString();
      const pill = { host: "relay-preview", clientVersion: "0.1.636" };
      const me = { name: "Shane Acton", email: "shane@example.com" };
      const from = kase.from === "self" ? me : { name: "Sven Wellmann", email: "sven@example.com" };
      const row = { id: "relay_arrival", threadId: "relay_arrival", kind: kase.kind,
        relayNotificationKind: kase.kind === "task" ? "task" : "plain_relay", title: kase.title,
        forHuman: "remember the milk", forAgent: kase.title ? "Detail." : "",
        senderName: from.name, senderEmail: from.email, createdAt: now, state: "unread", unread: true, source: pill };
      // The self-send exists on BOTH sides with the same relay id.
      const sent = kase.from === "self" ? [{ relayId: row.id, threadId: row.threadId, kind: row.kind, title: row.title,
        forHuman: row.forHuman, forAgent: row.forAgent, recipient: me, state: "delivered", createdAt: now, updatedAt: now, source: pill }] : [];
      window.arrival = { row, sent };
      window.fixture = { account: { paired: true, userId: "self", name: me.name, email: me.email, hasSentRelay: true },
        ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
        features: { requests: true }, requests: [], chats: [], slackChats: [], outbox: [],
        contacts: [{ id: "c_sven", name: "Sven Wellmann", email: "sven@example.com", source: "manual" }], relays: [], sent: [] };
      const api = { isTestOverlay: true, refresh: async () => structuredClone(window.fixture), refreshSent: async () => ({ items: window.fixture.sent }),
        contacts: async () => window.fixture.contacts, groups: async () => ({ ok: true, result: [] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}) };
      window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; } : async () => ({ ok: true }) });
    }, kase);
    await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
    await page.waitForFunction(() => !!window.events.onNewRelay && !!window.events.onInbox);
    await page.waitForTimeout(300);
    await page.evaluate(() => foldToPill());
    await page.waitForFunction(() => collapsed);
    // Main's order: the inbox that carries the arrival, then the arrival.
    await page.evaluate(() => {
      window.fixture.relays = [window.arrival.row];
      window.fixture.sent = window.arrival.sent;
      window.events.onInbox(structuredClone(window.fixture));
      window.events.onNewRelay([window.arrival.row], { sequential: true });
    });
    const banner = page.locator('.relay-arrival[data-opening-id="relay_arrival"]');
    await banner.waitFor();
    assert.equal(await page.evaluate(() => peeking), true, `${kase.name}: the banner peeks`);
    assert.equal(await page.locator(".relay-arrival").count(), 1, `${kase.name}: one banner row, not one per side`);
    const words = await banner.innerText();
    assert.match(words, kase.expect, `${kase.name}: the banner says what arrived`);
    assert.match(words, kase.from === "self" ? /Shane Acton/ : /Sven Wellmann/, `${kase.name}: the banner names the sender`);
    await banner.locator(".th-party").click();
    await page.waitForFunction(() => activeView === "threads");
    assert.deepEqual(errors, [], `${kase.name}: no renderer errors`);
    await page.close();
  }
  console.log("self relay arrival: ok");
} finally {
  await browser.close();
}
