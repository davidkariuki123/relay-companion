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

test("Slack is a first-class tab after Tasks with its own list and unread badge", () => {
  const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>", html.indexOf('<nav class="tabs"')));
  const relayAt = nav.indexOf('data-view="relays"');
  const slackAt = nav.indexOf('data-view="slack"');
  const tasksAt = nav.indexOf('data-view="tasks"');
  assert.ok(relayAt >= 0, "Relays tab is present");
  assert.ok(tasksAt > relayAt, "Tasks follows Relays in the existing tab rail");
  assert.ok(slackAt > tasksAt, "Slack follows Tasks");
  assert.match(nav, /data-view="slack"[^>]*>[\s\S]*?Slack[\s\S]*?id="slackBadge"/);
  assert.match(html, /<section class="view hidden" id="slackView">[\s\S]*?id="slackList"[\s\S]*?<\/section>/);
});

test("an unconnected Slack tab becomes the onboarding-inspired connection page without signup escape copy", () => {
  const render = html.slice(html.indexOf("function renderSlack()"), html.indexOf("// ---- the split's rail", html.indexOf("function renderSlack()")));
  assert.match(render, /!slackConnectionReady\(slackConnectionInfo\)/);
  assert.match(render, /Slack integration/);
  assert.match(render, /Connect your Slack to Relay\./);
  assert.match(render, /Relay for \$\{esc\(teamName\)\}/);
  assert.match(render, /Your Slack/);
  assert.match(render, /id="slackTabConnect"/);
  assert.match(render, /Sync starts when you connect\. Relay does not import earlier Slack history\./);
  assert.doesNotMatch(render, /Not now|Skip for now|Continue without Slack|Last step|Finish setup/);

  const applyView = html.slice(html.indexOf("function applyView()"), html.indexOf('document.getElementById("chatExpandBtn")'));
  assert.match(applyView, /activeView === "slack" && payload\.features\?\.slack === true && viewChanged[\s\S]*refreshSlackConnection/,
    "opening Slack refreshes the authoritative connection state");
  assert.match(html, /\(activeView === "settings" \|\| activeView === "slack"\)[\s\S]*refreshSlackConnection/,
    "the Slack page stays live while browser OAuth completes");
});

