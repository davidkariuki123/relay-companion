// Real renderer with mocked IPC. Never edits a live message or installed Companion.
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
  const sent=[{relayId:'edit-me',threadId:'edit-me',kind:'message',title:'',forHuman:'but its task is, when a new relay comes in, create a new claude session for that relay',forAgent:'',recipient:{name:'Shane Acton',email:'shane@example.com'},createdAt:new Date().toISOString(),updatedAt:'2026-09-10T10:00:00Z',state:'delivered'}];
  const payload={account:{paired:true,userId:'self',name:'David',email:'david@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{messageMutations:true},relays:[],sent,requests:[],chats:[],slackChats:[]};
  window.writes=[];window.failEdit=false;
  const api={isTestOverlay:true,refresh:async()=>payload,refreshSent:async()=>({items:sent}),contacts:async()=>[],groups:async()=>({ok:true,result:[]}),accountInfo:async()=>payload.account,agentSurfaces:async()=>({}),editMessage:async(id,forHuman,updatedAt)=>{window.writes.push({id,forHuman,updatedAt});return window.failEdit?{ok:false,error:'Try again'}:{ok:true,relayId:id,forHuman,editedAt:new Date().toISOString()}}};
  window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>({ok:true})});
 });
 await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
 await page.locator('#relaysList .relay-arrival').first().click();
 const bubble=page.locator('[data-msg="edit-me"]');
 const openEdit=async()=>{await bubble.locator('[data-message-more]').click();await page.locator('[data-message-edit="edit-me"]').click()};
 await openEdit();
 const input=page.locator('[data-message-edit-input="edit-me"]');
 const original=await input.inputValue();
 const long='A long message that must wrap fully. '.repeat(60)+'\n\nhttps://example.com/'+ 'unbroken'.repeat(100)+'\nLAST LINE';
 for(const width of [750,360,320]){
  await page.setViewportSize({width,height:740});
  await input.fill(long);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await input.inputValue(),long);
  const dimensions=await input.evaluate(el=>{
   const bubble=el.closest('.th-msg'),editor=el.closest('.th-message-edit'),actions=editor.querySelector('.th-message-edit-actions');
   const box=bubble.getBoundingClientRect(),field=el.getBoundingClientRect(),footer=actions.getBoundingClientRect();
   return {contained:field.left>=box.left&&field.right<=box.right,actionsContained:footer.left>=box.left&&footer.right<=box.right,footerBelow:footer.top>=field.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,font:getComputedStyle(el).fontSize};
  });
  assert.equal(dimensions.contained,true,JSON.stringify({width,...dimensions}));
  assert.equal(dimensions.actionsContained,true);
  assert.equal(dimensions.footerBelow,true);
  assert.ok(dimensions.scrollWidth<=dimensions.clientWidth+1,'long words must soft-wrap');
  assert.ok(dimensions.scrollHeight>dimensions.clientHeight,'long draft remains vertically scrollable');
  assert.equal(dimensions.font,'13px');
  await input.evaluate(el=>el.scrollTop=el.scrollHeight);
  assert.ok(await input.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-1));
  await page.waitForFunction(()=>{const button=document.querySelector('[data-message-edit-save]');const b=button.getBoundingClientRect();return document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)===button});
  assert.equal(await page.getByRole('button',{name:'Save changes',exact:true}).isVisible(),true);
 }
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await input.count(),0);
 assert.match(await bubble.innerText(),new RegExp(original));
 assert.equal(await page.evaluate(()=>window.writes.length),0);
 await openEdit();await input.fill('discard this');await input.press('Escape');
 assert.equal(await input.count(),0);
 await openEdit();await input.fill(long);
 if(process.env.RELAY_EDIT_SCREENSHOT)await page.locator('#card').screenshot({path:process.env.RELAY_EDIT_SCREENSHOT});
 await page.evaluate(()=>window.failEdit=true);
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByText('Try again',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),long,'failure preserves complete draft');
 await page.evaluate(()=>window.failEdit=false);
 await input.press('Control+Enter');
 await input.waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.writes.at(-1).forHuman),long,'save carries all text');
 assert.equal(await page.evaluate(()=>window.writes.length),2);
 assert.deepEqual(errors,[]);
 console.log('Message editing passed: 320/360/750px, long words, full draft, accessible footer, cancel, retry, and keyboard save.');
}finally{await browser.close()}
