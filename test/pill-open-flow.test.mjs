// Source-level guards for the three Windows open-flow bugs fixed in 0.1.68:
// the stdout race that sent successful opens to the browser, the ack that retired
// relays which never actually opened, and the "Open in current chat" no-op on
// machines with no claude-hook runtime. main.cjs requires electron at load time, so
// (like pill-read-ui.test.mjs) these read the shipped source — except parseOpenResult,
// which is small and pure enough to lift out and exercise for real.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const materializer = fs.readFileSync(new URL("../src/materializer.js", import.meta.url), "utf8");
const codexDesktop = fs.readFileSync(new URL("../src/codex-desktop.js", import.meta.url), "utf8");

// Slice a top-level function by brace counting from its header (string literals in
// this file never contain unbalanced braces, so a plain count is enough).
function sliceFunction(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  let depth = 0;
  // Start at the body brace, not the first "{" — the parameter list destructures.
  for (let i = src.indexOf(") {", start) + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${header}`);
}

const openPacket = sliceFunction(main, "async function openPacket(");
const openTaskDetail = sliceFunction(main, "function openTaskDetail(");

// ---- macOS launch ownership ------------------------------------------------

test("a bare second instance cannot reopen the pill", () => {
  const handlerStart = main.indexOf('app.on("second-instance"');
  const handlerEnd = main.indexOf('app.on("activate"', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = main.slice(handlerStart, handlerEnd);
  const guard = handler.indexOf("if (!nonce) return;");
  const reopen = handler.indexOf("requestExternalReopen(nonce)");
  assert.ok(guard >= 0, "bare second instances need an explicit-intent guard");
  assert.ok(reopen > guard, "the nonce guard must run before reopening the pill");
});

test("the macOS menu-bar icon has a stable shipped identity", () => {
  assert.match(main, /RELAY_TRAY_GUID,[\s\S]*?prepareMacTrayPosition,[\s\S]*?require\("\.\/tray-position\.cjs"\)/);

  const createTray = sliceFunction(main, "function createTray(");
  const register = createTray.indexOf("prepareMacTrayPosition(");
  const construct = createTray.indexOf("new Tray(icon, RELAY_TRAY_GUID)");
  assert.ok(register >= 0, "missing first-run macOS tray position registration");
  assert.ok(construct > register, "the position default must be registered before AppKit constructs the status item");
  assert.match(createTray, /readMacDefaultsNumber\(domain, key, \{ execFileSync \}\)/, "migration uses the tri-state defaults adapter");
  assert.match(createTray, /process\.platform === "darwin"[\s\S]*?new Tray\(icon, RELAY_TRAY_GUID\)/);
  assert.match(createTray, /:\s*new Tray\(icon\)/, "other platforms retain their existing tray semantics");
  assert.match(createTray, /writePillStatus\(\)/, "tray creation must publish observable health state");
  assert.match(main, /preferredPositionKey: process\.platform === "darwin" \? RELAY_TRAY_POSITION_KEY : null/);
  assert.match(main, /preferredPositionDefault: process\.platform === "darwin" \? RELAY_TRAY_DEFAULT_POSITION : null/);
  assert.match(main, /persistentId:[\s\S]*?tray\.getGUID\(\)/, "health reports the native Tray identity");
  assert.match(main, /RELAY_BUNDLE_IDS = \[[\s\S]*?RELAY_MAC_BUNDLE_IDENTIFIER/, "the branded pill remains self-owned when its composer activates");
  assert.match(main, /app\.on\("will-quit", preserveMacTrayPositionForExit\)/);
  assert.match(main, /preserveMacTrayPositionForExit\(\);\s*app\.exit\(0\)/, "app.exit preserves position explicitly");
  assert.match(main, /tray: trayStatus\(\)/);
});

// ---- Fix 1: the CLI stdout race -------------------------------------------

test("open spawns parse stdout on close, never on exit", () => {
  // "exit" fires before the stdout pipe drains on Windows, which emptied `out` and
  // routed a successful open to the web fallback.
  assert.doesNotMatch(main, /child\.on\("exit"/);
  assert.match(openPacket, /child\.on\("close"/);
  assert.match(openTaskDetail, /child\.on\("close"/);
});

test("both open spawns share the hardened result parser", () => {
  assert.match(openPacket, /parseOpenResult\(out\)/);
  assert.match(openTaskDetail, /parseOpenResult\(out\)/);
  assert.doesNotMatch(openPacket, /JSON\.parse\(out\.trim\(\)\)/);
  assert.doesNotMatch(openTaskDetail, /JSON\.parse\(out\.trim\(\)\)/);
});

test("open failure logs stdout as well as stderr", () => {
  for (const fn of [openPacket, openTaskDetail]) {
    assert.match(fn, /"stdout:",\s*\n?\s*tailFor\(out\)/);
    assert.match(fn, /"stderr:",\s*\n?\s*tailFor\(err\)/);
  }
});

// parseOpenResult is pure; lift it out of the source and run it.
const parseOpenResult = new Function(
  `${sliceFunction(main, "function parseOpenResult(")}\nreturn parseOpenResult;`,
)();

test("parseOpenResult reads a clean CLI payload", () => {
  const out = JSON.stringify({ url: "claude://x", skipExternalOpen: true, claudeFreshlyForged: true }, null, 2);
  assert.deepEqual(parseOpenResult(out), {
    url: "claude://x",
    skipExternalOpen: true,
    freshlyForged: true,
    cwd: null,
    cwdReason: null,
    workspaceKey: null,
    error: null,
  });
});

test("parseOpenResult recovers when stdout carries stray non-JSON lines", () => {
  const out = `(node:1) Warning: something\n{\n  "url": "https://relay/app"\n}\ntrailing noise`;
  assert.deepEqual(parseOpenResult(out), {
    url: "https://relay/app",
    skipExternalOpen: false,
    freshlyForged: false,
    cwd: null,
    cwdReason: null,
    workspaceKey: null,
    error: null,
  });
});

test("parseOpenResult returns safe defaults for empty or junk stdout", () => {
  for (const out of ["", "   ", undefined, "not json at all"]) {
    assert.deepEqual(parseOpenResult(out), {
      url: null,
      skipExternalOpen: false,
      freshlyForged: false,
      cwdReason: null,
      workspaceKey: null,
      error: null,
    });
  }
});

test("parseOpenResult carries passport-routing failure context", () => {
  const out = JSON.stringify({ error: "workspace-unmapped", cwdReason: "workspace-unmapped", workspaceKey: "git:github.com/acme/relay" });
  assert.deepEqual(parseOpenResult(out), {
    url: null,
    skipExternalOpen: false,
    freshlyForged: false,
    cwd: null,
    cwdReason: "workspace-unmapped",
    workspaceKey: "git:github.com/acme/relay",
    error: "workspace-unmapped",
  });
});

// ---- Fix 2: only a surfaced relay gets acked -------------------------------

test("openPacket acks exactly once, inside finishOpened", () => {
  assert.match(openPacket, /const finishOpened = \(\) => \{\s*\n\s*if \(!sent\) ackPacket\(packetId\);/);
  assert.equal(openPacket.match(/ackPacket\(/g).length, 1);
  // Every path stops the spinner, including the failing ones.
  assert.match(openPacket, /const finishFailed = \(message\) => \{[\s\S]*?send\("openDone", packetId\)/);
});

test("openPacket surfaced paths ack: test seam, connector reauth, CLI success", () => {
  assert.match(openPacket, /RELAY_OVERLAY_TEST_NO_HOST_OPEN === "1"\) return finishOpened\(\);/);
  assert.match(openPacket, /connectors`\)[\s\S]*?return finishOpened\(\);/);
  assert.match(openPacket, /if \(url \|\| skipExternalOpen\) \{[\s\S]*?finishOpened\(\);\s*\n\s*\} else \{/);
});

