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
  await page.locator("#cvNew").waitFor();
  const choose = async (id) => { await page.locator("#cvNew").click(); await page.locator(id).click(); };
  const focused = () => page.evaluate(() => document.activeElement.id);

  // One header row at native pill width; both actions work from either pane.
  const segment = await page.locator(".cv-seg").boundingBox();
  const trigger = await page.locator("#cvNew").boundingBox();
  assert.ok(trigger.x >= segment.x + segment.width);
  assert.ok(Math.abs((segment.y + segment.height / 2) - (trigger.y + trigger.height / 2)) < 1);
  await page.locator("#cvNew").click();
  assert.deepEqual(await page.locator("#cvNewMenu button").allTextContents(), ["New Contact", "New Group"]);
  assert.equal(await focused(), "cvNewContact");
  await page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "cvgNew");
  await page.keyboard.press("Escape");
  assert.equal(await focused(), "cvNew");
  assert.equal(await page.locator("#cvNewMenu").isVisible(), false);
  await page.locator("#cvNew").click();
  await page.locator("#cvSegGroups").click();
  assert.equal(await page.locator("#cvNewMenu").isVisible(), false);
  await page.locator("#cvSegPeople").click();

  await choose("#cvgNew");
  assert.equal(await page.locator("#cvSegGroups").getAttribute("aria-selected"), "true");
  assert.equal(await focused(), "cvgNewName");
  await page.locator("#cvgNewName").fill("Draft");
  await choose("#cvgNew");
  assert.equal(await page.locator("#cvgNewName").inputValue(), "Draft", "New Group keeps an open draft visible");
  await page.locator("#cvgNewCancel").click();
  assert.equal(await focused(), "cvNew");
  assert.equal(await page.locator("#cvgNewForm").isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.calls), [], "opening and cancelling creates nothing");

  await choose("#cvgNew");
  await page.locator("#cvgNewName").fill("Taken");
  await page.locator("#cvgNewName").press("Enter");
  await page.locator("#cvgError").getByText("A group with that name already exists.").waitFor();
  assert.equal(await page.locator("#cvgNewName").inputValue(), "Taken");
  await page.locator("#cvgNewName").fill("Project team");
  await page.locator("#cvgNewName").press("Enter");
  await page.locator(".gd-title h2").getByText("Project team").waitFor();
  assert.equal(await page.locator("#cvNew").isVisible(), false, "details retain their existing focused layout");
  await page.locator("[data-gd-add]").fill("Dana");
  await page.locator("[data-gd-add-pick]").click();
  await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.calls)).slice(0, 3), [["groupCreate", "Taken"], ["groupCreate", "Project team"], ["groupAddMember", "grp_1", "con_dana"]]);
  await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).locator("[data-gd-remove]").click();
  assert.equal(await page.locator(".gd-member").filter({ hasText:"Dana Kim" }).count(), 0);
  await page.locator("[data-gd-back]").click();

  await choose("#cvNewContact");
  assert.equal(await page.locator("#cvSegPeople").getAttribute("aria-selected"), "true");
  await page.locator("#cvAddInput").fill("alex@example.test");
  await page.locator("#cvAdd").click();
  await page.locator("#cvAddSheet").waitFor({ state:"hidden" });
  assert.equal(await page.locator("#cvList .cv-person").count(), 2);
  assert.equal(await focused(), "cvNew");

  await choose("#cvNewContact");
  await page.locator("#cvAddInput").fill("missing@example.test");
  await page.locator("#cvAddInput").press("Enter");
  await page.locator("#cvAddNote").getByText(/No Relay account found/).waitFor();
  assert.equal(await page.locator("#cvList .cv-person").count(), 2);
  await page.locator("#cvAddLink").click();
  assert.equal(await page.locator("#cvAddLink").innerText(), "Copied");
  await page.locator("#cvAddInput").fill("offline@example.test");
  await page.locator("#cvAddInput").press("Enter");
  await page.locator("#cvAddNote").getByText("Relay is unreachable right now.").waitFor();
  await page.locator("#cvAddCancel").click();
  assert.equal(await focused(), "cvNew");
  await choose("#cvNewContact");
  await choose("#cvgNew");
  assert.equal(await page.locator("#cvAddSheet").isVisible(), false);
  await choose("#cvNewContact");
  assert.equal(await page.locator("#cvgNewForm").isVisible(), false);
  await page.locator("#cvAddCancel").click();

  for (const width of [344, 736]) {
    await page.setViewportSize({ width, height:800 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator("#cvNew").click();
      const menu = await page.locator("#cvNewMenu").boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width && menu.y + menu.height <= 800);
      await page.keyboard.press("Escape");
    }
  }
  await page.locator("#cvNew").click();
  await page.locator('[data-view="relays"]').click();
  assert.equal(await page.locator("#cvNewMenu").isVisible(), false);
  assert.equal(await page.locator("#cvNew").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log("PASS: shared creation menu, keyboard/dismissal/focus, both panes, group creation/members, contact success/miss/error, invite copy, native and expanded layout.");
} finally { await browser.close(); }
