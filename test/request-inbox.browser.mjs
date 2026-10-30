// Real renderer with in-memory IPC. No installed app or live account is used.
// A NEW SENDER IS IN THE INBOX, LOCKED (Shane, 2026-10-28): no Requests page.
// Their row shows who and what kind of thing they sent, counts as unread, and
// opens only through Add contact; Delete and Block sit under ⋯.
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
    const at=(minutes)=>new Date(Date.now()-minutes*60000).toISOString();
    const relay=(id,sender,extra={})=>({id,threadId:`t-${sender}`,direction:'inbound',state:'delivered',unread:true,relayNotificationKind:'plain_relay',
      senderName:`Sender ${sender}`,senderEmail:`sender${sender}@example.com`,title:`Secret title ${id}`,forHuman:`Secret body ${id}`,forAgent:'Context',createdAt:at(1),attachments:[],...extra});
    window.contactsFixture=[{id:'friend',name:'Friend',emails:['friend@example.com'],email:'friend@example.com',onRelay:true},
      // Delivery records the sender; that is not the person adding them.
      {id:'inbound-0',name:'Sender 0',email:'sender0@example.com',emails:['sender0@example.com'],onRelay:true,source:'inbound'}];
    window.payloadFixture={account:{paired:true,userId:'self',name:'Test User',email:'self@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{todo:true,slack:true},relays:[
      relay('relay_a1','0',{createdAt:at(3)}),relay('relay_a2','0',{createdAt:at(2)}),
      relay('relay_b1','1'),
      relay('relay_c1','2',{forAgent:'',state:'read',unread:false}),
      {id:'relay_f1',threadId:'friend-thread',direction:'inbound',state:'delivered',unread:true,relayNotificationKind:'plain_relay',senderName:'Friend',senderEmail:'friend@example.com',title:'Known conversation',forHuman:'Hello friend',createdAt:at(10),attachments:[]}
    ],sent:[],requests:[],chats:[],slackChats:[],contacts:window.contactsFixture};
    const api={isTestOverlay:true,refresh:async()=>structuredClone(window.payloadFixture),refreshSent:async()=>({items:[]}),contacts:async()=>structuredClone(window.contactsFixture),groups:async()=>({ok:true,result:[]}),accountInfo:async()=>structuredClone(window.payloadFixture.account),agentSurfaces:async()=>({}),
      deleteRelay:async id=>{window.writes.push(['delete',id]);if(window.failDelete)return {ok:false,error:'offline'};window.payloadFixture.relays=window.payloadFixture.relays.filter(r=>r.id!==id);return {ok:true};},
      blockRequest:async id=>{window.writes.push(['block',id]);if(window.failBlock)throw Error('offline');return {blocked:true};},
      contactSave:async input=>{window.writes.push(['contact',input.email]);const contact={id:input.email,name:input.name,email:input.email,emails:input.emails,onRelay:true,source:'manual'};window.contactsFixture=window.contactsFixture.filter(c=>c.email!==input.email);window.contactsFixture.push(contact);return {ok:true,contact,contacts:structuredClone(window.contactsFixture)};}
    };
    window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?callback=>{window.events[key]=callback;return ()=>{};}:async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.waitForFunction(()=>!!window.events.onOpenFull);
  await page.evaluate(()=>window.events.onOpenFull());
  const lockedRow=(n)=>page.locator(`.request-row[data-request-room="sender${n}@example.com"]`);
  await lockedRow(0).waitFor();

  // No Requests page anywhere; the senders sit in the list beside Friend.
  assert.equal(await page.locator('#requestsEntry, .requests-head, .request-inbox-row').count(),0);
  assert.equal(await page.locator('#relaysList .request-row').count(),3);
  assert.equal(await page.locator('#relaysList .relay-arrival[data-party="Friend"]').count(),1);
  // Who and what kind, never the words.
  const listText=await page.locator('#relaysList').innerText();
  assert.doesNotMatch(listText,/Secret/,'no title or body of a locked sender renders');
  assert.match(await lockedRow(0).innerText(),/sender0@example\.com · not in your contacts/);
  assert.match(await lockedRow(0).innerText(),/Sent you 2 relays/);
  assert.match(await lockedRow(1).innerText(),/Sent you a relay/);
  assert.match(await lockedRow(2).innerText(),/Sent you a message/);
  // Counted like any arrival: two from sender 0, one from sender 1, Friend's one.
  await page.waitForFunction(()=>document.getElementById('relaysBadge').textContent.trim()==='4');

  // Tapping the row says what opens it; it does not open the conversation.
  await lockedRow(0).locator('.request-sent').click();
  assert.match(await lockedRow(0).locator('.request-hint').innerText(),/add them to read it/);
  assert.equal(await page.evaluate(()=>activeView),'relays');
  // Opening it any other way lands back on the locked row.
  await page.evaluate(()=>openThreadDetail('t-0','Sender 0'));
  assert.equal(await page.evaluate(()=>activeView),'relays');
  await page.evaluate(()=>openReader('relay_a1','relays'));
  assert.equal(await page.evaluate(()=>activeView),'relays');

  // ⋯ opens Delete and Block without writing anything.
  await lockedRow(2).locator('[data-message-more]').click();
  assert.equal(await lockedRow(2).locator('[role="menu"]').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>window.writes),[],'menu open does not mutate');
  await page.keyboard.press('Escape');
  // Delete: a failure keeps the row and says so; then it goes.
  await page.evaluate(()=>window.failDelete=true);
  await lockedRow(2).locator('[data-message-more]').click();
  await lockedRow(2).locator('[data-request-delete]').click();
  await lockedRow(2).locator('.request-error').waitFor();
  await page.evaluate(()=>window.failDelete=false);
  await lockedRow(2).locator('[data-message-more]').click();
  await lockedRow(2).locator('[data-request-delete]').click();
  await lockedRow(2).waitFor({state:'detached'});
  // Block: cancel writes nothing, a failure says so, success removes the row and its count.
  await lockedRow(1).locator('[data-message-more]').click();
  await lockedRow(1).locator('[data-request-block]').click();
  await page.locator('.people-dialog [data-dialog-close]').click();
  assert.equal(await page.evaluate(()=>window.writes.filter(w=>w[0]==='block').length),0);
  await page.evaluate(()=>window.failBlock=true);
  await lockedRow(1).locator('[data-message-more]').click();
  await lockedRow(1).locator('[data-request-block]').click();
  await page.locator('[data-request-confirm]').click();
  await page.locator('.people-dialog-error').filter({hasText:'Could not block'}).waitFor();
  await page.evaluate(()=>window.failBlock=false);
  await page.locator('[data-request-confirm]').click();
  await lockedRow(1).waitFor({state:'detached'});
  await page.waitForFunction(()=>document.getElementById('relaysBadge').textContent.trim()==='3');

  // Add contact saves them and opens the conversation, words and all.
  await lockedRow(0).locator('[data-request-add]').click();
  await page.waitForFunction(()=>window.writes.some(w=>w[0]==='contact'&&w[1]==='sender0@example.com'));
  await page.waitForFunction(()=>activeView==='threads');
  await page.waitForFunction(()=>[...document.querySelectorAll('body *')].some(el=>el.children.length===0&&el.checkVisibility()&&/Secret (title|body) relay_a2/.test(el.textContent)),null,{timeout:8000});
  await page.locator('[data-view="relays"]').click();
  assert.equal(await page.locator('#relaysList .request-row').count(),0,'an added sender is an ordinary conversation');
  assert.equal(await page.locator('#relaysList .relay-arrival[data-party="Sender 0"]').count(),1);

  // A new sender's arrival banners like any relay, locked, and Add contact
  // from the banner brings the pill up on their conversation.
  await page.evaluate(()=>foldToPill());
  await page.waitForFunction(()=>collapsed);
  await page.evaluate(()=>{const r={id:'relay_n1',threadId:'t-new',direction:'inbound',state:'delivered',unread:true,relayNotificationKind:'plain_relay',senderName:'Thandi Nkosi',senderEmail:'thandi@example.com',title:'Secret new title',forHuman:'Secret new body',forAgent:'Context',createdAt:new Date().toISOString(),attachments:[]};
    window.payloadFixture.relays.push(r);window.events.onInbox(structuredClone(window.payloadFixture));window.events.onNewRelay([r],{sequential:true});});
  const banner=page.locator('.request-row[data-request-room="thandi@example.com"]');
  await banner.waitFor();
  assert.equal(await page.evaluate(()=>peeking),true);
  assert.doesNotMatch(await banner.innerText(),/Secret/);
  assert.equal(await banner.locator('.qr-banner, [data-banner-copy], [data-banner-open]').count(),0,'no reply box or agent verbs for a locked sender');
  await banner.locator('[data-request-add]').click();
  await page.waitForFunction(()=>window.writes.some(w=>w[0]==='contact'&&w[1]==='thandi@example.com'));
  await page.waitForFunction(()=>activeView==='threads'&&!peeking);
  assert.deepEqual(errors,[]);
  console.log('PASS: locked rows in the list, no words, unread count, nudge, open guards, menu, delete failure/success, block cancel/failure/success, Add contact opens the conversation, from the list and the banner.');
} finally {await browser.close();}
