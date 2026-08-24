import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("collapsed pill says unread and never says unopened", () => {
  assert.match(html, /`\$\{unreadCount\} unread`/);
  assert.doesNotMatch(html, /\$\{unreadCount\} unopened/);
});

test("expanded pill exposes a mark-all-read action through IPC", () => {
  assert.match(html, /id="markAllRead"[^>]*>Mark all as read<\/button>/);
  assert.match(html, /window\.relay\.markAllRead\(\)/);
  assert.match(preload, /markAllRead: \(\) => ipcRenderer\.invoke\("relay:markAllRead"\)/);
  assert.match(main, /ipcMain\.handle\("relay:markAllRead"/);
  assert.match(main, /client\.markAllRead/);
});

test("Relays is a pure person/group index with no free-floating request receipts", () => {
  const relays = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));
  assert.match(relays, /const identityRows = relayIdentityRows\(\)/);
  assert.doesNotMatch(relays, /receiptRowHtml|data-receipt|rl-receipt/);
});

test("tab badges count unread items in their own visible surface", () => {
  const renderAll = html.slice(html.indexOf("function renderAll()"), html.indexOf("function onPayload"));
  assert.match(renderAll, /r\.unread && isRelayListKind\(r\) && !onRequestThread\(r, reqThreads\)/,
    "request progress/completion rows hidden from Relays cannot inflate its badge");
  assert.match(renderAll, /setBadge\(tasksBadgeEl, requestsUnreadCount\(\)\)/,
    "a read but unstarted Task is not unopened");
  assert.match(html, /function requestsUnreadCount\(\) \{ return taskRows\(\)\.filter\(\(r\) => r\.unread\)\.length; \}/);
  assert.doesNotMatch(renderAll, /setBadge\(tasksBadgeEl, requestsWaitingCount\(\)\)/);
});

test("every literal DOM lookup names an element that exists in the overlay", () => {
  const ids = [...html.matchAll(/document\.getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `missing DOM elements: ${missing.join(", ")}`);
});

test("reading a Relay never removes it from the Relays identity index", () => {
  const readRelays = main.slice(main.indexOf("function readRelays()"), main.indexOf("const RELAY_HIDDEN_KINDS"));
  const relays = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));

  assert.match(readRelays, /\.filter\(\(p\) => p\.direction === "inbound"\)/);
  assert.doesNotMatch(readRelays, /\.filter\(\(p\) => p\.state !== "read"\)/);
  assert.match(readRelays, /unread: p\.state !== "read"/);
  assert.match(relays, /const identityRows = relayIdentityRows\(\)/);
  const fullIndex = relays.slice(relays.indexOf("// Relays is the WhatsApp-shaped identity index"));
  assert.doesNotMatch(fullIndex, /filter\([^\n]*unread/);
});

