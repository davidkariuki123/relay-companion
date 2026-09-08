import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const slice = (start, end) => {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `found: ${start}`);
  const j = html.indexOf(end, i);
  assert.ok(j > i, `found after: ${end}`);
  return html.slice(i, j);
};

// PEOPLE (Sven, 2026-09-08, the Minimal design). Two ways in, told apart:
// "adding someone with email is only for people on relay, vs people off relay
// will come in with a link." A stranger's first message is a request: it waits
// in People, out of the feed and the count, until you accept it, reply, or
// ignore it. A contact is an address and what you call them.

test("Add offers two cases: an address for someone on Relay, your link for everyone else", () => {
  const sheet = slice('<div class="cv-add-sheet hidden" id="cvAddSheet">', '<form class="cv-form hidden" id="cvForm">');
  assert.match(sheet, /<div class="cv-add-t">On Relay already<\/div>/);
  assert.match(sheet, /id="cvAddInput" type="email"[^>]*placeholder="name@company\.com"/);
  assert.match(sheet, /id="cvAddNote">They show up in your People right away\.<\/div>/);
  assert.match(sheet, /id="cvAddT2">Not on Relay yet<\/div>/);
  assert.match(sheet, /id="cvAddLink">Copy your invite link<\/button>/);
  assert.match(sheet, /They paste it into Claude Code or Codex and show up here\./);
  assert.doesNotMatch(sheet, /invite by email|Invite by email/);
});

test("Add is one write with the exact row back; nothing is deleted, and the outcome is told as it is", () => {
  const add = slice("async function addPersonByAddress()", "async function copyInviteLinkFromPeople(");
  assert.match(add, /await window\.relay\.contactAdd\(\{ email:address \}\)/, "one IPC, one upsert");
  assert.doesNotMatch(add, /contactDelete|contactSave|openChatWith/, "no compensating delete, no lookup by side effect");
  assert.match(add, /res\.found === false/);
  assert.match(add, /\$\{address\} isn't on Relay yet\. Send them your link\./);
  assert.match(add, /if \(account !== signupAccountKey\(\)\) return;/, "a late result never paints another account's People");
});

// The real functions, run against controlled outcomes. What the person sees
// must follow from what the server said, not from a list refresh.
function addPersonHarness({ contactAdd, accountSwitch = false }) {
  const el = () => ({ value: "", disabled: false, textContent: "", classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, has(c) { return this.set.has(c); } } });
  const cvAddInputEl = el(); const cvAddGoEl = el(); const cvAddNoteEl = el(); const cvAddT2El = el();
  const calls = { closeAddSheet: 0, renderContacts: 0, renderAll: 0 };
  let account = "user_a";
  const src = slice("  function addSheetWarn(text)", "  // The link lands on the clipboard from main");
  const run = new Function("cvAddInputEl", "cvAddGoEl", "cvAddNoteEl", "cvAddT2El", "window", "calls", "signupAccountKey", "isValidEmail", "contactKey", "seed",
    `"use strict"; let contactsList = seed; let addSheetGeneration = 0;
     const closeAddSheet = () => { calls.closeAddSheet += 1; };
     const renderContacts = () => { calls.renderContacts += 1; };
     const renderAll = () => { calls.renderAll += 1; };
     ${src}
     return { addPersonByAddress, list: () => contactsList };`);
  const api = run(cvAddInputEl, cvAddGoEl, cvAddNoteEl, cvAddT2El,
    { relay: { contactAdd: async (input) => { const out = await contactAdd(input); if (accountSwitch) account = "user_b"; return out; } } },
    calls, () => account, (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s)), (c) => c.id || (c.emails || [])[0] || c.name,
    [{ id: "con_old", name: "Old Friend", emails: ["old@example.test"], onRelay: true }]);
  return { api, cvAddInputEl, cvAddGoEl, cvAddNoteEl, cvAddT2El, calls };
}

test("adding someone on Relay closes the sheet with their row in the list", async () => {
  const h = addPersonHarness({ contactAdd: async ({ email }) => ({ ok: true, contact: { id: "con_new", name: "Dana Kim", emails: [email], onRelay: true }, contacts: null }) });
  h.cvAddInputEl.value = "Dana@Example.test";
  await h.api.addPersonByAddress();
  assert.equal(h.calls.closeAddSheet, 1);
  assert.deepEqual(h.api.list().map((c) => c.id), ["con_old", "con_new"], "the exact row joins the list even when the refresh brought nothing");
  assert.equal(h.cvAddGoEl.disabled, false);
});

