import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = fs.readFileSync(new URL('../overlay/main.cjs', import.meta.url), 'utf8');
const start = main.indexOf('  const explicit = entry.recipient || {};', main.indexOf('async function postQueuedRelay'));
const end = main.indexOf('\n}\n', start);
const transport = main.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

function harness({ failSend=false, failRefresh=false }={}) {
  const calls=[];
  const result={relayId:'sent-relay',contact:{email:'new@example.com',autoCreated:true}};
  const send = new AsyncFunction('entry','client','prepared','text','files','refreshContacts','refreshCanonicalChats',transport);
  return {calls,result,run:()=>send({recipient:{email:'new@example.com'},idempotencyKey:'one-reply'},
    {sendRelay:async()=>{calls.push('send');if(failSend)throw Error('send refused');return result;}},
    [],'Hello',[],async()=>{calls.push('contacts');if(failRefresh)throw Error('offline');},async()=>{})};
}
test('a successful direct reply refreshes the server-created contact before returning',async()=>{
  const h=harness();assert.equal(await h.run(),h.result);assert.deepEqual(h.calls,['send','contacts']);
});
test('a rejected reply never refreshes or accepts the sender',async()=>{
  const h=harness({failSend:true});await assert.rejects(h.run(),/send refused/);assert.deepEqual(h.calls,['send']);
});
test('a contact refresh failure does not fail or resend an already delivered reply',async()=>{
  const h=harness({failRefresh:true});assert.equal(await h.run(),h.result);assert.deepEqual(h.calls,['send','contacts']);
});
