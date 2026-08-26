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
  assert.match(renderAll, /r\.unread[\s\S]*isRelayListKind\(r\)[\s\S]*!onRequestThread\(r, reqThreads\)/,
    "request progress/completion rows hidden from Relays cannot inflate its badge");
  assert.match(renderAll, /!relayIsSelfAuthored\(r, sentByRelayId\.get\(String\(r\.id \|\| r\.relayId \|\| ""\)\), viewerEmail\)/,
    "self-authored inbox twins cannot inflate a badge their conversation does not show");
  assert.match(renderAll, /setBadge\(tasksBadgeEl, requestsUnreadCount\(\)\)/,
    "a read but unstarted Task is not unopened");
  assert.match(html, /function requestsUnreadCount\(\) \{ return taskRows\(\)\.filter\(\(r\) => r\.unread\)\.length; \}/);
  assert.doesNotMatch(renderAll, /setBadge\(tasksBadgeEl, requestsWaitingCount\(\)\)/);
});

test("self-authored Relay detection is shared by conversations and the unread badge", () => {
  const helperStart = html.indexOf("function relayIsSelfAuthored(");
  const helperEnd = html.indexOf("\n  // A read receipt", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "self-authored helper exists");
  const helperSource = html.slice(helperStart, helperEnd);
  const relayIsSelfAuthored = Function(`${helperSource}; return relayIsSelfAuthored;`)();

  assert.equal(relayIsSelfAuthored({ senderEmail: "david@example.com" }, null, "DAVID@example.com"), true,
    "a staged note-to-self is outbound for its viewer");
  assert.equal(relayIsSelfAuthored({ senderEmail: "" }, { relayId: "relay_self" }, "david@example.com"), true,
    "a Sent twin identifies older self-authored rows without sender metadata");
  assert.equal(relayIsSelfAuthored({ senderEmail: "sven@example.com" }, null, "david@example.com"), false,
    "another person's Relay remains unread");

  const threadMessages = html.slice(html.indexOf("function threadMessages()"), html.indexOf("function buildThreads()"));
  const renderAll = html.slice(html.indexOf("function renderAll()"), html.indexOf("function onPayload"));
  assert.match(threadMessages, /const selfAuthored = relayIsSelfAuthored\(r, sentTwin, viewerEmail\)/,
    "conversation direction uses the shared viewer-aware rule");
  assert.match(renderAll, /!relayIsSelfAuthored\(/,
    "the unread badge uses the same viewer-aware rule");
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
  const slackSettings = html.slice(html.indexOf("function slackSettingsHtml(info)"), html.indexOf("function renderSettings()"));
  assert.match(html, /src="slackMark\.png" alt="Slack"/);
  assert.match(html, /class="open-actions sv-actions" data-stop="1" aria-label="Account actions"/,
    "permanent account actions stay ordinary page controls instead of trapping Settings in a modal menu role");
  assert.doesNotMatch(html, /class="open-actions sv-actions" data-stop="1" role="menu"/);
  assert.match(slackSettings, /New Slack messages sync with Relay, and Relays send from your Slack account\. Earlier Slack history is not imported\./);
  assert.doesNotMatch(slackSettings, /Relay for \$\{esc\(teamName\)\}|<span class="sv-slack-name">Your Slack<\/span>/,
    "Settings keeps its compact one-card ontology even though the Slack tab teaches both grants");
  assert.match(slackSettings, /id="svSlackConnect"/);
  assert.match(slackSettings, /id="svSlackDisconnectConfirm"/);
  assert.doesNotMatch(slackSettings, /data-slack-toggle|Mirror my DMs/);
  assert.match(preload, /slackConnection: \(\) => ipcRenderer\.invoke\("relay:slackConnection"\)/);
});

test("Device approvals exists only when E2EE is actually available", () => {
  assert.match(html, /deviceApprovalInfo\?\.available !== true\) return ""/,
    "disabled encryption removes the whole section, including its loading and error states");
});

test("Slack Settings follows browser-owned OAuth to its real server state", () => {
  assert.match(html, /const SLACK_CONNECTION_POLL_MS = 2000/,
    "a visible Slack connection surface polls the lightweight status endpoint");
  assert.match(html, /\(activeView === "settings" \|\| activeView === "slack"\) && rendererSurfaceActive\(\)[\s\S]*refreshSlackConnection\(\{ preserveWaiting:true \}\)/,
    "polling runs only while Settings or Slack is on an active renderer surface");
  assert.match(html, /slackConnectionReady\(result\.connection\)[\s\S]*slackConnectionWaiting = false/,
    "the pending affordance clears only when the server reports the complete team and personal grant");
  assert.match(html, /slackConnectionWaitingSince = result\?\.ok === true \? Date\.now\(\) : 0/,
    "a launched browser flow has a bounded pending lifetime instead of becoming an immortal optimistic state");
  assert.doesNotMatch(html, /slackConnectionWaiting = false;\s*if \(result\?\.ok && result\.connection\)/,
    "an ordinary status read must not silently cancel a still-pending OAuth flow");
});