test("Codex suppresses the deep-link fallback only after the target task is visibly confirmed", () => {
  // Materialization may suppress codex:// only for the stronger confirmation.
  // A generic notify result (`ok`) means the renderer ran and is insufficient.
  const openedInHostAssignment = materializer.match(/openedInHost = Boolean\(([^;]+)\);/);
  assert.ok(openedInHostAssignment, "missing Codex openedInHost decision");
  assert.doesNotMatch(openedInHostAssignment[1], /\?\.ok\b/);

  // Current Codex Desktop exposes its routed task through the same stable DOM
  // attributes used by app.get_summary. A successful postMessage is only a
  // request; the target row becoming active is the observable route ack.
  assert.ok(codexDesktop.includes("data-app-action-sidebar-thread-id"), "bridge must inspect the target task id");
  assert.ok(codexDesktop.includes("data-app-action-sidebar-thread-active"), "bridge must confirm the target task is active");
  assert.match(codexDesktop, /openConfirmed:\s*Boolean\(openId && reached\)/,
    "desktop result must expose the verified open separately from generic refresh success");

  // focus() is also a request on macOS. The bridge must report the state it can
  // observe after that request, not merely that the call returned without an
  // exception.
  assert.ok(/focused:\s*win\.isFocused\(\)/.test(codexDesktop), "bridge must report observed focus");

  // If either confirmation is absent, the CLI contract leaves skipExternalOpen
  // false and the overlay owns the existing codex:// fallback.
  assert.match(materializer, /skipExternalOpen = openedInHost;/);
  assert.match(openPacket, /if \(url && !skipExternalOpen\) \{[\s\S]*?shell\.openExternal\(url\)/);
});

test("openPacket failure paths recover into the exact local Preview, never the web inbox", () => {
  assert.match(openPacket, /non-developer account:", packetId\);\s*\n\s*return finishFailed\(\);/);
  assert.match(openPacket, /const finishInPreview = \(message\) => \{\s*\n\s*if \(openPreview\(packetId\)\)/);
  assert.match(openPacket, /workspace-unmapped[\s\S]*?finishInPreview\(message\)/);
  assert.match(openPacket, /open spawn error:[\s\S]*?finishInPreview\("Couldn't open this Relay/);
  assert.doesNotMatch(openPacket, /opened on the web instead/);
  assert.doesNotMatch(openPacket, /web fallback failed/);
  assert.doesNotMatch(openPacket, /row\.actionUrl/);
});

test("openError reaches the row through preload and the renderer", () => {
  assert.match(main, /send\("openError", packetId, message\)/);
  assert.match(preload, /onOpenError: \(cb\) => ipcRenderer\.on\("openError", \(_e, id, message\) => cb\(id, message \|\| ""\)\)/);
  assert.match(html, /window\.relay\.onOpenError\(\(id, message\) => \{/);
  // 0.1.81: error notes render through the rebuild-proof rowNotes state (a
  // payload push used to wipe the explanation while the user was reading it).
  assert.match(html, /setRowNote\(id, message, "err"\)/);
  // ...and a retry of the same row wipes the stale message.
  assert.match(html, /clearRowNote\(id\); \/\/ a previous open's failure text/);
  assert.match(html, /function clearRowNote\(id\) \{[\s\S]*?data-err="\$\{CSS\.escape\(id\)\}"/);
});

test("legacy current-chat IPC only opens an explicit destination picker", () => {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const run = new Function("win", `${sliceFunction(main, "function requestSessionPicker(")}\nreturn requestSessionPicker;`)(win);
  run("r_inbound", { host: "claude" });
  run("r_sent", { sent: true, host: "codex" });
  assert.deepEqual(sent, [
    ["openDone", "r_inbound"], ["chooseSession", "r_inbound", { source: "relay", provider: "claude" }],
    ["openDone", "r_sent"], ["chooseSession", "r_sent", { source: "sent", provider: "codex" }],
  ]);
  assert.doesNotMatch(main, /repairClaudeHooks|installClaudeHooks|stageInjection|watchInjectionDelivery|openPacketInCurrent/);
  assert.match(preload, /onChooseSession/);
  assert.match(html, /window\.relay\.onChooseSession/);
});

test("choosing a chat does not start opening, acknowledge or deliver content", () => {
  const calls = [];
  const run = new Function("openingIds", "loadSessionPicker", "hostKeyFor", "agentAppName",
    `${sliceFunction(html, "function openRelayFromUI(")}\nreturn openRelayFromUI;`)(new Map(), (...args) => calls.push(args), () => "claude", () => "Claude Code");
  run("r_inbound", "relay", "current", "claude");
  run("r_sent", "sent", "current", "codex");
  assert.deepEqual(calls, [["r_inbound", "claude", "Relay", null, "relay"], ["r_sent", "codex", "Relay", null, "sent"]]);
  assert.match(html, /const curLabel = "Choose chat"/);
  assert.match(main, /includeRendezvous: false/);
});

// ---- Fix 4: topmost level on Windows --------------------------------------

test("the overlay window uses the screen-saver level on win32", () => {
  assert.match(main, /win\.setAlwaysOnTop\(true, process\.platform === "win32" \? "screen-saver" : "floating"\)/);
});

// ---- 0.1.87: open-status notes reach the thread surfaces too ---------------

test("open-status notes render where actions happen: the reader and every bubble", () => {
  // The topic list carries no actions anymore (chat-first IA) — the note slot
  // lives in the reader page and inside EVERY bubble, rendered from rowNotes
  // state so payload rebuilds keep them. No thread-level note div: it repeated
  // the newest bubble's own note (Sven's double "Copied.").
  assert.match(html, /const note = rowNotes\.get\(r\.id\);/);
  assert.match(html, /data-err="\$\{esc\(r\.id\)\}" data-stop="1">\$\{esc\(\(note && note\.text\) \|\| ""\)\}/);
  assert.match(html, /data-err="\$\{esc\(m\.id\)\}" data-stop="1">\$\{esc\(rowNotes\.get\(m\.id\)\?\.text \|\| ""\)\}/);
  assert.doesNotMatch(html, /threadNote/);
});

// ---- thread detail is chat-shaped -----------------------------------------
// The restyle briefly reversed this (newest first, actions pinned on top) on
// the grounds that bottom-anchoring needs a composer. Read in place it lost the
// shape every messaging app has trained, and the pinned action slab dominated
// the view, so the 0.1.92 order stands.


// ---- 0.1.93: Sent rows get the same three-action menu ---------------------

test("sent rows expand into Preview / Choose chat / New chat", () => {
  // The shared menu builder has a sent namespace so the two lists wire independently.
  assert.match(html, /const preview = sent \? `data-sent-preview=/);
  assert.match(html, /const cur = sent \? `data-sent-open-current=/);
  assert.match(html, /const fresh = sent \? `data-sent-open-fresh=/);
  // Sent rows render the menu when expanded, and carry a status-note slot.
  assert.match(html, /const openCard = expanded \? openActionsHtml\(id, \{ sent: true, shareLinkUrl: shareCopyUrl \}\) : "";/);
  assert.match(html, /data-err="\$\{esc\(id\)\}">\$\{esc\(rowNotes\.get\(id\)\?\.text \|\| ""\)\}/);
  // Each action routes to its own sent-side path.
  assert.match(html, /return loadSessionPicker\(id, provider, "Relay", null, source\)/);
  assert.match(html, /source === "sent" && mode === "fresh" && window\.relay\.openSentFresh/);
  assert.match(preload, /openSentInCurrent: \(id, host\) => ipcRenderer\.send\("relay:openSentInCurrent", id, host\)/);
  assert.match(html, /window\.relay\.openSentFresh\(id, host \|\| hostKeyFor\(agentAppName\(\)\)\)/);
  assert.match(preload, /openSentFresh: \(id, host\) => ipcRenderer\.send\("relay:openSentFresh", id, host\)/);
});

test("previewing a sent relay reads sentCache and never acks a read receipt", () => {
  const fn = sliceFunction(main, "function previewPayloadForSent(");
  assert.match(fn, /sentCache \|\| \[\]/);
  assert.match(fn, /unread: false/);
  assert.match(fn, /outbound: true/);
  // The shared payload builder falls through to the sent lookup.
  assert.match(main, /return previewPayloadForSent\(id\);/);
});


test("the agent row opens the named provider's picker before any native launch", () => {
  assert.match(preload, /open: \(id, host\) => ipcRenderer\.send\("relay:open", id, host\)/);
  const wire = html.slice(html.indexOf("function wireHostOpen"), html.indexOf("// Before 0.1.290"));
  assert.match(wire, /loadSessionPicker\(id, host, relaySubject\(message\) \|\| "Relay", null, source\)/);
  assert.doesNotMatch(wire, /openRelayFromUI|data-continues/);
});

test("legacy current-chat IPC keeps the selected provider for the picker", () => {
  const handler = main.slice(main.indexOf('ipcMain.on("relay:openInCurrent"'), main.indexOf('ipcMain.on("relay:preview"'));
  assert.match(handler, /requestSessionPicker\(id, \{ host: String\(host \|\| ""\) \}\)/);
  assert.doesNotMatch(handler, /selectedHost === "codex"[\s\S]*?fresh: true/);
});

test("a confirmed exact-session open does not reactivate every Codex window", () => {
  const start = main.indexOf("async function presentSessionOpen");
  const end = main.indexOf("async function deliverPacketToSession", start);
  const present = main.slice(start, end);
  assert.ok(start >= 0 && end > start, "presentSessionOpen is available");
  assert.match(present, /if \(!result\?\.url \|\| result\.skipExternalOpen\) return;[\s\S]*activateHost\(provider, observedBundle\)/,
    "a bridge-confirmed primary-window focus returns before LaunchServices can raise auxiliary windows");
});

test("the New task/session picker row claims and recovers materialization before forceFresh", () => {
  const start = main.indexOf("async function deliverPacketToSession");
  const end = main.indexOf("async function continuePacketSession", start);
  const delivery = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(delivery, /claimRelayNewSession\(routePacketId, provider, \{ rebind: true \}\)/);
  assert.match(delivery, /claim\.kind === "recovered"/);
  assert.match(delivery, /markRelaySessionDispatching\(routePacketId, claim\.claim\.claimId\)/);
  assert.match(delivery, /completeRelayNewSession\([\s\S]*claim\.claim\.claimId/);
  assert.match(delivery, /noProviderSideEffect[\s\S]*releaseRelaySessionClaim\(routePacketId, claim\.claim\.claimId\)/,
    "an unopenable workspace releases its pre-dispatch claim because no native session exists");
  assert.match(delivery, /NEW_SESSION_ID_UNCONFIRMED/,
    "an unexplained missing native id remains fail-closed rather than forcing another task");
  assert.ok(
    delivery.indexOf("markRelaySessionDispatching") < delivery.indexOf("forceFresh: true"),
    "the durable dispatch boundary precedes materialization",
  );
});

// ---- a notification presents as a banner ----------------------------------

test("a notification presents as a banner, sized to the rows it actually shows", () => {
  const notifyFn = sliceFunction(html, "function notifyArrival(");
  const peekHeightFn = sliceFunction(html, "function peekHeight()");
  // The notification list is unread-only, so at full expanded height a single
  // new relay sat above ~380px of empty card and read as a broken window.
  assert.match(notifyFn, /classList\.add\("peek", "notifying"\)/);
  // Sized AFTER the render, because peekHeight measures the rows now in the DOM.
  assert.match(notifyFn, /renderAll\(\);[\s\S]*sizePeek\(\);/);
  // Relay notifications are `.relay-row`; measuring only the retired
  // `.row` species silently fell back to 118px and clipped the stack.
  assert.match(peekHeightFn, /querySelectorAll\("\.relay-row, \.row"\)/);
  assert.doesNotMatch(notifyFn, /springTo\(EXPANDED\.w, EXPANDED\.h\);/);
  // Engaging with a peek still restores the full chrome via clearPeek.
  const openFullFn = sliceFunction(html, "function openFull()");
  assert.match(openFullFn, /clearPeek\(\);/);
  const clearPeekFn = sliceFunction(html, "function clearPeek()");
  assert.match(clearPeekFn, /cardEl\.classList\.remove\("peek", "notifying"\)/);
  assert.match(peekHeightFn, /querySelectorAll\("\.relay-row, \.row"\)/);
  assert.match(html, /\.card\.peek \.scroll \{[\s\S]*padding-bottom:20px/);
  assert.doesNotMatch(html, /\.card\.peek \.scroll \{[\s\S]{0,300}mask-image/);
});

test("dismissing a visible notification retires it instead of replaying it", () => {
  const dismissFn = sliceFunction(html, "function dismissOverlay()");
  assert.match(dismissFn, /if \(!wasGhost\) sendAttentionDone\(true\)/);
  assert.doesNotMatch(dismissFn, /sendAttentionDone\(false\)/);
});

test("an arrival while the card is open lands in the list — it never re-banners the open inbox", () => {
  // The attention queue presents pending unread one batch at a time; without
  // this guard each batch yanked a just-opened card back to banner height.
  const notifyFn = sliceFunction(html, "function notifyArrival(");
  assert.match(notifyFn, /const onStageFull = !collapsed && !peeking && !ghost/);
  assert.match(notifyFn, /if \(onStageFull\) \{/);
  // The on-stage path keeps whatever chrome the card has and settles attention.
  assert.match(notifyFn, /cardEl\.classList\.add\("notifying"\); \/\/ state-only marker; the chrome stays put/);
  assert.match(notifyFn, /sendAttentionDone\(true\);\s*\n\s*return;/);
  // The early return must come BEFORE any peek state is taken, or an arrival
  // over an open card leaves `peeking` true for a banner that never appeared.
  const guard = notifyFn.indexOf("if (onStageFull) {");
  assert.ok(guard > 0 && guard < notifyFn.indexOf("peeking = true;"));
});

test("only a deliberately presented full card counts as on stage", () => {
  const predicate = sliceFunction(html, "function fullCardIsOnStage()");
  const isOnStage = Function(
    "presented", "collapsed", "peeking", "ghost", "cardEl",
    `"use strict"; ${predicate}; return fullCardIsOnStage();`,
  );
  const card = (...classes) => ({ classList: { contains: (name) => classes.includes(name) } });

  assert.equal(isOnStage(true, false, false, false, card()), true);
  assert.equal(isOnStage(false, false, false, false, card()), false, "never presented");
  assert.equal(isOnStage(true, true, false, false, card()), false, "folded to the pill");
  assert.equal(isOnStage(true, false, true, false, card()), false, "showing an arrival banner");
  assert.equal(isOnStage(true, false, false, true, card()), false, "notification-only ghost");
  assert.equal(isOnStage(true, false, false, false, card("offstage")), false, "OS window hidden");
  assert.equal(isOnStage(true, false, false, false, card("bye")), false, "dismissal in progress");
});

function arrivalHarness({ collapsed = false, peeking = false, reader = false, signup = false, presented = true } = {}) {
  const classes = new Set([...(collapsed ? ["collapsed"] : []), ...(signup ? ["signup"] : [])]);
  const calls = [];
  const context = vm.createContext({
    collapsed, peeking, presented, readerOpenNow: reader, ghost: false,
    peekTimer: null, ghostTimer: null, activeNotificationIds: [],
    notifSticky: false, notifInteracted: false, activeView: reader ? "threads" : "relays",
    cardEl: { classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    } },
    window: { relay: { attentionDone: (receipt) => calls.push(["done", receipt.dwelled]) } },
    cancelBye() {}, refreshCountLabel() {}, playTink() {},
    renderAll: () => calls.push(["render"]),
    commitNavigation: () => calls.push(["navigate"]),
    sizePeek: () => calls.push(["resize"]),
    setTimeout: () => { calls.push(["timer"]); return 1; }, clearTimeout() {},
    notificationDurationMs: 7000,
  });
  vm.runInContext(`${sliceFunction(html, "function dwellFor(")}\n${sliceFunction(html, "function sendAttentionDone(")}\n${sliceFunction(html, "function notifyArrival(")}\nnotifyArrival([{ id: "arrival" }], {});`, context);
  return { context, classes, calls };
}

test("arrivals preserve medium and large cards, including startup before an explicit open", () => {
  for (const reader of [false, true]) {
    for (const presented of [false, true]) {
      const { context, classes, calls } = arrivalHarness({ reader, presented });
      assert.equal(context.peeking, false);
      assert.equal(context.collapsed, false);
      assert.equal(context.activeView, reader ? "threads" : "relays");
      assert.equal(classes.has("peek"), false);
      assert.equal(classes.has("notifying"), false);
      assert.deepEqual(calls, [["render"], ["done", true]]);
    }
  }
});

test("compact arrivals still banner and successive arrivals can update that banner", () => {
  for (const state of [{ collapsed: true }, { peeking: true }]) {
    const { context, classes, calls } = arrivalHarness(state);
    assert.equal(context.peeking, true);
    assert.equal(context.collapsed, false);
    assert.equal(classes.has("peek"), true);
    assert.deepEqual(calls, [["navigate"], ["resize"], ["timer"]]);
  }
});

test("an in-flight arrival during onboarding never resizes or retires unseen mail", () => {
  for (const collapsed of [false, true]) {
    const { context, classes, calls } = arrivalHarness({ signup: true, collapsed, presented: false });
    assert.equal(context.peeking, false);
    assert.equal(context.collapsed, collapsed);
    assert.equal(classes.has("peek"), false);
    assert.deepEqual(calls, [["done", false]]);
  }
});

test("the attention pump leaves setup arrivals pending before starting or showing a banner", () => {
  for (const payload of [
    { account: { paired: true }, ui: { onboardingRequired: true } },
    { account: { paired: false } },
    ...["unavailable", "missing", "corrupt"].map((credentialStatus) => ({ account: { paired: true, credentialStatus } })),
  ]) {
    const context = vm.createContext({
      win: { isDestroyed: () => false }, pillReady: true, rendererListening: true,
      currentShow: null, attention: { hasShowing: () => false, pendingCount: () => 1 },
      attentionQueue: new Map([["arrival", { state: "pending" }]]),
      pillHidden: false, userIsAway: () => false, dismissed: false, payload,
      // A sign-in still reading its history also holds arrivals (get started, 2026-09-13).
      signInHistoryPending: new Set(), onboardingAccountKey: () => "user:test",
    });
    vm.runInContext(`${sliceFunction(main, "function pumpAttention(")}\nresult = pumpAttention(payload);`, context);
    assert.equal(context.result, false);
    assert.deepEqual([...context.attentionQueue], [["arrival", { state: "pending" }]]);
  }
});

// Read presence still requires deliberate presentation, independently of the
// size-based notification policy.
test("read presence requires a deliberate open even when the card boots expanded", () => {
  assert.match(html, /^\s*let presented = false;$/m, "the renderer starts un-presented");

  // Only a deliberate presentation turns it on.
  assert.match(sliceFunction(html, "function trayOpen()"), /presented = true;/);
  assert.match(sliceFunction(html, "function openFull()"), /presented = true;/);
  assert.match(sliceFunction(html, "function setCollapsed("), /if \(!collapsed\) presented = true;/);
  // Parking the card takes it back, so the next arrival banners rather than
  // landing silently in a list nobody is looking at.
  assert.match(sliceFunction(html, "function resetOffstage()"), /presented = false;/);
});

// `notifying` is watched from outside as "an arrival is mid-presentation". The
// on-stage path settles its arrival immediately, so leaving the marker set left
// the card permanently mid-notification for the life of the process.
test("settling an arrival clears the notifying marker on every path", () => {
  const settle = sliceFunction(html, "function sendAttentionDone(");
  assert.match(settle, /cardEl\.classList\.remove\("notifying"\)/);
  // The banner path drops it on the way out, as before.
  assert.match(sliceFunction(html, "function clearPeek()"), /classList\.remove\("peek", "notifying"\)/);
  assert.match(sliceFunction(html, "function foldToPill()"), /classList\.remove\("peek", "notifying"\)/);
});

// Slack-style run grouping is right for chat utterances and wrong for these:
// every row is a whole relay with its own title, actions and moment in time.
// Two relays from one sender collapsed into a single headerless block with one
// timestamp, and David could not tell there were two.


test("theme has two layers — system default, explicit button choice sticks", () => {
  // Boot resolves from the stored choice first, falling back to the OS sheet.
  assert.match(html, /const dark = stored \? stored === "dark" : true;/); // dark is the default face
  // A live OS change re-skins only while no explicit choice exists…
  assert.match(html, /catch \{ document\.documentElement\.dataset\.theme = "dark"; \}/); // dark even if storage fails
  // …and the button persists the explicit pick, ending the follow.
  assert.match(html, /localStorage\.setItem\("relayTheme", toDark \? "dark" : "light"\)/);
});

test("the fitted card keeps elevation inside its bounds", () => {
  assert.match(html, /\.card \{[\s\S]*?box-shadow:var\(--shadow-card\)/);
  assert.match(html, /\.card\.collapsed \{[\s\S]*?box-shadow:var\(--shadow-pill\)/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*?--paper-edge:rgba\(255,255,255,\.06\)/);
  assert.match(html, /--shadow-card:inset 0 1px 0 var\(--paper-edge\)/);
  assert.match(html, /--shadow-pill:inset 0 1px 0 var\(--paper-edge\)/);
  assert.doesNotMatch(html, /--shadow-(?:card|pill):[^;]*(?:rgba\(0,0,0|rgba\(31,26,23)/);
  assert.doesNotMatch(html, /inset 0 1px 0 rgba\(255,255,255,\.9\)/);
});

test("the macOS compositor canvas and ordinary native window clamp cover every card state", () => {
  const sizeOf = (name) => {
    const m = html.match(new RegExp(`const ${name} = \\{ w: (\\d+), h: (\\d+) \\}`));
    assert.ok(m, `${name} is declared in inbox.html`);
    return { w: Number(m[1]), h: Number(m[2]) };
  };
  const expanded = sizeOf("EXPANDED");
  const peek = sizeOf("PEEK");
  const max = main.match(/const CARD_MAX = \{ w: (\d+), h: (\d+) \}/);
  assert.ok(max, "CARD_MAX is declared in main.cjs");

  assert.ok(
    Number(max[1]) >= Math.max(expanded.w, peek.w),
    `CARD_MAX.w (${max[1]}) must cover the widest state (expanded ${expanded.w}, peek ${peek.w})`,
  );
  assert.ok(
    Number(max[2]) >= Math.max(expanded.h, peek.h),
    `CARD_MAX.h (${max[2]}) must cover the tallest state`,
  );
});

test("folding publishes destination native geometry before an animation frame can stall", () => {
  const spring = html.slice(html.indexOf("function springTo("), html.indexOf("// ---------- collapse / expand / peek"));
  assert.match(spring, /W\.t = w; H\.t = h;\s*[\s\S]*?publishCardSize\(w, h, \{ phase:"prepare", motionId \}\);/);
  assert.ok(
    spring.indexOf('publishCardSize(w, h, { phase:"prepare", motionId });') < spring.indexOf("requestAnimationFrame(frame)"),
    "the destination geometry is sent before the animated frame is scheduled",
  );
  const frame = sliceFunction(html, "function frame(");
  assert.match(frame, /commitSettledCardSize\(W\.t, H\.t, cardMotionId\)/,
    "the normal final geometry commits from actual spring settlement");
  assert.doesNotMatch(frame, /publishCardSizeThrottled/,
    "main never receives per-frame geometry that could compete with the renderer spring");
  assert.match(html, /const cardMotionSessionId = crypto\.randomUUID\(\)/,
    "each renderer lifetime has its own motion-ordering domain");
  assert.match(preload, /motionSessionId: typeof motion\.motionSessionId === "string"/,
    "the renderer session id crosses the isolated preload boundary");
  assert.match(preload, /ipcRenderer\.invoke\("relay:cardSizeSettled"/,
    "final renderer state waits for main's geometry acknowledgement");
  assert.match(main, /ipcMain\.handle\("relay:cardSizeSettled"/);
  assert.match(main, /const NATIVE_GEOMETRY_WATCHDOG_MS = 750/);
  const reconcile = sliceFunction(main, "function scheduleNativeGeometryReconcile(");
  assert.match(reconcile, /fitOverlayWindowToCard\(\{ settle: true \}\)/,
    "main eventually trims a stale Windows input surface even if renderer settlement is lost");
  assert.match(reconcile, /generation !== nativeGeometryGeneration/,
    "an older shrink deadline cannot override a newer card destination");
});

test("Windows/Linux use ordinary focusable windows, with a Linux taskbar fallback, while only macOS hit-tests a fixed canvas", () => {
  const create = sliceFunction(main, "function createWindow(");
  assert.match(create, /focusable: true/);
  assert.match(create, /win = createCompanionWindow\(BrowserWindow, \{/);
  assert.match(create, /process\.platform === "linux" \? \{ icon:/);
  assert.match(create, /hasShadow: false/);
  assert.match(main, /setIgnoreMouseEvents\(next, \{ forward: true \}\)/);
  assert.match(main, /function applyIgnore/);
  assert.match(main, /function hitTick/);
  assert.match(main, /function startHitTest/);
  assert.match(main, /const FIXED_OVERLAY_SURFACE = usesFixedOverlaySurface\(process\.platform\)/);
  const ignore = sliceFunction(main, "function applyIgnore(");
  assert.match(ignore, /if \(!FIXED_OVERLAY_SURFACE\) \{[\s\S]*?return;/,
    "an ordinary Windows window can never enter Electron click-through mode");
  assert.match(create, /if \(FIXED_OVERLAY_SURFACE\) \{[\s\S]*?applyIgnore\(true/,
    "only the macOS fixed surface starts the click-through hit tester");
  assert.doesNotMatch(main + preload + html, /relay:setFocusable|setFocusable/);
  assert.match(html, /\.card \{[\s\S]*?position:absolute; top:0; right:0;/,
    "the visible card shares the native window's top-right anchor throughout a morph");
  assert.doesNotMatch(html, /body \{[^}]*user-select:none/);
});

test("every native window in the Companion follows the shared taskbar policy", () => {
  assert.doesNotMatch(main, /new BrowserWindow\(/);
  assert.ok(
    (main.match(/createCompanionWindow\(BrowserWindow, \{/g) || []).length >= 4,
    "the pill, previews, attachment viewers and hidden renderers all use the Companion window factory",
  );
});

test("reader refreshes cannot change native focusability", () => {
  assert.doesNotMatch(html + preload + main, /setFocusable|relay:setFocusable/);
  assert.match(main, /function fitOverlayWindowToCard/);
  assert.match(main, /if \(FIXED_OVERLAY_SURFACE \|\| !win/,
    "macOS cannot accidentally re-enter native transition geometry");
  assert.match(main, /const nativeSize = FIXED_OVERLAY_SURFACE \? CARD_MAX : cardSize/,
    "Windows starts at the one visible card while macOS retains its compositor canvas");
  assert.match(main, /subscribeActiveApplicationChanges/);
  assert.match(main, /observeFrontmostBundle/);
  assert.match(main, /setAlwaysOnTop\(elevated, "floating"\)/);
  assert.match(main, /RELAY_OVERLAY_TEST_TOPMOST/);
  assert.match(main, /RELAY_OVERLAY_TEST_RECORDING/);
  assert.match(main, /isHarness && !isRecordingHarness \? \{ opacity: 0\.55 \} : \{\}/);
  assert.match(main, /ipcMain\.on\("relay:engage"/);
  assert.match(html, /window\.relay\.engage\?\.\(\)/, "a deliberate click raises Relay again after it yielded");
});

test("background render passes leave the keyboard with the normally focused window", () => {
  const applyView = sliceFunction(html, "function applyView(");
  assert.doesNotMatch(applyView, /setFocusable|typingInOverlayField/);
});

// The card is the app; only the notification needed the extra width. Widening
// the app itself makes the pill more intrusive for no benefit.
test("the expanded card stays at its designed width; only the banner is wider", () => {
  assert.match(html, /const EXPANDED = \{ w: 344, h: 524 \};/);
  assert.match(html, /const PEEK = \{ w: 400, h: 118 \};/);
  // The CSS width must track EXPANDED, or the card is letterboxed or clipped.
  assert.match(html, /width:344px; height:524px;/);
});

test("the native window starts in its platform geometry and synchronizes before readiness", () => {
  const initial = main.match(/const CARD_INITIAL = \{ w: (\d+), h: (\d+) \}/);
  assert.ok(initial, "main declares the initial visible card dimensions");
  assert.match(main, /let cardSize = \{ w: CARD_INITIAL\.w, h: CARD_INITIAL\.h \}/);
  const anchor = main.slice(main.indexOf("function anchorTopRight"), main.indexOf("function showOverlayWindow"));
  assert.match(anchor, /const nativeSize = FIXED_OVERLAY_SURFACE \? CARD_MAX : cardSize/);
  assert.match(anchor, /fittedOverlayBounds\(wa, nativeSize,/,
    "Windows gets card bounds while macOS gets the maximum canvas");

  const publish = html.lastIndexOf('publishCardSize(W.t, H.t, { phase:"settled", motionId:cardMotionId });');
  const ready = html.lastIndexOf("if (window.relay.rendererReady) window.relay.rendererReady();");
  assert.notEqual(publish, -1, "the renderer publishes its initial live geometry");
  assert.ok(publish < ready, "the initial native state is synchronized before main releases queued work");
});

test("card-size IPC resizes ordinary Windows windows and hit-tests only the macOS canvas", () => {
  const sizeHandler = main.slice(main.indexOf("function acceptRendererCardSize"), main.indexOf('ipcMain.on("relay:setPos"'));
  assert.match(sizeHandler, /cardSize = \{ w, h \}/);
  assert.match(sizeHandler, /if \(FIXED_OVERLAY_SURFACE\) scheduleHit\(0\);/,
    "a macOS visual target immediately refreshes the matching input region");
  assert.match(sizeHandler, /const settled = motion\.phase === "settled";[\s\S]*?fitOverlayWindowToCard\(\{ settle: settled \}\)/,
    "Windows follows the renderer with ordinary native bounds");
  assert.match(sizeHandler, /scheduleNativeGeometryReconcile\(settled \? NATIVE_GEOMETRY_VERIFY_MS : NATIVE_GEOMETRY_WATCHDOG_MS\)/,
    "Windows verifies settled bounds and has a bounded fallback for a missing receipt");
  const anchor = main.slice(main.indexOf("function anchorTopRight"), main.indexOf("function showOverlayWindow"));
  assert.match(anchor, /function anchorTopRight\(\)/);
  assert.match(anchor, /fittedOverlayBounds\(wa, nativeSize,/);
  const hitRect = sliceFunction(main, "function cardScreenRect(");
  assert.match(hitRect, /bounds\.x \+ bounds\.width - w/,
    "the visible card stays on the dragged surface's current top-right anchor");
  assert.match(main, /shouldIgnoreOverlayMouse\(point, cardScreenRect\(bounds\), pad\)/,
    "only the macOS transparent canvas needs pixels outside the card to pass through");
  assert.match(sizeHandler, /motionId < latestCardMotionId/,
    "a stale collapse completion cannot override a newer expansion");
  assert.match(sizeHandler, /motionSessionId !== latestCardMotionSessionId[\s\S]*?latestCardMotionId = 0/,
    "a renderer reload resets motion ordering before its new ids are compared");
  const show = main.slice(main.indexOf("function showOverlayWindow"), main.indexOf("function maybeShow"));
  assert.match(show, /target\.x !== current\.x \|\| target\.y !== current\.y/,
    "forced shows skip an identical fixed-canvas bounds transaction");
});

// The action menu flickered for the first few seconds after opening a relay,
// then settled. Cause: renderRelays rewrites the list wholesale, and
// notifyArrival calls renderAll() OUTSIDE the payload-signature guard — that
// guard lives in onPayload, bound to the `inbox` channel, while arrivals come
// through the separate `newRelay` channel. While the attention stack drained a
// backlog of unread one batch at a time, the list was destroyed and recreated
// once per batch, taking any open menu with it and replaying its 160ms reveal.
// It stopped on its own because backlogs are finite.
test("both relay-list renders skip the DOM write when the markup is unchanged", () => {
  const render = sliceFunction(html, "function renderRelays()");
  // Notification (unread-only) list.
  assert.match(render, /if \(relaysListEl\.innerHTML === nextNotifHtml\) return;/);
  // Conversation list.
  assert.match(render, /if \(relaysListEl\.innerHTML === nextListHtml\) return;/); // topic list keeps main no-op guard
  // The guard has to come BEFORE the write, or it guards nothing.
  const guard = render.indexOf("=== nextListHtml) return;");
  const write = render.indexOf("relaysListEl.innerHTML = nextListHtml;");
  assert.ok(guard > 0 && write > guard, "the guard must precede the write");
  // And nothing may assign the list innerHTML unguarded.
  const assignments = render.match(/relaysListEl\.innerHTML = /g) || [];
  // Three now: the banner, the list, and the empty-banner bail-out — a banner
  // with nothing in it is a glitch, so it clears rather than paints a void.
  assert.equal(assignments.length, 3, "banner, list, and the empty-banner clear");
  assert.match(render, /if \(!nextNotifHtml\) \{/);
});

test("an arrival over an already-open card does not re-render the world", () => {
  // The on-stage branch exists so a batch landing while the card is open lands
  // in the list instead of yanking the chrome. It must not undo that by
  // rebuilding the list underneath the reader.
  const notify = sliceFunction(html, "function notifyArrival(");
  assert.match(notify, /if \(onStageFull\) \{/);
});

test("one completed visible dwell retires a notification — it never re-pops for lack of a click", () => {
  const start = main.indexOf('ipcMain.on("relay:attentionDone"');
  const end = main.indexOf('ipcMain.handle("relay:soundBytes"', start);
  assert.ok(start >= 0 && end > start);
  const handler = main.slice(start, end);
  assert.match(handler, /const confirm = dwelled && visibleNow && !userIsAway\(\)/);
  assert.doesNotMatch(handler, /humanEvidence/);
  assert.doesNotMatch(handler, /currentShow\.inputSeen/);
});

test("legacy list menus render and wire the picker while remaining expanded", () => {
  const menu = sliceFunction(html, "function openActionsHtml(");
  assert.match(menu, /sessionPickerInlineHtml\(id, sessionPickerState\?\.provider\)/);
  // Sent rows live in the Sent tab and in the Relays tab's Sent segment, so the
  // wiring takes its container (the picker follows).
  assert.match(sliceFunction(html, "function wireSentRows("), /wireSessionPickerRows\(scope\)/);
  assert.match(sliceFunction(html, "function wireRelayRows("), /wireSessionPickerRows\(relaysListEl\)/);
  const loader = sliceFunction(html, "async function loadSessionPicker(");
  assert.match(loader, /if \(source === "sent"\) expandedSentId = id;\s*else expandedRelayId = id;/);
});
