// Real renderer with in-memory IPC. No installed app or live account is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
try {
  const page = await browser.newPage({viewport:{width:700,height:800}});
  page.setDefaultTimeout(8000);
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.events={}; window.writes=[]; window.failDelete=false; window.failBlock=false;
    const at='2026-09-11T08:00:00Z';
    window.contactsFixture=[{id:'friend',name:'Friend',emails:['friend@example.com'],email:'friend@example.com',onRelay:true}];
    window.payloadFixture={account:{paired:true,userId:'self',name:'Test User',email:'self@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{todo:true,slack:true},relays:[
      ...Array.from({length:2050},(_,i)=>({id:`r${i}`,threadId:`t${i%3}`,direction:'inbound',state:'read',relayNotificationKind:'plain_relay',senderName:`Sender ${i%3}`,senderEmail:`sender${i%3}@example.com`,title:`Request ${i}`,forHuman:'Hello',forAgent:'Context',createdAt:at,attachments:[]})),
      {id:'friend-relay',threadId:'friend-thread',direction:'inbound',state:'read',relayNotificationKind:'plain_relay',senderName:'Friend',senderEmail:'friend@example.com',title:'Known conversation',forHuman:'Hello',createdAt:at,attachments:[]}
    ],sent:[],requests:[],chats:[],slackChats:[],contacts:window.contactsFixture};
    const api={isTestOverlay:true,refresh:async()=>structuredClone(window.payloadFixture),refreshSent:async()=>({items:[]}),contacts:async()=>structuredClone(window.contactsFixture),groups:async()=>({ok:true,result:[]}),accountInfo:async()=>structuredClone(window.payloadFixture.account),agentSurfaces:async()=>({}),
      deleteRelay:async id=>{window.writes.push(['delete',id]);if(window.failDelete)return {ok:false,error:'offline'};window.payloadFixture.relays=window.payloadFixture.relays.filter(r=>r.id!==id);return {ok:true};},
      blockRequest:async id=>{window.writes.push(['block',id]);if(window.failBlock)throw Error('offline');return {blocked:true};},
      contactSave:async input=>{window.writes.push(['contact',input.email]);const contact={id:input.email,name:input.name,email:input.email,emails:input.emails,onRelay:true};window.contactsFixture.push(contact);return {ok:true,contact,contacts:structuredClone(window.contactsFixture)};}
    };
    window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?callback=>{window.events[key]=callback;return ()=>{};}:async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.locator('#requestsEntry').waitFor();
  assert.equal(await page.locator('#requestsEntry').count(),1);
  assert.match(await page.locator('#requestsEntry').innerText(),/2,050/);
  assert.equal(await page.locator('#requestsEntry svg').isVisible(),true);
  assert.equal(await page.locator('#cvSegRequests').count(),0);
  assert.match(await page.locator('[data-view="contacts"]').innerText(),/Contacts/);
  await page.locator('#requestsEntry').click();
  if(process.env.RELAY_REQUESTS_SCREENSHOT) { await page.locator('.request-inbox-more').first().click(); await page.locator('#card').screenshot({path:process.env.RELAY_REQUESTS_SCREENSHOT}); await page.keyboard.press('Escape'); }
  assert.equal(await page.locator('.request-inbox-row').count(),50,'large inbox is windowed');
  await page.locator('.request-inbox-more').first().click();
  assert.equal(await page.locator('#request-menu-0').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>window.writes),[],'menu open does not mutate');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.request-inbox-more').first().evaluate(el=>el===document.activeElement),true);
  await page.evaluate(()=>window.failDelete=true);
  await page.locator('.request-inbox-more').first().click();
  await page.locator('#request-menu-0 [data-request-delete]').click();
  await page.locator('.requests-error').waitFor();
  assert.match(await page.locator('.requests-head').innerText(),/2,050/,'failed deletion keeps request');
  await page.evaluate(()=>window.failDelete=false);
  await page.locator('.request-inbox-more').first().click();
  await page.locator('#request-menu-0 [data-request-delete]').click();
  await page.waitForFunction(()=>document.querySelector('.requests-head').textContent.includes('2,049'));
  assert.equal(await page.evaluate(()=>window.payloadFixture.relays.some(r=>r.id==='friend-relay')),true);
  await page.locator('.request-inbox-more').first().click();
  await page.locator('#request-menu-0 [data-request-block]').click();
  await page.locator('.people-dialog [data-dialog-close]').click();
  assert.equal(await page.evaluate(()=>window.writes.filter(w=>w[0]==='block').length),0);
  await page.evaluate(()=>window.failBlock=true);
  await page.locator('.request-inbox-more').first().click();
  await page.locator('#request-menu-0 [data-request-block]').click();
  await page.locator('[data-request-confirm]').click();
  await page.locator('.people-dialog-error').filter({hasText:'Could not block'}).waitFor();
  await page.evaluate(()=>window.failBlock=false);
  await page.locator('[data-request-confirm]').click();
  await page.waitForFunction(()=>!document.querySelector('.people-dialog').matches(':popover-open'));
  await page.locator('.request-inbox-more').first().click();
  await page.locator('#request-menu-0 [data-request-accept]').click();
  await page.waitForFunction(()=>window.writes.some(w=>w[0]==='contact'));
  const added=await page.evaluate(()=>window.writes.find(w=>w[0]==='contact')[1]);
  await page.locator('#requestsBack').click();
  assert.ok(await page.locator('.relay-arrival').count()>1,'accepted sender moves to main inbox');
  await page.locator('[data-view="contacts"]').click();
  assert.ok((await page.locator('#cvList').innerText()).includes(added));
  await page.locator('[data-view="relays"]').click();
  await page.locator('#requestsEntry').click();
  await page.locator('#requestsDeleteAll').click();
  await page.locator('[data-request-confirm]').click();
  await page.locator('.cv-empty').filter({hasText:'No requests.'}).waitFor({timeout:30000});
  assert.equal(await page.evaluate(()=>window.payloadFixture.relays.some(r=>r.id==='friend-relay')),true);
  assert.equal(await page.evaluate(email=>window.payloadFixture.relays.some(r=>r.senderEmail===email),added),true,'bulk deletion excludes accepted sender');
  await page.locator('#requestsBack').click();
  assert.equal(await page.locator('#requestsEntry').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: compact summary, 2,050 requests, bounded rows, menus, keyboard, delete failure/success, block cancel, accept/move, bulk isolation.');
} finally {await browser.close();}
