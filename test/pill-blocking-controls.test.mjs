import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../overlay/main.cjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('async function blockSavedPerson(input)'), main.indexOf('ipcMain.handle("relay:blockPerson"'));

function harness({contact = {id:'con_test',relayUserId:'usr_target'}, switchAccount = false, fail = false} = {}) {
  let key = 'usr_self';
  const writes = [];
  const client = {
    listContacts: async () => { if (switchAccount) key = 'usr_other'; if (fail) throw new Error('offline'); return {contacts:contact ? [contact] : []}; },
    setConnectionBlocked: async (...args) => { writes.push(args); return {blocked:true}; },
  };
  const block = new Function('onboardingAccountKey','relayClient','account', `${source}; return blockSavedPerson;`)(() => key, async () => client, () => ({userId:'usr_self'}));
  return {block,writes};
}

test('blocking a saved person verifies the exact live contact identity before writing', async () => {
  const h = harness();
  assert.deepEqual(await h.block({contactId:'con_test',relayUserId:'usr_target'}), {blocked:true});
  assert.deepEqual(h.writes, [['usr_target',true]]);
});

test('stale, missing, self, unlinked and cross-account identities never block anyone', async () => {
  for (const options of [{contact:null},{contact:{id:'con_test'}},{contact:{id:'con_test',relayUserId:'usr_changed'}},{contact:{id:'con_test',relayUserId:'usr_self'}},{switchAccount:true},{fail:true}]) {
    const h = harness(options);
    await assert.rejects(h.block({contactId:'con_test',relayUserId:'usr_target'}));
    assert.deepEqual(h.writes,[]);
  }
  const h = harness();
  await assert.rejects(h.block({contactId:'con_test'}));
  assert.deepEqual(h.writes,[]);
});

test('person controls are sibling buttons, with a modal and a visible recovery path', () => {
  const rows = html.slice(html.indexOf('function renderContacts()'), html.indexOf('const peopleDialog ='));
  assert.match(rows, /<div class="cv-person">/);
  assert.match(rows, /<button class="cv-person-more"[^>]*aria-haspopup="dialog"[^>]*data-contact-block=/);
  assert.doesNotMatch(rows, /<span class="cv-edit" role="button"/);
  assert.match(html, /id="cvBlockedPeople">Blocked people/);
  assert.match(html, /peopleDialog\.showModal\(\)/);
  assert.match(html, /peopleDialogAccount !== signupAccountKey\(\)\) closePeopleDialog/);
  const block = html.slice(html.indexOf('function openPersonBlock('), html.indexOf('async function openBlockedPeople('));
  assert.match(block, /\[data-block-confirm\].*addEventListener/);
  assert.match(block, /if \(!current\(\)\)/);
  assert.match(block, /result\?\.blocked !== true/);
  assert.doesNotMatch(block, /contactDelete|contactsList\s*=/);
  const unblock = html.slice(html.indexOf('async function openBlockedPeople('), html.indexOf('document.getElementById("cvBlockedPeople").addEventListener'));
  assert.match(unblock, /result\?\.blocked !== false/);
  assert.match(unblock, /No blocked people/);
  assert.match(unblock, /Could not unblock this person/);
});

test('one Add button moves between form and toolbar and honors reduced motion', () => {
  assert.equal((html.match(/id="cvAdd"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="cvAddGo"/);
  const motion = html.slice(html.indexOf('function moveAddButton('), html.indexOf('function openAddSheet()'));
  assert.match(motion, /getBoundingClientRect/);
  assert.match(motion, /open \? "cvAddTarget" : "cvAddHome"\)\.append\(cvAddEl\)/);
  assert.match(motion, /prefers-reduced-motion: reduce/);
  assert.match(motion, /addButtonAnimation\?\.cancel/);
  assert.match(html, /cvAddEl.addEventListener\("click", \(\) => cvAddSheetEl.classList.contains\("hidden"\) \? openAddSheet\(\) : addPersonByAddress\(\)\)/);
});
