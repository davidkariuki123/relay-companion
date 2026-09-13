import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const start = html.indexOf('      const canReact =');
const end = html.indexOf('      const chunkDivider =', start);
const pickerStart = html.indexOf('  function messageReactionPickerHtml(id)');
const pickerEnd = html.indexOf('  function reactionConfirmationHtml', pickerStart);
assert.ok(start >= 0 && end > start && pickerStart >= 0 && pickerEnd > pickerStart);
// Execute the actual renderer's action selection with both sides of its permission gates.
const render = new Function('m', 'mine', 'payload', 'groupPostingBlocked', 'messageDeleteConfirmIds',
  `const textLike=true, attachmentOnly=false, editingMessage=false, esc=s=>String(s);
   const REACTIONS_ENABLED=true, RX_PRIMARY=['👍'];
   ${html.slice(pickerStart, pickerEnd)}
   ${html.slice(start, end)}; return sideMenuHtml;`);
const message = { id:'message-1', body:'Hello' };
const enabled = { features:{ messageMutations:true } };

test('side menu retains reply but restricts mutation actions to eligible sent messages', () => {
  const sent = render(message, true, enabled, false, new Set());
  assert.match(sent, /data-reply-to=/);
  assert.match(sent, /data-message-edit=/);
  assert.match(sent, /data-message-delete=/);
  assert.match(sent, /data-rx-pick="message-1"/);
  for (const [item, mine, flags] of [
    [message, false, enabled],
    [message, true, {}],
    [{...message, pending:true}, true, enabled],
  ]) {
    const result = render(item, mine, flags, false, new Set());
    assert.match(result, /data-reply-to=/);
    assert.doesNotMatch(result, /data-message-(?:edit|delete)=/);
  }
  assert.equal(render(message, false, enabled, true, new Set()), '');
  assert.equal(render({...message, deletedAt:'2026-09-08'}, true, enabled, false, new Set()), '');
  assert.doesNotMatch(render({...message, pending:true}, true, enabled, false, new Set()), /data-rx-pick=/);
});

test('delete still requires a second deliberate action inside the menu', () => {
  const initial = render(message, true, enabled, false, new Set());
  assert.doesNotMatch(initial, /data-message-delete-confirm=/);
  const confirming = render(message, true, enabled, false, new Set([message.id]));
  assert.match(confirming, /data-message-delete-confirm=/);
  assert.match(confirming, /data-message-delete-cancel=/);
  assert.doesNotMatch(confirming, /data-message-delete=/);
});
