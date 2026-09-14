import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../overlay/main.cjs', import.meta.url), 'utf8');
const start = main.indexOf('  const explicit = entry.recipient || {};', main.indexOf('async function postQueuedRelay'));
const end = main.indexOf('\n}\n', start);
const transport = main.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

function harness({ failSend=false, failRefresh=false, clientMessageId }={}) {
  const calls=[];
  const result={relayId:'sent-relay',contact:{email:'new@example.com',autoCreated:true}};
  const send = new AsyncFunction('entry','client','prepared','text','files','refreshContacts','refreshCanonicalChats',transport);
  return {calls,result,run:()=>send({recipient:{email:'new@example.com'},idempotencyKey:'one-reply',clientMessageId},
    {sendRelay:async(request)=>{calls.push('send');assert.equal(request.source.clientMessageId,clientMessageId);if(failSend)throw Error('send refused');return result;}},
    [],'Hello',[],async()=>{calls.push('contacts');if(failRefresh)throw Error('offline');},async()=>{})};
}
test('a successful direct reply returns its receipt without waiting for contacts',async()=>{
  const h=harness();assert.equal(await h.run(),h.result);assert.deepEqual(h.calls,['send']);
});
test('a rejected reply never refreshes or accepts the sender',async()=>{
  const h=harness({failSend:true});await assert.rejects(h.run(),/send refused/);assert.deepEqual(h.calls,['send']);
});
test('a contact refresh failure does not fail or resend an already delivered reply',async()=>{
  const h=harness({failRefresh:true});assert.equal(await h.run(),h.result);assert.deepEqual(h.calls,['send']);
});
test('the transport carries the new queue entry identity through source metadata',async()=>{
  const h=harness({clientMessageId:'one-reply'});assert.equal(await h.run(),h.result);
});

test('accepted sends coalesce background contact and history refreshes and tolerate failure',async()=>{
  const calls=[];
  let timer;
  const context=vm.createContext({
    setTimeout(fn){timer=fn;return {unref(){}};},
    refreshSent:async()=>{calls.push('sent');},
    refreshContacts:async()=>{calls.push('contacts');throw Error('offline');},
    refreshCanonicalChats:async()=>{calls.push('chats');},
    pushInboxQuiet:()=>{calls.push('paint');},
  });
  const from=main.indexOf('let queuedSendRefreshTimer = null;');
  const to=main.indexOf('// ---- payload assembly',from);
  vm.runInContext(main.slice(from,to),context);
  context.refreshAfterQueuedSend();
  context.refreshAfterQueuedSend();
  assert.deepEqual(calls,[],'no cache request delays the delivery acknowledgement');
  timer();
  await new Promise(setImmediate);
  assert.deepEqual(calls,['sent','contacts','chats','paint']);
  assert.match(main,/onSent: \(\) => refreshAfterQueuedSend\(\)/);
});
