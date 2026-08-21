// The pill's half of the send outbox.
//
// overlay/main.cjs cannot be required outside Electron, so the wiring is pinned
// at the source — the same idiom the other pill-contract tests use. The live
// behaviour these describe is proved end to end by test/offline-send-probe.mjs,
// which boots the real app against a network it can cut.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");

test("Send commits to the queue and answers; it does not wait for the network", () => {
  assert.match(main, /ipcMain\.handle\("relay:sendReply", \(_e, input\) => enqueueReplyFromPill\(input\)\)/);
  assert.match(main, /function enqueueReplyFromPill\(input = \{\}\)/);
  assert.match(main, /const entry = outbox\.enqueue\(\{/);
  assert.match(main, /return \{ ok: true, queued: true, entry \}/);
  // The old handler awaited one HTTP attempt and flattened the outcome. Nothing
  // on the composer's path may await a send again.
  assert.doesNotMatch(main, /async function sendReplyFromPill/);
  assert.doesNotMatch(main, /ipcMain\.handle\("relay:sendReply", \(_e, input\) => sendReplyFromPill/);
});

test("the transport throws, because the queue judges the failure", () => {
  // Flattening every failure to { ok:false, error:"fetch failed" } is what left
  // the composer unable to tell a dead wifi from a rejected message — and so it
  // treated both as "give the words back".
  assert.match(main, /async function postQueuedRelay\(entry\)/);
  assert.match(main, /return client\.sendRelay\(\{/);
  assert.match(main, /idempotencyKey: entry\.idempotencyKey/);
  const transport = main.slice(main.indexOf("async function postQueuedRelay"), main.indexOf("function enqueueReplyFromPill"));
  assert.doesNotMatch(transport, /catch \(error\)/, "the transport reports the real error, it does not swallow it");
});

test("the queue reaches the renderer, and its own progress moves the payload", () => {
  assert.match(main, /const outbox = createOutbox\(\{/);
  assert.match(main, /file: OUTBOX_PATH/);
  assert.match(main, /outbox: outbox\.list\(\)/);
  // Nothing else in the payload moves while a message sits offline, so without
  // the queue in the push signature its progress would never be painted.
  assert.match(main, /outbox: \(payload\.outbox \|\| \[\]\)\.map\(\(e\) => \[e\.id, e\.state, e\.attempts/);
  assert.match(main, /onChange: \(\) => pushInboxQuiet\(\)/);
});

test("an older Sent response cannot erase a message revealed by a newer one", () => {
  assert.match(main, /let sentRefreshStarted = 0;/);
  assert.match(main, /let sentRefreshCommitted = 0;/);
  assert.match(main, /const refreshId = \+\+sentRefreshStarted;/);
  assert.match(main, /refreshId < sentRefreshCommitted/);
  assert.match(main, /sentRefreshCommitted = refreshId;/);
  assert.match(main, /deviceToken\(\) !== credential/);
});

test("a queued message is retired by the server's own view, and resumes on any evidence of network", () => {
  assert.match(main, /outbox\.retireConfirmed\(\{/);
  assert.match(main, /relayIds: sentCache\.map\(/);
  assert.match(main, /groupSendIds: sentCache\.map\(/);
  assert.match(main, /if \(outbox\.pendingCount\(\)\) outbox\.resume\(\)/);
  // Anything typed before the last quit goes out on the next launch.
  assert.match(main, /outbox\.start\(\);/);
  assert.match(main, /ipcMain\.handle\("relay:networkOnline"/);
  assert.match(main, /ipcMain\.handle\("relay:outboxRetry"/);
  assert.match(main, /ipcMain\.handle\("relay:outboxDiscard"/);
});

test("the preload exposes exactly the queue controls the room needs", () => {
  assert.match(preload, /outboxRetry: \(id\) => ipcRenderer\.invoke\("relay:outboxRetry", id\)/);
  assert.match(preload, /outboxDiscard: \(id\) => ipcRenderer\.invoke\("relay:outboxDiscard", id\)/);
  assert.match(preload, /networkOnline: \(\) => ipcRenderer\.invoke\("relay:networkOnline"\)/);
});
