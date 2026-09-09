// Real pill renderer, in-memory IPC. No account, installation or delivery changes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:850,height:850}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureEvents = {};
    window.fixtureWrites = [];
    window.fixtureFail = false;
    window.fixturePayload = {account:{paired:true,userId:'a',name:'Preview Person',email:'preview@example.test'},
      ui:{canDismiss:true,onboardingRequired:true,onboardingVersion:2,completedOnboardingVersion:2,
        networkOnboarding:{required:true,checking:false,version:2}},features:{},relays:[],sent:[],contacts:[],chats:[]};
    const api = {isTestOverlay:true, refresh:async () => structuredClone(window.fixturePayload),
      contacts:async () => [], groups:async () => ({ok:true,result:[]}),
      copyOnboardingInviteLink:async userId => {window.fixtureWrites.push(['copy',userId]); return {ok:true};},
      completeNetworkOnboarding:async userId => {
        window.fixtureWrites.push(['complete',userId]);
        if(window.fixtureFail) throw Error('offline');
        if(window.fixturePending) return new Promise(resolve => {window.fixtureResolve = resolve;});
        window.fixturePayload.ui.onboardingRequired = false;
        window.fixturePayload.ui.networkOnboarding.required = false;
        return {ok:true,userId,version:2};
      },
    };
    window.relay = new Proxy(api,{get:(target,key) => {
      if(key in target) return target[key];
      if(String(key).startsWith('on')) return callback => {window.fixtureEvents[key]=callback;return () => {};};
      return async () => ({ok:true});
    }});
  });
  await page.goto(new URL('../overlay/inbox.html',import.meta.url).href);
  await page.locator('#suNetworkCopy').waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
  assert.equal(await page.locator('#signupView').getByText('Grow your network.').isVisible(), true);
  await page.locator('#suNetworkCopy').click();
  await page.getByText('Link copied. Paste it wherever you talk to them.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [['copy','a']]);
  assert.equal(await page.locator('#suNetworkContinue').isVisible(), true, 'copying is not completion');
  if(process.env.RELAY_ONBOARDING_SCREENSHOT) await page.locator('#card').screenshot({path:process.env.RELAY_ONBOARDING_SCREENSHOT});
  await page.evaluate(() => {window.fixtureFail = true;});
  await page.locator('#suNetworkContinue').click();
  await page.getByText('Relay couldn’t save your progress. Check your connection and try again.').waitFor();
  await page.evaluate(() => {window.fixtureFail = false;});
  await page.locator('#suNetworkSkip').click();
  await page.locator('#suNetworkSkip').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [['copy','a'],['complete','a'],['complete','a']]);
  // A second account must get its own invitation step, without the copied/error state.
  await page.evaluate(() => {
    const p = window.fixturePayload;
    p.account.userId = 'b'; p.ui.onboardingRequired = true; p.ui.networkOnboarding.required = true;
    window.fixtureEvents.onInbox(structuredClone(p));
  });
  await page.locator('#suNetworkCopy').waitFor();
  assert.equal(await page.locator('#suNetworkCopy').textContent(), 'Copy invite link');
  await page.evaluate(() => {window.fixturePending = true;});
  await page.locator('#suNetworkContinue').click();
  await page.waitForFunction(() => typeof window.fixtureResolve === 'function');
  await page.evaluate(() => {
    window.fixturePayload.account.userId = 'c';
    window.fixtureEvents.onInbox(structuredClone(window.fixturePayload));
    window.fixtureResolve({ok:true,userId:'b',version:2});
  });
  await page.locator('#suNetworkContinue:not([disabled])').waitFor();
  assert.equal(await page.locator('#suNetworkCopy').isVisible(), true, 'late completion never dismisses another account');
  assert.deepEqual(errors, []);
  console.log('Network onboarding renderer: copy, retry, skip and account-switch checks passed.');
} finally {await browser.close();}
