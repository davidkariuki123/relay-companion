import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentToolSurface } from '../src/agent-tool-surface.js';
import { TOOLS, toolsForAccount, toolsForE2eeLocalAccount } from '../src/mcp.js';

const features = { requests: true, todo: true, aiSessions: true, connectors: true, messageMutations: true };
const caller = { host: 'codex', nativeId: 'thread_test', cwd: os.tmpdir() };
const key = 'stable-test-key';
const message = { title: 'A useful test message', forHuman: 'Here is the update.', forAgent: 'The complete context.', idempotencyKey: key };
const cases = {
  relay_ai_sessions: [{ action: 'list' }, 'listSessions'],
  relay_ai_session: [{ action: 'send', aiSessionId: 'ses_test', message: 'Continue', idempotencyKey: key }, 'createSessionOperation'],
  relay_agent_progress: [{ runRelayId: 'run_test', summary: 'Working' }, 'agentRunProgress'],
  relay_task_start: [{ taskRelayId: 'relay_test', idempotencyKey: key }, 'taskStarted'],
  relay_task_complete: [{ taskRelayId: 'relay_test', ...message }, 'taskCompleted'],
  relay_task_unclaim: [{ taskRelayId: 'relay_test', idempotencyKey: key }, 'taskUnclaimed'],
  relay_todo_update: [{ itemId: 'item_test', status: 'triage', expectedVersion: 1, idempotencyKey: key }, 'updateTodoStatus'],
  relay_todo_visibility: [{ itemId: 'item_test', removed: true, expectedVersion: 1, idempotencyKey: key }, 'updateTodoVisibility'],
  relay_todo_reorder: [{ status: 'triage', itemIds: ['item_test'], idempotencyKey: key }, 'reorderTodo'],
  relay_agent_complete: [{ runRelayId: 'run_test', ...message }, 'agentRunComplete'],
  relay_send: [{ recipient: { contactId: 'con_test' }, kind: 'message', ...message }, 'sendRelay'],
  relay_share_link: [{ ...message }, 'mintShareLink'],
  relay_contacts_search: [{ query: 'Test' }, 'searchContacts'],
  relay_groups_list: [{}, 'groups'],
  relay_group_create: [{ name: 'Test', memberContactIds: ['con_test'] }, 'addGroupMember'],
  relay_group_update: [{ groupId: 'grp_test', name: 'Renamed' }, 'renameGroup'],
  relay_group_delete: [{ groupId: 'grp_test' }, 'deleteGroup'],
  relay_contact_update: [{ contactId: 'con_test', firstName: 'Test', idempotencyKey: key }, 'updateContact'],
  relay_inbox_list: [{}, 'inbox'],
  relay_sent_list: [{}, 'sent'],
  relay_thread_fetch: [{ threadId: 'relay_test' }, 'thread'],
  relay_chats_list: [{}, 'chats'],
  relay_chat_fetch: [{ chatId: 'chat_test' }, 'chat'],
  relay_chat_send: [{ chatId: 'chat_test', forHuman: 'Plain text.', idempotencyKey: key }, 'sendRelay'],
  relay_message_edit: [{ relayId: 'relay_test', forHuman: 'Corrected.', idempotencyKey: key }, 'editMessage'],
  relay_message_delete: [{ relayId: 'relay_test', idempotencyKey: key }, 'deleteMessage'],
  relay_mark_read: [{ relayId: 'relay_test', idempotencyKey: key }, 'markRead'],
  relay_inbox_delete: [{ itemId: 'item_test', idempotencyKey: key }, 'deleteInboxItem'],
  relay_recently_deleted_list: [{}, 'recentlyDeleted'],
  relay_recently_deleted_restore: [{ itemId: 'item_test', idempotencyKey: key }, 'restoreInboxItem'],
  relay_file_download: [{ fileId: 'file_test' }, 'fileDownload'],
  relay_connector_list_tools: [{}, 'toolCatalog'],
  relay_connector_request_approval: [{ provider: 'test', toolName: 'write', approvalSummary: 'Write one item', idempotencyKey: key }, 'requestToolApproval'],
  relay_connector_call_tool: [{ provider: 'test', toolName: 'read', arguments: {}, idempotencyKey: key }, 'callTool'],
};
function surface(client, options = {}) {
  return createAgentToolSurface(client, { featuresReader: async () => features, encryptionReader: async () => ({ enabled: false }), ...options });
}

