// People/group chat rendering in the pill. Reply-chain ids remain internal;
// there is no visible or agent-authored thread/topic naming ontology.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const notifications = fs.readFileSync(new URL("../src/notifications.js", import.meta.url), "utf8");
const mcp = fs.readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8");

test("chat text bubbles preserve authored line breaks", () => {
  const rule = html.match(/\.th-msg\.text \.th-msg-title \{([^}]+)\}/)?.[1] || "";
  assert.match(rule, /white-space:pre-wrap/);

  assert.match(html, /<span class="th-msg-title">[^\n]*textLike \? linkify\(m\.title\)/);
});

test("legacy threadTitle stays readable in storage but never reaches the visible pill", () => {
  // Old packets remain readable during rolling upgrades.
  assert.match(notifications, /threadTitle: item\.threadTitle \|\| packet\?\.threadTitle \|\| null/);
  assert.match(notifications, /threadTitle: item\.threadTitle \|\| existing\.threadTitle \|\| null/);
  assert.doesNotMatch(main, /threadTitle: p\.threadTitle/);
  assert.doesNotMatch(html, /\.threadTitle/);
});

test("stable people and group identity survive into Chat rooms", () => {
  assert.match(notifications, /groupSendId: item\.groupSendId \|\| packet\?\.groupSendId \|\| null/);
  assert.match(notifications, /recipientGroupName: item\.recipientGroupName \|\| packet\?\.recipientGroupName \|\| null/);
  assert.match(main, /senderEmail: p\.senderEmail \|\| ""/);
  assert.match(main, /groupSendId: p\.groupSendId \|\| null/);
  assert.match(html, /partyKey: r\.recipientGroupName/);
  assert.match(html, /t\.isGroup = t\.isGroup \|\| people\.length > 1/);
  assert.match(html, /const key = stablePartyKey\(t\.partyKey\) \|\| legacyBridge \|\| t\.partyKey/);
});

test("an inbound group Relay stays in its exact group room", () => {
  const inbound = html.slice(html.indexOf("for (const r of payload.relays"), html.indexOf("const inboundIds"));
  assert.match(inbound, /isGroup: Boolean\(r\.recipientGroupName\)/);
  assert.match(inbound, /groupName: r\.recipientGroupName \|\| ""/);
  // Outbound group sends still carry their real group room identity.
  const outbound = html.slice(html.indexOf("for (const s of payload.sent"), html.indexOf("return msgs;"));
  assert.match(outbound, /isGroup: Boolean\(s\.groupSendId \|\| s\.recipientGroupName\)/);
  assert.match(html, /t\.isGroup = t\.isGroup \|\| people\.length > 1/);
});

test("legacy name-only rows join one unambiguous stable person room", () => {
  assert.match(html, /function sameDirectParty\(message, roomKey, roomName\)/);
  assert.match(html, /if \(stablePartyKey\(messageKey\) && stablePartyKey\(roomKey\)\) return false/);
  assert.match(html, /!stablePartyKey\(t\.partyKey\) && candidates && candidates\.size === 1/);
  assert.match(html, /filter\(\(m\) => sameDirectParty\(m, partyKey, party\)\)/);
  assert.match(html, /sameDirectParty\(m, roomKey, roomName\)/);
});

