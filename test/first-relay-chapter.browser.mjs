// Real pill renderer, in-memory IPC. The chapter after the first send
// (2026-09-13): celebration (auto-advance or Continue), Your first link,
// Grow your network, Open Relay. No account, installation or delivery changes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:850,height:850}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__relayCelebrationMs = 700;
    window.fixtureEvents = {};
    window.fixtureWrites = [];
    window.fixtureCopies = [];
    window.fixturePayload = {account:{paired:true,userId:'a',name:'Preview Person',email:'preview@example.test'},
      ui:{canDismiss:true,onboardingRequired:true,onboardingVersion:2,completedOnboardingVersion:0,
        firstRelayStatus:'sent',firstRelayId:'r_hello',firstLink:null,
        networkOnboarding:{required:false,checking:false,version:2}},features:{},relays:[],
      sent:[{relayId:'r_hello',createdAt:'2026-09-13T10:00:00Z',state:'delivered',recipient:{name:'Taylor',email:'taylor@example.test'}}],contacts:[],chats:[]};
    const api = {isTestOverlay:true, refresh:async () => structuredClone(window.fixturePayload),
      contacts:async () => [], groups:async () => ({ok:true,result:[]}),
      copyOnboardingInviteLink:async userId => {window.fixtureWrites.push(['copy',userId]); return {ok:true};},
      copyFirstLinkMessage:async userId => {
        if (window.fixtureCopyFailure) throw Error('clipboard unavailable');
        window.fixtureCopies.push(userId); return {ok:true};
      },
      completeSetupTutorial:async () => {
        window.fixtureWrites.push(['complete-local']);
        if(window.fixtureFail) return {ok:false};
        window.fixturePayload.ui.onboardingRequired = false;
        window.fixturePayload.ui.completedOnboardingVersion = 2;
        return {ok:true,version:2};
      },
      completeNetworkOnboarding:async userId => { window.fixtureWrites.push(['complete-network',userId]); return {ok:true,userId,version:2}; },
    };
    window.relay = new Proxy(api,{get:(target,key) => {
      if(key in target) return target[key];
      if(String(key).startsWith('on')) return callback => {window.fixtureEvents[key]=callback;return () => {};};
      return async () => ({ok:true});
    }});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  const push = (mutate) => page.evaluate((source) => { const p = window.fixturePayload; (new Function('p', source))(p); window.fixtureEvents.onInbox(structuredClone(p)); }, mutate);
  const shareText = "Here is where the plan stands. Read it and tell me what you'd change.\n\nPaste this into your Claude Code or Codex and it'll fetch the full relay: https://sendrelays.com/s/practice_first_link";

  // 1. The celebration: moving squares, a countdown bar, Continue.
  await page.locator('#suCelebrationContinue').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Your first Relay is sent.').isVisible(), true);
  assert.equal(await page.locator('.su-relay-moment i').count(), 3);
  assert.equal(await page.locator('.su-countdown > span').count(), 1);
  assert.equal(await page.locator('#suCelebrationContinue').textContent(), 'Continue');
  assert.equal(await page.locator('.su-first-relay-sent').evaluate(el => getComputedStyle(el).getPropertyValue('--su-countdown-ms').trim()), '700ms');
  // The bar is animated over the celebration's length (the test shortens it).
  assert.equal(await page.locator('.su-countdown > span').evaluate(el => getComputedStyle(el).animationDuration), '0.7s');
  assert.equal(await page.locator('.su-relay-moment i').first().evaluate(el => getComputedStyle(el).animationName), 'su-first-send, su-relay-hop');

  // 2. It advances on its own: Your first link, waiting for the agent.
  await page.locator('#suLinkSkip').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Now relay someone who isn’t on Relay.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('This screen updates when your link is ready.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('make you a relay about something you’re working on').isVisible(), true);
  assert.equal(await page.locator('#suCelebrationContinue').count(), 0);

  // 3. The account's history shows the minted link: the message to send appears.
  await push(`p.sent.push({relayId:'r_link',createdAt:'2026-09-13T10:05:00Z',state:'pending',recipient:{name:'Priya'},shareLink:{id:'shl_1',url:'https://sendrelays.com/s/practice_first_link',state:'unopened'}});
    p.ui.firstLink = {relayId:'r_link',url:'https://sendrelays.com/s/practice_first_link',state:'unopened',shareText:${JSON.stringify(shareText)}};`);
  await page.locator('#suLinkCopy').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Your link is ready.').isVisible(), true);
  assert.equal(await page.locator('#suFirstLinkText').innerText(), shareText);
  assert.equal(await page.locator('#suLinkCopy').textContent(), 'Copy message');
  assert.equal(await page.locator('#suLinkContinue').textContent(), 'Continue');
  await page.evaluate(() => {window.fixtureCopyFailure = true;});
  await page.locator('#suLinkCopy').click();
  await page.getByText('The message couldn’t be copied. Select the text above and copy it.').waitFor();
  await page.evaluate(() => {window.fixtureCopyFailure = false;});
  await page.locator('#suLinkCopy').click();
  await page.locator('#suLinkCopy:has-text("Copied")').waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureCopies), ['a']);
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [], 'copying never completes onboarding');

  // 4. Grow your network is last; Open Relay ends onboarding and opens Relays.
  await page.locator('#suLinkContinue').click();
  await page.locator('#suNetworkContinue').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Grow your network.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('Last step').isVisible(), true);
  assert.equal(await page.locator('#suNetworkContinue').textContent(), 'Open Relay');
  assert.equal(await page.locator('#suTutorialCopy').count(), 0);
  const footerInCard = () => page.locator('#suNetworkContinue').evaluate(el => {
    const button = el.getBoundingClientRect(), card = document.getElementById('card').getBoundingClientRect();
    return button.top >= card.top && button.bottom <= card.bottom;
  });
  assert.equal(await footerInCard(), true);
  await page.locator('#suNetworkCopy').click();
  await page.getByText('Link copied. Paste it wherever you talk to them.').waitFor();
  await page.evaluate(() => {window.fixtureFail = true;});
  await page.locator('#suNetworkContinue').click();
  await page.getByText('Relay couldn’t save your progress. Check your connection and try again.').waitFor();
  await page.evaluate(() => {window.fixtureFail = false;});
  await page.locator('#suNetworkContinue').click();
  await page.locator('#suNetworkContinue').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [['copy','a'],['complete-local'],['complete-local']]);
  assert.equal(await page.locator('#signupView').isVisible(), false, 'onboarding is over');

  // 5. A second account whose first send was itself a link starts at the
  //    ready screen: there is no hello to celebrate. Continue on the
  //    celebration skips the wait for a third account.
  await push(`p.account.userId = 'b'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0; p.ui.firstRelayId = 'r_link';`);
  await page.locator('#suLinkCopy').waitFor();
  assert.equal(await page.locator('#suCelebrationContinue').count(), 0, 'a link-first account has no celebration');
  await page.evaluate(() => { window.__relayCelebrationMs = 60000; });
  await push(`p.account.userId = 'c'; p.ui.firstRelayId = 'r_hello'; p.ui.firstLink = null;`);
  await page.locator('#suCelebrationContinue').waitFor();
  await page.locator('#suCelebrationContinue').click();
  await page.locator('#suLinkSkip').waitFor();
  await page.locator('#suLinkSkip').click();
  await page.locator('#suNetworkContinue').waitFor();
  assert.equal(await page.locator('#suNetworkCopy').textContent(), 'Copy invite link', 'a new account gets its own uncopied state');

  // 6. A pending invitation chapter completes on the server instead.
  await push(`p.ui.networkOnboarding.required = true;`);
  await page.locator('#suNetworkContinue').click();
  await page.locator('#suNetworkContinue').waitFor({state:'hidden'});
  const writes = await page.evaluate(() => window.fixtureWrites);
  assert.deepEqual(writes.at(-1), ['complete-network','c']);
  assert.deepEqual(errors, []);
  console.log('First-relay chapter renderer: celebration, first link, Grow your network and Open Relay checks passed.');
} finally {await browser.close();}
