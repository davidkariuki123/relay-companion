// Real inbox renderer, isolated browser and in-memory IPC. No live account,
// sends or system clipboard writes. Run alongside request-inbox.browser.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const { EXAMPLES } = require("../overlay/relay-anyone-tip.cjs");
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:360,height:700}});
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    window.events = {}; window.copied = []; window.copyFails = false; window.dismissed = 0;
    Object.defineProperty(navigator, "clipboard", {value:{writeText:async (text) => {
      if (window.copyFails) throw new Error("clipboard unavailable");
      window.copied.push(text);
    }}});
    const at = new Date().toISOString();
    window.fixture = {
      account:{paired:true,userId:"self",name:"Test User",email:"self@example.test",hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false},
      relays:[{id:"stranger",threadId:"new-room",direction:"inbound",state:"read",relayNotificationKind:"plain_relay",senderName:"New sender",senderEmail:"new@example.test",title:"A request",forHuman:"Hello",createdAt:at,attachments:[]}],
      contacts:[],sent:[],requests:[],chats:[],slackChats:[],
    };
    const api = {
      isTestOverlay:true,
      refresh:async () => structuredClone(window.fixture),
      refreshSent:async () => ({items:[]}),
      contacts:async () => [], groups:async () => ({ok:true,result:[]}),
      accountInfo:async () => structuredClone(window.fixture.account), agentSurfaces:async () => ({}),
      dismiss:() => { window.dismissed++; },
    };
    window.relay = new Proxy(api, {get:(target,key) => key in target ? target[key]
      : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; }
      : async () => ({ok:true})});
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.locator(".rat-card").waitFor();
  await page.locator("#requestsEntry").waitFor();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.events.onOpenFull());
  await page.clock.runFor(500);
  const current = () => page.locator(".rat-slide.active").innerText();
  // Playwright's virtual timer advances JS; CSS/WAAPI uses the compositor's
  // clock, so wait for the finite swipe before checking the resting layout.
  const settleSwipe = () => page.locator(".rat-track").evaluate((el) =>
    Promise.all(el.getAnimations({subtree:true}).map((animation) => animation.finished.catch(() => {}))));
  assert.equal(await current(), `“${EXAMPLES[0]}”`);
  assert.equal(await page.locator(".rat-dot").count(), 5);
  assert.equal(await page.getByText("Ask for help", {exact:true}).count(), 0);
  assert.equal(await page.locator(".rat-card .rat-title").innerText(), "Relay anyone even if they aren’t on Relay");
  assert.equal(await page.locator(".rat-result").evaluate((el) => getComputedStyle(el).textDecorationLine), "underline");
  assert.ok(await page.locator("#requestsEntry").evaluate((el) => el.getBoundingClientRect().bottom <= document.querySelector(".rat-card").getBoundingClientRect().top));

  // Frequent inbox pushes must not reset or replace a card in use.
  await page.getByRole("button", {name:"Example 1 of 5",exact:true}).click();
  await page.evaluate(() => { window.originalTip = document.querySelector(".rat-card"); });
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(3000);
    await page.evaluate(() => window.events.onInbox(structuredClone(window.fixture)));
    assert.equal(await current(), `“${EXAMPLES[0]}”`);
  }
  await page.clock.runFor(1400);
  assert.equal(await current(), `“${EXAMPLES[1]}”`, "one automatic swipe after ten seconds despite polling");
  assert.equal(await page.evaluate(() => window.originalTip === document.querySelector(".rat-card")), true);
  const height = await page.locator(".rat-viewport").evaluate((el) => el.getBoundingClientRect().height);
  for (const next of [2, 3, 4, 0]) {
    await page.clock.runFor(10000);
    await settleSwipe();
    assert.equal(await current(), `“${EXAMPLES[next]}”`);
    assert.equal(await page.locator(".rat-slide:visible").count(), 1);
    assert.equal(await page.locator(".rat-viewport").evaluate((el) => el.getBoundingClientRect().height), height);
  }

  await page.getByRole("button", {name:"Pause example rotation",exact:true}).click();
  await page.clock.runFor(30000);
  assert.equal(await current(), `“${EXAMPLES[0]}”`, "Pause holds the visible example");
  await page.getByRole("button", {name:"Example 4 of 5",exact:true}).click();
  await page.clock.runFor(400);
  await page.getByRole("button", {name:"Copy example",exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.copied), [EXAMPLES[3]], "copy uses the currently visible prompt");
  await page.getByRole("button", {name:"Example 5 of 5",exact:true}).click();
  await page.clock.runFor(400);
  await page.evaluate(() => { window.copyFails = true; });
  await page.getByRole("button", {name:"Copy example",exact:true}).click();
  assert.equal(await page.locator(".rat-copy").innerText(), "Try copying again");
  await page.evaluate(() => { window.copyFails = false; });
  await page.locator(".rat-copy").click();
  assert.deepEqual(await page.evaluate(() => window.copied), [EXAMPLES[3],EXAMPLES[4]]);
  await page.getByRole("button", {name:"Example 5 of 5",exact:true}).press("ArrowRight");
  await page.clock.runFor(400);
  assert.equal(await current(), `“${EXAMPLES[0]}”`, "keyboard wraps to the first example");
  const bounds = await page.locator(".rat-viewport").boundingBox();
  await page.mouse.move(bounds.x + bounds.width - 12, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 12, bounds.y + 20, {steps:4});
  await page.mouse.up();
  await page.clock.runFor(400);
  assert.equal(await current(), `“${EXAMPLES[1]}”`, "a leftward swipe advances");

  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  assert.equal(await page.locator(".rat-summary").isVisible(), true);
  assert.equal(await page.locator(".rat-card").isVisible(), false);
  await page.evaluate(() => window.events.onInbox(structuredClone(window.fixture)));
  await page.locator("#requestsEntry").click();
  assert.equal(await page.locator("#relayAnyoneTip").isVisible(), false, "tip stays out of the Requests page");
  await page.locator("#requestsBack").click();
  assert.equal(await page.locator(".rat-summary").isVisible(), true, "navigation preserves minimisation within the open window");
  await page.locator("#closeX").click();
  await page.clock.runFor(500);
  assert.equal(await page.evaluate(() => window.dismissed), 1);
  await page.evaluate(() => { window.events.onShown(); window.events.onOpenFull(); });
  await page.clock.runFor(500);
  assert.equal(await page.locator(".rat-card").isVisible(), true, "close and reopen always expands the tip");
  assert.equal(await current(), `“${EXAMPLES[0]}”`);
  assert.equal(await page.getByRole("button", {name:"Pause example rotation",exact:true}).count(), 1);

  // No requests and thousands of requests both keep the same expanded card.
  for (const count of [0,2847]) {
    await page.evaluate((count) => {
      const base = {threadId:"new-room",direction:"inbound",state:"read",relayNotificationKind:"plain_relay",senderName:"New sender",senderEmail:"new@example.test",title:"A request",forHuman:"Hello",createdAt:new Date().toISOString(),attachments:[]};
      window.fixture.relays = Array.from({length:count},(_,i) => ({...base,id:`stranger-${i}`}));
      window.events.onInbox(structuredClone(window.fixture));
    }, count);
    assert.equal(await page.locator(".rat-card").isVisible(), true);
    assert.equal(await page.locator("#requestsEntry").count(), count ? 1 : 0);
  }
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.clock.runFor(100);
  await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  await page.getByRole("button", {name:"Example 3 of 5",exact:true}).click();
  assert.equal(await page.locator(".rat-slide:visible").count(), 1);
  assert.equal(await page.locator(".rat-track").evaluate((el) => el.getAnimations({subtree:true}).filter((animation) => animation.effect.getKeyframes().some((frame) => "transform" in frame)).length), 0, "reduced motion suppresses the swipe");
  await page.getByRole("button", {name:"Pause example rotation",exact:true}).click();
  await page.clock.resume();
  for (const width of [360,736]) {
    await page.setViewportSize({width,height:800});
    for (const theme of ["light","dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const cardBounds = await page.locator(".rat-card").boundingBox();
      for (const selector of [".rat-head", ".rat-viewport", ".rat-controls", ".rat-footer"]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= cardBounds.x && box.x + box.width <= cardBounds.x + cardBounds.width + 1, `${selector} fits at ${width} in ${theme}`);
      }
      if (process.env.RELAY_TIP_SCREENSHOTS) {
        fs.mkdirSync(process.env.RELAY_TIP_SCREENSHOTS, {recursive:true});
        await page.locator("#card").screenshot({path:`${process.env.RELAY_TIP_SCREENSHOTS}/tip-${width}-${theme}.png`,animations:"disabled"});
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: five timed examples, poll stability, pause, copy success/failure, keyboard/swipe, minimise, Requests, close/reopen, reduced motion, light/dark layout.");
} finally { await browser.close(); }
