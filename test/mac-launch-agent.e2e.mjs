// Exercise real launchd with a disposable sleep job, never Relay's live services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reloadMacLaunchAgent } from '../src/mac-launch-agent.js';
if (process.platform !== 'darwin') { console.log('SKIP macOS only'); process.exit(0); }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launchd-test-'));
const label = `work.relay.test.${randomUUID()}`;
const plistPath = path.join(directory, 'test.plist');
const target = `gui/${process.getuid()}/${label}`;
const runCommand = (command,args) => { const r=spawnSync(command,args,{encoding:'utf8',timeout:10000}); return {ok:!r.error&&r.status===0,out:`${r.stdout||''}${r.stderr||''}`}; };
fs.writeFileSync(plistPath, `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>60</string></array><key>RunAtLoad</key><true/></dict></plist>`);
try {
  for (let i=0;i<3;i++) {
    const result = reloadMacLaunchAgent({label,plistPath,runCommand});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(runCommand('launchctl',['print',target]).ok,true);
  }
  console.log('PASS three consecutive real launchd registrations/reloads; job remains registered');
} finally { runCommand('launchctl',['bootout',target]); fs.rmSync(directory,{recursive:true,force:true}); }
