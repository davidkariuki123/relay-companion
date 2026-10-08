// DRAG TO RESIZE (ao1 feedback, 2026-10-08: "sometimes the chat box gets in the
// way. Being able to drag to resize would help"). The left edge, the bottom
// edge and the bottom-left corner resize the open card; each frame (small
// card, reader, expanded app) keeps its own size across restarts; a
// double-click goes back to the designed size; nothing resizes a folded pill.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const context = await browser.newContext({viewport:{width:960,height:860}, screen:{width:1512,height:982}, reducedMotion:'reduce'});
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    window.__resizing = [];
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    window.fixture = {
      account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false,replyThreads:true,topics:false,fullAppExpand:true},
      contacts:[], sent:[], requests:[], chats:[], slackChats:[],
      relays:[{id:'relay-s1',threadId:'room-sven',state:'read',relayNotificationKind:'plain_relay',senderName:'Sven Wellmann',senderEmail:'sven@example.test',
        title:'',forHuman:'Shipping the share page fold tomorrow.',forAgent:'',createdAt:ago(30),attachments:[]}],
    };
    const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>[],
      groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),setupSnapshot:async()=>({hosts:[],scannedAt:Date.now()}),
      cardResizing:(on)=>window.__resizing.push(on)};
    window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
  });
  const boot = async () => {
    await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
    await page.waitForFunction(()=>!!window.events.onOpenFull);
    await page.evaluate(()=>window.events.onOpenFull());
    await page.waitForTimeout(300);
  };
  await boot();
  const size = () => page.locator('#card').evaluate(el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  const drag = async (edge, dx, dy) => {
    const b = await page.locator(`.card-resize[data-resize="${edge}"]`).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + dx * i / 8, y + dy * i / 8);
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  assert.deepEqual(await size(), [344, 524], 'the small card opens at its designed size');
  await drag('s', 0, -100);
  assert.deepEqual(await size(), [344, 424], 'the bottom edge makes it shorter');
  await drag('sw', -120, 40);
  assert.deepEqual(await size(), [464, 464], 'the corner grows it away from the pinned top-right corner');
  await drag('w', 500, 0);
  assert.equal((await size())[0], 344, 'never narrower than the small card was designed');
  await drag('s', 0, -900);
  assert.equal((await size())[1], 380, 'never shorter than its minimum');
  assert.deepEqual(await page.evaluate(() => window.__resizing), [true, false, true, false, true, false, true, false],
    'main holds pointer input for exactly each drag');

  // The expanded app fills the screen and has nothing to drag; folding back
  // returns the small card at the size it was given.
  await page.locator('#wideToggle').click();
  await page.waitForFunction(() => document.getElementById('card').classList.contains('wide'));
  await page.waitForTimeout(300);
  assert.deepEqual(await size(), [1512, 982], 'the expanded app fills the screen');
  assert.deepEqual(await page.locator('.card-resize').evaluateAll(els => els.map(el => getComputedStyle(el).display)), ['none', 'none', 'none']);
  await page.locator('#wideToggle').click();
  await page.waitForFunction(() => !document.getElementById('card').classList.contains('wide'));
  await page.waitForTimeout(300);
  assert.deepEqual(await size(), [344, 380], 'back to the small card, at the size it was given');

  // Sizes outlive a restart.
  await boot();
  assert.deepEqual(await size(), [344, 380], 'the small card reopens at your size');

  // Double-click: back to the designed size, and forgotten.
  await page.locator('.card-resize[data-resize="w"]').dblclick();
  await page.waitForTimeout(400);
  assert.deepEqual(await size(), [344, 524]);
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('relayCardFrames'))), {});

  // A folded pill has nothing to grab.
  await page.locator('#minimizeBtn').click();
  await page.waitForTimeout(400);
  assert.deepEqual(await page.locator('.card-resize').evaluateAll(els => els.map(el => getComputedStyle(el).display)), ['none', 'none', 'none']);
  assert.deepEqual(errors, []);
  console.log('card resize: ok');
} finally {
  await browser.close();
}
