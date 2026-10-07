// The smart ways-to-use-Relay card in the real inbox renderer: an isolated
// browser and in-memory IPC, no live account. The fixed card's behaviour is
// covered by relay-anyone-tip.browser.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const { TITLE, EXAMPLES } = require("../overlay/relay-anyone-tip.cjs");
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:360,height:700}});
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    window.events = {}; window.teaching = [];
    window.fixture = {
      account:{paired:true,userId:"self",name:"Test User",email:"self@example.test",hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,slack:false,smartTips:true},
      usage:{sentWithAttachments:false,receivedWithAttachments:false,openedReceivedAttachments:false,createdShareLink:true,
        examples:{unopenedFrom:"Dylan Maltman"}},
      relays:[{id:"from-jonty",threadId:"jonty-room",direction:"inbound",state:"read",relayNotificationKind:"plain_relay",senderName:"Jonty Quenet",senderEmail:"jonty@example.test",title:"Pricing",forHuman:"Hello",createdAt:new Date().toISOString(),attachments:[]}],
      contacts:[],sent:[],requests:[],chats:[],slackChats:[],
    };
    const api = {
      isTestOverlay:true,
      refresh:async () => structuredClone(window.fixture),
      refreshSent:async () => ({items:[]}),
      contacts:async () => [], groups:async () => ({ok:true,result:[]}),
      accountInfo:async () => structuredClone(window.fixture.account), agentSurfaces:async () => ({}),
      dismiss:() => {},
      teachingEvent:(name, way) => { window.teaching.push(way ? [name, way] : [name]); },
    };
    window.relay = new Proxy(api, {get:(target,key) => key in target ? target[key]
      : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; }
      : async () => ({ok:true})});
  });
  const push = (patch) => page.evaluate((patch) => {
    Object.assign(window.fixture, patch);
    window.events.onInbox(structuredClone(window.fixture));
  }, patch);
  const title = () => page.locator(".rat-summary .rat-title").innerText();
  const wayNames = () => page.locator(".rat-slide .rat-way").allTextContents();
  const current = () => page.locator(".rat-slide.active .rat-way").innerText();

  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.locator(".rat-summary").waitFor();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.events.onOpenFull());
  await page.clock.runFor(500);

  // Someone who has made a share link is not taught to make one.
  assert.equal(await title(), "Five more ways to use Relay");
  assert.deepEqual(await wayNames(), ["Pick up where you left off", "Carry on work someone sent you", "Check what needs you", "Pull your work together", "Send files"]);
  // The examples use the person's own people: who is waiting, and who they relay with.
  const promptOf = (way) => page.locator(".rat-slide").filter({has:page.locator(".rat-way", {hasText:way})}).locator(".rat-prompt").innerText();
  assert.equal(await promptOf("Carry on work someone sent you"), "“Open the Relay from Dylan and carry on the work here.”");
  assert.equal(await promptOf("Send files"), "“Relay Jonty the files in this folder.”");
  assert.equal(await page.getByRole("button", {name:"Expand tip: Five more ways to use Relay",exact:true}).count(), 1);

  // A way used while the card is open stays until the person is done with it.
  await page.locator(".rat-summary").click();
  await page.getByRole("button", {name:"Example 2 of 5",exact:true}).click();
  await page.clock.runFor(400);
  assert.equal(await current(), "Carry on work someone sent you");
  await push({usage:{...await page.evaluate(() => window.fixture.usage), sentToSelf:true}});
  assert.equal(await current(), "Carry on work someone sent you", "the open card does not change under the person");
  assert.equal(await page.locator(".rat-slide").count(), 5);
  assert.ok((await wayNames()).includes("Pick up where you left off"));
  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  assert.ok(!(await wayNames()).includes("Pick up where you left off"), "minimising lets the used way go");
  assert.equal((await wayNames())[0], "Carry on work someone sent you");
  await page.locator(".rat-summary").click();
  assert.equal(await current(), "Carry on work someone sent you", "the example the person was on stays selected");

  // Pull your work together is shown once: on screen in the open card, then
  // gone at the next refresh, and the read is reported so it stays gone.
  assert.deepEqual(await wayNames(), ["Carry on work someone sent you", "Check what needs you", "Pull your work together", "Send files", "Ask someone a question"]);
  assert.equal(await page.evaluate(() => window.teaching.some(([name]) => name === "example_read")), false, "not read before it is on screen");
  await page.getByRole("button", {name:"Example 3 of 5",exact:true}).click();
  await page.clock.runFor(400);
  assert.equal(await current(), "Pull your work together");
  assert.deepEqual(await page.evaluate(() => window.teaching.filter(([name]) => name === "example_read")), [["example_read", "pull_together"]]);
  await page.getByRole("button", {name:"Example 4 of 5",exact:true}).click();
  assert.ok((await wayNames()).includes("Pull your work together"), "it stays while the card is open");
  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  assert.ok(!(await wayNames()).includes("Pull your work together"), "gone at the next refresh");
  await push({usage:{...await page.evaluate(() => window.fixture.usage)}});
  assert.ok(!(await wayNames()).includes("Pull your work together"), "and it does not come back before the server has heard");
  await page.locator(".rat-summary").click();

  // One way left: no dots, no rotation.
  const everything = {
    sentWithAttachments:true, receivedWithAttachments:false, openedReceivedAttachments:false,
    createdShareLink:true, sentToSelf:true, openedReceivedRelay:true, agentListedInbox:true, sendsToOthers:20,
    askedQuestion:true, sentAsks:{answer:true,feedback:true,handover:true,action:true}, sentToGroup:true, forwarded:true, sentTask:false,
  };
  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  await push({usage:everything});
  assert.equal(await title(), "One more way to use Relay");
  await page.locator(".rat-summary").click();
  assert.deepEqual(await wayNames(), ["Send a Task"]);
  assert.equal(await page.locator(".rat-controls").isVisible(), false, "a single way has no dots");
  await page.clock.runFor(25000);
  assert.equal(await current(), "Send a Task");

  // Nothing left to teach: the card goes away.
  await page.getByRole("button", {name:"Minimise tip",exact:true}).click();
  await push({usage:{...everything, sentTask:true}});
  assert.equal(await page.locator("#relayAnyoneTip").isVisible(), false, "nothing left, no card");

  // Without the developer gate the person keeps the fixed five, whatever they have done.
  await push({features:{requests:false,slack:false,smartTips:false}});
  assert.equal(await page.locator("#relayAnyoneTip").isVisible(), true);
  assert.equal(await title(), TITLE);
  assert.deepEqual(await wayNames(), EXAMPLES.map((example) => example.way));

  // The smart card's own ways report engagement like the fixed ones.
  await push({features:{requests:false,slack:false,smartTips:true}, usage:{...everything, sentTask:false, forwarded:false}});
  await page.locator(".rat-summary").click();
  await page.getByRole("button", {name:"Example 2 of 2",exact:true}).click();
  const chosen = await page.evaluate(() => window.teaching.filter(([name]) => name === "example_chosen").at(-1));
  assert.deepEqual(chosen, ["example_chosen", "send_task"]);
  assert.deepEqual(errors, []);
  console.log("PASS: smart card retires used ways, waits while open, keeps the selected example, single way without dots, hides when done, fixed five without the gate, engagement ids, own people in examples, Pull your work together shown once.");
} finally { await browser.close(); }
