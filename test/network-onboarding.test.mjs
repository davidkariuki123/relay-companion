import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createNetworkOnboarding } from '../overlay/network-onboarding.cjs';

const reply = (id = 'a', version = 0) => ({ user:{id}, onboardingVersion:version, requiredOnboardingVersion:2 });
function harness(options = {}) {
  let who = { key:'prod|a', userId:'a' };
  let clock = 1;
  const completed = options.completed || {};
  const presented = options.presented || {};
  const writes = [];
  const flow = createNetworkOnboarding({ identity:() => who, now:() => clock, completed, presented,
    read:options.read || (async () => reply(who.userId)),
    complete:options.complete || (async (identity, version) => { writes.push([identity.userId, version]); return reply(identity.userId, version); }),
  });
  return { flow, completed, presented, writes, switch:(next) => { who = next; }, tick:() => { clock += 30_001; } };
}

test('legacy install and first-send completion cannot dismiss the account invitation chapter', async () => {
  for (const version of [0, 1]) {
    const h = harness({read:async () => reply('a', version)});
    assert.equal(h.flow.status().required, false, 'unverified state never forces the page');
    await h.flow.refresh();
    assert.equal(h.flow.status().required, true);
    assert.equal(h.writes.length, 0, 'observing the page never completes it');
  }
});

test('completed account stays complete on a second device and later updates', async () => {
  const h = harness({read:async () => reply('a', 2)});
  await h.flow.refresh();
  assert.equal(h.flow.status().required, false);
  assert.equal(h.flow.shouldPresent('0.1.999'), false);
});

test('offline, unknown, future schemas and another account response never force onboarding', async () => {
  for (const read of [async () => { throw Error('offline'); }, async () => ({}),
    async () => reply('b'), async () => ({...reply(), requiredOnboardingVersion:3})]) {
    const h = harness({read}); await h.flow.refresh();
    assert.equal(h.flow.status().required, false);
    assert.equal(h.flow.status().checking, true);
  }
});

test('failed status checks retry and reveal a confirmed unfinished account', async () => {
  let calls = 0;
  const h = harness({read:async () => { if (++calls === 1) throw Error(); return reply(); }});
  await h.flow.refresh(); await h.flow.refresh();
  assert.equal(calls, 1);
  h.tick(); await h.flow.refresh();
  assert.equal(h.flow.status().required, true);
});

test('closing the page is respected for the same build, and a new build can resume it', async () => {
  const h = harness(); await h.flow.refresh();
  assert.equal(h.flow.shouldPresent('old'), true);
  h.flow.markPresented('old');
  assert.equal(h.flow.shouldPresent('old'), false);
  assert.equal(h.flow.shouldPresent('new'), true);
  const restarted = harness({presented:h.presented}); await restarted.flow.refresh();
  assert.equal(restarted.flow.shouldPresent('old'), false);
  await h.flow.finish('a');
  assert.equal(h.flow.shouldPresent('new'), false);
  assert.deepEqual(h.writes, [['a', 2]]);
});

test('an old in-flight GET cannot undo explicit completion', async () => {
  let resolve;
  const h = harness({read:() => new Promise(r => {resolve = r;})});
  const pending = h.flow.refresh();
  await h.flow.finish('a');
  resolve(reply()); await pending;
  assert.equal(h.flow.status().required, false);
  assert.equal(h.completed['prod|a'], 2);
});

test('a read crossing an account switch cannot open a page or persist another account', async () => {
  let resolve;
  const h = harness({read:() => new Promise(r => {resolve = r;})});
  const pending = h.flow.refresh();
  h.switch({key:'prod|b', userId:'b'});
  resolve(reply()); await pending;
  assert.deepEqual(h.completed, {});
  assert.equal(h.flow.status().checking, true);
  h.switch(null); assert.equal(h.flow.status().required, false);
});

test('completion rejects stale account clicks, wrong responses and failed saves', async () => {
  const wrongClick = harness();
  await assert.rejects(wrongClick.flow.finish('b'), /account changed/);
  assert.deepEqual(wrongClick.writes, []);
  for (const complete of [async () => { throw Error('offline'); }, async () => reply('b', 2), async () => reply('a', 1)]) {
    const h = harness({complete}); await h.flow.refresh();
    await assert.rejects(h.flow.finish('a'));
    assert.equal(h.flow.status().required, true);
  }
});

test('completion crossing an account switch cannot complete the newly selected account', async () => {
  let resolve;
  const h = harness({complete:() => new Promise(r => {resolve = r;})});
  const pending = h.flow.finish('a');
  h.switch({key:'prod|b', userId:'b'});
  resolve(reply('a', 2)); await assert.rejects(pending, /account changed/);
  assert.deepEqual(h.completed, {});
});

test('completion and presentation are isolated by API origin as well as account', async () => {
  const h = harness(); await h.flow.refresh(); await h.flow.finish('a');
  h.switch({key:'dev|a', userId:'a'});
  await h.flow.refresh();
  assert.equal(h.flow.status().required, true);
});

test('native prompt waits for a ready, visible, attended pill and preserves Keep Relay hidden', () => {
  const main = fs.readFileSync(new URL('../overlay/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('function presentNetworkOnboarding()');
  const end = main.indexOf('\nconst presentedRelayIds', start);
  for (const blocked of ['notReady', 'hidden', 'away', 'alreadyPresented', 'failedShow', 'none']) {
    let marked = 0, shows = 0;
    const scope = vm.createContext({
      pillReady:blocked !== 'notReady', pillHidden:blocked === 'hidden', dismissed:true,
      userIsAway:() => blocked === 'away', pillVersion:() => 'candidate',
      win:{isDestroyed:() => false, isVisible:() => blocked !== 'failedShow'},
      networkOnboarding:{shouldPresent:() => blocked !== 'alreadyPresented', markPresented:() => {marked++;}},
      maybeShow:() => {shows++;},
    });
    vm.runInContext(main.slice(start, end), scope);
    scope.presentNetworkOnboarding();
    assert.equal(marked, blocked === 'none' ? 1 : 0, blocked);
    assert.equal(shows, ['none','failedShow'].includes(blocked) ? 1 : 0, blocked);
    assert.equal(scope.pillHidden, blocked === 'hidden', 'never rewrites the hidden preference');
  }
});
