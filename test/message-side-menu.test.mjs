import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const start = html.indexOf('      const canReact =');
const end = html.indexOf('      const chunkDivider =', start);
const pickerStart = html.indexOf('  function messageReactionPickerHtml(id)');
const pickerEnd = html.indexOf('  function reactionConfirmationHtml', pickerStart);
const rulesStart = html.indexOf('  const MESSAGE_EDIT_WINDOW_MS =');
const rulesEnd = html.indexOf('  const threadEditTargets = new Map();', rulesStart);
assert.ok(start >= 0 && end > start && pickerStart >= 0 && pickerEnd > pickerStart && rulesStart >= 0 && rulesEnd > rulesStart);
// Execute the actual renderer's action selection with both sides of its
// permission gates, and the real edit/delete rules (WhatsApp's windows).
const render = new Function('m', 'mine', 'payload', 'groupPostingBlocked', 'messageDeleteConfirmIds',
  `const textLike=true, attachmentOnly=false, editingMessage=false, esc=s=>String(s);
   const REACTIONS_ENABLED=true, RX_PRIMARY=['👍'];
   ${html.slice(rulesStart, rulesEnd)}
   ${html.slice(pickerStart, pickerEnd)}
   ${html.slice(start, end)}; return sideMenuHtml;`);
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
const message = { id:'message-1', body:'Hello', at:minutesAgo(1) };
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

test("WhatsApp's windows: edit for 15 minutes, delete for everyone for 2 days", () => {
  const sixteenMinutes = render({...message, at:minutesAgo(16)}, true, enabled, false, new Set());
  assert.doesNotMatch(sixteenMinutes, /data-message-edit=/, 'a 16-minute-old text can no longer be edited');
  assert.match(sixteenMinutes, /data-message-delete=/, 'but it can still be deleted');
  const fourteenMinutes = render({...message, at:minutesAgo(14)}, true, enabled, false, new Set());
  assert.match(fourteenMinutes, /data-message-edit=/);
  const threeDays = render({...message, at:minutesAgo(3 * 24 * 60)}, true, enabled, false, new Set());
  assert.doesNotMatch(threeDays, /data-message-(?:edit|delete)=/, 'after 2 days neither verb is offered');
  // Editing does not reopen the window: the age is the send, not the edit.
  const editedLate = render({...message, at:minutesAgo(20), editedAt:minutesAgo(1)}, true, enabled, false, new Set());
  assert.doesNotMatch(editedLate, /data-message-edit=/);
});

test('the menu never carries the delete confirmation; that question lives under the bubble', () => {
  const confirming = render(message, true, enabled, false, new Set([message.id]));
  assert.doesNotMatch(confirming, /data-message-delete-confirm=/);
  assert.match(confirming, /data-message-delete=/);
});
