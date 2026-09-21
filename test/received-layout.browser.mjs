// Real renderer with isolated in-memory IPC; no live account or messages.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:360,height:700}});
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {}; window.deleted = []; window.readIds = [];
    const item = (id, extra={}) => ({id,threadId:`thread-${id}`,direction:'inbound',state:'delivered',unread:true,
      relayNotificationKind:'plain_relay',senderName:'Sven',senderEmail:'sven@example.test',title:`Title ${id}`,
      forHuman:`Human body ${id}`,forAgent:`Agent context ${id}`,createdAt:new Date(Date.now()-Number(id.replace(/\D/g,'')||0)*60000).toISOString(),attachments:[],...extra});
    window.fixture = {
      account:{paired:true,userId:'self',name:'David Kariuki',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false},
      contacts:[{contactId:'sven',name:'Sven',email:'sven@example.test'}],
      relays:[item('relay1'),item('task2',{relayNotificationKind:'task'}),item('legacy3',{relayNotificationKind:'task_request'}),
        item('text4',{forAgent:''}),item('deleted5',{deletedAt:new Date().toISOString()}),
        item('self6',{senderEmail:'self@example.test',senderName:'David Kariuki'}),
        item('stranger7',{senderEmail:'new@example.test',senderName:'New sender'}),
        item('group8',{senderEmail:'group-member@example.test',senderName:'Group member',recipientGroupId:'grp_team',recipientGroupName:'Team'}),
        ...Array.from({length:30},(_,i)=>item(`older${i+10}`))],
      sent:[{relayId:'sent',title:'Sent only',forHuman:'My letter',forAgent:'Context',recipient:{name:'Sven',email:'sven@example.test'},createdAt:new Date().toISOString()}],
      requests:[],chats:[],slackChats:[],
    };
    const api={isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:window.fixture.sent}),
      contacts:async()=>window.fixture.contacts,groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),
      deleteRelay:async id=>{window.deleted.push(id);return {ok:true};},
      markRead:async id=>{window.readIds.push(id);return {ok:true};}};
    window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?callback=>{window.events[key]=callback;return()=>{};}:async()=>({ok:true})});
  });
  const open = async()=>{
    await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
    await page.waitForFunction(()=>!!window.events.onOpenFull);
    await page.evaluate(()=>window.events.onOpenFull());
    await page.locator('#relaysLayout').waitFor({state:'visible'});
  };
  const received=page.locator('[data-inbox-direction="received"]');
  const chats=page.locator('[data-inbox-type="chats"]');
  await open();
  assert.equal(await chats.getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Expand tip: Five ways to use Relay',exact:true}).click();
  await page.getByRole('button',{name:'Example 2 of 5',exact:true}).click();
  await page.locator('[data-inbox-type="relays"]').click();
  await received.click();
  assert.equal(await received.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.rat-card').isVisible(),true);
  assert.match(await page.locator('.rat-slide.active').innerText(),/Pick up where you left off/);
  assert.equal(await page.locator('#requestsEntry .requests-count').innerText(),'1');
  const ids=await page.locator('#relaysList .row').evaluateAll(els=>els.map(el=>el.dataset.id));
  assert.deepEqual(ids.slice(0,4),['relay1','group8','older10','older11']);
  for(const omitted of ['text4','deleted5','self6','stranger7','sent']) assert.ok(!ids.includes(omitted),omitted);
  assert.equal(ids.length,25,'first render window');
  assert.equal(await page.evaluate(()=>{
    const row=document.querySelector('#relaysList .row');
    row.focus();
    window.events.onInbox(structuredClone(window.fixture));
    return row===document.querySelector('#relaysList .row') && document.activeElement===row;
  }),true,'unchanged polling preserves rows and keyboard focus');
  await page.locator('[data-inbox-type="tasks"]').click();
  assert.equal(await page.locator('[data-id="task2"] .kchip').innerText(),'Task');
  assert.equal(await page.locator('[data-id="legacy3"] .kchip').innerText(),'Task');
  assert.equal(await page.locator('[data-id="task2"] .rk-subject').innerText(),'Title task2');
  await page.locator('[data-inbox-type="relays"]').click();
  const groupBadge=page.locator('[data-id="group8"] .rk-recipient-group');
  assert.equal(await groupBadge.innerText(),'Team');
  assert.equal(await groupBadge.getAttribute('aria-label'),'Sent to group: Team');
  assert.equal(await page.locator('[data-id="relay1"] .rk-recipient-group').count(),0);
  assert.equal(await page.locator('[data-id="relay1"] .rk-subject').evaluate(el=>getComputedStyle(el).cursor),'pointer');
  await page.evaluate(()=>{
    window.fixture.relays.find(r=>r.id==='group8').recipientGroupName='Granular <Design & Product> with a very long group name';
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await groupBadge.innerText(),'Granular <Design & Product> with a very long group name');
  assert.equal(await groupBadge.locator('svg').count(),1);
  assert.equal(await groupBadge.evaluate(el=>el.getBoundingClientRect().width<=100),true);
  assert.deepEqual(await page.evaluate(()=>window.readIds),[],'listing does not read items');
  await page.locator('#requestsEntry').click();
  assert.equal(await page.locator('#relaysLayout').isVisible(),false);
  assert.equal(await page.locator('.request-inbox-row').count(),1);
  await page.getByRole('button',{name:'Back to Relays',exact:true}).click();
  assert.equal(await received.getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Minimise tip',exact:true}).click();
  await page.locator('#scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>document.querySelectorAll('#relaysList .row').length===32);
  await page.locator('#scroll').evaluate(el=>el.scrollTop=0);
  // Electron grows the native window for the existing wide reader.
  await page.setViewportSize({width:900,height:900});
  await groupBadge.click();
  await page.locator('#readerView').waitFor({state:'visible'});
  assert.match(await page.locator('#readerView').innerText(),/Human body group8/);
  await page.locator('#readerBack').click();
  await page.locator('#relaysLayout').waitFor({state:'visible'});
  await page.locator('[data-inbox-type="tasks"]').click();
  await page.locator('[data-id="task2"]').press('Enter');
  await page.locator('#readerView').waitFor({state:'visible'});
  assert.match(await page.locator('#readerView').innerText(),/Human body task2/);
  assert.equal(await page.locator('#relaysLayout').isVisible(),false);
  await page.locator('#readerBack').click();
  await page.locator('#relaysLayout').waitFor({state:'visible'});
  assert.equal(await received.getAttribute('aria-pressed'),'true','reader returns to Received');
  assert.equal(await page.locator('.rat-summary').isVisible(),true);
  // A reload restores Received without storing or reading any correspondence.
  await open();
  assert.equal(await received.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-inbox-type="tasks"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-inbox-type="relays"]').click();
  await page.locator('[data-id="relay1"] [data-delete]').click();
  assert.deepEqual(await page.evaluate(()=>window.deleted),['relay1']);
  assert.equal(await page.locator('#readerView').isVisible(),false,'delete does not open a row');
  await chats.click();
  assert.equal(await page.locator('#relaysList .row').count(),0);
  assert.ok(await page.locator('#relaysList .relay-arrival').count()>0);
  await page.locator('[data-inbox-type="relays"]').click();
  await received.click();
  await page.evaluate(()=>{
    window.fixture.relays=window.fixture.relays.filter(r=>['stranger7','text4','self6'].includes(r.id));
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await page.locator('#relaysList .row').count(),0);
  assert.equal(await page.locator('#requestsEntry').isVisible(),true);
  await page.evaluate(()=>{window.fixture.relays=[];window.events.onInbox(structuredClone(window.fixture));});
  assert.equal(await page.locator('#relaysEmpty .t1').innerText(),'No received relays yet');
  // Type and direction are independent, and Sent uses the existing filters.
  await page.evaluate(()=>{
    window.fixture.sent.push({...window.fixture.sent[0],relayId:'sent-task',kind:'task',relayNotificationKind:'task',title:'Sent task only'});
    window.events.onInbox(structuredClone(window.fixture));
  });
  const sent=page.locator('[data-inbox-direction="sent"]');
  await sent.click();
  assert.match(await page.locator('#relaysList').innerText(),/Sent only/);
  assert.doesNotMatch(await page.locator('#relaysList').innerText(),/Sent task only/);
  await page.locator('[data-inbox-type="tasks"]').click();
  assert.equal(await sent.getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#relaysList').innerText(),/Sent task only/);
  assert.doesNotMatch(await page.locator('#relaysList').innerText(),/Sent only/);
  await open();
  assert.equal(await sent.getAttribute('aria-pressed'),'true','Sent direction survives reload');
  assert.equal(await page.locator('[data-inbox-type="tasks"]').getAttribute('aria-pressed'),'true');
  await chats.click();
  assert.equal(await page.locator('#relaysFilter').isVisible(),false);
  assert.deepEqual(await page.locator('#relaysLayout button').allTextContents(),['Chats','Tasks','Relays']);
  assert.deepEqual(await page.locator('#relaysFilter button').allTextContents(),['Received','Sent']);
  // Existing All preferences migrate to Relays without exposing an All tab.
  await page.evaluate(()=>{
    setProtoPref(`relayRelaysLayout:${signupAccountKey()}`, 'received');
    setProtoPref(`relayRelaysFilter:${signupAccountKey()}`, 'all');
  });
  await open();
  assert.equal(await received.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-inbox-type="relays"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{
    window.fixture.account={...window.fixture.account,userId:'other',email:'other@example.test'};
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await chats.getAttribute('aria-pressed'),'true','account preference is isolated');
  assert.deepEqual(errors,[]);
  console.log('Received layout: filtering, tasks, chronology, pagination, requests, tip state, reader, delete, persistence and account isolation passed.');
} finally { await browser.close(); }
