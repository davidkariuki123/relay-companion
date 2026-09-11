// Exercise the actual renderer with synthetic messages and in-memory IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE
  ? { executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport:{ width:736, height:1100 }, reducedMotion:"reduce" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    window.readBatches = [];
    window.deferRead = false;
    const initial = {
      id:"relay_initial", threadId:"relay_initial", direction:"inbound", state:"read", unread:false,
      relayNotificationKind:"plain_relay", senderName:"Alex", senderEmail:"alex@example.com",
      recipientGroupId:"grp_team", recipientGroupName:"Team", title:"", forHuman:"Earlier text",
      forAgent:"", createdAt:"2026-09-11T13:00:00Z", attachments:[],
    };
    window.payloadFixture = {
      account:{ paired:true, userId:"self", name:"Test User", email:"self@example.com", hasSentRelay:true },
      ui:{ canDismiss:true, onboardingRequired:false, completedOnboardingVersion:1 },
      features:{}, relays:[initial], sent:[], requests:[], chats:[], slackChats:[], contacts:[],
    };
    window.arrive = (id, { groupId="grp_team", groupName="Team", unread=true } = {}) => {
      window.payloadFixture.relays.push({ ...initial, id, threadId:id,
        recipientGroupId:groupId, recipientGroupName:groupName, unread,
        state:unread ? "delivered" : "read", forHuman:"A new message in the conversation that is already open.",
        createdAt:new Date(Date.parse(initial.createdAt) + window.payloadFixture.relays.length * 60000).toISOString(),
      });
      window.events.onInbox(structuredClone(window.payloadFixture));
    };
    const api = {
      isTestOverlay:true,
      refresh:async () => structuredClone(window.payloadFixture), refreshSent:async () => ({ items:[] }),
      contacts:async () => [], groups:async () => ({ ok:true, result:[] }),
      accountInfo:async () => structuredClone(window.payloadFixture.account), agentSurfaces:async () => ({}),
      ackMany:async (ids) => {
        window.readBatches.push(ids);
        if (window.deferRead) return { ok:false, deferred:true };
        for (const row of window.payloadFixture.relays) if (ids.includes(row.id)) {
          row.unread = false;
          row.state = "read";
        }
        return { ok:true };
      },
    };
    window.relay = new Proxy(api, { get:(target, key) => key in target ? target[key]
      : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; }
        : async () => ({ ok:true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  // The boot card is already expanded. Enter directly without a tray open or fold/unfold.
  await page.locator('.relay-arrival[data-party="Team"]').click();
  await page.locator('[data-msg="relay_initial"]').waitFor();
  await page.evaluate(() => window.arrive("relay_arrival"));
  await page.locator('[data-msg="relay_arrival"]').waitFor();
  await page.waitForFunction(() => window.readBatches.flat().includes("relay_arrival"));
  assert.equal(await page.locator("#relaysBadge").innerText(), "0");
  assert.equal(await page.locator("#relaysBadge").isVisible(), false);
  assert.equal(await page.locator('[data-msg="relay_arrival"] .th-msg-title').evaluate((el) => getComputedStyle(el).fontWeight), "400");
  if (process.env.RELAY_TEXT_READ_SCREENSHOT) {
    await page.locator("#card").screenshot({ path:process.env.RELAY_TEXT_READ_SCREENSHOT });
  }

  // A different group stays unread even when its sender is the same person.
  await page.evaluate(() => window.arrive("relay_other", { groupId:"grp_other", groupName:"Other" }));
  assert.equal(await page.locator("#relaysBadge").innerText(), "1");
  assert.equal(await page.evaluate(() => window.readBatches.flat().includes("relay_other")), false);

  // A presence deferral must not claim success or bold the person's prose.
  await page.evaluate(() => { window.deferRead = true; window.arrive("relay_deferred"); });
  await page.waitForFunction(() => document.querySelector('[data-msg="relay_deferred"]')?.classList.contains("unread"));
  assert.equal(await page.locator('[data-msg="relay_deferred"] .th-msg-title').evaluate((el) => getComputedStyle(el).fontWeight), "400");
  assert.equal(await page.locator("#relaysBadge").innerText(), "2");
  await page.evaluate(() => { window.deferRead = false; window.events.onInbox(structuredClone(window.payloadFixture)); });
  await page.waitForFunction(() => window.payloadFixture.relays.find((row) => row.id === "relay_deferred").state === "read");
  assert.equal(await page.locator("#relaysBadge").innerText(), "1");

  await page.evaluate(() => window.__relayMotionTest.setCollapsed(true));
  await page.evaluate(() => window.arrive("relay_folded"));
  assert.equal(await page.evaluate(() => window.readBatches.flat().includes("relay_folded")), false);
  assert.deepEqual(errors, []);
  console.log("PASS: startup room entry, live arrivals, regular text weight, other-room isolation, deferred read recovery, folded pill.");
} finally {
  await browser.close();
}
