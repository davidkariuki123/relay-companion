// The card tells main which view it is in and what caused each change
// (overlay/view-telemetry.cjs): Expand, ⌘⇧E, Minimize, a tap on the pill,
// the Dock, the ✕. One report per change, never a stray step between.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:960,height:860}, screen:{width:1512,height:982}, reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    window.views = [];
    window.fixture = {
      account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false,topics:false,fullAppExpand:true},
      contacts:[], sent:[], requests:[], chats:[], slackChats:[],
      relays:[{id:'relay-s1',threadId:'room-sven',state:'read',relayNotificationKind:'plain_relay',senderName:'Sven Wellmann',senderEmail:'sven@example.test',
        title:'',forHuman:'Shipping the share page fold tomorrow.',forAgent:'',createdAt:new Date().toISOString(),attachments:[]}],
    };
    const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>[],
      groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),setupSnapshot:async()=>({hosts:[],scannedAt:Date.now()}),
      viewState:(view, cause)=>{ window.views.push(`${view}:${cause}`); }};
    window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.waitForFunction(()=>!!window.events.onOpenFull && !!window.events.onExpandApp);
  await page.evaluate(()=>window.events.onOpenFull());
  await page.waitForTimeout(300);
  const card = page.locator('#card');
  const since = async (action) => {
    const before = await page.evaluate(() => window.views.length);
    await action();
    await page.waitForTimeout(700);
    return page.evaluate((n) => window.views.slice(n), before);
  };

  assert.deepEqual(await since(() => page.locator('#wideToggle').click()), ['wide:expand_button'], 'Expand');
  assert.deepEqual(await since(() => page.keyboard.press('Meta+Shift+KeyE')), ['card:shortcut'], 'Collapse with ⌘⇧E');
  assert.deepEqual(await since(() => page.locator('#wideToggle').click()), ['wide:expand_button']);
  // Minimize from the full app folds straight to the pill: one change, not a stop at the card.
  assert.deepEqual(await since(() => page.locator('#minimizeBtn').click()), ['pill:minimise_button'], 'Minimize from the full app');
  await page.waitForFunction(() => document.getElementById('card').classList.contains('collapsed'));
  assert.deepEqual(await since(() => page.evaluate(() => window.events.onExpandApp())), ['card:dock', 'wide:dock'], 'the Dock unfolds, then expands');
  assert.deepEqual(await since(() => page.locator('#minimizeBtn').click()), ['pill:minimise_button']);
  assert.deepEqual(await since(async () => {
    const box = await page.locator('#lockup').boundingBox();
    await page.mouse.click(box.x + 12, box.y + box.height / 2);
  }), ['card:pill_tap'], 'a tap on the pill');
  assert.deepEqual(await since(() => page.locator('#closeX').click()), ['hidden:close'], 'the ✕');
  assert.ok(await card.count());
  assert.deepEqual(errors, []);
  console.log('view telemetry: ok');
} finally {
  await browser.close();
}
