import test from "node:test";
import assert from "node:assert/strict";
import {
  SHOW_RETRY_LIMIT,
  loadQueue,
  saveQueue,
  enqueueUnseen,
  nextToShow,
  beginShow,
  confirmSeen,
  abortShow,
  drop,
  reconcileWithUnread,
  pendingCount,
  hasShowing,
} from "../overlay/attention-queue.cjs";

test("enqueueUnseen adds only unseen, unqueued ids", () => {
  const q = loadQueue({});
  const added = enqueueUnseen(q, ["a", "b", "a", "", null], { presentedIds: new Set(["b"]), now: 100 });
  assert.deepEqual(added, ["a"]);
  assert.equal(pendingCount(q), 1);
  // Re-enqueueing an already-queued id is a no-op (attempts survive).
  beginShow(q, "a");
  abortShow(q, "a");
  const again = enqueueUnseen(q, ["a"], { presentedIds: new Set(), now: 200 });
  assert.deepEqual(again, []);
  assert.equal(q.get("a").attempts, 1);
});

test("nextToShow serves oldest first and is null while a card is on stage", () => {
  const q = loadQueue({});
  enqueueUnseen(q, ["newer"], { now: 200 });
  enqueueUnseen(q, ["older"], { now: 100 });
  assert.equal(nextToShow(q).id, "older");
  beginShow(q, "older");
  assert.equal(nextToShow(q), null); // strict one-at-a-time
  confirmSeen(q, "older");
  assert.equal(nextToShow(q).id, "newer");
});

test("confirmSeen removes; abortShow keeps and eventually marks sticky", () => {
  const q = loadQueue({});
  enqueueUnseen(q, ["x"], { now: 1 });
  for (let i = 0; i < SHOW_RETRY_LIMIT; i++) {
    beginShow(q, "x");
    abortShow(q, "x");
  }
  assert.equal(q.get("x").sticky, true, "unconfirmed dwells exhaust into sticky");
  assert.equal(pendingCount(q), 1, "sticky entries never drop silently");
  beginShow(q, "x");
  assert.ok(confirmSeen(q, "x"));
  assert.equal(pendingCount(q), 0);
});

test("persistence round-trips and demotes in-flight shows on load (crash recovery)", () => {
  const q = loadQueue({});
  enqueueUnseen(q, ["a", "b"], { now: 5 });
  beginShow(q, "a");
  const prefs = saveQueue(q, {});
  const revived = loadQueue(prefs);
  assert.equal(pendingCount(revived), 2, "a crash mid-show loses nothing");
  assert.equal(revived.get("a").showing, false, "in-flight show demoted to pending");
  assert.equal(revived.get("a").attempts, 1, "the attempt still counted");
  assert.equal(hasShowing(revived), false);
});

test("reconcileWithUnread drops entries the user handled elsewhere, never fresh unread", () => {
  const q = loadQueue({});
  enqueueUnseen(q, ["kept", "readElsewhere", "deleted"], { now: 9 });
  const dropped = reconcileWithUnread(q, new Set(["kept"]));
  assert.deepEqual(dropped.sort(), ["deleted", "readElsewhere"]);
  assert.equal(pendingCount(q), 1);
  assert.ok(q.has("kept"));
});

test("drop expresses an explicit per-relay user act", () => {
  const q = loadQueue({});
  enqueueUnseen(q, ["opened"], { now: 3 });
  assert.ok(drop(q, "opened"));
  assert.equal(pendingCount(q), 0);
});

test("legacy/garbage prefs shapes load safely", () => {
  for (const raw of [null, 42, "x", [], [{ id: "a", enqueuedAt: 1 }], { a: { enqueuedAt: 2 } }, { "": {} }]) {
    const q = loadQueue({ pendingAttention: raw });
    assert.ok(q instanceof Map);
    for (const entry of q.values()) {
      assert.equal(typeof entry.id, "string");
      assert.ok(entry.id.length > 0);
      assert.equal(entry.showing, false);
    }
  }
});
