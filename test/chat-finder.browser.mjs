// Exercise the real inbox with isolated in-memory IPC and no live account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:360,height:700}});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    const names = [...Array.from({length:65}, (_, i) => `Person ${i}`), 'Jordan Nel', 'Granular'];
    window.fixture = {
      account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false},
      contacts:names.map((name,i) => ({contactId:`contact-${i}`,name,email:`person${i}@example.test`})),
      relays:names.map((name,i) => ({id:`relay-${i}`,threadId:`room-${i}`,direction:'inbound',state:'read',relayNotificationKind:'plain_relay',senderName:name,senderEmail:`person${i}@example.test`,...(name==='Granular'?{recipientGroupId:'grp_granular',recipientGroupName:'Granular'}:{}),title:'Hello',forHuman:'Hello',createdAt:new Date(Date.now()-i*60000).toISOString(),attachments:[]})),
      sent:[],requests:[],chats:[],slackChats:[],
    };
    const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>window.fixture.contacts,groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({})};
    window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.waitForFunction(()=>!!window.events.onOpenFull);
  await page.evaluate(()=>window.events.onOpenFull());
  const trigger=page.getByRole('button',{name:'Find a chat',exact:true});
  await trigger.waitFor({state:'visible'});
  assert.equal(await page.locator('#relaysList [data-party="Jordan Nel"]').count(),0,'Jordan starts beyond the render window');
  await trigger.click();
  const input=page.getByRole('searchbox',{name:'Search chats'});
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.getByRole('button',{name:'Clear search',exact:true}).isVisible(),false);
  await input.fill('  jOrDaN  ');
  assert.equal(await page.locator('.chat-finder-result').count(),1);
  assert.equal(await page.locator('#chatFinderStatus').innerText(),'1 chat');
  assert.match(await page.locator('.chat-finder-result').innerText(),/Jordan Nel/);
  await page.evaluate(()=>window.events.onInbox(structuredClone(window.fixture)));
  assert.equal(await input.inputValue(),'  jOrDaN  ');
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  await input.fill('no such chat');
  assert.match(await page.locator('#chatFinderResults').innerText(),/No chats found/);
  await page.getByRole('button',{name:'Clear search',exact:true}).click();
  assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('.chat-finder-result').count(),67);
  assert.equal(await page.locator('#scroll').evaluate(el=>getComputedStyle(el).overflowY),'hidden','the covered inbox does not keep a second scrollbar');
  assert.equal(await page.locator('#chatFinderResults').evaluate(el=>getComputedStyle(el).overflowX),'hidden','finder results never scroll sideways');
  await page.screenshot({path:'/tmp/relay-chat-finder.png'});
  await input.fill('Granular');
  assert.equal(await page.locator('.chat-finder-result').count(),1,'groups are searchable');
  await input.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#scroll').evaluate(el=>getComputedStyle(el).overflowY),'auto','closing search restores inbox scrolling');
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  await trigger.click();
  await page.locator('[data-view="relays"]').click();
  assert.equal(await page.locator('#chatFinder').evaluate(el=>el.matches(':popover-open')),false,'outside click dismisses search');
  await trigger.click();
  assert.equal(await input.inputValue(),'');
  await input.fill('jordan');
  await input.press('ArrowDown');
  assert.equal(await page.locator('.chat-finder-result').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  // Verify the popover stays inside the native card at narrow and wide sizes in both themes.
  for(const width of [320,360,736]) {
    await page.setViewportSize({width,height:700});
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.waitForTimeout(150);
      assert.ok(await page.locator('#chatFinder').evaluate(el=>{
        const a=el.getBoundingClientRect(),b=document.getElementById('card').getBoundingClientRect();
        return a.left>=b.left && a.right<=b.right+1 && a.bottom<=b.bottom+1 && el.scrollWidth<=el.clientWidth;
      }),`finder fits at ${width}px in ${theme}`);
    }
  }
  await page.setViewportSize({width:360,height:700});
  await input.press('Enter');
  await page.waitForFunction(()=>!document.getElementById('threadsView').classList.contains('hidden'));
  assert.equal(await page.locator('#chatFinder').evaluate(el=>el.matches(':popover-open')),false);
  assert.match(await page.locator('#threadsView').innerText(),/Jordan Nel/);
  await page.locator('[data-view="relays"]').click();
  await trigger.click();
  await input.fill('jordan');
  await page.evaluate(()=>{
    window.fixture.account={...window.fixture.account,userId:'other',email:'other@example.test'};
    window.fixture.relays=[];window.fixture.contacts=[];
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await page.locator('#chatFinder').evaluate(el=>el.matches(':popover-open')),false,'account changes dismiss search');
  assert.equal(await page.locator('#chatFinderResults').innerText(),'');
  assert.deepEqual(errors,[]);
  console.log('Chat finder: search, render-window coverage, updates, empty state, keyboard, layout, open and account reset passed.');
} finally { await browser.close(); }
