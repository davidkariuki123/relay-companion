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

test("Slack is a first-class tab beside Relays with its own list and unread badge", () => {
  const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>", html.indexOf('<nav class="tabs"')));
  const relayAt = nav.indexOf('data-view="relays"');
  const slackAt = nav.indexOf('data-view="slack"');
  const tasksAt = nav.indexOf('data-view="tasks"');
  assert.ok(relayAt >= 0, "Relays tab is present");
  assert.ok(slackAt > relayAt, "Slack follows Relays in the existing tab rail");
  assert.ok(tasksAt < 0 || slackAt < tasksAt, "Slack precedes the optional Tasks tab");
  assert.match(nav, /data-view="slack"[^>]*>[\s\S]*?Slack[\s\S]*?id="slackBadge"/);
  assert.match(html, /<section class="view hidden" id="slackView">[\s\S]*?id="slackList"[\s\S]*?<\/section>/);
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

test("an exact-linked Relay room hydrates and polls its canonical Relay body while Slack stays hidden", () => {
  const poll = html.slice(
    html.indexOf("async function refreshActiveCanonicalChat()"),
    html.indexOf("let signupStage", html.indexOf("async function refreshActiveCanonicalChat()")),
  );
  assert.match(poll, /const includeSlack = slackMessagesVisible\(room\)/);
  assert.match(poll, /window\.relay\.canonicalChat\(room\.chatId, \{[\s\S]*?surface: conversationSurface\(\),[\s\S]*?includeSlack/);
  assert.doesNotMatch(poll, /!includeSlack/,
    "Relay summaries have no bodies; hidden Slack must not prevent the Relay-origin detail poll");

  const open = html.slice(html.indexOf("async function openRoom("), html.indexOf("function renderSlack("));
  assert.match(open, /if \(isSlackIntegratedRoom\(selected\) && selected\.chatId && !options\.hydrated\)/,
    "opening a linked Relay room hydrates detail even when its includeSlack flag is false");
  assert.match(open, /canonicalChat\?\.\(selected\.chatId, \{ surface, includeSlack \}\)/);
});

test("canonical optimistic reads are surface-keyed and update only that surface's summary", () => {
  const read = html.slice(html.indexOf("function readVisibleChatRoom()"), html.indexOf("// Open a conversation INTO"));
  assert.match(read, /if \(isSlackIntegratedRoom\(visibleRoom\) && visibleRoom\.chatId\)/,
    "visible canonical Relay rows are read even though Slack-origin rows remain hidden");
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