test("an address not on Relay leaves People unchanged and points at your link", async () => {
  const h = addPersonHarness({ contactAdd: async () => ({ ok: true, found: false }) });
  h.cvAddInputEl.value = "new@example.test";
  await h.api.addPersonByAddress();
  assert.equal(h.calls.closeAddSheet, 0, "the sheet stays so the person sees the outcome");
  assert.equal(h.cvAddNoteEl.textContent, "new@example.test isn't on Relay yet. Send them your link.");
  assert.ok(h.cvAddT2El.classList.has("lit"));
  assert.equal(h.api.list().length, 1, "a miss never creates a row");
});

test("a failure is shown as a failure and changes nothing; a bad address never leaves the pill", async () => {
  const h = addPersonHarness({ contactAdd: async () => ({ ok: false, error: "Relay is unreachable right now. Try again in a moment." }) });
  h.cvAddInputEl.value = "new@example.test";
  await h.api.addPersonByAddress();
  assert.equal(h.cvAddNoteEl.textContent, "Relay is unreachable right now. Try again in a moment.");
  assert.equal(h.api.list().length, 1);
  assert.equal(h.calls.renderContacts, 0);
  let called = 0;
  const bad = addPersonHarness({ contactAdd: async () => { called += 1; return { ok: true }; } });
  bad.cvAddInputEl.value = "not an address";
  await bad.api.addPersonByAddress();
  assert.equal(called, 0);
  assert.equal(bad.cvAddNoteEl.textContent, "That doesn't look like an address.");
});

test("a result that lands after the account changed paints nothing", async () => {
  const h = addPersonHarness({ accountSwitch: true, contactAdd: async ({ email }) => ({ ok: true, contact: { id: "con_new", name: "Dana", emails: [email], onRelay: true }, contacts: null }) });
  h.cvAddInputEl.value = "dana@example.test";
  await h.api.addPersonByAddress();
  assert.equal(h.calls.renderContacts + h.calls.renderAll + h.calls.closeAddSheet, 0);
  assert.equal(h.api.list().length, 1);
});

test("main adds only verified Relay accounts and caches the exact committed row", async () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const between = (a, b) => { const i = main.indexOf(a); const j = main.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return main.slice(i, j); };
  const src = [
    between("function contactsFingerprintOf(list)", "async function refreshContacts()"),
    between("function contactBookRow(c)", "function ensureContactsLoaded()"),
    between("function cacheContact(saved)", "async function deleteContactFromBook(input)"),
    between("async function addContactByAddress(input)", "// ---- the send outbox"),
  ].join("\n");
  const make = (upsert, refreshed) => new Function("relayClient", "contactErrorText", "contactsAfterWrite", "seed",
    `"use strict"; const onboardingAccountKey = () => "user:a"; let contactsCache = seed; let contactsFingerprint = ""; ${src}; return { add: addContactByAddress, cache: () => contactsCache };`)(
    async () => ({ addRelayContact: upsert }), (e, f) => (e && e.message) || f, async () => refreshed, [{ id: "con_a", name: "Amy", email: "amy@x.test", emails: ["amy@x.test"], onRelay: true }]);
  assert.match(src, /client\.addRelayContact\(email\)/);
  let sent = null;
  const ok = make(async (input) => { sent = input; return { found: true, contact: { id: "con_b", name: "Bob", emails: ["bob@x.test"], onRelay: true } }; }, null);
  const res = await ok.add({ email: " Bob@X.test " });
  assert.equal(sent, "bob@x.test");
  assert.equal(res.ok, true);
  assert.deepEqual(res.contact, { id: "con_b", name: "Bob", email: "bob@x.test", emails: ["bob@x.test"], onRelay: true, source: "", updatedAt: null });
  const miss = make(async () => ({ found: false }), null);
  assert.deepEqual(await miss.add({ email: "missing@x.test" }), { ok: true, found: false });
  assert.equal(miss.cache().length, 1);
  assert.deepEqual(ok.cache().map((c) => c.id), ["con_a", "con_b"], "the row is in the cache even though the refresh failed");
  assert.equal(res.contacts, null, "a failed refresh is reported as no list, not as a failed write");
  const down = make(async () => { throw new Error("fetch failed"); }, null);
  const failed = await down.add({ email: "bob@x.test" });
  assert.equal(failed.ok, false);
  assert.equal(down.cache().length, 1, "nothing changes on a failure");
  const bad = await down.add({ email: "nope" });
  assert.equal(bad.error, "That email looks off.");
  assert.match(main, /ipcMain\.handle\("relay:contactAdd", \(_e, input\) => addContactByAddress\(input\)\);/);
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /contactAdd: \(input\) => ipcRenderer\.invoke\("relay:contactAdd", input\),/);
});

