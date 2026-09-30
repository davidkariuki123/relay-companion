import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadMacLaunchAgent } from '../src/mac-launch-agent.js';

test('Mac repair retries asynchronous removal without repeatedly unloading the replacement', () => {
  const calls = []; let attempts = 0; let waits = 0;
  const result = reloadMacLaunchAgent({ label: 'work.relay.companion', plistPath: '/home/agent.plist', uid: 501,
    sleep: () => waits++, runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'bootstrap' && attempts++ < 2) return { ok: false, out: 'Bootstrap failed: 5: Input/output error' };
      return { ok: true };
    } });
  assert.equal(result.ok, true); assert.equal(waits, 2);
  assert.equal(calls.filter(c => c[1] === 'bootout').length, 1);
  assert.deepEqual(calls.at(-1), ['launchctl', 'print', 'gui/501/work.relay.companion']);
});
test('Mac repair is bounded and preserves non-transient failures', () => {
  for (const [out, expected] of [['Bootstrap failed: 5: Input/output error', 3], ['Operation not permitted', 1]]) {
    let bootstraps = 0;
    const result = reloadMacLaunchAgent({ label: 'x', plistPath: '/x', attempts: 3, sleep: () => {},
      runCommand: (_c, args) => { if (args[0] === 'bootstrap') bootstraps++; return { ok: false, out }; } });
    assert.equal(result.ok, false); assert.equal(result.detail, out); assert.equal(bootstraps, expected);
  }
});
test('Mac repair never reports success if the job is absent after bootstrap', () => {
  assert.equal(reloadMacLaunchAgent({ label: 'x', plistPath: '/x',
    runCommand: (_c, args) => ({ ok: args[0] !== 'print', out: 'not found' }) }).reason, 'launch-agent-not-registered');
});
