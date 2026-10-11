// Link-recipient chats in the real renderer (inbox.html) with in-memory IPC.
// No installed app, no live account. RELAY_LINK_CHAT_SHOTS=<dir> also writes
// a dark screenshot of each state (A-1 … A-8 on the design board).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const SHOTS = process.env.RELAY_LINK_CHAT_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const AGENT = "## Context\nWe need one headline usage measure for the dashboard.\n\n## Open question\nWhich measure Shane trusts.";
const LONG = "Shane, before we pick a usage number for the dashboard: I think weekly active senders beats total Relays sent, because one busy person can inflate the total. Which would you trust more?";

function fixture(now, { linkChats = true } = {}) {
  const at = (min) => new Date(now - min * 60000).toISOString();
  const LINKS = [
    { id: "relay_shane_a", title: "Pricing page draft", forHuman: "The annual plan is the part I’m least sure of.", min: 60 * 7, lnk: "shl_1" },
    { id: "relay_shane_b", title: "Notes from Tuesday’s call", forHuman: "The three follow-ups we agreed, with owners.", min: 60 * 5, lnk: "shl_2" },
    { id: "relay_shane_c", title: "Choose a useful usage measure", forHuman: LONG, min: 58, lnk: "shl_3" },
  ];
  const sent = LINKS.map((l) => ({
    relayId: l.id, id: l.id, threadId: l.id, state: "pending", kind: "message",
    title: l.title, forHuman: l.forHuman, forAgent: AGENT, createdAt: at(l.min), updatedAt: at(l.min), attachments: [],
    recipient: { name: l.id === "relay_shane_b" ? "Shane" : "Shane Acton", email: `${l.lnk}@guests.sendrelays.com`, onRelay: true },
    delivery: { channel: "link", state: "sent" },
    shareLink: { id: l.lnk, url: `https://sendrelays.com/s/${l.lnk}tok`, state: "unopened" },
  }));
  // An unaddressed link with its own replier keeps today's behaviour.
  sent.push({
    relayId: "relay_anyone", id: "relay_anyone", threadId: "relay_anyone", state: "delivered", kind: "message",
    title: "Your parcel is with me", forHuman: "Your parcel is with me.", forAgent: "", createdAt: at(300), updatedAt: at(300), attachments: [],
    recipient: { name: "Someone with the link", email: "shl_9@guests.sendrelays.com", onRelay: true },
    delivery: { channel: "link", state: "opened" },
    shareLink: { id: "shl_9", url: "https://sendrelays.com/s/shl_9tok", state: "opened" },
  });
  const relays = [
    { id: "relay_welcome", threadId: "relay_welcome", direction: "inbound", state: "read", relayNotificationKind: "plain_relay",
      senderName: "Relay Agent", senderEmail: "agent@sendrelays.com", title: "Welcome to Relay", forHuman: "Relay is connected.", forAgent: "## Context\nWelcome.", createdAt: at(62), attachments: [] },
    { id: "relay_sven", threadId: "relay_sven", direction: "inbound", state: "read", senderName: "Sven", senderEmail: "sven@example.test",
      title: "", forHuman: "Pushed the fix for the paste bug. Can you try it on yours?", forAgent: "", createdAt: at(185), attachments: [] },
    { id: "relay_rando", threadId: "relay_rando", direction: "inbound", state: "read", senderName: "Rando (unverified)", senderEmail: "slm_9@guests.sendrelays.com",
      title: "", forHuman: "Thanks, got it.", forAgent: "", createdAt: at(250), attachments: [], source: { host: "share_link", shareLinkId: "shl_9" } },
  ];
  const chat = {
    key: "name:shane acton", name: "Shane Acton", firstName: "Shane", state: "no_email", contact: null,
    links: LINKS.slice().reverse().map((l) => ({ relayId: l.id, shareLinkId: l.lnk, url: `https://sendrelays.com/s/${l.lnk}tok`, label: "Shane Acton", createdAt: at(l.min), state: "unopened" })),
    newestUrl: "https://sendrelays.com/s/shl_3tok", guestAddresses: [], updatedAt: at(58),
  };
  return {
    account: { paired: true, userId: "self", name: "David", email: "david@example.test", hasSentRelay: true },
    ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1 },
    features: { requests: false, todo: false, slack: false, inboxPages: true },
    contacts: [{ id: "c-sven", name: "Sven", email: "sven@example.test", emails: ["sven@example.test"], onRelay: true },
      { id: "c-agent", name: "Relay Agent", email: "agent@sendrelays.com", emails: ["agent@sendrelays.com"], onRelay: true, source: "relay" },
      { id: "c-rando", name: "Rando", email: "slm_9@guests.sendrelays.com", emails: ["slm_9@guests.sendrelays.com"], onRelay: true }],
    relays, sent, linkChats: linkChats ? [chat] : null, requests: [], chats: [], slackChats: [],
    settings: { accountKey: "self", agentApps: [] },
  };
}

