// Real renderer with mocked IPC. New replies, unfolded (David, 2026-10-07):
// a folded reply that is still unread is shown inside the message it answers,
// read only once it has been on screen, and reachable from one capsule over
// the composer, on every visit, for as long as the chat has unread replies.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 640 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const pill = { host: "relay-preview", clientVersion: "0.1.590" };
    const sven = { senderName: "Sven Wellmann", senderEmail: "sven@example.com" };
    const toSven = { recipient: { name: "Sven Wellmann", email: "sven@example.com" }, state: "delivered" };
    const text = (id, minutes, words, extra = {}) => ({ id, threadId: "t1", kind: "message", title: "", forHuman: words, forAgent: "",
      ...sven, createdAt: ago(minutes), unread: false, source: pill, ...extra });
    const relays = [
      { id: "relay_r1", threadId: "t1", kind: "message", relayNotificationKind: "plain_relay", title: "Conductor support research",
        forHuman: "Relay already works in Conductor.", forAgent: "The detail.", ...sven, createdAt: ago(300), unread: false, source: pill },
      text("relay_n1", 20, "Read it. Shipping the link today.", { inReplyToRelayId: "relay_r1", unread: true }),
      // Enough read history between the two threads that they never share a screen.
      ...Array.from({ length: 18 }, (_, i) => text(`relay_f${i}`, 280 - i * 10, `Earlier note ${i + 1}, already read.`)),
      // A busy thread: five new replies to one text of mine.
      ...["Agreed.", "Full screen for backlogs.", "Same paper, more room.", "Collapse snaps back.", "I will dig up the mocks."]
        .map((words, i) => text(`relay_n${i + 2}`, 10 - i, words, { inReplyToRelayId: "relay_t1", unread: true })),
    ];
    const sent = [
      { relayId: "relay_t1", threadId: "t1", kind: "message", title: "", forHuman: "What about an expanded full-screen view?", forAgent: "",
        ...toSven, createdAt: ago(60), updatedAt: ago(60), source: pill },
    ];
    const group = { id: "grp_designs", name: "Designs", owner: { userId: "self", name: "David", email: "david@example.com" },
      members: [{ userId: "sven", name: "Sven Wellmann", email: "sven@example.com" }] };
    for (const row of [...relays, ...sent]) Object.assign(row, { recipientGroupId: group.id, recipientGroupName: group.name });
    window.fixture = { account: { paired: true, userId: "self", name: "David", email: "david@example.com", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
      features: { replyThreads: true }, relays, sent, requests: [], chats: [], slackChats: [], outbox: [] };
    window.acks = [];
    const api = { isTestOverlay: true, refresh: async () => window.fixture, refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => [], groups: async () => ({ ok: true, result: [group] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      ackMany: async (ids) => { window.acks.push(...ids); return { ok: true }; } };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  const state = () => page.evaluate(() => {
    const control = document.querySelector(".th-unread-jump");
    const unread = payload.relays.filter((row) => row.unread).map((row) => String(row.id));
    return {
      unread,
      onScreen: unreadReplyNewsIds().filter((id) => replyNewsPlacement(id) === "visible"),
      next: nextReplyNewsTarget(),
      capsule: control && !control.classList.contains("hidden") ? control.innerText.replace(/\s+/g, " ").trim() : "",
      badge: document.getElementById("relaysBadge")?.textContent.trim() || "",
    };
  });
  const openRoom = async () => {
    await page.locator('#relaysList .relay-arrival[data-party="Designs"]').click();
    await page.locator('#thRows [data-msg="relay_r1"]').waitFor({ state: "attached" });
    await page.waitForFunction(() => !threadEntryFollowToken());
  };
  const leaveRoom = async () => {
    await page.locator("#thBack").click();
    await page.locator('#relaysList .relay-arrival[data-party="Designs"]').waitFor();
  };

  await openRoom();
  // The news sits inside the message it answers, above its reply strip.
  const card = page.locator('#thRows [data-msg="relay_r1"]');
  assert.equal(await card.locator('[data-rt-tray] [data-rt-news="relay_n1"]').count(), 1, "a Relay card holds its new reply");
  assert.ok(await card.evaluate((el) => {
    const tray = el.querySelector("[data-rt-tray]"), strip = el.querySelector(".th-rt-link.strip");
    return Boolean(tray && strip && tray.nextElementSibling === strip);
  }), "the news sits directly above the card's reply strip");
  const bubble = page.locator('#thRows [data-msg="relay_t1"]');
  assert.ok(await bubble.evaluate((el) => el.classList.contains("holds-news")), "a text with news becomes a holder");
  assert.equal(await bubble.locator(".th-rt-link.strip[data-reply-thread-open='relay_t1']").count(), 1, "its reply line moves inside as a strip");
  assert.equal(await page.locator("#thRows > .th-rt-link[data-reply-thread-open='relay_t1']").count(), 0, "and is not repeated outside");
  assert.equal(await bubble.locator(".th-rt-link.strip").getAttribute("data-reply-thread-reader"), null, "a text's strip opens its thread, not a reader");
  // Five new replies: two show, three wait behind one line.
  assert.equal(await bubble.locator("[data-rt-tray] > [data-rt-news]").count(), 2);
  assert.match(await bubble.locator("[data-rt-more]").innerText(), /3 more new replies/);
  assert.doesNotMatch(await bubble.locator(".th-rt-link.strip").innerText(), /new/, "the strip does not count what the message already shows");
  assert.deepEqual(await page.evaluate(() => window.acks), [], "opening the room reads none of the folded replies");

  let s = await state();
  assert.equal(s.unread.length, 6);
  assert.match(s.capsule, /6 new/, "the capsule offers every new reply");
  assert.equal(s.badge, "6");

  // A visit that reads nothing leaves everything unread, and the next visit
  // shows it all again.
  await leaveRoom();
  assert.equal((await state()).unread.length, 6, "leaving clears nothing that was not shown");
  await openRoom();
  assert.match((await state()).capsule, /6 new/, "every visit shows the capsule while replies are unread");

  // Each press goes somewhere you cannot see, reads what you were shown, and
  // the count only ever falls.
  let presses = 0;
  let last = s.unread.length;
  let shownThisVisit = [];
  while ((s = await state()).unread.length && presses < 10) {
    if (!s.next) { await page.waitForTimeout(800); continue; }
    assert.ok(!s.onScreen.includes(s.next), `press ${presses + 1} goes off screen (${s.next})`);
    await page.locator(".th-unread-jump-btn").click();
    presses += 1;
    await page.waitForFunction(() => !replyNews?.gliding);
    await page.waitForTimeout(900);
    const after = await state();
    assert.ok(after.unread.length <= last, "the count never rises");
    assert.equal(after.badge || "0", String(after.unread.length || "0").replace(/^0$/, "0"), "the badge tells the truth");
    last = after.unread.length;
    if (presses === 1) {
      // Partway through: leave and come back. The rest is still offered.
      await leaveRoom();
      await openRoom();
      assert.match((await state()).capsule, new RegExp(`${last} new`), "a return visit offers what is left");
      shownThisVisit = await page.evaluate(() => [...document.querySelectorAll("#thRows [data-rt-news]")].map((row) => row.dataset.rtNews));
      assert.equal(shownThisVisit.length, last, "a return visit starts from what is still unread");
    }
  }
  assert.equal((await state()).unread.length, 0, "the capsule reaches every new reply");
  assert.equal(await page.locator("#thRows [data-rt-more][aria-expanded='false']").count(), 0, "nothing new is left behind a closed fold");
  assert.deepEqual([...new Set(await page.evaluate(() => window.acks))].sort(),
    ["relay_n1", "relay_n2", "relay_n3", "relay_n4", "relay_n5", "relay_n6"]);
  // Read replies stay where they were for the rest of the visit.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#thRows [data-rt-news]")].map((row) => row.dataset.rtNews)),
    shownThisVisit, "nothing read this visit vanishes from under the reader");
  // Done: the way back to the newest message, then nothing.
  await page.waitForFunction(() => {
    const control = document.querySelector(".th-unread-jump");
    return control.classList.contains("hidden") || /Latest|Caught up/.test(control.innerText);
  });
  if (!(await page.evaluate(() => roomAtNewest()))) {
    await page.waitForFunction(() => /Latest/.test(document.querySelector(".th-unread-jump").innerText));
    await page.locator(".th-unread-jump-btn").click();
    await page.waitForFunction(() => roomAtNewest());
  }
  await page.waitForFunction(() => document.querySelector(".th-unread-jump").classList.contains("hidden"));

  // With nothing unread the next visit is the ordinary room.
  await leaveRoom();
  await openRoom();
  assert.equal(await page.locator("#thRows [data-rt-tray]").count(), 0, "read replies fold again on the next visit");
  assert.equal(await page.locator("#thRows > .th-rt-link[data-reply-thread-open='relay_t1']").count(), 1, "the reply line is back under the text");
  assert.ok(await page.locator(".th-unread-jump").evaluate((el) => el.classList.contains("hidden")), "no capsule without unread replies");
  // The capsule opens a fold itself when the next new reply is behind it.
  await page.reload();
  await openRoom();
  for (let i = 0; i < 4 && await page.evaluate(() => nextReplyNewsTarget()) !== "relay_n4"; i += 1) {
    await page.locator(".th-unread-jump-btn").click();
    await page.waitForFunction(() => !replyNews?.gliding);
    await page.waitForTimeout(900);
  }
  assert.equal(await page.evaluate(() => nextReplyNewsTarget()), "relay_n4", "the next new reply is the first behind the fold");
  assert.ok(await page.evaluate(() => !document.querySelector('[data-rt-tray="relay_t1"]').classList.contains("open")), "the fold is still closed");
  await page.locator(".th-unread-jump-btn").click();
  await page.waitForFunction(() => document.querySelector('[data-rt-tray="relay_t1"]').classList.contains("open"));
  await page.waitForFunction(() => !replyNews?.gliding);
  assert.equal(await page.evaluate(() => replyNewsPlacement("relay_n4")), "visible", "and lands on it");
  assert.deepEqual(errors, []);
  console.log("PASS: new replies show inside their message on every visit while unread, are read only once shown, and one capsule reaches every one, opening a fold on its way.");
} finally { await browser.close(); }
