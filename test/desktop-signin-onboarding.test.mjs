import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../overlay/main.cjs', import.meta.url), 'utf8');

test('opening signed-out Relay reads recovery state but never creates an authorization', async () => {
  const source = html.slice(html.indexOf('  async function initializeInstallationAuthorization('), html.indexOf('  async function connectChatFromSignup('));
  const calls = [];
  const context = vm.createContext({
    window: { relay: {
      installationAuthState: async () => { calls.push('state'); return { status: 'idle' }; },
      installationAuthBegin: async () => { throw new Error('must not begin on app open'); },
    } }, payload: { account: { paired: false } }, signupStateLoaded: false,
    signupInitializationFailed: false, signupBusy: false, signupError: '', signupStage: '',
    pendingOpenSignupCard: () => '', rendererSurfaceActive: () => true,
    renderSignup: () => {}, applyInstallationState: () => {}, pollInstallationState: () => {},
  });
  vm.runInContext(source, context);
  await context.initializeInstallationAuthorization();
  await context.initializeInstallationAuthorization();
  assert.deepEqual(calls, ['state']);
  assert.equal(context.signupStage, 'method');
  assert.equal(context.signupBusy, false);
});

test('desktop connection completes only the signed-in account before loading its history', async () => {
  const start = main.indexOf('onConnected: async (registration) => {') + 'onConnected: async (registration) => {'.length;
  const end = main.indexOf('\n        },', start);
  const calls = [];
  const versions = { 'user:other': 0 };
  const context = vm.createContext({
    loadAccountModules: async () => ({ notifications: { resetCompanionStateForAccount: () => calls.push('reset') } }),
    nativeCredentialCache: {}, STATE_PATH: '/test/state',
    sentCache: [], sentFingerprint: '', sentLoadedOnce: null, contactsCache: [], contactsFingerprint: '', contactsLoadedOnce: null,
    canonicalChatsCache: [], slackChatsCache: [], canonicalChatsFingerprint: '', canonicalChatsLoadedOnce: null,
    onboardingAccountKey: (account) => `user:${account.userId}`, onboardingVersions: versions, COMPANION_ONBOARDING_VERSION: 2,
    writeOverlayPrefs: () => calls.push('persist'), restartCompanionDaemon: async () => calls.push('daemon'),
    refreshSent: async () => { assert.equal(versions['user:existing'], 2); calls.push('sent'); },
    refreshContacts: async () => {}, refreshCanonicalChats: async () => {}, pushInbox: async () => calls.push('inbox'),
  });
  const connect = vm.runInContext(`(async (registration) => {${main.slice(start, end)}})`, context);
  await connect({ user: { id: 'existing', email: 'existing@example.com' }, deviceId: 'device' });
  assert.equal(versions['user:other'], 0);
  assert.ok(calls.indexOf('persist') < calls.indexOf('sent'));
  assert.equal(calls.at(-1), 'inbox');
});
