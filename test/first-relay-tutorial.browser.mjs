// The first Relay tutorial in the REAL renderer (inbox.html) with an in-memory
// data layer: no Companion, no account, no network. It starts from the real end
// of onboarding, and the test does every click itself.
// Run from the repository root: node packages/companion/test/first-relay-tutorial.browser.mjs
// Set FRT_SHOTS=<dir> to keep a screenshot of every step.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const shots = process.env.FRT_SHOTS || "";
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
const errors = [];

async function open({ welcome = true, saved = null, reducedMotion = "no-preference", chosen = "", apps = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 344, height: 524 }, colorScheme: "dark", reducedMotion });
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(({ welcome, saved, chosen, apps }) => {
    window.events = {}; window.saved = []; window.opened = []; window.chatOpens = []; window.pickers = []; window.deliveries = [];
    const now = Date.now();
    const relays = welcome ? [{ id: "relay_welcome", threadId: "thread-welcome", direction: "inbound", state: "delivered", unread: true,
      relayNotificationKind: "plain_relay", senderName: "Relay Agent", senderEmail: "agent@sendrelays.com", title: "Welcome to Relay",
      forHuman: "Relay is connected. Messages sent to you appear here, and your AI can read and reply.\n\nNot sure when you'd use Relay? Ask your AI, \"what is Relay for?\"",
      forAgent: "## What this is\nRelay's automated welcome.\n\n## The two parts of every Relay\n- **The message for the person:** short.\n- **The document for their AI:** everything.\n\n## How to help this person\n1. **Reading a Relay.** Explain the point first.\n2. **Replying.** Show it before sending.",
      createdAt: new Date(now - 8 * 60000).toISOString(), attachments: [] }] : [];
    window.fixture = {
      account: { paired: true, userId: "self", name: "David", email: "david@example.test", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 2, onboardingVersion: 2, firstRelayId: "",
        onboardingAgent: chosen ? { host: chosen, place: chosen === "chatgpt" ? "browser" : "" } : null },
      features: { requests: false, todo: false, slack: false },
      contacts: [{ contactId: "relay-agent", name: "Relay Agent", email: "agent@sendrelays.com" }],
      relays, sent: [], requests: [], chats: [], slackChats: [],
      settings: { accountKey: "self", ...(saved ? { firstRelayTutorial: saved } : {}), ...(apps || {}) },
    };
    const api = {
      isTestOverlay: true,
      refresh: async () => structuredClone(window.fixture),
      refreshSent: async () => ({ items: [] }),
      contacts: async () => window.fixture.contacts,
      groups: async () => ({ ok: true, result: [] }),
      accountInfo: async () => window.fixture.account,
      agentSurfaces: async () => ({}),
      completeSetupTutorial: async () => ({ ok: true, version: 2 }),
      savePillSettings: async (patch) => { window.saved.push(patch); return { ok: true }; },
      openInApp: async (...args) => { window.opened.push(args); return { ok: true }; },
      openChatApp: async (key, prompt) => { window.chatOpens.push([key, prompt]); return { ok: true, via: "web" }; },
      // Claude Code and Codex installed here, with a session menu that has no earlier sessions.
      capabilities: async () => ({ "Claude Code": { available: true }, Codex: { available: true }, _claudeDesktop: { available: true }, _codexDesktop: { available: true }, _claudeCli: { available: true }, _codexCli: { available: true } }),
      sessionPicker: async (id, provider) => { window.pickers.push([id, provider]); await new Promise((r) => setTimeout(r, 250)); return { ok: true, provider, recent: [], defaultSurface: "desktop" }; },
      deliverToSession: async (id, selection) => { window.deliveries.push([id, selection]); return { ok: true }; },
    };
    window.relay = new Proxy(api, { get: (t, k) => (k in t ? t[k] : String(k).startsWith("on") ? (cb) => { window.events[k] = cb; return () => {}; } : async () => ({ ok: true })) });
  }, { welcome, saved, chosen, apps });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => !!window.events.onOpenFull);
  await page.evaluate(() => window.events.onOpenFull());
  await page.locator("#relaysLayout").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
