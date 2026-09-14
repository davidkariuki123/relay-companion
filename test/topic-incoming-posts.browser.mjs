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
    const post = (n, extra = {}) => ({ id:`tpst_${n}`, topicId, author:{relayUserId:'usr_other',name:'David Kariuki'}, origin:'agent', nature:'finding',
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
      topicPosts:async(_id, input = {})=>{
        const since = input.since ? Date.parse(input.since) : null;
        const posts = window.fixturePosts.filter((p) => since === null || Date.parse(p.createdAt) > since);
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
  await page.locator('[data-topic-post="tpst_12"]').waitFor();
  const board = () => page.evaluate(() => ({
    posts:[...document.querySelectorAll('[data-topic-post]')].map((el) => el.getAttribute('data-topic-post')),
    scrollTop:document.getElementById('scroll').scrollTop,
    pill:document.querySelector('[data-topic-incoming]')?.textContent || '',
    draft:document.querySelector('[data-topic-compose-form] input[name=title]')?.value ?? null,
  }));
  const wake = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // Nothing new: no pill.
  await wake();
  await page.waitForTimeout(150);
  assert.equal((await board()).pill, '');

  // A half-written post and a scrolled board.
  await page.locator('[data-topic-compose]').click();
  await page.locator('[data-topic-compose-form] input[name=title]').fill('My unsent draft');
  await page.evaluate(() => { document.getElementById('scroll').scrollTop = 600; });
  const before = await board();
  assert.ok(before.scrollTop > 0, 'the board scrolls');

  // Another member's agent posts; the board is told, and nothing moves.
  await page.evaluate(() => window.fixturePosts.unshift(window.fixtureMakePost(13)));
  await wake();
  await page.locator('[data-topic-incoming]').waitFor();
  let now = await board();
  assert.equal(now.pill, '1 new post');
  assert.deepEqual(now.posts, before.posts, 'the list is not redrawn under the reader');
  assert.equal(now.scrollTop, before.scrollTop, 'scroll position is kept');
  assert.equal(now.draft, 'My unsent draft', 'the draft survives');
  assert.equal(await page.locator('[data-topic-incoming]').evaluate((el) => {
    const r = el.getBoundingClientRect(); const s = document.getElementById('scroll').getBoundingClientRect();
    return r.top >= s.top && r.bottom <= s.bottom;
  }), true, 'the pill is on screen while scrolled');
  await page.locator('[data-topic-incoming]').evaluate(async (el) => { await Promise.all(el.getAnimations().map((a) => a.finished)); el.dataset.fixtureFirst = '1'; });

  // An agent-only post is not counted in the people lane; a second human post is.
  await page.evaluate(() => {
    window.fixturePosts.unshift(window.fixtureMakePost(14, { forHuman:'' }));
    window.fixturePosts.unshift(window.fixtureMakePost(15));
  });
  await wake();
  await page.waitForFunction(() => document.querySelector('[data-topic-incoming]')?.textContent === '2 new posts');
  now = await board();
  assert.equal(now.draft, 'My unsent draft');
  assert.equal(now.scrollTop, before.scrollTop);
  // Updating the count keeps the same pill: it does not flash in again.
  assert.equal(await page.locator('[data-topic-incoming]').evaluate((el) => el.dataset.fixtureFirst === '1' && el.getAnimations().length === 0
    && Number(getComputedStyle(el).opacity) > 0.99 && el.getBoundingClientRect().height >= 20), true, 'the same pill, fully shown at its real size');
  if (process.env.RELAY_SCREENSHOT_DIR) await page.screenshot({ path:`${process.env.RELAY_SCREENSHOT_DIR}/topic-incoming-posts.png` });

  // Checking again finds nothing further: no double counting.
  await wake();
  await page.waitForTimeout(150);
  assert.equal((await board()).pill, '2 new posts');

  // Tapping it is the read: new posts on top, board at its top, watermark moved, pill gone.
  await page.locator('[data-topic-incoming]').click();
  await page.waitForFunction(() => !document.querySelector('[data-topic-incoming]'));
  now = await board();
  assert.deepEqual(now.posts.slice(0, 3), ['tpst_15', 'tpst_13', 'tpst_12']);
  assert.equal(now.scrollTop, 0);
  assert.equal(await page.evaluate(() => window.fixtureSeen), 1);
  await page.locator('[data-topic-lane="agent"]').click();
  assert.deepEqual((await board()).posts.slice(0, 3), ['tpst_15', 'tpst_14', 'tpst_13'], 'the agent lane holds the agent-only post');

  assert.deepEqual(errors, []);
  console.log('topic incoming posts: ok');
} finally {
  await browser.close();
}
