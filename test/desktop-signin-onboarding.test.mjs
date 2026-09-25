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

// A desktop sign-in decides the first-send chapter from the account's history,
// read AFTER the daemon restart and BEFORE the final push. While that read is
// in flight the key sits in signInHistoryPending, which is what keeps the
// payload from flashing the tutorial at a returning sender.
function connectHarness({ history }) {
  const start = main.indexOf('onConnected: async (registration) => {') + 'onConnected: async (registration) => {'.length;
  const end = main.indexOf('\n        },', start);
  const calls = [];
  const versions = { 'user:other': 0 };
  const statuses = { 'user:other': 'complete' };
  const pending = new Set();
  const observed = { pendingDuringRefresh: null, versionDuringRefresh: 'unset' };
  const context = vm.createContext({
    loadAccountModules: async () => ({ notifications: { resetCompanionStateForAccount: () => calls.push('reset') } }),
    adoptCurrentAccountFeatures: () => {},
    resetAccountViewCaches: () => {},
    nativeCredentialCache: {}, STATE_PATH: '/test/state',
    sentCache: [], sentFingerprint: '', sentLoadedOnce: null, contactsCache: [], contactsFingerprint: '', contactsLoadedOnce: null,
    canonicalChatsCache: [], slackChatsCache: [], canonicalChatsFingerprint: '', canonicalChatsLoadedOnce: null,
    onboardingAccountKey: (account) => `user:${account.userId}`, onboardingVersions: versions, COMPANION_ONBOARDING_VERSION: 2,
    signInHistoryPending: pending,
    // The setup pill (native installer) leaves the middle of the screen for
    // its top-right home as soon as the account connects, before the restart.
    leaveSetupPlacement: () => calls.push('home'),
    firstRelayOnboarding: { status: (key) => statuses[key] || 'checking' },
    writeOverlayPrefs: () => calls.push('persist'), restartCompanionDaemon: async () => calls.push('daemon'),
    refreshSent: async () => {
      observed.pendingDuringRefresh = [...pending];
      observed.versionDuringRefresh = 'user:signed-in' in versions ? versions['user:signed-in'] : 'unset';
      statuses['user:signed-in'] = history;
      calls.push('sent');
    },
    refreshContacts: async () => {}, refreshCanonicalChats: async () => {}, pushInbox: async () => calls.push('inbox'),
  });
  const connect = vm.runInContext(`(async (registration) => {${main.slice(start, end)}})`, context);
  return { calls, versions, pending, observed,
    connect: () => connect({ user: { id: 'signed-in', email: 'signed-in@example.com' }, deviceId: 'device' }) };
}

test('an existing sender is completed only after its history is read, before the final push', async () => {
  const h = connectHarness({ history: 'complete' });
  await h.connect();
  assert.equal(h.observed.versionDuringRefresh, 'unset', 'never marked before the history request');
  assert.deepEqual(h.observed.pendingDuringRefresh, ['user:signed-in'], 'held back while the history loads');
  assert.equal(h.versions['user:signed-in'], 2);
  assert.equal(h.versions['user:other'], 0, 'only the signed-in account');
  assert.ok(h.calls.indexOf('home') < h.calls.indexOf('daemon'), 'the setup pill goes home the moment it is signed in');
  assert.ok(h.calls.indexOf('daemon') < h.calls.indexOf('sent'));
  assert.ok(h.calls.indexOf('sent') < h.calls.indexOf('persist'));
  assert.ok(h.calls.indexOf('persist') < h.calls.indexOf('inbox'));
  assert.equal(h.calls.at(-1), 'inbox');
  assert.equal(h.pending.size, 0, 'released once the decision is made');
});

test('a confirmed empty history leaves the first-send chapter open for a new account', async () => {
  const h = connectHarness({ history: 'waiting' });
  await h.connect();
  assert.deepEqual(h.observed.pendingDuringRefresh, ['user:signed-in']);
  assert.equal('user:signed-in' in h.versions, false, 'version stays unset so the chapter shows');
  assert.equal(h.versions['user:other'], 0);
  assert.equal(h.calls.includes('persist'), false);
  assert.equal(h.calls.at(-1), 'inbox');
  assert.equal(h.pending.size, 0);
});

test('a history that could not be checked keeps the sign-in tutorial-free', async () => {
  const h = connectHarness({ history: 'unavailable' });
  await h.connect();
  assert.equal(h.versions['user:signed-in'], 2);
  assert.ok(h.calls.indexOf('sent') < h.calls.indexOf('persist'));
  assert.equal(h.calls.at(-1), 'inbox');
  assert.equal(h.pending.size, 0);
});

// While the decision is pending the account's payload is masked (chapter
// complete, so onboardingRequired false) and nothing is delivered for it. A
// state.json write, the daemon restart or the server's onboarding answer
// landing in that window would otherwise paint the inbox or Grow your network
// seconds before the handoff replaces them.
test('no payload reaches the renderer for an account whose history is still being read', () => {
  const push = main.slice(main.indexOf('async function pushInboxNow(force) {'), main.indexOf('// Refresh state-derived rows only'));
  const gate = push.indexOf('if (signInHistoryPending.has(onboardingAccountKey())) return;');
  assert.ok(gate >= 0, 'the gate exists');
  assert.ok(gate < push.indexOf('lastStateStatSig = stateFileStatSig();'), 'before the state generation is recorded, so the safety poll still owes a re-push');
  assert.ok(gate < push.indexOf('const payload = buildPayload();'), 'nothing is built, forced or not');
  const pump = main.slice(main.indexOf('function pumpAttention(prebuiltPayload = null) {'), main.indexOf('const digestMode ='));
  assert.match(pump, /\|\| signInHistoryPending\.has\(onboardingAccountKey\(payload\.account\)\)/, 'the welcome relay waits for the decided screen');
  // The masking itself, pinned byte for byte with the version check it feeds.
  assert.match(main, /const completedOnboardingVersion = signInHistoryPending\.has\(onboardingAccountKey\(currentAccount\)\)\s*\? COMPANION_ONBOARDING_VERSION\s*: onboardingVersionFor\(currentAccount\);/);
  assert.match(main, /onboardingRequired: currentAccount\.paired && \(networkOnboardingState\.required \|\| completedOnboardingVersion < COMPANION_ONBOARDING_VERSION\),/);
});

