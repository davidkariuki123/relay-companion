// Run with RELAY_PLAYWRIGHT_MODULE pointing at an installed Playwright module.
// Loads the real renderer with an isolated, in-memory IPC fixture; no installed
// Companion files, accounts, messages or read receipts are changed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const { chromium }=require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser=await chromium.launch({ headless:true });
try {
  const page=await browser.newPage({ viewport:{width:850,height:850},reducedMotion:"reduce" });
  page.setDefaultTimeout(10000);
  const errors=[]; page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureEvents={}; window.fixtureVisits=0; window.fixtureVisitIds=new Set();
    const now=Date.now()-60000;
    const relays=Array.from({length:32},(_,index)=>({
      id:`relay_m${index}`,threadId:`relay_m${index}`,groupSendId:`gsend_${index}`,recipientGroupId:"grp_granular",recipientGroupName:"Granular",
      kind:"message",relayNotificationKind:"plain_relay",senderName:index%2 ? "Shane Acton" : "David Kariuki",senderEmail:index%2 ? "shane@example.com" : "david@example.com",
      forHuman:[2,12,22].includes(index) ? "@Sven_Wellmann please check this image." : `Conversation message ${index}. Some context around the image attachment.`,
      forAgent:"",title:"",unread:true,recipientMentioned:[2,12,22].includes(index),attachments:[],
      createdAt:new Date(now-(32-index)*60000).toISOString(),updatedAt:new Date(now-(32-index)*60000).toISOString(),
    }));
    const group={id:"grp_granular",name:"Granular",owned:false,owner:{userId:"david",name:"David Kariuki",email:"david@example.com"},members:[{contactId:"sven",name:"Sven Wellmann",email:"sven@example.com"},{contactId:"shane",name:"Shane Acton",email:"shane@example.com"}]};
    window.fixturePayload={ account:{paired:true,name:"Sven Wellmann",email:"sven@example.com",hasSentRelay:true},ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1},features:{peopleMentions:true},relays:relays.filter(row=>row.id!=="relay_m2"),sent:[],requests:[],chats:[],slackChats:[] };
    const api={
      isTestOverlay:true,
      refresh:async()=>structuredClone(window.fixturePayload),
      refreshSent:async()=>({items:[]}),
      contacts:async()=>[{id:"david",name:"David Kariuki",email:"david@example.com"},{id:"shane",name:"Shane Acton",email:"shane@example.com"}],
      groups:async()=>({ok:true,result:[group]}),
      accountInfo:async()=>({name:"Sven Wellmann",email:"sven@example.com",hasSentRelay:true}),
      agentSurfaces:async()=>({}),
      mentionVisit:async(chatId,visitId)=>{
        if(!window.fixtureVisitIds.has(visitId)) { window.fixtureVisitIds.add(visitId); window.fixtureVisits++; }
        return {ok:true,visit:{chatId,visitId,openedAt:new Date().toISOString(),previousOpenedAt:window.fixtureVisits>1 ? new Date().toISOString() : null,
          mentions:window.fixtureVisits===1 ? relays.filter(row=>row.recipientMentioned && !window.fixtureRemoved?.includes(row.id)).map(row=>({...row,relayId:row.id,state:"delivered",direction:"inbound",sender:{name:row.senderName,email:row.senderEmail}})) : [],
        }};
      },
    };
    window.relay=new Proxy(api,{get:(target,key)=>{
      if(key in target) return target[key];
      if(String(key).startsWith("on")) return (callback)=>{window.fixtureEvents[key]=callback;return ()=>{};};
      return async()=>({ok:true});
    }});
  });
  await page.goto(new URL("../overlay/inbox.html",import.meta.url).href);
  await page.locator("#relaysList .relay-arrival").first().waitFor();
  await page.locator("#relaysList .relay-arrival").first().click();
  await page.locator('[data-mention-nav="first"]').waitFor();
  await page.waitForFunction(()=>document.querySelector(".th-mention-jump")?.textContent.includes("3 mentions"));
  assert.match(await page.locator('.th-mention-jump').innerText(),/3 mentions/);
  if(process.env.RELAY_MENTION_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_MENTION_SCREENSHOT.replace('.png','-idle.png')});
  await page.locator('[data-mention-nav="first"]').click();
  await page.locator('[data-msg="relay_m2"].mention-target').waitFor();
  await page.waitForFunction(()=>{
    const bounds=document.querySelector('[data-msg="relay_m2"].mention-target')?.getBoundingClientRect();
    const card=document.querySelector('#card').getBoundingClientRect();
    return bounds && bounds.top>=card.top && bounds.bottom<=card.bottom;
  });
  if(process.env.RELAY_MENTION_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_MENTION_SCREENSHOT});
  await page.evaluate(()=>window.fixtureEvents.onInbox({...structuredClone(window.fixturePayload),relays:window.fixturePayload.relays.map(row=>({...row,unread:false}))}));
  assert.equal(await page.locator('[data-msg="relay_m2"].mention-target').count(),1);
  for (const id of ["relay_m12","relay_m22"]) {
    await page.locator('[data-mention-nav="next"]').click();
    await page.locator(`[data-msg="${id}"].mention-target`).waitFor();
  }
  await page.getByRole("button",{name:"Back to latest",exact:true}).click();
  assert.equal(await page.locator('.th-mention-jump').isVisible(),false);
  await page.locator('#thBack').click();
  await page.locator('#relaysList .relay-arrival').first().click();
  await page.waitForFunction(()=>window.fixtureVisits===2);
  assert.equal(await page.locator('.th-mention-jump').isVisible(),false);
  assert.deepEqual(errors,[]);
  // A notification opens the tagged message, with the rest of this visit still navigable.
  await page.reload();
  await page.locator('#relaysList .relay-arrival').first().waitFor();
  await page.evaluate(()=>{
    foldToPill();
    window.fixtureEvents.onNewRelay(window.fixturePayload.relays.find(row=>row.id==='relay_m22'),{sticky:false});
  });
  await page.getByText('David mentioned you in Granular',{exact:true}).waitFor();
  if(process.env.RELAY_MENTION_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_MENTION_SCREENSHOT.replace('.png','-notification.png')});
  await page.locator('[data-mention-target="relay_m22"]').click();
  await page.locator('[data-msg="relay_m22"].mention-target').waitFor();
  assert.match(await page.locator('.th-mention-jump').innerText(),/3 of 3/);
  await page.evaluate(()=>{
    window.fixtureRemoved=['relay_m22'];
    window.fixturePayload.relays=window.fixturePayload.relays.map(row=>row.id==='relay_m22' ? {...row,recipientMentioned:false,deletedAt:new Date().toISOString()} : row);
    window.fixtureEvents.onInbox(structuredClone(window.fixturePayload));
  });
  await page.waitForFunction(()=>document.querySelector('.th-mention-jump')?.textContent.includes('2 mentions'));
  assert.equal(await page.locator('[data-msg="relay_m22"].mention-target').count(),0);
  assert.deepEqual(errors,[]);
  console.log("Real Companion renderer: older missing mentions, exact notification target, three-message navigation, refresh, deletion, completion and revisit passed.");
} finally { await browser.close(); }