test("attachments use image plates and quiet file rows backed only by main-process bytes", () => {
  // Renderer: image attachments unfold into design-system plates while files
  // remain chips. Both carry only ids; open and preview route through preload.
  assert.match(html, /button class="td-att td-att-open"[^>]*data-att-relay=/);
  assert.match(html, /button class="att-fig td-att-open"[^>]*data-att-preview="1"/);
  assert.match(html, /attachmentPlates\(r\.attachments, \{ relayId: r\.id \}\)/);
  // THE CARGO LAW: files stand free BENEATH the bubble, in their own zone —
  // never inside it, where the enclosure outweighed the relay itself.
  assert.match(html, /<div class="th-cargo\$\{mine \? " mine" : ""\}">\$\{attachmentPlates\(files, \{ relayId: m\.id \}\)\}<\/div>/);
  assert.match(html, /window\.relay\.openAttachment\(relayId, chip\.getAttribute\("data-att-id"\)\)/);
  assert.match(html, /window\.relay\.previewAttachment/);
  assert.match(html, /class="att-plate"/);
  assert.match(html, /class="att-cap"/);
  // Preload: invoke pair.
  assert.match(preload, /openAttachment: \(relayId, attachmentId\) => ipcRenderer\.invoke\("relay:openAttachment", relayId, attachmentId\)/);
  assert.match(preload, /previewAttachment: \(relayId, attachmentId\) => ipcRenderer\.invoke/);
  // Main: handler exists, containment-checks the stored path against the
  // attachments store before either shell.openPath or bounded preview, and
  // downloads on demand.
  assert.match(main, /ipcMain\.handle\("relay:openAttachment"/);
  assert.match(main, /ipcMain\.handle\("relay:previewAttachment"/);
  assert.match(main, /resolved\.startsWith\(attachmentsRoot \+ path\.sep\)/);
  assert.match(main, /shell\.openPath\(target\)/);
  assert.match(main, /materializeAttachmentFiles/);
  assert.match(main, /resolveSafeAttachmentPreview/);
  assert.match(main, /Canonical Slack-linked messages live in the normalized chat cache/);
  assert.match(main, /const fetched = await new RelayClient\(\)\.fetchRelay\(id\)/);
  assert.match(main, /let pendingRelayReader = null/);
  assert.match(main, /if \(!pendingRelayReader \|\| !rendererListening/);
  assert.match(main, /ipcMain\.on\("relay:rendererReady", \(\) => \{[\s\S]*deliverPendingRelayReader\(\)/,
    "a cold View Relay launch waits for the renderer's explicit listener-ready handshake");
});

test("reader attachments share the deployed frosted footer above both document actions", () => {
  const shelf = html.slice(html.indexOf("function relaySharedShelf"), html.indexOf("function safeAttachmentImageUrl"));
  const reader = html.slice(html.indexOf("function renderReader()"), html.indexOf("// ---------- the Tasks board"));

  assert.match(shelf, /Array\.isArray\(relay\?\.attachments\)/,
    "the shelf projects the Relay's one shared attachment collection");
  assert.match(shelf, /Attached to this Relay/);
  assert.match(shelf, /class="rd-shelf-card td-att-open"/,
    "shelf cards reuse the existing authorized attachment-open path");
  assert.match(shelf, /data-att-preview="1"/,
    "previewable files reuse the existing bounded preview path");
  assert.match(reader, /const sharedShelf = relaySharedShelf\(r\)/);
  assert.match(reader, /<div class="rd-foot"><div class="rd-col">\$\{sharedShelf\}\$\{status\}\$\{bothNote\}\$\{composer\}/,
    "the shelf is inside the deployed footer and precedes existing actions");
  assert.match(html, /\.rd-foot \{[^}]*backdrop-filter:blur\(14px\)/,
    "the shelf inherits the deployed 14px frost and long-document reveal");
  assert.match(reader, /wireAttachmentChips\(readerBodyEl\)/,
    "reader shelf clicks are wired after every tab render");
});

test("Slack Settings is one truthful card with the official mark and no optimistic toggle", () => {
  assert.match(html, /src="slackMark\.png" alt="Slack"/);
  assert.match(html, /Relay for \$\{esc\(teamName\)\}/);
  assert.match(html, /Sync starts when you connect\. Relay does not import earlier Slack history\./);
  assert.match(html, /id="svSlackConnect"/);
  assert.match(html, /id="svSlackDisconnectConfirm"/);
  assert.doesNotMatch(html, /data-slack-toggle|Mirror my DMs/);
  assert.match(preload, /slackConnection: \(\) => ipcRenderer\.invoke\("relay:slackConnection"\)/);
});

test("From Slack is message provenance, not a blanket channel label", () => {
  assert.match(html, /provider: item\.provider \|\| \(item\.origin === "slack" \? \{ name:"slack" \} : null\)/);
  assert.match(html, /message\?\.origin === "slack" \|\| message\?\.provider\?\.name === "slack"/);
  assert.match(html, /<img src="slackMark\.png" alt="" \/>From Slack/);
});

test("Slack-linked files and agent documents open the deployed Relay reader", () => {
  assert.match(html, /for \(const chat of canonicalChatDetails\.values\(\)\)/);
  assert.match(html, /const chat = result\?\.chat \|\| result/,
    "the renderer unwraps the main-process canonical chat response before opening the reader");
  assert.match(html, /canonicalChatDetails\.set\(chat\.chatId, chat\);[\s\S]*openFull\(\);[\s\S]*openReader\(messageId, "threads"\)/,
    "View Relay deliberately unfolds the native Pill before opening the requested reader");
  assert.match(html, /attachments: item\.attachments \|\| \[\]/);
  assert.match(html, /const textLike = !\(item\.attachments \|\| \[\]\)\.length && relayTextLike/);
  assert.match(html, /const sharedShelf = relaySharedShelf\(r\)/);
});

test("Slack channel replies live in a real thread subview, including earlier-root gaps", () => {
  assert.match(html, /slackFocusedThreadId/);
  assert.match(html, /data-slack-thread-focus/);
  assert.match(html, /Slack child replies live behind their root's thread affordance/);
  assert.match(html, /Earlier Slack thread/);
  assert.match(html, /Started before Relay was connected\./);
  assert.match(html, /Still linking this reply to its Slack thread…/);
  assert.match(html, /selectedReplyTargetId \|\| String\(focusedSlackParent\?\.id \|\| ""\)/,
    "the focused composer posts back into the Slack thread instead of creating a channel root");
});

test("relay rows project attachment metadata only — no localPath, no signed URL", () => {
  const readRelays = main.slice(main.indexOf("function readRelays()"), main.indexOf("const RELAY_HIDDEN_KINDS"));
  assert.match(readRelays, /hasLocalCopy: Boolean\(a\.localPath\)/);
  assert.doesNotMatch(readRelays, /localPath: /);
  assert.doesNotMatch(readRelays, /openUrl/);
  assert.doesNotMatch(readRelays, /attachmentUrls/);
});

test("staged relays recover both complete documents from the durable packet", () => {
  const recovery = main.slice(
    main.indexOf("const documentsForPacket = createPacketDocumentReader()"),
    main.indexOf("// The inbound Relay attention rows"),
  );
  const readRelays = main.slice(main.indexOf("function readRelays()"), main.indexOf("const RELAY_HIDDEN_KINDS"));

  assert.match(recovery, /createPacketDocumentReader\(\)/);
  assert.match(readRelays, /forHuman: documents\.forHuman/);
  assert.match(readRelays, /forAgent: documents\.forAgent/);
});

test("the list scroller can never scroll sideways and its scrollbar corner is transparent", () => {
  // overflow-y:auto computes overflow-x to auto, which let wide rows sprout a
  // horizontal scrollbar and an unstyled WHITE scrollbar corner over the card.
  assert.match(html, /\.scroll \{ overflow-x:hidden; \}/);
  assert.match(html, /\.scroll::-webkit-scrollbar:horizontal \{ height:0; \}/);
  assert.match(html, /\.scroll::-webkit-scrollbar-corner \{ background:transparent; \}/);
});