test("a contact is an address and what you call them; no first name, no surname", () => {
  assert.match(html, /id="cvName" placeholder="What you call them"/);
  assert.doesNotMatch(html, /id="cvFirst"|id="cvLast"|cvSplitName|placeholder="First name"|placeholder="Surname"/);
  const submit = slice("cvFormEl.addEventListener(\"submit\"", "cvSaveEl.disabled = true;");
  assert.match(submit, /const name = String\(cvNameEl\.value \|\| ""\)\.trim\(\);/);
  assert.match(submit, /A name is required\./);
  assert.doesNotMatch(html, /A first name is required/);
});

test("your link sits under the list for whoever is not on Relay yet", () => {
  assert.match(html, /<div class="cv-latent" id="cvLatent">Not on Relay yet\? <button type="button" class="cv-latent-link" id="cvLatentLink">Copy your link<\/button> and send it to them\.<\/div>/);
  const copy = slice("async function copyInviteLinkFromPeople(", "cvAddEl.addEventListener(");
  assert.match(copy, /window\.relay\.copyOnboardingInviteLink\(\)/, "main mints the link and puts it on the clipboard");
  assert.match(copy, /button\.textContent = "Copied";/);
  assert.match(html, /cvLatentLinkEl\.addEventListener\("click", \(\) => copyInviteLinkFromPeople\(cvLatentLinkEl\)\);/);
  assert.match(html, /cvAddLinkEl\.addEventListener\("click", \(\) => copyInviteLinkFromPeople\(cvAddLinkEl\)\);/);
});

test("a request is a direct Relay room from an address you do not know and never wrote to", () => {
  const model = slice("const IGNORED_REQUESTS_PREF", "function renderRequestsPane()");
  assert.match(model, /if \(!room \|\| room\.isGroup \|\| room\.provider === "slack" \|\| room\.integration\) return false;/);
  assert.match(model, /if \(!address \|\| known\.has\(address\)\) return false;/);
  assert.match(model, /\.some\(\(message\) => message\.direction === "out"\)\) return false;/, "writing to someone makes them a conversation");
  // Known = your People, you, and everyone you have sent to.
  assert.match(model, /for \(const c of \[\.\.\.\(payload\.contacts \|\| \[\]\), \.\.\.contactsList\]\)/);
  assert.match(model, /for \(const item of payload\.sent \|\| \[\]\)/);
  assert.match(model, /const mine = String\(payload\.account\?\.email \|\| ""\)\.trim\(\)\.toLowerCase\(\);/);
  // Ignore is this device's memory for this account, not a server state.
  assert.match(model, /"proto\.ignoredRequests\.v1"/);
  assert.match(model, /return account \? `\$\{IGNORED_REQUESTS_PREF\}:\$\{account\}` : "";/);
});

test("Ignore belongs to the account that clicked it, and nothing is read or written without one", () => {
  const src = slice("  const IGNORED_REQUESTS_PREF", "  function knownAddresses()");
  const store = new Map();
  let account = "user_a";
  const api = new Function("protoPref", "setProtoPref", "signupAccountKey", `"use strict"; ${src}; return { ignoredRequestKeys, ignoreRequest };`)(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback), (key, value) => store.set(key, value), () => account);
  api.ignoreRequest("Stranger@Example.test");
  assert.deepEqual([...api.ignoredRequestKeys()], ["stranger@example.test"]);
  account = "user_b";
  assert.deepEqual([...api.ignoredRequestKeys()], [], "B does not inherit A's Ignore");
  account = "user_a";
  assert.deepEqual([...api.ignoredRequestKeys()], ["stranger@example.test"], "A's choice is still A's");
  account = null;
  api.ignoreRequest("other@example.test");
  assert.deepEqual([...api.ignoredRequestKeys()], [], "no account, no memory");
  assert.deepEqual([...store.keys()], ["proto.ignoredRequests.v1:user_a"], "nothing was written under an unknown owner");
});

