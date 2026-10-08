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

test('person controls are sibling buttons, with an anchored popover and a visible recovery path', () => {
  const rows = html.slice(html.indexOf('function renderContacts()'), html.indexOf('const peopleDialog ='));
  assert.match(rows, /<div class="cv-person">/);
  assert.match(rows, /<button class="cv-person-more"[^>]*aria-haspopup="menu"[^>]*data-message-more/);
  assert.doesNotMatch(rows, /<span class="cv-edit" role="button"/);
  // The recovery path is Blocked people on You, plus the Blocked people
  // button the Block dialog offers once someone is blocked.
  assert.doesNotMatch(html, /id="cvBlockedPeople"/);
  assert.match(html, /<button class="sv-row" id="svBlockedPeople" type="button"><span class="sv-row-copy"><span class="sv-row-name">Blocked people<\/span>/);
  assert.match(html, /document\.getElementById\("svBlockedPeople"\)\?\.addEventListener\("click", \(event\) => openBlockedPeople\(event\.currentTarget\)\)/);
  assert.match(html, /peopleDialog\.showPopover\(\)/);
  assert.match(html, /peopleDialogAccount !== signupAccountKey\(\)\) closePeopleDialog/);
  const block = html.slice(html.indexOf('function openPersonBlock('), html.indexOf('async function openBlockedPeople('));
  assert.match(block, /\[data-block-confirm\].*addEventListener/);
  assert.match(block, /if \(!current\(\)\)/);
  assert.match(block, /result\?\.blocked !== true/);
  assert.match(block, /\[data-blocked-list\]"\)\.addEventListener\("click", \(\) => openBlockedPeople\(trigger\)\)/);
  assert.doesNotMatch(block, /contactDelete|contactsList\s*=/);
  // Every pointer names the page by where it lives and what it is called.
  assert.match(block, /You can unblock them in You › Blocked people\./);
  assert.match(block, /data-blocked-list>Blocked people<\/button>/);
  assert.match(html, /<h2 id="cvBlockedTitle">Blocked people<\/h2>/);
  assert.doesNotMatch(html, /Blocked contacts|Contacts → Blocked/);
  const unblock = html.slice(html.indexOf('async function openBlockedPeople('), html.indexOf('cvBlockedBackEl.addEventListener("click"'));
  assert.ok(unblock.length > 0);
  assert.match(unblock, /result\?\.blocked !== false/);
  assert.match(unblock, /No one is blocked/);
  assert.match(unblock, /Could not unblock this contact/);
  // The page's Back names where it returns to.
  assert.match(html, /<button class="cv-blocked-back" id="cvBlockedBack" type="button">← You<\/button>/);
  assert.match(unblock, /const from = previous\?\.from \|\| \(activeView === "settings" \? "settings" : "contacts"\);/);
  assert.match(unblock, /cvBlockedBackEl\.textContent = from === "settings" \? "← You" : "← Contacts";/);
  // The page stays in the view that opened it (expanded-mode review,
  // 2026-10-08): from You it takes You's place under the You tab; from a
  // Block dialog it is a page of Contacts. Opening never changes the view.
  assert.match(html, /function blockedPeopleView\(page = blockedPeoplePage\) \{ return page\?\.from === "settings" \? "settings" : "contacts"; \}/);
  assert.doesNotMatch(unblock, /activeView = "contacts"|commitNavigation\(\)/);
  assert.match(unblock, /const current = \(\) => blockedPeoplePage === page && activeView === blockedPeopleView\(page\) && page\.account === signupAccountKey\(\);/);
  assert.match(unblock, /if \(from === "settings"\) \{\s*delete settingsViewEl\.dataset\.pageHtml;\s*settingsViewEl\.replaceChildren\(cvBlockedPageEl\);\s*\} else \{\s*if \(cvBlockedPageEl\.parentElement !== contactsViewEl\) contactsViewEl\.append\(cvBlockedPageEl\);\s*cvOverviewEl\.classList\.add\("gone"\);\s*\}/);
  // Back puts the page home in Contacts' view and, from You, redraws You and
  // returns focus to the row that opened it.
  const close = html.slice(html.indexOf('function closeBlockedPeople('), html.indexOf('async function openBlockedPeople('));
  assert.doesNotMatch(close, /activeView = /, "closing never navigates");
  assert.match(close, /if \(cvBlockedPageEl\.parentElement !== contactsViewEl\) contactsViewEl\.append\(cvBlockedPageEl\);/);
  assert.match(close, /if \(previous\.from === "settings"\) \{\s*delete settingsViewEl\.dataset\.pageHtml;\s*if \(activeView === "settings"\) \{\s*renderSettings\(\);[\s\S]*?document\.getElementById\("svBlockedPeople"\)\?\.focus\(\{ preventScroll:true \}\);\s*\}\s*return;\s*\}/);
  // You keeps the page in place while it is open, instead of repainting over it.
  const settings = html.slice(html.indexOf('function renderSettings()'), html.indexOf('function wireTaskRuntimeControls('));
  assert.match(settings, /if \(blockedPeoplePage && blockedPeopleView\(\) === "settings"\) \{\s*if \(cvBlockedPageEl\.parentElement !== settingsViewEl\) settingsViewEl\.replaceChildren\(cvBlockedPageEl\);\s*return;\s*\}/);
  assert.ok(settings.indexOf('blockedPeopleView() === "settings"') < settings.indexOf('const info = settingsInfo;'), "the early return comes before You is drawn");
  // Escape, a stale view and a second tap on the page's own tab all close it.
  assert.match(html, /event\.key === "Escape" && blockedPeoplePage && activeView === blockedPeopleView\(\) && !event\.defaultPrevented/);
  assert.match(html, /if \(blockedPeoplePage && \(activeView !== blockedPeopleView\(\) \|\| blockedPeoplePage\.account !== signupAccountKey\(\)\)\) \{\s*closeBlockedPeople\(\{ restoreFocus:false, animate:false \}\);/);
  assert.match(html, /if \(blockedPeoplePage && blockedPeopleView\(\) === view\) closeBlockedPeople\(\);\s*else if \(view === "settings" && setupPageOpen\) closeSetupPage\(\);/);
  assert.equal((html.match(/if \(blockedPeoplePage && blockedPeopleView\(\) === view\) closeBlockedPeople\(\);/g) || []).length, 2, "the small card's tabs and the wide sidebar's tab hop agree");
  assert.doesNotMatch(html, /blockedPeoplePage\.from = "contacts"|blockedPeoplePage\?\.from === "settings" \? "settings" : "contacts"\)/);
});

