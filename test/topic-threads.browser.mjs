// Run with RELAY_PLAYWRIGHT_MODULE pointing at an installed Playwright module.
// Uses the real renderer and in-memory IPC; never changes an installed app/account.
// An open topic board learns about posts made elsewhere (another member, or the
// person's own agent) as an "N new posts" pill; the list, scroll and a draft stay
// put until the person taps it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE} : {}) });
try {
  const page = await browser.newPage({ viewport:{width:420,height:640} });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const topicId = 'tpc_fixture';
    const at = (minutes) => new Date(Date.UTC(2026, 8, 14, 10, minutes)).toISOString().replace('Z', '+00:00');
    const post = (n, extra = {}) => ({ id:`tpst_${n}`, threadId:"tpth_fixture", topicId, author:{relayUserId:'usr_other',name:'David Kariuki'}, origin:'agent', nature:'finding',
      title:`Post ${n}`, forHuman:`Human words for post ${n}. `.repeat(8), forAgent:`Agent words ${n}`, createdAt:at(n), updatedAt:at(n), editedAt:null, ...extra });
    window.fixturePosts = Array.from({ length:12 }, (_, i) => post(i + 1)).reverse();
    window.fixtureMakePost = post;
    window.fixtureSeen = 0;
    window.fixtureEvents = {};
    const membership = { role:'admin', state:'active', approvedMandateVersion:1, mandateCurrent:true, postConfirmation:'auto' };
    const summary = () => ({ id:topicId, name:'Dev work and deploys', mandate:'Engineering.', mandateVersion:1, memberCount:3, adminCount:1,
      postCount:window.fixturePosts.length, newPostCount:0, latestPostAt:window.fixturePosts[0].createdAt, archivedAt:null, membership });
    window.fixturePayload = { account:{paired:true,userId:'usr_self',name:'Preview Person',email:'preview@example.com',hasSentRelay:true},
      ui:{canDismiss:true,onboardingRequired:false,completedOnboardingVersion:1,topicStandingRules:[]}, features:{topics:true},
      relays:[], sent:[], requests:[], chats:[], slackChats:[] };
    const api = {
      isTestOverlay:true,
      refresh:async()=>structuredClone(window.fixturePayload),
      refreshSent:async()=>({items:[]}),
      contacts:async()=>[],
      groups:async()=>({ok:true,result:[]}),
      accountInfo:async()=>structuredClone(window.fixturePayload.account),
      agentSurfaces:async()=>({}),
      topicsList:async()=>({ok:true,result:[summary()]}),
      topicGet:async()=>({ok:true,result:{...summary(),members:[]}}),
      topicSeen:async()=>{ window.fixtureSeen++; return {ok:true,result:summary()}; },
      topicThreads:async(_id,input={})=>({ok:true,result:{topic:summary(),threads:[{id:input.threadId || (window.fixtureMoved ? "tpth_separate" : "tpth_fixture"),title:"Windows readiness",summary:"David found a blocker; a fix awaits release.",summaryAuthor:{name:"David"},summaryOrigin:"agent",status:"open",postCount:window.fixturePosts.length,contributorCount:2,version:1,attentionAt:at(12)}]}}),
      topicPostCreate:async(_id,input)=>{ window.fixtureCreated=input; const p=post(99,{...input,author:{relayUserId:'usr_self',name:'Preview Person'}}); window.fixturePosts.unshift(p);return {ok:true,result:{post:p}}; },
      topicMovePosts:async(_id,_thread,input)=>{window.fixtureMoved=input; for(const p of window.fixturePosts) if(input.postIds.includes(p.id))p.threadId='tpth_separate';return {ok:true,result:{threadId:'tpth_separate'}};},
      topicPosts:async(_id, input = {})=>{
        const since = input.since ? Date.parse(input.since) : null;
        const posts = window.fixturePosts.filter((p) => (!input.threadId || p.threadId === input.threadId) && (since === null || Date.parse(p.updatedAt) > since));
        return {ok:true,result:{topic:summary(),posts:structuredClone(posts.slice(0, 50)),nextCursor:posts.length > 50 ? 'more' : null}};
      },
    };
    window.relay=new Proxy(api,{get:(target,key)=>{
      if(key in target) return target[key];
      if(String(key).startsWith('on')) return callback=>{window.fixtureEvents[key]=callback;return ()=>{};};
      return async()=>({ok:true});
    }});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.locator('.tab[data-view="topics"]').click();
  await page.locator('[data-topic-open="tpc_fixture"]').click();
  await page.locator('[data-thread-open="tpth_fixture"]').waitFor();
  assert.equal(await page.locator('[data-topic-post]').count(),0,'overview shows compact summaries, not full posts');
  await page.locator('[data-thread-search] input').fill('Windows');
  await page.locator('[data-thread-search] button').click();
  await page.locator('[data-thread-open="tpth_fixture"]').click();
  await page.locator('[data-topic-post="tpst_12"]').waitFor();
  await page.locator('[data-topic-compose]').click();
  await page.locator('[data-topic-compose-form] input[name=title]').fill('More evidence');
  await page.locator('[data-topic-compose-form] textarea').fill('The trace confirms the original finding.');
  await page.locator('[data-topic-compose-form] select[name=importance]').selectOption('detail');
  await page.locator('[data-topic-compose-form] button[type=submit]').click();
  await page.locator('[data-topic-post="tpst_99"]').waitFor();
  const posted=await page.evaluate(()=>window.fixtureCreated);
  assert.equal(posted.threadId,'tpth_fixture'); assert.equal(posted.importance,'detail');
  await page.locator('[data-topic-move="tpst_99"]').click();
  await page.locator('[data-topic-move-form] input[name=title]').fill('Separate investigation');
  await page.locator('[data-topic-move-form] button[type=submit]').click();
  await page.waitForFunction(()=>window.fixtureMoved);
  assert.deepEqual(await page.evaluate(()=>window.fixtureMoved.postIds),['tpst_99']);
  assert.equal(await page.evaluate(()=>window.fixtureMoved.expectedVersion),1);
  assert.equal(await page.locator('[data-topic-post="tpst_99"]').count(),1);
  await page.locator('[data-thread-back]').click();
  await page.locator('[data-thread-open="tpth_separate"]').waitFor();
  if(process.env.RELAY_SCREENSHOT_DIR) await page.screenshot({path:process.env.RELAY_SCREENSHOT_DIR+'/topic-threads.png'});
  assert.deepEqual(errors,[]);
  console.log('topic thread overview, append and split: ok');
} finally { await browser.close(); }