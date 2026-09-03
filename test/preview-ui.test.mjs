import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildPreview } from "../scripts/build-preview.mjs";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function cssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const end = source.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
  return source.slice(start, end + 1);
}

const inbox = read("../overlay/inbox.html");
const pillPreload = read("../overlay/preload.cjs");
const main = read("../overlay/main.cjs");
const previewHtml = read("../overlay/preview.html");
const previewRenderer = read("../overlay/preview-renderer.js");
const previewPreloadSource = read("../overlay/preview-preload-source.cjs");
const previewPreloadBundle = read("../overlay/preview-preload.cjs");
const hoverIntent = read("../overlay/hover-intent.js");

function inlineFunction(source, name, nextMarker) {
  const definition = between(source, `function ${name}(`, nextMarker).trim();
  return Function(`"use strict"; return (${definition});`)();
}

test("Relay identity rows show the room and latest gist without shortening the reader", () => {
  const arrival = between(inbox, "function relayIdentityRowHtml(identity)", "// ---------- the reader:");
  assert.match(arrival, /const name = identity\.name/);
  assert.match(arrival, /<span class="th-party">\$\{esc\(name\)\}<\/span>/);
  assert.match(arrival, /const gist = relayListGist\(row\.title \|\| row\.body \|\| "Message", 90\)/);
  assert.match(arrival, /\$\{senderPrefix\}\$\{esc\(gist\)\}/);
  assert.match(arrival, /identity\.unreadCount/);
  assert.match(arrival, /class="av-stack"/);
  assert.doesNotMatch(arrival, /threadTitle/);

  const shorten = inlineFunction(inbox, "relayListGist", "// map enums -> humane copy");
  const complete = "Postmark account is still pending approval although DNS is ready and nothing is needed until their team replies";
  const shortened = shorten(complete, 90);
  assert.ok(shortened.length <= 90, `Relay gist is bounded: ${shortened.length}`);
  assert.ok(shortened.endsWith("…"));
  assert.equal(shortened, "Postmark account is still pending approval although DNS is ready and nothing is needed…");
  assert.equal(shorten("One compact message gist", 90), "One compact message gist");
  assert.equal(shorten("AReallyLongUnbrokenLegacyTitle", 12), "AReallyLong…", "an unbroken legacy token still cannot overflow");

  // Both inbound and sent readers still resolve the complete semantic title;
  // relayListGist is deliberately confined to the identity list.
  const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board:");
  const sentReaderProjection = between(inbox, "function readerRow(id)", "const RX_PRIMARY");
  assert.match(reader, /const subject = chatOwnedWork && triggerRow[\s\S]*?: request \? [\s\S]*?relaySubject\(r\)/);
  assert.match(sentReaderProjection, /title: sentSubject\(sent\)/);
  assert.doesNotMatch(reader, /relayListGist/);
  assert.doesNotMatch(sentReaderProjection, /relayListGist/);
});

test("both Relay documents render the complete document system", () => {
  const markdown = between(inbox, "function mdToHtml", "function readerParagraphs");
  const reader = between(inbox, "function renderReader()", "// ---------- the Tasks board:");

  assert.match(inbox, /:is\(\.rd-body,\.rd-agentcopy\) \.md-h/);
  assert.match(inbox, /:is\(\.rd-body,\.rd-agentcopy\) \.md-codeblock/);
  assert.match(inbox, /:is\(\.rd-body,\.rd-agentcopy\) \.md-list/);
  assert.match(inbox, /:is\(\.rd-body,\.rd-agentcopy\) \.md-table/);
  assert.match(inbox, /\.md-pre \{[^}]*max-width:100%[^}]*overflow:auto[^}]*white-space:pre/);
  assert.match(markdown, /class="md-codebar"/);
  assert.match(markdown, /data-code-wrap/);
  assert.match(markdown, /data-code-copy/);
  assert.match(reader, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(reader, /classList\.toggle\("wrap"\)/);
  assert.match(reader, /your agent receives both the “for you” and “for your agent” parts/);
  assert.doesNotMatch(reader, /this one verbatim/);

  // Long legacy headlines remain readable while new sends are corrected at
  // composition time; the complete stored title is not silently discarded.
  assert.match(reader, /subject\.length > 120 \? " long very-long"/);
  assert.doesNotMatch(reader, /relayListGist\(subject/);
});

