// THE EXPANDED APP (David, 2026-10-07): Expand is a mode of the whole app.
// The list you know becomes the sidebar and whatever you open opens beside
// it; Back, tabs and the list never fold the frame, only Collapse does.
// Real renderer, isolated in-memory IPC.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  // The screen is the window here: the expanded app fills the screen it is on.
  const page = await browser.newPage({viewport:{width:1280,height:800}, screen:{width:1280,height:800}, reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {};
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const relay = (id, threadId, name, words, minutes, extra = {}) => ({id, threadId, state:'read', relayNotificationKind:'plain_relay', senderName:name,
      senderEmail:`${name.split(' ')[0].toLowerCase()}@example.test`, title:extra.title || '', forHuman:words, forAgent:extra.forAgent || '', createdAt:ago(minutes), attachments:[], ...extra});
    const relays = [
      relay('relay-s1', 'room-sven', 'Sven Wellmann', 'Shipping the share page fold tomorrow.', 30),
      relay('relay-s2', 'room-sven', 'Sven Wellmann', '', 60, {title:'Design contract round two', forAgent:'Eighteen laws.'}),
      relay('relay-h1', 'room-shane', 'Shane Acton', 'The staging build is green now.', 90),
      relay('relay-k1', 'room-kiara', 'Kiara Moodley', 'The site copy reads so much better.', 120),
    ];
    const topic = {id:'tpc_dev', name:'Dev work and deploys', mandate:'Engineering and deploys.', mandateVersion:1, memberCount:3, newPostCount:0, postCount:4, latestPostAt:ago(40),
      membership:{role:'member', state:'active', approvedMandateVersion:1, mandateCurrent:true, postConfirmation:'auto'}};
    window.fixture = {
      account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false,replyThreads:true,topics:true},
      contacts:[{contactId:'c-sven',name:'Sven Wellmann',email:'sven@example.test'},{contactId:'c-shane',name:'Shane Acton',email:'shane@example.test'},{contactId:'c-kiara',name:'Kiara Moodley',email:'kiara@example.test'},{contactId:'c-aron',name:'Aron van Ammers',email:'aron@example.test'}],
      relays, sent:[], requests:[], chats:[], slackChats:[],
    };
    const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>window.fixture.contacts,
      groups:async()=>({ok:true,result:[]}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),setupSnapshot:async()=>({hosts:[],scannedAt:Date.now()}),
      topicsList:async()=>({ok:true,result:[topic]}),topicGet:async()=>({ok:true,result:{...topic,members:[]}}),
      topicThreads:async()=>({ok:true,result:{topic,threads:[],nextCursor:null}}),topicSeen:async()=>({ok:true,result:topic}),
      topicPosts:async()=>({ok:true,result:{topic,posts:[],nextCursor:null}}),
      // Someone you have never written to: the chat is created on the server.
      openChatWith:async(email,name)=>{ await new Promise(r=>setTimeout(r,120)); return {ok:true,recipient:{email},
        chat:{chatId:'chat_aron',kind:'direct',title:name,participants:[{id:'self',name:'Test User',self:true},{id:'aron',name,self:false,email}],items:[],unreadCount:0,messageCount:0,updatedAt:ago(1)}}; },
      canonicalChat:async()=>({ok:false})};
    window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.waitForFunction(()=>!!window.events.onOpenFull);
  await page.evaluate(()=>window.events.onOpenFull());
  const card = page.locator('#card');
  const width = async () => Math.round((await card.boundingBox()).width);
  const wide = () => card.evaluate(el => el.classList.contains('wide'));
  const state = () => page.evaluate(() => ({ view:activeView, room:threadDetailId, expanded:appExpanded }));
  const settle = () => page.waitForTimeout(250);
  const FULL = await page.evaluate(() => ({ w:screen.availWidth, h:screen.availHeight }));

  // The small card opens a room; the window's one switch turns the WHOLE
  // APP wide, and stays exactly where it was, now reading Collapse.
  await page.locator('#relaysList .relay-row[data-party="Shane Acton"]').click();
  await page.waitForFunction(() => activeView === 'threads');
  assert.equal(await width(), 344);
  const switchBox = () => page.locator('#wideToggle').evaluate(el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top), el.textContent.trim()]; });
  const before = await switchBox();
  assert.equal(before[3], 'Expand');
  await page.locator('#wideToggle').click();
  await page.waitForFunction(() => appExpanded && document.getElementById('card').classList.contains('wide'));
  await settle();
  assert.equal(await width(), FULL.w, 'the expanded app fills the screen');
  assert.equal(Math.round((await card.boundingBox()).height), FULL.h, 'top to bottom');
  assert.equal((await state()).room, 'room-shane', 'the room stays open through Expand');
  assert.equal(await page.locator('#wideSide #relaysView').isVisible(), true, 'the inbox list is the sidebar');
  const after = await switchBox();
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'the switch never moves: it is under the pointer');
  assert.equal(after[3], 'Collapse');
  assert.equal(await page.locator('#thExpand').count(), 0, 'one switch, one place: no second copy in the room');
  assert.equal(await page.locator('#thBack').isVisible(), false, 'Back has nowhere to go beside the list');
  assert.match(await page.evaluate(() => wideLitSelector), /room-shane/, 'the open chat is lit in the list');

  // Clicking the chat that is already open does nothing (no reload, no jump).
  const opens = await page.evaluate(() => { let n = 0; const real = openThreadDetail; window.__opens = () => n; openThreadDetail = (...a) => { n++; return real(...a); }; return 0; });
  await page.locator('#relaysList .relay-row[data-party="Shane Acton"]').click();
  assert.equal(await page.evaluate(() => window.__opens()), opens, 'the open row is a no-op');

  // Another chat from the sidebar replaces the pane; the frame holds.
  await page.locator('#relaysList .relay-row[data-party="Sven Wellmann"]').click();
  await page.waitForFunction(() => threadDetailId === 'room-sven');
  assert.equal(await width(), FULL.w);

  // A chat opens on its newest message and stays there while what loads late
  // settles in; a real scroll lets go (David, 2026-10-08: chats opened 100 to
  // 340px short, the last message under the composer).
  await page.waitForTimeout(400);
  const gap = () => page.evaluate(() => { const el = roomScrollElement(); return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop); });
  await page.evaluate(() => { const late = document.createElement('div'); late.id = 'lateGrowth'; late.style.height = '1400px'; document.getElementById('thRows').prepend(late); });
  await page.waitForTimeout(150);
  assert.ok(await gap() <= 2, `late content left the room ${await gap()}px short of its newest message`);
  await page.evaluate(() => { roomScrollElement().scrollTop -= 101; });
  await page.waitForTimeout(150);
  assert.ok(await gap() <= 2, 'a layout nudge with no gesture goes back to the newest');
  await page.mouse.move(650, 400);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(250);
  assert.ok(await gap() > 100, 'a real scroll is the person\'s and is never undone');
  await page.evaluate(() => document.getElementById('lateGrowth')?.remove());

  // Switching chats beside the list is instant: one click merges the inbox at
  // most twice (before and after it marks the chat read), never once per row.
  for (const party of ['Shane Acton', 'Kiara Moodley', 'Sven Wellmann']) {
    const builds = await page.evaluate(() => chatIndexBuilds);
    await page.locator(`#relaysList .relay-row[data-party="${party}"]`).click();
    await page.waitForFunction(() => activeView === 'threads');
    assert.ok(await page.evaluate(() => chatIndexBuilds) - builds <= 2, `opening ${party} rebuilt the inbox ${await page.evaluate(() => chatIndexBuilds) - builds} times`);
  }
  await page.locator('#relaysList .relay-row[data-party="Sven Wellmann"]').click();

  // ⌥↓ walks the list, opening each chat in the pane.
  await page.locator('#thQrInput').evaluate(el => el.blur());
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(() => threadDetailId !== 'room-sven');

  // Tabs swap the sidebar and keep the frame; coming back finds the same chat.
  const roomBefore = (await state()).room;
  await page.locator('.tab[data-view="topics"]').click();
  await settle();
  assert.equal(await wide(), true, 'Topics stays expanded');
  assert.equal(await page.locator('#topicsSide [data-topic-open]').count(), 1, 'the topics list is the sidebar');
  assert.equal(await page.locator('#wideEmpty').isVisible(), true, 'nothing open: the pane says so');
  await page.locator('#topicsSide [data-topic-open]').click();
  await page.waitForFunction(() => topicsState.detail && !document.getElementById('topicsView').classList.contains('hidden'));
  assert.equal(await width(), FULL.w);
  await page.locator('.tab[data-view="contacts"]').click();
  await settle();
  assert.equal(await wide(), true, 'Contacts stays expanded');
  // One person's chat open beside the list, then someone you have never
  // written to: their chat is created and opens in the pane (it used to be
  // dropped because the list was no longer "the Contacts view").
  await page.locator('#cvList .cv-item').filter({ hasText:'Kiara Moodley' }).click();
  await page.waitForFunction(() => activeView === 'threads' && threadDetailId === 'room-kiara');
  await page.locator('#cvList .cv-item').filter({ hasText:'Aron van Ammers' }).click();
  await page.waitForFunction(() => String(threadDetailId).includes('chat_aron'));
  assert.equal(await width(), FULL.w);
  await page.locator('.tab[data-view="settings"]').click();
  await settle();
  assert.equal(await wide(), true, 'You stays expanded');
  assert.equal(await page.locator('#wideSide #settingsView').isVisible(), true, 'the You page is the sidebar');
  assert.equal(await page.locator('#setupPane #setupPage').isVisible(), true, 'Your AIs opens beside it');
  assert.equal(await page.locator('#setupBack').isVisible(), false);
  const youTab = await page.locator('.tab[data-view="settings"]').boundingBox();
  await page.locator('.tab[data-view="contacts"]').click(); await settle();
  assert.deepEqual(await page.locator('.tab[data-view="settings"]').boundingBox(), youTab, 'the tab row never moves between tabs');
  await page.locator('.tab[data-view="settings"]').click(); await settle();
  await page.locator('.tab[data-view="relays"]').click();
  await page.waitForFunction(() => activeView === 'threads');
  assert.equal((await state()).room, roomBefore, 'the Inbox remembers the chat it had open');

  // Back (if ever reached) only empties the pane: the frame never folds.
  await page.evaluate(() => document.getElementById('thBack').click());
  await page.waitForFunction(() => activeView === 'relays');
  await settle();
  assert.equal(await width(), FULL.w, 'Back never collapses the expanded app');
  assert.equal(await page.locator('#wideEmpty').isVisible(), true);

  // Folding to the pill and back keeps the mode; the pill is the pill.
  await page.locator('#lockup .word').click();
  await page.waitForFunction(() => collapsed);
  await settle();
  assert.equal(await wide(), false, 'the folded pill never wears the two-pane grid');
  assert.equal(await width(), 244);
  await page.locator('#lockup .word').click();
  await page.waitForFunction(() => !collapsed);
  await settle();
  assert.equal(await wide(), true);
  assert.equal(await width(), FULL.w);

  // The mode outlives a restart.
  assert.equal(await page.evaluate(() => localStorage.getItem('relayAppExpanded')), '1');

  // Collapse is the one way out, and it keeps what is open.
  await page.locator('#relaysList .relay-row[data-party="Kiara Moodley"]').click();
  await page.waitForFunction(() => threadDetailId === 'room-kiara');
  await page.locator('#wideToggle').click();
  await page.waitForFunction(() => !appExpanded);
  await settle();
  assert.equal(await width(), 344);
  assert.equal(await wide(), false);
  assert.deepEqual(await state(), { view:'threads', room:'room-kiara', expanded:false }, 'Collapse keeps the open chat');
  assert.equal(await page.locator('#relaysView').evaluate(el => el.closest('#scroll') !== null), true, 'the list went home to the small card');
  assert.equal(await page.evaluate(() => localStorage.getItem('relayAppExpanded')), '0');
  assert.deepEqual(errors, []);
  console.log('expanded app: ok');
} finally {
  await browser.close();
}