// The end of onboarding, exactly as the pill runs it.
const finishOnboarding = (page) => page.evaluate(async () => { await finishNetworkInvitation(); });
const noteText = (page) => page.locator(".frt-note .frt-in:not(.frt-out) .frt-say").innerText();
const step = (page) => page.locator(".frt-note .frt-k").textContent();
const waitNote = (page, re) => page.waitForFunction((src) => {
  const el = document.querySelector(".frt-note .frt-in:not(.frt-out) .frt-say");
  return el && new RegExp(src).test(el.textContent) && getComputedStyle(document.querySelector(".frt-note")).opacity === "1";
}, re.source);
// The ink is drawn in and complete: the line has a path and no dash left to draw.
const inkDrawn = (page) => page.waitForFunction(() => {
  const line = document.querySelector(".frt-line"), loop = document.querySelector(".frt-loop");
  return line && loop && line.getAttribute("d") && getComputedStyle(line).opacity === "1" && !line.style.strokeDasharray && !loop.style.strokeDasharray;
});
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
// Where the ink's arrow ends, against the target's rect.
const arrowTouches = (page, selector) => page.evaluate((selector) => {
  const line = document.querySelector(".frt-line"), card = document.getElementById("card").getBoundingClientRect();
  const nums = line.getAttribute("d").match(/-?\d+(\.\d+)?/g).map(Number);
  const end = { x: nums[6] + card.left, y: nums[7] + card.top };
  const r = document.querySelector(selector).getBoundingClientRect();
  return end.x >= r.left - 30 && end.x <= r.right + 30 && end.y >= r.top - 30 && end.y <= r.bottom + 30;
}, selector);

// Steps 1–5 by hand, quickly (scenario 1 checks each of them closely).
async function throughBoth(page) {
  await finishOnboarding(page);
  await waitNote(page, /Start here/);
  await page.locator('#relaysList .relay-row[data-opening-id="relay_welcome"] .th-title').click();
  await waitNote(page, /This card is/);
  await page.setViewportSize({ width: 720, height: 760 });
  await page.locator('#thHistory .th-msg[data-msg="relay_welcome"] .th-msg-title').click();
  await waitNote(page, /This part is for you\. Just the short version/);
  for (const next of [/You never have/, /Now open the part/]) {
    await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
    await waitNote(page, next);
  }
  await page.locator("#readerBody .rd-details-head").click();
  await waitNote(page, /This part is for your AI: all the detail/);
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /Your AI reads both parts/);
}
const inkRetracted = async (page) => {
  const ink = await page.evaluate(() => ({ line: getComputedStyle(document.querySelector(".frt-line")).opacity, loop: getComputedStyle(document.querySelector(".frt-loop")).opacity }));
  return Number(ink.line) < 0.3 && Number(ink.loop) < 0.3;
};

