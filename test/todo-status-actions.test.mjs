import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
const html=fs.readFileSync(new URL('../overlay/inbox.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('  async function commitTodoStatus('),html.indexOf('  function wireReaderTodoStatus('));
function harness(results, stop={ok:true}) {
  const calls=[],notices=[];
  const row={todoStatus:'triage',todoVersion:7};
  const context=vm.createContext({
    payload:{account:'self'},accountCacheIdentity:a=>a,crypto:{randomUUID},
    window:{relay:{todoStatusUpdate:async(id,input)=>{calls.push(['update',id,input]);return results.shift();},taskStop:async id=>{calls.push(['stop',id]);return typeof stop==='function'?stop():stop;}}},
    readerRow:()=>row,todoItemById:()=>row,setRowNote(){},clearRowNote(){},loadTodo:async()=>{},
    showTodoRemovalNotice:message=>notices.push(message),activeView:'tasks',
  });
  vm.runInContext(source,context);
  return {context,calls,row,notices,run:(cancel=true)=>context.commitTodoStatus('task_1',cancel?'canceled':'done',7,'',cancel)};
}
test('Mark as done updates the status without stopping a task or changing visibility',async()=>{
 const h=harness([{ok:true,status:'done',version:8}]);assert.equal(await h.run(false),true);assert.equal(h.calls.length,1);assert.equal(h.row.todoStatus,'done');
});
test('a stuck task stops then cancels with the same version and idempotency key',async()=>{
 const h=harness([{ok:false,code:'task_active'},{ok:true,status:'canceled',version:8}]);assert.equal(await h.run(),true);assert.deepEqual(h.calls.map(c=>c[0]),['update','stop','update']);assert.strictEqual(h.calls[0][2],h.calls[2][2]);assert.equal(h.row.todoStatus,'canceled');
});
test('idle tasks cancel without stopping; version conflicts never stop newer work',async()=>{
 for(const result of [{ok:true,status:'canceled',version:8},{ok:false,code:'todo_version_conflict',error:'Changed elsewhere',details:{currentVersion:9,currentStatus:'in_progress'}}]){
 const h=harness([result]);await h.run();assert.equal(h.calls.length,1);if(!result.ok){assert.equal(h.row.todoVersion,9);assert.equal(h.notices[0],'Changed elsewhere');}}
});
test('stop failure leaves status intact and surfaces an error',async()=>{
 const h=harness([{ok:false,code:'task_active'}],{ok:false,error:'Only the claimant can stop this task'});assert.equal(await h.run(),false);assert.equal(h.calls.length,2);assert.equal(h.row.todoStatus,'triage');assert.equal(h.notices.length,1);
});
test('switching accounts while stopping never cancels in the new account',async()=>{
 const h=harness([{ok:false,code:'task_active'}],()=>{h.context.payload.account='other';return {ok:true};});assert.equal(await h.run(),false);assert.equal(h.calls.length,2);assert.equal(h.notices.length,0);
});
