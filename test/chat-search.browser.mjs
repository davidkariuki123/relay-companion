// Search is the list (2026-10-07): the tab row becomes the field, the inbox
// below becomes the results. Real renderer, isolated in-memory IPC.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {})});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:360,height:700}, reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.events = {}; window.opened = [];
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const names = [...Array.from({length:65}, (_, i) => `Person ${i}`), 'Jordan Nel'];
    const relays = names.map((name,i) => ({id:`relay-${i}`,threadId:`room-${i}`,state:'read',relayNotificationKind:'plain_relay',senderName:name,senderEmail:`person${i}@example.test`,title:'',forHuman:'Hello',createdAt:ago(30 + i),attachments:[]}));
    relays.push(
      {id:'relay-g1',threadId:'room-g',relayNotificationKind:'plain_relay',senderName:'Shane Acton',senderEmail:'shane@example.test',recipientGroupId:'grp_granular',recipientGroupName:'Granular',title:'',forHuman:'The deploy went out twice.',createdAt:ago(5)},
      {id:'relay-p1',threadId:'room-0',relayNotificationKind:'plain_relay',senderName:'Person 0',senderEmail:'person0@example.test',title:'',forHuman:'Can you send me the pricing sheet before the call?',createdAt:ago(400)},
      ...Array.from({length:14}, (_, i) => ({id:`relay-f${i}`,threadId:'room-0',relayNotificationKind:'plain_relay',senderName:'Person 0',senderEmail:'person0@example.test',title:'',forHuman:`Later note ${i}, long enough to take a line of its own in the room.`,createdAt:ago(390 - i * 10)})),
    );
    window.fixture = {
      account:{paired:true,userId:'self',name:'Test User',email:'self@example.test',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},
      features:{requests:false,todo:false,slack:false,replyThreads:true},
      contacts:[...names.map((name,i) => ({contactId:`contact-${i}`,name,email:`person${i}@example.test`})), {contactId:'contact-priya',name:'Priya Raman',email:'priya@example.test'}],
      relays, sent:[],requests:[],chats:[],slackChats:[],
    };
    const groups = [{id:'grp_granular',name:'Granular',owner:{userId:'self',name:'Test User',email:'self@example.test'},members:[{userId:'s',name:'Shane Acton',email:'shane@example.test'},{userId:'a',name:'Andrew Ng',email:'andrew@example.test'}]}];
    const api = {isTestOverlay:true,refresh:async()=>structuredClone(window.fixture),refreshSent:async()=>({items:[]}),contacts:async()=>window.fixture.contacts,groups:async()=>({ok:true,result:groups}),accountInfo:async()=>window.fixture.account,agentSurfaces:async()=>({}),
      openChatWith:async(email,name)=>{ window.opened.push(email); return {ok:true,chat:{chatId:`chat_${email}`,kind:'direct',items:[],participants:[{id:'me',name:'Test User',self:true},{id:'p',name:name||email,...(email==='dan@studio.io'?{onRelay:false}:{})}]},recipient:{email,name}}; },
      copyOnboardingInviteLink:async()=>{ window.invitesCopied=(window.invitesCopied||0)+1; return {ok:true}; }};
    window.relay = new Proxy(api,{get:(target,key)=>key in target ? target[key] : String(key).startsWith('on') ? callback=>{window.events[key]=callback;return()=>{};} : async()=>({ok:true})});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.waitForFunction(()=>!!window.events.onOpenFull);
  await page.evaluate(()=>window.events.onOpenFull());
  const trigger=page.getByRole('button',{name:'Search',exact:true});
  await trigger.waitFor({state:'visible'});
  const input=page.getByRole('combobox',{name:'Search chats and messages'});
  const searching=()=>page.locator('#card').evaluate(el=>el.classList.contains('searching'));
  const options=page.locator('#chatSearchResults [role="option"]');
  const lit=()=>page.locator('#chatSearchResults [role="option"].is-active');
  const labels=()=>page.locator('#chatSearchResults .cs-label').allInnerTexts();
  assert.equal(await page.locator('#relaysList [data-party="Jordan Nel"]').count(),0,'Jordan starts beyond the render window');

  // The field takes the tab row; empty, the results are the inbox itself.
  await trigger.click();
  assert.equal(await searching(),true);
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('[data-view="relays"]').isVisible(),false,'the tabs give way to the field');
  assert.equal(await page.locator('#relaysList').isVisible(),false,'there is never a second copy of the list');
  assert.equal(await options.count(),await page.evaluate(()=>relayIdentityRows().length),'an empty field lists every chat');
  assert.deepEqual(await labels(),[]);
  assert.equal(await lit().count(),0,'nothing is lit before typing');

  await input.fill('  jOrDaN  ');
  assert.deepEqual((await labels()).map(s=>s.toLowerCase()),['chats']);
  assert.equal(await options.count(),1);
  assert.equal(await page.locator('#chatSearchResults mark.hit').first().innerText(),'Jordan');
  assert.equal(await lit().count(),1,'the first answer is lit: it is what Enter opens');
  await page.evaluate(()=>window.events.onInbox(structuredClone(window.fixture)));
  assert.equal(await input.inputValue(),'  jOrDaN  ','an inbox push keeps the query');
  assert.equal(await input.evaluate(el=>el===document.activeElement),true,'and the cursor');

  // A group is found by the people in it, never by the person searching.
  await input.fill('shane');
  await page.waitForFunction(()=>document.querySelector('#chatSearchResults [data-party="Granular"] .cs-people'));
  assert.match(await page.locator('#chatSearchResults [data-party="Granular"] .cs-people').innerText(),/Shane Acton, Andrew Ng/);
  await input.fill('test user');
  assert.equal(await page.locator('#chatSearchResults [data-party="Granular"]').count(),0);

  // A word from a message: opened at that message, not at the bottom.
  await input.fill('pricing');
  assert.ok((await labels()).some(label=>/messages/i.test(label)));
  assert.match(await lit().innerText(),/send me the pricing sheet/);
  await input.press('Enter');
  await page.waitForFunction(()=>activeView==='threads');
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(()=>{
    const hit=document.querySelector('#thRows [data-msg="relay-p1"]'); const box=hit.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  }),'the room opens at the message it was found by');
  await page.waitForFunction(()=>CSS.highlights.has('relay-search-hit'));
  assert.equal(await page.evaluate(()=>[...CSS.highlights.get('relay-search-hit')].map(range=>range.toString()).join()),'pricing','the searched word is lit inside the message');
  await page.locator('#thBack').click();
  await page.waitForFunction(()=>activeView==='relays');
  assert.equal(await searching(),true,'Back returns to the same search');
  assert.equal(await input.inputValue(),'pricing');
  await page.waitForFunction(()=>document.activeElement===document.getElementById('chatSearchInput'));

  // Arrows move the lit row; the pointer lights the row under it.
  await input.fill('person 1');
  const first=await lit().getAttribute('id');
  await input.press('ArrowDown');
  assert.notEqual(await lit().getAttribute('id'),first);
  await input.press('ArrowUp');
  assert.equal(await lit().getAttribute('id'),first);
  await options.nth(2).hover();
  assert.equal(await lit().getAttribute('id'),await options.nth(2).getAttribute('id'));

  // A contact with no chat yet opens ready to write.
  await input.fill('priya');
  assert.deepEqual((await labels()).map(s=>s.toLowerCase()),['chats'],'a contact with no chat yet sits among the chats');
  assert.equal(await lit().getAttribute('data-search-kind'),'person','the person named comes first');
  await input.press('Enter');
  await page.waitForFunction(()=>window.opened.includes('priya@example.test'));
  await page.waitForFunction(()=>activeView==='threads');
  assert.equal(await page.locator('#thSlackPeople .th-sp-away').count(),0,'someone on Relay gets no such line');
  await page.locator('#thBack').click();
  await page.waitForFunction(()=>activeView==='relays');

  // An address finds its person's chat; an address nobody has yet offers a new chat.
  await input.fill('person0@example.test');
  assert.equal(await lit().getAttribute('data-party'),'Person 0');
  await input.fill('dan@studio.io');
  assert.equal(await lit().getAttribute('data-search-kind'),'address');
  assert.match(await lit().innerText(),/New chat/);
  await input.press('Enter');
  await page.waitForFunction(()=>window.opened.includes('dan@studio.io'));
  await page.waitForFunction(()=>activeView==='threads');
  // Someone not on Relay hears nothing until they join: the room says so, and copies the invite link.
  await page.locator('#thSlackPeople').getByText('dan@studio.io isn’t on Relay yet. Send them your invite link.').waitFor();
  await page.getByRole('button',{name:'Copy invite link'}).click();
  assert.equal(await page.evaluate(()=>window.invitesCopied),1);
  await page.locator('#thBack').click();
  await page.waitForFunction(()=>activeView==='relays');

  await input.fill('no such chat');
  assert.match(await page.locator('#chatSearchResults').innerText(),/No results for “no such chat”/);
  assert.equal(await page.locator('#chatSearchLive').innerText(),'No results');

  // Escape clears, then leaves; the list and its scrolling come back.
  await input.press('Escape');
  assert.equal(await input.inputValue(),'');
  assert.equal(await searching(),true);
  await input.press('Escape');
  assert.equal(await searching(),false);
  assert.equal(await page.locator('#relaysList').isVisible(),true);
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);

  // Typing on the inbox searches; the keystroke lands in the field. So does ⌘F.
  await page.evaluate(()=>document.activeElement.blur());
  await page.keyboard.type('jor');
  assert.equal(await searching(),true);
  assert.equal(await input.inputValue(),'jor');
  await page.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await searching(),false);
  await page.keyboard.press('Meta+f');
  assert.equal(await searching(),true);

  // It never overflows the card, at any width, in either theme.
  await input.fill('person');
  for(const width of [320,360,736]) {
    await page.setViewportSize({width,height:700});
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      assert.ok(await page.evaluate(()=>{
        const card=document.getElementById('card').getBoundingClientRect();
        const parts=[...document.querySelectorAll('#chatSearch, #chatSearchCancel, #chatSearchResults')].map(el=>el.getBoundingClientRect());
        return parts.every(b=>b.left>=card.left-0.5 && b.right<=card.right+0.5) && document.getElementById('scroll').scrollWidth<=document.getElementById('scroll').clientWidth;
      }),`search fits at ${width}px in ${theme}`);
    }
  }
  await page.setViewportSize({width:360,height:700});

  // Another tab or another account ends the search.
  await page.locator('[data-view="contacts"]').evaluate(el=>el.click());
  assert.equal(await searching(),false);
  await page.locator('[data-view="relays"]').click();
  assert.equal(await searching(),false,'coming back to Inbox shows the inbox');
  await trigger.click();
  await input.fill('jordan');
  await page.evaluate(()=>{
    window.fixture.account={...window.fixture.account,userId:'other',email:'other@example.test'};
    window.fixture.relays=[];window.fixture.contacts=[];
    window.events.onInbox(structuredClone(window.fixture));
  });
  assert.equal(await searching(),false,'account changes end search');
  assert.equal(await page.locator('#chatSearchResults').innerText(),'');
  assert.deepEqual(errors,[]);
  console.log('Chat search: field in place, every chat, name/member/message/contact hits, open-at-message, Back, keys, type-to-search, layout and resets passed.');
} finally { await browser.close(); }
