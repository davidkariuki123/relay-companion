import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

const html = source("../overlay/inbox.html");
const preload = source("../overlay/preload.cjs");
const main = source("../overlay/main.cjs");
const client = source("../src/client.js");

// Slack lives in Inbox › Chats (David, 2026-10-07). There is no Slack tab,
// list, badge or Show/Hide toggle: a chat that is also in Slack is one chat.
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function chatsRuntime(payload) {
  return new Function("payload", `
    const chatConversations = () => [];
    const contactChatAnchors = new Map();
    const groupsList = [];
    const canonicalChatDetails = new Map();
    const assignFallbackChatIds = () => {};
    const knownAddresses = () => new Set();
    const isRequestRoom = () => false;
    ${between(html, "function isSlackIntegratedRoom(room)", "\n  // The background service stages")}
    ${between(html, "function normalizedPartyName(", "function chatRoomForThread(")}
    ${between(html, "function slackChannelRoomListed(room)", "// Inbox has Chats")}
    return { chatSections, relayIdentityRows };
  `)(payload);
}

function slackChat(chatId, { type = "public_channel", state = "active", name = "", unreadCount = 0, last = null, messageCount = 0, threadIds = [] } = {}) {
  return {
    chatId,
    kind: type === "im" ? "direct" : "group",
    integration: { provider: "slack", type, state },
    channel: name ? { name } : null,
    participants: type === "im" ? [{ name: "Sven Wellmann" }, { name: "Me", self: true }] : [],
    threadIds,
    unreadCount,
    messageCount,
    updatedAt: "2026-10-07T09:00:00.000Z",
    lastMessage: last,
  };
}