const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
const errors = [];
async function session(options = {}) {
  const page = await browser.newPage({ viewport: { width: 344, height: options.height || 700 }, colorScheme: "dark", deviceScaleFactor: 2 });
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(({ fx }) => {
    window.events = {};
    window.calls = [];
    window.fixture = fx;
    window.answer = null; // set by the test: how linkChatEmail answers
    window.push = () => window.events.onInbox && window.events.onInbox(structuredClone(window.fixture));
    const api = {
      isTestOverlay: true,
      refresh: async () => structuredClone(window.fixture),
      refreshSent: async () => ({ items: structuredClone(window.fixture.sent) }),
      contacts: async () => structuredClone(window.fixture.contacts),
      groups: async () => ({ ok: true, result: [] }),
      accountInfo: async () => structuredClone(window.fixture.account),
      agentSurfaces: async () => ({}),
      sendReply: async (input) => { window.calls.push(["sendReply", input]); return { ok: true, relayId: "relay_sent_reply" }; },
      copyShareLink: async (url) => { window.calls.push(["copyShareLink", url]); return { ok: true }; },
      copyOnboardingInviteLink: async (userId) => { window.calls.push(["copyInvite", userId]); return { ok: true, url: "https://sendrelays.com/i/d4V1d" }; },
      linkChatEmail: async (input) => {
        window.calls.push(["linkChatEmail", input]);
        await new Promise((resolve) => { window.releaseAnswer = resolve; if (!window.holdAnswer) resolve(); });
        const answer = window.answer(input);
        if (answer.ok) window.push();
        return answer;
      },
    };
    window.relay = new Proxy(api, { get: (t, k) => (k in t ? t[k] : String(k).startsWith("on") ? (cb) => { window.events[k] = cb; return () => {}; } : async () => ({ ok: true })) });
  }, { fx: fixture(Date.now(), options) });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.waitForFunction(() => !!window.events.onOpenFull);
  await page.evaluate(() => window.events.onOpenFull());
  await page.waitForTimeout(900);
  return page;
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(450);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.locator("#card").screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const shaneRow = (page) => page.locator("#relaysList [data-thread]", { hasText: "Shane Acton" });
async function openShane(page) {
  await shaneRow(page).first().click();
  await page.locator("#thLinkCard:not([hidden])").waitFor();
  await page.waitForTimeout(500);
}

try {
  // ---- The card never covers the newest message: in the compact pill, with a
  // long newest Relay, it opens folded to its one line; opened on purpose it stays open.
  let page = await session({ height: 524 });
  // A pill short enough that the open card and the long newest Relay cannot share it.
  await page.addStyleTag({ content: "#scroll { max-height: 330px !important; }" });
  await openShane(page);
  await page.locator("#thLinkCard.is-fold").waitFor();
  const compact = await page.evaluate(() => {
    const cardRect = document.getElementById("thLinkCard").getBoundingClientRect();
    const msgs = document.querySelectorAll("#thRows .th-msg");
    const last = msgs[msgs.length - 1].getBoundingClientRect();
    return { cardTop: cardRect.top, cardBottom: cardRect.bottom, lastTop: last.top };
  });
  assert.ok(compact.cardBottom - compact.cardTop < 52, "folded to one line");
  await shot(page, "compact-autofold");
  await page.locator("#thLinkCard .lk-a-card").click({ position: { x: 40, y: 12 } });
  await page.locator("#thLinkCard:not(.is-fold)").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#thLinkCard.is-fold").count(), 0, "opened on purpose, it stays open");
  await page.close();

  // ---- A-1: one Chats row for all of Shane Acton's links, with a link badge.
  page = await session();
  await shaneRow(page).first().waitFor();
  assert.equal(await shaneRow(page).count(), 1, "three links, one chat");
  assert.equal(await shaneRow(page).locator(".lk-badge").count(), 1, "the avatar wears the link badge");
  assert.match(await shaneRow(page).innerText(), /Choose a useful usage measure|weekly active senders/i, "newest preview");
  assert.equal(await page.locator("#relaysList [data-thread]", { hasText: "Rando" }).count(), 1, "an unaddressed link's replier keeps their own chat");
  await shot(page, "A-1-chats");

  // ---- A-2: the card, Copy link copies the newest link, Send waits.
  await openShane(page);
  const card = page.locator("#thLinkCard");
  assert.match(await card.innerText(), /Shane isn’t one of your contacts yet\./);
  assert.match(await card.innerText(), /You made a link for them\. Copy it and send it to them yourself\. Add their email so their replies come here and you can reach them on Relay\./);
  assert.equal(await page.locator("#thRows .th-msg").count() >= 3, true, "all three links are in the one room");
  assert.equal(await page.locator("#thQrSend").isDisabled(), true, "Send waits for an address");
  assert.equal(await page.locator("#thQrInput").getAttribute("data-placeholder"), "Add Shane’s email to message them here.");
  assert.equal(await page.locator("#thQrInput").getAttribute("contenteditable"), "false");
  assert.match(await page.locator("#thRows").innerText(), /Shared by link/);
  // The card is sticky under the header and the newest message starts below it.
  const geometry = await page.evaluate(() => {
    const cardRect = document.getElementById("thLinkCard").getBoundingClientRect();
    const msgs = document.querySelectorAll("#thRows .th-msg");
    const last = msgs[msgs.length - 1].getBoundingClientRect();
    const dock = document.querySelector(".th-composer-dock").getBoundingClientRect();
    return { cardBottom: cardRect.bottom, lastTop: last.top, lastBottom: last.bottom, lastHeight: last.height, dockTop: dock.top,
      fold: document.getElementById("thLinkCard").classList.contains("is-fold") };
  });
  assert.equal(geometry.fold, false, "the pill has room for the open card beside this Relay");
  const visible = Math.min(geometry.lastBottom, geometry.dockTop) - Math.max(geometry.lastTop, geometry.cardBottom);
  assert.ok(visible >= Math.min(geometry.lastHeight, 96) - 1, `the newest message stays in view under the card (${visible}px)`);
  await card.locator('[data-lk-act="copy-link"]').click();
  await page.waitForFunction(() => window.calls.some((c) => c[0] === "copyShareLink"));
  assert.deepEqual(await page.evaluate(() => window.calls.find((c) => c[0] === "copyShareLink")), ["copyShareLink", "https://sendrelays.com/s/shl_3tok"], "Copy link copies the newest link");
  await page.locator("#thLinkCard", { hasText: "Link copied" }).waitFor();
  await page.waitForTimeout(1900);
  await shot(page, "A-2-card");

  // ---- A-3: folded, one tappable line; the fold is remembered.
  await card.locator('[data-lk-act="fold"]').click();
  await page.locator("#thLinkCard.is-fold").waitFor();
  assert.match(await card.innerText(), /Not a contact yet/);
  assert.match(await card.innerText(), /Copy link/);
  assert.match(await card.innerText(), /Add email/);
  await shot(page, "A-3-folded");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("relay.linkChatFolded:"))), true);
  await card.locator(".lk-a-card").click({ position: { x: 40, y: 12 } });
  await page.locator("#thLinkCard:not(.is-fold)").waitFor();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("relay.linkChatFolded:"))), false);

  // ---- A-4: the email field; a bad address is refused in place.
  await card.locator('[data-lk-act="add-email"]').click();
  const field = card.locator(".lk-input");
  await field.waitFor();
  assert.equal(await card.locator("label").innerText(), "Shane’s email");
  assert.equal(await field.getAttribute("placeholder"), "shane@company.com");
  await field.fill("not-an-email");
  await field.press("Enter");
  await card.locator(".lk-a-err").waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c[0] === "linkChatEmail").length), 0);
  await field.fill("shane.acton@example.com");
  await shot(page, "A-4-email");

  // ---- A-5: checking, then A-6a: on Relay. The same Relays flip to Delivered.
  await page.evaluate(() => {
    window.holdAnswer = true;
    window.answer = (input) => {
      const f = window.fixture;
      const contact = { id: "con_shane", name: "Shane Acton", email: "shane.acton@example.com", onRelay: true };
      for (const s of f.sent.filter((row) => row.relayId.startsWith("relay_shane"))) {
        s.state = "delivered";
        s.recipient = { name: "Shane Acton", email: contact.email, onRelay: true };
        s.delivery = { channel: "device", state: "sent" };
        s.shareLink = { ...s.shareLink, state: "claimed" };
      }
      f.linkChats = [{ ...f.linkChats[0], key: "contact:con_shane", state: "on_relay", contact, newestUrl: null,
        links: f.linkChats[0].links.map((l) => ({ ...l, state: "claimed" })) }];
      f.contacts = [...f.contacts, { id: "con_shane", name: "Shane Acton", email: contact.email, emails: [contact.email], onRelay: true }];
      return { ok: true, result: { result: "on_relay", delivered: 3, contact, chat: f.linkChats[0] } };
    };
  });
  await field.press("Enter");
  await page.locator("#thLinkCard", { hasText: "Looking for Shane on Relay…" }).waitFor();
  assert.equal(await card.locator(".lk-input").isDisabled(), true);
  await shot(page, "A-5-checking");
  const sentCall = await page.evaluate(() => window.calls.find((c) => c[0] === "linkChatEmail")[1]);
  assert.equal(sentCall.key, "name:shane acton");
  assert.equal(sentCall.email, "shane.acton@example.com");
  assert.ok(sentCall.idempotencyKey.length >= 8);
  await page.evaluate(() => window.releaseAnswer());
  await page.locator("#thLinkCard", { hasText: "Shane is on Relay." }).waitFor();
  assert.match(await card.innerText(), /They’re now in your contacts, and these Relays are in their inbox\./);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#thQrSend").isDisabled(), false, "Send works once he is a contact");
  assert.notEqual(await page.locator("#thQrInput").getAttribute("data-placeholder"), "Add Shane’s email to message them here.");
  assert.match(await page.locator("#thRows").innerText(), /Delivered/);
  assert.doesNotMatch(await page.locator("#thRows").innerText(), /Shared by link/);
  await shot(page, "A-6a-on-relay");
  // The success line leaves; the chat is an ordinary chat with him.
  await page.locator("#thLinkCard[hidden]").waitFor({ state: "attached", timeout: 9000 });
  await page.locator("#thBack").click();
  await shaneRow(page).first().waitFor();
  assert.equal(await shaneRow(page).locator(".lk-badge").count(), 0, "an ordinary chat wears no link badge");
  await page.close();

  // ---- A-6b / A-7 / A-8: not on Relay, invite, change email, a reply from the link.
  page = await session();
  await openShane(page);
  const card2 = page.locator("#thLinkCard");
  if (await page.locator("#thLinkCard.is-fold").count()) await card2.locator(".lk-a-card").click({ position: { x: 40, y: 12 } });
  await card2.locator('[data-lk-act="add-email"]').click();
  await card2.locator(".lk-input").fill("shane@newco.example");
  await page.evaluate(() => {
    window.answer = (input) => {
      const f = window.fixture;
      const contact = { id: "con_shane", name: "Shane Acton", email: input.email, onRelay: false };
      f.linkChats = [{ ...f.linkChats[0], key: "contact:con_shane", state: "not_on_relay", contact }];
      return { ok: true, result: { result: "not_on_relay", delivered: 0, contact, chat: f.linkChats[0] } };
    };
  });
  await card2.locator(".lk-input").press("Enter");
  await page.locator("#thLinkCard", { hasText: "Shane isn’t on Relay yet." }).waitFor();
  assert.match(await card2.innerText(), /They can still read your link in their browser\. When they join, this conversation will be waiting for them\./);
  assert.equal(await page.locator("#thQrSend").isDisabled(), false, "messages typed here go to his email");
  assert.equal(await page.locator("#thQrInput").getAttribute("contenteditable"), "true");
  await card2.locator('[data-lk-act="copy-invite"]').click();
  await page.waitForFunction(() => window.calls.some((c) => c[0] === "copyInvite"));
  assert.deepEqual(await page.evaluate(() => window.calls.find((c) => c[0] === "copyInvite")), ["copyInvite", "self"]);
  await page.waitForTimeout(1900);
  await shot(page, "A-6b-not-on-relay");
  // Change email: the field comes back with the address to fix.
  await card2.locator('[data-lk-act="change-email"]').click();
  assert.equal(await card2.locator(".lk-input").inputValue(), "shane@newco.example");
  await card2.locator('[data-lk-act="cancel"]').click();
  await card2.locator('[data-lk-act="fold"]').click();
  await page.locator("#thLinkCard.is-fold").waitFor();
  assert.match(await card2.innerText(), /Invite Shane to Relay/);
  assert.match(await card2.innerText(), /Copy invite link/);
  await shot(page, "A-7-invite-folded");

  // A reply typed on the link page lands in this chat, said so.
  await page.evaluate(() => {
    const f = window.fixture;
    f.relays.push({ id: "relay_shane_reply", threadId: "relay_copy", direction: "inbound", state: "delivered", unread: true,
      senderName: "Shane Acton (unverified)", senderEmail: "slm_7@guests.sendrelays.com", title: "",
      forHuman: "Weekly active senders, agreed. Total sent flatters us. Can we see it split by new vs returning?",
      forAgent: "", createdAt: new Date().toISOString(), attachments: [], source: { host: "share_link", shareLinkId: "shl_3" } });
    const shane = f.sent.find((s) => s.relayId === "relay_shane_c");
    shane.shareLink = { ...shane.shareLink, state: "opened", firstOpenedAt: new Date().toISOString() };
    f.linkChats = [{ ...f.linkChats[0], guestAddresses: ["slm_7@guests.sendrelays.com"] }];
    window.push();
  });
  await page.locator("#thRows", { hasText: "Weekly active senders, agreed." }).waitFor();
  assert.match(await page.locator("#thRows").innerText(), /replied from the link/);
  assert.match(await page.locator("#thRows").innerText(), /Opened from the link/);
  assert.doesNotMatch(await page.locator("#thRows").innerText(), /\(unverified\)/);
  await page.evaluate(() => { const el = document.getElementById("scroll"); el.scrollTop = el.scrollHeight; });
  await shot(page, "A-8-reply-from-link");
  await page.locator("#thBack").click();
  await shaneRow(page).first().waitFor();
  assert.equal(await shaneRow(page).count(), 1, "the replier did not open a second chat");
  assert.equal(await page.locator("#relaysList [data-thread]", { hasText: "Shane Acton (unverified)" }).count(), 0);
  await page.close();

  // ---- No email yet, but they replied on the link page: Send answers
  // through the link, to the newest replier, exactly as before link chats.
  page = await session();
  await page.evaluate(() => {
    const f = window.fixture;
    const at = (min) => new Date(Date.now() - min * 60000).toISOString();
    f.relays.push(
      { id: "relay_reply_old", threadId: "relay_copy_1", direction: "inbound", state: "read", senderName: "Shane Acton (unverified)",
        senderEmail: "slm_1@guests.sendrelays.com", title: "", forHuman: "Read the pricing one.", forAgent: "", createdAt: at(30), attachments: [],
        source: { host: "share_link", shareLinkId: "shl_1" } },
      { id: "relay_reply_new", threadId: "relay_copy_3", direction: "inbound", state: "delivered", unread: true, senderName: "Shane (unverified)",
        senderEmail: "slm_3@guests.sendrelays.com", title: "", forHuman: "Weekly active senders, agreed.", forAgent: "", createdAt: at(5), attachments: [],
        source: { host: "share_link", shareLinkId: "shl_3" } },
    );
    f.linkChats = [{ ...f.linkChats[0], guestAddresses: ["slm_1@guests.sendrelays.com", "slm_3@guests.sendrelays.com"] }];
  });
  await page.evaluate(() => window.push());
  await openShane(page);
  assert.equal(await page.locator("#thQrSend").isDisabled(), false, "a reply on the link page opens Send");
  assert.equal(await page.locator("#thQrInput").getAttribute("contenteditable"), "true");
  assert.notEqual(await page.locator("#thQrInput").getAttribute("data-placeholder"), "Add Shane’s email to message them here.");
  assert.equal(await page.locator(".lk-reply-hint").innerText(), "Replying through your link. Add Shane’s email to reach them on Relay.");
  assert.match(await page.locator("#thLinkCard").innerText(), /isn’t one of your contacts yet|Not a contact yet/, "the card still offers the email step");
  await page.locator("#thQrInput").click();
  await page.keyboard.type("Split by new vs returning, coming up.");
  await page.locator("#thQrSend").click();
  await page.waitForFunction(() => window.calls.some((c) => c[0] === "sendReply"));
  const reply = await page.evaluate(() => window.calls.find((c) => c[0] === "sendReply")[1]);
  assert.equal(reply.recipient.email, "slm_3@guests.sendrelays.com", "to the newest replier's own link conversation");
  assert.equal(reply.text, "Split by new vs returning, coming up.");
  await shot(page, "link-reply-composer");
  // Their email added: the hint goes and Send goes to the email (as above).
  await page.evaluate(() => {
    const f = window.fixture;
    f.linkChats = [{ ...f.linkChats[0], key: "contact:con_shane", state: "not_on_relay", contact: { id: "con_shane", name: "Shane Acton", email: "shane@newco.example", onRelay: false } }];
    window.push();
  });
  await page.locator(".lk-reply-hint").waitFor({ state: "detached" });
  assert.equal(await page.locator("#thQrSend").isDisabled(), false);
  await page.close();

  // ---- An API that predates link chats: today's behaviour, no card, no badge.
  page = await session({ linkChats: false });
  await page.locator("#relaysList [data-thread]").first().waitFor();
  assert.equal(await shaneRow(page).count(), 0, "unanswered links stay on the Relays page");
  assert.equal(await page.locator(".lk-badge").count(), 0);
  await page.close();

  assert.deepEqual(errors, []);
  console.log("PASS: link chats — one row per person with badge, card states A-2…A-8, fold memory, copy link/invite, email validation, on/not on Relay, Send gating, link replies filed with label, older API untouched.");
} finally {
  await browser.close();
}
