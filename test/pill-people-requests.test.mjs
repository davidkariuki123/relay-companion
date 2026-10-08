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

test("Add offers two cases: an address for someone on Relay, your link for everyone else", async () => {
  // One field finds and adds; there is no separate add sheet any more.
  assert.match(html, /<input id="cvSearch" type="search" placeholder="Search, or add by email"/);
  assert.doesNotMatch(html, /id="cvAddSheet"|id="cvAddInput"|id="cvAddLink"|id="cvAddT2"/);
  assert.doesNotMatch(html, /invite by email|Invite by email/);
  // Case one: an address nobody in the book has offers Add.
  const h = addPersonHarness({ contactAdd: async () => ({ ok: true, found: false }) });
  h.type("new@example.test");
  assert.equal(h.findTitle(), "Not in your contacts");
  assert.equal(h.findNote(), "Added right away if they’re on Relay");
  assert.ok(h.button("cvFindAdd"), "the row's verb is Add");
  assert.equal(h.button("cvFindLink"), null);
  // Case two: Relay has no account for it, so the row turns into your link.
  await h.button("cvFindAdd").click();
  assert.equal(h.findTitle(), "Not on Relay yet");
  assert.match(h.findNote(), /join/);
  assert.equal(h.button("cvFindAdd"), null);
  assert.equal(h.button("cvFindLink").text, "Copy link");
  // Nothing to offer for a name, or an address already in the book.
  h.type("not an address");
  assert.equal(h.cvFindEl.innerHTML, "");
  h.type("Old@Example.test");
  assert.equal(h.cvFindEl.innerHTML, "", "someone already in the book is found, not added again");
});

test("Add is one write with the exact row back; nothing is deleted, and the outcome is told as it is", () => {
  const add = slice("async function addPersonByAddress()", "async function copyInviteLinkFromPeople(");
  assert.match(add, /await window\.relay\.contactAdd\(\{ email:address \}\)/, "one IPC, one upsert");
  assert.doesNotMatch(add, /contactDelete|contactSave|openChatWith/, "no compensating delete, no lookup by side effect");
  assert.match(add, /res\.found === false/);
  assert.match(add, /cvFind = \{ address, state:"missing", note:"" \};/, "a miss is told as a miss, not as an error");
  assert.match(add, /if \(generation !== addSheetGeneration\) return;/, "a cleared field ignores a late answer");
  assert.match(add, /if \(account !== signupAccountKey\(\)\) return;/, "a late result never paints another account's People");
});

// The real functions, run against controlled outcomes. What the person sees
// must follow from what the server said, not from a list refresh.
function addPersonHarness({ contactAdd, accountSwitch = false, copyResult = "Copied" }) {
  const calls = { renderContacts: 0, renderAll: 0, contactAdd: 0, copy: 0 };
  let account = "user_a";
  let api = null;
  const cvSearchEl = { value: "" };
  // The find row is rendered as a string; its buttons are looked up by id.
  const cvFindEl = { innerHTML: "" };
  const buttons = new Map();
  const document = {
    getElementById(id) {
      if (!cvFindEl.innerHTML.includes(`id="${id}"`)) return null;
      if (!buttons.has(cvFindEl.innerHTML + id)) {
        const label = cvFindEl.innerHTML.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1] ?? "";
        const button = { id, textContent: label, disabled: /id="[^"]+" disabled/.test(cvFindEl.innerHTML), listeners: [],
          addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); } };
        buttons.set(cvFindEl.innerHTML + id, button);
      }
      return buttons.get(cvFindEl.innerHTML + id);
    },
  };
  const src = slice("  function cvTypedAddress()", "  // The link lands on the clipboard from main");
  const run = new Function("cvSearchEl", "cvFindEl", "document", "window", "calls", "signupAccountKey", "isValidEmail", "contactKey", "contactEmails", "esc", "copyInviteLinkFromPeople", "seed",
    `"use strict"; let contactsList = seed; let cvFind = null; let addSheetGeneration = 0;
     function renderContacts() { calls.renderContacts += 1; renderContactFind(); }
     const renderAll = () => { calls.renderAll += 1; };
     ${src}
     return { addPersonByAddress, renderContactFind, closeAddSheet, list: () => contactsList, find: () => cvFind };`);
  api = run(cvSearchEl, cvFindEl, document,
    { relay: { contactAdd: async (input) => { calls.contactAdd += 1; const out = await contactAdd(input); if (accountSwitch) account = "user_b"; return out; } } },
    calls, () => account, (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s)), (c) => c.id || (c.emails || [])[0] || c.name,
    (c) => c.emails || [], (s) => String(s),
    async (button) => { calls.copy += 1; button.textContent = copyResult; },
    [{ id: "con_old", name: "Old Friend", emails: ["old@example.test"], onRelay: true }]);
  const text = (cls) => cvFindEl.innerHTML.match(new RegExp(`class="${cls}">([^<]*)<`))?.[1] ?? null;
  return {
    api, calls, cvFindEl, cvSearchEl,
    // What the field's input handler does: the lists re-render, and with them the find row.
    type(value) { cvSearchEl.value = value; api.renderContactFind(); },
    findTitle: () => text("cv-name"),
    findNote: () => text("cv-sub"),
    button(id) {
      const button = document.getElementById(id);
      if (!button) return null;
      return { text: button.textContent, disabled: button.disabled, click: () => Promise.all(button.listeners.map((fn) => fn({ currentTarget: button }))) };
    },
  };
}

