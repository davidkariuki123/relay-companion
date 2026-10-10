// Real pill renderer, in-memory IPC. YOUR FIRST RELAY, PICKED IN THE PILL
// (2026-10-10): after sign-in the person chooses Codex, Claude Code or
// Conductor; the app connects the account itself and opens the AI with
// "Set up Relay with me."; the AI's four ideas fill the pill; a tap goes to a
// waiting AI or, with none waiting, reopens the AI with the idea typed in; a
// minted first link lands on It's ready to send. No account, installation or
// delivery changes. Set RELAY_FIRST_RELAY_SHOTS=<dir> to save a dark-mode
// screenshot of each screen there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const shots = process.env.RELAY_FIRST_RELAY_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 850, height: 900 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureEvents = {};
    window.fixtureCalls = [];
    window.fixtureWaiter = true;
    const now = () => new Date().toISOString();
    window.fixturePayload = { account: { paired: true, userId: 'a', name: 'Alex Rivera', email: 'alex@example.test' },
      ui: { canDismiss: true, onboardingRequired: true, onboardingVersion: 2, completedOnboardingVersion: 0,
        firstRelayStatus: 'waiting', firstRelayId: '', firstLink: null, firstRelayKind: 'link',
        networkOnboarding: { required: false, checking: false, version: 2 },
        localOnboardingPrompt: 'Set up Relay with me.',
        onboardingAgent: { host: '', place: '', connectedAt: '', openable: { codex: true, 'claude-code': true, conductor: false } },
        firstRelayIdeas: null },
      features: {}, relays: [], sent: [], contacts: [], chats: [] };
    const publish = () => window.fixtureEvents.onInbox?.(structuredClone(window.fixturePayload));
    const api = { isTestOverlay: true, refresh: async () => structuredClone(window.fixturePayload),
      contacts: async () => [], groups: async () => ({ ok: true, result: [] }),
      onboardingChooseAgent: async (userId, host) => {
        window.fixtureCalls.push(['choose', userId, host]);
        window.fixturePayload.ui.onboardingAgent = { ...window.fixturePayload.ui.onboardingAgent, host, connectedAt: now() };
        return structuredClone(window.fixturePayload.ui.onboardingAgent);
      },
      onboardingResetAgent: async (userId) => {
        window.fixtureCalls.push(['reset', userId]);
        window.fixturePayload.ui.onboardingAgent = { ...window.fixturePayload.ui.onboardingAgent, host: '', connectedAt: '' };
        window.fixturePayload.ui.firstRelayIdeas = null;
        return structuredClone(window.fixturePayload.ui.onboardingAgent);
      },
      onboardingOpenAgent: async (userId) => {
        window.fixtureCalls.push(['open', userId]);
        const host = window.fixturePayload.ui.onboardingAgent.host;
        window.fixturePayload.ui.firstRelayIdeas = { id: 'setup_1', host, kind: 'none', inviterName: '', inviterFirstName: '', orgName: '',
          openedAt: now(), agentStartedAt: '', ideas: [], ideasAt: '', pick: null };
        setTimeout(publish, 0);
        return { ok: true };
      },
      onboardingPickIdea: async (userId, ideaId) => {
        window.fixtureCalls.push(['pick', userId, ideaId]);
        const flow = window.fixturePayload.ui.firstRelayIdeas;
        const mode = window.fixtureWaiter ? 'waiter' : 'reopened';
        flow.pick = { ideaId, mode, at: now(), claimed: false };
        return { mode, opened: mode === 'reopened' ? 'opened' : null, ideas: structuredClone(flow) };
      },
      onboardingFocusAgent: async (userId) => { window.fixtureCalls.push(['focus', userId]); return { ok: true }; },
      copyFirstLink: async (userId) => { window.fixtureCalls.push(['copy-link', userId]); return { ok: true }; },
    };
    window.relay = new Proxy(api, { get: (target, key) => {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return (callback) => { window.fixtureEvents[key] = callback; return () => {}; };
      return async () => ({ ok: true });
    } });
  });
  await page.goto(new URL('../overlay/inbox.html', import.meta.url).href);
  const push = (mutate) => page.evaluate((source) => { const p = window.fixturePayload; (new Function('p', source))(p); window.fixtureEvents.onInbox(structuredClone(p)); }, mutate);
  const calls = () => page.evaluate(() => window.fixtureCalls);
  const view = page.locator('#signupView');
  // The signup card is a fixed size: every screen fits it without clipping.
  const fits = async (label) => {
    const overflow = await page.locator('#signupBody, .su-body').first().evaluate((el) => el.scrollHeight - el.clientHeight);
    assert.ok(overflow <= 1, `${label} fits the card (overflow ${overflow}px)`);
  };
  const shot = async (name) => {
    if (!shots) return;
    await page.waitForTimeout(700); // entrances settle
    await page.locator('.card').screenshot({ path: path.join(shots, `${name}.png`) });
  };
  const ideas = (prefix = '') => JSON.stringify([
    { id: 'idea-1', title: `${prefix}Review the pricing page copy`, line: 'Ask for a read before Friday’s launch', kind: 'review' },
    { id: 'idea-2', title: 'Ask about the rollout date', line: 'Check what the customer said on Tuesday', kind: 'answer' },
    { id: 'idea-3', title: 'Hand over the login fix', line: 'What I tried, and what is left', kind: 'handoff' },
    { id: 'idea-4', title: 'Share this week’s progress', line: 'Three things shipped, one blocked', kind: 'update' },
  ]);

  // 1. Which AI do you use most? is unchanged; Codex leads to Add Relay to Codex.
  await view.getByText('Which AI do you use most?').waitFor();
  await page.locator('[data-agent-choose="codex"]').click();
  await view.getByText('Two clicks:').waitFor();
  assert.match(await page.locator('.su-title').innerText(), /Add Relay to\s+Codex\./);
  assert.equal(await page.locator('[data-agent-open]').textContent(), 'Open Codex');
  await fits('01-add-relay-to-codex');
  await shot('01-add-relay-to-codex');

  // 2. Open Codex: opening is not starting. The setup message sits in Codex's
  //    composer until the person presses send, so the pill stays put.
  await page.locator('[data-agent-open]').click();
  await page.waitForFunction(() => Boolean(window.fixturePayload.ui.firstRelayIdeas?.openedAt));
  await page.waitForTimeout(300);
  assert.equal(await view.getByText('Finding ideas for your first Relay.').count(), 0, 'not before the AI starts');
  assert.match(await page.locator('.su-title').innerText(), /Add Relay to\s+Codex\./);
  assert.equal(await view.getByText('Press send in Codex.').count(), 0, 'no hint in the first minute');
  assert.deepEqual((await calls()).map((call) => call[0]), ['choose', 'open']);

  // 3. A minute without the AI starting: the same screen says to press send.
  await push(`p.ui.firstRelayIdeas.openedAt = new Date(Date.now() - 61000).toISOString();`);
  await view.getByText('Press send in Codex.').waitFor();
  assert.match(await page.locator('.su-title').innerText(), /Add Relay to\s+Codex\./);
  await fits('02-press-send-hint');
  await shot('02-press-send-hint');

  // 3b. The AI's first Relay tool call marks it started: finding ideas.
  await push(`p.ui.firstRelayIdeas.agentStartedAt = new Date().toISOString();`);
  await view.getByText('Finding ideas for your first Relay.').waitFor();
  assert.equal(await view.getByText('Your first Relay', { exact: true }).isVisible(), true);
  assert.equal(await view.getByText('Codex is looking at what you’ve worked on lately, so it can suggest something to send. Nothing goes to anyone yet.').isVisible(), true);
  assert.equal(await page.locator('.su-idea.skeleton').count(), 4);
  assert.equal(await view.getByText('Press send in Codex.').count(), 0, 'started: no press-send hint');
  await fits('03-finding-ideas');
  await shot('03-finding-ideas');

  // 4. The AI started and wrote four ideas: the picker, with no skip.
  await push(`p.ui.firstRelayIdeas.ideas = ${ideas()}; p.ui.firstRelayIdeas.ideasAt = new Date().toISOString();`);
  await view.getByText('What do you need from someone this week?').waitFor();
  assert.equal(await page.locator('.su-idea:not(.skeleton)').count(), 4);
  assert.equal(await page.locator('.su-idea .su-idea-title').first().textContent(), 'Review the pricing page copy');
  assert.equal(await page.locator('.su-idea .su-idea-line').first().textContent(), 'Ask for a read before Friday’s launch');
  assert.deepEqual(await page.locator('.su-idea .su-idea-icon').evaluateAll((els) => els.map((el) => el.dataset.kind)), ['review', 'answer', 'handoff', 'update']);
  assert.equal(await view.getByText('Suggested by Codex from your recent chats').isVisible(), true);
  assert.equal(await view.getByText(/Skip/).count(), 0, 'no skip link');
  assert.equal(await page.locator('.su-idea-list').evaluate((el) => getComputedStyle(el).overflowY), 'auto', 'the list scrolls inside itself');
  assert.equal(await page.locator('.su-idea-title').first().evaluate((el) => getComputedStyle(el).textOverflow), 'clip', 'titles wrap, never cut');
  await fits('04-picker');
  await shot('04-picker');

  // 5. A tap with the AI waiting: Codex is writing it.
  await page.locator('[data-idea-id="idea-2"]').click();
  await view.getByText('Codex is writing it.').waitFor();
  assert.equal(await page.locator('.su-idea-quote .su-idea-title').textContent(), 'Ask about the rollout date');
  assert.equal(await view.getByText('Look in Codex. It shows you the Relay and its link when it’s ready.').isVisible(), true);
  await page.locator('[data-agent-focus]').click();
  assert.deepEqual((await calls()).slice(-2), [['pick', 'a', 'idea-2'], ['focus', 'a']]);
  await fits('05-codex-is-writing');
  await shot('05-codex-is-writing');

  // 6. The link is minted: It's ready to send.
  const url = 'https://sendrelays.com/s/first_pricing_review';
  await push(`p.sent.push({ relayId: 'r_first', createdAt: new Date().toISOString(), state: 'pending', recipient: { name: 'Sam' }, shareLink: { id: 'shl_1', url: '${url}', state: 'unopened' } });
    p.ui.firstRelayStatus = 'sent'; p.ui.firstRelayId = 'r_first'; p.ui.firstLink = { relayId: 'r_first', url: '${url}', state: 'unopened', shareText: '' };`);
  // The chat leads the pill: "Codex is writing it." stays up for a few seconds
  // after the mint (or until the AI checks in), so Codex's own message shows first.
  const minted = Date.now();
  await page.waitForTimeout(400);
  assert.equal(await view.getByText('Codex is writing it.').isVisible(), true, 'held while the chat catches up');
  await view.getByText('It’s ready to send.').waitFor({ timeout: 8000 });
  assert.ok(Date.now() - minted >= 3500, 'held about four seconds');
  assert.equal(await page.locator('#suFirstLinkUrl').inputValue(), url);
  await page.locator('#suLinkCopy').click();
  await page.locator('#suLinkCopy:has-text("Copied")').waitFor();
  assert.deepEqual((await calls()).at(-1), ['copy-link', 'a']);
  await fits('06-ready-to-send');
  await shot('06-ready-to-send');

  // 7. An invited person: every idea is for the inviter, and the AI asks before sending.
  await push(`p.account.userId = 'b'; p.sent = []; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null; p.ui.firstRelayKind = 'hello';
    p.ui.onboardingAgent = { ...p.ui.onboardingAgent, host: 'claude-code' };
    p.ui.firstRelayIdeas = { id: 'setup_2', host: 'claude-code', kind: 'invite', inviterName: 'Sam Rivera', inviterFirstName: 'Sam', orgName: '',
      openedAt: new Date().toISOString(), agentStartedAt: new Date().toISOString(), ideas: ${ideas()}, ideasAt: new Date().toISOString(), pick: null };`);
  await view.getByText('What do you need from Sam this week?').waitFor();
  assert.equal(await view.getByText('Sam Rivera invited you, so they’re in your contacts').isVisible(), true);
  await fits('07-picker-invite');
  await shot('07-picker-invite');
  await page.locator('[data-idea-id="idea-1"]').click();
  await view.getByText('Claude Code is writing to Sam.').waitFor();
  assert.equal(await view.getByText('Look in Claude Code. You’ll see the message first, and nothing goes to Sam until you say send.').isVisible(), true);
  assert.equal(await page.locator('[data-agent-focus]').textContent(), 'Open Claude Code');
  await fits('08-writing-to-inviter');
  await shot('08-writing-to-inviter');

  // 8. A tap with no AI waiting: the AI is opened again with the idea typed in.
  await page.evaluate(() => { window.fixtureWaiter = false; });
  await push(`p.account.userId = 'c'; p.ui.onboardingAgent = { ...p.ui.onboardingAgent, host: 'codex' };
    p.ui.firstRelayIdeas = { id: 'setup_3', host: 'codex', kind: 'none', inviterName: '', inviterFirstName: '', orgName: '',
      openedAt: new Date().toISOString(), agentStartedAt: new Date().toISOString(), ideas: ${ideas()}, ideasAt: new Date().toISOString(), pick: null };`);
  await view.getByText('What do you need from someone this week?').waitFor();
  await page.locator('[data-idea-id="idea-3"]').click();
  await view.getByText('Press send in Codex.').waitFor();
  assert.equal(await view.getByText('Codex had stopped, so we opened it again with this typed in.').isVisible(), true);
  assert.equal(await page.locator('.su-idea-quote .su-idea-title').textContent(), 'Hand over the login fix');
  await fits('09-press-send-reopened');
  await shot('09-press-send-reopened');

  // 9. Choosing a different AI from the hint starts afresh at the chooser.
  await push(`p.account.userId = 'd'; p.ui.firstRelayIdeas = { id: 'setup_4', host: 'codex', kind: 'none', inviterName: '', inviterFirstName: '', orgName: '',
      openedAt: new Date(Date.now() - 90000).toISOString(), agentStartedAt: '', ideas: [], ideasAt: '', pick: null };`);
  await view.getByText('Press send in Codex.').waitFor();
  await page.locator('[data-agent-reset]').click();
  await view.getByText('Which AI do you use most?').waitFor();
  assert.deepEqual((await calls()).at(-1), ['reset', 'd']);

  // 10. An AI that checks in at the end of its turn releases the hold at once.
  await page.evaluate(() => { window.fixtureWaiter = true; });
  await push(`p.account.userId = 'e'; p.sent = []; p.ui.firstRelayStatus = 'waiting'; p.ui.firstRelayId = ''; p.ui.firstLink = null;
    p.ui.onboardingAgent = { ...p.ui.onboardingAgent, host: 'codex' };
    p.ui.firstRelayIdeas = { id: 'setup_5', host: 'codex', kind: 'none', inviterName: '', inviterFirstName: '', orgName: '',
      openedAt: new Date().toISOString(), agentStartedAt: new Date().toISOString(), ideas: ${ideas()}, ideasAt: new Date().toISOString(), pick: { ideaId: 'idea-1', mode: 'waiter', at: new Date().toISOString(), claimed: true, wrapUpAt: '' } };`);
  await view.getByText('Codex is writing it.').waitFor();
  await push(`p.sent.push({ relayId: 'r_e', createdAt: new Date().toISOString(), state: 'pending', recipient: { name: 'Sam' }, shareLink: { id: 'shl_e', url: 'https://sendrelays.com/s/e', state: 'unopened' } });
    p.ui.firstRelayStatus = 'sent'; p.ui.firstRelayId = 'r_e'; p.ui.firstLink = { relayId: 'r_e', url: 'https://sendrelays.com/s/e', state: 'unopened', shareText: '' };`);
  await page.waitForTimeout(300);
  assert.equal(await view.getByText('Codex is writing it.').isVisible(), true);
  const wrapped = Date.now();
  await push(`p.ui.firstRelayIdeas.pick.wrapUpAt = new Date().toISOString();`);
  await view.getByText('It’s ready to send.').waitFor({ timeout: 2000 });
  assert.ok(Date.now() - wrapped < 2000, 'released by the check-in, not the timer');

  assert.deepEqual(errors, []);
  console.log(`First-Relay ideas renderer: chooser, add, finding, hint, picker, writing, invite, reopen and ready-to-send checks passed.${shots ? ` Screenshots in ${shots}.` : ''}`);
} finally { await browser.close(); }
