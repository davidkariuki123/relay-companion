// Relay opened from its Dock icon is Expand: a folded pill unfolds and becomes
// the full app; an open card just expands; with the gate off nothing changes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  for (const gate of [true, false]) {
    const page = await browser.newPage({viewport:{width:960,height:860}, screen:{width:1512,height:982}, reducedMotion:'reduce'});
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript((fullAppExpand) => {
      window.events = {};
      window.fixture = {
        account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
        ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
        features:{requests:false,todo:false,slack:false,topics:false,fullAppExpand},
        contacts:[], sent:[], requests:[], chats:[], slackChats:[],
        relays:[{id:'relay-s1',threadId:'room-sven',state:'read',relayNotificationKind:'plain_relay',senderName:'Sven Wellmann',senderEmail:'sven@example.test',
          title:'',forHuman:'Shipping the share page fold tomorrow.',forAgent:'',createdAt:new Date().toISOString(),attachments:[]}],
      };
      const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>[],
        groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),setupSnapshot:async()=>({hosts:[],scannedAt:Date.now()})};
      window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
    }, gate);
    await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
    await page.waitForFunction(()=>!!window.events.onOpenFull && !!window.events.onExpandApp);
    await page.evaluate(()=>window.events.onOpenFull());
    await page.waitForTimeout(300);
    await page.locator('#minimizeBtn').click();
    await page.waitForFunction(() => document.getElementById('card').classList.contains('collapsed'));
    // The Dock click: main reopens and asks for the full app.
    await page.evaluate(() => { window.events.onExpandApp(); });
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => ({ collapsed, expanded: appExpanded, wide: document.getElementById('card').classList.contains('wide') }));
    if (gate) assert.deepEqual(state, { collapsed:false, expanded:true, wide:true }, 'a folded pill opens straight into the full app');
    else assert.deepEqual(state, { collapsed:true, expanded:false, wide:false }, 'with the gate off a Dock open changes nothing here');
    if (gate) {
      await page.evaluate(() => { window.events.onExpandApp(); });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => appExpanded), true, 'a second Dock click keeps the full app (never toggles it closed)');
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('dock expand: ok');
} finally {
  await browser.close();
}
