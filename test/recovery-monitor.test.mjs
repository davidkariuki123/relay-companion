import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recoveryMonitor, AWAKE_GRACE_MS, CHECK_OVERDUE_MS } from '../bootstrap/recovery-monitor.cjs';
import { write, read, launch } from '../bootstrap/recovery-launcher.cjs';
import { repairRecoverySchedule } from '../src/recovery-maintenance.js';
import { startRecoveryHeartbeat } from '../src/recovery-health.js';
import { collectInstallationHealth } from '../bootstrap/installation-health.cjs';
function fixture(t) {
  const homeDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-monitor-'));
  t.after(()=>fs.rmSync(homeDir,{recursive:true,force:true}));
  const root=path.join(homeDir,'.relay','recovery'), now=10*CHECK_OVERDUE_MS;
  const put=(file,data)=>write(path.join(root,file),data);
  put('daemon.json',{pid:process.pid,at:now,awakeSince:now-AWAKE_GRACE_MS-1});
  return {homeDir,root,now,put};
}
test('missing and overdue checks are flagged only on a continuously active computer', t=>{
  const f=fixture(t);
  assert.equal(recoveryMonitor(f).state,'missing');
  f.put('status.json',{status:'current',checkedAt:f.now-CHECK_OVERDUE_MS-1});
  assert.equal(recoveryMonitor(f).state,'overdue');
  f.put('daemon.json',{at:f.now,awakeSince:f.now});
  assert.equal(recoveryMonitor(f).state,'warming-up');
  f.put('daemon.json',{at:f.now-60_001,awakeSince:1});
  assert.equal(recoveryMonitor(f).state,'unverified');
});
test('disabled updates are never automatically repaired',t=>{
  const f=fixture(t); f.put('policy.json',{autoUpdate:false});
  assert.equal(recoveryMonitor(f).state,'disabled');
  assert.equal(repairRecoverySchedule({...f,repair:()=>assert.fail('disabled')}).status,'not-needed');
});
test('schedule repair is rate limited, preserves running recovery, and awaits an actual check', async t=>{
  const f=fixture(t); let calls=0;
  f.put('launcher.lock',{pid:process.pid});
  assert.equal(repairRecoverySchedule({...f,repair:()=>assert.fail('live')}).status,'busy');
  fs.rmSync(path.join(f.root,'launcher.lock'));
  let attemptedLaunch;
  const repair=options=>{
    calls++;assert.equal(options.homeDir,f.homeDir);
    attemptedLaunch=launch({root:f.root,run:()=>assert.fail('repair owns launcher admission')});
    assert.equal(read(path.join(f.root,'run.lock','owner.json')).pid,process.pid);
    return {ok:true};
  };
  assert.equal(repairRecoverySchedule({...f,repair}).status,'awaiting-check');
  assert.equal(recoveryMonitor(f).needsRepair,true,'registration alone proves no scheduled check');
  assert.equal(repairRecoverySchedule({...f,repair}).status,'backoff');assert.equal(calls,1);
  assert.equal((await attemptedLaunch).status,'already-running');
  f.put('status.json',{status:'current',ok:true,checkedAt:f.now+1});
  assert.equal(recoveryMonitor({...f,now:f.now+2}).repairStatus,'confirmed');
});
test('failed repair stays visible and cannot repeatedly restart scheduling', t=>{
  const f=fixture(t); let calls=0;
  const repair=()=>{calls++;throw Error('scheduler unavailable');};
  assert.equal(repairRecoverySchedule({...f,repair}).status,'failed');
  assert.equal(recoveryMonitor(f).repairStatus,'failed');
  assert.equal(repairRecoverySchedule({...f,repair}).status,'backoff');assert.equal(calls,1);
});
test('the heartbeat resets its awake window after sleep or clock reversal',t=>{
  const f=fixture(t); let tick,clock=f.now;
  startRecoveryHeartbeat({homeDir:f.homeDir,now:()=>clock,setIntervalImpl:fn=>{tick=fn;return {unref(){}};}});
  clock+=5000;tick();assert.equal(read(path.join(f.root,'daemon.json')).awakeSince,f.now);
  clock+=10*60_000;tick();assert.equal(read(path.join(f.root,'daemon.json')).awakeSince,clock);
  clock-=1000;tick();assert.equal(read(path.join(f.root,'daemon.json')).awakeSince,clock);
});
test('fleet report exposes missed checks and repair state without paths or errors',t=>{
  const f=fixture(t);f.put('maintenance.json',{status:'failed',at:f.now});
  const report=collectInstallationHealth({...f,commands:[]});
  assert.equal(report.recovery.failureCode,'recovery-checks-missing');
  assert.equal(report.recovery.monitor.repairStatus,'failed');
  assert.equal(JSON.stringify(report).includes(f.homeDir),false);
});
test('fallback and launcher failure are distinct from a stopped scheduler', t=>{
  const f=fixture(t);f.put('launcher-status.json',{status:'fallback',at:f.now});
  assert.equal(recoveryMonitor(f).state,'fallback');
  assert.equal(recoveryMonitor(f).needsRepair,false);
  f.put('launcher-status.json',{status:'failed',at:f.now});
  assert.equal(recoveryMonitor(f).state,'launcher-failed');
  assert.equal(recoveryMonitor(f).needsRepair,true);
});