test("adding someone on Relay closes the sheet with their row in the list", async () => {
  const h = addPersonHarness({ contactAdd: async ({ email }) => ({ ok: true, contact: { id: "con_new", name: "Dana Kim", emails: [email], onRelay: true }, contacts: null }) });
  h.type("Dana@Example.test");
  const pending = h.api.addPersonByAddress();
  assert.equal(h.findNote(), "Looking for their Relay account…");
  assert.equal(h.button("cvFindAdd").disabled, true, "one write in flight");
  await h.api.addPersonByAddress(); // a second press while busy is ignored
  await pending;
  assert.equal(h.calls.contactAdd, 1);
  assert.deepEqual(h.api.list().map((c) => c.id), ["con_old", "con_new"], "the exact row joins the list even when the refresh brought nothing");
  assert.equal(h.cvFindEl.innerHTML, "", "the find row closes: they are in the book now");
  assert.equal(h.api.find(), null);
  assert.ok(h.calls.renderContacts >= 1 && h.calls.renderAll === 1);
  // A full list back replaces the book.
  const full = addPersonHarness({ contactAdd: async ({ email }) => ({ ok: true, contact: { id: "con_new", emails: [email] }, contacts: [{ id: "con_new", emails: [email] }] }) });
  full.type("dana@example.test");
  await full.api.addPersonByAddress();
  assert.deepEqual(full.api.list().map((c) => c.id), ["con_new"]);
});

test("an address not on Relay leaves People unchanged and points at your link", async () => {
  const h = addPersonHarness({ contactAdd: async () => ({ ok: true, found: false }) });
  h.type("new@example.test");
  await h.api.addPersonByAddress();
  assert.equal(h.findTitle(), "Not on Relay yet", "the row stays so the person sees the outcome");
  assert.ok(h.button("cvFindLink"), "and offers your link");
  assert.equal(h.api.find().state, "missing");
  assert.equal(h.api.list().length, 1, "a miss never creates a row");
  assert.equal(h.calls.renderContacts + h.calls.renderAll, 0);
});

test("a failure is shown as a failure and changes nothing; a bad address never leaves the pill", async () => {
  const h = addPersonHarness({ contactAdd: async () => ({ ok: false, error: "Relay is unreachable right now. Try again in a moment." }) });
  h.type("new@example.test");
  await h.api.addPersonByAddress();
  assert.equal(h.findTitle(), "Couldn’t add them");
  assert.equal(h.findNote(), "Relay is unreachable right now. Try again in a moment.");
  assert.ok(h.button("cvFindAdd") && !h.button("cvFindAdd").disabled, "Add stays to try again");
  assert.equal(h.api.list().length, 1);
  assert.equal(h.calls.renderContacts, 0);
  const thrown = addPersonHarness({ contactAdd: async () => { throw new Error("fetch failed"); } });
  thrown.type("new@example.test");
  await thrown.api.addPersonByAddress();
  assert.equal(thrown.findTitle(), "Couldn’t add them");
  assert.equal(thrown.findNote(), "fetch failed");
  assert.equal(thrown.api.list().length, 1);
  let called = 0;
  const bad = addPersonHarness({ contactAdd: async () => { called += 1; return { ok: true }; } });
  bad.type("not an address");
  await bad.api.addPersonByAddress();
  assert.equal(called, 0);
  assert.equal(bad.cvFindEl.innerHTML, "", "a name is a search, not an add");
});

