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
  await page.locator('[data-inbox-type="tasks"]').click();
  await received.click();
  await page.evaluate(()=>{
    const template=window.fixture.relays.find(r=>r.id==='task2');
    const at=new Date().toISOString();
    window.fixture.relays=[
      ...Array.from({length:30},(_,i)=>({...template,id:`done-${i}`,threadId:`done-thread-${i}`,taskCompletedAt:at})),
      {...template,id:'working',threadId:'working',taskStartedAt:at},
      {...template,id:'cancelled',threadId:'cancelled',taskCancelledAt:at},
      {...template,id:'rejected',threadId:'rejected',taskRejectedAt:at},
      {...template,id:'older-open',threadId:'older-open'},
    ];
    window.events.onInbox(structuredClone(window.fixture));
  });
  await page.locator('[data-inbox-type="tasks"]').click();
  const rowIds=()=>page.locator('#relaysList .row').evaluateAll(rows=>rows.map(r=>r.dataset.id));
  assert.deepEqual(await rowIds(),['older-open','working'],'older unfinished tasks surface before newer completed history');
  assert.deepEqual(await page.locator('.received-task-heading').allTextContents(),['In progress1'],'no added Yours to do heading');
  const completed=page.locator('[data-task-history="done"]');
  const closed=page.locator('[data-task-history="closed"]');
  assert.equal(await completed.getAttribute('aria-expanded'),'false');
  assert.equal(await completed.locator('.received-task-count').innerText(),'30');
  assert.equal(await closed.locator('.received-task-count').innerText(),'2');
  await completed.click();
  assert.equal(await completed.getAttribute('aria-expanded'),'true');
  assert.equal(await completed.evaluate(el=>el===document.activeElement),true,'disclosure retains keyboard focus');
  await page.locator('#scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>document.querySelectorAll('#relaysList .row').length===32);
  assert.equal(await page.evaluate(()=>{
    const row=document.querySelector('#relaysList .row');
    window.events.onInbox(structuredClone(window.fixture));
    return row===document.querySelector('#relaysList .row');
  }),true,'unchanged polling preserves the expanded history and DOM');
  await completed.click();
  assert.deepEqual(await rowIds(),['older-open','working']);
  await closed.click();
  assert.deepEqual(await rowIds(),['older-open','working','cancelled','rejected']);
  await page.evaluate(()=>{
    window.fixture.relays.find(r=>r.id==='older-open').taskCompletedAt=new Date().toISOString();
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.deepEqual(await rowIds(),['working','cancelled','rejected'],'completion leaves active work immediately');
  assert.equal(await completed.locator('.received-task-count').innerText(),'31');
  await page.locator('[data-inbox-type="relays"]').click();
  assert.equal(await page.locator('.received-task-fold').count(),0,'other lists keep chronological layout');
  await page.locator('[data-inbox-type="tasks"]').click();
  await page.evaluate(()=>{
    window.fixture.relays=window.fixture.relays.filter(r=>r.taskCompletedAt);
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await page.locator('#relaysEmpty').isVisible(),false,'all-complete inbox retains its history disclosure');
  assert.equal(await completed.isVisible(),true);
  assert.equal((await rowIds()).length,0);
  await completed.click();
  await page.evaluate(()=>{
    window.fixture.account={...window.fixture.account,userId:'other',email:'other@example.test'};
    window.events.onInbox(structuredClone(window.fixture));
  });
  await page.locator('[data-inbox-type="tasks"]').click();
  await received.click();
  await page.locator('[data-inbox-type="tasks"]').click();
  assert.equal(await completed.getAttribute('aria-expanded'),'false','account switch resets disclosure state');
  assert.deepEqual(errors,[]);
  console.log('Received task grouping: unfinished-first, history, closed states, paging, live completion, focus, polling and account isolation passed.');
} finally { await browser.close(); }