try {
  // 1 · The whole tutorial, every click by hand, opening in ChatGPT (chosen at onboarding).
  let page = await open({ chosen: "chatgpt" });
  await finishOnboarding(page);
  assert.equal(await page.evaluate(() => activeView), "relays", "onboarding ends on the Inbox");
  await waitNote(page, /Start here/);
  await inkDrawn(page);
  assert.equal(await step(page), "Step 1 of 7");
  assert.ok(await arrowTouches(page, '#relaysList .relay-row[data-opening-id="relay_welcome"]'), "the ink points at Relay Agent's row");
  await shot(page, "1-inbox");
  // A wrong click nudges and changes nothing.
  await page.locator('[data-inbox-type="tasks"]').click();
  assert.equal(await page.locator('[data-inbox-type="chats"]').getAttribute("aria-pressed"), "true", "the Tasks tab did not take the click");
  assert.equal(await step(page), "Step 1 of 7");
  // The right click goes through to the pill; the ink pulls back at once.
  await page.locator('#relaysList .relay-row[data-opening-id="relay_welcome"] .th-title').click();
  await page.waitForTimeout(170);
  const midPush = await page.evaluate(() => ({ line: getComputedStyle(document.querySelector(".frt-line")).opacity, loop: getComputedStyle(document.querySelector(".frt-loop")).opacity }));
  assert.ok(Number(midPush.line) < 0.3 && Number(midPush.loop) < 0.3, `no ink while the screen moves: ${JSON.stringify(midPush)}`);
  await waitNote(page, /This card is/);
  await inkDrawn(page);
  assert.equal(await page.evaluate(() => activeView), "threads");
  assert.ok(await arrowTouches(page, '#thHistory .th-msg[data-msg="relay_welcome"]'), "the ink points at the welcome Relay's card");
  await shot(page, "2-chat");
  // The card's own buttons are not "open the Relay".
  await page.locator('#thHistory .th-msg[data-msg="relay_welcome"] .th-host-copy').click().catch(() => {});
  assert.equal(await page.evaluate(() => activeView), "threads");
  // Electron grows the native window for the reader.
  await page.setViewportSize({ width: 720, height: 760 });
  await page.locator('#thHistory .th-msg[data-msg="relay_welcome"] .th-msg-title').click();
  await waitNote(page, /This part is for you\. Just the short version/);
  await inkDrawn(page);
  assert.equal(await page.evaluate(() => activeView), "reader");
  assert.ok(await arrowTouches(page, "#readerBody .rd-headline"), "the ink points at the part for you");
  await shot(page, "3-you");
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /You never have to wade through AI slop/);
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /Now open the part for your AI/);
  assert.equal(await step(page), "Step 4 of 7");
  await page.waitForTimeout(1000);
  assert.ok(await arrowTouches(page, "#readerBody .rd-details"), "the ink slid to For your agent");
  await shot(page, "4-agent");
  // Clicking the words instead of the disclosure nudges.
  await page.locator("#readerBody .rd-headline").click();
  assert.equal(await page.locator("#readerBody .rd-details.open").count(), 0);
  await page.locator("#readerBody .rd-details-head").click();
  await waitNote(page, /This part is for your AI: all the detail and context/);
  assert.equal(await page.locator("#readerBody .rd-details.open").count(), 1, "the real disclosure opened");
  await page.waitForTimeout(1200);
  assert.ok(await arrowTouches(page, "#readerBody .rd-details"), "the ink tracked the agent part through the scroll");
  await shot(page, "5-ai");
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /Your AI reads both parts\. You only need the top one\./);
  assert.equal(await step(page), "Step 5 of 7");
  await page.waitForTimeout(1200);
  const both = await page.evaluate(() => {
    const loop = document.querySelector(".frt-loop").getBBox(), card = document.getElementById("card").getBoundingClientRect();
    const h = document.querySelector("#readerBody .rd-headline").getBoundingClientRect(), d = document.querySelector("#readerBody .rd-details").getBoundingClientRect();
    const top = loop.y + card.top, bottom = loop.y + loop.height + card.top;
    return { coversHuman: top <= h.top, coversAgent: bottom >= d.top + 20 };
  });
  assert.deepEqual(both, { coversHuman: true, coversAgent: true }, "one loop around both parts");
  await shot(page, "6-both");
  assert.equal(await page.evaluate(() => window.chatOpens.length + window.opened.length), 0, "nothing was opened in another app on the way");
  // 6 · Open it in the AI they chose: ChatGPT, a browser host.
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /Open it in ChatGPT\. Your AI gets both parts, ready to go\./);
  await page.waitForTimeout(1100); // the ink slides to the tile and the note rises to the top
  assert.equal(await step(page), "Step 6 of 7");
  await inkDrawn(page);
  assert.ok(await arrowTouches(page, '#readerBody .rd-host-actions .th-host-tile[data-host="chatgpt"]'), "the ink points at Open in ChatGPT");
  assert.ok(await page.evaluate(() => document.querySelector(".frt-note").getBoundingClientRect().bottom < document.querySelector("#readerBody .rd-host-actions").getBoundingClientRect().top),
    "the note moved up, clear of the Open in row");
  // Another app's tile is not this step.
  await page.locator('#readerBody .rd-host-actions .th-host-tile[data-host="claude-app"]').click();
  assert.equal(await page.evaluate(() => window.chatOpens.length), 0);
  await page.locator('#readerBody .rd-host-actions .th-host-tile[data-host="chatgpt"]').click();
  await waitNote(page, /Well done\. It’s opening in your ChatGPT now\./);
  assert.deepEqual(await page.evaluate(() => window.chatOpens.map(([key]) => key)), ["chatgpt"], "the click did what it does today");
  await page.waitForTimeout(200);
  assert.ok(await inkRetracted(page), "no ink once it is opening outside the pill");
  assert.equal(await step(page), "Step 7 of 7");
  await waitNote(page, /That’s the tutorial\. You’re all set\./);
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="done"]').click();
  await page.waitForFunction(() => !document.querySelector(".frt-layer"));
  assert.deepEqual(await page.evaluate(() => window.saved), [{ firstRelayTutorial: "done" }]);
  await page.close();

  // 1b · Codex: Open in Codex opens its task menu (a transition: the ink pulls
  // back), then New Codex task, then it opens in Codex.
  page = await open({ chosen: "codex", apps: { agentApps: ["Claude Code", "Codex"] } });
  await throughBoth(page);
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="next"]').click();
  await waitNote(page, /Open it in Codex\. Your AI gets both parts, ready to go\./);
  await page.waitForTimeout(1100); // the ink slides to the tile and the note rises to the top
  await inkDrawn(page);
  assert.ok(await arrowTouches(page, '#readerBody .rd-host-actions .th-host-tile[data-host="codex"]'), "the ink points at Open in Codex");
  await shot(page, "7-openin");
  await page.locator('#readerBody .rd-host-actions .th-host-tile[data-host="codex"]').click();
  await page.waitForTimeout(170);
  assert.ok(await inkRetracted(page), "the ink pulls back while the menu opens");
  await waitNote(page, /Pick New Codex task to start fresh\./);
  await inkDrawn(page);
  assert.deepEqual(await page.evaluate(() => window.pickers), [["relay_welcome", "codex"]]);
  assert.ok(await arrowTouches(page, "#readerBody .sp-list.open [data-sp-new]"), "the ink points at New Codex task");
  assert.equal(await step(page), "Step 6 of 7");
  await shot(page, "8-menu");
  await page.locator("#readerBody .sp-list.open [data-sp-new]").click();
  await waitNote(page, /Well done\. It’s opening in your Codex now\./);
  assert.deepEqual(await page.evaluate(() => window.deliveries.map(([id, s]) => [id, s.provider, s.mode])), [["relay_welcome", "codex", "new"]], "it opens in Codex as today");
  await waitNote(page, /That’s the tutorial\. You’re all set\./);
  await page.waitForTimeout(700);
  await shot(page, "9-done");
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="done"]').click();
  await page.waitForFunction(() => !document.querySelector(".frt-layer"));
  assert.deepEqual(await page.evaluate(() => window.saved), [{ firstRelayTutorial: "done" }]);
  await page.close();

  // 1c · No app to open in (every Open in switched off): it ends at both parts.
  page = await open({ chosen: "codex", apps: { chatApps: [], agentApps: [] } });
  await throughBoth(page);
  assert.equal(await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="done"]').count(), 1, "Done, not Next");
  assert.equal(await step(page), "Step 5 of 5");
  await page.locator('.frt-note .frt-in:not(.frt-out) [data-frt="done"]').click();
  await page.waitForFunction(() => !document.querySelector(".frt-layer"));
  assert.deepEqual(await page.evaluate(() => window.saved), [{ firstRelayTutorial: "done" }]);
  await page.close();

  // 2 · Escape skips, and Skip is saved.
  page = await open();
  await finishOnboarding(page);
  await waitNote(page, /Start here/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".frt-layer"));
  assert.deepEqual(await page.evaluate(() => window.saved), [{ firstRelayTutorial: "skipped" }]);
  await page.close();

  // 3 · The note's Skip mid-way.
  page = await open();
  await finishOnboarding(page);
  await waitNote(page, /Start here/);
  await page.locator('#relaysList .relay-row[data-opening-id="relay_welcome"] .th-title').click();
  await waitNote(page, /This card is/);
  await page.locator('.frt-note [data-frt="skip"]').click();
  await page.waitForFunction(() => !document.querySelector(".frt-layer"));
  assert.deepEqual(await page.evaluate(() => window.saved), [{ firstRelayTutorial: "skipped" }]);
  await page.close();

  // 4 · No welcome Relay: no tutorial. Already done: no tutorial.
  for (const options of [{ welcome: false }, { saved: "done" }, { saved: "skipped" }]) {
    page = await open(options);
    await finishOnboarding(page);
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".frt-layer").count(), 0, JSON.stringify(options));
    assert.deepEqual(await page.evaluate(() => window.saved), []);
    await page.close();
  }

  // 5 · Reduced motion: the outline and the note appear in place, complete.
  page = await open({ reducedMotion: "reduce" });
  await finishOnboarding(page);
  await page.locator(".frt-note").waitFor();
  await page.waitForFunction(() => document.querySelector(".frt-loop")?.getAttribute("d"));
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".frt-note")).opacity === "1");
  // (The pill's own reduced-motion rule makes every style change a 1 ms transition; those are not motion.)
  const still = await page.evaluate(() => ({
    note: getComputedStyle(document.querySelector(".frt-note")).opacity,
    dash: document.querySelector(".frt-line").style.strokeDasharray,
    animations: document.querySelector(".frt-layer").getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition)).length,
  }));
  assert.deepEqual(still, { note: "1", dash: "", animations: 0 });
  await shot(page, "10-reduced");
  await page.close();

  assert.deepEqual(errors, []);
  console.log("PASS: first Relay tutorial: starts at the end of onboarding on the Inbox; real clicks advance through chat, reader, both parts; wrong clicks nudge; ink retracts across screens and tracks within one; Open in ChatGPT and in Codex via New Codex task (ink retracts as the menu opens); ends at both parts with no app; Done/Escape/Skip saved; no welcome or already done → nothing; reduced motion is static.");
} finally {
  await browser.close();
}
