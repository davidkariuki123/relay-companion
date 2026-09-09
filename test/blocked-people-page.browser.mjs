// Run with RELAY_PLAYWRIGHT_MODULE pointing at an installed Playwright module.
// Uses the real renderer and in-memory IPC; never changes an installed app/account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {}) });
try {
  const page = await browser.newPage({ viewport:{width:850,height:850} });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureEvents = {};
    window.fixtureBlocks = [];
    window.fixtureWrites = [];
    window.fixtureReadMode = 'normal';
    window.fixtureUnblockMode = 'normal';
    window.fixturePayload = { account:{paired:true,userId:'usr_self',name:'Preview Person',email:'preview@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{},relays:[],sent:[],requests:[],chats:[],slackChats:[] };
    const api = {
      isTestOverlay:true,
      refresh:async()=>structuredClone(window.fixturePayload),
      refreshSent:async()=>({items:[]}),
      contacts:async()=>Array.from({length:12},(_,i)=>({id:`con_${i}`,relayUserId:i===1?undefined:`usr_${i}`,onRelay:i===1?false:true,name:`Contact ${i}`,email:`contact${i}@example.com`})),
      blockPerson:async input=>{window.fixtureWrites.push(input);return {blocked:true};},
      groups:async()=>({ok:true,result:[]}),
      accountInfo:async()=>structuredClone(window.fixturePayload.account),
      agentSurfaces:async()=>({}),
      connectionBlocks:async()=>{
        if(window.fixtureReadMode==='fail') throw Error('offline');
        if(window.fixtureReadMode==='pending') return new Promise(resolve=>{window.resolveBlocks=resolve;});
        return {blocks:structuredClone(window.fixtureBlocks)};
      },
      unblockPerson:async id=>{
        window.fixtureWrites.push(id);
        if(window.fixtureUnblockMode==='fail') throw Error('offline');
        if(window.fixtureUnblockMode==='pending') return new Promise(resolve=>{window.resolveUnblock=resolve;});
        window.fixtureBlocks=window.fixtureBlocks.filter(person=>person.relayUserId!==id);
        return {blocked:false};
      },
    };
    window.relay=new Proxy(api,{get:(target,key)=>{
      if(key in target) return target[key];
      if(String(key).startsWith('on')) return callback=>{window.fixtureEvents[key]=callback;return ()=>{};};
      return async()=>({ok:true});
    }});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.locator('.tab[data-view="contacts"]').click();
  await page.locator('#cvList .cv-person').first().waitFor();
  // Unlinked contacts have a useful Edit menu, with no impossible Block action.
  await page.locator('#cvList [data-message-more]').nth(1).click();
  assert.equal(await page.locator('#person-menu-1 [data-contact-edit]').isVisible(),true);
  assert.equal(await page.locator('#person-menu-1 [data-contact-block]').count(),0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cvList [data-message-more]').nth(1).evaluate(el=>el===document.activeElement),true);
  await page.locator('#cvList [data-message-more]').first().click();
  assert.deepEqual(await page.evaluate(()=>window.fixtureWrites),[],'opening the menu never blocks');
  await page.locator('#person-menu-0 [data-contact-block]').click();
  await page.locator('.people-dialog:popover-open').waitFor();
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert.equal(await page.locator('.people-dialog').evaluate(el=>getComputedStyle(el,'::backdrop').backgroundColor),'rgba(0, 0, 0, 0)');
  const confirmation=await page.locator('.people-dialog').boundingBox();
  const card=await page.locator('#card').boundingBox();
  assert.ok(confirmation.width<=260 && confirmation.x>=card.x && confirmation.x+confirmation.width<=card.x+card.width);
  assert.deepEqual(await page.evaluate(()=>window.fixtureWrites),[],'confirmation requires an explicit action');
  await page.locator('#card').screenshot({path:'/tmp/people-confirmation-real.png'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.people-dialog:popover-open').count(),0);
  assert.equal(await page.locator('#cvList [data-message-more]').first().evaluate(el=>el===document.activeElement),true);
  const open = () => page.locator('#cvBlockedPeople').click();
  const back = () => page.locator('#cvBlockedBack').click();
  await open();
  await page.locator('.cv-blocked-empty').waitFor();
  assert.equal(await page.locator('dialog[open]').count(),0,'Blocked people must not open a modal');
  assert.equal(await page.locator('#cvOverview').isVisible(),false);
  assert.equal(await page.locator('.tab[data-view="contacts"]').evaluate(el=>el.classList.contains('active')),true);
  assert.equal(await page.locator('#cvBlockedPage').evaluate(el=>Boolean(el.closest('#card'))),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'cvBlockedBack');
  assert.equal(await page.locator('#scroll').evaluate(el=>el.scrollTop),0);
  await page.locator('#cvBlockedPage').evaluate(async el=>{await Promise.all(el.getAnimations().map(animation=>animation.finished));});
  if(process.env.RELAY_BLOCKED_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_BLOCKED_SCREENSHOT});
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('#cvBlockedPage').isVisible(),true);
  if(process.env.RELAY_BLOCKED_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_BLOCKED_SCREENSHOT.replace('.png','-alternate-theme.png')});
  await back();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'cvBlockedPeople');
  assert.ok(await page.locator('#scroll').evaluate(el=>el.scrollTop)>0,'back restores the scrolled People list');
  await open();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cvOverview').isVisible(),true);
  await open();
  await page.locator('.tab[data-view="contacts"]').click();
  assert.equal(await page.locator('#cvOverview').isVisible(),true,'selected People tab returns home');

  await page.evaluate(()=>{window.fixtureReadMode='fail';});
  await open();
  await page.locator('[data-blocks-retry]').waitFor();
  await page.evaluate(()=>{window.fixtureReadMode='normal';window.fixtureBlocks=[{relayUserId:'usr_alex',name:'Alex Morgan'},{relayUserId:'usr_jamie',name:'Jamie Lee'}];});
  await page.locator('[data-blocks-retry]').click();
  await page.locator('[data-unblock="usr_alex"]').waitFor();
  await page.evaluate(()=>{window.fixtureUnblockMode='fail';});
  await page.locator('[data-unblock="usr_alex"]').click();
  await page.waitForFunction(()=>document.getElementById('cvBlockedError').textContent.includes('Could not unblock'));
  assert.equal(await page.locator('[data-unblock]').count(),2);
  assert.equal(await page.locator('[data-unblock]:disabled').count(),0);
  await page.evaluate(()=>{window.fixtureUnblockMode='pending';});
  await page.locator('[data-unblock="usr_alex"]').click();
  assert.equal(await page.locator('[data-unblock]:disabled').count(),2);
  await page.evaluate(()=>window.resolveUnblock({blocked:false}));
  await page.waitForFunction(()=>document.querySelectorAll('[data-unblock]').length===1);
  assert.match(await page.locator('#cvBlockedStatus').innerText(),/Alex Morgan unblocked/);
  await page.evaluate(()=>{window.fixtureUnblockMode='normal';});
  await page.locator('[data-unblock="usr_jamie"]').click();
  await page.locator('.cv-blocked-empty').waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'cvBlockedBack');
  await back();

  // A read belonging to a previous visit cannot replace a newer visit's rows.
  await page.evaluate(()=>{window.fixtureReadMode='pending';});
  await open();
  await page.waitForFunction(()=>Boolean(window.resolveBlocks));
  await back();
  await page.evaluate(()=>{window.fixtureReadMode='normal';window.fixtureBlocks=[];});
  await open();
  await page.locator('.cv-blocked-empty').waitFor();
  await page.evaluate(()=>window.resolveBlocks({blocks:[{relayUserId:'usr_stale',name:'Stale person'}]}));
  assert.equal(await page.locator('[data-unblock]').count(),0);
  await back();

  // Account changes hide/clear the page before any old result can be painted.
  await page.evaluate(()=>{window.fixtureReadMode='pending';window.resolveBlocks=null;});
  await open();
  await page.waitForFunction(()=>Boolean(window.resolveBlocks));
  await page.evaluate(()=>{window.fixturePayload.account={...window.fixturePayload.account,userId:'usr_other',email:'other@example.com'};window.fixtureEvents.onInbox(structuredClone(window.fixturePayload));});
  await page.waitForFunction(()=>document.getElementById('cvBlockedPage').classList.contains('gone'));
  await page.evaluate(()=>window.resolveBlocks({blocks:[{relayUserId:'usr_private',name:'Private person'}]}));
  assert.equal(await page.locator('#cvBlockedList').innerText(),'');

  await page.evaluate(()=>{window.fixtureReadMode='normal';});
  await page.emulateMedia({reducedMotion:'reduce'});
  await open();
  assert.equal(await page.locator('#cvBlockedPage').evaluate(el=>el.getAnimations().length),0);
  await page.locator('.tab[data-view="relays"]').click();
  await page.locator('.tab[data-view="contacts"]').click();
  assert.equal(await page.locator('#cvOverview').isVisible(),true,'leaving People resets the subpage');
  // The existing block confirmation's recovery link lands on this same page.
  await page.locator('#cvList [data-message-more]').first().click();
  await page.locator('[data-contact-block]').first().click();
  await page.locator('[data-block-confirm]').click();
  await page.locator('.people-dialog [data-blocked-list]').click();
  await page.locator('.cv-blocked-empty').waitFor();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await back();
  assert.equal(await page.locator('#cvList [data-message-more]').first().evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(errors,[]);
  console.log('Blocked People browser checks passed: containment, navigation/focus/scroll, retry, unblock, duplicate prevention, stale reads, account switch, reduced motion.');
} finally { await browser.close(); }
