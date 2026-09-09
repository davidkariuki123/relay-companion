// Real renderer, mocked IPC: no live account changes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.RELAY_CHROMIUM_EXECUTABLE?{executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE}:{})});
try {
 const page=await browser.newPage({viewport:{width:850,height:850}});
 page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const payload={account:{paired:true,userId:'self',name:'Preview',email:'preview@example.com',hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{todo:true},relays:[],sent:[],requests:[],chats:[],slackChats:[]};
  window.writes=[];window.running=true;
  window.items=[{relayId:'message',kind:'message',title:'Wrap the copied invite link'},{relayId:'task',kind:'task',title:'Check the Relay live runner'}].map(i=>({...i,todoStatus:'triage',todoVersion:1,todoVisibilityVersion:0,sender:{name:'Sven'},createdAt:new Date().toISOString()}));
  const api={isTestOverlay:true,refresh:async()=>payload,refreshSent:async()=>({items:[]}),contacts:async()=>[],groups:async()=>({ok:true,result:[]}),accountInfo:async()=>payload.account,agentSurfaces:async()=>({}),
   todoList:async()=>({ok:true,groups:['triage','done'].map(status=>({status,count:window.items.filter(i=>i.todoStatus===status).length,items:window.items.filter(i=>i.todoStatus===status)})),counts:{triage:window.items.filter(i=>i.todoStatus==='triage').length,done:window.items.filter(i=>i.todoStatus==='done').length}}),
   todoStatusUpdate:async(id,input)=>{window.writes.push(['update',id,input.status]);if(id==='task'&&window.running)return {ok:false,code:'task_active'};const item=window.items.find(i=>i.relayId===id);item.todoStatus=input.status;item.todoVersion++;return {ok:true,status:input.status,version:item.todoVersion};},
   taskStop:async id=>{window.writes.push(['stop',id]);window.running=false;return {ok:true};}
  };
  window.relay=new Proxy(api,{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>({ok:true})});
 });
 await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
 await page.locator('.tab[data-view="tasks"]').click();
 await page.locator('[data-todo-item="message"] [data-todo-actions]').click();
 assert.equal(await page.locator('[data-todo-menu-status]').innerText(),'Mark as done');
 assert.equal(await page.locator('[data-todo-menu-remove]').isVisible(),true);
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator('[data-todo-menu-remove]').evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.items[0].todoStatus==='done');
 await page.locator('[data-todo-item="task"] [data-todo-actions]').click();
 assert.equal(await page.locator('[data-todo-menu-status]').innerText(),'Cancel task');
 if(process.env.RELAY_TODO_SCREENSHOT)await page.locator('#card').screenshot({path:process.env.RELAY_TODO_SCREENSHOT});
 await page.locator('[data-todo-menu-status]').click();
 await page.waitForFunction(()=>window.items[1].todoStatus==='canceled');
 assert.deepEqual(await page.evaluate(()=>window.writes),[['update','message','done'],['update','task','canceled'],['stop','task'],['update','task','canceled']]);
 assert.deepEqual(errors,[]);
 console.log('Todo menu browser checks passed: correct actions, keyboard, done, and stuck-task cancellation.');
} finally {await browser.close();}
