// A row in People is a PERSON, and a row in Groups is the room its roster
// names. Clicking either opens the conversation, the way clicking a name opens
// one in every messenger there has ever been.
//
// Field note 2026-08-19 (David): every square inch of the row opened the edit
// card, so there was no way to reach a person except through a form about them.
// The card is the rarer errand and now sits behind its own worded Edit control;
// the rest of the row is the door to talking.
//
// Where the pill already holds the transcript the room opens IN the pill, and
// People stays the lit tab: it is the same room reached from a different index,
// not a trip through Relays. A person or group nothing has been said to yet has
// no local room, so that one resolves server-side in its own window — keyed by
// the room rather than by a message, so it is always the same window, and it
// opens empty with a live composer rather than as a dead end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { RelayClient, closeRelayConnections } from "../src/client.js";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const previewRenderer = fs.readFileSync(new URL("../overlay/preview-renderer.js", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("the room with one person is asked for by address, in a body rather than a URL", async (t) => {
  // An address in a path or a query string is an address in every access log
  // between here and the API. A chat id is a hash of the people in the room, so
  // asking by address is the only way a contact card can name its room.
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ chatId: "chat_abc123", title: "Sven Wellmann", items: [] }));
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relay = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });

  const chat = await relay.chatWith("sven@example.com");
  assert.equal(chat.chatId, "chat_abc123");
  assert.deepEqual(requests, [
    { method: "POST", url: "/v1/chats/resolve", body: '{"email":"sven@example.com"}' },
  ]);
  assert.doesNotMatch(requests[0].url, /@|sven/, "the address never rides in the URL");
});

