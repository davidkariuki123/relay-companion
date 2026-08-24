import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const ackWorker = fs.readFileSync(new URL("../overlay/state-ack-worker.cjs", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start} .. ${end}`);
  return source.slice(from, to);
}

test("opening a room batches unread acknowledgements after the destination frame", () => {
  const open = between(html, "function openThreadDetail", "// ---------- Settings view");
  assert.match(open, /const roomAckIds = \[\]/);
  assert.match(open, /commitNavigation\(\{ outerScrollTop: 0 \}\)/);
  assert.match(open, /persistReadIds\(roomAckIds, \{ afterPaint: true \}\)/);
  assert.ok(open.indexOf("commitNavigation") < open.indexOf("persistReadIds"));
  assert.doesNotMatch(open, /window\.relay\.ack\(/);

  const persist = between(html, "function persistReadIds", "function readVisibleChatRoom");
  assert.match(persist, /if \(afterPaint\) requestAnimationFrame\(\(\) => requestAnimationFrame\(persist\)\)/);
  assert.match(persist, /window\.relay\.ackMany\?\.\(uniqueIds\)/);

  const batch = between(ackWorker, "function ackPacketsTransaction", "function ackPacketsInState");
  assert.equal((batch.match(/withJsonLockStrict\(/g) || []).length, 1, "one room performs one strict locked state transaction");
  assert.equal((batch.match(/atomicWriteJsonSync\(/g) || []).length, 1, "one room rewrites state once");
  const mainBatch = between(main, "async function persistAckBatch", "function scheduleStateAckFlush");
  assert.match(mainBatch, /await ackRowsOffMain\(ids, expectedAccount\)/);
  assert.doesNotMatch(mainBatch, /withJsonLock|readFileSync|atomicWriteJsonSync/);
  const queue = between(main, "function scheduleStateAckFlush", "function ackPacket");
  assert.match(queue, /groups = new Map\(\)/, "overlapping requests are coalesced by account");
  assert.match(queue, /group\.ids\.add\(id\)/);
  assert.match(queue, /group\.requests\.every\(\(request\) => request\.optimistic\)/,
    "only renderer-projected batches may suppress their redundant payload");
  const enqueue = between(main, "function ackPackets", "function ackPacket");
  assert.match(enqueue, /if \(optimistic\) deferQuietPush\(520\)/);
  assert.match(main, /pendingAckRefCounts/);
  assert.match(main, /row\.unread && !pendingAckIds\.has\(String\(row\.id\)\)/);
  assert.match(mainBatch, /pushInboxQuiet\(\{ stateChange: true \}\)/);
  assert.doesNotMatch(mainBatch, /pushInbox\(true\)/);
  const sideEffects = between(main, "function scheduleAckSideEffects", "async function persistAckBatch");
  assert.match(sideEffects, /const run = \(\) => \{/);
  assert.match(sideEffects, /quietPushNotBefore - Date\.now\(\)/);
  assert.match(sideEffects, /appendLocalTraces/);
  assert.match(sideEffects, /relayClient\(authToken \? \{ token: authToken \} : undefined\)/);
  assert.match(sideEffects, /ackClientMatchesAccount\(client, expectedAccount, authToken\)/);
  assert.match(main, /pendingAckSideEffects\.size/);
  assert.match(main, /flushAckSideEffectsForExit\(\);[\s\S]*?waitForStateAcksToDrainWithin/,
    "quit/relaunch drains deferred Seen receipts as well as the state worker");
  assert.match(main, /if \(stateAckQuitDraining\) \{[\s\S]*?event\.preventDefault\(\)/,
    "a repeated quit cannot bypass the active drain");
  assert.match(main, /stateAckFinalQuitPassThrough = true;[\s\S]*?app\.quit\(\)/,
    "pass-through is armed only for the controlled final quit");
  assert.match(enqueue, /if \(!ok\) pushInbox\(true\)/, "failed optimism is corrected by a canonical push");
  assert.match(main, /lastStateStatSig = currentStateSig;[\s\S]*?lastSig = "";/,
    "skipping an optimistic generation cannot hide a later unread restore");
  assert.match(preload, /ackMany: \(ids\) => ipcRenderer\.invoke\("relay:ackMany"/);
  assert.match(main, /ipcMain\.handle\("relay:ackMany"/);
  assert.match(main, /ackPackets\(Array\.isArray\(ids\) \? ids : \[\], \{ optimistic: true \}\)/);
  assert.match(main, /String\(file\) === "state\.json"/);
  assert.doesNotMatch(main, /startsWith\("state\.json"\)/);
});

test("the first pointer event never cold-starts Web Audio", () => {
  const pointer = between(html, 'window.addEventListener("mousedown", () => {', '}, { capture: true });');
  assert.match(pointer, /window\.relay\.engage/);
  assert.doesNotMatch(pointer, /initAudio|\.resume\(/);
  const prime = between(html, "function primeAudio", 'window.addEventListener("mousedown"');
  assert.match(prime, /requestIdleCallback/);
  assert.match(prime, /readerMorphSnapshot \|\| readerMorphInFlight \|\| roomViewTransition \|\| raf/);
});

test("all compact-to-reader resize transitions can hold a frozen source face", () => {
  const prepare = between(html, "function prepareReaderMorph", "function startReaderMorph");
  assert.doesNotMatch(prepare, /sourceView !== "tasks"/);
  for (const view of ["relays", "chat", "threads", "sent", "tasks", "contacts"]) {
    assert.match(prepare, new RegExp(`${view}:`));
  }
  assert.match(html, /const morphFromCompact = !chatExpanded && prepareReaderMorph\(activeView\)/);
  assert.match(prepare, /snapshot\.style\.width = `\$\{Math\.round\(cardEl\.getBoundingClientRect\(\)\.width\)\}px`/);
  assert.match(prepare, /node\.dataset\.readerMorphId = node\.id/);
  assert.match(prepare, /frozen\.scrollTop = live\.scrollTop/);
  assert.doesNotMatch(prepare, /readerOpenNow/);
  const start = between(html, "function startReaderMorph", "let peeking");
  assert.ok(start.indexOf('classList.add("reader-morph-destination")') < start.indexOf("requestAnimationFrame(async"),
    "the destination is hidden before the first paint opportunity");
  assert.match(start, /destinationView === "reader" \|\| \(destinationView === "threads" && chatExpanded\)/);
  assert.match(start, /syncCardSize\(destinationView === "reader" \|\| \(destinationView === "threads" && chatExpanded\)\)/);
});

test("compact room navigation animates exact viewport pixels with a matching Back transition", () => {
  const styles = between(html, "@keyframes roomPixelsForwardOld", "@keyframes roomForwardSourceOut");
  assert.match(styles, /roomPixelsForwardOld[\s\S]*translate3d\(-24%,0,0\)/,
    "the captured list recedes toward the leading edge");
  assert.match(styles, /roomPixelsForwardNew[\s\S]*translate3d\(100%,0,0\)/,
    "the captured room enters from the trailing edge");
  assert.match(styles, /roomPixelsBackOld[\s\S]*translate3d\(100%,0,0\)/,
    "Back returns the captured room toward the edge it entered from");
  assert.match(styles, /roomPixelsBackNew[\s\S]*translate3d\(-24%,0,0\)/,
    "Back restores the captured list from the same parallax depth");
  assert.doesNotMatch(styles, /scale\(/, "room text never scales during navigation");
  assert.equal((styles.match(/\.36s cubic-bezier\(\.32,\.72,0,1\)/g) || []).length, 4,
    "both faces and both directions share one timing curve");
  assert.match(styles, /::view-transition-group\(relay-room\)/);
  assert.match(styles, /::view-transition-image-pair\(relay-room\)/);
  assert.match(styles, /::view-transition-old\(relay-room\),[\s\S]*::view-transition-new\(relay-room\) \{[\s\S]*background:var\(--bg\)/,
    "both moving pixel faces are opaque");

  const relays = between(html, "function renderRelays()", "function relayIdentityRowHtml");
  assert.equal((relays.match(/prepareReaderMorph\(activeView, \{ motion:"forward" \}\)/g) || []).length, 1,
    "the resizing notification face retains the shared reader morph");
  assert.match(relays, /startRoomViewTransition\(\(\) => \{[\s\S]*?openThreadDetail\([\s\S]*?\}, \{ motion:"forward" \}\)/,
    "the stable Relays list uses browser-captured pixels for room entry");

  const back = between(html, 'thBackEl.addEventListener("click", () => {', "let threadsSource");
  assert.match(back, /startRoomViewTransition\(navigateBack, \{ motion:"back" \}\)/,
    "compact Back reverses the exact-pixel transition");
  assert.match(back, /prepareReaderMorph\("threads", \{ motion:"morph" \}\)/,
    "expanded Back still coordinates its real native resize");
  assert.match(back, /navigateBack\(\);[\s\S]*startReaderMorph\(activeView\)/);
});

test("the room transition names one stable viewport and cleans up on actual completion", () => {
  const room = between(html, "let roomViewTransition = null", "let peeking");
  assert.match(room, /typeof document\.startViewTransition !== "function"/);
  assert.match(room, /scrollEl\.style\.viewTransitionName = "relay-room"/,
    "the scroller viewport is the sole pixel snapshot");
  assert.match(room, /document\.startViewTransition\(\(\) => \{/);
  assert.match(room, /transition\.finished\.then\(/,
    "cleanup follows compositor completion instead of a guessed timeout");
  assert.doesNotMatch(room, /cloneNode|setTimeout|prepareCardSize/,
    "same-size room navigation has no DOM clone, timer, or native-size IPC barrier");
  assert.match(room, /const deferredPayload = roomViewTransitionDeferredPayload/);
  assert.match(room, /if \(deferredPayload\) queueMicrotask\(\(\) => onPayload\(deferredPayload\)\)/,
    "the newest payload reconciles after the compositor transaction");
});

test("payload reconciliation cannot rebuild the destination during its crossfade", () => {
  const clean = between(html, "function cleanReaderMorph", "function prepareReaderMorph");
  assert.match(clean, /const deferredPayload = readerMorphDeferredPayload/);
  assert.match(clean, /queueMicrotask\(\(\) => onPayload\(deferredPayload\)\)/);
  const payload = between(html, "function onPayload", "window.relay.onInbox");
  assert.match(payload, /if \(readerMorphSnapshot\) \{[\s\S]*?readerMorphDeferredPayload = next;[\s\S]*?return;/);
});

test("payload reconciliation cannot replace a room while its snapshots are moving", () => {
  const payloadHandler = between(html, "function onPayload(next)", "window.relay.onInbox(onPayload)");
  assert.match(payloadHandler, /if \(roomViewTransition\) \{[\s\S]*roomViewTransitionDeferredPayload = next;[\s\S]*return;/);
});

test("an unrelated polling payload cannot resurrect an optimistic read", () => {
  const persist = between(html, "function persistReadIds", "function readVisibleChatRoom");
  assert.match(persist, /optimisticReadIds\.add\(id\)/);
  assert.match(persist, /optimisticReadIds\.delete\(id\)/);
  assert.match(persist, /row\.unread = true/);
  const payload = between(html, "function onPayload", "window.relay.onInbox");
  assert.match(payload, /optimisticReadIds\.has\(id\)/);
  assert.match(payload, /return \{ \.\.\.row, unread: false, state: "read" \}/);
  assert.match(payload, /row\.unread === false \|\| row\.state === "read"/);
});
