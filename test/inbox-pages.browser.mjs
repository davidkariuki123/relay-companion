// Inbox pages (dev-gated): real renderer, isolated in-memory IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
const errors = [];

async function openPill(features) {
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((features) => {
    window.events = {}; window.done = [];
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const item = (id, extra = {}) => ({ id, relayId: id, threadId: `thread-${id}`, direction: "inbound", state: "delivered", unread: true,
      relayNotificationKind: "plain_relay", senderName: "Sven Wellmann", senderEmail: "sven@example.test", title: `Title ${id}`,
      forHuman: `Human body ${id}`, forAgent: `Agent context ${id}`, createdAt: ago(5), attachments: [], ...extra });
    window.fixture = {
      account: { paired: true, userId: "self", name: "David Kariuki", email: "self@example.test", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1 },
      features: { requests: true, todo: false, slack: false, taskExecution: true, ...features },
      contacts: [{ contactId: "sven", name: "Sven Wellmann", email: "sven@example.test" }],
      relays: [
        item("relay1"),
        item("task2", { kind: "task", relayNotificationKind: "task", title: "Cut the triple Done" }),
        item("text3", { forAgent: "", title: "", forHuman: "just a text" }),
        item("old4", { createdAt: ago(60 * 24 * 30), unread: false, title: "Old and read" }),
      ],
      sent: [{ relayId: "sent1", id: "sent1", kind: "task", title: "Try the full app", forHuman: "Tell me", forAgent: "Steps", recipient: { name: "Sven Wellmann", email: "sven@example.test" }, createdAt: ago(30), taskStartedAt: ago(10) }],
      requests: [], chats: [], slackChats: [],
    };
    const api = { isTestOverlay: true, refresh: async () => structuredClone(window.fixture), refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => window.fixture.contacts, groups: async () => ({ ok: true, result: [] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      taskDone: async (id) => { window.done.push(id); return { ok: true }; } };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; } : async () => ({ ok: true }) });
  }, features);
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => !!window.events.onOpenFull);
  await page.evaluate(() => window.events.onOpenFull());
  await page.locator("#relaysList .relay-arrival").first().waitFor();
  // A trackpad, in-page: one wheel event every 8 ms; reports which were blocked.
  await page.evaluate(() => {
    window.pad = (seq, every = 8) => new Promise((done) => {
      const out = []; let i = 0;
      const fire = () => {
        if (i >= seq.length) return done(out);
        const [dx, dy] = seq[i++];
        out.push(!document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true })));
        setTimeout(fire, every);
      };
      fire();
    });
  });
  return page;
}
const swipe = (dir, peak = 10) => { const s = []; for (const k of [.2, .45, .75, 1, 1]) s.push([dir * peak * k, 1.5 * k]); for (let i = 0; i < 6; i++) s.push([dir * peak, 1.5]); let d = peak; for (let i = 0; i < 60; i++) { d *= .94; if (d < .3) break; s.push([dir * d, .2]); } return s; };