test("clicking a contact opens the conversation; only Edit opens the card", () => {
  const rows = between(html, 'for (const el of cvListEl.querySelectorAll(".cv-item"))', "  /**");
  // The row is the person: it opens the room, never the form about them.
  assert.match(rows, /openContactRoom\(el\.getAttribute\("data-contact"\)\)/);
  assert.doesNotMatch(rows, /openContactForm\(el\.getAttribute/);
  // Edit is the only door to the card, and its click stops at the control
  // rather than bubbling out to the row and opening a room behind the form.
  const edit = between(rows, '[data-contact-edit]', "\n  }");
  assert.match(edit, /event\.stopPropagation\(\)/);
  assert.match(edit, /openContactForm\(edit\.getAttribute\("data-contact-edit"\)\)/);
  // The row and the control now do different things, so the card must be
  // reachable without a mouse.
  assert.match(html, /<span class="cv-edit" role="button" tabindex="0" data-contact-edit=/);
  assert.match(edit, /if \(event\.key !== "Enter" && event\.key !== " "\) return;/);

  const room = between(html, "function openContactRoom(key)", "  /**");
  // A room the pill already holds opens IN the pill — expanded, like every
  // other room — and sourced to "contacts" so People stays the lit tab.
  assert.match(room, /openThreadDetail\(existing\.threadId, existing\.name \|\| contact\.name, "contacts", \{ expanded: true \}\)/);
  // Identity is the ADDRESS first: renaming someone in the book must not
  // strand them from the correspondence already on the wire.
  assert.match(room, /`email:\$\{String\(email\)\.trim\(\)\.toLowerCase\(\)\}`/);
  // Two known-but-different addresses never merge on a name collision.
  assert.match(room, /if \(stablePartyKey\(room\.partyKey\)\) return false;/);
  // Nothing said yet: resolve the canonical chat and register it in the same
  // main-pill conversation model rather than opening a second renderer.
  assert.match(room, /const openGeneration = \+\+cvOpenGeneration/);
  assert.match(room, /openContactChat\(key, openGeneration\);/);

  const opener = between(html, "function openContactChat(key, openGeneration = ++cvOpenGeneration)", "\n  }\n");
  // The address comes from the contact's own book entry — the primary one, the
  // same address a relay to them would go to.
  assert.match(opener, /const email = c \? \(contactEmails\(c\)\[0\] \|\| ""\) : ""/);
  assert.match(opener, /window\.relay\.openChatWith\(email, c\.name \|\| ""\)/);
  // A contact with no address has nowhere to send — and a click that does
  // nothing reads as a broken row, so the list says why and points at Edit.
  assert.match(opener, /has no address to write to\. Add one with Edit\./);
  // A pill that has auto-updated ahead of the main process it runs against must
  // not throw on a bridge that is not there yet — and must not fail silently.
  assert.match(opener, /if \(!window\.relay\.openChatWith\) \{/);
  // A room that will not open says so on the LIST, which is what was clicked:
  // the card that used to carry this is shut on this path.
  assert.match(opener, /cvOpenGeneration === openGeneration && cvOpeningKey === key && activeView === "contacts"/);
  assert.match(opener, /if \(!stillCurrent\(\)\) return;/, "a slow result cannot open the previously clicked person");
  assert.match(opener, /storeCanonicalChatDetail\(res\.chat, \{ surface:"relay" \}\)/);
  assert.match(opener, /directContactRoomAnchor\(res\.chat, c, email, res\.recipient\)/);
  assert.match(opener, /contactChatAnchors\.set\(anchor\.chatId, anchor\)/);
  assert.match(opener, /openThreadDetail\(resolved\.threadId, resolved\.name \|\| c\.name, "contacts", \{ expanded:true, hydrated:true \}\)/);
  // And the list has somewhere to put it: #cvError lives inside the card.
  assert.match(html, /<div class="cvg-error" id="cvPeopleError"><\/div>\s*\n\s*<div class="cv-list" id="cvList">/);
});

test("a room entered from People keeps People lit, and Back returns there", () => {
  // The lit tab follows threadsSource, so "contacts" is what keeps the
  // highlight on People instead of throwing it to Relays (David).
  const source = between(html, "function isConversationRoomSource(source = threadsSource)", "\n  function openThreadDetail");
  assert.match(source, /source === "chat" \|\| source === "relays" \|\| source === "slack" \|\| source === "contacts"/,
    "Slack is another room index while the existing People source remains intact");
  assert.match(html, /: activeView === "threads" \? threadsSource/);

  // Back goes back to the list that was clicked, on the row it left.
  const back = between(html, "thBackEl.addEventListener", "let threadsSource =");
  assert.match(back, /threadsSource === "contacts" \? "contacts"/);
  assert.match(back, /destinationView === "contacts" \? contactsListScrollTop/);
  assert.match(back, /activeView = destinationView;/);
  assert.match(html, /if \(activeView === "contacts" && source === "contacts" && scrollEl\) contactsListScrollTop = scrollEl\.scrollTop;/);
});

test("the pill asks for a contact's chat by address and name, coerced to primitives", () => {
  assert.match(
    preload,
    /openChatWith: \(email, name\) =>\s*\n\s*ipcRenderer\.invoke\("relay:openChatWith", \{ email: String\(email \|\| ""\), name: String\(name \|\| ""\) \}\)/,
  );
  assert.doesNotMatch(preload, /openGroupChat:/, "saved groups open in the pill; no detached group-window bridge remains");
});

// A group is not a container for messages: it is a NAME for one participant
// set, so its row opens the room those people share — the same window, reached
// a different way. See apps/api/src/services/chat-identity.ts.
test("opening a group in People opens its room; only Edit expands the roster", () => {
  const rows = between(html, 'for (const el of cvgListEl.querySelectorAll("[data-group]"))', "for (const el of cvgListEl.querySelectorAll(\"[data-unmember]\"))");
  assert.match(rows, /openGroupRoom\(el\.getAttribute\("data-group"\)\)/);
  // Edit still expands and collapses; the second click on an open row is a
  // CLOSE, and must not bubble out and open the conversation it just left.
  const edit = between(rows, "[data-group-edit]", "\n    }");
  assert.match(edit, /event\.stopPropagation\(\)/);
  assert.match(edit, /const closing = cvgExpandedId === id/);
  assert.match(edit, /if \(event\.key !== "Enter" && event\.key !== " "\) return;/);
  // The control has to exist on the row for any of that to be reachable.
  assert.match(html, /<span class="cvg-edit" role="button" tabindex="0" data-group-edit="\$\{esc\(g\.id\)\}">Edit<\/span>/);
  assert.match(html, /\.cvg-item:hover \.cvg-edit, \.cvg-item:focus-visible \.cvg-edit \{ opacity:1;/);

  const room = between(html, "function openGroupRoom(groupId)", "\n  function groupRoomPostingState");
  // Same law as a contact row: the pill's own room, People still lit.
  assert.match(room, /openThreadDetail\(existing\.threadId, existing\.name \|\| group\.name, "contacts", \{ expanded: true \}\)/);
  // Matched by the two keys chatSections() merges group rooms by, id first.
  assert.match(room, /room\.groupId && String\(room\.groupId\) === wantedId/);
  assert.match(room, /!room\.groupId && normalizedPartyName\(room\.groupName \|\| room\.name\) === wantedName/);
  assert.doesNotMatch(room, /openGroupChat\(groupId\)/, "an empty group must not switch to a detached window");
  // groupsList, not message history, creates the room for a zero-message group.
  assert.match(html, /threadId: `group-room:\$\{group\.id\}`/);
  assert.match(html, /hasActivity: false/);
  assert.match(html, /const emptyGroupAnchor = chatRoom && chatRoom\.isGroup && chatRoom\.groupId/);
});

test("a Relay-owned channel only its owner can address carries no recipient, and says why", () => {
  const opener = between(main, "async function openChatWithContact", "function openPreviewExternal");
  assert.match(opener, /chat = groupId \? await client\.chatForGroup\(groupId\) : await client\.chatWith\(email\)/);
  // The send path takes groupId from the roster's OWNER and nobody else, so a
  // member's window carries nothing to address: they answer by replying, which
  // is all they can do. Giving them a group recipient would build a composer
  // the API refuses.
  assert.match(
    opener,
    /const recipient = groupId\s*\n\s*\? \(chat && chat\.group && chat\.group\.owned \? \{ groupId \} : null\)\s*\n\s*: \{ email, name \}/,
  );
  // And an empty room in somebody else's group is a 404 by design: say what is
  // true rather than opening a window whose composer would be refused.
  assert.match(opener, /if \(groupId && error && error\.status === 404\)/);
  assert.match(opener, /No conversation in this channel yet — only its owner can start one\./);

  // Both shapes reach the API as a recipient ref, never flattened to a string.
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  assert.match(send, /carried && carried\.groupId\s*\n\s*\? \{ groupId: String\(carried\.groupId\) \}/);
  assert.match(send, /\? \{ email: String\(carried\.email\) \}/);
});

test("a contact's canonical chat is returned to the main pill and never creates Preview", () => {
  const opener = between(main, "async function openChatWithContact", "function openPreviewExternal");
  assert.match(opener, /chat = groupId \? await client\.chatForGroup\(groupId\) : await client\.chatWith\(email\)/);
  assert.match(opener, /return \{ ok: true, chat, recipient \};/);
  assert.doesNotMatch(opener, /createPreviewWindow|previewEntryFor|showPreviewWindow|openFace/);
  // The existing IPC/preload contract is reused. No new bridge or reader was
  // introduced merely to move a canonical chat into the correct renderer.
  assert.match(preload, /openChatWith: \(email, name\) =>/);
  assert.doesNotMatch(preload, /openResolvedContact|openContactInPill/);
});

test("an explicit chat-only Preview reads the chat main assigned to that window", () => {
  const loader = between(main, "async function previewChat(entry, threadId)", "/**\n * Send a reply");
  // The seed is the room main already fetched to know which window to open:
  // spent once, so opening a chat does not pay a second round trip to see
  // itself, and every read after it is fresh from the server.
  assert.match(loader, /if \(entry && entry\.chatSeed\) \{[\s\S]*?entry\.chatSeed = null;[\s\S]*?return \{ ok: true, chat: seed \};/);
  // Which room comes from the window's own payload — a window opened on a chat
  // can only ever read that chat, whatever the renderer asks for.
  assert.match(loader, /const chatId = String\(\(entry && entry\.payload && entry\.payload\.chatId\) \|\| ""\)/);
  assert.match(loader, /chatId \? await client\.chat\(chatId\) : await client\.chatForThread\(id\)/);
});

test("the retained explicit chat-only Preview cannot escape into another face", () => {
  const render = between(previewRenderer, "async function renderContent(next)", "if (!bridge) {");
  assert.match(
    render,
    /chatOnly = Boolean\(text\(row\.chatId\)\) && !text\(row\.relayId\)/,
    "a chat window is one with a room and no message behind it",
  );
  // This compatibility surface still opens IN its assigned conversation and
  // offers no way back to a reading face that does not exist. People no longer
  // routes ordinary direct chats here.
  const chatBranch = between(render, "if (chatOnly) {", "chatBackEl.classList.remove(\"gone\")");
  assert.match(chatBranch, /document\.title = `\$\{who\} — Relay`/);
  assert.match(chatBranch, /chatNameEl\.textContent = who/);
  assert.match(chatBranch, /chatBackEl\.classList\.add\("gone"\)/);
  assert.match(chatBranch, /showFace\("chat", \{ force: true \}\)/);
  assert.match(chatBranch, /await loadChat\(\)/);
  // No task face and no session face: neither belongs to a room.
  assert.match(chatBranch, /taskMode = false;/);
  assert.match(chatBranch, /setSessionMode\(false\);/);

  // Every path that would leave the conversation stays in it, and Escape —
  // which backs out one level — leaves the window instead.
  assert.match(previewRenderer, /if \(chatOnly && next !== "chat"\) return;/);
  assert.match(previewRenderer, /if \(face === "chat" && !chatOnly\) showFace\("message"\);\s*\n\s*else bridge\.close\(\);/);
});

test("an empty direct chat can be written to from the main pill", () => {
  const composer = between(html, "const emptyGroupAnchor =", "if (!sendAnchor ||");
  assert.match(composer, /const emptyRelayDirectAnchor = chatRoom && !chatRoom\.isGroup/);
  assert.match(composer, /chatRoom\.addressRecipient && chatRoom\.addressRecipient\.email/);
  assert.match(composer, /emptyGroupAnchor \|\| emptySlackDirectAnchor \|\| emptyRelayDirectAnchor/);
  assert.match(composer, /emptyRoomAnchor\.addressRecipient/);
  // The direct address, never a guessed chat id, starts the first message.
  const anchor = between(html, "function directContactRoomAnchor", "function mergeDirectContactAnchor");
  assert.match(anchor, /addressRecipient:recipient/);
  assert.match(anchor, /partyKey = `email:\$\{address\}`/);

  // Explicit Preview windows can still compose in their own supported flows;
  // ordinary People clicks no longer enter this renderer.
  // With nothing to answer there is no reply target, and the composer would sit
  // disabled in a room whose whole point is to be written in.
  assert.match(previewRenderer, /const hasTarget = Boolean\(replyTargetId\(\)\) \|\| chatOnly;/);
  assert.match(previewRenderer, /if \(\(!body && !stagedReplyFiles\.length\) \|\| \(!targetId && !chatOnly\)\) return;/);
  // And it says so, pointing at the composer rather than reporting emptiness.
  assert.match(previewRenderer, /chatOnly \? "No messages yet\. Write the first one below\." : "No messages in this conversation yet\."/);
  // The name on the composer is the one the reader knows this person by.
  assert.match(previewRenderer, /const who = chatOnly\s*\n\s*\? text\(content\.chatTitle\) \|\| text\(chat && chat\.title\)/);

  // Main addresses that first message to the person the window is for; every
  // message after it answers the one before, like any other chat.
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  assert.match(send, /if \(!inReplyToRelayId && !to\) return \{ ok: false, error: "There is nothing here to reply to\." \}/);
  assert.match(send, /\.\.\.\(inReplyToRelayId \? \{ inReplyToRelayId \} : \{\}\)/);
});

test("a resolved direct chat keeps one identity through hydration and account changes", () => {
  const merge = between(html, "function mergeDirectContactAnchor", "function directContactAnchorForChatId");
  assert.match(merge, /return \{\s*\.\.\.existing,\s*\.\.\.anchor,/,
    "the saved contact identity wins over an outbound-only room named You");
  assert.match(merge, /threadId:anchor\.threadId/);
  assert.match(merge, /anchor\.threadId,[\s\S]*?\.\.\.\(existing\.threadIds \|\| \[\]\)/,
    "the synthetic open coordinate and every later real thread id remain aliases of one room");
  const lookup = between(html, "function directContactAnchorForChatId", "function slackIntegrationForChat");
  assert.match(lookup, /return contactChatAnchors\.get\(id\) \|\| null/,
    "canonical chat id is the one registry key, even if a contact address changes");
  const reader = between(html, "function readerRow(id)", "const RX_PRIMARY");
  assert.match(reader, /const directAnchor = directContactAnchorForChatId\(chat\.chatId\)/);
  assert.match(reader, /directAnchor\?\.name \|\| chat\.channel\?\.name/,
    "the reader uses the saved contact name for canonical outbound messages");

  const accountCaches = between(html, "function clearCanonicalAccountCaches", "function onPayload(next)");
  assert.match(accountCaches, /cvOpenGeneration \+= 1/);
  assert.match(accountCaches, /cvOpeningKey = null/);
  assert.match(accountCaches, /contactChatAnchors\.clear\(\)/);
  assert.match(accountCaches, /canonicalChatDetails\.clear\(\)/);
  const payloadHandler = between(html, "function onPayload(next)", "window.relay.onInbox(onPayload)");
  assert.match(payloadHandler, /nextAccountIdentity !== canonicalAccountIdentity/);
  assert.match(payloadHandler, /clearCanonicalAccountCaches\(\)/);
});

test("an empty direct send failure restores the composer without dereferencing a missing message", () => {
  const send = between(html, "const doThReply = async () =>", "threadComposerSend = doThReply");
  assert.doesNotMatch(send, /setRowNote\(newest\.id/);
  assert.match(send, /setRowNote\(newest \? newest\.id : \(sendAnchor\.threadId \|\| thread\.threadId\)/);
});

test("two unclaimed links with no address are two rooms, not one", () => {
  // The guest address is what keys these rooms apart today. When the server
  // stops sending it the key becomes the literal "email:", which stablePartyKey
  // accepts as stable, and every share relay in the account collapses into one
  // room titled after whichever link is newest. The link's own id replaces it.
  const expression = between(html, "partyKey: s.groupSendId || s.recipientGroupName", "\n        isGroup:").trim();
  const partyKeyOf = Function("s", "id", `"use strict"; return (${expression.replace(/^partyKey:\s*/, "").replace(/,$/, "")});`);
  const stablePartyKey = Function(`"use strict"; ${between(html, "function stablePartyKey(value)", "function sameDirectParty(")}; return stablePartyKey;`)();

  const keys = [
    partyKeyOf({ relayId: "relay_a", recipient: { name: "Priya from the gym" }, shareLink: { id: "shl_a", state: "unopened" } }, "relay_a"),
    partyKeyOf({ relayId: "relay_b", recipient: { name: "Sam" }, shareLink: { id: "shl_b", state: "opened" } }, "relay_b"),
  ];
  assert.deepEqual(keys, ["share:shl_a", "share:shl_b"]);
  for (const key of keys) {
    assert.doesNotMatch(key, /undefined/);
    assert.equal(stablePartyKey(key), key, "each link's room is stable on its own key");
  }

  // A claimed link is an ordinary relay again and merges with whatever room
  // already existed with that person.
  assert.equal(
    partyKeyOf({ recipient: { name: "Priya Nair", email: "Priya@Example.com" }, shareLink: { id: "shl_a", state: "claimed" } }, "relay_a"),
    "email:priya@example.com",
  );
});