test('every current MCP capability is discoverable and reaches its canonical handler without MCP', async () => {
  assert.deepEqual(Object.keys(cases).sort(), TOOLS.map(t => t.name).sort(), 'new MCP capabilities require a handler exercise here');
  const calls = [];
  const client = new Proxy({}, { get: (_, method) => async (...args) => {
    calls.push({ method, args });
    return { id: 'grp_test', chatId: 'chat_test', relayId: 'relay_test', state: 'sent', items: [], contacts: [], groups: [], sessions: [], operation: { id: 'op_test' } };
  } });
  const api = surface(client);
  assert.deepEqual((await api.list(caller)).tools, toolsForAccount(features, 'codex'));
  for (const [name, [args, expectedMethod]] of Object.entries(cases)) {
    calls.length = 0;
    const result = await api.call(name, args, caller);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    assert.ok(calls.some(c => c.method === expectedMethod), `${name} must invoke ${expectedMethod}`);
  }
});

test('catalog and calls obey live product and encryption restrictions', async () => {
  let current = features;
  let encrypted = false;
  let writes = 0;
  const api = surface({ deleteMessage: async () => { writes++; } }, {
    featuresReader: async () => current,
    encryptionReader: async () => ({ enabled: encrypted }),
  });
  current = { requests: false, aiSessions: false, todo: false, connectors: false, messageMutations: false };
  assert.deepEqual((await api.list(caller)).tools, toolsForAccount(current, 'codex'));
  assert.equal((await api.call('relay_message_delete', cases.relay_message_delete[0], caller)).isError, true);
  assert.equal((await api.call('relay_connector_call_tool', {}, caller)).isError, true);
  current = features;
  encrypted = true;
  assert.deepEqual((await api.list(caller)).tools, toolsForE2eeLocalAccount(features, 'codex'));
  assert.equal((await api.call('relay_share_link', message, caller)).isError, true);
  assert.equal(writes, 0);
  assert.equal((await api.call('relay_unknown', {}, caller)).isError, true);
  assert.equal((await api.call('relay_groups_list', [], caller)).isError, true);
});

test('caller workspace, provenance and native session survive the helper boundary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tool-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'note.txt'), 'attachment from caller');
  let sent;
  let started;
  const api = surface({ sendRelay: async body => { sent = body; return { relayId: 'relay_test', state: 'sent' }; }, taskStarted: async (_, body) => { started = body; return {}; } });
  const source = { ...caller, cwd: root };
  const result = await api.call('relay_send', { ...cases.relay_send[0], files: ['note.txt'] }, source);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(sent.source.host, 'relay-agent-protocol');
  assert.equal(sent.source.surface, 'codex');
  assert.equal(Buffer.from(sent.attachments[0].contentBase64, 'base64').toString(), 'attachment from caller');
  await api.call('relay_task_start', cases.relay_task_start[0], source);
  assert.equal(started.sourceProvider, 'codex');
  assert.equal(started.sourceNativeId, 'thread_test');
});

test('review state persists across calls and is isolated between callers; API remedies survive', async () => {
  let sends = 0;
  const api = surface({ sendRelay: async () => { sends++; return { relayId: 'relay_test' }; }, updateContact: async () => { throw Object.assign(new Error('invalid_request'), { body: { issues: [{ path: ['firstName'], message: 'Required' }] } }); } });
  const draft = { ...cases.relay_send[0], forHuman: 'word '.repeat(100).trim(), longForHumanConfirmed: true };
  assert.equal((await api.call('relay_send', draft, caller)).isError, true);
  assert.equal((await api.call('relay_send', draft, { ...caller, nativeId: 'other' })).isError, true);
  assert.equal(sends, 0);
  assert.notEqual((await api.call('relay_send', draft, caller)).isError, true);
  assert.equal(sends, 1);
  const error = await api.call('relay_contact_update', {}, caller);
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /firstName: Required/);
});
