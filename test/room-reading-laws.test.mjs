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

test("every room entry follows newest through sent-cache hydration regardless of the previous exit", () => {
  const open = html.slice(html.indexOf("function openThreadDetail("), html.indexOf("// ---------- Settings view"));
  const resetAt = open.indexOf("threadDetailScrolledFor = null;");
  const selectAt = open.indexOf("threadDetailId = threadId;");
  assert.ok(resetAt >= 0 && resetAt < selectAt, "entry rearms scrolling before selecting even the same room id");
  assert.match(open, /const entryFollowToken = beginThreadEntryFollow\(threadId\)/);
  assert.match(open, /commitNavigation\(\{ outerScrollTop: 0 \}\);\s*hydrateThreadEntry\(entryFollowToken\)/,
    "the outbound refresh remains part of the same guarded room entry");

  const render = html.slice(html.indexOf("function renderThreadDetail()"), html.indexOf('document.getElementById("thExpand")'));
  assert.match(render, /const entryFollowToken = threadEntryFollowToken\(\)/);
  assert.match(render, /if \(threadDetailScrolledFor !== thread\.threadId \|\| followOwnSend \|\| entryFollowToken\)/);
  assert.match(render, /else if \(threadDetailScrolledFor !== thread\.threadId \|\| entryFollowToken\)/);
  assert.ok((render.match(/if \(entryFollowToken\) scrollRoomToNewest\(chatShaped\);/g) || []).length >= 2,
    "entry hydration pins synchronously before a backgrounded Electron window can defer paint");
  assert.match(render, /threadEntryFollowToken\(\) !== entryFollowToken/,
    "a stale callback cannot pull a reader back down after deliberate scrolling");

  const entryFollow = html.slice(html.indexOf("function beginThreadEntryFollow("), html.indexOf("function captureRoomScroll("));
  assert.match(entryFollow, /Promise\.allSettled\(\[sentReady, fontsReady\]\)\.then\(\(\) => settleThreadEntryFollow\(token\)\)/);
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
  assert.match(bind, /if \(m && m\.textLike\) return;/);
  assert.match(bind, /openReader\(id, m\.direction === "out" \? "sent" : \(m\.request \? "tasks" : "threads"\)\)/);
  assert.doesNotMatch(bind, /expandedMsgIds\.add/);
});

test("internal chains never divide consecutive ordinary texts", () => {
  // A visible chat is one room. Wire reply-chain ids remain meaningful for
  // structured Relays, but cannot put a hairline and a repeated sender label
  // between two texts the same person sent minutes apart.
  assert.match(html, /&& !\(prev\.textLike && m\.textLike\)/);
  assert.match(html, /const cont = continuesSenderRun\(prev, m, chunkDateLabel\)/);
  assert.match(html, /Boolean\(previous\.textLike && current\.textLike\)/);
  assert.match(html, /const chainSeamClass = chainChanged && !chunkDateLabel \? " th-seam" : ""/);
  assert.match(html, /\$\{chainSeamClass\}/);
  assert.match(html, /\.th-run\.th-seam \{ border-top:1px solid var\(--hair\)/);
});

test("a group's face stays stacked even when only one member has spoken", () => {
  // A group must remain visually distinct from a direct chat. Known inbound
  // speakers lead the stack; the saved group identity supplies the fallback
  // disc until another member has spoken.
  const rows = html.slice(html.indexOf("function relayIdentityRows("), html.indexOf("function renderRelays()"));
  assert.match(rows, /people: message\.isGroup && message\.direction === "in" && message\.party \? \[message\.party\] : \[\]/);
  assert.match(rows, /!existing\.people\.includes\(message\.party\)/);
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
  // subline stays. The reader's agent document paints the SAME rows as its
  // footer, so the two surfaces cannot drift, and one binder wires the click
  // wherever the rows are.
  const footer = html.slice(html.indexOf("function relayHostActionsHtml"), html.indexOf("// ---- the thread reply composer"));
  assert.match(footer, /\$\{agentAppHosts\(\)\.map\(\(host\) => hostActionRowHtml\(host, message, source\)\)\.join\(""\)\}/, "the rows are the choice, nothing else");
  assert.doesNotMatch(footer, /data-host="codex"[\s\S]*?data-host="claude"/, "no fixed pair of rows");
  assert.match(footer, /function wireHostOpen\(scope\)/);
  assert.match(html, /wireHostOpen\(thHistoryEl\);/, "the room binds through the shared binder");
  const reader = html.slice(html.indexOf("function renderReader()"), html.indexOf("wireHostOpen(readerBodyEl);") + 30);
  assert.match(reader, /const workOn = payload\.features\?\.relayWork === true;/);
  assert.match(reader, /const hasWork = \(request \|\| workOn\) && !\["idle", "waiting", "parked"\]\.includes\(runState\);/);
  assert.match(reader, /const bothNote = onAgent && workOn \?/);
  assert.match(reader, /if \(onAgent && !workOn\) return `<div class="rd-host-actions" data-stop="1">\$\{relayHostActionsHtml\(\{/);
  assert.match(reader, /wireHostOpen\(readerBodyEl\);/, "the reader binds through the shared binder");
  const agentFooter = reader.slice(reader.indexOf('if (onAgent && !workOn) return `<div class="rd-host-actions"'), reader.indexOf("if (onAgent || onWork) return relayWorkDockHtml"));
  assert.doesNotMatch(agentFooter, /<textarea/, "no composer to your own agent on the shipped agent document");
  // The letter keeps its reply — the loudest control on a person's letter.
  assert.match(reader, /<textarea id="qrInput" rows="1" placeholder="Reply…">/);
  assert.match(reader, /<button type="button" id="qrSend">Send<\/button>/);
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
