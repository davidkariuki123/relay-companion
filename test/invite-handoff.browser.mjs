// Real renderer with in-memory IPC. Never modifies an installed Companion.
// RELAY_PLAYWRIGHT_MODULE may point to a local Playwright installation.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, ...(process.env.RELAY_CHROME_CHANNEL ? {channel:process.env.RELAY_CHROME_CHANNEL} : {})});
try {
 const page = await browser.newPage({viewport:{width:500,height:680},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.fixture={account:{paired:true,email:'test@example.com',userId:'test'},ui:{canDismiss:true,onboardingRequired:true,onboardingVersion:2,firstRelayStatus:'waiting'},relays:[],sent:[],contacts:[],chats:[],outbox:[],features:{}};
  window.copies=0;window.completed=0;
  window.relay=new Proxy({isTestOverlay:true,platform:'darwin',refresh:async()=>window.fixture,onInbox:cb=>{window.deliver=cb;},
   copyOnboardingInviteLink:async()=>{window.copies++;return window.copyFailure ? {ok:false,error:'Copy failed. Try again.'} : {ok:true,url:'https://sendrelays.com/i/example'};},
   completeSetupTutorial:async()=>{window.completed++;return {ok:true,version:2};}
  },{get:(t,k)=>k in t?t[k]:(...args)=>Promise.resolve({})});
 });
 await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
 await page.locator('.su-first-relay').waitFor();
 await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>{window.fixture.ui.firstRelayStatus='sent';window.deliver(window.fixture);});
 assert.equal(await page.locator('#signupBody h1').innerText(),'Your first Relay is sent.');
 await page.getByRole('button',{name:'Open Relay',exact:true}).click();
 assert.equal(await page.locator('#signupBody h1').innerText(),'Send Relays to everyone you work with.');
 assert.equal(await page.evaluate(()=>window.completed),0);
 await page.evaluate(()=>{window.inviteNode=document.querySelector('.su-invite');window.deliver(window.fixture);window.copyFailure=true;});
 await page.getByRole('button',{name:'Copy invitation',exact:true}).click();
 await page.locator('#suInviteError:not([hidden])').waitFor();
 await page.waitForFunction(()=>{const el=document.getElementById('signupBody');return el.scrollHeight<=el.clientHeight;});
 assert.equal(await page.locator('#suInviteOpen').innerText(),'Maybe later');
 assert.equal(await page.locator('#signupBody').evaluate(el=>el.scrollHeight<=el.clientHeight),true);
 await page.evaluate(()=>{window.copyFailure=false;});
 for(let i=0;i<3;i++) {
  await page.locator('#suInviteCopy').click();
  await page.getByRole('button',{name:'Copy again',exact:true}).waitFor();
  assert.equal(await page.locator('#suInviteCopy').isEnabled(),true);
 }
 assert.equal(await page.evaluate(()=>window.copies),4);
 assert.match(await page.locator('#suInviteHint').innerText(),/Share it with everyone you want to invite to Relay\./);
 await page.evaluate(()=>window.deliver(window.fixture));
 assert.equal(await page.evaluate(()=>window.inviteNode===document.querySelector('.su-invite')),true);
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  if(process.env.RELAY_SCREENSHOT_DIR)await page.locator('#card').screenshot({path:process.env.RELAY_SCREENSHOT_DIR+'/invite-implemented-'+theme+'.png'});
  assert.equal(await page.locator('#signupBody').evaluate(el=>el.scrollHeight<=el.clientHeight),true,'fits native card');
  const box=await page.locator('#card').boundingBox();assert.equal(box.width,344);assert.equal(box.height,524);
  if(process.env.RELAY_SCREENSHOT_DIR)await page.locator('#card').screenshot({path:process.env.RELAY_SCREENSHOT_DIR+'/invite-implemented-'+theme+'.png'});
 }
 assert.equal(await page.locator('.su-invite-hero i').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.locator('#suInviteOpen').click();
 assert.equal(await page.evaluate(()=>window.completed),1);
 assert.equal(await page.locator('#signupView').evaluate(el=>el.classList.contains('gone')),true);
 // A new account does not inherit the invitation chapter or its copied state.
 await page.evaluate(()=>{window.fixture.account.userId='other';window.fixture.ui.firstRelayStatus='waiting';window.deliver(window.fixture);});
 assert.match(await page.locator('#signupBody h1').innerText(),/Follow the instructions/);
 await page.evaluate(()=>{window.fixture.ui.firstRelayStatus='sent';window.deliver(window.fixture);});
 await page.getByRole('button',{name:'Open Relay',exact:true}).click();
 assert.equal(await page.locator('#suInviteOpen').innerText(),'Maybe later');
 assert.equal(await page.locator('#signupBody').evaluate(el=>el.scrollHeight<=el.clientHeight),true);
 await page.locator('#suInviteOpen').click();
 assert.equal(await page.evaluate(()=>window.completed),2);
 assert.deepEqual(errors,[]);
 console.log('PASS: celebration → invitation → copy failure/retry/recopy → completion; refresh stability, account isolation, skip, native dimensions, both themes and reduced motion.');
} finally {await browser.close();}