test('one Add button, in the find row, submits the typed address without moving or animating', () => {
  const find = html.slice(html.indexOf('function renderContactFind()'), html.indexOf('function closeAddSheet()'));
  // Exactly one Add, rendered only for an address nobody in the book has.
  assert.equal((find.match(/id="cvFindAdd"/g) || []).length, 1);
  assert.match(find, /<button class="cv-add solid" type="button" id="cvFindAdd"\$\{cvFind\.state === "busy" \? " disabled" : ""\}>Add<\/button>/);
  assert.match(find, /document\.getElementById\("cvFindAdd"\)\?\.addEventListener\("click", addPersonByAddress\)/);
  assert.match(find, /if \(!address \|\| known\) \{ cvFind = null; cvFindEl\.innerHTML = ""; return; \}/);
  // The old button that flew between the toolbar and the sheet is gone, so
  // there is no motion to honour.
  assert.doesNotMatch(html, /id="cvAdd"|id="cvAddGo"|id="cvAddHome"|id="cvAddTarget"/);
  assert.doesNotMatch(html, /function moveAddButton|addButtonAnimation/);
  const add = html.slice(html.indexOf('let addSheetGeneration = 0;'), html.indexOf('cvCancelEl.addEventListener("click", closeContactForm)'));
  assert.doesNotMatch(add, /\.animate\(/);
  // Enter in the field is the same Add.
  assert.match(add, /if \(cvFind && cvFind\.state === "ready"\) \{ addPersonByAddress\(\); return; \}/);
});