test("Preview opens the reader IN THE PILL, never the pre-redesign window", () => {
  // preview.html is the surface the redesign replaced. Every path that reached
  // it dropped the reader back into the old design mid-session (David, live:
  // "what the fuck is this? This is the old design"), so the pill's own rows
  // open the pill's reader and nothing here opens a window.
  assert.match(inbox, /data-preview="\$\{esc\(id\)\}"/);
  assert.match(inbox, /openReader\(id, "relays"\)/);
  assert.doesNotMatch(inbox, /window\.relay\.preview\(/);

  // The IPC itself stays — main still opens the preview window for the surfaces
  // that legitimately own it; the pill simply stops pointing at it.
  assert.match(pillPreload, /preview:\s*\(id\)\s*=>\s*ipcRenderer\.send\("relay:preview", id\)/);
  const handler = between(main, 'ipcMain.on("relay:preview"', 'ipcMain.on("relay:preview:ready"');
  assert.match(handler, /openPreview\(id\)/);
});

test("thread preview and provider actions keep their source direction explicit", () => {
  assert.match(inbox, /data-thread-preview="\$\{esc\(id\)\}"/);
  const footer = between(inbox, "function relayHostActionsHtml", "// ---- the thread reply composer");
  assert.match(footer, /message && message\.direction === "out" \? "sent" : "relay"/);
  assert.match(footer, /data-source="\$\{source\}"/);
  const wire = between(inbox, "function wireHostOpen", "// Before 0.1.290");
  assert.match(wire, /loadSessionPicker\(id, host, relaySubject\(message\) \|\| "Relay", null, source\)/);
});

test("older Relay provider rows use explicit hover intent, keyboard and touch disclosure", () => {
  assert.match(inbox, /<script src="\.\/hover-intent\.js"><\/script>/);
  assert.doesNotMatch(inbox, /\.th-msg:hover \.th-host-actions/);
  assert.match(inbox, /\.th-msg\.host-intent-open \.th-host-actions/);
  assert.match(inbox, /data-host-disclosure/);
  assert.match(inbox, /@media \(hover:none\), \(pointer:coarse\)/);
  assert.match(inbox, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(hoverIntent, /scrollQuietMs:\s*220/);
  assert.match(hoverIntent, /postScrollMovePx:\s*4/);
  assert.match(hoverIntent, /seamDwellMs:\s*180/);
  assert.match(hoverIntent, /bodyDwellMs:\s*420/);
  assert.match(hoverIntent, /exitGraceMs:\s*240/);
});

test("preview document keeps the high-level title before the scrollable Markdown detail", () => {
  for (const id of ["messageTitle", "messageBody", "detailScroll", "replyInput", "replyButton"]) {
    assert.equal((previewHtml.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} is unique`);
  }

  const titleAt = previewHtml.indexOf('id="messageTitle"');
  const scrollAt = previewHtml.indexOf('id="detailScroll"');
  const bodyAt = previewHtml.indexOf('id="messageBody"');
  const scrollEndAt = previewHtml.indexOf("</main>", scrollAt);
  const replyAt = previewHtml.indexOf('id="replyInput"');
  assert.ok(titleAt < scrollAt, "the prominent title is outside and before the detail scroller");
  assert.ok(scrollAt < bodyAt && bodyAt < scrollEndAt, "the Markdown body is inside the detail scroller");
  assert.ok(scrollEndAt < replyAt, "the reply composer is pinned outside the detail scroller");

  assert.match(cssRule(previewHtml, ".preview-shell"), /display:flex;\s*flex-direction:column;\s*overflow:hidden/);
  assert.match(cssRule(previewHtml, ".message-head"), /flex:0 0 auto/);
  assert.match(cssRule(previewHtml, ".detail-scroll"), /flex:1 1 auto;\s*min-height:0;\s*overflow:auto/);
  assert.match(cssRule(previewHtml, ".reply-composer"), /flex:0 0 auto/);
});

test("the reply composer starts disabled and only arms once there is something to send", () => {
  const replyButton = previewHtml.match(/<button\b[^>]*\bid="replyButton"[^>]*>/)?.[0] || "";
  assert.match(replyButton, /\sdisabled(?:\s|>)/, "ships disabled, so a dead bridge cannot look live");
  assert.match(replyButton, /aria-disabled="true"/);

  // Arming is conditional on a target and either words or staged files.
  assert.match(previewRenderer, /const ready = hasTarget && !sending && Boolean\(replyInputEl\.value\.trim\(\) \|\| stagedReplyFiles\.length\)/);
  assert.match(previewRenderer, /replyButtonEl\.disabled = !ready/);
  // Enter sends, Shift+Enter keeps writing.
  assert.match(previewRenderer, /if \(event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing\) return/);
});

test("a reply names no recipient: the server addresses it from the message it answers", () => {
  // The renderer may only say WHICH message it is replying to, WHAT it says, and
  // which message this is (for idempotency) — never WHO receives it.
  assert.match(
    previewPreloadSource,
    /sendReply: \(inReplyToRelayId, body, idempotencyKey, files = \[\]\) =>[\s\S]*?inReplyToRelayId: String\(inReplyToRelayId \|\| ""\),[\s\S]*?body: String\(body \|\| ""\),/,
  );
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  // A reply names nobody: the server addresses it from the message it answers,
  // which is what keeps a group reply going to the whole roster. Only the FIRST
  // message of a room opened from a card carries an address (a person) or a
  // roster (a group), and it comes from the window's own entry — never from
  // the renderer, which is told which room it is in and nothing more.
  assert.match(send, /recipient: inReplyToRelayId \? \{\} : to/);
  assert.match(send, /const carried = \(entry && entry\.recipient\) \|\| null/);
  assert.doesNotMatch(send, /input\.recipient|input\.to|input\.email|input\.groupId/);
});

test("a retried reply reuses its idempotency key, so a lost response cannot double-send", () => {
  // The key identifies the MESSAGE, not the attempt: it is minted once when the
  // person hits send and threaded back through retry unchanged.
  assert.match(previewRenderer, /function newIdempotencyKey\(\)/);
  assert.match(previewRenderer, /await deliver\(body, targetId, newIdempotencyKey\(\), payload\.files, payload\.attachments\)/);
  assert.match(previewRenderer, /deliver\(entry\.body, entry\.inReplyToRelayId, entry\.idempotencyKey, entry\.files, entry\.attachments\)/);
  assert.match(previewRenderer, /bridge\.sendReply\(targetId, body, entry\.idempotencyKey, entry\.files\)/);
  // Main honours the renderer's key rather than minting a fresh one per attempt.
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  assert.match(send, /const idempotencyKey = String\(\(input && input\.idempotencyKey\) \|\| ""\) \|\|/);
  assert.match(send, /idempotencyKey,/);
});

test("a sent reply is retired by its own local id, not by a returned relay id", () => {
  // A GROUP send answers with one sibling's id while the transcript collapses
  // the fan-out to a different sibling, so an id match never happens and the
  // optimistic bubble would show forever alongside the real one.
  assert.match(previewRenderer, /outgoing = outgoing\.filter\(\(o\) => o\.state !== "sent"\)/);
  assert.doesNotMatch(previewRenderer, /known\.has\(o\.relayId\)/);
});

test("the preview's privileged channels answer only the preview window", () => {
  for (const channel of ["relay:preview:chat", "relay:preview:reply"]) {
    const handler = between(main, `ipcMain.handle("${channel}"`, "});");
    // Resolving the sender's own entry does the refusing: an event from any
    // other renderer has no entry, and the answer is decided by the window's
    // own record rather than by anything the caller says about itself.
    assert.match(
      handler,
      /const entry = previewEntryForEvent\(event\);\s*\n\s*if \(!entry\) return \{ ok: false, error: "Not the preview window\." \}/,
      `${channel} refuses events from any other renderer`,
    );
  }
  // The pill's own channel is the mirror image: only the pill may ask for a
  // contact's chat, and it asks by address.
  const contactChat = between(main, 'ipcMain.handle("relay:openChatWith"', "});");
  assert.match(contactChat, /event\.sender !== win\.webContents/);
  assert.match(contactChat, /return \{ ok: false, error: "Not the pill\." \}/);
});

test("preview payload is an explicit allowlist and never exposes briefingMarkdown", () => {
  const projector = between(main, "function previewPayloadForPacket", "// Find an approvalId");
  const returnedObject = projector.match(/return\s*\{([\s\S]*?)^\s{2}\};/m)?.[1] || "";
  assert.ok(returnedObject, "preview payload object is present");

  const keys = [...returnedObject.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
  // threadId is the only CONTENT-adjacent addition the conversation face needs:
  // an opaque id the API re-authorises on every call. openFace is not content
  // at all — a two-value verdict computed here from fields already listed.
  assert.deepEqual(keys, [
    "relayId",
    "title",
    "forHuman",
    "senderName",
    "e2ee",
    "createdAt",
    "unread",
    "threadId",
    "openFace",
  ]);
  assert.doesNotMatch(returnedObject, /briefingMarkdown|contentPath|filePath|attachmentUrls|forAgent|\.\.\.row/);
});

test("the conversation face is a second face of the same window, not a second window", () => {
  for (const id of ["faces", "faceMessage", "faceChat", "chatChip", "chatBack", "chatList", "chatScroll"]) {
    assert.equal((previewHtml.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} is unique`);
  }
  // One track carrying both faces, moved by transform — the composer below it
  // never moves, so the two faces turn on it as a hinge.
  assert.match(cssRule(previewHtml, ".faces-track"), /transform:translateX\(0\)/);
  assert.match(previewHtml, /\.faces\.at-chat \.faces-track \{ transform:translateX\(-50%\); \}/);
  // The off-screen face is never focusable or announced.
  assert.match(previewHtml, /\.face\[aria-hidden="true"\] \{ visibility:hidden; \}/);
  assert.match(previewRenderer, /faceChatEl\.setAttribute\("aria-hidden", onChat \? "false" : "true"\)/);

  // Bubbles read the way every messaging app has taught people to read them.
  assert.match(cssRule(previewHtml, ".bubble-row.mine"), /align-self:flex-end/);
  assert.match(cssRule(previewHtml, ".bubble-row.theirs"), /align-self:flex-start/);
  // Names only in a room with more than two people.
  assert.match(previewRenderer, /showAuthor: entry\.isGroup && !entry\.mine && firstOfRun/);
});

test("a chat message opens IN its conversation, not on the reading face", () => {
  // Both projections decide the face; the sent one is the case that sent David
  // to a relay-shaped window for a one-word text he had just typed to Shane.
  const packet = between(main, "function previewPayloadForPacket", "function previewPayloadForSent");
  const sent = between(main, "function previewPayloadForSent", "// Find an approvalId");
  for (const projector of [packet, sent]) assert.match(projector, /openFace: openingFaceFor\(\{/);
  assert.match(main, /require\("\.\/message-face\.cjs"\)/);
  // A typed text is sent UNTITLED — titlelessness is the marker every surface
  // reads, so no compose site may derive a subject from the body again.
  assert.doesNotMatch(main, /titleFromBody/);
  assert.doesNotMatch(main, /function replyTitleFromBody/);

  // The renderer honours the verdict, and only when there is a thread to open.
  assert.match(
    previewRenderer,
    /const opensInChat = text\(row\.openFace\) === "chat" && Boolean\(text\(row\.threadId\)\)/,
  );
  assert.match(previewRenderer, /showFace\(opensInChat \? "chat" : "message", \{ force: true \}\)/);
});

test("opening into a conversation lands on the message that was clicked", () => {
  // Without this a text message sent last week opens at the bottom of a chat
  // that has moved on since, and the message you clicked is nowhere on screen.
  assert.match(previewRenderer, /if \(entry\.relayId\) row\.dataset\.relayId = entry\.relayId/);
  assert.match(previewRenderer, /\.bubble-row\[data-relay-id="\$\{cssEscape\(id\)\}"\]/);
  // The newest message still belongs at the end, where a conversation sits.
  assert.match(previewRenderer, /if \(!target \|\| !target\.nextElementSibling\) \{\s*scrollChatToLatest\(\);/);
  // Only the FIRST placement lands on it; after that the room behaves normally.
  assert.match(previewRenderer, /landed = true;\s*scrollChatToOpened\(\)/);

  // Placement moves the chat scroller and NOTHING else. scrollIntoView scrolls
  // every scrollable ancestor, and the faces track is one of them even at
  // overflow:hidden — it slid the whole conversation out of the window while
  // the DOM still reported it centred. Caught by test/preview-face-probe.mjs.
  assert.doesNotMatch(previewRenderer, /\.scrollIntoView\(/);
  assert.match(previewRenderer, /chatScrollEl\.scrollTop \+= row\.top \+ row\.height \/ 2 - \(view\.top \+ view\.height \/ 2\)/);
});

test("a conversation that will not load hands the message back", () => {
  // The reader opened a message; a failed chat load must not leave them staring
  // at an empty conversation with their message nowhere in the window.
  const loader = between(previewRenderer, "async function loadChat", "// --- The conversation face");
  const failure = between(loader, "if (!result || !result.ok)", "chat = result.chat");
  assert.match(failure, /if \(face === "chat"\) \{\s*showFace\("message"\);/);
  assert.match(failure, /setNote\(/);
  // Same for a message that turns out to have no thread at all.
  assert.match(loader, /if \(!threadId && !chatOnly\) \{[\s\S]*?if \(face === "chat"\) showFace\("message"\);/);
  // A window opened from a contact card has no message to hand back, so the
  // reason is painted where the conversation would be — and the composer stays
  // live, because the person it writes to is known either way.
  assert.match(failure, /if \(chatOnly\) \{[\s\S]*?renderChatState\(failure, true\);[\s\S]*?refreshComposer\(\);[\s\S]*?return;/);
});

test("bubble Markdown goes through the same sanitiser as the reader", () => {
  // Every innerHTML in the renderer is fed by bridge.renderMarkdown, which runs
  // in the isolated preload and returns DOMPurify output.
  const assignments = [...previewRenderer.matchAll(/(\w+)\.innerHTML = (\w+)/g)].map((m) => m[2]);
  // TOOL_ICONS is the one non-sanitizer source: developer-authored, module-level
  // SVG string constants for the session face's activity icons. They must stay
  // static — no interpolation — so no runtime value can ever reach them.
  assert.deepEqual([...new Set(assignments)].sort(), ["html", "safeHtml"]);
  const iconBlock = between(previewRenderer, "const TOOL_ICONS = {", "};");
  assert.doesNotMatch(iconBlock, /\$\{/, "icon constants carry no interpolation");
  const chevronLine = between(previewRenderer, "const ACT_CHEVRON =", ";");
  assert.doesNotMatch(chevronLine, /\$\{/, "chevron constant carries no interpolation");
  assert.match(previewRenderer, /const html = body \? bridge\.renderMarkdown\(body\) : ""/);
  assert.match(previewRenderer, /const safeHtml = markdown \? await Promise\.resolve\(bridge\.renderMarkdown\(markdown\)\) : ""/);
  // Links inside bubbles leave through the audited external-open path.
  assert.match(previewRenderer, /chatScrollEl\.addEventListener\("click"[\s\S]*?bridge\.openExternal\(target\.getAttribute\("href"\)\)/);
});

test("preview Markdown security controls survive into the bundled preload", () => {
  for (const [label, source] of [
    ["source", previewPreloadSource],
    ["bundle", previewPreloadBundle],
  ]) {
    assert.match(source, /html:\s*false/, `${label} disables raw Markdown HTML`);
    assert.match(source, /DOMPurify\.sanitize\(/, `${label} sanitizes parser output`);
    assert.match(source, /markdown\.renderer\.rules\.image\s*=/, `${label} replaces remote images with inert text`);
    assert.match(source, /new Set\(\["https:",\s*"http:",\s*"mailto:"\]\)/, `${label} allowlists external URL schemes`);

    const allowedTags = between(source, "ALLOWED_TAGS: [", "],");
    const forbiddenTags = between(source, "FORBID_TAGS: [", "],");
    assert.doesNotMatch(allowedTags, /["']img["']/i, `${label} never allowlists img`);
    assert.match(forbiddenTags, /["']img["']/i, `${label} explicitly forbids img`);
  }

  assert.match(previewHtml, /img-src 'self' data: blob:/);
  assert.doesNotMatch(previewHtml, /img-src[^;]*(?:https:|file:)/);
  const externalOpen = between(main, "function openPreviewExternal", "function isPreviewEvent");
  assert.match(externalOpen, /new Set\(\["http:",\s*"https:",\s*"mailto:"\]\)/);
});

test("checked-in preview preload is byte-for-byte current with its build source", async () => {
  const result = await buildPreview({ write: false, logLevel: "silent" });
  assert.equal(result.outputFiles.length, 1);
  assert.equal(result.outputFiles[0].text, previewPreloadBundle);
});

test("preview BrowserWindow uses an isolated sandboxed renderer", () => {
  const createWindow = between(main, "function createPreviewWindow", "function openPreview");
  assert.match(createWindow, /preload:\s*path\.join\(__dirname, "preview-preload\.cjs"\)/);
  assert.match(createWindow, /contextIsolation:\s*true/);
  assert.match(createWindow, /nodeIntegration:\s*false/);
  assert.match(createWindow, /sandbox:\s*true/);
});

test("sending waits on the send alone, not on reconciliation the sender cannot see", () => {
  // Every sequential await here costs a full round trip (~1s to App Runner), and
  // the composer says "Sending…" for all of them. Only the send itself is work
  // the person is actually waiting for.
  const send = between(main, "async function sendPreviewReply", "function installActiveSpaceWatcher");
  assert.match(send, /const sent = await client\.sendRelay\(/, "the send itself is awaited");
  // Sent-history and pill-list refreshes are fire-and-forget.
  assert.doesNotMatch(send, /await refreshSent\(\)/);
  assert.doesNotMatch(send, /await pushInbox\(/);
  assert.match(send, /refreshSent\(\)\s*\n\s*\.then\(\(\) => pushInbox\(true\)\)/);

  // The renderer settles the bubble immediately and reconciles in the background.
  assert.doesNotMatch(previewRenderer, /await loadChat\(\{ keepScroll: false \}\)/);
  assert.match(previewRenderer, /if \(face === "chat"\) renderChat\(\);\s*\n\s*loadChat\(\{ keepScroll: true \}\)\.catch/);
});

test("an open conversation shows new mail without being reopened", () => {
  // Without this the chat face is a transcript frozen at open time: a message
  // arriving while you are reading never appears.
  const push = between(main, "if (force || sig !== lastSig)", "pumpAttention(payload)");
  // Each open preview is reading its own conversation, so each is nudged — and
  // only ones whose renderer is actually listening.
  assert.match(push, /for \(const entry of livePreviews\(\)\)/);
  assert.match(push, /if \(!entry\.rendererReady\) continue/, "only when a live preview can receive it");
  assert.match(push, /entry\.win\.webContents\.send\("relay:preview:mail"\)/);

  // The nudge carries no data, so no third party's mail crosses the bridge.
  assert.match(previewPreloadSource, /onMail: \(callback\) =>[\s\S]*?const listener = \(\) => callback\(\);/);
  assert.doesNotMatch(previewPreloadSource, /relay:preview:mail", \(_event, [a-z]/i);

  // The renderer re-reads the conversation, and never races an in-flight send.
  // A contact's window has no thread of its own and must refresh all the same.
  assert.match(
    previewRenderer,
    /bridge\.onMail\(\(\) => \{[\s\S]*?if \(sending \|\| \(!text\(content\.threadId\) && !chatOnly\)\) return;[\s\S]*?loadChat\(\{ keepScroll: true \}\)/,
  );
});

// Previews are documents, not one reused pane. The singleton this replaced meant
// previewing a second relay evicted the first — including one parked in the Dock.
test("previews are per-relay windows: a new relay adds one, the same relay raises its own", () => {
  // No module-level current-window state left to clobber; windows live in a map.
  assert.match(main, /^const previews = new Map\(\);$/m);
  assert.doesNotMatch(main, /^let previewWin = null;$/m);
  assert.doesNotMatch(main, /^let previewPayload = null;$/m);

  const openPreview = between(main, "function openPreview(", "async function openChatWithContact");
  // An unseen relay gets its OWN window; nothing existing is touched.
  assert.match(openPreview, /const existing = previewEntryFor\(previewKeyFor\(nextPayload\)\)/);
  assert.match(openPreview, /if \(!existing\) \{[\s\S]*createPreviewWindow\(nextPayload\)/);
  // A relay that already has a window raises that one instead of duplicating it.
  assert.match(openPreview, /sendPreviewPayload\(existing\)[\s\S]*showPreviewWindow\(existing\)/);

  // What a window is FOR is its key: a relay, or the chat a contact card opened.
  // The two id spaces cannot collide, so one map holds both kinds.
  const keyFor = between(main, "function previewKeyFor(payload)", "\n}\n");
  assert.match(keyFor, /const relayId = String\(payload\.relayId \|\| ""\);\s*\n\s*if \(relayId\) return relayId;/);
  assert.match(keyFor, /return String\(payload\.chatId \|\| ""\);/);

  // Each window registers itself and deregisters only its own entry, so a close
  // racing a reopen cannot evict the newer window.
  const createWindow = between(main, "function createPreviewWindow", "function openPreview(");
  assert.match(createWindow, /previews\.set\(key, entry\)/);
  assert.match(createWindow, /if \(previews\.get\(key\) === entry\) previews\.delete\(key\)/);
  // Two windows must not stack exactly: each takes a free cascade slot.
  assert.match(createWindow, /const slot = nextCascadeSlot\(\)/);
});

// With several previews up, an IPC message must act on the window that sent it.
// Routing to "the" preview would minimize or close a window the user never touched.
test("preview IPC acts on the window that sent it, never on a shared current one", () => {
  for (const channel of ["relay:preview:ready", "relay:preview:rendered", "relay:preview:minimize", "relay:preview:close"]) {
    const handler = between(main, `ipcMain.on("${channel}"`, "});");
    assert.match(handler, /previewEntryForEvent\(event\)/, `${channel} resolves its sender`);
    assert.doesNotMatch(handler, /\bpreviewWin\b/, `${channel} has no shared-window reference`);
  }
  // Read receipts are per-window too: each tracks the relay IT rendered.
  const rendered = between(main, 'ipcMain.on("relay:preview:rendered"', "});");
  assert.match(rendered, /id !== entry\.payload\.relayId \|\| id === entry\.renderedRelayId/);
  // A theme flip reaches every open preview, not just one.
  const theme = between(main, 'ipcMain.on("relay:theme"', "});");
  assert.match(theme, /for \(const entry of livePreviews\(\)\)/);
});

test("a rendered conversation marks every visible inbound message read", () => {
  assert.match(previewPreloadSource, /renderedChat: \(ids\) => ipcRenderer\.send\([\s\S]*?relay:preview:chat-rendered/);
  assert.match(previewRenderer, /renderedUnreadIds = entries[\s\S]*?bridge\.renderedChat\(renderedUnreadIds\)/);
  const loader = between(main, "async function previewChat(entry, threadId)", "/**\n * Send a reply");
  assert.match(loader, /item\.direction === "inbound" && item\.state === "delivered"/);
  const handler = between(main, 'ipcMain.on("relay:preview:chat-rendered"', 'ipcMain.on("relay:preview:minimize"');
  assert.match(handler, /previewEntryForEvent\(event\)/);
  assert.match(handler, /chatReadPresenceIsAvailable\(entry\.win\)/,
    "a minimized, sleeping, locked, or long-idle preview cannot claim a read");
  assert.match(handler, /entry\.chatUnreadRelayIds\.has\(id\)/);
  assert.match(handler, /client\.markManyRead\(remoteOnly/);
  assert.match(handler, /source: "relay_pill_open"/);
  // POST /v1/inbox/read is a no-op compatibility shim. A human read routed
  // through it answers 200, updates nothing, and never reaches the sender.
  assert.doesNotMatch(handler, /markInboxRead/);
  assert.match(handler, /if \(rowById\(id\)\) \{[\s\S]*?ackPacket\(id\)/);
});


test("the Task face offers a local Review Safety before one-click Start task", () => {
  assert.match(previewHtml, /id="safetyButton"[^>]*>Review Safety<\/button>/);
  assert.match(previewHtml, /id="safetyPanel"/);
  assert.match(previewPreloadSource, /reviewSafety:[\s\S]*relay:preview:reviewSafety/);
  assert.match(previewPreloadBundle, /relay:preview:reviewSafety/);
  const reviewHandler = between(main, 'ipcMain.handle("relay:preview:reviewSafety"', "});");
  assert.match(reviewHandler, /id !== String\(entry\.relayId/);
  assert.match(reviewHandler, /reviewRequestSafetyById/);
  assert.match(previewRenderer, /async function reviewSafety\(\)/);
  assert.match(previewRenderer, /plainLanguage/);
  // The current pill reader, not only the retired standalone preview, carries
  // the two-button consent surface.
  assert.match(inbox, /data-request-safety/);
  assert.match(inbox, />Review Safety<\/button>/);
  assert.match(inbox, /label: failed \? "Retry" : state === "stopped" \? "Start again" : "Start task"/);
  assert.match(pillPreload, /relay:requestReviewSafety/);
});

test("a consequential Task result waits on the recipient device before encrypted release", () => {
  assert.match(main, /candidate\.assessment\?\.level !== "none"/);
  assert.match(main, /completionReview/);
  assert.match(main, /releaseProviderCompletion/);
  assert.match(inbox, />Send result<\/button>/);
  assert.match(inbox, /data-result-send/);
  assert.match(pillPreload, /relay:requestCompletionSend/);
});

test("the task face declares itself and its runtime in the document", () => {
  assert.match(previewHtml, /id="taskChip"/);
  assert.match(previewHtml, /id="taskState"/);
  assert.match(previewHtml, /id="runtimePop"/);
  assert.match(previewHtml, /data-rt-model="claude-opus-5"/);
  cssRule(previewHtml, ".task-chip");
  cssRule(previewHtml, ".runtime-pop");
  // Codex is offered only when detected; the projector says whether it is.
  assert.match(main, /codex: Boolean\(codexCliPath\(\) \|\| appInstalled\("Codex"\) \|\| appInstalled\("ChatGPT"\)\)/);
  assert.match(previewRenderer, /rtCodexItemEl\.disabled = !codexAvailable/);
});

test("the session face reads through the audited transcript reader, preview-only", () => {
  // Main: the feed resolves the forged session and never spreads a row.
  const feed = between(main, "async function previewTaskSession", "async function previewTaskLiveState");
  assert.match(feed, /import\("\.\.\/src\/ai-session-transcript\.js"\)/);
  assert.match(feed, /nativeRef: \{ transcriptPath: claudePath \}/);
  assert.match(feed, /nativeRef: \{ sessionPath: codexPath \}/);
  // Both new channels answer only the preview window.
  for (const channel of ["relay:preview:session", "relay:preview:steer"]) {
    const handler = between(main, `ipcMain.handle("${channel}"`, "});");
    assert.match(handler, /isPreviewEvent\(event\)/);
  }
  // Steer goes to the LIVE socket, never to the sender.
  const steer = between(main, "async function previewTaskSteer", "function installActiveSpaceWatcher");
  assert.match(steer, /sendClaudeSocket/);
  assert.doesNotMatch(steer, /sendRelay|sendPreviewReply/);
  // Preload bridges exist and the bundle carries them.
  assert.match(previewPreloadSource, /loadSession: \(relayId\)/);
  assert.match(previewPreloadBundle, /relay:preview:session/);
});

test("a live Claude socket needs recent native activity and stale sockets stop honestly", () => {
  const liveState = between(main, "async function previewTaskLiveState", "// Steer/follow-up");
  assert.match(liveState, /if \(!match \|\| !match\.socketLive\) return "offline"/);
  assert.match(liveState, /Date\.now\(\) - lastActivityAt <= 90_000 \? "active" : "stalled"/);
  const steer = between(main, "async function previewTaskSteer", "function installActiveSpaceWatcher");
  assert.match(steer, /if \(newTurn && match && match\.socketLive\)/);
  assert.match(steer, /process\.kill\(pid, "SIGTERM"\)/);
  assert.match(steer, /continueClaudeDesktopCodeSession/);
});



test("provider materialization state reaches both inbound and sent conversation rows", () => {
  assert.match(main, /materializedCodex: Boolean\(p\.codexThreadId \|\| p\.sessionBinding\?\.provider === "codex"\)/);
  assert.match(main, /materializedClaude: Boolean\(p\.claudeNativeSession\?\.sessionId \|\| p\.sessionBinding\?\.provider === "claude"\)/);
  assert.doesNotMatch(main, /materializedCodex: Boolean\(p\.materializedSurfaces/);
  assert.doesNotMatch(main, /materializedClaude: Boolean\(p\.materializedSurfaces/);
  assert.match(main, /function sentWithMaterializationState/);
  assert.match(main, /packets\[`sent_\$\{relayId\}`\]/);
  assert.match(main, /materializedCodex: Boolean\(row\.codexThreadId \|\| row\.sessionBinding\?\.provider === "codex"\)/);
  assert.match(main, /materializedClaude: Boolean\(row\.claudeNativeSession\?\.sessionId \|\| row\.sessionBinding\?\.provider === "claude"\)/);
  const inbound = between(inbox, "for (const r of payload.relays", "// A self-send exists");
  const sent = between(inbox, "for (const s of payload.sent", "const canonicalIds");
  assert.match(inbound, /materializedCodex: Boolean\(r\.materializedCodex\)/);
  assert.match(sent, /materializedClaude: Boolean\(s\.materializedClaude\)/);
});

test("Codex runner uses native activity labels and native completion truth", () => {
  const feed = between(main, "async function taskRunFeed", "const providerCompletionInflight");
  assert.match(feed, /codexAppServerActivity/);
  assert.match(feed, /codexRuntimeSessionRef\.logPath/);
  assert.match(feed, /codexRuntimeSessionRef\.turnId/);
  assert.doesNotMatch(feed, /session\.nativeCompletedAt/, "legacy polling cannot bypass canonical terminal reconciliation");
  assert.match(main, /canonicalProviderCompletionCandidate/);
  assert.match(previewRenderer, /activity\.activeVerb/);
  assert.match(previewRenderer, /activity\.doneVerb/);
});

test("the session document stays calm: evidence collapsed, no spinners, one bubble", () => {
  // Disclosure bodies render only when opened; the chevron does not exist
  // until hover or open.
  assert.doesNotMatch(previewHtml, /\.act-body\s*\{/);
  assert.match(cssRule(previewHtml, ".session-activity-body"), /height:0/);
  const chev = cssRule(previewHtml, ".act-chev");
  assert.match(chev, /opacity:0/);
  // Live state is the cadenced shimmer on the words, not a spinner.
  cssRule(previewHtml, ".native-cadenced-shimmer");
  assert.match(previewHtml, /@keyframes nativeCadencedSweep/);
  // The renderer accepts only the main-owned canonical presentation; seeded
  // legacy reader records never enter its DOM path.
  assert.match(previewRenderer, /run\?\.presentation \|\| run\?\.workPresentation/);
  assert.doesNotMatch(previewRenderer, /seedDropped = true;/);
  // Typed activities use reducer-authored active/done verbs.
  assert.match(previewRenderer, /activity\.activeVerb/);
  assert.match(previewRenderer, /activity\.doneVerb/);
  // The composer's verb follows the session: Steer while live, Send when done.
  assert.match(previewRenderer, /"Steer the current turn…"/);
  assert.match(previewRenderer, /done \? "Send" : "Steer"/);
});




test("streaming prose is coalesced to one DOM mutation per animation frame", () => {
  assert.match(previewRenderer, /_sessionPendingText/);
  assert.match(previewRenderer, /_sessionMarkdownFrame = requestAnimationFrame/);
});


test("a For-you Task reply is optimistic correspondence and remains in the person's conversation", () => {
  const reader = between(inbox, "if (!onAgent) {", "const oc = readerBodyEl.querySelector");
  assert.match(reader, /optimisticChatReplies\.set\(idempotencyKey/);
  assert.match(reader, /request:false/);
  // The reply is handed to the device's send queue, which is what carries it
  // across a dead connection; the canonical relayId arrives later, on the
  // payload, through syncOutboxProjection. The reader no longer waits for a
  // send response to stamp it.
  assert.match(reader, /optimistic\.outboxId = String\(res\.entry\.id \|\| idempotencyKey\)/);
  assert.match(reader, /optimisticChatReplies\.delete\(idempotencyKey\)/, "only a device that cannot hold the message removes the row");
  const sentProjection = between(inbox, "for (const s of payload.sent", "const canonicalIds");
  assert.doesNotMatch(sentProjection, /!request && onRequestThread/, "ordinary human replies are not hidden merely because they answer a Task");
  assert.doesNotMatch(sentProjection, /isCompletionRelay\(s\).*continue/, "completion Relays remain in the conversation");
  assert.match(sentProjection, /const sentTextLike = request \? false : ownedAgent \|\| relayTextLike/, "completion keeps the ordinary Relay classifier");
});

test("Work images reach Codex as attachments and stay visible through reconciliation", () => {
  const files = between(inbox, "async function composerFilePayloads", "function fmtBytes");
  const steer = between(main, "async function previewTaskSteer", "function installActiveSpaceWatcher");
  assert.match(files, /window\.relay\.pathForFile/);
  assert.match(files, /contentBase64/);
  assert.match(files, /URL\.createObjectURL/);
  assert.match(steer, /stageCodexLocalImages\(files\)/);
  assert.match(steer, /localImages,/);
});


test("the Relay AI session surface uses the same Codex completed-turn contract", () => {
  const session = between(previewRenderer, "function renderSession", "async function pollSession");
  assert.match(cssRule(previewHtml, ".agent-prose"), /font-size:14px; line-height:21px/);
  assert.match(cssRule(previewHtml, ".act-sum"), /font-size:14px; line-height:21px/);
  assert.match(cssRule(previewHtml, ".session-final"), /font-size:14px; line-height:21px/);
  assert.match(previewHtml, /animation:sessionFade \.18s cubic-bezier\(\.33,1,\.68,1\)/);
  assert.match(session, /updateSessionDisclosure/);
  assert.match(session, /RelayWorkUI\.partitionTurn\(turn\)/);
  assert.match(session, /RelayWorkUI\.partitionTurn\(turn\)/);
  assert.doesNotMatch(session, /className = "session-worked"/);
  assert.match(session, /RelayWorkUI\.partitionTurn\(turn\)/);
  assert.match(session, /node\.className = "session-divider"/);
  assert.match(session, /updateSessionMarkdown\(node, block\.unit, "session-final"\)/);
  assert.doesNotMatch(previewRenderer, /markSessionSegment/);
  assert.ok(session.indexOf("session-divider") < session.indexOf("session-final"), "divider precedes the separate final answer");
});







test("no <p> in the preview contains a block child, so nothing escapes its own hide class", () => {
  // A parser auto-closes <p> at the first block-level child, ejecting that
  // child AND every following sibling out of the paragraph. When the paragraph
  // is the element carrying `gone`, the ejected nodes render unconditionally —
  // which is exactly how the task runtime caption's trailing sentence leaked
  // into every preview, and how the runtime popover lost its .rt-anchor.
  const blockTags = "div|p|ul|ol|li|section|main|header|footer|article|h[1-6]|table|form|pre|blockquote";
  for (const [label, source] of [["preview.html", previewHtml], ["inbox.html", inbox]]) {
    const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)];
    for (const [, inner] of paragraphs) {
      const offenders = inner.match(new RegExp(`<(${blockTags})\\b`, "g")) || [];
      assert.deepEqual(offenders, [], `${label}: a <p> contains block children ${offenders.join(", ")}`);
    }
  }
  // And the caption specifically is a div that still wears the reply-note look.
  assert.match(previewHtml, /<div class="reply-note runtime-note gone" id="taskRuntimeNote">/);
  const caption = between(previewHtml, 'id="taskRuntimeNote"', "</div>\n    </footer>");
  assert.match(caption, /id="runtimePop"/, "the popover stays inside the caption");
  assert.match(caption, /on your machine/, "the trailing sentence stays inside the caption");
});



test("Cowork Start owns a remote session, feed, Steer, and honest terminal state", () => {

  const feed = between(main, "async function previewTaskSession", "async function previewTaskSteer");
  assert.match(feed, /readCoworkSession/);
  assert.match(feed, /coworkEventsToRecords/);
  assert.match(feed, /coworkSessionLifecycle/);
  const coworkRefresh = between(feed, "updateStagedPacket(id, {", "});");
  assert.doesNotMatch(coworkRefresh, /taskCompletedAt|workCompletedAt/, "legacy Cowork polling never persists settlement");
  assert.doesNotMatch(feed, /providerCompletionCandidate\(/, "legacy transcript reads never derive Task settlement");
  assert.match(main, /providerCompletionIdempotencyKey/);
  const monitor = between(main, "async function settleCanonicalWorkEnvelope", "function workEventAuthorized");
  assert.match(monitor, /canonicalProviderCompletionCandidate/);
  assert.match(monitor, /updateStagedPacket\(id, \{ \[completedField\]: candidate\.completedAt, \.\.\.\(isRequest \? \{ taskState: "completed" \} : \{\}\) \}\)/);
  assert.ok(monitor.indexOf("updateStagedPacket") < monitor.indexOf("queueProviderCompletionBridge"), "local Done persists before the fallible wire receipt");
  assert.match(monitor, /ensureCanonicalCompletionMonitor/);
  assert.match(monitor, /startedAt/);
  assert.match(monitor, /expectedProviderTurnId/);
  assert.match(monitor, /hasWireCompletionTarget\(id\)/, "local-only proof ids become Done without an impossible wire retry");
  assert.match(main, /\.then\(\(\) => reconcileCanonicalCompletionMonitors\(\)\)/, "restart recovery is main-owned, not renderer polling");
  const bridge = between(main, "async function bridgeProviderCompletion", "// \"Is the agent working right now?\"");
  assert.match(bridge, /recipient: \{\}/);
  assert.match(bridge, /inReplyToRelayId: key/);
  assert.match(bridge, /type: "completion"/);
  assert.match(bridge, /key\.startsWith\("egmsg_"\)[\s\S]*client\.taskCompleted\(key/);
  assert.match(bridge, /sent\?\.taskClaim[\s\S]*taskClaim: sent\.taskClaim/);
  assert.match(bridge, /providerCompletionRelayId/);
  const steer = between(main, "async function previewTaskSteer", "function installActiveSpaceWatcher");
  assert.match(steer, /appendCoworkMessage/);

});

test("a completion send failure cannot withhold local native Done", () => {
  const settle = between(main, "async function settleCanonicalWorkEnvelope", "async function ensureCanonicalCompletionMonitor");
  const delivery = between(main, "async function bridgeProviderCompletion", "// \"Is the agent working right now?\"");
  const retry = between(main, "function queueProviderCompletionBridge", "async function bridgeProviderCompletion");
  assert.ok(settle.indexOf("updateStagedPacket") < settle.indexOf("queueProviderCompletionBridge"));
  const sentAt = delivery.indexOf("await client.sendRelay");
  assert.ok(sentAt >= 0 && delivery.slice(sentAt).indexOf("providerCompletionRelayId") >= 0, "wire receipt is persisted only after delivery succeeds");
  assert.match(retry, /\.catch\(\(error\) =>/);
  assert.match(retry, /providerCompletionRetryTimers\.set/);
});




test("Settings exposes complete subscription connection management for Claude Code and Codex", () => {
  assert.match(inbox, />Connections</);
  assert.doesNotMatch(inbox, /Relay uses each app's local profile\. Your credentials stay with the app\./);
  assert.doesNotMatch(inbox, /This Mac's existing local profile/);
  assert.match(inbox, /data-provider-connect="\$\{id\}"/);
  assert.match(inbox, /item\.connected\s*\? "Connected"/);
  assert.match(inbox, /"Sign in to Claude Code" : "Sign in to Codex"/);
  assert.match(inbox, /"Use Claude subscription" : "Use ChatGPT subscription"/);
  assert.doesNotMatch(inbox, /Connect local profile/);
  assert.doesNotMatch(inbox, /data-provider-refresh|Refresh status/);
  assert.doesNotMatch(inbox, /data-provider-open|Open \$\{esc\(item\.label\)\}/);
  assert.match(inbox, /Local MCPs/);
  assert.match(inbox, /Connected apps/);
  assert.match(inbox, /MCPs and account connectors/);
  assert.match(inbox, /const list = values\.map\(\(entry\) =>/);
  assert.match(inbox, /sv-provider-list sv-agent-provider-list/);
  assert.match(inbox, /data-provider-details="\$\{esc\(id\)\}"/);
  assert.match(inbox, /aria-controls="svProviderDetail-\$\{esc\(id\)\}"/);
  assert.match(inbox, /claudeCodeMark\.svg/);
  assert.match(inbox, /codexMark\.svg/);
  assert.match(inbox, /healthy \? countLabel : status/);
  assert.doesNotMatch(inbox, /<span class="sv-provider-status">\$\{esc\(requirement\)\}<\/span>/);
  assert.doesNotMatch(inbox, /data-provider-integrations|providerIntegrationsDialogHtml|sv-integration-more/);
  assert.match(inbox, /data-provider-enable="\$\{id\}"/);
  assert.match(inbox, /Disabled for Tasks/);
  assert.match(inbox, /window\.addEventListener\("focus", \(\) => \{[\s\S]*activeView === "settings"[\s\S]*loadSettings\(\)/);
  assert.match(inbox, /document\.addEventListener\("visibilitychange"[\s\S]*document\.visibilityState === "visible"[\s\S]*loadSettings\(\)/);
  assert.match(pillPreload, /providerAuthStatus: \(\) => ipcRenderer\.invoke\("relay:providerAuthStatus"\)/);
  assert.match(pillPreload, /providerInventory:[\s\S]*relay:providerInventory/);
  assert.match(pillPreload, /providerAuthConnect/);
  assert.doesNotMatch(pillPreload, /providerAuthOpen/);
  assert.match(pillPreload, /providerAuthSetEnabled/);
  assert.match(main, /ipcMain\.handle\("relay:providerAuthStatus"/);
  assert.match(main, /ipcMain\.handle\("relay:providerInventory"/);
  assert.match(main, /ipcMain\.handle\("relay:providerAuthConnect"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("relay:providerAuthOpen"/);
  assert.match(main, /ipcMain\.handle\("relay:providerAuthSetEnabled"/);
  const settingsLoad = between(inbox, "async function loadSettings", "// Provider state is live product state");
  assert.match(settingsLoad, /const accountTask/);
  assert.match(settingsLoad, /providerInventory\(\{ refresh:false \}\)/);
  assert.match(settingsLoad, /refreshProviderInventory\(\{ seq \}\)/);
  assert.doesNotMatch(settingsLoad, /Promise\.all\(\[\s*window\.relay\.accountInfo[\s\S]*providerAuthStatus/);
});


test("ordinary window focus survives reader refreshes and run retries invalidate stale polls", () => {
  const dress = between(inbox, "function dressComposer", "let readerSource");
  const reader = between(inbox, "function renderReader", "// ---------- the Tasks board");
  assert.doesNotMatch(dress, /setFocusable/);
  assert.doesNotMatch(reader, /setFocusable/);
});


test("terminal request status shares the centered runner and composer measure", () => {
  assert.match(inbox, /\.request-terminal-status \{ width:100%; max-width:34em; margin:0 auto 4px;/);
  assert.match(inbox, /\.request-terminal-status[^}]*text-align:center/);
  assert.match(inbox, /class="request-terminal-status\$\{inline \? " inline" : ""\}"/);
  assert.doesNotMatch(inbox, /Didn't finish[^`]*reader-from/);
});

test("the session face's state words never claim more than the machine knows", () => {
  const session = between(previewRenderer, "function sessionEntries", "function acceptSessionResult");
  assert.match(session, /RelayWorkUI\.normalizeConversationView/);
  assert.match(session, /RelayWorkUI\.partitionTurn\(turn\)/);
  assert.doesNotMatch(session, /workedForLabel|taskStartedAt|taskCompletedAt/);
  assert.doesNotMatch(session, /a moment|Starting the session|Paused — steer/);
});

test("the agent folder has no human reply button and never crashes control wiring", () => {
  const reader = between(inbox, "function renderReader()", "function renderTasksBoard()");
  assert.match(reader, /const send = document\.getElementById\("qrSend"\)/);
  assert.match(reader, /const input = document\.getElementById\("qrInput"\)/);
  assert.match(reader, /if \(send && input\) \{[\s\S]*?send\.addEventListener\("click", doSend\);[\s\S]*?dressComposer\(input, doSend\);[\s\S]*?\}/);
});
