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
test('crashed selected engine falls back, and the next scheduled check prefers the proven copy', async t => {
  const {root,older,newer} = fixture(t); const calls=[];
  const run = async (p,{runId}) => {
    calls.push(p.version);
    if(p.version === newer.version) return {ok:false,reason:'exit'};
    write(path.join(root,'status.json'),{ok:true,status:'current',launcherVersion:p.version,runId,checkedAt:Date.now()});
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
    write(path.join(root,'status.json'),{ok:true,status:'current',launcherVersion:p.version,runId,checkedAt:Date.now()}); return {ok:true};
  }});
  assert.equal(read(path.join(root,'known-good.json')).bundle,newer.bundle);
  assert.equal(read(path.join(root,'previous-good.json')).bundle,older.bundle);
});
test('an internal failure cannot carry its retry backoff into the proven fallback', async t => {
  const {root,newer}=fixture(t);
  const result=await launch({root,run:async(p,{runId})=>{
    if(p.version===newer.version){
      write(path.join(root,'status.json'),{ok:false,status:'failed',lastError:'Cannot read properties of undefined',retryAt:Date.now()+60000,launcherVersion:p.version,runId,checkedAt:Date.now()});
      return {ok:false,reason:'exit'};
    }
    assert.equal(read(path.join(root,'status.json')).retryAt,0);
    write(path.join(root,'status.json'),{ok:true,status:'current',launcherVersion:p.version,runId,checkedAt:Date.now()});return {ok:true};
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
    assert.equal(p.bundle,older.bundle);write(path.join(root,'status.json'),{ok:true,status:'ahead',launcherVersion:p.version,runId,checkedAt:Date.now()});return {ok:true};
  }});
  assert.equal(read(path.join(root,'launcher-status.json')).status,'fallback');
});
test('the installed standalone launcher survives a real syntax error in the selected recovery module', async t => {
  const {root,older,newer}=fixture(t);
  fs.mkdirSync(path.dirname(older.node),{recursive:true});fs.copyFileSync(process.execPath,older.node);fs.chmodSync(older.node,0o700);
  for(const p of [older,newer]) fs.mkdirSync(path.join(p.bundle,'bootstrap'),{recursive:true});
  fs.writeFileSync(path.join(newer.bundle,'bootstrap','recovery-runner.cjs'),'this is invalid javascript {{');
  fs.writeFileSync(path.join(older.bundle,'bootstrap','recovery-runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'status.json'))},JSON.stringify({ok:true,status:'current',launcherVersion:'1.0.0',runId:process.env.RELAY_RECOVERY_RUN_ID,checkedAt:Date.now()}));`);
  fs.copyFileSync(new URL('../bootstrap/recovery-launcher.cjs',import.meta.url),path.join(root,'launch.cjs'));
  const result=spawnSync(process.execPath,[path.join(root,'launch.cjs')],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(read(path.join(root,'launcher-status.json')).status,'fallback');
});
test('a genuinely hung recovery process is stopped before the fallback starts', async t => {
  const {root,older,newer}=fixture(t);
  fs.mkdirSync(path.dirname(older.node),{recursive:true});fs.copyFileSync(process.execPath,older.node);fs.chmodSync(older.node,0o700);
  for(const p of [older,newer]) fs.mkdirSync(path.join(p.bundle,'bootstrap'),{recursive:true});
  const pidFile=path.join(root,'hung.json');
  fs.writeFileSync(path.join(newer.bundle,'bootstrap','recovery-runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(older.bundle,'bootstrap','recovery-runner.cjs'),`const fs=require('node:fs');const {pid}=JSON.parse(fs.readFileSync(${JSON.stringify(pidFile)}));try{process.kill(pid,0);process.exit(2);}catch{};fs.writeFileSync(${JSON.stringify(path.join(root,'status.json'))},JSON.stringify({ok:true,status:'current',launcherVersion:'1.0.0',runId:process.env.RELAY_RECOVERY_RUN_ID,checkedAt:Date.now()}));`);
  assert.equal((await launch({root,timeoutMs:5000,attemptTimeoutMs:500})).status,'fallback');
});