test("there is no Slack tab: the nav, view, list, badge and renderer are gone", () => {
  const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>", html.indexOf('<nav class="tabs"')));
  assert.match(nav, /data-view="relays"/, "Inbox is present");
  assert.doesNotMatch(nav, /data-view="slack"|id="slackBadge"/);
  assert.doesNotMatch(html, /id="slackView"|id="slackList"|id="slackEmpty"|id="slackBadge"/);
  assert.doesNotMatch(html, /function renderSlack\(|slackListScrollTop|slackViewEl|slackBadgeEl|activeView === "slack"/);
  // One list of chats: no separate Slack branch inside chatSections.
  const sections = between(html, "function chatSections()", "function chatRoomForThread(");
  assert.doesNotMatch(sections, /surface === "slack"/);
  assert.match(sections, /const slackSummaries = payload\.features\?\.slack === true \? \(payload\.slackChats \|\| \[\]\) : \[\];/);
  assert.match(sections, /for \(const chat of \[\.\.\.\(payload\.chats \|\| \[\]\), \.\.\.slackSummaries\]\)/);
});

test("Relay and Slack summaries of one chat merge into one room in Chats, by chat id", () => {
  const relayLast = { relayId: "relay_1", createdAt: "2026-10-07T10:00:00.000Z", direction: "inbound", preview: "From the pill", senderName: "Sven" };
  const slackLast = { relayId: "relay_2", createdAt: "2026-10-07T10:05:00.000Z", direction: "inbound", preview: "From Slack", senderName: "Shane" };
  const payload = {
    features: { slack: true },
    chats: [slackChat("chat_product", { name: "product", unreadCount: 1, last: relayLast, threadIds: ["t_product"], messageCount: 2 })],
    slackChats: [
      slackChat("chat_product", { name: "product", unreadCount: 3, last: slackLast, threadIds: ["t_product"], messageCount: 5 }),
      slackChat("chat_design", { name: "design" }),
      slackChat("chat_old", { name: "old", state: "archived" }),
      slackChat("chat_dm", { type: "im" }),
      slackChat("chat_dm_live", { type: "im", unreadCount: 1, last: { ...slackLast, relayId: "relay_3" } }),
    ],
  };
  const runtime = chatsRuntime(payload);
  const { rooms } = runtime.chatSections();
  const product = rooms.filter((room) => room.chatId === "chat_product");
  assert.equal(product.length, 1, "one chat, one room, wherever its messages were typed");
  assert.equal(product[0].name, "#product", "a Slack channel reads the way Slack writes it");
  assert.equal(product[0].unreadCount, 3, "the merged room carries the larger unread count");
  assert.equal(product[0].latest.id, "relay_2", "the newest message from either side leads");
  assert.equal(product[0].messageCount, 5, "freshness keys follow the Slack projection the room opens on");

  const listed = runtime.relayIdentityRows().map((room) => room.chatId);
  assert.ok(listed.includes("chat_product"));
  assert.ok(listed.includes("chat_design"), "a Slack channel you are in is listed before anyone writes in it");
  assert.ok(listed.includes("chat_dm_live"), "a Slack DM joins once it has a message");
  assert.ok(!listed.includes("chat_dm"), "a quiet Slack DM stays out");
  assert.ok(!listed.includes("chat_old"), "an archived channel stays out");

  const off = chatsRuntime({ ...payload, features: { slack: false } });
  const offListed = off.relayIdentityRows().map((room) => room.chatId);
  assert.ok(!offListed.includes("chat_design") && !offListed.includes("chat_dm_live"),
    "Slack-only chats never reach an account without the Slack feature");
  assert.equal(off.chatSections().rooms.find((room) => room.chatId === "chat_product")?.unreadCount, 1,
    "with Slack off, Slack's summary contributes nothing");
});

test("a Slack-linked row wears the Slack mark on its avatar, and a channel wears its #", () => {
  const row = between(html, "function relayIdentityRowHtml(", "// ---------- the reader");
  assert.match(row, /const slackRoom = payload\.features\?\.slack === true && isSlackIntegratedRoom\(identity\);/);
  assert.match(row, /<span class="avatar sq channel-hash"[^`]*>#<\/span>/);
  assert.match(row, /`<span class="av-slack">\$\{baseAvatar\}<img class="av-slack-mark" src="slackMark\.png" alt="Slack" \/><\/span>`/);
  assert.match(html, /\.av-slack-mark \{[^}]*position:absolute;/);
  assert.match(html, /\.avatar\.channel-hash \{/);
  // A quiet channel has no sender or time to show.
  assert.match(row, /const senderPrefix = quietRoom \? "" :/);
});

test("Connect is one row at the top of Chats in plain words, with no signup escape copy", () => {
  const nudge = between(html, "function slackNudgeState()", "function renderSetupNudge()");
  assert.match(nudge, /: slackConnectionInfo\?\.team\?\.connected \? "Sync your messages with Slack"\s*: "Bring your Slack chats here";/,
    "a teammate already seated in Slack groups is asked to sync, a newcomer to bring their chats");
  assert.match(nudge, /: "Connect";/);
  assert.match(nudge, /state === "waiting" \|\| state === "opening" \? "Click Allow in your browser"/);
  assert.match(nudge, /state === "waiting" \? "Open again"/);
  assert.match(nudge, /state === "connected" \? "Slack is connected"/);
  assert.match(nudge, /state === "paused" \? "Reconnect your Slack"/);
  assert.doesNotMatch(nudge, /Skip for now|Continue without Slack|Last step|Finish setup/);
  assert.doesNotMatch(html, /Connect your Slack to Relay\.|Relay does not import earlier Slack history/);

  const applyView = html.slice(html.indexOf("function applyView()"), html.indexOf('document.getElementById("chatExpandBtn")'));
  assert.match(applyView, /activeView === "relays" && payload\.features\?\.slack === true && viewChanged && !slackConnectionLoaded[\s\S]*refreshSlackConnection/,
    "opening Inbox checks the authoritative connection state until it is known");
  assert.match(html, /\(activeView === "settings" \|\| \(\(activeView === "relays" \|\| activeView === "threads"\) && slackConnectionWaiting\)\)[\s\S]*refreshSlackConnection/,
    "the row stays live only while browser OAuth is pending");
});

test("Slack surfaces and transport are fail-closed outside the dev feature row", () => {
  assert.doesNotMatch(html, /data-view="slack"/, "no build has a Slack tab");
  assert.match(html, /function slackNudgeState\(\) \{\s*if \(payload\.features\?\.slack !== true \|\| !window\.relay\.slackConnect\) return "";/,
    "the Chats row cannot paint while the feature is off");
  assert.match(html, /function slackMessagesVisible\(room\) \{\s*return payload\.features\?\.slack === true && isSlackIntegratedRoom\(room\);/);
  assert.match(html, /function slackChannelRoomListed\(room\) \{\s*if \(payload\.features\?\.slack !== true \|\| !isSlackIntegratedRoom\(room\)\) return false;/);
  assert.match(html, /const slackUnread = payload\.features\?\.slack === true \? \(payload\.slackChats \|\| \[\]\)\.reduce\(/,
    "Slack unread never counts for an account without the feature");
  assert.match(html, /function slackSettingsHtml\(info\) \{\s*if \(payload\.features\?\.slack !== true\) return "";/,
    "Settings cannot paint a Slack card while the feature is off");
  assert.match(html, /async function refreshSlackConnection[\s\S]{0,140}payload\.features\?\.slack !== true\) return;/,
    "the hidden UI does not probe Slack status");
  assert.match(main, /async function refreshCanonicalChats\(\) \{\s*if \(currentProductFeatures\(\)\.slack !== true\)[\s\S]*?slackChatsCache = \[\]/,
    "the main process does not fetch Slack projections while disabled");
  for (const channel of ["relay:slackConnection", "relay:slackConnect", "relay:slackDisconnect"]) {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(start >= 0, `${channel} handler exists`);
    assert.match(main.slice(start, start + 450), /currentProductFeatures\(\)\.slack !== true/,
      `${channel} checks the product feature before transport`);
  }
});

test("Slack surfaces use exact integration metadata so DMs are not lost or name-matched", () => {
  const integrationChecks = [html, main].filter((text) => /integration/.test(text)).join("\n");
  assert.match(integrationChecks, /integration\?*\.provider\s*===\s*"slack"|integration\?\.provider\s*===\s*"slack"/);
  assert.doesNotMatch(main, /\.filter\(\(chat\) => chat && chat\.channel && chat\.channel\.slack\)/,
    "a channel-only filter silently drops Slack IMs");
  assert.doesNotMatch(integrationChecks, /title\s*===|participants[^\n]*integration/,
    "a provider link is never inferred from a title or participant roster");
});

test("the Companion requests Relay-hidden and Slack-visible projections explicitly", () => {
  const listClient = client.slice(client.indexOf("async chats("), client.indexOf("async chat(", client.indexOf("async chats(")));
  const detailClient = client.slice(client.indexOf("async chat("), client.indexOf("sendChatMessage(", client.indexOf("async chat(")));
  assert.match(listClient, /\/v1\/chats\?surface=relay/,
    "Relay list requests never rely on a server default that can drift");
  assert.match(listClient, /\/v1\/chats\?surface=slack/,
    "Slack has its own linked-conversation projection");
  assert.match(detailClient, /const relayPath = `\$\{managedBase\}\?surface=relay\$\{suffix\}`/);
  assert.match(detailClient, /surface=slack&includeSlack=true/);
  assert.match(detailClient, /surface=relay&includeSlack=true/,
    "Slack enters Relays only through the explicit reveal path");

  const visibility = html.slice(html.indexOf("function conversationSurface("), html.indexOf("// Store one server generation"));
  assert.match(visibility, /return source === "slack" \? "slack" : "relay"/);
  assert.doesNotMatch(visibility, /slackVisibilityOverrides|slackVisibilityKey/, "visibility is not a per-room toggle any more");

  // A Slack-integrated room opened from any list reads Slack's projection of
  // itself (every message, Slack's read cursor); Back still returns to that list.
  const open = between(html, "function openThreadDetail(", "// ---------- Settings view");
  assert.match(open, /const roomFromList = isConversationRoomSource\(source\) \? chatRoomForThread\(threadId, "relay"\) : null;/);
  assert.match(open, /if \(isConversationRoomSource\(source\) && payload\.features\?\.slack === true && isSlackIntegratedRoom\(roomFromList\)\) \{\s*source = "slack";\s*\}/);
  assert.ok(open.indexOf('const returnSource = source === "slack" ? "relays" : source;') >= 0
    && open.indexOf('const returnSource = source === "slack" ? "relays" : source;') < open.indexOf('source = "slack";'),
    "the list a room came from is remembered before the projection switches");
  assert.match(open, /threadsReturnSource = returnSource;/);
});

test("chat reads remain surface-qualified across renderer, preload, main, and client", () => {
  assert.match(preload, /canonicalChatRead:\s*\(chatId,\s*options/);
  assert.match(preload, /invoke\("relay:canonicalChatRead",[\s\S]{0,140}\{[\s\S]{0,80}surface/);
  assert.match(main, /ipcMain\.handle\("relay:canonicalChatRead",\s*async\s*\(event,\s*input\)/);
  const mainRead = main.slice(
    main.indexOf('ipcMain.handle("relay:canonicalChatRead"'),
    main.indexOf('ipcMain.handle("relay:openChatWith"'),
  );
  assert.match(mainRead, /markChatRead\([\s\S]{0,220}?surface[\s\S]{0,80}?includeSlack/);
  const markRead = client.slice(client.indexOf("markChatRead("), client.indexOf("/** The chat around", client.indexOf("markChatRead(")));
  assert.match(markRead, /surface/);
  assert.match(markRead, /this\.#req\("POST",[\s\S]*?\{[\s\S]*?surface/);
});

test("a Slack-linked room shows every message and says so once, with the Slack mark beside its name", () => {
  assert.doesNotMatch(html, /id="thSlackVisibility"|thSlackVisibilityLabel|Show Slack|Hide Slack|slackVisibilityOverrides|slackVisibilityKey/,
    "there is nothing to show, hide or switch");
  const integrationGate = between(html, "function isSlackIntegratedRoom(", "\n  // The background service stages");
  assert.match(integrationGate, /room\.integration\?\.provider === "slack"/,
    "the mark is worn only by an exactly linked room");
  const header = between(html, "function syncSlackVisibilityButton(", "// Store one server generation");
  assert.match(header, /thDetailNameEl\.classList\.toggle\("slack", linked\);/);
  assert.match(header, /thDetailNameEl\.title = linked \? "Also in Slack" : "";/);
  assert.match(html, /\.th-detail-name\.slack::after \{[^}]*url\("slackMark\.png"\)/);
  // The composer names its destination the way Slack does.
  assert.match(html, /function slackComposerPlaceholder\(room\) \{\s*if \(payload\.features\?\.slack !== true \|\| !isSlackIntegratedRoom\(room\)\) return "";/);
  // Slack's own words: "Message #code" in a channel, "Message Sven" in a DM.
  assert.match(html, /\? `Message \$\{slackChannelLabel\(room\)\}` : `Message \$\{name\.split\(\/\\s\+\/\)\[0\]\}`;/);
  assert.match(html, /slackComposerPlaceholder\(chatRoom\) \|\| "Reply…"/);
  // A channel nobody has written in since it connected is quiet, not broken.
  assert.match(html, /"Nothing here yet\. It syncs with Slack\."/);
});

test("Inbox counts Relay and Slack unread in one number", () => {
  assert.match(main, /slackChats\s*:/,
    "the payload still carries Slack summaries beside Relay summaries");
  const renderAll = between(html, "function renderAll()", "function onPayload");
  assert.match(renderAll, /const slackUnread = payload\.features\?\.slack === true \? \(payload\.slackChats \|\| \[\]\)\.reduce\(\s*\(sum, chat\) => sum \+ Math\.max\(0, Number\(chat\?\.unreadCount \|\| 0\)\), 0\) : 0;/);
  assert.match(renderAll, /const unread = relayUnreadIds\.size \+ slackUnread;/);
  assert.match(renderAll, /setBadge\(relaysBadgeEl, unread\);/);
  assert.doesNotMatch(renderAll, /slackBadgeEl/);

  const rows = between(html, "function relayIdentityRows()", "function renderRelays()");
  assert.match(rows, /\(room\.hasActivity !== false \|\| slackChannelRoomListed\(room\)\) && !isRequestRoom\(room, known\)/,
    "Slack channels you are in join the same list; requests still wait in Requests");
});

test("an exact-linked Relay room paints first, then hydrates and polls its canonical body", () => {
  const poll = html.slice(
    html.indexOf("async function refreshActiveCanonicalChat("),
    html.indexOf("let signupStage", html.indexOf("async function refreshActiveCanonicalChat(")),
  );
  assert.match(poll, /const includeSlack = slackMessagesVisible\(room\)/);
  assert.match(poll, /requestCanonicalChatDetail\(room, surface, \{ includeSlack \}\)/);
  assert.doesNotMatch(poll, /!includeSlack/,
    "Relay summaries have no bodies; hidden Slack must not prevent the Relay-origin detail poll");

  const open = html.slice(html.indexOf("function openRoom("), html.indexOf("function renderChat("));
  assert.match(open, /const roomCoordinate = isSlackIntegratedRoom\(selected\) && selected\.chatId[\s\S]*String\(selected\.chatId\)/,
    "a linked room enters by immutable chat id rather than a message or root id");
  assert.doesNotMatch(open, /await requestCanonicalChatDetail|requestCanonicalChatDetail\(/,
    "room entry is never network-gated before its destination snapshot");

  const openThread = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  assert.match(openThread, /commitNavigation\(\{ outerScrollTop: 0 \}\);[\s\S]*requestCanonicalChatDetail\(room, source, \{ includeSlack \}\)/,
    "canonical hydration starts only after the local destination has painted");
});

test("Slack rows navigate by chat id and can recover without a list-summary lookup", () => {
  const row = html.slice(html.indexOf("function relayIdentityRowHtml("), html.indexOf("// ---------- the reader"));
  assert.match(row, /const roomCoordinate = identity\.chatId \|\| identity\.threadId \|\| row\.threadId \|\| row\.id/);
  assert.match(row, /data-thread="\$\{esc\(roomCoordinate\)\}"/,
    "the newest Slack reply id is presentation data, never the room address");

  const lookup = html.slice(html.indexOf("function chatRoomForThread("), html.indexOf("// Messages that arrive"));
  assert.match(lookup, /canonicalChatDetails\.get\(String\(threadId \|\| ""\)\)/);
  assert.match(lookup, /roomFromChatSummary\(cached\)/,
    "cached canonical detail keeps an active chat-id room addressable if its list summary is replaced");

  assert.match(html, /let threadDetailChatId = ""/);
  assert.match(html, /function recoverActiveSlackRoom\(/);
  assert.match(html, /requestCanonicalChatDetail\(room, "slack", \{ includeSlack:true \}\)/);
  assert.match(html, /id="thConversationRetry"/,
    "a failed active-room recovery ends in an explicit retry instead of the Relay Sent loader");
});

test("Slack detail hydration is versioned, shared, and skipped for a current cache", () => {
  const cache = html.slice(
    html.indexOf("function canonicalChatHydrationKey("),
    html.indexOf("function syncSlackVisibilityButton(", html.indexOf("function canonicalChatHydrationKey(")),
  );
  assert.match(html, /const canonicalChatHydrations = new Map\(\)/);
  assert.match(html, /const canonicalChatDetailProjectionKeys = new Map\(\)/);
  assert.match(html, /const canonicalChatLatestStartedGeneration = new Map\(\)/);
  assert.match(html, /const canonicalChatLatestAppliedGeneration = new Map\(\)/);
  assert.match(cache, /canonicalChatHydrations\.get\(key\)/);
  assert.match(cache, /canonicalChatHydrations\.set\(key, request\)/);
  assert.match(cache, /canonicalChatLatestStartedGeneration\.set\(chatId, generation\)/);
  assert.match(cache, /generation < Number\(canonicalChatLatestStartedGeneration\.get\(id\) \|\| 0\)/);
  assert.match(cache, /canonicalChatLatestAppliedGeneration\.set\(id, generation\)/);
  assert.match(cache, /\.finally\(\(\) => canonicalChatHydrations\.delete\(key\)\)/);
  assert.match(cache, /detail\.updatedAt[\s\S]*room\.summaryUpdatedAt/);
  assert.match(cache, /detail\.messageCount[\s\S]*room\.messageCount/);
  assert.match(cache, /detail\.lastMessage\?\.relayId[\s\S]*room\.summaryLastMessageId/);
  assert.match(cache, /`\$\{conversationSurface\(source\)\}:\$\{String\(room\.chatId\)\}:\$\{includeSlack \? "with-slack" : "relay-only"\}`/,
    "Relay-hidden and Slack-visible transcripts do not share an invalid cache key");

  const openThread = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  assert.match(openThread, /!options\.hydrated[\s\S]*!canonicalChatDetailIsCurrent\(room, source, \{ includeSlack \}\)/,
    "a current selected-room transcript opens without another lazy hydration");
});

test("a newer Slack-visible transcript cannot be overwritten by an older Relay-only response", async () => {
  const requestSource = html.slice(
    html.indexOf("function requestCanonicalChatDetail("),
    html.indexOf("function reconcileCanonicalChatResult(", html.indexOf("function requestCanonicalChatDetail(")),
  );
  const pending = [];
  const runtime = new Function("window", `
    const canonicalChatHydrations = new Map();
    const canonicalChatLatestStartedGeneration = new Map();
    const canonicalChatLatestAppliedGeneration = new Map();
    let canonicalChatRequestGeneration = 0;
    let threadsSource = "relay";
    function conversationSurface(source = threadsSource) { return source === "slack" ? "slack" : "relay"; }
    function slackMessagesVisible() { return false; }
    function canonicalChatHydrationKey(room, source = threadsSource, includeSlack = false) {
      return \`${"${conversationSurface(source)}:${String(room.chatId)}:${includeSlack ? \"with-slack\" : \"relay-only\"}"}\`;
    }
    ${requestSource}
    return { requestCanonicalChatDetail, canonicalChatResultIsCurrent };
  `)({ relay:{ canonicalChat:(chatId, options) => new Promise((resolve) => pending.push({ chatId, options, resolve })) } });

  const room = { chatId:"chat_race" };
  const relayOnly = runtime.requestCanonicalChatDetail(room, "relay", { includeSlack:false });
  const sharedRelayOnly = runtime.requestCanonicalChatDetail(room, "relay", { includeSlack:false });
  assert.equal(sharedRelayOnly, relayOnly, "identical projections share one in-flight request and generation");
  const withSlack = runtime.requestCanonicalChatDetail(room, "relay", { includeSlack:true });
  assert.equal(pending.length, 2, "different projections may run concurrently");

  pending[1].resolve({ ok:true, chat:{ chatId:room.chatId, items:[{ relayId:"new-with-slack" }] } });
  const newest = await withSlack;
  let stored = null;
  if (runtime.canonicalChatResultIsCurrent(newest, room.chatId)) stored = newest.chat;

  pending[0].resolve({ ok:true, chat:{ chatId:room.chatId, items:[{ relayId:"old-relay-only" }] } });
  const older = await relayOnly;
  if (runtime.canonicalChatResultIsCurrent(older, room.chatId)) stored = older.chat;

  assert.equal(stored?.items?.[0]?.relayId, "new-with-slack");
  assert.equal(runtime.canonicalChatResultIsCurrent(older, room.chatId), false,
    "the late older projection remains stale for every consumer of its shared promise");

  const reverseRoom = { chatId:"chat_reverse" };
  const reverseRelayOnly = runtime.requestCanonicalChatDetail(reverseRoom, "relay", { includeSlack:false });
  const reverseWithSlack = runtime.requestCanonicalChatDetail(reverseRoom, "relay", { includeSlack:true });
  pending[2].resolve({ ok:true, chat:{ chatId:reverseRoom.chatId, items:[{ relayId:"early-relay-only" }] } });
  const earlyOlder = await reverseRelayOnly;
  assert.equal(runtime.canonicalChatResultIsCurrent(earlyOlder, reverseRoom.chatId), false,
    "an older projection is stale even when it completes before the newer request");
  pending[3].resolve({ ok:true, chat:{ chatId:reverseRoom.chatId, items:[{ relayId:"later-with-slack" }] } });
  const laterNewest = await reverseWithSlack;
  assert.equal(runtime.canonicalChatResultIsCurrent(laterNewest, reverseRoom.chatId), true);
});

test("canonical responses match the still-visible room, surface, and Slack projection before side effects", () => {
  const source = html.slice(
    html.indexOf("function canonicalChatResultMatchesVisibleProjection("),
    html.indexOf("function reconcileCanonicalChatResult(", html.indexOf("function canonicalChatResultMatchesVisibleProjection(")),
  );
  const state = {
    activeView:"threads",
    surface:"relay",
    threadDetailId:"thread-a",
    includeSlack:true,
    room:{ chatId:"chat-a" },
  };
  const matches = new Function("state", `
    let activeView = state.activeView;
    let threadDetailId = state.threadDetailId;
    function conversationSurface() { return state.surface; }
    function chatRoomForThread(threadId) { return threadId === state.threadDetailId ? state.room : null; }
    function slackMessagesVisible() { return state.includeSlack; }
    ${source}
    return canonicalChatResultMatchesVisibleProjection;
  `)(state);
  const result = {
    ok:true,
    chat:{ chatId:"chat-a" },
    canonicalRequest:{ chatId:"chat-a", surface:"relay", includeSlack:true },
  };
  assert.equal(matches(result, { chatId:"chat-a", surface:"relay" }), true);
  state.includeSlack = false;
  assert.equal(matches(result, { chatId:"chat-a", surface:"relay" }), false,
    "hiding Slack invalidates an in-flight with-Slack response");
  state.includeSlack = true;
  state.room = { chatId:"chat-b" };
  assert.equal(matches(result, { chatId:"chat-a", surface:"relay" }), false,
    "switching rooms invalidates the old room response");
  state.room = { chatId:"chat-a" };
  state.surface = "slack";
  assert.equal(matches(result, { chatId:"chat-a", surface:"relay" }), false,
    "switching surfaces invalidates the old surface response");
});

test("a read of a Slack-linked room is a whole read: one call, both summaries quiet, local rows acked", () => {
  const read = between(html, "function readVisibleChatRoom()", "// Open a conversation INTO");
  assert.match(read, /if \(\(isSlackIntegratedRoom\(visibleRoom\) \|\| resolvedDirectAnchor \|\| serverTranscriptRoom\(visibleRoom\)\) && visibleRoom\.chatId\)/,
    "visible canonical Relay, resolved direct and server-read Relay rows share the canonical read path");
  assert.match(read, /const generationKey = `\$\{surface\}:\$\{chatId\}`/);
  assert.doesNotMatch(read, /canonicalReadGeneration\.(?:get|set|delete)\(chatId\)/,
    "one surface cannot suppress another surface's read generation");
  assert.doesNotMatch(read, /if \(surface === "slack"\) return;/,
    "a Slack-linked room's local Relay rows are read too");

  const persisted = [];
  const acked = [];
  const visibleRoom = { chatId: "chat_product", integration: { provider: "slack", type: "public_channel" } };
  const payload = {
    features: { slack: true },
    relays: [{ id: "relay_local", unread: true }],
    chats: [{ chatId: "chat_product", unreadCount: 1 }, { chatId: "chat_other", unreadCount: 2 }],
    slackChats: [{ chatId: "chat_product", unreadCount: 3 }, { chatId: "chat_other", unreadCount: 4 }],
  };
  const canonicalChatDetails = new Map([["chat_product", { chatId: "chat_product", items: [
    { relayId: "relay_local", direction: "inbound", state: "delivered" },
    { relayId: "relay_slack", direction: "inbound", state: "delivered", origin: "slack" },
  ] }]]);
  const runtime = new Function("payload", "canonicalChatDetails", "visibleRoom", "persisted", "acked", `
    const threadsSource = "slack";
    const threadDetailId = "chat_product";
    const canonicalReadGeneration = new Map();
    const canonicalReadFailures = new Map();
    const canonicalChatDetailProjectionKeys = new Map();
    const canonicalChatFingerprints = new Map();
    const visibleRoomAckIds = new Set();
    const canonicalChatFingerprint = () => "";
    const chatRoomForThread = () => visibleRoom;
    const directContactAnchorForChatId = () => null;
    const serverTranscriptRoom = () => false;
    const refreshActiveCanonicalChat = () => {};
    const persistCanonicalChatRead = (chatId, options) => { persisted.push({ chatId, options }); return Promise.resolve({ ok: true }); };
    const visibleChatRoomMessages = () => [{ id: "relay_local", direction: "in", unread: true }];
    const persistReadIds = (ids) => { if (ids.length) acked.push(...ids); };
    ${between(html, "function conversationSurface(", "\n  // The background service stages")}
    ${between(html, "function slackMessagesVisible(room)", "function canonicalChatHydrationKey(")}
    ${between(html, "function readVisibleChatRoom()", "// Open a conversation INTO")}
    return readVisibleChatRoom;
  `)(payload, canonicalChatDetails, visibleRoom, persisted, acked);
  runtime();
  assert.deepEqual(persisted, [{ chatId: "chat_product", options: { surface: "slack", includeSlack: true } }],
    "one call; the server moves Relay's and Slack's cursors together");
  assert.equal(payload.chats.find((chat) => chat.chatId === "chat_product").unreadCount, 0);
  assert.equal(payload.slackChats.find((chat) => chat.chatId === "chat_product").unreadCount, 0);
  assert.equal(payload.chats.find((chat) => chat.chatId === "chat_other").unreadCount, 2, "other chats keep their counts");
  assert.equal(payload.slackChats.find((chat) => chat.chatId === "chat_other").unreadCount, 4);
  assert.ok(canonicalChatDetails.get("chat_product").items.every((item) => item.state === "read"),
    "every visible message, wherever it was typed, paints read");
  assert.deepEqual(acked, ["relay_local"], "the local Relay row is acknowledged too");
  assert.equal(payload.relays[0].unread, false);

  runtime();
  assert.equal(persisted.length, 1, "the same read generation is not posted twice");
});

test("an empty Slack DM never replaces the real last message of the chat it joins", () => {
  assert.match(html, /if \(projected\.hasActivity && new Date\(projected\.latest\.at \|\| 0\) > new Date\(existing\.latest\.at \|\| 0\)\) \{/);
});

test("a Slack channel keeps its #name when the saved groups pass reaches its room", () => {
  assert.match(html, /const slackChannelRoom = isSlackIntegratedRoom\(existing\) && \/channel\$\/\.test\(existing\.integration\?\.type \|\| ""\);/);
  assert.match(html, /existing\.name = slackChannelRoom \? existing\.name : group\.name \|\| existing\.name;/);
  // and a Slack channel's group row finds its room by chat id instead of seeding an empty twin
  assert.match(html, /\.find\(\(room\) => room\.chatId && String\(room\.chatId\) === String\(group\.id\)\)/);
});
