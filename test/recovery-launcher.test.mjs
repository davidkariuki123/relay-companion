import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch, write, read } from '../bootstrap/recovery-launcher.cjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launcher-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const pointer = (v, hash) => ({schema:1,version:v,bundle:path.join(root,'versions',hash.repeat(64)),node:path.join(root,'node','owned',process.platform === 'win32' ? 'node.exe' : 'node')});
  const older = pointer('1.0.0','a'), newer = pointer('1.0.1','b');
  write(path.join(root,'current.json'),newer); write(path.join(root,'known-good.json'),older);
  return {root,older,newer};
}

test('a completed deferral never calls the installation healthy or promotes the engine', async t => {
  const {root,older} = fixture(t);
  const result = await launch({root,run:async(p,{runId}) => {
    write(path.join(root,'status.json'),{ok:true,status:'deferred-memory-pressure',launcherVersion:p.version,runId,checkedAt:Date.now()});
    return {ok:true};
  }});
  assert.equal(result.status,'runner-completed');
  assert.equal(read(path.join(root,'launcher-status.json')).runtimeStatus,'deferred-memory-pressure');
  assert.equal(read(path.join(root,'known-good.json')).bundle,older.bundle);
});
test('crashed selected engine falls back, and the next scheduled check prefers the proven copy', async t => {
  const {root,older,newer} = fixture(t); const calls=[];
  const run = async (p,{runId}) => {
    calls.push(p.version);
    if(p.version === newer.version) return {ok:false,reason:'exit'};
    write(path.join(root,'status.json'),{ok:true,status:'current',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()});
    return {ok:true};
  };
  assert.equal((await launch({root,run})).status,'fallback');
  assert.deepEqual(calls,['1.0.1','1.0.0']); calls.length=0;
  assert.equal((await launch({root,run})).status,'fallback');
  assert.deepEqual(calls,['1.0.0']);
  assert.equal(read(path.join(root,'known-good.json')).bundle,older.bundle);
});
test('fresh successful check promotes a candidate and retains the previous proven engine', async t => {
  const {root,older,newer}=fixture(t);
  await launch({root,run:async (p,{runId}) => {
    write(path.join(root,'status.json'),{ok:true,status:'current',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()}); return {ok:true};
  }});
  assert.equal(read(path.join(root,'known-good.json')).bundle,newer.bundle);
  assert.equal(read(path.join(root,'previous-good.json')).bundle,older.bundle);
});

