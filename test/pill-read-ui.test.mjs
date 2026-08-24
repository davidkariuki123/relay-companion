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
  assert.match(relays, /const identityRows = relayIdentityRows\(allRows\)/);
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

test("reading a Relay never removes it from the Relays identity index", () => {
  const readRelays = main.slice(main.indexOf("function readRelays()"), main.indexOf("const RELAY_HIDDEN_KINDS"));
  const relays = html.slice(html.indexOf("function renderRelays()"), html.indexOf("function relayIdentityRowHtml"));

  assert.match(readRelays, /\.filter\(\(p\) => p\.direction === "inbound"\)/);
  assert.doesNotMatch(readRelays, /\.filter\(\(p\) => p\.state !== "read"\)/);
  assert.match(readRelays, /unread: p\.state !== "read"/);
  assert.match(relays, /const identityRows = relayIdentityRows\(allRows\)/);
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
