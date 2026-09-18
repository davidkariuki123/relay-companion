// Real renderer with mocked IPC. Never edits a live message or installed Companion.
// Editing happens in the room's composer (WhatsApp's way); deleting asks
// under the bubble. Both follow WhatsApp's windows: 15 minutes, 2 days.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:750,height:850},reducedMotion:'reduce'});
 page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const ago=(ms)=>new Date(Date.now()-ms).toISOString();
  const text=(relayId,forHuman,createdAt)=>({relayId,threadId:'room',kind:'message',title:'',forHuman,forAgent:'',recipient:{name:'Shane Acton',email:'shane@example.com'},createdAt,updatedAt:createdAt,state:'delivered'});
  const sent=[
   text('old-one','sent three days ago, past both windows',ago(3*24*60*60*1000)),
   text('stale-one','sent twenty minutes ago, past the edit window',ago(20*60*1000)),
   text('edit-me','but its task is, when a new relay comes in, create a new claude session for that relay',ago(60*1000)),
  ];
  const payload={account:{paired:true,userId:'self',name:'David',email:'david@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{messageMutations:true},relays:[],sent,requests:[],chats:[],slackChats:[]};
  window.writes=[];window.deletes=[];window.failEdit=false;
  const api={isTestOverlay:true,refresh:async()=>payload,refreshSent:async()=>({items:sent}),contacts:async()=>[],groups:async()=>({ok:true,result:[]}),accountInfo:async()=>payload.account,agentSurfaces:async()=>({}),
   editMessage:async(id,forHuman,updatedAt)=>{window.writes.push({id,forHuman,updatedAt});if(window.failEdit)return{ok:false,error:'Couldn’t save. Try again.'};const editedAt=new Date().toISOString();const row=sent.find(s=>s.relayId===id);row.forHuman=forHuman;row.editedAt=editedAt;return{ok:true,relayId:id,forHuman,editedAt,updatedAt:editedAt}},
   deleteMessage:async(id,updatedAt)=>{window.deletes.push({id,updatedAt});const deletedAt=new Date().toISOString();const row=sent.find(s=>s.relayId===id);row.deletedAt=deletedAt;return{ok:true,relayId:id,deletedAt,updatedAt:deletedAt}}};
  window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>({ok:true})});
 });
 await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
 await page.locator('#relaysList .relay-arrival').first().click();
 const bubble=page.locator('[data-msg="edit-me"]');
 const composer=page.locator('.qr.th-qr');
 const field=page.locator('#thQrInput');
 const send=page.locator('#thQrSend');
 // Centre the ⋯ in the room and let the scroll event land before clicking. The
 // composer floats over the room's bottom edge, so Playwright would otherwise
 // scroll inside its click, and the room closes any open menu when it scrolls.
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const menuOf=async(id)=>{const trigger=page.locator(`[data-msg="${id}"] [data-message-more]`);await trigger.evaluate(el=>el.scrollIntoView({block:'center'}));await settle();await trigger.click()};
 const openEdit=async()=>{await menuOf('edit-me');await page.locator('[data-message-edit="edit-me"]').click()};

 // The windows decide which verbs the menu offers.
 await menuOf('old-one');
 assert.equal(await page.locator('[data-message-edit="old-one"]').count(),0,'3 days old: no edit');
 assert.equal(await page.locator('[data-message-delete="old-one"]').count(),0,'3 days old: no delete');
 await page.keyboard.press('Escape');
 await menuOf('stale-one');
 assert.equal(await page.locator('[data-message-edit="stale-one"]').count(),0,'20 minutes old: no edit');
 assert.equal(await page.locator('[data-message-delete="stale-one"]').count(),1,'20 minutes old: still deletable');
 await page.keyboard.press('Escape');

 // Edit takes over the composer: the band names the message, the field holds
 // its words with the caret at the end, the button reads Save, the bubble
 // wears the ring. A draft already in the composer comes back afterwards.
 await field.fill('a draft in progress');
 const original=await bubble.locator('.th-msg-title').innerText();
 await openEdit();
 await composer.locator('.th-edit-band').waitFor();
 assert.match(await composer.locator('.th-edit-band').innerText(),/Editing your message/);
 assert.equal(await field.evaluate(el=>el.value),original);
 assert.equal(await field.evaluate(el=>el.selectionStart),original.length,'caret sits at the end');
 assert.equal(await send.innerText(),'Save');
 assert.equal(await bubble.evaluate(el=>el.classList.contains('editing')),true);
 assert.equal(await field.evaluate(el=>document.activeElement===el),true,'the field is focused');

 // Esc leaves with the words untouched and the draft back.
 await field.press('Escape');
 await composer.locator('.th-edit-band').waitFor({state:'detached'});
 assert.equal(await send.innerText(),'Relay');
 assert.equal(await field.evaluate(el=>el.value),'a draft in progress');
 assert.equal(await page.evaluate(()=>window.writes.length),0);
 await field.fill('');

 // The × on the band is the same leave.
 await openEdit();
 await composer.locator('[data-edit-cancel]').click();
 await composer.locator('.th-edit-band').waitFor({state:'detached'});

 // Unchanged words end the edit quietly; nothing is written.
 await openEdit();
 await send.click();
 await composer.locator('.th-edit-band').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.writes.length),0,'identical words are not an edit');

 // Empty words are refused, in place, with the edit still open.
 await openEdit();
 await field.fill('');
 await send.click();
 await page.getByText('A message cannot be empty. To take it back, delete it.').waitFor();
 assert.equal(await composer.locator('.th-edit-band').count(),1);

 // A failure keeps the whole draft in the field and says so under the bubble.
 const long='A long message that must wrap fully. '.repeat(40)+'\n\nhttps://example.com/'+'unbroken'.repeat(40)+'\nLAST LINE';
 // The composer takes multi-line words as the edit put them there (its value
 // setter); Playwright's fill() builds <div> lines no person types.
 await field.evaluate((el,words)=>{el.value=words;el.dispatchEvent(new Event('input',{bubbles:true}))},long);
 await page.evaluate(()=>window.failEdit=true);
 await send.click();
 await page.getByText('Couldn’t save. Try again.').waitFor();
 assert.equal(await field.evaluate(el=>el.value),long,'failure preserves complete draft');
 assert.equal(await composer.locator('.th-edit-band').count(),1,'still editing after a failure');
 if(process.env.RELAY_EDIT_SCREENSHOT)await page.locator('#card').screenshot({path:process.env.RELAY_EDIT_SCREENSHOT});

 // Enter saves; the bubble carries the new words and "Edited · HH:MM".
 await page.evaluate(()=>window.failEdit=false);
 await field.press('Enter');
 await composer.locator('.th-edit-band').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.writes.at(-1).forHuman),long,'save carries all text');
 assert.equal(await page.evaluate(()=>window.writes.length),2);
 await page.waitForFunction(()=>/^Edited · \d{1,2}:\d{2}/.test(document.querySelector('[data-msg="edit-me"] .th-blk-time')?.textContent||''));
 assert.match(await bubble.locator('.th-msg-title').innerText(),/LAST LINE/);
 assert.equal(await send.innerText(),'Relay');
 assert.equal(await field.evaluate(el=>el.value),'');

 // ↑ in an empty composer edits your newest editable text.
 await field.focus();
 await field.press('ArrowUp');
 await composer.locator('.th-edit-band').waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector('.qr.th-qr').dataset.editTarget),'edit-me');
 await field.press('Escape');

 // Delete asks under the bubble, with who stops seeing it. Keep restores.
 await menuOf('edit-me');
 await page.locator('[data-message-delete="edit-me"]').click();
 const under=page.locator('[data-msg="edit-me"] + .th-under');
 await under.locator('[data-message-delete-confirm]').waitFor();
 assert.match(await under.innerText(),/Delete for everyone\? Shane won’t see it any more\./);
 assert.equal(await bubble.evaluate(el=>el.classList.contains('deleting')),true);
 await under.locator('[data-message-delete-cancel]').click();
 await under.locator('[data-message-delete-confirm]').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.deletes.length),0);
 // Delete leaves the tombstone in your own voice.
 await menuOf('edit-me');
 await page.locator('[data-message-delete="edit-me"]').click();
 await under.locator('[data-message-delete-confirm]').click();
 await page.waitForFunction(()=>document.querySelector('[data-msg="edit-me"]')?.classList.contains('deleted'));
 assert.equal(await page.evaluate(()=>window.deletes.length),1);
 assert.match(await bubble.locator('.th-msg-title').innerText(),/^You deleted this message$/);
 assert.equal(await bubble.locator('[data-message-more]').count(),0,'a tombstone has no menu');
 assert.deepEqual(errors,[]);
 console.log('Message editing passed: windows, composer takeover, Esc/×/unchanged/empty/failure, Enter save, edited mark, ↑ edit, delete ask/keep/confirm.');
}finally{await browser.close()}
