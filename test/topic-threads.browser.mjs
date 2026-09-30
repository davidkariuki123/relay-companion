// Run with RELAY_PLAYWRIGHT_MODULE pointing at an installed Playwright module.
// Uses the real renderer and in-memory IPC; never changes an installed app/account.
// The overview refreshes at the top, including own-agent posts and edits.
// Reading farther down or writing a search keeps the UI in place behind an
// update button. Also exercises thread navigation and splitting.
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
    window.fixtureThreadVersion = 1;
    window.fixtureThreadSummary = 'David found a blocker; a fix awaits release.';
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
      topicThreads:async(_id,input={})=>({ok:true,result:{topic:summary(),threads:[{id:input.threadId || (window.fixtureMoved ? "tpth_separate" : "tpth_fixture"),title:"Windows readiness",summary:window.fixtureThreadSummary,summaryAuthor:{name:"David"},summaryOrigin:"agent",status:"open",postCount:window.fixturePosts.length,contributorCount:2,version:window.fixtureThreadVersion,attentionAt:at(12)}]}}),
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
  // Own-agent updates have no unread badge; edits can retain attentionAt.
  // The open overview must still refresh without leaving and re-entering.
  await page.evaluate(() => {
    window.fixtureThreadVersion++;
    window.fixtureThreadSummary = 'The live infrastructure investigation is complete.';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-thread-open="tpth_fixture"]')?.textContent.includes('investigation is complete'));
  assert.equal(await page.evaluate(() => window.fixtureSeen), 0, 'background refresh does not mark the topic read');
  assert.equal(await page.locator('[data-topic-incoming]').count(), 0, 'top-of-overview refresh needs no extra click');

  // The visible board's timer also detects a new own-agent post, without a
  // visibility event, unread count, or change to the thread's attention time.
  await page.evaluate(() => {
    window.fixtureThreadVersion++;
    window.fixturePosts.unshift(window.fixtureMakePost(13, {author:{relayUserId:'usr_self',name:'Preview Person'}}));
  });
  await page.waitForFunction(() => document.querySelector('[data-thread-open="tpth_fixture"]')?.textContent.includes('13 posts'));

  // An unfinished search survives arrival, with a visible update affordance.
  await page.locator('[data-thread-search] input').fill('unfinished search');
  await page.evaluate(() => {
    window.fixtureThreadVersion++;
    window.fixtureThreadSummary = 'Another update arrived while writing a search.';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('[data-topic-incoming]').waitFor();
  assert.equal(await page.locator('[data-thread-search] input').inputValue(), 'unfinished search');
  assert.ok((await page.locator('[data-thread-open="tpth_fixture"]').textContent()).includes('investigation is complete'));
  // A transient API error must not erase the pending update indicator.
  await page.evaluate(() => {
    window.fixtureOriginalThreads = window.relay.topicThreads;
    window.relay.topicThreads = async () => ({ok:false,error:'Temporary outage'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-topic-incoming]').count(), 1);
  await page.evaluate(() => { window.relay.topicThreads = window.fixtureOriginalThreads; });
  await page.locator('[data-topic-incoming]').click();
  await page.waitForFunction(() => document.querySelector('[data-thread-open="tpth_fixture"]')?.textContent.includes('while writing a search'));

  await page.locator('[data-thread-search] input').fill('Windows');
  await page.locator('[data-thread-search] button').click();
  await page.locator('[data-thread-open="tpth_fixture"]').click();
  await page.locator('[data-topic-post="tpst_12"]').waitFor();
  assert.equal(await page.locator('[data-topic-compose]').count(),0,'topics are agent-authored: no New thread or Add update');
  await page.locator('[data-topic-move="tpst_12"]').click();
  await page.locator('[data-topic-move-form] input[name=title]').fill('Separate investigation');
  await page.locator('[data-topic-move-form] button[type=submit]').click();
  await page.waitForFunction(()=>window.fixtureMoved);
  assert.deepEqual(await page.evaluate(()=>window.fixtureMoved.postIds),['tpst_12']);
  assert.equal(await page.evaluate(()=>window.fixtureMoved.expectedVersion),4);
  assert.equal(await page.locator('[data-topic-post="tpst_12"]').count(),1);
  await page.locator('[data-thread-back]').click();
  await page.locator('[data-thread-open="tpth_separate"]').waitFor();
  // Keep an overview reader's position too, not just a reader inside a thread.
  await page.evaluate(() => {
    window.fixtureThreadVersion++;
    window.fixtureThreadSummary = 'Long overview context.';
    const getThreads = window.relay.topicThreads;
    window.relay.topicThreads = async (...args) => {
      const response = await getThreads(...args);
      const first = response.result.threads[0];
      response.result.threads.push(...Array.from({length:8}, (_, i) => ({...first,id:'tpth_older_' + i,title:'Older investigation ' + i})));
      return response;
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-thread-open="tpth_separate"]')?.textContent.includes('Long overview context'));
  await page.evaluate(() => {
    document.getElementById('scroll').scrollTop = 180;
    document.querySelector('[data-thread-open="tpth_separate"]').dataset.fixturePreserved = 'yes';
  });
  const overviewScroll = await page.locator('#scroll').evaluate(el => el.scrollTop);
  assert.ok(overviewScroll > 0);
  await page.evaluate(() => {
    window.fixtureThreadVersion++;
    window.fixtureThreadSummary = 'Update received while reading farther down.';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('[data-topic-incoming]').waitFor();
  assert.equal(await page.locator('#scroll').evaluate(el => el.scrollTop), overviewScroll);
  assert.equal(await page.locator('[data-thread-open="tpth_separate"]').getAttribute('data-fixture-preserved'), 'yes');
  await page.locator('[data-topic-incoming]').click();
  await page.waitForFunction(() => document.querySelector('[data-thread-open="tpth_separate"]')?.textContent.includes('farther down'));
  if(process.env.RELAY_SCREENSHOT_DIR) await page.screenshot({path:process.env.RELAY_SCREENSHOT_DIR+'/topic-threads.png'});
  assert.deepEqual(errors,[]);
  console.log('topic thread overview, append and split: ok');
} finally { await browser.close(); }