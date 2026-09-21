import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {saveDesktopTeachingContext} from '../src/desktop-teaching-context.js';
test('verified desktop context reaches the existing tutorial without losing retry identity',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-context-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'agent-protocol.json');
 const run={id:'run-one',stage:'teaching',accountId:'usr_test',context:{inviter:{name:'Alex',relayUserId:'usr_alex'}}};const apiUrl='https://api.sendrelays.com';
 assert.throws(()=>saveDesktopTeachingContext({directory,run:{...run,stage:'browser'},apiUrl}));
 saveDesktopTeachingContext({directory,run,apiUrl});let saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.inviter.relayUserId,'usr_alex');assert.equal(saved.tutorial.state,'pending');
 saved.accessToken='web_keep_existing_credential';saved.tutorial={state:'attempting',idempotencyKey:'retry-the-same-send'};fs.writeFileSync(file,JSON.stringify(saved));
 saveDesktopTeachingContext({directory,run,apiUrl});saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.accessToken,'web_keep_existing_credential');assert.equal(saved.tutorial.idempotencyKey,'retry-the-same-send');
 assert.throws(()=>saveDesktopTeachingContext({directory,run:{...run,accountId:'usr_other'},apiUrl}));
 assert.throws(()=>saveDesktopTeachingContext({directory,run,apiUrl:'https://dev-api.sendrelays.com'}));
 assert.throws(()=>saveDesktopTeachingContext({directory,run:{...run,id:'new-run'},apiUrl}));
});
