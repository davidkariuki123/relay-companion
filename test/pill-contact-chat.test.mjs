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
  // Nothing said yet: the resolved window is the fallback, not a dead click.
  assert.match(room, /openContactChat\(key\);/);

  const opener = between(html, "function openContactChat(key)", "\n  }\n");
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
  assert.match(opener, /const onThisRow = \(message\) => \{ if \(cvOpeningKey === key\) cvPeopleErrorEl\.textContent = message; \}/);
  assert.match(opener, /onThisRow\(res\.error \|\| "That conversation could not be opened\."\)/);
  // And the list has somewhere to put it: #cvError lives inside the card.
  assert.match(html, /<div class="cvg-error" id="cvPeopleError"><\/div>\s*\n\s*<div class="cv-list" id="cvList">/);
});

test("a room entered from People keeps People lit, and Back returns there", () => {
  // The lit tab follows threadsSource, so "contacts" is what keeps the
  // highlight on People instead of throwing it to Relays (David).
  const source = between(html, "function isConversationRoomSource(source = threadsSource)", "\n  function openThreadDetail");
  assert.match(source, /source === "chat" \|\| source === "relays" \|\| source === "contacts"/);
  assert.match(html, /: activeView === "threads" \? threadsSource/);

  // Back goes back to the list that was clicked, on the row it left.
  const back = between(html, "thBackEl.addEventListener", "let threadsSource =");
  assert.match(back, /threadsSource === "contacts" \? "contacts"/);
  assert.match(back, /activeView === "contacts" \? contactsListScrollTop/);
  assert.match(html, /if \(activeView === "contacts" && source === "contacts" && scrollEl\) contactsListScrollTop = scrollEl\.scrollTop;/);
});

test("the pill asks for a contact's chat by address and name, coerced to primitives", () => {
  assert.match(
    preload,
    /openChatWith: \(email, name\) =>\s*\n\s*ipcRenderer\.invoke\("relay:openChatWith", \{ email: String\(email \|\| ""\), name: String\(name \|\| ""\) \}\)/,
  );
  assert.match(
    preload,
    /openGroupChat: \(groupId, name\) =>\s*\n\s*ipcRenderer\.invoke\("relay:openChatWith", \{ groupId: String\(groupId \|\| ""\), name: String\(name \|\| ""\) \}\)/,
  );
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
  assert.match(room, /openGroupChat\(groupId\);/);

  const opener = between(html, "function openGroupChat(groupId)", "\n  /**");
  assert.match(opener, /window\.relay\.openGroupChat\(groupId, \(g && g\.name\) \|\| ""\)/);
  assert.match(opener, /if \(!window\.relay\.openGroupChat\) \{/);
  // A failure lands on the pane it came from, and only while that row is the
  // one still being opened — the roster is no longer expanded on this path.
  assert.match(opener, /const onThisRow = \(message\) => \{ if \(cvgOpeningId === groupId\) cvgShowError\(message\); \}/);
  assert.match(opener, /onThisRow\(res\.error \|\| "That conversation could not be opened\."\)/);
});

test("a group only its owner can address carries no recipient, and says why", () => {
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
  assert.match(opener, /No conversation in this group yet — only its owner can start one\./);

  // Both shapes reach the API as a recipient ref, never flattened to a string.
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  assert.match(send, /carried && carried\.groupId\s*\n\s*\? \{ groupId: String\(carried\.groupId\) \}/);
  assert.match(send, /\? \{ email: String\(carried\.email\) \}/);
});

test("a contact's chat opens one window per room, seeded with the room main already read", () => {
  const opener = between(main, "async function openChatWithContact", "function openPreviewExternal");
  assert.match(opener, /chat = groupId \? await client\.chatForGroup\(groupId\) : await client\.chatWith\(email\)/);
  // Keyed by the ROOM rather than by anything that was said in it, so the card
  // always lands in the same window however often it is clicked.
  assert.match(opener, /const existing = previewEntryFor\(chatId\)/);
  assert.match(opener, /createPreviewWindow\(payload, \{ recipient, chatSeed: chat \}\)/);
  // A second click raises what is already open, with the room as it stands now.
  assert.match(opener, /existing\.chatSeed = chat;[\s\S]*?sendPreviewPayload\(existing\)[\s\S]*?showPreviewWindow\(existing\)/);
  // No relay was opened to get here: the window is the conversation and nothing
  // else, and it is named by the card that opened it.
  assert.match(opener, /openFace: "chat"/);
  assert.match(opener, /chatTitle: name \|\| String\(\(chat && chat\.title\) \|\| ""\) \|\| email/);

  // The window carries the person; the renderer is never told how to reach them.
  const createWindow = between(main, "function createPreviewWindow", "function openPreview(");
  assert.match(createWindow, /recipient,/);
  assert.match(createWindow, /chatSeed,/);
  const payloadSend = between(main, "function sendPreviewPayload", "// The lowest cascade offset");
  assert.doesNotMatch(payloadSend, /recipient|chatSeed/, "neither crosses to the renderer");
});

test("a contact's window reads its own room, decided by main and not by the renderer", () => {
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

test("a room opened from a contact card is the conversation and nothing else", () => {
  const render = between(previewRenderer, "async function renderContent(next)", "if (!bridge) {");
  assert.match(
    render,
    /chatOnly = Boolean\(text\(row\.chatId\)\) && !text\(row\.relayId\)/,
    "a chat window is one with a room and no message behind it",
  );
  // It opens IN the conversation, wears the name from the card that opened it,
  // and offers no way back to a reading face that does not exist.
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

test("an empty room can be written to: the first message is what starts it", () => {
  // With nothing to answer there is no reply target, and the composer would sit
  // disabled in a room whose whole point is to be written in.
  assert.match(previewRenderer, /const hasTarget = Boolean\(replyTargetId\(\)\) \|\| chatOnly;/);
  assert.match(previewRenderer, /if \(!body \|\| \(!targetId && !chatOnly\)\) return;/);
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