// Switch Account (You page, pairing code) hands the running pill a new account
// 3.5 s before it relaunches. The same history gate decides that account's
// chapter before anything paints for it, and persists the decision so the
// fresh process does not show "Checking..." until its own first sent fetch.
function switchHarness({ history, daemonFails = false }) {
  const start = main.indexOf('async function pairWithCode(input) {');
  const end = main.indexOf('\n}\n', start);
  const calls = [];
  const versions = {};
  const statuses = {};
  const pending = new Set();
  const observed = {};
  const res = { user: { id: 'switched', email: 'switched@example.com', name: 'Switched' }, deviceId: 'device' };
  class RelayClient {
    async registerDevice() { calls.push('register'); return res; }
  }
  const context = vm.createContext({
    console: { error: () => {} },
    adoptCurrentAccountFeatures: () => {},
    resetAccountViewCaches: () => {},
    loadAccountModules: async () => ({
      account: { normalizePairingCode: (code) => code, deviceNameForPairing: () => 'Mac',
        replacedDeviceCredential: () => { calls.push('read-previous'); return { deviceToken: 'dev_previous' }; },
        persistPairedAccount: () => { calls.push('persist-account'); observed.pendingAtPersist = [...pending]; },
        revokeReplacedDevice: async (previous, registration) => {
          calls.push('revoke-replaced');
          observed.revoked = { previous, registration };
          return 'revoked';
        } },
      notifications: { resetCompanionStateForAccount: () => { calls.push('reset'); observed.pendingAtReset = [...pending]; } },
    }),
    loadRelayModules: async () => ({ RelayClient }),
    readConfigFile: () => ({}), STATE_PATH: '/test/state', process: { platform: 'darwin' },
    onboardingAccountKey: (account) => `user:${account.userId}`, onboardingVersions: versions, COMPANION_ONBOARDING_VERSION: 2,
    signInHistoryPending: pending, firstRelayOnboarding: { status: (key) => statuses[key] || 'checking' },
    writeOverlayPrefs: () => calls.push('persist'),
    restartCompanionDaemon: async () => {
      calls.push('daemon');
      if (daemonFails) throw new Error('launchctl failed');
      return 'restarted';
    },
    refreshSent: async () => {
      observed.pendingDuringRefresh = [...pending];
      observed.versionDuringRefresh = 'user:switched' in versions ? versions['user:switched'] : 'unset';
      statuses['user:switched'] = history;
      calls.push('sent');
    },
    pushInbox: async (force) => calls.push(force ? 'inbox' : 'inbox-quiet'),
    relaunchPillSoon: () => calls.push('relaunch'), ACCOUNT_CHANGE_RELAUNCH_DELAY_MS: 3500,
  });
  const pair = vm.runInContext(`(${main.slice(start, end)}\n})`, context);
  return { calls, versions, pending, observed, pair: () => pair({ code: 'PAIR123' }) };
}

test('Switch Account decides the new account from its history before the pill paints it, then persists the decision', async () => {
  const h = switchHarness({ history: 'complete' });
  const result = await h.pair();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, email: 'switched@example.com', daemon: 'restarted' });
  assert.deepEqual(h.observed.pendingAtPersist, [], 'the account is current only once it is persisted');
  assert.deepEqual(h.observed.pendingAtReset, ['user:switched'], 'held back before the state.json write the watcher turns into a push');
  assert.deepEqual(h.observed.pendingDuringRefresh, ['user:switched']);
  assert.equal(h.observed.versionDuringRefresh, 'unset');
  assert.equal(h.versions['user:switched'], 2);
  assert.deepEqual(h.calls, ['read-previous', 'register', 'persist-account', 'revoke-replaced', 'reset', 'daemon', 'sent', 'persist', 'inbox', 'relaunch']);
  assert.equal(h.observed.revoked.previous.deviceToken, 'dev_previous', 'the credential read before registering is the one retired');
  assert.equal(h.observed.revoked.registration.deviceId, 'device', 'and only after the new one is stored');
  assert.equal(h.pending.size, 0);
});

test('Switch Account into an account with a confirmed empty history leaves its chapter open', async () => {
  const h = switchHarness({ history: 'waiting' });
  await h.pair();
  assert.equal('user:switched' in h.versions, false);
  assert.equal(h.calls.includes('persist'), false);
  assert.ok(h.calls.indexOf('sent') < h.calls.indexOf('inbox'), 'the decided payload is the first one pushed');
  assert.ok(h.calls.indexOf('inbox') < h.calls.indexOf('relaunch'));
  assert.equal(h.pending.size, 0);
});

test('a Switch Account that fails after the account is current releases the gate', async () => {
  const h = switchHarness({ history: 'complete', daemonFails: true });
  const result = await h.pair();
  assert.equal(result.ok, false);
  assert.equal(h.pending.size, 0, 'a stuck key would silence every later push for the account');
  assert.equal(h.versions['user:switched'], 2, 'an unchecked history keeps the switch tutorial-free, as in onConnected');
  assert.equal(h.calls.includes('sent'), false);
  assert.equal(h.calls.includes('inbox'), false);
  assert.equal(h.calls.includes('relaunch'), false);
});
