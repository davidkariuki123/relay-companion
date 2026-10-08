// A group room speaks to the group (David, Granular, 2026-10-08). The room
// folds thread replies under their Relay and gathers a Task's completions,
// which are direct messages, so the newest visible row with an address was
// Shane's "Done". The composer inherited that address and two messages typed
// into Granular went to Shane alone, and never showed in the room.
// Real renderer, mocked IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.RELAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RELAY_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 750, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const pill = { host: "relay-preview", clientVersion: "0.1.596" };
    const room = { recipientGroupId: "grp_granular", recipientGroupName: "Granular" };
    const shane = { senderName: "Shane Acton", senderEmail: "shane@example.com" };
    const sven = { senderName: "Sven Wellmann", senderEmail: "sven@example.com" };
    const toGroup = { recipient: { name: "Granular" }, state: "delivered", ...room };
    const relays = [
      { id: "relay_shane_text", threadId: "relay_shane_text", kind: "message", title: "", forHuman: "Cooking on task UX.", forAgent: "",
        ...shane, ...room, createdAt: ago(70), unread: false, source: pill },
      // Replies in the thread of the question: they fold under it.
      { id: "relay_outline", threadId: "t_question", kind: "message", title: "", forHuman: "It needs a subtle outline.", forAgent: "",
        ...shane, ...room, inReplyToRelayId: "relay_question", createdAt: ago(60), unread: false, source: pill },
      { id: "relay_messy", threadId: "t_question", kind: "message", title: "", forHuman: "The big button looks messy.", forAgent: "",
        ...sven, ...room, inReplyToRelayId: "relay_question", createdAt: ago(58), unread: false, source: pill },
      // The Task's completion: a DIRECT message from Shane, no group on it.
      { id: "relay_done", threadId: "relay_task", kind: "message", type: "completion", title: "", forHuman: "Done", forAgent: "",
        ...shane, inReplyToRelayId: "relay_task", createdAt: ago(50), unread: false, source: { host: "relay-mcp" } },
    ];
    const sent = [
      { relayId: "relay_task", threadId: "relay_task", kind: "task", title: "Update to the latest dev Relay", forHuman: "Can you update?", forAgent: "Steps.",
        ...toGroup, groupSendId: "gsend_task", taskAssignment: "everyone", createdAt: ago(120), updatedAt: ago(120), source: pill },
      { relayId: "relay_question", threadId: "t_question", kind: "message", title: "Thoughts on expanded mode?", forHuman: "What do you think?", forAgent: "Detail.",
        ...toGroup, groupSendId: "gsend_question", createdAt: ago(65), updatedAt: ago(65), source: pill },
      { relayId: "relay_mine", threadId: "t_question", kind: "message", title: "", forHuman: "My current view is…", forAgent: "",
        ...toGroup, groupSendId: "gsend_mine", inReplyToRelayId: "relay_question", createdAt: ago(40), updatedAt: ago(40), source: pill },
    ];
    const group = { id: "grp_granular", name: "Granular", owner: { userId: "sven", name: "Sven Wellmann", email: "sven@example.com" },
      members: [{ userId: "self", name: "David Kariuki", email: "david@example.com" }, { userId: "shane", name: "Shane Acton", email: "shane@example.com" }] };
    window.fixture = { account: { paired: true, userId: "self", name: "David Kariuki", email: "david@example.com", hasSentRelay: true },
      ui: { canDismiss: true, onboardingRequired: false, completedOnboardingVersion: 1, soundsMuted: true },
      features: { replyThreads: true }, relays, sent, requests: [], chats: [], slackChats: [], outbox: [] };
    window.sends = [];
    const api = { isTestOverlay: true, refresh: async () => window.fixture, refreshSent: async () => ({ items: window.fixture.sent }),
      contacts: async () => [], groups: async () => ({ ok: true, result: [group] }), accountInfo: async () => window.fixture.account, agentSurfaces: async () => ({}),
      sendReply: async (request) => { window.sends.push(request); return { ok: true }; } };
    window.relay = new Proxy(api, { get: (target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : async () => ({ ok: true }) });
  });
  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.locator('#relaysList .relay-row[data-party="Granular"]').first().click();
  await page.locator("#thQrInput").waitFor();
  await page.waitForFunction(() => activeView === "threads");
  const visible = await page.evaluate(() => [...document.querySelectorAll("#thRows [data-msg]")].map((el) => el.getAttribute("data-msg")));
  assert.ok(!visible.includes("relay_outline") && !visible.includes("relay_mine"), "thread replies fold under their Relay");
  assert.equal(visible.at(-1), "relay_done", "Shane's direct completion is the newest row in the room");

  // The case that misrouted: the newest visible row with an address is a
  // member's direct completion.
  await page.locator("#thQrInput").fill("not sure you are notified about thread messages");
  await page.locator("#thQrInput").press("Enter");
  await page.waitForFunction(() => window.sends.length === 1);
  const [send] = await page.evaluate(() => window.sends);
  assert.deepEqual(send.recipient, { groupId: "grp_granular" }, "a message typed in a group room goes to the group");
  assert.equal(send.inReplyToRelayId, undefined, "a room message answers nothing");
  assert.equal(send.chat.isGroup, true);
  assert.equal(send.chat.groupId, "grp_granular");
  assert.match(send.chat.partyKey, /^group:/, "the queued bubble belongs to the group room");
  // The bubble shows in the room it was typed in.
  await page.locator("#thRows .th-msg, #thRows [data-msg]").filter({ hasText: "not sure you are notified" }).first().waitFor();

  // The banner's quick reply reads the same address, whichever row it holds.
  const bannerRecipient = await page.evaluate(() => bannerReplyRecipient(
    { isGroup: true, groupId: "grp_granular", name: "Granular", msgs: [] },
    { id: "relay_done", addressRecipient: { email: "shane@example.com" } },
  ));
  assert.deepEqual(bannerRecipient, { groupId: "grp_granular" }, "the banner answers the group, not one member");

  // The room's info sheet belongs to the room: leaving it closes the sheet.
  await page.evaluate(() => openGroupInfo());
  await page.waitForFunction(() => !document.getElementById("groupInfoBackdrop").classList.contains("hidden"));
  await page.locator('.tab[data-view="contacts"]').click();
  await page.waitForFunction(() => activeView === "contacts");
  assert.equal(await page.evaluate(() => document.getElementById("groupInfoBackdrop").classList.contains("hidden")), true, "the sheet does not float over the list");

  assert.deepEqual(errors, []);
  console.log("group room address: ok");
} finally {
  await browser.close();
}
