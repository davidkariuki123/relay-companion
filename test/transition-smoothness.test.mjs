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
  assert.match(prime, /readerMorphSnapshot \|\| readerMorphInFlight \|\| raf/);
});

test("all compact-to-reader transitions can hold a frozen source face", () => {
  const prepare = between(html, "function prepareReaderMorph", "function startReaderMorph");
  assert.doesNotMatch(prepare, /sourceView !== "requests"/);
  for (const view of ["relays", "chat", "threads", "sent", "requests", "contacts"]) {
    assert.match(prepare, new RegExp(`${view}:`));
  }
  assert.match(html, /const morphFromList = prepareReaderMorph\(activeView\);[\s\S]*?startReaderMorph\("threads"\)/);
  assert.match(html, /const morphFromCompact = !chatExpanded && prepareReaderMorph\(activeView\)/);
  assert.match(prepare, /snapshot\.style\.width = `\$\{Math\.round\(cardEl\.getBoundingClientRect\(\)\.width\)\}px`/);
  assert.match(prepare, /node\.dataset\.readerMorphId = node\.id/);
  assert.match(prepare, /frozen\.scrollTop = live\.scrollTop/);
  assert.doesNotMatch(prepare, /readerOpenNow/);
  const start = between(html, "function startReaderMorph", "let peeking");
  assert.ok(start.indexOf('classList.add("reader-morph-destination")') < start.indexOf("requestAnimationFrame(async"),
    "the destination is hidden before the first paint opportunity");
  assert.match(start, /destinationView === "threads" && !chatExpanded \? EXPANDED : READER/);
  assert.match(start, /syncCardSize\(destinationView === "threads" \? chatExpanded : true\)/);
});

test("payload reconciliation cannot rebuild the destination during its crossfade", () => {
  const clean = between(html, "function cleanReaderMorph", "function prepareReaderMorph");
  assert.match(clean, /const deferredPayload = readerMorphDeferredPayload/);
  assert.match(clean, /queueMicrotask\(\(\) => onPayload\(deferredPayload\)\)/);
  const payload = between(html, "function onPayload", "window.relay.onInbox");
  assert.match(payload, /if \(readerMorphSnapshot\) \{[\s\S]*?readerMorphDeferredPayload = next;[\s\S]*?return;/);
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
