// Standalone Chromium renderer regression: the real inbox document with a mock
// preload bridge. No Companion process, account, external API, or messages.
// Run from the repository root: node packages/companion/test/chat-message-metadata.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const overlay=fileURLToPath(new URL("../overlay/", import.meta.url));
const server=http.createServer((request,response)=>{
  const name=decodeURIComponent(new URL(request.url,"http://localhost").pathname).slice(1);
  const target=path.resolve(overlay,name || "inbox.html");
  if (!target.startsWith(overlay) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  const type=target.endsWith(".html")?"text/html":/\.(?:js|cjs)$/.test(target)?"text/javascript":target.endsWith(".woff2")?"font/woff2":"application/octet-stream";
  response.writeHead(200,{"content-type":type}); fs.createReadStream(target).pipe(response);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:344,height:700},timezoneId:"Africa/Johannesburg",reducedMotion:"reduce"});
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const empty={account:{paired:true,userId:"self",email:"self@example.com",name:"You"},ui:{soundsMuted:true},features:{},relays:[],sent:[],contacts:[],outbox:[]};
    window.relay=new Proxy({isTestOverlay:true,refresh:async()=>empty,contacts:async()=>[],rendererReady:()=>window.ready=true}, {
      get:(target,key)=>key in target?target[key]:String(key).startsWith("on")?()=>{}:async()=>({ok:true}),
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/inbox.html`);
  await page.waitForFunction(()=>window.ready);
  const fixture={account:{paired:true,userId:"self",email:"self@example.com",name:"You"},ui:{soundsMuted:true},features:{},relays:[],sent:[],contacts:[],outbox:[{
    id:"test-send",createdAt:"2026-09-10T22:50:53Z",state:"queued",attempts:1,lastError:"",text:"Can you send me the updated version when you get a chance?",files:[],
    chat:{threadId:"thread_fixture",party:"Test",partyKey:"email:test@example.com"},recipient:{email:"test@example.com"},
  }]};
  await page.evaluate(input=>{ onPayload(input); openThreadDetail("thread_fixture","Test","relays"); },fixture);
  await page.locator(".th-text-content time").waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const inspect=()=>page.locator(".th-msg.text:not(.attachment-only)").evaluateAll(nodes=>nodes.map(node=>{
    const title=node.querySelector(".th-msg-title"),clock=node.querySelector("time"),range=document.createRange();
    range.selectNodeContents(title);
    const c=clock.getBoundingClientRect(),text=[...range.getClientRects()];
    const status=document.querySelector(".th-under .th-seen");
    return {clock:clock.textContent,lines:new Set(text.map(r=>r.top)).size,
      overlap:text.some(r=>r.left<c.right&&r.right>c.left&&r.top<c.bottom&&r.bottom>c.top),
      clockTop:c.top,textBottom:Math.max(...text.map(r=>r.bottom)),
      label:status?.textContent,opacity:status?getComputedStyle(status).opacity:null,animation:status?getComputedStyle(status).animationName:null};
  }));
  for(const width of [344,480]) {
    await page.setViewportSize({width,height:700});
    for(const theme of ["light","dark"]) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      for(const full of [false,true]) {
        fixture.outbox[0].text=full?"Can you send me the updated version before our meeting tomorrow morning?":"Can you send me the updated version when you get a chance?";
        for(let refresh=0;refresh<3;refresh++) {
          fixture.outbox[0].attempts=refresh+1;
          await page.evaluate(input=>onPayload(input),fixture);
          const [result]=await inspect();
          assert.equal(result.clock,"00:50");
          assert.equal(result.overlap,false,JSON.stringify(result));
          assert.equal(result.lines,2);
          assert.equal(result.label,"Sending…");
          assert.equal(result.opacity,"0.75");
          assert.equal(result.animation,"none");
          assert.equal(result.clockTop>=result.textBottom,full,JSON.stringify(result));
        }
      }
    }
  }
  fixture.outbox[0].state="sent";
  fixture.outbox[0].relayId="relay_fixture";
  await page.evaluate(input=>onPayload(input),fixture);
  assert.equal((await inspect())[0].label,"Sent");
  fixture.sent=[{relayId:"relay_fixture",threadId:"thread_fixture",createdAt:"2026-09-10T22:50:53Z",state:"delivered",kind:"message",title:"",forHuman:fixture.outbox[0].text,forAgent:"",recipient:{name:"Test",email:"test@example.com"}}];
  fixture.outbox=[];
  await page.evaluate(input=>onPayload(input),fixture);
  const [delivered]=await inspect();
  assert.equal(delivered.label,"Delivered");
  assert.equal(delivered.opacity,"0.75");
  assert.equal(delivered.animation,"none");
  assert.equal(delivered.clock,"00:50");
  fixture.outbox=[{id:"photo-send",createdAt:"2026-09-10T22:51:01Z",state:"queued",attempts:1,lastError:"",text:"",
    files:[{name:"photo.png",size:68,contentType:"image/png"}],
    chat:{threadId:"thread_fixture",party:"Test",partyKey:"email:test@example.com"},recipient:{email:"test@example.com"}}];
  await page.evaluate(input=>{ window.viewerCalls=[]; window.relay.openAttachmentViewer=async(...args)=>{window.viewerCalls.push(args);return {ok:true};}; onPayload(input); },fixture);
  const photoTime=page.locator('.th-cargo-time');
  assert.equal(await photoTime.textContent(),"00:51");
  assert.equal(await photoTime.isVisible(),true);
  await page.locator('.ca-photo[data-att-id="file-0"]').click();
  assert.equal(await page.evaluate(()=>window.viewerCalls.length),1);
  assert.equal(await page.evaluate(()=>window.viewerCalls[0][0]),"outbox:photo-send");
  assert.deepEqual(errors,[]);
  console.log("PASS: actual renderer, two-line reservations, clock stability, both themes, refreshes, and Sending → Sent → Delivered without hidden states.");
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