test("Slack surfaces and transport are fail-closed outside the dev feature row", () => {
  assert.match(html, /view === "slack" && payload\.features\?\.slack !== true/,
    "the Slack tab is absent from customer builds");
  assert.match(html, /function slackSettingsHtml\(info\) \{\s*if \(payload\.features\?\.slack !== true\) return "";/,
    "Settings cannot paint a Slack card while the feature is off");
  assert.match(html, /async function refreshSlackConnection[\s\S]{0,140}payload\.features\?\.slack !== true\) return;/,
    "the hidden UI does not probe Slack status");
  assert.match(main, /async function refreshCanonicalChats\(\) \{\s*if \(PRODUCT_FEATURES\.slack !== true\)[\s\S]*?slackChatsCache = \[\]/,
    "the main process does not fetch Slack projections while disabled");
  for (const channel of ["relay:slackConnection", "relay:slackConnect", "relay:slackDisconnect"]) {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(start >= 0, `${channel} handler exists`);
    assert.match(main.slice(start, start + 450), /PRODUCT_FEATURES\.slack !== true/,
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
  assert.match(detailClient, /const relayPath = `\$\{managedBase\}\?surface=relay`/);
  assert.match(detailClient, /surface=slack&includeSlack=true/);
  assert.match(detailClient, /surface=relay&includeSlack=true/,
    "Slack enters Relays only through the explicit reveal path");

  const visibility = html.slice(html.indexOf("function conversationSurface("), html.indexOf("// Store one server generation"));
  assert.match(visibility, /return source === "slack" \? "slack" : "relay"/);
  assert.match(visibility, /conversationSurface\(source\) === "slack"/,
    "Slack defaults visible only on its own surface");
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

test("one native room-header control reveals Slack in compact and expanded modes", () => {
  const headerStart = html.indexOf('<div class="th-detail-head th-bar-sticky">');
  const header = html.slice(headerStart, html.indexOf("</div>", headerStart) + 6);
  assert.match(header, /id="thSlackVisibility"/);
  assert.match(header, /id="thSlackVisibilityLabel"/);
  assert.match(header, /aria-pressed=/);
  assert.equal((html.match(/id="thSlackVisibility"/g) || []).length, 1,
    "compact and expanded rooms share the native header instead of duplicating controls");

  const integrationGate = html.slice(html.indexOf("function isSlackIntegratedRoom("), html.indexOf("function slackVisibilityKey("));
  assert.match(integrationGate, /room\.integration\?\.provider === "slack"/,
    "the reveal control is offered only for an exactly linked room");
  const buttonState = html.slice(html.indexOf("function syncSlackVisibilityButton("), html.indexOf("// Store one server generation"));
  assert.match(buttonState, /Show(?:[^"`<\n]{0,24})? Slack/,
    "the native label can stay compact or include a hidden-message count");
  assert.match(buttonState, /Hide Slack/);
  const toggleAt = html.indexOf('thSlackVisibilityEl.addEventListener("click"');
  const toggle = html.slice(toggleAt, html.indexOf('document.getElementById("thExpand")', toggleAt));
  assert.match(toggle, /includeSlack:true/,
    "the native control changes detail projection rather than only hiding already-fetched DOM rows");
});

test("Relay and Slack badges and lists consume only their own surface projections", () => {
  assert.match(main, /slackChats\s*:/,
    "the payload keeps Slack summaries separate from Relay summaries");
  assert.match(html, /payload\.slackChats/);

  const relays = html.slice(html.indexOf("function relayIdentityRows()"), html.indexOf("function renderRelays()"));
  assert.doesNotMatch(relays, /payload\.slackChats/,
    "Slack-only rooms cannot enter the Relay identity list");

  const renderAll = html.slice(html.indexOf("function renderAll()"), html.indexOf("function onPayload"));
  assert.match(renderAll, /setBadge\(slackBadgeEl,/);
  assert.match(renderAll, /setBadge\(relaysBadgeEl,/);
  assert.doesNotMatch(renderAll, /setBadge\(relaysBadgeEl,[^\n]*slack/,
    "Slack unread never inflates the Relay tab badge");
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

test("canonical optimistic reads are surface-keyed and update only that surface's summary", () => {
  const read = html.slice(html.indexOf("function readVisibleChatRoom()"), html.indexOf("// Open a conversation INTO"));
  assert.match(read, /if \(\(isSlackIntegratedRoom\(visibleRoom\) \|\| resolvedDirectAnchor\) && visibleRoom\.chatId\)/,
    "visible canonical Relay and resolved direct rows share the canonical read path");
  assert.doesNotMatch(read, /isSlackIntegratedRoom\(visibleRoom\) && slackMessagesVisible/,
    "Slack visibility cannot gate reading Relay-origin canonical rows");
  assert.match(read, /const generationKey = `\$\{surface\}:\$\{chatId\}`/);
  assert.match(read, /canonicalReadGeneration\.get\(generationKey\)/);
  assert.match(read, /canonicalReadGeneration\.set\(generationKey, generation\)/);
  assert.doesNotMatch(read, /canonicalReadGeneration\.(?:get|set|delete)\(chatId\)/,
    "one surface cannot suppress another surface's read generation");
  assert.match(read, /const includeSlack = slackMessagesVisible\(visibleRoom\)/);
  assert.match(read, /const readOptions = \{ surface, includeSlack:slackMessagesVisible\(visibleRoom\) \}/);
  assert.match(read, /persistCanonicalChatRead\(chatId, \{ surface, includeSlack:true \}\)/);
  assert.match(read, /persistCanonicalChatRead\(chatId, readOptions\)/,
    "the read mutation records exactly what was visible");

  assert.match(read, /if \(surface === "slack"\)[\s\S]*?payload\.slackChats\s*=/);
  assert.match(read, /else[\s\S]*?payload\.chats\s*=/);
  const slackBranch = read.slice(read.indexOf('if (surface === "slack")'), read.indexOf("else", read.indexOf('if (surface === "slack")')));
  const relayBranch = read.slice(read.indexOf("else", read.indexOf('if (surface === "slack")')), read.indexOf("Promise.resolve", read.indexOf('if (surface === "slack")')));
  assert.doesNotMatch(slackBranch, /payload\.chats\s*=/,
    "Slack optimistic reads cannot consume the Relay list count");
  assert.doesNotMatch(relayBranch, /payload\.slackChats\s*=/,
    "Relay optimistic reads cannot consume the Slack list count");
});
