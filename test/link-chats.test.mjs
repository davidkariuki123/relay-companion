// Link-recipient chats, the pure half (overlay/link-chats.js): which room a
// row is filed in, what the card says in each state, when Send waits.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = { globalThis: {} };
context.window = context.globalThis;
vm.runInNewContext(fs.readFileSync(new URL("../overlay/link-chats.js", import.meta.url), "utf8"), context);
const L = context.globalThis.RelayLinkChats;

const chat = (over = {}) => ({
  key: "name:shane acton", name: "Shane Acton", firstName: "Shane", state: "no_email", contact: null,
  links: [{ relayId: "relay_b", shareLinkId: "shl_b" }, { relayId: "relay_a", shareLinkId: "shl_a" }],
  newestUrl: "https://sendrelays.com/s/b", guestAddresses: ["slm_1@guests.sendrelays.com"], ...over,
});

test("a chat without an email is its own room; with one, it is the contact's chat", () => {
  assert.equal(L.roomKeyOf(chat()), "linkchat:name:shane acton");
  assert.equal(L.roomKeyOf(chat({ contact: { email: "Shane@Example.com" } })), "email:shane@example.com");
  assert.equal(L.chatsOf({ linkChats: null }), null, "an API that cannot say");
  assert.equal(L.chatsOf({}), null);
});

test("links, replies through them and earlier answers to repliers are filed into the person's room", () => {
  const index = L.buildIndex([chat()]);
  const rows = [
    { id: "relay_a", direction: "out", partyKey: "share:shl_a", party: "Shane", addressRecipient: { email: "shl_a@guests.sendrelays.com" } },
    { id: "relay_r", direction: "in", partyKey: "email:slm_1@guests.sendrelays.com", party: "Shane Acton (unverified)", addressRecipient: { email: "slm_1@guests.sendrelays.com" } },
    { id: "relay_early", direction: "in", partyKey: "email:slm_2@guests.sendrelays.com", party: "Jo (unverified)", source: { host: "share_link", shareLinkId: "shl_b" } },
    { id: "relay_answer", direction: "out", partyKey: "email:slm_1@guests.sendrelays.com", party: "Shane Acton (unverified)" },
    { id: "relay_other", direction: "in", partyKey: "email:sven@example.com", party: "Sven", addressRecipient: { email: "sven@example.com" } },
    { id: "relay_anyone", direction: "in", partyKey: "email:slm_9@guests.sendrelays.com", party: "Rando (unverified)", source: { host: "share_link", shareLinkId: "shl_9" } },
  ];
  L.rekey(rows, index);
  const [link, reply, early, answer, other, anyone] = rows;
  for (const row of [link, reply, early, answer]) {
    assert.equal(row.partyKey, "linkchat:name:shane acton");
    assert.equal(row.linkChatKey, "name:shane acton");
  }
  assert.equal(link.addressRecipient, null, "a link itself is no address before an email exists");
  assert.equal(answer.addressRecipient, null, "only a reply typed on the link page addresses the room");
  assert.deepEqual({ ...reply.addressRecipient }, { email: "slm_1@guests.sendrelays.com" }, "answering it goes back through the link, as today");
  assert.deepEqual({ ...early.addressRecipient }, { email: "slm_2@guests.sendrelays.com" });
  assert.equal(link.party, "Shane Acton", "the link is to the person the chat is named for");
  assert.equal(reply.linkReply, true);
  assert.equal(reply.party, "Shane Acton", "the card says it came through the link; no (unverified) twice");
  assert.equal(early.linkReply, true, "a reply ahead of the next refresh still names its link");
  assert.equal(other.partyKey, "email:sven@example.com");
  assert.equal(other.linkChatKey, undefined);
  assert.equal(anyone.partyKey, "email:slm_9@guests.sendrelays.com", "an unaddressed link's replier keeps their own chat");

  const emailed = L.rekey([{ id: "relay_a", direction: "out", partyKey: "share:shl_a" }],
    L.buildIndex([chat({ state: "not_on_relay", contact: { id: "con", name: "Shane Acton", email: "shane@x.com" } })]));
  assert.equal(emailed[0].partyKey, "email:shane@x.com");
  assert.deepEqual({ ...emailed[0].addressRecipient }, { email: "shane@x.com", name: "Shane Acton" }, "what is typed there goes to the email");
});

test("the card's faces follow the chat and the person's choices", () => {
  const now = 1_000;
  assert.equal(L.cardKind(chat(), {}, now), "intro");
  assert.equal(L.cardKind(chat(), { folded: true }, now), "fold-intro");
  assert.equal(L.cardKind(chat(), { mode: "email" }, now), "email");
  assert.equal(L.cardKind(chat(), { mode: "checking" }, now), "checking");
  const invited = chat({ state: "not_on_relay", contact: { email: "s@x.com" } });
  assert.equal(L.cardKind(invited, {}, now), "fold-invite", "after the email step it is one line");
  assert.equal(L.cardKind(invited, { expanded: true }, now), "invite");
  const joined = chat({ state: "on_relay", contact: { email: "s@x.com" } });
  assert.equal(L.cardKind(joined, {}, now), "", "an ordinary chat has no card");
  assert.equal(L.cardKind(joined, { joinedUntil: now + 1 }, now), "joined");
  assert.equal(L.cardKind(joined, { joinedUntil: now - 1 }, now), "");
});

