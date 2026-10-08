// Exercise the actual inbox renderer with synthetic contacts and in-memory IPC.
// No account access, live writes, or system clipboard writes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless:true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath:process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport:{ width:344, height:524 } });
  page.setDefaultTimeout(8000);
  const errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    const copy = (value) => structuredClone(value);
    const account = { paired:true, userId:"self", name:"Test User", email:"self@example.test", hasSentRelay:true };
    let contacts = [{ id:"con_dana", name:"Dana Kim", email:"dana@example.test", emails:["dana@example.test"], onRelay:true }];
    let groups = [];
    window.calls = [];
    window.events = {};
    const ok = (value) => ({ ok:true, result:copy(value) });
    const payload = () => ({ account, ui:{ canDismiss:true, onboardingRequired:false, completedOnboardingVersion:1 }, features:{ requests:false, todo:false, slack:false, googleContacts:false }, contacts, relays:[], sent:[], outbox:[], tasks:[], chats:[], slackChats:[] });
    const api = {
      isTestOverlay:true,
      refresh:async () => copy(payload()), contacts:async () => copy(contacts),
      groups:async () => ok(groups), refreshSent:async () => ({ items:[] }),
      accountInfo:async () => copy(account), agentSurfaces:async () => ({}),
      groupCreate:async (name) => {
        window.calls.push(["groupCreate", name]);
        if (name === "Taken") return { ok:false, error:"A group with that name already exists." };
        const group = { id:`grp_${groups.length + 1}`, name, owned:true, members:[], memberCount:0, owner:{ userId:account.userId, name:account.name, email:account.email } };
        groups.push(group); return ok(group);
      },
      contactsSearch:async (query) => ok({ matches:contacts.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())).map((c) => ({ ...c, contactId:c.id })) }),
      groupAddMember:async (id, contactId) => {
        window.calls.push(["groupAddMember", id, contactId]);
        const group = groups.find((g) => g.id === id), contact = contacts.find((c) => c.id === contactId);
        group.members.push({ ...contact, contactId }); group.memberCount = group.members.length;
        return ok(group);
      },
      groupRemoveMember:async (id, contactId) => {
        const group = groups.find((g) => g.id === id);
        group.members = group.members.filter((c) => c.contactId !== contactId); group.memberCount = group.members.length;
        return ok(group);
      },
      contactAdd:async ({ email }) => {
        window.calls.push(["contactAdd", email]);
        if (email === "offline@example.test") return { ok:false, error:"Relay is unreachable right now." };
        if (email !== "alex@example.test") return { ok:true, found:false };
        const contact = { id:"con_alex", name:"Alex Jones", email, emails:[email], onRelay:true };
        contacts = [...contacts.filter((c) => c.id !== contact.id), contact];
        return { ok:true, contact:copy(contact), contacts:copy(contacts) };
      },
      copyOnboardingInviteLink:async () => { window.calls.push(["copyInvite"]); return { ok:true }; },
    };
    window.relay = new Proxy(api, { get:(target, key) => key in target ? target[key]
      : String(key).startsWith("on") ? (callback) => { window.events[key] = callback; return () => {}; }
      : async () => ({ ok:true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.locator('[data-view="contacts"]').waitFor();
  await page.evaluate(() => window.events.onOpenFull());
  await page.locator('[data-view="contacts"]').click();
  await page.locator("#cvSearch").waitFor();
  const focused = () => page.evaluate(() => document.activeElement.id);
  const peopleNames = () => page.locator("#cvList .cv-person .cv-name").allInnerTexts();
  const find = page.locator("#cvFind");
  const search = async (value) => { await page.locator("#cvSearch").fill(value); };

  // One view: the field, then Groups with its own verb, then People A–Z.
  assert.equal(await page.locator("#cvSearch").getAttribute("placeholder"), "Search, or add by email");
  for (const gone of ["#cvNew", "#cvNewMenu", "#cvSegPeople", "#cvSegGroups", "#cvAddSheet", "#cvAdd", "#cvLatent", "#cvBlockedPeople"]) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} belongs to the old Contacts`);
  }
  const top = async (selector) => (await page.locator(selector).boundingBox()).y;
  assert.ok(await top("#cvSearch") < await top("#cvgHead"));
  assert.ok(await top("#cvgHead") < await top("#cvPeopleHead"));
  assert.ok(await top("#cvPeopleHead") < await top("#cvList"));
  assert.equal(await page.locator("#cvgNew").innerText(), "New group");
  assert.deepEqual(await peopleNames(), ["Dana Kim"]);
  assert.equal(await find.innerHTML(), "", "nothing typed, nothing to add");

  // New group opens the existing form; a second press keeps the draft.
  await page.locator("#cvgNew").click();
  assert.equal(await focused(), "cvgNewName");
  await page.locator("#cvgNewName").fill("Draft");
  await page.locator("#cvgNew").click();
  assert.equal(await page.locator("#cvgNewName").inputValue(), "Draft", "New group keeps an open draft visible");
  await page.locator("#cvgNewCancel").click();
  assert.equal(await focused(), "cvgNew");
  assert.equal(await page.locator("#cvgNewForm").isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.calls), [], "opening and cancelling creates nothing");

  await page.locator("#cvgNew").click();
  await page.locator("#cvgNewName").fill("Taken");
  await page.locator("#cvgNewName").press("Enter");
  await page.locator("#cvgError").getByText("A group with that name already exists.").waitFor();
  assert.equal(await page.locator("#cvgNewName").inputValue(), "Taken");
  await page.locator("#cvgNewName").fill("Project team");
  await page.locator("#cvgNewName").press("Enter");
  await page.locator(".gd-title h2").getByText("Project team").waitFor();
  assert.equal(await page.locator("#cvSearch").isVisible(), false, "details retain their existing focused layout");
  await page.locator("[data-gd-add]").fill("Dana");
  await page.locator("[data-gd-add-pick]").click();
  await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.calls)).slice(0, 3), [["groupCreate", "Taken"], ["groupCreate", "Project team"], ["groupAddMember", "grp_1", "con_dana"]]);
  await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).locator("[data-gd-remove]").click();
  assert.equal(await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).count(), 0);
  await page.locator("[data-gd-back]").click();
  await page.locator("#cvgList .cvg-item").filter({ hasText:"Project team" }).waitFor();
  // A group is a deck: its own square, with its letter, in front. A group of
  // just you is that square alone, filling one tile's footprint.
  const deckCards = page.locator("#cvgList .cvg-item .cvg-stack .cv-avatar");
  const box = (locator) => locator.boundingBox();
  assert.equal(await page.locator("#cvgList .cvg-item .cv-avatar.sq").count(), 0, "the old single square is gone");
  assert.equal(await deckCards.count(), 1, "a group of just you is its own square alone");
  assert.equal(await deckCards.first().innerText(), "P");
  const lone = await box(deckCards.first()), loneStack = await box(page.locator("#cvgList .cvg-item .cvg-stack"));
  assert.deepEqual([lone.width, lone.height], [30, 30]);
  assert.deepEqual([loneStack.width, loneStack.height], [30, 30]);

  // Search narrows both lists by word prefix and bolds what matched.
  await search("pro");
  assert.equal(await page.locator("#cvgList .cvg-item").count(), 1);
  assert.equal(await page.locator("#cvgList .cvg-name b").first().innerText(), "Pro");
  assert.equal(await page.locator("#cvList .cv-person").count(), 0);
  assert.equal(await page.locator("#cvPeopleHead").isVisible(), false, "an empty section says nothing");
  assert.equal(await page.locator("#cvgNew").isVisible(), false, "New group waits while searching");
  await search("ki");
  assert.deepEqual(await peopleNames(), ["Dana Kim"]);
  assert.equal(await page.locator("#cvList .cv-name b").innerText(), "Ki");
  assert.equal(await page.locator("#cvGroups").isVisible(), false);
  await page.locator("#cvSearch").press("Escape");
  assert.equal(await page.locator("#cvSearch").inputValue(), "");
  assert.equal(await page.locator("#cvgList .cvg-item").count(), 1);
  assert.deepEqual(await peopleNames(), ["Dana Kim"]);

  // With Dana in the group, the deck shows her card behind the group's
  // square, and her name finds the group too.
  await page.locator("#cvgList .cvg-item").filter({ hasText:"Project team" }).locator("[data-group-edit]").click();
  await page.locator(".gd-title h2").getByText("Project team").waitFor();
  // The group's own page introduces it with the same deck, larger.
  assert.equal(await page.locator(".gd-identity .cvg-stack .cv-avatar").count(), 1);
  assert.deepEqual(Object.values(await box(page.locator(".gd-identity .cvg-stack"))).slice(2), [40, 40]);
  await page.locator("[data-gd-add]").fill("Dana");
  await page.locator("[data-gd-add-pick]").click();
  await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".gd-identity .cvg-stack .cv-avatar").length === 2);
  const bigStack = await box(page.locator(".gd-identity .cvg-stack"));
  const [bigFront, bigBack] = await Promise.all([0, 1].map((i) => box(page.locator(".gd-identity .cvg-stack .cv-avatar").nth(i))));
  assert.deepEqual([bigStack.width, bigStack.height, bigFront.width, bigFront.height], [40, 40, 32, 32]);
  assert.deepEqual([bigBack.x - bigFront.x, bigFront.y - bigBack.y], [4, 4], "the card behind steps up and right");
  await page.locator("[data-gd-back]").click();
  await page.locator("#cvgList .cvg-item").filter({ hasText:"Project team" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("#cvgList .cvg-item .cvg-stack .cv-avatar").length === 2);
  assert.equal(await deckCards.nth(0).innerText(), "P", "the group's own letter is in front");
  assert.equal(await deckCards.nth(1).innerText(), "", "a person's card carries no initials");
  const hues = await deckCards.evaluateAll((cards) => cards.map((card) => card.style.getPropertyValue("--cv-h")));
  assert.notEqual(hues[0], hues[1], "the person's card wears their own hue");
  const stack = await box(page.locator("#cvgList .cvg-item .cvg-stack"));
  const [front, back] = await Promise.all([0, 1].map((i) => box(deckCards.nth(i))));
  assert.deepEqual([stack.width, stack.height, front.width, front.height], [30, 30, 24, 24]);
  assert.deepEqual([back.x - front.x, front.y - back.y], [3, 3]);
  for (const card of [front, back]) {
    assert.ok(card.x >= stack.x && card.x + card.width <= stack.x + stack.width + 0.5 && card.y >= stack.y - 0.5 && card.y + card.height <= stack.y + stack.height + 0.5, "the deck keeps one tile's footprint");
  }
  const name = await box(page.locator("#cvgList .cvg-item .cvg-name"));
  assert.ok(name.x >= stack.x + stack.width, "the name starts after the deck");
  // Where the cards overlap, the group's square is the one you see.
  const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent, [back.x + 2, back.y + back.height - 2]);
  assert.equal(onTop, "P", "the group's square is on top");
  await search("ki");
  assert.equal(await page.locator("#cvgList .cvg-item").count(), 1, "a member's name finds the group");
  assert.deepEqual(await peopleNames(), ["Dana Kim"]);
  await search("dana@");
  assert.equal(await page.locator("#cvgList .cvg-item").count(), 1, "so does a member's address");
  await search("user");
  assert.equal(await page.locator("#cvGroups").isVisible(), false, "your own name does not find every group you are in");
  await page.locator("#cvSearch").press("Escape");

  // Someone already in the book is found, not offered again.
  await search("dana@example.test");
  assert.equal(await find.innerHTML(), "");
  assert.deepEqual(await peopleNames(), ["Dana Kim"]);

  // An address on Relay: one Add, and their row joins the list.
  await search("alex@example.test");
  await find.getByText("Not in your contacts").waitFor();
  await find.getByText("Added right away if they’re on Relay").waitFor();
  await page.locator("#cvFindAdd").click();
  await page.locator("#cvFindAdd").waitFor({ state:"detached" });
  assert.equal(await find.innerHTML(), "");
  await search("");
  assert.deepEqual(await peopleNames(), ["Alex Jones", "Dana Kim"], "People sorts A–Z");

  // An address not on Relay: the row turns into your link. Enter is Add.
  await search("missing@example.test");
  await page.locator("#cvSearch").press("Enter");
  await find.getByText("Not on Relay yet").waitFor();
  assert.equal(await page.locator("#cvFindAdd").count(), 0);
  assert.equal(await page.locator("#cvFindLink").innerText(), "Copy link");
  await page.locator("#cvFindLink").click();
  await find.getByText("Link copied").waitFor();
  assert.equal(await page.locator("#cvFindLink").innerText(), "Copy again");
  assert.equal(await page.locator("#cvList .cv-person").count(), 0, "a miss is not a contact");

  // A failure is told as a failure, and Add stays to try again.
  await search("offline@example.test");
  await page.locator("#cvSearch").press("Enter");
  await find.getByText("Couldn’t add them").waitFor();
  await find.getByText("Relay is unreachable right now.").waitFor();
  assert.equal(await page.locator("#cvFindAdd").isEnabled(), true);
  await page.locator("#cvSearch").press("Escape");
  assert.equal(await find.innerHTML(), "");
  assert.deepEqual(await peopleNames(), ["Alex Jones", "Dana Kim"]);
  assert.deepEqual((await page.evaluate(() => window.calls)).filter(([name]) => name !== "groupCreate" && name !== "groupAddMember"),
    [["contactAdd", "alex@example.test"], ["contactAdd", "missing@example.test"], ["copyInvite"], ["contactAdd", "offline@example.test"]],
    "one write per Add; a known address and a search write nothing");

  for (const width of [344, 736]) {
    await page.setViewportSize({ width, height:800 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await search("someone@example.test");
      for (const selector of ["#cvSearch", "#cvFind .cv-find-row", "#cvFindAdd"]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${selector} fits at ${width}px`);
      }
      await page.locator("#cvSearch").press("Escape");
    }
  }
  // The field has no box inside its box: the ring is on the field's frame.
  await page.locator("#cvSearch").focus();
  const field = await page.locator("#cvSearch").evaluate((el) => {
    const input = getComputedStyle(el), frame = getComputedStyle(el.closest(".cv-search"));
    return { border:input.borderTopWidth, outline:input.outlineStyle, shadow:input.boxShadow, appearance:input.webkitAppearance || input.appearance, frame:frame.boxShadow };
  });
  assert.deepEqual([field.border, field.outline, field.shadow, field.appearance], ["0px", "none", "none", "none"]);
  assert.notEqual(field.frame, "none", "the focus ring is on the frame");

  // Google contacts is not a search result: its card steps aside while a
  // query is typed (behind the Dev gate, here turned on).
  await page.evaluate(async () => {
    const next = await window.relay.refresh();
    window.events.onInbox({ ...next, features:{ ...next.features, googleContacts:true } });
  });
  await page.locator('[data-view="relays"]').click();
  await page.locator('[data-view="contacts"]').click();
  await page.locator("#cvGoogle").waitFor({ state:"visible" });
  await search("da");
  assert.equal(await page.locator("#cvGoogle").isVisible(), false, "typing hides the Google card");
  await page.locator("#cvSearch").press("Escape");
  await page.locator("#cvGoogle").waitFor({ state:"visible" });

  await page.locator('[data-view="relays"]').click();
  assert.equal(await page.locator("#cvSearch").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log("PASS: one field finds and adds, Groups then People A–Z, group decks, group creation/members, search narrowing (by group or member) and bold prefixes, borderless field, Google card steps aside while searching, contact success/miss/error, invite copy, native and expanded layout.");
} finally { await browser.close(); }