test('a legacy current label without readiness evidence cannot promote a recovery engine', async t => {
  const {root,older}=fixture(t);
  const result = await launch({root,run:async(p,{runId}) => {
    write(path.join(root,'status.json'),{ok:true,status:'current',launcherVersion:p.version,runId,checkedAt:Date.now()});
    return {ok:true};
  }});
  assert.equal(result.status,'runner-completed');
  assert.equal(read(path.join(root,'known-good.json')).bundle,older.bundle);
});
test('an internal failure cannot carry its retry backoff into the proven fallback', async t => {
  const {root,newer}=fixture(t);
  const result=await launch({root,run:async(p,{runId})=>{
    if(p.version===newer.version){
      write(path.join(root,'status.json'),{ok:false,status:'failed',lastError:'Cannot read properties of undefined',retryAt:Date.now()+60000,launcherVersion:p.version,runId,checkedAt:Date.now()});
      return {ok:false,reason:'exit'};
    }
    assert.equal(read(path.join(root,'status.json')).retryAt,0);
    write(path.join(root,'status.json'),{ok:true,status:'current',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()});return {ok:true};
  }});
  assert.equal(result.status,'fallback');
});
test('network errors are retryable; startup success alone never proves a replacement', async t => {
  const {root,older} = fixture(t); let calls=0;
  const result=await launch({root,run:async(p,{runId}) => {
    calls++;write(path.join(root,'status.json'),{ok:false,status:'failed',lastError:'fetch failed',launcherVersion:p.version,runId,checkedAt:Date.now()});return {ok:false,reason:'exit'};
  }});
  assert.equal(result.status,'runner-error'); assert.equal(calls,1);
  assert.equal(read(path.join(root,'known-good.json')).bundle,older.bundle);
});
test('corrupt pointer uses the recorded fallback, without trusting an arbitrary path', async t => {
  const {root,older}=fixture(t);write(path.join(root,'current.json'),{schema:1,bundle:'/elsewhere',version:'1.2.3'});
  await launch({root,run:async(p,{runId}) => {
    assert.equal(p.bundle,older.bundle);write(path.join(root,'status.json'),{ok:true,status:'ahead',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()});return {ok:true};
  }});
  assert.equal(read(path.join(root,'launcher-status.json')).status,'fallback');
});
test('the installed standalone launcher survives a real syntax error in the selected recovery module', async t => {
  const {root,older,newer}=fixture(t);
  fs.mkdirSync(path.dirname(older.node),{recursive:true});fs.copyFileSync(process.execPath,older.node);fs.chmodSync(older.node,0o700);
  for(const p of [older,newer]) fs.mkdirSync(path.join(p.bundle,'bootstrap'),{recursive:true});
  fs.writeFileSync(path.join(newer.bundle,'bootstrap','recovery-runner.cjs'),'this is invalid javascript {{');
  fs.writeFileSync(path.join(older.bundle,'bootstrap','recovery-runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'status.json'))},JSON.stringify({ok:true,status:'current',runtimeHealthy:true,launcherVersion:'1.0.0',runId:process.env.RELAY_RECOVERY_RUN_ID,checkedAt:Date.now()}));`);
  fs.copyFileSync(new URL('../bootstrap/recovery-launcher.cjs',import.meta.url),path.join(root,'launch.cjs'));
  const result=spawnSync(process.execPath,[path.join(root,'launch.cjs')],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(read(path.join(root,'launcher-status.json')).status,'fallback');
});
test('a genuinely hung recovery process is stopped before the fallback starts', async t => {
  const {root,older,newer}=fixture(t);
  fs.mkdirSync(path.dirname(older.node),{recursive:true});fs.copyFileSync(process.execPath,older.node);fs.chmodSync(older.node,0o700);
  for(const p of [older,newer]) fs.mkdirSync(path.join(p.bundle,'bootstrap'),{recursive:true});
  // Liveness is proven through a socket the hung runner listens on, never its pid:
  // Windows hands a freed pid to the next process within milliseconds, so under a
  // busy suite a pid probe can meet a stranger and call the stopped runner "hung".
  const readyFile=path.join(root,'hung.json'), verdictFile=path.join(root,'verdict.txt');
  fs.writeFileSync(path.join(newer.bundle,'bootstrap','recovery-runner.cjs'),`const server=require('node:net').createServer(socket=>socket.on('error',()=>{}));server.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({pid:process.pid,port:server.address().port})));`);
  fs.writeFileSync(path.join(older.bundle,'bootstrap','recovery-runner.cjs'),`const fs=require('node:fs');const net=require('node:net');
    let ready;try{ready=JSON.parse(fs.readFileSync(${JSON.stringify(readyFile)}));}catch(e){fs.writeFileSync(${JSON.stringify(verdictFile)},'hung runner never became ready: '+e.code);process.exit(3);}
    const probe=net.connect(ready.port,'127.0.0.1');
    probe.once('connect',()=>{fs.writeFileSync(${JSON.stringify(verdictFile)},'hung runner still accepting connections');process.exit(2);});
    probe.once('error',()=>{fs.writeFileSync(${JSON.stringify(verdictFile)},'stopped');fs.writeFileSync(${JSON.stringify(path.join(root,'status.json'))},JSON.stringify({ok:true,status:'current',runtimeHealthy:true,launcherVersion:'1.0.0',runId:process.env.RELAY_RECOVERY_RUN_ID,checkedAt:Date.now()}));process.exit(0);});`);
  // A cold node start on a loaded machine can exceed half a second; the attempt
  // window must let the hung runner become ready before the launcher stops it.
  const result=await launch({root,timeoutMs:20000,attemptTimeoutMs:2000});
  const verdict=fs.existsSync(verdictFile)?fs.readFileSync(verdictFile,'utf8'):'fallback runner never ran';
  const log=fs.existsSync(path.join(root,'recovery.log'))?fs.readFileSync(path.join(root,'recovery.log'),'utf8'):'';
  assert.equal(result.status,'fallback',`${verdict}
${log}`);
  assert.equal(verdict,'stopped');
});
test('a deadline that interrupts a working runner does not quarantine its bundle, and the log says why', async t => {
  const {root,older,newer}=fixture(t); const calls=[];
  const run = async (p,{runId}) => {
    calls.push(p.version);
    if (p.version===newer.version) { write(path.join(root,'status.json'),{ok:true,status:'downloading',launcherVersion:p.version,runId,checkedAt:Date.now()}); return {ok:false,reason:'deadline'}; }
    write(path.join(root,'status.json'),{ok:true,status:'current',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()}); return {ok:true};
  };
  assert.equal((await launch({root,run})).status,'fallback');
  const status=read(path.join(root,'launcher-status.json'));
  assert.equal(status.failedBundle,null); assert.equal(status.retryAt,null);
  // The selected bundle is tried first again on the next check: slow is not broken.
  calls.length=0; await launch({root,run}); assert.deepEqual(calls,['1.0.1','1.0.0']);
  const log=fs.readFileSync(path.join(root,'recovery.log'),'utf8');
  assert.match(log,/launcher result bundle=1\.0\.1 .*ok=false reason=deadline reported=downloading/);
  assert.match(log,/launcher done status=fallback quarantined=no/);
  // A silent hang (no status written) is still a real failure of that bundle.
  const silent = async (p,{runId}) => { if (p.version===newer.version) return {ok:false,reason:'deadline'};
    write(path.join(root,'status.json'),{ok:true,status:'current',runtimeHealthy:true,launcherVersion:p.version,runId,checkedAt:Date.now()}); return {ok:true}; };
  await launch({root,run:silent});
  assert.equal(read(path.join(root,'launcher-status.json')).failedBundle,newer.bundle);
  assert.equal(older.version,'1.0.0');
});
test('a failed in-place repair is retried by the same bundle next check, never handed to an older runner', async t => {
  const {root,newer}=fixture(t); const calls=[];
  for (const status of ['restart-failed','reactivate-failed']) {
    write(path.join(root,'launcher-status.json'),{schema:1,status:'healthy'});
    const result=await launch({root,run:async(p,{runId})=>{
      calls.push(p.version);
      write(path.join(root,'status.json'),{ok:false,status,restarts:1,lastError:'service-start-failed',launcherVersion:p.version,runId,checkedAt:Date.now()});
      return {ok:false,reason:'exit'};
    }});
    assert.equal(result.status,'runner-error');
    assert.equal(read(path.join(root,'launcher-status.json')).failedBundle,undefined);
  }
  assert.deepEqual(calls,[newer.version,newer.version]);
});