test("a result that lands after the account changed paints nothing", async () => {
  const h = addPersonHarness({ accountSwitch: true, contactAdd: async ({ email }) => ({ ok: true, contact: { id: "con_new", name: "Dana", emails: [email], onRelay: true }, contacts: null }) });
  h.type("dana@example.test");
  await h.api.addPersonByAddress();
  assert.equal(h.calls.renderContacts + h.calls.renderAll, 0);
  assert.equal(h.api.list().length, 1);
  assert.notEqual(h.findTitle(), "Not on Relay yet");
  // Same for a field that was cleared or closed while the write was out.
  let resolve;
  const late = addPersonHarness({ contactAdd: () => new Promise((r) => { resolve = r; }) });
  late.type("dana@example.test");
  const pending = late.api.addPersonByAddress();
  late.api.closeAddSheet();
  resolve({ ok: true, found: false });
  await pending;
  assert.equal(late.cvFindEl.innerHTML, "");
  assert.equal(late.calls.renderContacts + late.calls.renderAll, 0);
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

test("your link is offered in place for whoever is not on Relay yet", async () => {
  // The standing invite sentence under the list is gone; the link appears
  // exactly where someone typed an address Relay does not know.
  assert.doesNotMatch(html, /id="cvLatent"|id="cvLatentLink"|cvLatentLinkEl|cvAddLinkEl/);
  const copy = slice("async function copyInviteLinkFromPeople(", 'cvSearchEl.addEventListener("input"');
  assert.match(copy, /window\.relay\.copyOnboardingInviteLink\(\)/, "main mints the link and puts it on the clipboard");
  assert.match(copy, /button\.textContent = "Copied";/);
  const h = addPersonHarness({ contactAdd: async () => ({ ok: true, found: false }) });
  h.type("new@example.test");
  await h.api.addPersonByAddress();
  await h.button("cvFindLink").click();
  assert.equal(h.calls.copy, 1);
  assert.equal(h.findTitle(), "Link copied");
  assert.equal(h.button("cvFindLink").text, "Copy again");
  // A copy that failed does not claim it was copied.
  const failed = addPersonHarness({ contactAdd: async () => ({ ok: true, found: false }), copyResult: "Could not copy" });
  failed.type("new@example.test");
  await failed.api.addPersonByAddress();
  await failed.button("cvFindLink").click();
  assert.equal(failed.findTitle(), "Not on Relay yet");
});

test("a request is a direct Relay room from an address you do not know and never wrote to", () => {
  const model = slice("const IGNORED_REQUESTS_PREF", "function renderRequestsPane()");
  assert.match(model, /if \(!room \|\| room\.isGroup \|\| room\.provider === "slack" \|\| room\.integration\) return false;/);
  assert.match(model, /if \(!address \|\| known\.has\(address\)\) return false;/);
  assert.match(model, /\.some\(\(message\) => message\.direction === "out"\)\) return false;/, "writing to someone makes them a conversation");
  // Known = your Contacts, you, and everyone you have sent to.
  assert.match(model, /for \(const c of \[\.\.\.\(payload\.contacts \|\| \[\]\), \.\.\.contactsList\]\)/);
  assert.match(model, /for \(const item of payload\.sent \|\| \[\]\)/);
  assert.match(model, /const mine = String\(payload\.account\?\.email \|\| ""\)\.trim\(\)\.toLowerCase\(\);/);
  // Ignore is this device's memory for this account, not a server state.
  assert.match(model, /"proto\.ignoredRequests\.v1"/);
  assert.match(model, /return account \? `\$\{IGNORED_REQUESTS_PREF\}:\$\{account\}` : "";/);
});

test("a reply through your own link is a conversation, never a request", () => {
  const src = slice("  function roomAddress(room)", "  function requestAddresses()");
  const isRequestRoom = new Function(`"use strict"; ${src}; return isRequestRoom;`)();
  const known = new Set(["sam@example.test"]);
  const jo = { partyKey: "email:slm_1@guests.sendrelays.com", msgs: [{ direction: "in", source: { host: "share_link" } }] };
  assert.equal(isRequestRoom(jo, known), false, "Jo answered the link you sent her");
  const stranger = { partyKey: "email:stranger@example.test", msgs: [{ direction: "in", source: { host: "relay-mcp" } }] };
  assert.equal(isRequestRoom(stranger, known), true, "a stranger writing first is still a request");
});

test("a link reply's room opens with the note you sent, and replies go to that person", () => {
  const block = slice("const linkNotes = new Map(", "for (const message of msgs) {");
  const run = new Function("msgs", `"use strict"; ${block} return msgs;`);
  const note = { id: "relay_link", direction: "out", partyKey: "share:shl_1", threadId: "relay_link", title: "hey jo", addressRecipient: { email: "shl_1@guests.sendrelays.com" } };
  const reply = (who, at) => ({ id: `relay_${who}`, direction: "in", partyKey: `email:slm_${who}@guests.sendrelays.com`, threadId: `copy_${who}`, party: who,
    addressRecipient: { email: `slm_${who}@guests.sendrelays.com` }, source: { host: "share_link", shareLinkId: "shl_1" }, at });
  const msgs = run([note, reply("jo", 1), reply("jo", 2), reply("priya", 3)]);
  const notes = msgs.filter((m) => m.linkNote);
  assert.deepEqual(notes.map((m) => m.partyKey), ["email:slm_jo@guests.sendrelays.com", "email:slm_priya@guests.sendrelays.com"], "one note per person who replied");
  assert.deepEqual(notes[1].addressRecipient, { email: "slm_priya@guests.sendrelays.com" }, "your answer goes to Priya, not back to the link");
  assert.equal(notes[1].threadId, "copy_priya");
  const forged = run([note, { ...reply("x", 4), source: { host: "relay-device-direct", shareLinkId: "shl_1" } }]);
  assert.equal(forged.some((m) => m.linkNote), false, "only a real share-link reply pulls in your note");
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

test("delivery-created contacts remain requests until accepted or sent to", () => {
  const src = slice("  function knownAddresses()", "  function requestAddresses()");
  const stranger = { email: "stranger@example.test", emails: ["stranger@example.test"], source: "inbound" };
  const payload = { contacts: [stranger], sent: [], account: { email: "me@example.test" } };
  const api = new Function("payload", "contactsList", "contactEmails", `${src}; return { knownAddresses, isRequestRoom };`)(
    payload, [stranger], (c) => c.emails || [c.email]);
  const room = { partyKey: "email:stranger@example.test", msgs: [{ direction: "in" }] };
  assert.equal(api.isRequestRoom(room), true, "both contact caches may contain an inbound-only sender");
  assert.equal(api.isRequestRoom({ ...room, msgs: [...room.msgs, { direction: "out" }] }), false, "a text or Relay reply accepts the room");
  payload.sent.push({ recipient: { email: "STRANGER@example.test" } });
  assert.equal(api.isRequestRoom(room), false, "previous outbound correspondence counts even outside this room");
  payload.sent = [];
  for (const source of ["manual", "inferred", "invite", "google", "companion"]) {
    stranger.source = source;
    assert.equal(api.isRequestRoom(room), false, `${source} is an owner-established contact`);
  }
  stranger.source = "inbound";
  assert.equal(api.isRequestRoom({ ...room, isGroup: true }), false);
  assert.equal(api.isRequestRoom({ ...room, provider: "slack" }), false);
  assert.equal(api.isRequestRoom({ partyKey: "email:me@example.test" }), false);
});

test("source-only acceptance invalidates the contact cache fingerprint", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const src = main.slice(main.indexOf("function contactsFingerprintOf(list)"), main.indexOf("async function refreshContacts()"));
  const fingerprint = new Function(`${src}; return contactsFingerprintOf;`)();
  const row = { id: "con_a", email: "a@example.test", source: "inbound" };
  assert.notEqual(fingerprint([row]), fingerprint([{ ...row, source: "manual" }]));
  assert.match(main, /contacts: payload.contacts.map\(\(c\) => \[c.id, c.name, c.email, c.relayUserId, c.onRelay, c.source\]\)/);
});

test("requests use one Relays entry, with no Contacts badge or third Contacts pane", () => {
  const rows = slice("function relayIdentityRows()", "function renderRelays()");
  assert.match(rows, /!isRequestRoom/);
  assert.match(html, /requestSummaryHtml\(requestCount\)/);
  assert.match(html, /setBadge\(peopleBadgeEl, 0\)/);
  assert.doesNotMatch(html, /id="cvSegRequests"/);
  assert.doesNotMatch(html, /id="cvSeg|data-pane="(people|groups)"/, "Contacts has no panes at all now");
  assert.match(html, /aria-label="Search contacts and groups, or add someone by email"/);
  assert.match(html, /data-view="contacts">Contacts /);
});
