// Real pill renderer, in-memory IPC. The chapter after the first send
// (2026-09-13): celebration (auto-advance or Continue), Your first link,
// Grow your network, Open Relay. Then the Get started path (no inviter): the
// handoff asks for a link, the ready screen carries the celebration, and a
// pill opened by setup signs in on its own, once. No account, installation
// or delivery changes.
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
  assert.equal(await page.locator('#signupView').getByText('Your first link').isVisible(), true, 'a hello came first: this is the second screen');
  assert.equal(await page.locator('.su-first-link .su-relay-moment').count(), 0, 'the celebration already happened');
  assert.equal(await page.locator('#signupView').getByText('Send it wherever you talk to them. They can ask their Claude Code or Codex to reply. Their reply will appear inside your Relay app, even if they don’t have Relay.').isVisible(), true);
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

  // 7. GET STARTED (no inviter): the handoff asks for a link. When the link
  //    is minted, the ready screen carries the celebration marks, since the
  //    link was itself the first Relay and there was no hello to celebrate.
  await push(`p.account.userId = 'd'; p.ui.onboardingRequired = true; p.ui.completedOnboardingVersion = 0;
    p.ui.firstRelayKind = 'link'; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null;
    p.ui.networkOnboarding.required = false;`);
  await page.locator('#signupView').getByText('Follow the instructions in').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Your first Relay').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('make you a relay about something you’re working on').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('and the other person needs nothing installed.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('This screen updates when your link is ready.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('Your agent will help you send your first Relay.').count(), 0);
  assert.equal(await page.locator('#suLinkSkip').count(), 0, 'before the link, the handoff has no Your-first-link Skip');
  assert.equal(await page.locator('#suHandoffSkip').textContent(), 'Skip for now', 'no inviter: the handoff is not a dead end');
  const linkShareText = "Here is the brief for the launch page. Read it and tell me what you'd change.\n\nPaste this into your Claude Code or Codex and it'll fetch the full relay: https://sendrelays.com/s/first_link_only";
  await push(`p.sent.push({relayId:'r_link_only',createdAt:'2026-09-13T11:00:00Z',state:'pending',recipient:{name:'Sam'},shareLink:{id:'shl_2',url:'https://sendrelays.com/s/first_link_only',state:'unopened'}});
    p.ui.firstRelayStatus = 'sent'; p.ui.firstRelayId = 'r_link_only';
    p.ui.firstLink = {relayId:'r_link_only',url:'https://sendrelays.com/s/first_link_only',state:'unopened',shareText:${JSON.stringify(linkShareText)}};`);
  await page.locator('#suLinkCopy').waitFor();
  assert.equal(await page.locator('#suCelebrationContinue').count(), 0, 'no separate celebration screen');
  assert.equal(await page.locator('.su-first-link.su-first-relay-sent .su-relay-moment i').count(), 3, 'the moment lands on the ready screen');
  assert.equal(await page.locator('.su-first-link .su-relay-moment i').first().evaluate(el => getComputedStyle(el).animationName), 'su-first-send, su-relay-hop');
  assert.equal(await page.locator('.su-countdown').count(), 0, 'nothing to wait for');
  assert.equal(await page.locator('#signupView').getByText('Your first Relay').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('Your first link').count(), 0);
  assert.equal(await page.locator('#signupView').getByText('Your link is ready.').isVisible(), true);
  assert.equal(await page.locator('#suFirstLinkText').innerText(), linkShareText);
  assert.equal(await page.locator('#signupView').getByText('Send it wherever you talk to them. They can ask their Claude Code or Codex to reply. Their reply will appear inside your Relay app, even if they don’t have Relay.').isVisible(), true);
  assert.equal(await page.locator('#suLinkCopy').textContent(), 'Copy message');
  assert.equal(await page.locator('#suLinkContinue').textContent(), 'Continue');
  // Copy message changes the controls in place: the marks are the same nodes
  // afterwards, so their entrance does not replay.
  await page.evaluate(() => { document.querySelector('.su-first-link .su-relay-moment').dataset.probe = 'kept'; });
  await page.locator('#suLinkCopy').click();
  await page.locator('#suLinkCopy:has-text("Copied")').waitFor();
  assert.deepEqual((await page.evaluate(() => window.fixtureCopies)).at(-1), 'd');
  assert.equal(await page.locator('.su-first-link .su-relay-moment').getAttribute('data-probe'), 'kept', 'the moment was not rebuilt');
  assert.equal(await page.locator('#suLinkCopy').isDisabled(), false);
  await page.evaluate(() => {window.fixtureCopyFailure = true;});
  await page.locator('#suLinkCopy').click();
  await page.locator('.su-first-link .su-error').waitFor();
  assert.equal(await page.locator('.su-first-link .su-error').textContent(), 'The message couldn’t be copied. Select the text above and copy it.');
  assert.equal(await page.locator('.su-first-link .su-relay-moment').getAttribute('data-probe'), 'kept', 'nor on a failed copy');
  await page.evaluate(() => {window.fixtureCopyFailure = false;});
  await page.locator('#suLinkCopy').click();
  await page.locator('.su-first-link .su-error').waitFor({state:'detached'});
  assert.equal(await page.locator('#suLinkCopy').textContent(), 'Copied');
  await page.locator('#suLinkContinue').click();
  await page.locator('#suNetworkContinue').waitFor();
  assert.equal(await page.locator('#signupView').getByText('Grow your network.').isVisible(), true);
  assert.equal(await page.locator('#signupView').getByText('Last step').isVisible(), true);
  assert.equal(await page.locator('#suNetworkContinue').textContent(), 'Open Relay');
  await page.locator('#suNetworkContinue').click();
  await page.locator('#suNetworkContinue').waitFor({state:'hidden'});
  assert.deepEqual((await page.evaluate(() => window.fixtureWrites)).at(-1), ['complete-local']);
  assert.equal(await page.locator('#signupView').isVisible(), false, 'Open Relay ends onboarding for the link-first account');
  assert.equal(await page.locator('#suCelebrationContinue').count(), 0, 'the link-first account never saw the celebration screen');

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
  console.log('First-relay chapter renderer: celebration, first link, link-first, Grow your network and Open Relay checks passed.');

  // 8. A signed-out pill. Opened by "npx relay-companion setup" (the marker
  //    the main process reports as ui.agentInstalled), it starts the browser
  //    sign-in itself, exactly once. Without the marker, or with an approval
  //    already in flight, it waits for the person.
  const openSignedOut = async ({agentInstalled, authState}) => {
    const signedOut = await browser.newPage({viewport:{width:850,height:850}});
    const pageErrors = [];
    signedOut.on('pageerror', error => pageErrors.push(error.message));
    await signedOut.addInitScript(({agentInstalled, authState}) => {
      window.fixtureEvents = {};
      window.fixtureSignIns = [];
      window.fixtureStateReads = 0;
      window.fixturePayload = {account:{paired:false,credentialStatus:'unpaired',credentialError:'',credentialStore:'',email:'',name:'',userId:''},
        ui:{canDismiss:true,onboardingRequired:false,onboardingVersion:2,completedOnboardingVersion:0,
          setupPrompt:'Read https://sendrelays.com/for-agents and set me up on Relay.',agentInstalled,
          firstRelayStatus:'checking',firstRelayId:'',firstLink:null,networkOnboarding:{required:false,checking:false,version:2}},
        features:{},relays:[],sent:[],contacts:[],chats:[]};
      const api = {isTestOverlay:true, refresh:async () => structuredClone(window.fixturePayload),
        contacts:async () => [], groups:async () => ({ok:true,result:[]}),
        installationAuthState:async () => { window.fixtureStateReads += 1; return structuredClone(authState); },
        installationAuthSignIn:async options => { window.fixtureSignIns.push(options); return {status:'pending_identity'}; },
        installationAuthBegin:async () => { throw Error('must not begin on app open'); },
      };
      window.relay = new Proxy(api,{get:(target,key) => {
        if(key in target) return target[key];
        if(String(key).startsWith('on')) return callback => {window.fixtureEvents[key]=callback;return () => {};};
        return async () => ({ok:true});
      }});
    }, {agentInstalled, authState});
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
  await manual.signedOut.locator('#suCopySetup').waitFor();
  assert.equal(await manual.signedOut.locator('#suCopySetup').textContent(), 'Copy setup prompt');
  assert.equal((await manual.signedOut.locator('#suGoogle').textContent()).trim(), 'Continue with Google');
  assert.equal(await manual.signedOut.locator('#suSignIn').textContent(), 'Use email instead');
  await manual.signedOut.waitForTimeout(250);
  assert.deepEqual(await manual.signedOut.evaluate(() => window.fixtureSignIns), [], 'no marker: the person clicks Sign in');
  assert.equal(await manual.signedOut.locator('#signupView').getByText('Continue in your browser.').count(), 0);
  assert.deepEqual(manual.pageErrors, []);
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