test("From Slack is message provenance, not a blanket channel label", () => {
  assert.match(html, /provider: item\.provider \|\| \(item\.origin === "slack" \? \{ name:"slack" \} : null\)/);
  assert.match(html, /message\?\.origin === "slack" \|\| message\?\.provider\?\.name === "slack"/);
  assert.match(html, /<img src="slackMark\.png" alt="" \/>From Slack/);
  assert.match(html, /const showProviderByline = !continuesIntoNext \|\| providerKey\(nextMessage\) !== providerKey\(m\)/,
    "a Slack provenance shelf closes a sender run instead of repeating inside every short bubble");
});

test("Slack-linked files and agent documents open the deployed Relay reader", () => {
  assert.match(html, /for \(const chat of canonicalChatDetails\.values\(\)\)/);
  assert.match(html, /const chat = result\?\.chat \|\| result/,
    "the renderer unwraps the main-process canonical chat response before opening the reader");
  assert.match(html, /storeCanonicalChatDetail\(chat\);[\s\S]*openFull\(\);[\s\S]*openReader\(messageId, "threads"\)/,
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
  assert.match(html, /String\(row\.inReplyToRelayId \|\| ""\) === rootId/,
    "only an explicit child counts as a Slack reply; a shared compatibility thread key cannot create a false 1 reply");
  assert.doesNotMatch(html, /row\.inReplyToRelayId \|\| row\.id !== message\?\.id/,
    "top-level siblings are never inferred to be replies");
});

test("an open Slack channel refreshes on a live-chat cadence without repainting unchanged generations", () => {
  assert.match(html, /const ACTIVE_CANONICAL_CHAT_POLL_MS = 1000/);
  assert.match(html, /if \(activeCanonicalChatRefresh \|\| !rendererSurfaceActive\(\)\) return/,
    "collapsed, offstage, hidden, and overlapping channel requests do not form a background poll storm");
  assert.match(html, /canonicalChatDetailProjectionKeys\.get\(id\) === projectionKey[\s\S]*canonicalChatFingerprints\.get\(projectionKey\) === nextFingerprint\) return false/,
    "an unchanged transcript in the same projection does not rebuild the open chat");
  assert.match(html, /setInterval\(\(\) => \{ refreshActiveCanonicalChat\(\); \}, ACTIVE_CANONICAL_CHAT_POLL_MS\)/);
  assert.match(html, /liveCanonicalArrivalIds\.add\(messageId\)/);
  assert.match(html, /th-msg\.live-arrival \{ animation:thMessageArrival/,
    "only newly arrived bubbles settle into the existing transcript");
});

test("an open Slack channel persists one canonical read cursor instead of acking canonical ids as legacy rows", () => {
  assert.match(html, /const canonicalReadGeneration = new Map\(\)/);
  assert.match(html, /item\.direction === "inbound" && \(item\.state === "pending" \|\| item\.state === "delivered"\)/);
  assert.match(html, /const generationKey = `\$\{surface\}:\$\{chatId\}`/);
  assert.match(html, /canonicalReadGeneration\.get\(generationKey\) !== generation/,
    "the live poll cannot submit the same surface-qualified read generation every second");
  assert.doesNotMatch(html, /canonicalReadGeneration\.(?:get|set|delete)\(chatId\)/,
    "one surface's generation cannot suppress another surface's read persistence");
  assert.match(html, /canonicalChatDetails\.set\(chatId, opened\)/,
    "the visible transcript becomes read optimistically instead of flickering until Slack returns");
  assert.match(html, /return window\.relay\.canonicalChatRead\?\.\(chatId, options\)/,
    "the preload call carries the surface-qualified read options");
  assert.match(html, /persistCanonicalChatRead\(chatId, \{ surface, includeSlack:true \}\)/,
    "the visible surface and reveal state qualify the canonical cursor advance");
  assert.match(html, /if \(!id\.startsWith\("relay_"\)\) continue/,
    "canonical message ids never enter the legacy per-delivery acknowledgment path");
  const reconcile = html.slice(
    html.indexOf("function reconcileCanonicalChatResult("),
    html.indexOf("function syncSlackVisibilityButton(", html.indexOf("function reconcileCanonicalChatResult(")),
  );
  assert.match(reconcile, /if \(changed\) renderThreadDetail\(\);\s*if \(readVisible\) readVisibleChatRoom\(\);/,
    "a Slack arrival that paints into the open channel is immediately treated as read");
});

test("automatic chat reads require recent system-wide activity without requiring Relay focus", () => {
  assert.match(preload, /chatReadActivity: \(\) => ipcRenderer\.send\("relay:chatReadActivity"\)/);
  assert.match(html, /\["pointerdown", "keydown", "wheel"\][\s\S]*window\.relay\.chatReadActivity/);
  assert.match(main, /CHAT_READ_IDLE_THRESHOLD_SECONDS/);
  assert.match(main, /ipcMain\.handle\("relay:ackMany"[\s\S]*chatReadPresenceIsAvailable\(win\)/);
  assert.match(main, /ipcMain\.handle\("relay:canonicalChatRead"[\s\S]*chatReadPresenceIsAvailable\(win\)/);
  assert.match(main, /interruptChatReadPresence\(\);[\s\S]*requeueActiveAttention\(\)/,
    "sleep and lock invalidate read presence alongside notification presence");
  assert.doesNotMatch(main, /chatReadPresenceIsAvailable[\s\S]{0,500}isFocused/,
    "using another app does not prevent an otherwise visible chat from recording reads");
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