test("the copy, word for word", () => {
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const intro = text(L.cardHtml(chat(), {}));
  assert.match(intro, /Shane isn’t one of your contacts yet\./);
  assert.match(intro, /You made a link for them\. Copy it and send it to them yourself\. Add their email so their replies come here and you can reach them on Relay\./);
  assert.match(intro, /Copy link Add Shane’s email/);
  assert.match(text(L.cardHtml(chat(), { folded: true })), /^Not a contact yet Copy link Add email/);
  assert.doesNotMatch(L.cardHtml(chat({ newestUrl: null }), {}), /copy-link/, "no live link, nothing to copy");
  const email = L.cardHtml(chat(), { mode: "email" });
  assert.match(text(email), /Shane’s email/);
  assert.match(email, /placeholder="shane@company\.com"/);
  assert.match(text(L.cardHtml(chat(), { mode: "checking", email: "s@x.com" })), /Looking for Shane on Relay…/);
  const joined = chat({ state: "on_relay" });
  assert.match(text(L.cardHtml(joined, { joinedUntil: Date.now() + 5000, delivered: 1 })), /Shane is on Relay\. They’re now in your contacts, and this Relay is in their inbox\./);
  assert.match(text(L.cardHtml(joined, { joinedUntil: Date.now() + 5000, delivered: 3 })), /these Relays are in their inbox\./);
  const invited = chat({ state: "not_on_relay", contact: { email: "s@x.com" } });
  assert.match(text(L.cardHtml(invited, { expanded: true })), /Shane isn’t on Relay yet\. − They can still read your link in their browser\. When they join, this conversation will be waiting for them\. Copy invite link Change email/);
  assert.match(text(L.cardHtml(invited, {})), /^Invite Shane to Relay Copy invite link$/);
  assert.doesNotMatch(L.cardHtml(chat({ name: "<img src=x>", firstName: "<img" }), {}), /<img/, "names are escaped");
  assert.equal(L.emailPlaceholder(chat({ firstName: "José" })), "jose@company.com");
  assert.equal(L.emailPlaceholder(chat({ firstName: "李" })), "name@company.com");
});

test("three composer states: blocked, answering through the link, ordinary", () => {
  const index = L.buildIndex([chat()]);
  const link = L.rekey([{ id: "relay_a", direction: "out", partyKey: "share:shl_a" }], index);
  assert.equal(L.composerMode(chat(), link), "blocked", "no reply and no email: nothing could reach them");
  assert.equal(L.composerBlocked(chat(), link), true);
  const replied = L.rekey([
    { id: "relay_a", direction: "out", partyKey: "share:shl_a" },
    { id: "relay_r", direction: "in", partyKey: "email:slm_1@guests.sendrelays.com", party: "Shane Acton (unverified)" },
  ], index);
  assert.equal(L.composerMode(chat(), replied), "link-reply", "a reply on the link page opens Send, back through the link");
  assert.equal(L.composerBlocked(chat(), replied), false);
  assert.equal(L.linkReplyHint(chat()), "Replying through your link. Add Shane’s email to reach them on Relay.");
  for (const state of ["not_on_relay", "on_relay"]) {
    const emailed = chat({ state, contact: { email: "s@x.com", name: "Shane Acton" } });
    assert.equal(L.composerMode(emailed, replied), "open", `${state}: the email is the address`);
    const filed = L.rekey([{ id: "relay_r2", direction: "in", partyKey: "email:slm_1@guests.sendrelays.com" }], L.buildIndex([emailed]));
    assert.equal(filed[0].addressRecipient.email, "s@x.com", `${state}: Send goes to the email, not the link`);
  }
  assert.equal(L.composerMode(null, replied), "open");
});

test("Send waits for an address, and the card never covers the newest message", () => {
  assert.equal(L.composerBlocked(chat()), true);
  assert.equal(L.composerBlocked(chat({ state: "not_on_relay" })), false);
  assert.equal(L.composerBlocked(chat({ state: "on_relay" })), false);
  assert.equal(L.composerBlocked(null), false);
  assert.equal(L.composerPlaceholder(chat()), "Add Shane’s email to message them here.");
  assert.equal(L.coversNewest(130, 260), false, "a real part of a long message is in view");
  assert.equal(L.coversNewest(60, 260), true);
  assert.equal(L.coversNewest(60, 50), false, "a short message fits whole");
  assert.equal(L.coversNewest(40, 50), true);
  assert.equal(L.coversNewest(-10, 50), true);
});

test("receipts say how a link travelled until Relay delivers it", () => {
  assert.equal(L.receiptLabel({ shareLink: { state: "unopened" } }), "Shared by link");
  assert.equal(L.receiptLabel({ shareLink: { state: "opened" } }), "Opened from the link");
  assert.equal(L.receiptLabel({ shareLink: { state: "claimed" } }), "", "delivered: the ordinary receipt");
  assert.equal(L.receiptLabel({ shareLink: { kind: "sent", state: "opened" } }), "");
  assert.equal(L.receiptLabel({}), "");
});
