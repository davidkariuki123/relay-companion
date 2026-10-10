// Real pill renderer, in-memory IPC. The chapter after the first send
// (2026-09-13, trimmed 2026-10-10): a hello is celebrated (auto-advance or
// Continue) and the chapter ends by itself; a first Relay that was a link
// lands on It's ready to send. No second link lesson, no Grow your network.
// Then the Get started path (no inviter): the handoff asks for a link, and a
// pill opened by setup signs in on its own, once. No account, installation
// or delivery changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
      copyFirstLink:async userId => {
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

  // 2. It advances on its own and the chapter ends: no link lesson, no Grow
  //    your network. A failure to save offers Try again.
  await page.evaluate(() => {window.fixtureFail = true;});
  await page.locator('#suFinishRetry').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Relay couldn’t save your progress. Check your connection and try again.').isVisible(), true);
  assert.equal(await page.locator('#suLinkSkip').count(), 0);
  assert.equal(await page.locator('#suNetworkContinue').count(), 0);
  await page.evaluate(() => {window.fixtureFail = false;});
  await page.locator('#suFinishRetry').click();
  await page.locator('#signupView').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites), [['complete-local'],['complete-local']]);

  // 3. An account whose first Relay was a link lands on It's ready to send,
  //    with the moment and the link, and no celebration screen of its own.
  const linkUrl = 'https://sendrelays.com/s/first_link_only';
  await push(`p.account.userId = 'b'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.sent.push({relayId:'r_link_only',createdAt:'2026-09-13T11:00:00Z',state:'pending',recipient:{name:'Sam'},shareLink:{id:'shl_2',url:'${linkUrl}',state:'unopened'}});
    p.ui.firstRelayStatus = 'sent'; p.ui.firstRelayId = 'r_link_only';
    p.ui.firstLink = {relayId:'r_link_only',url:'${linkUrl}',state:'unopened',shareText:'Here is the brief.\\n\\n${linkUrl}'};`);
  await page.locator('#suLinkCopy').waitFor();
  assert.equal(await page.locator('#suCelebrationContinue').count(), 0, 'no separate celebration screen');
  assert.equal(await page.locator('.su-first-link.su-first-relay-sent .su-relay-moment i').count(), 3, 'the moment lands on the ready screen');
  assert.equal(await page.locator('#signupView').getByText('It’s ready to send.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('Send the link to whoever should review it. They read and reply in their browser, with nothing to install.').isVisible(), true);
  assert.equal(await page.locator('#suFirstLinkUrl').inputValue(), linkUrl);
  assert.equal(await page.locator('#suLinkCopy').textContent(), 'Copy link');
  assert.equal(await page.locator('#suLinkOpen').getAttribute('href'), linkUrl);
  assert.equal(await page.locator('#suLinkOpen').textContent(), 'Open it yourself');
  // Copy link changes the controls in place: the moment is not rebuilt.
  await page.evaluate(() => { document.querySelector('.su-first-link .su-relay-moment').dataset.probe = 'kept'; });
  await page.evaluate(() => {window.fixtureCopyFailure = true;});
  await page.locator('#suLinkCopy').click();
  await page.locator('.su-first-link .su-error').waitFor();
  assert.equal(await page.locator('.su-first-link .su-error').textContent(), 'The link couldn’t be copied. Select it above and copy it.');
  await page.evaluate(() => {window.fixtureCopyFailure = false;});
  await page.locator('#suLinkCopy').click();
  await page.locator('#suLinkCopy:has-text("Copied")').waitFor();
  await page.locator('.su-first-link .su-error').waitFor({state:'detached'});
  assert.equal(await page.locator('.su-first-link .su-relay-moment').getAttribute('data-probe'), 'kept', 'the moment was not rebuilt');
  assert.deepEqual(await page.evaluate(() => window.fixtureCopies), ['b']);
  assert.deepEqual((await page.evaluate(() => window.fixtureWrites)).length, 2, 'copying never completes onboarding');
  await page.locator('#suLinkContinue').click();
  await page.locator('#signupView').waitFor({state:'hidden'});
  assert.deepEqual((await page.evaluate(() => window.fixtureWrites)).at(-1), ['complete-local']);

  // 4. A pending invitation chapter completes on the server instead, still
  //    without a screen of its own; Continue on the celebration skips the wait.
  await page.evaluate(() => { window.__relayCelebrationMs = 60000; });
  await push(`p.account.userId = 'c'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.ui.firstRelayId = 'r_hello'; p.ui.firstLink = null; p.ui.networkOnboarding.required = true;`);
  await page.locator('#suCelebrationContinue').click();
  await page.locator('#signupView').waitFor({state:'hidden'});
  assert.deepEqual((await page.evaluate(() => window.fixtureWrites)).at(-1), ['complete-network','c']);

  // 5. GET STARTED with a chat AI or none chosen: the handoff asks for a link.
  await push(`p.account.userId = 'd'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.ui.firstRelayKind = 'link'; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null;
    p.ui.networkOnboarding.required = false;`);
  await page.locator('#signupView').getByText('Follow the instructions in').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Your first Relay', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('will help you make your first Relay link').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('The other person needs nothing installed.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('This screen updates when your link is ready.').isVisible(), true);
  assert.equal(await page.locator('#suHandoffSkip').textContent(), 'Skip for now', 'no inviter: the handoff is not a dead end');

  // 7b. A sign-in into an account with an empty history (no inviter, no agent
  //     conversation driving) can leave the handoff: Skip for now completes
  //     the local chapter. The hello handoff has no Skip.
  await push(`p.account.userId = 'e'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.ui.firstRelayKind = 'link'; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null; p.sent = [];`);
  await page.locator('#suHandoffSkip').waitFor();
  await page.locator('#suHandoffSkip').click();
  await page.locator('#suHandoffSkip').waitFor({state:'hidden'});
  assert.deepEqual((await page.evaluate(() => window.fixtureWrites)).at(-1), ['complete-local']);
  assert.equal(await page.locator('#signupView').isVisible(), false, 'Skip on the handoff ends the local chapter');
  await push(`p.account.userId = 'f'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.ui.firstRelayKind = 'hello'; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null; p.sent = [];`);
  await page.locator('#signupView').getByText('Your agent will help you send your first Relay.').waitFor();
  assert.equal(await page.locator('#suHandoffSkip').count(), 0, 'the invite path handoff is unchanged');
  assert.deepEqual(errors, []);
  console.log('First-relay chapter renderer: celebration, ready to send, finishing and Get started handoff checks passed.');

  // 8. A signed-out pill. Opened by "npx relay-companion setup" (the marker
  //    the main process reports as ui.agentInstalled), it starts the browser
  //    sign-in itself, exactly once. Without the marker, or with an approval
  //    already in flight, it waits for the person.
  const openSignedOut = async ({agentInstalled, authState, applicationOwned = false}) => {
    const signedOut = await browser.newPage({viewport:{width:850,height:850}});
    const pageErrors = [];
    signedOut.on('pageerror', error => pageErrors.push(error.message));
    await signedOut.addInitScript(({agentInstalled, authState, applicationOwned}) => {
      window.fixtureEvents = {};
      window.fixtureSignIns = [];
      window.fixtureStateReads = 0;
      window.fixturePayload = {account:{paired:false,credentialStatus:'unpaired',credentialError:'',credentialStore:'',email:'',name:'',userId:''},
        ui:{canDismiss:true,onboardingRequired:false,onboardingVersion:2,completedOnboardingVersion:0,
          agentInstalled,applicationOwned,
          firstRelayStatus:'checking',firstRelayId:'',firstLink:null,networkOnboarding:{required:false,checking:false,version:2}},
        features:{},relays:[],sent:[],contacts:[],chats:[]};
      const api = {isTestOverlay:true, refresh:async () => structuredClone(window.fixturePayload),
        contacts:async () => [], groups:async () => ({ok:true,result:[]}),
        installationAuthState:async () => { window.fixtureStateReads += 1; return structuredClone(authState); },
        installationAuthSignIn:async options => { window.fixtureSignIns.push(options); return {status:'pending_identity'}; },
      };
      window.relay = new Proxy(api,{get:(target,key) => {
        if(key in target) return target[key];
        if(String(key).startsWith('on')) return callback => {window.fixtureEvents[key]=callback;return () => {};};
        return async () => ({ok:true});
      }});
    }, {agentInstalled, authState, applicationOwned});
    await signedOut.goto(new URL('../overlay/inbox.html',import.meta.url).href);
    await signedOut.waitForFunction(() => window.fixtureStateReads > 0);
    return {signedOut, pageErrors};
  };
  const auto = await openSignedOut({agentInstalled:true, authState:{status:'idle'}});
  await auto.signedOut.locator('#signupView').getByText('Continue in your browser.').waitFor();
  assert.deepEqual(await auto.signedOut.evaluate(() => window.fixtureSignIns), [{forceAccountSelection:false}]);
  // Another payload while the pill waits for the browser must not start a second sign-in.
  await auto.signedOut.evaluate(() => window.fixtureEvents.onInbox(structuredClone(window.fixturePayload)));
  await auto.signedOut.waitForTimeout(250);
  assert.equal(await auto.signedOut.locator('#signupView').getByText('Continue in your browser.').isVisible(), true);
  assert.equal((await auto.signedOut.evaluate(() => window.fixtureSignIns)).length, 1, 'exactly one sign-in');
  assert.deepEqual(auto.pageErrors, []);
  await auto.signedOut.close();

  const manual = await openSignedOut({agentInstalled:false, authState:{status:'idle'}});
  // Relay is already installed wherever the pill runs, so no signed-out screen offers an agent setup prompt.
  await manual.signedOut.locator('#signupView').getByText('Sign in to get started.').waitFor();
  assert.equal(await manual.signedOut.locator('#suCopySetup').count(), 0, 'nothing for an agent to install');
  assert.equal((await manual.signedOut.locator('#suGoogle').textContent()).trim(), 'Continue with Google');
  assert.equal(await manual.signedOut.locator('#suSignIn').textContent(), 'Use email instead');
  await manual.signedOut.waitForTimeout(250);
  assert.deepEqual(await manual.signedOut.evaluate(() => window.fixtureSignIns), [], 'no marker: the person clicks Sign in');
  assert.equal(await manual.signedOut.locator('#signupView').getByText('Continue in your browser.').count(), 0);
  assert.deepEqual(manual.pageErrors, []);

  // 8b. A Relay the native application installer set up (ui.applicationOwned):
  //     Relay is already installed, so the screen leads with Continue with
  //     Google, keeps email as a link, shows no agent setup prompt, and opens
  //     no browser on its own (the installer's marker is not agentInstalled).
  const installed = await openSignedOut({agentInstalled:false, applicationOwned:true, authState:{status:'idle'}});
  await installed.signedOut.locator('#signupView').getByText('Sign in to get started.').waitFor();
  assert.equal(await installed.signedOut.locator('#suCopySetup').count(), 0, 'nothing for an agent to install');
  assert.equal(await installed.signedOut.locator('.su-setup-prompt').count(), 0);
  assert.equal((await installed.signedOut.locator('#suGoogle').textContent()).trim(), 'Continue with Google');
  assert.equal(await installed.signedOut.locator('#suGoogle').evaluate(el => el.classList.contains('su-primary')), true, 'Google is the primary way in');
  assert.equal(await installed.signedOut.locator('#suSignIn').textContent(), 'Use email instead');
  assert.equal(await installed.signedOut.locator('#signupView').getByText('quit and reopen Claude Code or Codex').isVisible(), true);
  await installed.signedOut.waitForTimeout(250);
  assert.deepEqual(await installed.signedOut.evaluate(() => window.fixtureSignIns), [], 'the person clicks Continue with Google themselves');
  const shot = fileURLToPath(new URL('../../../dist/setup-ui/pill-application-signin.png', import.meta.url));
  fs.mkdirSync(path.dirname(shot), {recursive:true});
  await installed.signedOut.locator('.card').screenshot({path:shot});
  assert.deepEqual(installed.pageErrors, []);
  await installed.signedOut.close();
  await manual.signedOut.close();

  const resumed = await openSignedOut({agentInstalled:true, authState:{status:'pending_identity',authorizationId:'auth_1',expiresAt:'2099-01-01T00:00:00Z'}});
  await resumed.signedOut.locator('#suResumeSetup').waitFor();
  assert.equal(await resumed.signedOut.locator('#signupView').getByText('Continue your setup.').isVisible(), true);
  await resumed.signedOut.waitForTimeout(250);
  assert.deepEqual(await resumed.signedOut.evaluate(() => window.fixtureSignIns), [], 'an approval in flight is never replaced on open');
  assert.deepEqual(resumed.pageErrors, []);
  await resumed.signedOut.close();
  console.log('Get started renderer: auto sign-in once, method stage without the marker, and no restart over a pending approval passed.');
} finally {await browser.close();}