test("requests stay out of the Relays list and the unread count; People wears their number", () => {
  const rows = slice("function relayIdentityRows()", "function renderRelays()");
  assert.match(rows, /\.filter\(\(room\) => room\.hasActivity !== false && !isRequestRoom\(room, known\)\)/);
  const all = slice("function renderAll()", 'if (activeView === "chat") renderChat();');
  assert.match(all, /const quiet = requestAddresses\(\);/);
  assert.match(all, /&& !quiet\.has\(String\(r\.senderEmail \|\| ""\)\.trim\(\)\.toLowerCase\(\)\)\)/);
  assert.match(all, /setBadge\(peopleBadgeEl, requestRooms\(\)\.length\);/);
  assert.match(html, /data-view="contacts">People <span class="tab-badge gone" id="peopleBadge">0<\/span><\/button>/);
});

test("a request supports Accept, reversible Ignore, and confirmed server blocking", () => {
  const pane = slice("function renderRequestsPane()", "function renderContacts()");
  // The way back from Ignore is a quiet line in the People pane's shape, not
  // a bare button, and only while something is hidden (Sven, 2026-09-08).
  assert.match(pane, /ignored\.size \? `<div class="cv-latent">Ignored requests are hidden\. <button type="button" class="cv-latent-link" id="cvShowIgnored">Show them<\/button>\.<\/div>`/);
  assert.match(pane, /<div class="cv-latent">Showing ignored requests\. <button type="button" class="cv-latent-link" id="cvShowIgnored">Back to requests<\/button>\.<\/div>/);
  assert.doesNotMatch(pane, /cv-add quiet" type="button" id="cvShowIgnored"/);
  assert.match(pane, /"No requests\. Someone new writing to you shows up here first\."/);
  assert.match(pane, /"No ignored requests\."/);
  assert.match(pane, /<span class="cv-request-why">Not in your People<\/span>/);
  assert.match(pane, /data-request-accept="\$\{esc\(address\)\}"[^>]*>Accept<\/button>/);
  assert.match(pane, /data-request-ignore="\$\{esc\(address\)\}">Ignore<\/button>/);
  // Ignore and Block are plain words; the one hint sits under the rows.
  assert.doesNotMatch(pane, /Ignore hides a request on this computer/);
  assert.match(pane, /`<div class="cv-request-note">Open one to read it\. Replying accepts it too\.<\/div>`/);
  // Accepting is saving them: the same write the People form does.
  assert.match(pane, /window\.relay\.contactSave\(\{ contactId:"", name, emails:\[address\], email:address \}\)/);
  assert.match(pane, /openThreadDetail\(el\.getAttribute\("data-request-open"\), el\.getAttribute\("data-party"\) \|\| "", "contacts", \{ expanded:true \}\);/);
  assert.match(pane, /await window\.relay\.blockRequest/);
  assert.match(pane, /Block this person\?/);
  assert.match(pane, /data-request-restore/);
});

test("People has three panes and the Add sheet belongs to the first", () => {
  const panes = slice("function applyContactsPane()", "const cvgListEl = document.getElementById(\"cvgList\");");
  assert.match(panes, /const requests = contactsPane === "requests";/);
  assert.match(panes, /cvRequestsEl\.classList\.toggle\("gone", !requests\);/);
  assert.match(panes, /cvLatentEl\.classList\.toggle\("gone", !people\);/);
  assert.match(panes, /if \(!people\) \{ cvFormEl\.classList\.add\("hidden"\); closeAddSheet\(\); \}/);
  assert.match(panes, /if \(requests\) renderRequestsPane\(\);/);
  assert.match(panes, /cvSegRequestsNEl\.textContent = requests \? String\(requests\) : "";/);
  assert.match(html, /aria-label="People, channels and requests"/);
});