test("a conversation is named only by its person or saved group", () => {
  assert.match(html, /t\.name = t\.isGroup \? \(t\.groupName \|\| setLabel\) : t\.people\[0\]/);
  assert.match(html, /setThreadHeader\(roomName \|\| voices, ""\)/);
  assert.doesNotMatch(html, /explicitTitle|allTopics|topicsPanelOpen|Search topics|>Topics</);
  const chat = html.slice(html.indexOf("function renderChat()"), html.indexOf("function renderChatRail()"));
  assert.match(chat, /const \{ rooms \} = chatSections\(\)/);
  assert.match(chat, /rooms\.map\(row\)\.join\(""\)/);
  assert.doesNotMatch(chat, />Groups<|>People<|section\("Groups"|section\("People"/);
  assert.doesNotMatch(chat, />See all</);
});

test("known @handles render as highlighted contact names without changing unknown text", () => {
  const start = html.indexOf("function mentionContact(");
  const end = html.indexOf("\n  function relaySender(", start);
  assert.notEqual(start, -1, "missing mention renderer");
  assert.notEqual(end, -1, "missing mention renderer boundary");
  const source = html.slice(start, end);
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const linkify = Function(
    "contactsList",
    "esc",
    `"use strict"; ${source}; return linkify;`,
  )([{ handle:"shane_acton", name:"Shane Acton" }], escapeHtml);

  assert.equal(
    linkify("@Shane_Acton what's the word?"),
    '<span class="th-mention" aria-label="Mentioned Shane Acton">@Shane Acton</span> what&#039;s the word?',
  );
  assert.equal(linkify("Ask @not_saved"), "Ask @not_saved", "unknown handles stay honest");
  assert.equal(linkify("mail shane@shane_acton.dev"), "mail shane@shane_acton.dev", "email domains are not mentions");
  assert.match(linkify("https://example.com/@shane_acton"), /^<a href=/, "a URL remains one link token");
  assert.match(html, /\.th-msg\.text \.th-mention \{[\s\S]*?border:1px solid[\s\S]*?background:/);
  assert.match(html, /else if \(activeView === "threads"\) renderThreads\(\)/, "an open room repaints after contact names load");
});

test("direct and group conversations share one newest-first chronology", () => {
  const source = html.slice(html.indexOf("function chatSections()"), html.indexOf("function chatRoomForThread("));
  assert.match(source, /const rooms = sortConversationRooms\(\[\.\.\.groups, \.\.\.people\]\)/);
  assert.match(source, /return \{ convos, groups, people, rooms \}/);

  const sortSource = html.slice(html.indexOf("function sortConversationRooms("), html.indexOf("function chatSections()"));
  const sortConversationRooms = Function(`"use strict"; ${sortSource}; return sortConversationRooms;`)();
  const sorted = sortConversationRooms([
    { name: "Older person", isGroup: false, latest: { at: "2026-08-14T08:00:00Z" } },
    { name: "Newest group", isGroup: true, latest: { at: "2026-08-14T10:00:00Z" } },
    { name: "Middle person", isGroup: false, latest: { at: "2026-08-14T09:00:00Z" } },
    { name: "Quiet Z", isGroup: true, hasActivity:false, latest: { at: "2026-08-21T11:00:00Z" } },
    { name: "Quiet A", isGroup: true, hasActivity:false, latest: { at: "2026-08-21T12:00:00Z" } },
  ]);
  assert.deepEqual(
    sorted.map((room) => room.name),
    ["Newest group", "Middle person", "Older person", "Quiet A", "Quiet Z"],
    "activity is chronological; empty saved rooms follow it but remain listed",
  );

  const chat = html.slice(html.indexOf("function renderChat()"), html.indexOf("function renderChatRail()"));
  assert.doesNotMatch(chat, /tb-group/);
  const rail = html.slice(html.indexOf("function renderChatRail()"), html.indexOf("function renderThreads()"));
  assert.match(rail, /const \{ rooms \} = chatSections\(\)/);
  assert.match(rail, /rooms\.map\(row\)\.join\(""\)/);
  assert.doesNotMatch(rail, /rl-h|>Groups<|>People</);
});

test("the Relays tab is one latest-message row per exact identity", () => {
  const identitySource = html.slice(html.indexOf("function relayIdentityRows("), html.indexOf("function renderRelays()"));
  const shane = {
    name: "Shane",
    latest: { id: "agent", party: "Shane's Codex", ownedAgent: true, at: "2026-08-13T13:00:00Z" },
    latestAt: "2026-08-13T13:00:00Z",
    unreadCount: 1,
    people: ["Shane"],
  };
  const granular = {
    name: "Granular",
    isGroup: true,
    latest: { id: "group-agent", party: "Shane's Codex", ownedAgent: true, at: "2026-08-13T12:00:00Z" },
    latestAt: "2026-08-13T12:00:00Z",
    unreadCount: 0,
    people: ["Shane", "Sven"],
  };
  const quiet = { name: "New group", hasActivity: false, latest: { at: "2026-08-13T14:00:00Z" } };
  const relayIdentityRows = Function("chatSections", `"use strict"; ${identitySource}; return relayIdentityRows;`)(
    () => ({ rooms: [shane, granular, quiet] }),
  );
  const rows = relayIdentityRows();
  assert.deepEqual(rows, [shane, granular]);
  assert.equal(rows[0].name, "Shane", "the agent byline does not create or rename its own room");
  assert.deepEqual(rows[1].people, ["Shane", "Sven"], "the group keeps its human roster");

  const render = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));
  assert.match(render, /const allRows = threadMessages\(\)[\s\S]*?\.sort\(\(a, b\) => new Date\(b\.at/);
  assert.match(identitySource, /const \{ rooms \} = chatSections\(\)/);
  assert.match(identitySource, /filter\(\(room\) => room\.hasActivity !== false\)/);
  assert.match(identitySource, /latestAt: room\.latestAt \|\| \(room\.latest && room\.latest\.at\)/);
  assert.doesNotMatch(identitySource, /message\.party|message\.partyKey|new Map/,
    "Relays must not rebuild room identity from agent-authored messages");
  assert.match(render, /const identityRows = relayIdentityRows\(\)/);
  assert.match(render, /unread\.map\(\(row\) => relayIdentityRowHtml\(row\)\)/);
  assert.match(render, /visible\.map\(\(row\) => relayIdentityRowHtml\(row\)\)\.join\(""\)/);
  assert.doesNotMatch(render, /receiptRowHtml|data-receipt/);
  assert.doesNotMatch(render, /entry\.html|receiptRowHtml/);
  assert.doesNotMatch(render, /\(payload\.relays \|\| \[\]\)/);
});

test("a newer Task becomes the person's latest Relays preview", () => {
  const identitySource = html.slice(html.indexOf("function relayIdentityRows("), html.indexOf("function renderRelays()"));
  const room = {
    name: "Shane Acton",
    latest: {
      id: "request_newer",
      direction: "out",
      party: "Shane Acton",
      at: "2026-08-18T17:16:01Z",
      title: "Explore Relay Security Trust",
      request: true,
    },
  };
  const relayIdentityRows = Function("chatSections", `"use strict"; ${identitySource}; return relayIdentityRows;`)(
    () => ({ rooms: [room] }),
  );
  const [shane] = relayIdentityRows();

  assert.equal(shane.latest.id, "request_newer");
  assert.equal(shane.latest.title, "Explore Relay Security Trust");

  const render = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));
  assert.doesNotMatch(render, /filter\(\(message\) => !message\.request\)/,
    "the identity index must choose its preview from the same correspondence visible in the room");
});

test("Relays previews use WhatsApp sender attribution and stacked group identity", () => {
  const row = html.slice(html.indexOf("function relayIdentityRowHtml(identity)"), html.indexOf("// ---------- the reader:"));
  assert.match(row, /row\.direction === "out"[\s\S]*?You:/);
  assert.match(row, /identity\.isGroup[\s\S]*?row\.party/);
  assert.match(row, /class="av-stack"/);
  assert.match(row, /groupPeople\.length < 2/);
});

test("merged people and group rooms retain every internal reply-chain id", () => {
  const sections = html.slice(html.indexOf("function chatSections()"), html.indexOf("function renderChatRail"));
  assert.match(sections, /byParty\.set\(key, \{ \.\.\.t, threadIds: new Set\(\[t\.threadId\]\) \}\)/);
  assert.match(sections, /prev\.threadIds\.add\(t\.threadId\)/);
  assert.match(sections, /byGroup\.set\(key, \{ \.\.\.t, hasActivity: true, threadIds: new Set\(\[t\.threadId\]\) \}\)/);
  assert.match(sections, /threadId: `group-room:\$\{group\.id\}`/);
  assert.match(sections, /room\.threadIds instanceof Set && room\.threadIds\.has\(threadId\)/);
});

test("opening a person or group room deterministically keeps its rail visible", () => {
  const open = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  // Re-landed (Sven, 2026-08-16): a relay tap lands in the glance frame —
  // only Chat-sourced opens earn the split. The invariant this test guards is
  // unchanged: chatExpanded is derived deterministically from source/options,
  // never a bare reset that races openRoom, so a room entered from Chat
  // always keeps its rail.
  assert.match(open, /chatExpanded = options\.expanded === undefined \? source === "chat" : Boolean\(options\.expanded\)/);
  assert.doesNotMatch(open, /chatExpanded = false/);
  const noDetail = html.slice(html.indexOf("function renderThreads()"), html.indexOf("function renderThreadDetail"));
  assert.match(noDetail, /activeView = "chat"/);
  assert.doesNotMatch(noDetail, /buildThreads\(\)/);
});

test("a newly opened room positions the newest conversations at the top of the rail", () => {
  const scrollSource = html.slice(
    html.indexOf("function setChatRailScrollTop("),
    html.indexOf("function rememberChatRailScroll("),
  );
  const setChatRailScrollTop = Function(`"use strict"; ${scrollSource}; return setChatRailScrollTop;`)();
  const rail = { scrollTop: 976, clientHeight: 260 };
  const newestConversation = { offsetTop: 4, offsetHeight: 44 };
  const nextConversation = { offsetTop: 52, offsetHeight: 44 };
  const isInViewport = (row) => (
    row.offsetTop + row.offsetHeight > rail.scrollTop
      && row.offsetTop < rail.scrollTop + rail.clientHeight
  );

  // No saved position means first visit, even when Chromium carried a stale
  // bottom scrollTop through the split layout's DOM replacement.
  assert.equal(setChatRailScrollTop(rail, undefined), 0);
  assert.equal(rail.scrollTop, 0);
  assert.equal(isInViewport(newestConversation), true);
  assert.equal(isInViewport(nextConversation), true);

  // A position is restored only when the user actually scrolled that room.
  assert.equal(setChatRailScrollTop(rail, 84), 84);
  assert.equal(rail.scrollTop, 84);

  const render = html.slice(html.indexOf("function renderChatRail()"), html.indexOf("function renderThreads()"));
  assert.match(render, /const nextHtml =/);
  assert.match(render, /if \(railEl\.innerHTML !== nextHtml\)/);
  assert.match(render, /positionChatRail\(railEl, roomKey\)/);
  assert.match(html, /railEl\.querySelector\("\.rl-row\.on"\)\?\.scrollIntoView\(\{ block:"nearest" \}\)/);
  assert.match(html, /#threadsView\.chat-max \.chat-rail[\s\S]*?overflow-anchor:none/);
  // The real failure was subtler than a nonzero rail.scrollTop: the long room
  // enlarged #threadsView and the OUTER card scroller moved the entire rail
  // thousands of pixels upward. The split is now viewport-sized and the room
  // is the only scrolling sibling, so the first headings remain on screen.
  assert.match(html, /#threadsView\.chat-max:not\(\.hidden\) \{[\s\S]*?height:100%; min-height:0; overflow:hidden/);
  assert.match(html, /#threadsView\.chat-max \.chat-rail \{[\s\S]*?height:100%; min-height:0/);
  assert.match(html, /#threadsView\.chat-max #thDetail \{[\s\S]*?height:100%;[\s\S]*?overflow-y:auto/);
  assert.match(html, /function roomScrollElement\(\)[\s\S]*?chatExpanded \? thDetailEl : scrollEl/);
});

test("reader Back restores the exact room scroll anchor", () => {
  const navigation = html.slice(html.indexOf("function captureRoomScroll()"), html.indexOf("// Paragraph-level rendering"));
  assert.match(navigation, /anchorId: anchor \? anchor\.getAttribute\("data-msg"\) : null/);
  assert.match(navigation, /anchorOffset: anchor \? anchor\.getBoundingClientRect\(\)\.top - viewportTop : 0/);
  assert.match(navigation, /roomScroll: captureRoomScroll\(\)/);
  assert.match(navigation, /roomScrollEl\.scrollTop = Number\(saved\.top\) \|\| 0/);
  assert.match(navigation, /roomScrollEl\.scrollTop \+= currentOffset - \(Number\(saved\.anchorOffset\) \|\| 0\)/);
  assert.match(navigation, /requestAnimationFrame\(\(\) => \{[\s\S]*?restoreRoomScroll\(back\.roomScroll\)/);

  const captureSource = html.slice(html.indexOf("function captureRoomScroll()"), html.indexOf("function restoreRoomScroll("));
  const restoreSource = html.slice(html.indexOf("function restoreRoomScroll("), html.indexOf("function openReader("));
  const scroll = { scrollTop: 312, getBoundingClientRect: () => ({ top: 40 }) };
  let anchorDocumentTop = 400;
  const before = { getAttribute: () => "before", getBoundingClientRect: () => ({ top: 10, bottom: 30 }) };
  const anchor = {
    getAttribute: () => "anchor",
    getBoundingClientRect: () => ({ top: anchorDocumentTop - scroll.scrollTop, bottom: anchorDocumentTop - scroll.scrollTop + 70 }),
  };
  const history = { querySelectorAll: () => [before, anchor] };
  const capture = Function("activeView", "roomScrollElement", "thHistoryEl", `"use strict"; return (${captureSource.trim()});`)("threads", () => scroll, history);
  const restore = Function("roomScrollElement", "thHistoryEl", `"use strict"; return (${restoreSource.trim()});`)(() => scroll, history);
  const saved = capture();
  assert.deepEqual(saved, { top: 312, anchorId: "anchor", anchorOffset: 48 });
  anchorDocumentTop += 60; // new content arrived above while the reader was open
  scroll.scrollTop = 0;
  restore(saved);
  assert.equal(scroll.scrollTop, 372, "the same message returns to the same viewport offset");
});

test("per-party colors are stable across conversations and restarts", () => {
  assert.match(html, /function partyColorClass\(name, mine\)/);
  // A hash of the name, never render order — same person, same color, always.
  assert.match(html, /h = \(h \* 31 \+ key\.charCodeAt\(i\)\) >>> 0/);
  assert.match(html, /return `p\$\{h % 8\}`/);
  assert.match(html, /\.th-party\.p0 \{ color:#4a6b5f; \}/);
  assert.match(html, /\.th-party\.me \{ color:var\(--muted\); \}/);
});

test("the user's own messages are labelled 'You' and sit left like every row", () => {
  assert.match(html, /const mine = m\.direction === "out" && !m\.ownedAgent;/);
  assert.match(html, /const who = m\.ownedAgent \? ownedAgentName : mine \? me : m\.party;/);
  // "You", not the account name: the pill is a personal surface, only ever
  // read by its owner (Slack shows your name because its rooms are shared).
  assert.match(html, /const me = "You";/);
  assert.match(html, /\$\{mine \? " mine" : ""\}/);
  // No side-hanging: bare right-hung text without bubbles read as broken
  // (Sven, restyle round 5). Identity comes from the muted "You" instead
  // (.th-party.me) — left-aligned like every other row.
  assert.doesNotMatch(html, /\.th-msg\.mine \{ text-align:right/);
  assert.doesNotMatch(html, /\.th-msg\.mine [^{]*\{ flex-direction:row-reverse/);
});

test("the thread view never repaints identical markup (the Read-the-Conversation flash)", () => {
  assert.match(html, /const rowsChanged = Boolean\(thRowsEl\) && thRowsEl\.innerHTML !== rowsHtml;/);
  assert.match(html, /if \(rowsChanged\) thRowsEl\.innerHTML = rowsHtml;/);
  assert.match(html, /if \(shellChanged \|\| rowsChanged\) \{/);
  assert.match(html, /return; \/\/ markup unchanged: existing handlers are still bound/);
  assert.match(html, /return; \/\/ nothing changed at all/);
});

// David, 2026-08-18: "when i send a message in the relay chat, i often want to
// send more. but the pipe/selection doesnt stay focused on the chat composer".
// The room used to be ONE innerHTML write with its own composer inside it, so
// every payload push destroyed the textarea — which is why a refresh had to be
// deferred while it held focus, and why sending had to blur itself to let its
// own bubble through. Rows and dock are siblings now: the composer is never
// written twice, so the caret simply stays where the user left it.
test("a live refresh repaints the history around the composer, never through it", () => {
  assert.match(html, /<div id="thRows" class="\$\{chatShaped \? "chat-order" : "inbox-order"\}"><\/div>/);
  assert.match(html, /const thRowsEl = document\.getElementById\("thRows"\);/);
  assert.doesNotMatch(html, /thQrInput\.blur\(\)/, "sending must not give up the keyboard");
  assert.doesNotMatch(html, /threadDetailRenderPending/, "no repaint waits on a blur any more");
  // The shell is rebuilt only when the room, its order or its posting state
  // changes — never for new messages.
  assert.match(html, /const shellKey = `\$\{chatShaped \? "chat" : "inbox"\}\|\$\{groupPostingBlocked \? "blocked" : "open"\}\|\$\{threadStateKey\}`/);
  assert.match(html, /const shellChanged = thHistoryEl\.dataset\.shellKey !== shellKey \|\| !document\.getElementById\("thRows"\);/);
  // Faces that change while the composer stays put are set in place.
  assert.match(html, /composerQr\.classList\.toggle\("replying", Boolean\(replyTargetId\)\)/);
  assert.match(html, /if \(composerSendEl\) composerSendEl\.disabled = chatReplySending\.has\(threadStateKey\)/);
  // A surviving node must not collect a fresh listener per repaint: one
  // binding, dispatching through the ref each render refreshes.
  assert.match(html, /threadComposerSend = doThReply;/);
  assert.match(html, /if \(!thQrSend\.dataset\.wired\) \{/);
  assert.match(html, /thQrSend\.addEventListener\("click", \(e\) => \{ e\.stopPropagation\(\); threadComposerSend\?\.\(\); \}\)/);
  assert.match(html, /dressComposer\(thQrInput, \(\) => threadComposerSend\?\.\(\)\)/);
  // Nothing rebuilds the field from the draft store any more, so an emptied or
  // restored field has to be told its own height.
  assert.match(html, /thQrInput\.relayResize\?\.\(\)/);
  assert.match(html, /restored\.value = text;/);
  // The rows keep the flex geometry they had as direct children of #thHistory:
  // block flow would collapse the margins between bubbles.
  assert.match(html, /#thRows \{ display:flex; flex-direction:column; \}/);
  assert.match(html, /#thRows\.inbox-order \.th-msg:last-of-type \{ margin-bottom:10px; \}/);
});

test("entering a chat gives its composer the keyboard without a click", () => {
  const open = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  assert.match(open, /const composerFocusRequest = beginThreadComposerEntryFocus\(threadId\)/);
  assert.match(open, /commitNavigation\(\{ outerScrollTop: 0 \}\);[\s\S]*focusThreadComposerOnEntry\(composerFocusRequest\);[\s\S]*settleThreadComposerEntryFocus\(composerFocusRequest\)/);
  assert.match(html, /input\.focus\(\{ preventScroll:true \}\)/, "room entry focuses without moving the transcript");
  assert.match(html, /input\.setSelectionRange\(end, end\)/, "an existing draft resumes at its end");
  assert.match(html, /dressComposer\(thQrInput, \(\) => threadComposerSend\?\.\(\)\);[\s\S]*focusThreadComposerOnEntry\(threadComposerEntryFocus, \{ recover:true \}\)/,
    "a room whose sent-side history loads asynchronously still receives focus");
  assert.match(html, /if \(activeView !== "threads"\) threadComposerEntryFocus = null/,
    "leaving the room cancels delayed focus instead of stealing it later");
});

test("a successful chat send follows the new message; unrelated refreshes preserve reading position", () => {
  assert.match(html, /let threadDetailFollowSendFor = null/);
  assert.match(html, /threadDetailFollowSendFor = threadStateKey/);
  assert.match(html, /const followOwnSend = threadDetailFollowSendFor === threadStateKey/);
  assert.match(html, /roomScrollEl\.scrollTo\(\{ top, behavior:"smooth" \}\)/);
  assert.match(html, /scrollRoomToNewest\(chatShaped, \{ smooth:followOwnSend \}\)/);
  assert.match(html, /if \(followOwnSend\) threadDetailFollowSendFor = null/);
  assert.match(html, /if \(followOwnSend && !shellChanged && !rowsChanged\) \{/);
  assert.match(html, /scrollRoomToNewest\(chatShaped\);[\s\S]*?scrollRoomToNewest\(chatShaped, \{ smooth:true \}\)/);
});

test("chat send is visible before the Sent projection catches up and reconciles exactly once", () => {
  assert.match(html, /const optimisticChatReplies = new Map\(\)/);
  assert.match(html, /optimisticChatReplies\.set\(idempotencyKey, \{/);
  assert.match(html, /id: optimisticId,[\s\S]*?direction: "out"[\s\S]*?pending: true/);
  assert.match(html, /if \(mine && m\.pending\) bits\.push\(\.\.\.outboxStatusBits\(m\)\)/);
  assert.match(html, /if \(optimistic\.relayId && canonicalIds\.has\(String\(optimistic\.relayId\)\)\)/);
  assert.match(html, /optimisticChatReplies\.delete\(key\)/);
  // The canonical ids no longer come from a send RESPONSE the composer awaited
  // — the composer does not wait for one. They come from the device's queue,
  // which is what still holds the message while the network is gone.
  assert.match(html, /function syncOutboxProjection\(\)/);
  assert.match(html, /relayId: String\(entry\.relayId \|\| ""\)/);
  assert.match(html, /groupSendId: String\(entry\.groupSendId \|\| ""\)/);
});

test("an unsent message is the device's business, not the composer's", () => {
  // The bug: on weak wifi the bubble said Sending… for the 15s client timeout,
  // then vanished and the words reappeared in the composer — and nothing ever
  // sent them (David, Granular group, 2026-08-20).
  //
  // Send now commits to a durable queue in the main process and answers at
  // once. These pin the three halves of that: the queue reaches the renderer,
  // the renderer mirrors it, and the ladder is reported honestly.
  assert.match(html, /outbox: Array\.isArray\(next\.outbox\) \? next\.outbox : \[\]/);
  assert.match(html, /syncOutboxProjection\(\);/);
  assert.match(html, /outboxState: String\(entry\.state \|\| "queued"\)/);
  assert.match(html, /function outboxStatusBits\(m\)/);
  assert.match(html, /Trying again…/);
  assert.match(html, /th-status-settle/);
  assert.match(html, /receipt\.label === "Sent" \|\| receipt\.label === "Delivered"/);
  assert.match(html, /data-outbox-retry/);
  assert.match(html, /data-outbox-discard/);
  // A regained connection must flush the queue rather than wait out the
  // backoff the outage earned.
  assert.match(html, /window\.addEventListener\("online"/);
  assert.match(html, /window\.relay\.networkOnline/);
});

test("a room has at most one Seen receipt and a pending send suppresses the old one", () => {
  assert.match(html, /function receiptFor\(m, msgs\) \{/);
  assert.match(html, /RelayReadReceipts\.forLatest\(m, msgs, timeAgo\)/);
  assert.match(html, /data-receipt-toggle/);
  assert.match(html, /expandedReceiptIds/);
  assert.doesNotMatch(html, /if \(m\.textLike\) \{\s*const newest = msgs\.filter/);
});

test("only a six-hour chunk boundary changes conversation geometry", () => {
  assert.doesNotMatch(html, /gap-mid|gapClass|headerGapClass|bubbleGapClass/);
  assert.doesNotMatch(html, /th-seam|chainChanged|chainSeamClass/);
  assert.match(html, /const chunkDivider = chunkDateLabel/);
});

test("same-sender bubbles keep one gap across Tasks, texts, and directions", () => {
  // A replyable text has an interstitial .th-under row; a Task does not. The
  // base continuation gap and the accessory-row compensation must describe
  // the same visual distance, matching the established spacing between two
  // outbound text messages.
  assert.match(html, /\.th-msg\.cont \{ margin-top:20px; \}/);
  assert.match(html, /\.th-under \{[^}]*height:15px;[^}]*margin:3px 16px 0;/);
  assert.match(html, /\.th-under \+ \.th-msg\.cont \{ margin-top:2px; \}/);
  assert.doesNotMatch(html, /\.th-msg:has\(\+ \.th-msg\.cont\) \{ border-bottom:0; \}/);
});

test("conversation chunks carry the selected Relay date divider", () => {
  const source = html.match(/(function formatChatDate\(iso, nowValue = Date\.now\(\)\) \{[\s\S]*?\n  \}\n\n  function chatChunkDateLabel\(iso, previousIso, nowValue = Date\.now\(\)\) \{[\s\S]*?\n  \})\n/)[1];
  const { formatChatDate, chatChunkDateLabel } = Function(
    `"use strict"; ${source}; return { formatChatDate, chatChunkDateLabel };`,
  )();
  const now = new Date(2026, 7, 17, 18, 0, 0);
  const localIso = (year, month, day, hour = 12) => new Date(year, month, day, hour, 0, 0).toISOString();

  assert.equal(formatChatDate(localIso(2026, 7, 17), now), "Today");
  assert.equal(formatChatDate(localIso(2026, 7, 16), now), "Yesterday");
  assert.equal(formatChatDate(localIso(2026, 0, 3), now), "3 Jan");
  assert.equal(formatChatDate(localIso(2025, 7, 17), now), "17 Aug 2025");

  const first = localIso(2026, 7, 17, 8);
  const sameChunk = localIso(2026, 7, 17, 13);
  const nextChunk = localIso(2026, 7, 17, 15);
  assert.equal(chatChunkDateLabel(first, "", now), "Today", "the first visible chunk is labelled");
  assert.equal(chatChunkDateLabel(sameChunk, first, now), "", "six hours or less stays in one chunk");
  assert.equal(chatChunkDateLabel(nextChunk, first, now), "Today", "a pause over six hours starts a labelled chunk");

  assert.match(html, /class="th-chunk-date\$\{firstChunk \? " first" : ""\}" role="separator"/);
  assert.match(html, /return `\$\{chunkDivider\}\$\{runHeader\}/);
  assert.doesNotMatch(html, /\.th-run\.th-seam|\.th-msg\.gap-mid|\.th-run\.gap-mid/);
});

test("a dated chunk reintroduces the sender even inside the same wire thread", () => {
  const source = html.match(/(function continuesSenderRun\(previous, current, chunkDateLabel\) \{[\s\S]*?\n  \})\n/)[1];
  const continuesSenderRun = Function(
    `"use strict"; ${source}; return continuesSenderRun;`,
  )();
  const previous = {
    party: "Sven Wellmann",
    direction: "in",
    threadId: "relay_20260813153401840_2df18c122fec",
    textLike: true,
  };
  const current = { ...previous };

  assert.equal(continuesSenderRun(previous, current, ""), true, "same chunk stays grouped");
  assert.equal(
    continuesSenderRun(previous, current, "Today"),
    false,
    "the first message below a dated divider gets its own sender header",
  );
  assert.equal(
    continuesSenderRun(previous, { ...current, direction: "out" }, ""),
    false,
    "a direction change still starts a new sender run",
  );
  assert.equal(
    continuesSenderRun(previous, { ...current, threadId: "another-chain" }, ""),
    true,
    "opaque wire chains never split one speaker's visible run",
  );
  assert.equal(
    continuesSenderRun({ ...previous, textLike:false }, { ...current, textLike:false, threadId:"another-chain" }, ""),
    true,
    "structured Relays also stay in the same visible run",
  );
  const request = { ...previous, textLike:false, request:true, threadId:"firebase" };
  const correction = { ...request };
  const text = { ...previous, textLike:true, request:false, threadId:"plain-text" };
  const nextRequest = { ...request, threadId:"plugin" };
  assert.equal(continuesSenderRun(request, correction, ""), true, "a Request correction stays grouped");
  assert.equal(continuesSenderRun(correction, text, ""), true, "Request to text stays grouped");
  assert.equal(continuesSenderRun(text, nextRequest, ""), true, "text to Request stays grouped");
  assert.match(html, /const cont = continuesSenderRun\(prev, m, chunkDateLabel\)/);
});

test("a room send addresses the room and quotes only a chosen Relay", () => {
  assert.match(html, /const selectedReplyTargetId = String\(threadReplyTargets\.get\(threadStateKey\) \|\| ""\)/);
  assert.match(html, /const inReplyToRelayId = selectedReplyTargetId;/);
  assert.match(html, /const recipient = \(addressAnchor && addressAnchor\.addressRecipient\)/);
  assert.match(html, /emptyGroupAnchor \? \{ groupId:emptyGroupAnchor\.groupId \} : null/);
  assert.match(html, /sendReply\(\{\s*text, recipient, \.\.\.\(inReplyToRelayId \? \{ inReplyToRelayId \} : \{\}\), files, idempotencyKey,/);
  assert.doesNotMatch(html, /sendReply\(\{ text, inReplyToRelayId: newest\.id/);
});

test("specific replies use an attached composer preview and render a source reference", () => {
  assert.match(html, /const threadReplyTargets = new Map\(\)/);
  assert.match(html, /class="th-composer-dock\$\{chatShaped \? " chat-shaped" : ""\}"/);
  assert.match(html, /\.th-composer-dock\.chat-shaped \{ position:sticky; bottom:0; z-index:2; padding-bottom:16px;/);
  assert.match(html, /\.th-composer-dock \{ flex:none; padding:14px 16px 0; background:var\(--bg\); \}/);
  assert.match(html, /class="qr th-qr col\$\{replyTargetId \? " replying" : ""\}"/);
  assert.match(html, /class="th-reply-target"/);
  assert.match(html, /Replying to \$\{esc\(replyPreviewAuthor\(replyTarget\)\)\}/);
  assert.match(html, /data-reply-cancel="1"/);
  assert.match(html, /threadReplyTargets\.set\(threadStateKey, id\)/);
  assert.match(html, /threadReplyTargets\.delete\(threadStateKey\)/);
  // Attaching or detaching a Relay repaints the composer's top face in place;
  // neither hands the keyboard back, and both leave the caret in the field.
  assert.doesNotMatch(html, /liveBox === document\.activeElement/);
  assert.match(html, /composerQr\.querySelector\("\.th-reply-target"\)\?\.remove\(\)/);
  assert.match(html, /composerQr\.insertAdjacentHTML\("afterbegin", composerReplyTargetHtml\)/);
  assert.match(html, /wireReplyCancel\(composerQr, threadStateKey\)/);
  assert.match(html, /if \(b\.dataset\.wired\) continue;/);
  assert.match(html, /inReplyToRelayId: r\.inReplyToRelayId \|\| ""/);
  assert.match(html, /inReplyToRelayId: s\.inReplyToRelayId \|\| ""/);
  assert.match(html, /\$\{messageReplyReferenceHtml\(m\)\}/);
  assert.match(html, /data-reply-ref="\$\{esc\(parentId\)\}"/);
  assert.match(html, /source\.scrollIntoView\(\{ block:"center", behavior:REDUCED \? "auto" : "smooth" \}\)/);
  assert.match(html, /\.th-reply-ref \{ flex:0 0 calc\(100% - 42px\); width:calc\(100% - 42px\)/);
  assert.match(html, /margin:0 42px 7px 0/);
});

test("agent-authored relays use the shipped Codex and Claude Code marks in a bubble footer", () => {
  // The byline reads the surface and nothing else. Gating on the transport
  // host meant relays that DID state their surface still rendered nothing.
  assert.doesNotMatch(html, /source\?\.host !== "relay-mcp"/);
  assert.match(html, /const PROVIDER_BYLINE = new Map\(\[/);
  assert.match(html, /\["codex", \{ mark: "codexMark\.svg", label: "Codex" \}\]/);
  assert.match(html, /\["claude_code", \{ mark: "claudeCodeMark\.svg", label: "Claude Code" \}\]/);
  assert.match(html, /\["claude_desktop", \{ mark: "claudeCodeMark\.svg", label: "Claude Desktop" \}\]/);
  assert.match(html, /\["claude_cowork", \{ mark: "claudeCodeMark\.svg", label: "Claude Cowork" \}\]/);
  assert.match(html, /PROVIDER_BYLINE\.get\(String\(message\?\.source\?\.surface \|\| ""\)\)/);
  assert.match(html, /Sent with \$\{esc\(provider\.label\)\}/);
  assert.match(html, /\.th-provider-byline \{[^}]*border-top:1px solid var\(--hair\)/s);
});

test("the byline RENDERS — executed, not pattern-matched", () => {
  // This feature shipped with four green assertions beside it and never once
  // appeared in production, because every one of them checked source text or
  // an environment instead of running the thing. So run the thing.
  const start = html.indexOf("const PROVIDER_BYLINE = ");
  assert.notEqual(start, -1, "the byline table moved — this test extracts it by name");
  const source = html.slice(start, html.indexOf("const defaultReplyAnchorIds"));
  const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const providerBylineHtml = new Function("esc", `${source}; return providerBylineHtml;`)(esc);

  const from = (surface, extra = {}) => providerBylineHtml({ source: { host: "relay-mcp", surface }, ...extra });

  assert.match(from("codex"), /codexMark\.svg[^>]*>Sent with Codex</);
  assert.match(from("claude_code"), /claudeCodeMark\.svg[^>]*>Sent with Claude Code</);
  assert.match(from("claude_desktop"), /Sent with Claude Desktop</);
  assert.match(from("claude_cowork"), /Sent with Claude Cowork</);

  // A correct surface stamped by a host OTHER than relay-mcp still renders:
  // this exact case (host "claude-code-direct") was live and showed nothing.
  assert.match(
    providerBylineHtml({ source: { host: "claude-code-direct", surface: "claude_code" } }),
    /Sent with Claude Code</,
  );

  // Silence for everything that is not a known authoring surface — including
  // "relay_companion", which the pill stamps on its own staged copy of an
  // inbound relay and which says nothing about who wrote it.
  assert.equal(providerBylineHtml({ source: { host: "relay", surface: "relay_companion" } }), "");
  assert.equal(providerBylineHtml({ source: { host: "relay-mcp" } }), "");
  assert.equal(providerBylineHtml({ source: {} }), "");
  assert.equal(providerBylineHtml({}), "");
  assert.equal(from("codex", { deletedAt: "2026-08-19T00:00:00Z" }), "", "a withdrawn relay keeps no footer");

  // The surface is whatever the sender wrote on the wire. Looked up in an
  // object literal, these inherit a truthy function from Object.prototype and
  // render "Sent with undefined" next to a broken image.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(from(key), "", `an inherited key must not render a byline: ${key}`);
  }
});

test("the provenance byline is not confined to rows without an agent document", () => {
  // The byline was gated on `textLike`, which is false for exactly two kinds
  // of row: one carrying a forAgent document, and any request/task. Those are
  // the MOST agent-authored things in the room — so the footer was withheld
  // from precisely the relays that most needed it, and could only ever appear
  // on a plain one-document text. It is rendered for every row; surface decides.
  assert.match(html, /\$\{providerBylineHtml\(m\)\}/);
  assert.doesNotMatch(html, /\$\{textLike \? providerBylineHtml\(m\) : ""\}/);
});

test("the room composer prevents duplicate sends, and returns a draft only when the device itself refuses it", () => {
  assert.match(html, /let thReplySending = false;/);
  assert.match(html, /const threadStateKey = isConversationRoomSource\(\) \? String\(threadDetailId\) : String\(thread\.threadId\)/);
  assert.match(html, /if \(thReplySending \|\| chatReplySending\.has\(threadStateKey\)\) return;/);
  assert.match(html, /thQrSend\.disabled = true;/);
  assert.match(html, /chatReplySending\.add\(threadStateKey\)/);
  assert.match(html, /const threadComposerDrafts = new Map\(\)/);
  assert.match(html, /<textarea id="thQrInput"[^>]*>\$\{esc\(threadDraft\)\}<\/textarea>/);
  assert.match(html, /const priorAttempt = threadReplyAttemptKeys\.get\(threadStateKey\)/);
  assert.match(html, /priorAttempt && priorAttempt\.fingerprint === fingerprint/);
  assert.match(html, /sendReply\(\{\s*text, recipient, \.\.\.\(inReplyToRelayId \? \{ inReplyToRelayId \} : \{\}\), files, idempotencyKey,/);
  // The restore path still exists — a device that cannot store the message at
  // all must not swallow it — but it is now reachable ONLY from that, never
  // from a failed network attempt, which the queue absorbs and retries.
  assert.match(html, /optimisticChatReplies\.delete\(idempotencyKey\)/);
  assert.match(html, /chatReplySending\.delete\(threadStateKey\)/);
  assert.match(html, /threadComposerDrafts\.set\(threadStateKey, text\)/);
  assert.match(html, /const restored = document\.getElementById\("thQrInput"\)/);
});

test("developer chat composers rank owned laptop agents ahead of participant mentions", () => {
  const owned = html.indexOf('{ token:"my_claude", name:"@my_claude"');
  const participant = html.indexOf('...[...participantNames]');
  assert.ok(owned >= 0 && participant > owned, "owned agents precede participant suggestions");
  assert.match(html, /groupInfoRoster\(group\)[\s\S]*!member\.currentUser/, "saved-group rosters contribute participants who have not spoken yet");
  assert.match(html, /payload\.features\?\.requests === true \? \[/, "owned agents are suggested only where the feature is enabled");
  assert.match(html, /if \(event\.key === "Enter" \|\| event\.key === "Tab"\)/, "keyboard selection works without leaving the composer");
  assert.match(html, /button\.addEventListener\("click"[\s\S]*chooseMention/, "touch and click selection dismisses the menu too");
  assert.match(html, /\["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"\][\s\S]*renderMentions/, "moving the caret re-evaluates the active mention");
  assert.match(html, /thQrInput\.addEventListener\("blur"[\s\S]*closeMentions/, "leaving the composer dismisses the menu");
  assert.match(html, /\.th-mention-menu\.hidden\s*\{\s*display:none;\s*\}/, "the hidden state actually removes the mention menu");
  assert.match(html, /title:"I'm on it"[\s\S]*agentInvocation:true/, "sending paints the immediate owned-agent response");
  assert.match(html, /const ownedAgentParticipantNames = new Set\([\s\S]*message\.ownedAgent/,
    "owned-agent reply identities are tracked separately from people");
  assert.match(html, /thread\.party && !ownedAgentParticipantNames\.has\(normalizedPartyName\(thread\.party\)\)/,
    "an owned-agent reply cannot re-enter the selector through the direct-room fallback");
  assert.match(html, /const savedContact = !currentUser && email[\s\S]*contactsList\.find[\s\S]*const shown = savedName/,
    "the viewer's saved contact name wins over somebody else's group-roster label");
  const groupMentions = html.slice(html.indexOf("const participantNames = new Set();"), html.indexOf("const mentionOptions = [", html.indexOf("const participantNames = new Set();")));
  assert.match(groupMentions, /thread\.isGroup[\s\S]*groupInfoRoster\(group\)/,
    "group mentions come from the current roster");
  assert.doesNotMatch(groupMentions.split("} else {")[0], /message\.party/,
    "historical group sender labels cannot create stale mention choices");
});

test("owned-agent faces remain inside the human room", () => {
  const buildThreads = html.slice(html.indexOf("function buildThreads()"), html.indexOf("function normalizedPartyName("));
  assert.match(buildThreads, /m\.direction === "in" && !m\.ownedAgent/,
    "an agent response cannot name the room as an inbound participant");
  assert.match(buildThreads, /find\(\(m\) => !m\.ownedAgent\) \|\| latest/,
    "room identity prefers a human counterpart even without an inbound message");
  assert.match(buildThreads, /m\.direction === "in" && !m\.ownedAgent && m\.party/,
    "the room roster excludes owned-agent bylines");
  assert.match(html, /partyKey:sendAnchor\.partyKey \|\| thread\.partyKey \|\| ""/,
    "the immediate agent bubble inherits the existing room key");
  assert.doesNotMatch(html, /partyKey:`owned-agent:\$\{provider\}`/,
    "an optimistic agent response never creates an agent-addressed room");

  const buildThreadsFn = Function("threadMessages", `"use strict"; ${buildThreads}; return buildThreads;`)(() => [
    {
      id: "trigger", threadId: "thread_self", direction: "out", party: "Shane",
      partyKey: "email:shane@example.com", at: "2026-08-24T14:21:46.205Z",
    },
    {
      id: "agent", threadId: "thread_self", direction: "in", party: "Shane's Codex",
      partyKey: "email:", ownedAgent: true, at: "2026-08-24T14:21:46.284Z",
    },
  ]);
  const [selfThread] = buildThreadsFn();
  assert.equal(selfThread.party, "Shane");
  assert.equal(selfThread.partyKey, "email:shane@example.com");
  assert.equal(selfThread.latest.id, "agent", "the agent can own the latest message without owning the room");
});

test("progress-only Relay edits repaint an already-open desktop chat", () => {
  const relayFingerprint = main.slice(main.indexOf("const sig = JSON.stringify({"), main.indexOf("if (force || sig !== lastSig)"));
  assert.match(relayFingerprint, /relays:[\s\S]*r\.updatedAt/,
    "the pill's inbox signature includes the in-place generation changed by agent progress");
});

test("unfinished owned-agent replies visibly pulse until their final agent payload arrives", () => {
  assert.match(html, /const agentWorking = m\.ownedAgent && !String\(m\.agent \|\| ""\)\.trim\(\) && !m\.deletedAt/);
  assert.match(html, /agentWorking \? " agent-working"/);
  assert.match(html, /agent-working-indicator[\s\S]*agent-working-dot[\s\S]*agent-working-dot[\s\S]*agent-working-dot/);
  assert.match(html, /@keyframes agentWorkingPulse/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /agentWorking \? ' aria-busy="true"'/);
});

test("agents can quote explicitly but cannot name threads", () => {
  assert.match(mcp, /Addressing a person, group, or chat never implies a reply/);
  assert.match(mcp, /Set replyToRelayId only when/);
  assert.match(mcp, /not a product object, visible thread\/topic, title, chat, or UI destination/);
  assert.doesNotMatch(mcp, /args\.threadTitle|properties\.threadTitle/);
  assert.match(mcp, /function withoutThreadTitles/);
  assert.match(mcp, /key !== "threadTitle"/);
});


test("requests stay on the board for control and appear in chat as delivered correspondence", () => {
  // The board uses the relay anatomy (Sven's audit: .tb-title hardcoded ink
  // and tap-navigates-to-reader made tasks feel like a different app): the
  // shared title component with the read/unread system, preview when folded,
  // and the same interaction as every bubble — tap unfolds in place.
  assert.doesNotMatch(html, /tb-title/);
  assert.match(html, /\.tb-row\.unread \.th-title \{ color:var\(--ink\); font-weight:500; \}/);
  assert.match(html, /const expandedRequestIds = new Set\(\)/);
  // The request ROOT is visible in the person's chat, labelled as a Task;
  // progress/completion and execution controls remain on the board/reader.
  assert.match(html, /const request = isTaskRow\(r\)/);
  assert.match(html, /if \(!request && !isRelayListKind\(r\)\) continue;/);
  assert.match(html, /const textLike = request \? false : ownedAgent \|\| relayTextLike/);
  assert.match(html, /m\.request \? '<span class="kchip">Task<\/span>'/);
  assert.match(html, /m\.request \? "tasks" : "threads"/);
  // The dock's composer never clips: inputs must be allowed to shrink.
  assert.match(html, /\.qr textarea \{ flex:1 1 auto; min-width:0;/); // the capsule IS the field (autosizing textarea)
  // Group membership IS the status — no per-row chips repeating the header,
  // no notes on board rows; moving between groups is the feedback (Sven:
  // "it says parked in about 3 places").
  // TWO STATES, NOT THREE: a message sent into a finished run continues it
  // rather than starting it again, so the word is "Working" throughout.
  assert.match(html, /\+ section\("Working", groups\.running, \(\) => ""\)/);
  assert.match(html, /\+ section\("Parked", groups\.parked, \(\) => ""\)/);
  assert.doesNotMatch(html, /tb-status/);
  // A folded task row is EXACTLY a list row: disc, name + time, serif title,
  // one quiet control. Topic and brief appear only on unfold; no preview line
  // ("disk, davids name, the thread name, the task summary and the task in
  // full detail" — Sven counting the noise).
  assert.match(html, /function requestRowHtml|renderTasksBoard/); // the board renders rows; topic chip retired
  assert.doesNotMatch(html, /bodyPreview\(r\.forHuman \|\| "", title, 72\)/);
  // Title-less 1:1 conversations are named the person, plain — no suffix.
  assert.doesNotMatch(html, /\$\{t\.party\} · direct/);
});

test("your own relays are readable too — the text/letter rule is the same on both sides", () => {
  // Outbound letters use the sent cache as their reader source; they must not
  // carry a chevron that points at an early return (David: "none of this is
  // clickable for me").
  const sentPush = html.slice(html.indexOf("for (const s of payload.sent || [])"), html.indexOf("return msgs;"));
  // A quick text you typed stays a text; a titled relay with a body of its
  // own is a letter you can open. Hardcoding textLike:true meant a reader
  // could open everyone's relays but never their own (Sven, live).
  assert.match(sentPush, /const sentTextLike = request \? false : ownedAgent \|\| relayTextLike\(s\.forHuman, sentSubject\(s\), s\.forAgent\)/);
  assert.match(sentPush, /textLike: sentTextLike/);
  assert.match(sentPush, /body: s\.forHuman \|\| "",/);
  assert.match(sentPush, /preview: \(\(\) => \{/);
  assert.match(html, /function readerRow\(id\)/);
  assert.match(html, /openReader\(id, m\.direction === "out" \? "sent" : \(m\.request \? "tasks" : "threads"\)\)/);
  assert.doesNotMatch(html, /if \(el\.getAttribute\("data-dir"\) === "out"\) return;/);
});

test("the agent document, not title similarity, distinguishes text from a Relay", () => {
  const classifier = html.slice(html.indexOf("function relayTextLike"), html.indexOf("function sentIsRead"));
  const listGate = html.slice(html.indexOf("function isRelayListKind"), html.indexOf("function relaySubject"));
  assert.match(classifier, /!String\(forAgent \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(classifier, /b === s|startsWith/);
  assert.match(listGate, /type\) \|\| ""\) === "completion"/);
  assert.match(listGate, /row\.forAgent/, "only two-document completions stay off the correspondence list");
  assert.match(html, /const textLike = request \? false : ownedAgent \|\| relayTextLike\(r\.forHuman, subj, r\.forAgent\)/);
  assert.match(html, /const sentTextLike = request \? false : ownedAgent \|\| relayTextLike\(s\.forHuman, sentSubject\(s\), s\.forAgent\)/);
});

test("opening a conversation reads ALL of it — never a per-message click", () => {
  // Letters used to be exempt, waiting for an unfold, so a reader could open a
  // chat, read the thing, come back, and still find it bold with a count on it
  // (David, live 2026-08-13). Opening is reading — every message in the room.
  assert.match(html, /const sameRoom = room && room\.isGroup/);
  assert.match(html, /sameDirectParty\(m, partyKey, party\)/);
  assert.match(html, /roomAckIds\.push\(messageId\)/);
  assert.match(html, /persistReadIds\(roomAckIds, \{ afterPaint: true \}\)/);
  assert.match(html, /if \(m\.unread\) \{/);
  assert.match(html, /const raw = \(payload\.relays \|\| \[\]\)\.find\(\(row\) => String\(row\.id\) === String\(id\)\);/);
  assert.match(html, /if \(raw\) raw\.unread = false;/);
  // Tasks follow the letter rule too: unfolding reads, and ACTING certainly
  // does — a parked task must never stay bold (Sven).
  assert.match(html, /if \(r && r\.unread\) \{/);
  assert.match(html, /r\.unread = false; \/\/ the badge follows the open immediately/);
  assert.match(html, /window\.relay\.ack\(id\); \/\/ acting on a request reads it/);
  assert.match(html, /window\.relay\.ack\(id\); \/\/ parked ≠ unread/);
  // And the bubble clock anchors TOP-RIGHT regardless of how the title wraps —
  // absolutely positioned, out of the flex flow (in-flow it landed wherever
  // the wrapped title pushed it).
  assert.match(html, /\.th-blk-time \{ position:absolute; top:10px; right:13px;/);
  assert.match(html, /\.th-msg \.th-msg-title \{ padding-right:34px; \}/);
  // Relays stays a message ledger rather than collapsing those reads into one
  // grouped row whose own latest send could mask earlier unread arrivals.
  const renderRelays = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));
  assert.match(renderRelays, /relayIdentityRowHtml/);
  assert.doesNotMatch(renderRelays, /const attention =/);
});

test("Chat and Relays open the same person room, never isolated wire threads", () => {
  assert.match(html, /return source === "chat" \|\| source === "relays"/);
  assert.match(html, /const chatRoom = isConversationRoomSource\(\)\s*\n\s*\? chatRoomForThread\(threadDetailId\)/);
  assert.match(html, /const roomName = threadDetailPartyHint \|\| \(chatRoom && chatRoom\.name\) \|\| voices;/);
  assert.match(html, /setThreadHeader\(roomName \|\| voices, ""\)/);
  assert.match(html, /if \(thread && isConversationRoomSource\(\) && !\(chatRoom && chatRoom\.isGroup\)\)/);
  assert.doesNotMatch(html, /explicitTitle/);
});

test("an inbound arrival is read immediately only when its Chat room is actually on screen", () => {
  const visibleRoom = html.slice(html.indexOf("function visibleChatRoomMessages"), html.indexOf("function openRoom"));
  assert.match(visibleRoom, /if \(!fullCardIsOnStage\(\)\) return \[\];/);
  assert.match(visibleRoom, /activeView !== "threads" \|\| !isConversationRoomSource\(\) \|\| !threadDetailId/);
  // Direct and group rooms can both span multiple invisible reply chains.
  assert.match(visibleRoom, /const ids = room\.threadIds instanceof Set/);
  assert.match(visibleRoom, /return ids\.has\(m\.threadId\)/);
  assert.match(visibleRoom, /sameDirectParty\(m, roomKey, roomName\)/);
  assert.match(visibleRoom, /raw\.unread = false;/);
  assert.match(visibleRoom, /persistReadIds\(ackIds\)/);
  const payloadHandler = html.slice(html.indexOf("function onPayload"), html.indexOf("window.relay.onInbox"));
  assert.match(payloadHandler, /readVisibleChatRoom\(\);/);
});

test("the pill never shows a layout-taking scrollbar", () => {
  // Chromium's classic scrollbar consumes layout width, so the moment an
  // unfold made a view scrollable, every line in the pill reflowed narrower
  // (Sven: "distorts the information… removed entirely"). The pill scrolls
  // like Messages — no chrome, no reflow.
  assert.match(html, /\.qr textarea::-webkit-scrollbar \{ display:none; \}/); // composer never shows a bar
  assert.match(html, /\.qr textarea::-webkit-scrollbar \{ display:none; \}/);
});

test("hand-offs speak in conversation terms: starts vs continues, said BEFORE the tap", () => {
  // The B-rule: the conversation owns the agent thread. First hand-off starts
  // the agent on it; later ones continue that same chat — never "current
  // chat"/"new chat" vocabulary, which failed every first-timer it met.
  assert.match(html, /const handedThreads = new Map\(\)/);
  assert.match(html, /Reopening the \$\{agentAppName\(\)\} chat that knows this conversation/); // Open-in, not Hand
  assert.match(html, /Opening \$\{agentAppName\(\)\} on this conversation — staged, nothing sends until you do/);
  // Any real hand-off marks the conversation (current or fresh, never preview).
  assert.match(html, /source !== "sent" && \(mode === "current" \|\| mode === "fresh"\)/);
  // The header-name sheet is GONE ("no one will see it" — Sven).
  assert.doesNotMatch(html, /convSheet/);
  // The redundant Talk/Reply mode button is gone. The visible document owns
  // the composer: For you replies to the person, while For Agent starts Work.
  // Tasks use the document-owned destination too: For you replies to the
  // person, while For Agent starts or continues Work.
  assert.doesNotMatch(html, /data-reply-mode|__relayToggleReplyMode|replyTarget\(/);
  assert.doesNotMatch(html, /Talk to \$\{esc\(app\)\}|Reply to \$\{esc/);
  assert.match(html, /if \(request && \(onAgent \|\| onWork\)\) return requestDockHtml\(r, \{ inline: true \}\)/);
  assert.match(html, /if \(onAgent \|\| onWork\) return relayWorkDockHtml\(r, \{ inline: true \}\)/);
  assert.match(html, /data-work-start="\$\{esc\(r\.id\)\}"/);
  assert.match(html, /<button type="button" id="qrSend">Send<\/button>/);
  assert.match(html, /if \(!onAgent && !onWork\)/,
    "For you wires the human reply composer for ordinary Relays and Tasks");
  // And the destination line lives where hand-offs actually happen — inside
  // the unfolded bubble, not only on the off-path reader page (Sven:
  // "havent implemented anything for that which i can see").
  // The destination whisper under the verb was CUT (David): the button says\n  // where it goes, and the row note says what happened after the tap.\n  assert.match(html, /Reopening the \$\{agentAppName\(\)\} chat that knows this conversation/);
});

test("every titled bubble opens the reader; quick texts stay inert", () => {
  // One document rule in both directions. A quick text has no hidden page;
  // every titled relay does, including the user's own sent relay.
  assert.match(html, /if \(m && m\.textLike\) return;/);
  assert.match(html, /openReader\(id, m\.direction === "out" \? "sent" : \(m\.request \? "tasks" : "threads"\)\)/);
  assert.match(html, /const r = readerRow\(readerId\)/);
  assert.doesNotMatch(html, /data-strip-reply/);
  // The task reader keeps the intention verbs + transparency line.
  assert.match(html, /data-open-in="\$\{esc\(r\.id\)\}">Open in \$\{esc\(rt\.app\)\}/); // the Hand verb is retired
  assert.match(html, /class="rt-chip" data-route-menu="app"/); // the rail IS the transparency, and it is writable
});

test("every chat-message link uses the theme accent", () => {
  assert.match(html, /\.th-msg :is\(\.th-msg-title, \.th-body\) a \{ color:var\(--accent\)/);
  assert.doesNotMatch(html, /\.th-msg\.text \.th-msg-title a/,
    "link color must not depend on the message subtype or fall back to browser blue");
  assert.match(html, /inlineBody \? `<div class="th-body"[^`]+\$\{readerParagraphs\(m\.body\)\}/,
    "titled Relay bodies must remain inside the themed message-link scope");
  assert.match(html, /href="\$\{esc\(href\)\}" data-md-link="1"/,
    "Markdown links must continue through the safe URL renderer");
});

// ---- a default reply anchor is not a quote ---------------------------------
// inReplyToRelayId is Relay's reply-chain key and every sender sets it by
// default: the room composer anchors to the newest ordinary message, and
// relay_send tells agents to pass "the newest related Relay". Rendered as a
// visible reference, that key quoted the line above practically every message.
function sliceFunction(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  let depth = 0;
  for (let i = src.indexOf(") {", start) + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${header}`);
}
const defaultReplyAnchorMap = new Function(
  `${sliceFunction(html, "function defaultReplyAnchorMap(")}; return defaultReplyAnchorMap;`,
)();

test("the message directly above is a default anchor, and reaching past it is not", () => {
  const anchors = defaultReplyAnchorMap([
    { id: "reversion", at: "2026-08-18T07:39:09.000Z" },
    { id: "fixed", at: "2026-08-18T08:26:40.000Z" },
    { id: "sick", at: "2026-08-18T08:28:00.000Z" },
  ]);
  assert.ok(anchors.get("sick").has("fixed"), "the line above is the anchor the composer sets for you");
  assert.ok(!anchors.get("sick").has("reversion"), "a reach-back is a deliberate reply");
  assert.equal(anchors.get("reversion").size, 0, "nothing sits above the first message");
});

test("out-of-order arrivals are anchored by time, not by list position", () => {
  const anchors = defaultReplyAnchorMap([
    { id: "third", at: "2026-08-18T09:00:00.000Z" },
    { id: "first", at: "2026-08-18T07:00:00.000Z" },
    { id: "second", at: "2026-08-18T08:00:00.000Z" },
  ]);
  assert.ok(anchors.get("third").has("second"));
  assert.ok(!anchors.get("third").has("first"));
});

test("a Task in between does not turn the composer's own anchor into a quote", () => {
  // The composer skips Tasks when it picks an anchor, so both the line
  // directly above and the newest ordinary message above are defaults.
  const anchors = defaultReplyAnchorMap([
    { id: "chat", at: "2026-08-18T07:00:00.000Z" },
    { id: "request", at: "2026-08-18T07:30:00.000Z", request: true },
    { id: "reply", at: "2026-08-18T08:00:00.000Z" },
  ]);
  assert.ok(anchors.get("reply").has("chat"), "the newest ordinary message above");
  assert.ok(anchors.get("reply").has("request"), "and the message directly above");
});

test("the reply chip renders only for a deliberate reply still visible in the room", () => {
  assert.match(html, /const defaultReplyAnchorIds = defaultReplyAnchorMap\(thread\.msgs\)/);
  assert.match(html, /const defaults = defaultReplyAnchorIds\.get\(String\(\(message && message\.id\) \|\| ""\)\)/);
  assert.match(html, /if \(defaults && defaults\.has\(parentId\)\) return "";/);
  // A parent outside the loaded room is indistinguishable from a default
  // anchor, and the default is overwhelmingly the case: say nothing rather
  // than stamp a placeholder on old messages.
  assert.doesNotMatch(html, /Original Relay unavailable/);
  assert.doesNotMatch(html, /th-reply-ref missing/);
});
