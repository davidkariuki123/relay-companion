import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Sven's room-reading laws — re-landed on 0.1.227 after the PR #229
// integration kept the product-contract half and left these out. Each pin
// carries its origin and the failure it guards. A law nobody pins is a law
// the next refactor loses: this exact file was deleted wholesale in that
// integration, and every behavior it protected silently went with it.

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, "../overlay/inbox.html"), "utf8");

test("the renderer script parses", () => {
  // A dropped brace once shipped a dead blank pill past 876 green tests,
  // because the suite regexes the source and never parses it. Seatbelt.
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, "inbox.html contains its renderer script");
  assert.doesNotThrow(() => new Function(script[1]));
});

test("a relay tap lands in the glance frame; only Chat-sourced opens earn the split", () => {
  // Sven: "intuitively it should be the other way around... the left side
  // with people, groups and all of that seems redundant if you just want to
  // see the message." Compact by default, ⤢ Expand opt-in; David's law for
  // Chat rooms untouched (openRoom asserts it; options.expanded still wins).
  const open = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  assert.match(open, /chatExpanded = options\.expanded === undefined \? source === "chat" : Boolean\(options\.expanded\)/);
  assert.doesNotMatch(open, /chatExpanded = false;/);
});

test("every room entry follows newest through every asynchronous hydration phase", () => {
  const open = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  const resetAt = open.indexOf("threadDetailScrolledFor = null;");
  const selectAt = open.indexOf("threadDetailId = roomCoordinate;");
  assert.ok(resetAt >= 0 && resetAt < selectAt, "entry rearms scrolling before selecting even the same room id");
  assert.match(open, /const entryFollowToken = beginThreadEntryFollow\(roomCoordinate\)/);
  assert.match(open, /let canonicalDetailReady = Promise\.resolve\(null\)/);
  assert.match(open, /canonicalDetailReady = requestCanonicalChatDetail\(room, source, \{ includeSlack \}\)/,
    "a cold Slack transcript remains part of the guarded room entry");
  assert.match(open, /hydrateThreadEntry\(entryFollowToken, \{[\s\S]*includeSent:source !== "slack",[\s\S]*detailReady:canonicalDetailReady/,
    "both outbound and canonical hydration are handed to the entry-follow latch");

  const render = html.slice(html.indexOf("function renderThreadDetail()"), html.indexOf('document.getElementById("thExpand")'));
  assert.match(render, /const entryFollowToken = threadEntryFollowToken\(\)/);
  assert.match(render, /if \(threadDetailScrolledFor !== thread\.threadId \|\| followOwnSend \|\| followLiveAgent \|\| entryFollowToken\)/);
  assert.match(render, /else if \(threadDetailScrolledFor !== thread\.threadId \|\| entryFollowToken\)/);
  assert.match(render, /if \(entryFollowToken \|\| followLiveAgent\) scrollRoomToNewest\(chatShaped\);/);
  assert.match(render, /if \(entryFollowToken\) scrollRoomToNewest\(chatShaped\);/,
    "entry hydration pins synchronously before a backgrounded Electron window can defer paint");
  assert.match(render, /threadEntryFollowToken\(\) !== entryFollowToken/,
    "a stale callback cannot pull a reader back down after deliberate scrolling");

  const entryFollow = html.slice(html.indexOf("function beginThreadEntryFollow("), html.indexOf("function captureRoomScroll("));
  assert.match(entryFollow, /Promise\.allSettled\(\[sentReady, fontsReady, detailReady\]\)\.then\(\(\) => settleThreadEntryFollow\(token\)\)/);
  assert.match(entryFollow, /afterRoomViewTransition\(\(\) => \{/,
    "the final pin waits for any deferred transcript render behind the room transition");
  assert.match(entryFollow, /requestAnimationFrame\(\(\) => requestAnimationFrame/,
    "the final bottom pin waits for hydrated DOM and layout");
  assert.match(entryFollow, /threadDetailEntryFollow = null/,
    "entry following is temporary; normal polling preserves the reading position afterward");
  assert.match(entryFollow, /\["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "\]/,
    "explicit reader navigation interrupts entry following");

  const back = html.slice(html.indexOf('thBackEl.addEventListener("click"'), html.indexOf("let threadsSource"));
  assert.match(back, /threadDetailScrolledFor = null;/);

  const close = html.slice(html.indexOf("function closeReader()"), html.indexOf("// Paragraph-level rendering"));
  assert.ok(close.indexOf("openThreadDetail(") < close.indexOf("requestAnimationFrame("));
  assert.match(close, /requestAnimationFrame\(\(\) => \{[\s\S]*?restoreRoomScroll\(back\.roomScroll\)/);

  for (const start of ["function ghostArrival(row)", "// New relays always enter the notification stack"]) {
    const banner = html.slice(html.indexOf(start), html.indexOf("commitNavigation({ outerScrollTop: 0 });", html.indexOf(start)) + 48);
    assert.match(banner, /activeView = "relays";[\s\S]*?commitNavigation\(\{ outerScrollTop: 0 \}\);/);
  }
});

test("delayed canonical detail cannot release entry-follow before its deferred render", async () => {
  const helpers = html.slice(
    html.indexOf("function beginThreadEntryFollow("),
    html.indexOf("function interruptThreadEntryFollow("),
  );
  let resolveDetail;
  const detailReady = new Promise((resolve) => { resolveDetail = resolve; });
  const runtime = new Function("detailReady", `
    let activeView = "threads";
    let threadDetailId = "slack-room";
    let threadDetailEntryFollow = null;
    let threadDetailEntryFollowSeq = 0;
    const scroller = { scrollHeight:1200, scrollTop:0 };
    const deferredTransitionWork = [];
    const window = { relay:{} };
    const document = { fonts:{ ready:Promise.resolve() } };
    function roomScrollElement() { return scroller; }
    function chatOrder() { return "chat"; }
    function afterRoomViewTransition(work) { deferredTransitionWork.push(work); }
    function requestAnimationFrame(work) { queueMicrotask(work); }
    ${helpers}
    const token = beginThreadEntryFollow(threadDetailId);
    hydrateThreadEntry(token, { includeSent:false, detailReady });
    return {
      scroller,
      pending:() => threadEntryFollowToken(),
      finishTransition:() => deferredTransitionWork.splice(0).forEach((work) => work()),
    };
  `)(detailReady);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.scroller.scrollTop, 0, "the summary paint must not end entry-follow early");
  assert.ok(runtime.pending(), "the room remains latched while canonical detail is in flight");

  resolveDetail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.scroller.scrollTop, 0, "a completed request still waits for the deferred room render");
  assert.ok(runtime.pending(), "the transition owns the follow latch until its destination is mutable");

  runtime.finishTransition();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.scroller.scrollTop, 1200, "the hydrated transcript lands on its newest message");
  assert.equal(runtime.pending(), 0, "ordinary refreshes preserve reading position after entry settles");
});

test("an invoked agent stays pinned above the composer across streaming layout changes", () => {
  const observerSource = html.match(/(function observeRoomFollowLayout\(rowsEl, composerEl\) \{[\s\S]*?\n  \})\n/)[1];
  let resize;
  const scroller = { scrollHeight:720, scrollTop:0 };
  const observed = [];
  const rows = {
    isConnected:true,
    dataset:{ roomFollowKey:"room-1" },
    classList:{ contains:(name) => name === "chat-order" },
  };
  const composer = {};
  const runtime = Function("ResizeObserver", "rows", "composer", "scroller", `
    let threadDetailFollowObservedRows = null;
    let threadDetailFollowObserver = null;
    let threadDetailFollowLayoutQueued = false;
    let threadDetailLiveFollow = { roomKey:"room-1", following:true };
    const RelayChatPresentation = {
      shouldPinChatLiveFollow:(state, roomKey) => state.following && state.roomKey === roomKey,
    };
    function requestAnimationFrame(work) { work(); }
    function roomScrollElement() { return scroller; }
    function scrollRoomToNewest(chatShaped) {
      scroller.scrollTop = chatShaped ? scroller.scrollHeight : 0;
    }
    ${observerSource}
    observeRoomFollowLayout(rows, composer);
    return {
      release:() => { threadDetailLiveFollow = { roomKey:null, following:false }; },
      observed:() => threadDetailFollowObserver.observed,
    };
  `)(class {
    constructor(callback) { resize = callback; this.observed = observed; }
    observe(target) { this.observed.push(target); }
    disconnect() {}
  }, rows, composer, scroller);

  assert.deepEqual(runtime.observed(), [rows, composer], "both transcript and composer geometry are watched");
  resize();
  assert.equal(scroller.scrollTop, 720, "the growing agent row remains immediately above the composer");
  runtime.release();
  scroller.scrollHeight = 960;
  resize();
  assert.equal(scroller.scrollTop, 720, "a deliberate reader override releases the pin");
});

test("a letter short enough to be self-contained renders whole in the bubble", () => {
  // Sven: "most of the time the human readable version is enough to be in
  // one message... like whatsapp." ≤550 chars = whole in the bubble; longer
  // keeps title + preview and its tap is the reader — no in-between.
  assert.match(html, /const INLINE_BODY_MAX = 550/);
  const at = html.indexOf("const inlineBody =");
  const row = html.slice(at, html.indexOf("const aggregates", at));
  assert.match(row, /!textLike && !m\.request && !open/);
  assert.match(row, /INLINE_BODY_MAX/);
  assert.match(html, /!textLike && !open && inlineBody \? `<div class="th-body"/);
  assert.match(html, /!textLike && !open && !inlineBody && m\.preview/);
});

test("a titled letter's tap is the reader in either frame; texts stay inert", () => {
  // No in-between (Sven, after a 940-char in-place unfold read as a wall):
  // production's tap ontology, kept. If an unfold toggle returns to the room
  // tap, this is the law it breaks.
  const bind = html.slice(
    html.indexOf('for (const el of thHistoryEl.querySelectorAll(".th-msg"))'),
    html.indexOf("function syncExpandButton"),
  );
  assert.match(bind, /const m = messageById\.get\(String\(id\)\)/,
    "the click resolves the exact painted message, including a canonical direct row before Sent hydration");
  assert.doesNotMatch(bind, /threadMessages\([^)]*\)\.find/,
    "a click must not rebuild a smaller local-only projection than the one that painted the card");
  assert.match(bind, /if \(m && m\.textLike && !m\.ownedAgent\) return;/);
  assert.match(bind, /if \(m && m\.ownedAgent\)[\s\S]*openReader/,
    "every owned-agent response opens its Work reader even when a legacy projection omitted the session id");
  assert.match(bind, /openReader\(id, m\.direction === "out" \? "sent" : \(m\.request \? "tasks" : "threads"\)\)/);
  assert.doesNotMatch(bind, /expandedMsgIds\.add/);
});

test("the document reader can open a canonical direct Relay before Sent hydrates", () => {
  const reader = html.slice(html.indexOf("function readerRow(id)"), html.indexOf("const RX_PRIMARY"));
  const canonicalAt = reader.indexOf("for (const chat of canonicalChatDetails.values())");
  const sentAt = reader.indexOf("const sent = (payload.sent || [])");
  assert.ok(canonicalAt >= 0 && canonicalAt < sentAt, "canonical chat detail is consulted before the lazy Sent cache");
  assert.match(reader, /title: String\(item\.title \|\| "Relay"\)/);
  assert.match(reader, /forHuman: String\(item\.forHuman \|\| ""\)/);
  assert.match(reader, /forAgent: String\(item\.forAgent \|\| ""\)/);
  assert.match(reader, /outbound,/);
});

test("a failed canonical direct read refreshes the same main-pill chat", () => {
  const refresh = html.slice(html.indexOf("async function refreshActiveCanonicalChat("), html.indexOf("let signupStage"));
  assert.match(refresh, /directContactAnchorForChatId\(room\.chatId\)/);
  assert.match(refresh, /!isSlackIntegratedRoom\(room\) && !resolvedDirect/,
    "resolved Relay contacts use the canonical refresh path without becoming Slack rooms");
  const reconcile = html.slice(html.indexOf("function reconcileCanonicalChatResult"), html.indexOf("function syncSlackVisibilityButton"));
  assert.match(reconcile, /directContactAnchorForChatId\(id\)/);
  assert.match(reconcile, /contactChatAnchors\.set\(id, refreshed\)/,
    "fresh server truth rebuilds the direct anchor after an optimistic read rollback");
  const read = html.slice(html.indexOf("function readVisibleChatRoom()"), html.indexOf('thBackEl.addEventListener("click"'));
  assert.match(read, /canonicalReadGeneration\.delete\(generationKey\)/);
  assert.match(read, /const retryImmediately = failures === 1/);
  assert.match(read, /retryAfter:retryImmediately \? 0 : Date\.now\(\) \+ 5000/);
  assert.match(read, /refreshActiveCanonicalChat\(\{ readVisible:retryImmediately \}\)/,
    "one immediate retry is followed by a cooldown and a server-truth refresh without recursion");
});

test("internal chains and message species never divide a same-sender chat run", () => {
  // A visible chat is one room. Wire reply-chain ids and Task/Relay/text
  // presentation stay internal; only a six-hour dated chunk divides the room.
  assert.match(html, /const cont = continuesSenderRun\(prev, m, chunkDateLabel\)/);
  assert.doesNotMatch(html, /chainChanged|chainSeamClass|th-seam/);
  assert.doesNotMatch(html, /gap-mid|45 \* 60e3/);
  const source = html.match(/(function continuesSenderRun\(previous, current, chunkDateLabel\) \{[\s\S]*?\n  \})\n/)[1];
  assert.doesNotMatch(source, /threadId|textLike|request/);
});

test("message species never change the spacing inside a sender run", () => {
  assert.match(html, /\.th-msg\.cont \{ margin-top:20px; \}/);
  assert.match(html, /\.th-under \{[^}]*height:15px;[^}]*margin:3px 16px 0;/);
  assert.match(html, /\.th-under \+ \.th-msg\.cont \{ margin-top:2px; \}/);
  assert.doesNotMatch(html, /\.th-msg:has\(\+ \.th-msg\.cont\) \{ border-bottom:0; \}/);
});

test("a group's face stays stacked even when only one member has spoken", () => {
  // A group must remain visually distinct from a direct chat. Known inbound
  // people come from the same canonical human roster as Chat; an agent byline
  // cannot become a group member or change the room's face.
  const rows = html.slice(html.indexOf("function relayIdentityRows("), html.indexOf("function renderRelays()"));
  assert.match(rows, /const \{ rooms \} = chatSections\(\)/);
  assert.doesNotMatch(rows, /message\.party|message\.partyKey/);
  const chats = html.slice(html.indexOf("function chatConversations("), html.indexOf("function normalizedPartyName("));
  assert.match(chats, /m\.direction === "in" && !m\.ownedAgent && m\.party/);
  const rowHtml = html.slice(html.indexOf("function relayIdentityRowHtml("), html.indexOf("// ---------- the reader:"));
  assert.match(rowHtml, /while \(identity\.isGroup && groupPeople\.length < 2\)/);
  assert.match(rowHtml, /identity\.isGroup\s*\? `<span class="av-stack">/);
});

test("the conversation composer is human-only; agent hand-offs live on Relay rows", () => {
  // Normal chat text is correspondence. Codex and Claude hand-offs belong to
  // the exact two-document Relay row, never beside the human Send button.
  assert.doesNotMatch(html, /const handAnchor =/);
  assert.doesNotMatch(html, /id="thQrOpen"/);
  const composer = html.slice(html.indexOf("const threadComposer = `"), html.indexOf("// Own messages are labelled"));
  assert.doesNotMatch(composer, /replyRail\(/);
  assert.match(composer, /id="thQrSend"/);
});

test("only two-document Relays carry provider actions, and the newest Relay stays open", () => {
  const detail = html.slice(html.indexOf("function renderThreadDetail()"), html.indexOf("function syncExpandButton"));
  assert.match(detail, /find\(\(message\) => !message\.textLike && !message\.request\)/,
    "a newer quick text cannot steal resident-footer ownership from the latest Relay");
  assert.match(detail, /const hasHostActions = !textLike && !m\.request/);
  assert.match(detail, /hasHostActions \? relayHostActionsHtml/);
  assert.doesNotMatch(html, /\.th-msg:hover \.th-host-actions/,
    "raw hover cannot open provider actions while the pointer is merely passing through");
  assert.match(html, /\.th-msg\.host-intent-open \.th-host-actions/);
  assert.match(html, /\.th-msg\.host-focus-open \.th-host-actions/);
  assert.match(html, /\.th-host-actions\.persistent/);
});

test("provider footer copy distinguishes a first open from an existing task or session", () => {
  const footer = html.slice(html.indexOf("function relayHostActionsHtml"), html.indexOf("// ---- the thread reply composer"));
  assert.match(footer, /message\?\.materializedCodex/);
  assert.match(footer, /Start a new task with this Relay/);
  assert.match(footer, /Continue in its existing task/);
  assert.match(footer, /message\?\.materializedClaude/);
  assert.match(footer, /Start a new session with this Relay/);
  assert.match(footer, /Continue in its existing session/);
});

test("the open rows are the apps you chose — one, or both — on the bubble and in the reader alike", () => {
  // Sven, 2026-08-17, on the two-row footer: "should probably detect which
  // desktop apps you have then only suggest those, or even in settings you
  // choose which one" — and, after David and Shane: "they would want an
  // option to always have both… I would always choose one (claude)." The
  // rows are the choice Settings holds (one app, or Both in David's order),
  // detection-backed; the other app is one tap away. David's per-relay
  // subline stays. Both immutable reader documents paint the SAME rows as the
  // footer, so the surfaces cannot drift, and one binder wires the click
  // wherever the rows are. The agent composer below those rows is for its
  // route, note, and Send — it must not duplicate provider launch controls.
  const footer = html.slice(html.indexOf("function relayHostActionsHtml"), html.indexOf("// ---- the thread reply composer"));
  assert.match(footer, /\$\{agentAppHosts\(\)\.map\(\(host\) => hostActionRowHtml\(host, message, source\) \+ sessionPickerInlineHtml\(id, host\)\)\.join\(""\)\}/,
    "the configured provider rows remain the choice and own their inline picker state");
  assert.doesNotMatch(footer, /data-host="codex"[\s\S]*?data-host="claude"/, "no fixed pair of rows");
  assert.match(footer, /function wireHostOpen\(scope\)/);
  assert.match(html, /wireHostOpen\(thHistoryEl\);/, "the room binds through the shared binder");
  const reader = html.slice(html.indexOf("function renderReader()"), html.indexOf("wireHostOpen(readerBodyEl);") + 30);
  assert.match(reader, /const workOn = payload\.features\?\.relayWork === true;/);
  assert.match(reader, /const bothNote = onAgent && workOn && !handoff \?/);
  assert.match(reader, /const documentHostActions = !request && onHuman \? `<div class="rd-host-actions" data-stop="1">\$\{relayHostActionsHtml\(\{/,
    "the provider rows live on the human document; the agent face's rail names the app and Send opens it");
  assert.match(reader, /if \(onAgent && !workOn\) return "";/);
  assert.match(reader, /if \(onAgent\) return relayWorkDockHtml\(r, \{ inline: true \}\)/,
    "the agent composer is the hand-off and carries no provider launch buttons");
  assert.match(reader, /\$\{documentHostActions\}\$\{composer\}/,
    "provider rows precede the active document's composer");
  assert.match(reader, /wireHostOpen\(readerBodyEl\);/, "the reader binds through the shared binder");
  // The letter keeps its reply — the loudest control on a person's letter.
  assert.match(reader, /<textarea id="qrInput" rows="1" placeholder="Reply…">/);
  const humanComposerStart = reader.indexOf('<textarea id="qrInput"');
  const humanComposer = reader.slice(humanComposerStart, reader.indexOf('id="qrSend"', humanComposerStart) + 80);
  assert.doesNotMatch(humanComposer, /data-open-in-host=/,
    "the human reply composer does not duplicate provider actions from the agent face");
  assert.match(reader, /<button type="button" id="qrSend">Send<\/button>/);
});

test("a compact provider-row click expands the existing conversation and unfolds destinations beneath that row", () => {
  const picker = html.slice(html.indexOf("function renderSessionPickerSurface"), html.indexOf('// The verb NAMES an app'));
  const footer = html.slice(html.indexOf("function relayHostActionsHtml"), html.indexOf("// Before 0.1.290"));
  assert.doesNotMatch(html, /id="sessionPickerView"/, "there is no standalone picker page");
  assert.doesNotMatch(picker, /data-sp-host|sp-hosts/, "there is no duplicate Claude/Codex toggle");
  assert.match(footer, /class="th-host-action\$\{selected \? " pressed" : ""\}"/,
    "the provider row itself owns the pressed state");
  assert.match(footer, /selected[\s\S]*"Choose where this Relay lands"/);
  assert.match(picker, /const expandConversation = activeView === "threads" && !chatExpanded/);
  assert.match(picker, /const morphFromCompact = expandConversation && prepareReaderMorph\("threads"\)/);
  assert.match(picker, /chatExpanded = true;[\s\S]*commitNavigation\(\);[\s\S]*startReaderMorph\("threads"\)/,
    "the existing compact room becomes the existing expanded room before the picker is shown");
  assert.match(picker, /New Codex task/);
  assert.match(picker, /New Claude Code session/);
  assert.match(picker, /current \$\{session\.surface === "terminal" \? "terminal " : ""\}\$\{noun\}/);
  assert.match(picker, /lastMessageAt \|\| session\.lastActiveAt/);
  assert.doesNotMatch(footer, /if \(bound\) \{[\s\S]*openRelayFromUI\(id, source, "open", host\)/,
    "legacy materialization cannot bypass destination choice");
  assert.doesNotMatch(picker, /if \(result\?\.binding\) \{[\s\S]*window\.relay\.continueSession/,
    "a remembered binding is labeled in the picker instead of short-circuiting it");
  assert.match(picker, /if \(!state \|\| state\.delivering \|\| button\.disabled\) return;/,
    "one picker selection blocks every competing row until delivery settles");
  assert.match(picker, /querySelectorAll\("\.sp-row"\)[\s\S]*row\.disabled = true/,
    "double-clicks and rapid destination changes cannot emit concurrent IPC deliveries");
  assert.match(footer, /loadSessionPicker\(id, host, relaySubject\(message\) \|\| "Relay", null, source\)/,
    "received and sent rows enter the same immediate picker path");
  assert.doesNotMatch(footer, /if \(source === "relay"\)/,
    "sent Relays cannot bypass the picker and silently create a fresh session");
});

test("composer attachments are enabled across picker, paste, and drop", () => {
  assert.match(html, /const COMPOSER_ATTACHMENTS_ENABLED = true;/);
  assert.match(html, /if \(COMPOSER_ATTACHMENTS_ENABLED && qr && !qr\.querySelector\("\.cmp-plus"\)\)/);
  assert.match(html, /field\.addEventListener\("paste"/);
  assert.match(html, /field\.addEventListener\("drop"/);
});

test('every element that toggles "hidden" has CSS that actually hides it', () => {
  // The generic .hidden rule is scoped to .view; anything else toggling the
  // class needs its own display:none or the toggle is a silent no-op. Found
  // live: See info rendered on every room in every frame while the code
  // diligently toggled a class with no CSS. This runs that audit.
  const ids = new Set();
  for (const m of html.matchAll(/(\w+)El\.classList\.(?:toggle|add|remove)\("hidden"/g)) ids.add(m[1]);
  for (const m of html.matchAll(/getElementById\("(\w+)"\)\.classList\.(?:toggle|add|remove)\("hidden"/g)) ids.add(m[1]);
  const uncovered = [];
  for (const name of ids) {
    const decl = html.match(new RegExp(`const ${name}El = document\\.getElementById\\("(\\w+)"\\)`));
    const elid = decl ? decl[1] : name;
    const tag = html.match(new RegExp(`<\\w+ class="([^"]*)"[^>]*id="${elid}"`))
      || html.match(new RegExp(`id="${elid}"[^>]*class="([^"]*)"`));
    if (!tag) continue;
    const classes = tag[1].split(/\s+/).filter(Boolean);
    const covered = classes.some((c) => c === "view"
      || new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.hidden\\s*\\{`).test(html));
    if (!covered) uncovered.push(elid);
  }
  assert.deepEqual(uncovered, [], `elements whose "hidden" class hides nothing: ${uncovered.join(", ")}`);
});