try {
  // Gate off: nothing changes.
  let page = await openPill({});
  assert.equal(await page.locator("#relaysLayout").isVisible(), true, "the old rows stay without the gate");
  assert.equal(await page.locator(".ip-pager").count(), 0);
  await page.close();

  // Gate on.
  page = await openPill({ inboxPages: true });
  assert.equal(await page.locator("#relaysLayout").isVisible(), false, "the rows step aside");
  await page.locator(".ip-pager").waitFor();
  assert.equal(await page.locator('.ip-dots [data-ip-to="chats"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator(".ip-due.on").count(), 1, "the list's dot says something waits");

  // A swipe with vertical noise: every event is ours, and we land on the list.
  const blocked = await page.evaluate((seq) => window.pad(seq), swipe(1));
  assert.ok(blocked.every(Boolean), `no event leaked to scrolling (${blocked.filter((b) => !b).length} did)`);
  await page.waitForFunction(() => !document.querySelector(".ip-list").hidden && !document.querySelector(".card").classList.contains("ip-moving"));
  assert.equal(await page.locator('.ip-dots [data-ip-to="list"]').getAttribute("aria-selected"), "true");
  const forYou = await page.locator(".ip-list .row.waits").evaluateAll((els) => els.map((el) => el.dataset.ip));
  assert.deepEqual(forYou.sort(), ["relay1", "task2"], "For you holds the waiting Relay and Task, not texts or old history");
  assert.match(await page.locator(".ip-list").innerText(), /With others/);
  assert.match(await page.locator(".ip-list").innerText(), /Old and read/, "old history is in Earlier");

  // The page's name is said once, on arrival: folding and reopening the
  // card (here, on Contacts) must not replay it.
  await page.waitForFunction(() => !document.querySelector(".ip-name.show"), null, { timeout: 4000 });
  await page.evaluate(() => { setCollapsed(true); });
  await page.waitForTimeout(250);
  await page.evaluate(() => { activeView = "contacts"; commitNavigation(); setCollapsed(false); });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".ip-name")).opacity), "0", "no page name on reopen");
  assert.equal(await page.locator(".ip-pager").isVisible(), false, "no dots on Contacts");
  await page.evaluate(() => { activeView = "relays"; commitNavigation(); });
  await page.waitForFunction(() => !document.querySelector(".ip-list").hidden);

  // Ticking a Task: it leaves, and Done goes out after the undo window.
  await page.locator('.ip-list .row[data-ip="task2"]').hover();
  await page.locator('.ip-list .row[data-ip="task2"] [data-ip-tick]').click();
  await page.locator(".ip-toast.on").waitFor();
  await page.waitForFunction(() => !document.querySelector('.ip-list .row.waits[data-ip="task2"]'));
  assert.deepEqual(await page.evaluate(() => window.done), [], "not before the undo window");
  await page.waitForFunction(() => window.done.includes("task2"), null, { timeout: 8000 });

  // Back to Chats with ⌘1; open the Relay's chat: it still waits on you.
  await page.keyboard.press("Meta+1");
  await page.waitForFunction(() => !document.querySelector(".ip-chats").hidden && !document.querySelector(".card").classList.contains("ip-moving"));
  // A Relay arrives after the pages exist; its chat is opened (read)…
  await page.evaluate(() => { const f = window.fixture;
    f.relays.unshift({ ...f.relays[0], id: "fresh5", relayId: "fresh5", threadId: "thread-fresh5", title: "Fresh one", createdAt: new Date(Date.now() + 1000).toISOString(), unread: true });
    window.events.onInbox(structuredClone(f));
    f.relays[0].unread = false; window.events.onInbox(structuredClone(f)); });
  await page.keyboard.press("Meta+2");
  await page.waitForFunction(() => !document.querySelector(".ip-list").hidden && !document.querySelector(".card").classList.contains("ip-moving"));
  assert.equal(await page.locator('.ip-list .row.waits[data-ip="fresh5"]').count(), 1, "reading the chat is not dealing with the Relay");

  // …opening it in the reader is.
  await page.locator('.ip-list .row.waits[data-ip="fresh5"] .rk-subject').click();
  await page.waitForFunction(() => typeof activeView !== "undefined" && activeView === "reader");
  await page.evaluate(() => closeReader());
  await page.waitForFunction(() => !document.querySelector('.ip-list .row.waits[data-ip="fresh5"]'), null, { timeout: 5000 });

  // A diagonal that is mostly vertical never moves the page.
  await page.keyboard.press("Meta+1");
  await page.waitForFunction(() => !document.querySelector(".card").classList.contains("ip-moving"));
  const diag = await page.evaluate(() => window.pad(Array.from({ length: 12 }, () => [4, 11])));
  assert.equal(diag.filter(Boolean).length, 0, "a scroll is never held");
  assert.equal(await page.locator(".card").evaluate((el) => el.classList.contains("ip-moving")), false);
  await page.close();

  assert.deepEqual(errors, []);
  console.log("inbox-pages.browser: ok");
} finally {
  await browser.close();
}
