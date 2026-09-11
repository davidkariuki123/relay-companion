// The session event board: a per-session cursor over the daemon's snapshots,
// rendered into a tool description and cleared by the reads that consume it.
// This is the mid-session channel for sessions that have no Relay hook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import context from "../src/agent-relay-context.cjs";
import digestModule from "../src/session-digest.cjs";

const { recordAgentRelayIndex, recordAgentTopicIndex } = context;
const { QUIET_DESCRIPTION, createSessionDigest, describeDigest, watchSessionDigest, statePath } = digestModule;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-digest-"));
}
function relay(number, nowMs, extra = {}) {
  return { relayId: `relay_${number}`, title: `Title ${number}`, sender: { name: `Sender ${number}` }, createdAt: new Date(nowMs + number * 1000).toISOString(), kind: "message", ...extra };
}
function topic(id, overrides = {}) {
  return { id, name: `Topic ${id}`, mandate: "About things.", mandateVersion: 1, postCount: 0, latestPostAt: "", membership: { state: "active", mandateCurrent: true }, ...overrides };
}

test("a new session starts quiet at the current snapshots and reports only what arrives afterwards", () => {
  const home = tempHome();
  const scope = "dev_token";
  const nowMs = Date.parse("2026-09-11T09:00:00.000Z");
  recordAgentRelayIndex(home, scope, { items: [relay(1, nowMs)] }, { nowMs: nowMs + 5000 });
  recordAgentTopicIndex(home, scope, { topics: [topic("tpc_dev", { postCount: 2, latestPostAt: "2026-09-11T08:00:00.000Z" })] });
  const board = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_1", nowMs });
  assert.equal(board.refresh().description, QUIET_DESCRIPTION);
  assert.ok(fs.existsSync(statePath(home, scope, "ses_1")));

  recordAgentRelayIndex(home, scope, { items: [relay(2, nowMs, { sender: { name: "Sven" } }), relay(1, nowMs)] }, { nowMs: nowMs + 10_000 });
  recordAgentTopicIndex(home, scope, { topics: [
    topic("tpc_dev", { postCount: 5, latestPostAt: "2026-09-11T09:05:00.000Z" }),
    topic("tpc_design", { membership: { state: "invited", mandateCurrent: false } }),
  ] });
  const { changed, description, digest } = board.refresh();
  assert.equal(changed, true);
  assert.match(description, /^NEW since this session last checked\./);
  assert.match(description, /Relays \(1\): \{"receivedAt":.*"sender":"Sven","title":"Title 2","relayId":"relay_2","kind":"message"\}/);
  assert.match(description, /Topics: .*3 new posts on Topic tpc_dev \[tpc_dev\] since 2026-09-11T/);
  assert.match(description, /invited to Topic tpc_design \[tpc_design\]: join in the Relay app/);
  assert.deepEqual(digest.newRelays.map((item) => item.relayId), ["relay_2"]);
  assert.equal(board.refresh().changed, false, "an unchanged digest is not re-announced");
});

test("taking the board returns the records and clears it; narrower reads clear only what they opened", () => {
  const home = tempHome();
  const scope = "dev_token";
  const nowMs = Date.parse("2026-09-11T09:00:00.000Z");
  recordAgentRelayIndex(home, scope, { items: [] }, { nowMs });
  recordAgentTopicIndex(home, scope, { topics: [topic("tpc_dev", { postCount: 1 })] });
  const board = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_2", nowMs });
  recordAgentRelayIndex(home, scope, { items: [relay(3, nowMs), relay(2, nowMs), relay(1, nowMs)] }, { nowMs: nowMs + 5000 });
  recordAgentTopicIndex(home, scope, { topics: [topic("tpc_dev", { postCount: 4 }), topic("tpc_new")] });

  // Opening only the oldest new Relay moves the cursor past it and no further.
  board.commitRelays(["relay_1"]);
  let digest = board.refresh().digest;
  assert.deepEqual(digest.newRelays.map((item) => item.relayId), ["relay_2", "relay_3"]);
  // Opening a later one without the one before it leaves the cursor alone.
  board.commitRelays(["relay_3"]);
  assert.deepEqual(board.refresh().digest.newRelays.map((item) => item.relayId), ["relay_2", "relay_3"]);
  // Listing topics clears membership changes but keeps unread posts.
  board.commitTopicList();
  digest = board.refresh().digest;
  assert.deepEqual(digest.topicChanges.map((change) => [change.topicId, change.change]), [["tpc_dev", "new posts"]]);
  // Reading the board clears its posts.
  board.commitTopic("tpc_dev");
  assert.deepEqual(board.refresh().digest.topicChanges, []);
  // Taking everything returns the rest and leaves the board quiet.
  const taken = board.take();
  assert.deepEqual(taken.relays.map((item) => item.relayId), ["relay_2", "relay_3"]);
  assert.equal(board.refresh().description, QUIET_DESCRIPTION);
  // The cursor survives a new board instance for the same session.
  const again = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_2" });
  assert.equal(again.refresh().description, QUIET_DESCRIPTION);
  // A different session on the same account has its own cursor.
  const other = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_3" });
  assert.equal(other.refresh().description, QUIET_DESCRIPTION, "a session opened now starts at the current snapshots");
});

test("the description stays within the host budget and topics are omitted off the developer row", () => {
  const home = tempHome();
  const scope = "dev_token";
  const nowMs = Date.parse("2026-09-11T09:00:00.000Z");
  recordAgentRelayIndex(home, scope, { items: [] }, { nowMs });
  const board = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_4", topicsEnabled: false, nowMs });
  recordAgentRelayIndex(home, scope, { items: Array.from({ length: 40 }, (_, index) => relay(index + 1, nowMs, { title: "T".repeat(170) })) }, { nowMs: nowMs + 5000 });
  recordAgentTopicIndex(home, scope, { topics: [topic("tpc_dev", { postCount: 9 })] });
  const { description } = board.refresh();
  assert.ok(Buffer.byteLength(description, "utf8") <= 2_048);
  assert.match(description, /Relays \(40\):/);
  assert.doesNotMatch(description, /Topics:/);
  assert.deepEqual(board.take().topics, []);
  assert.equal(describeDigest({ newRelays: [], topicChanges: [{ topicId: "tpc_x", name: "X", change: "invited" }] }, { topicsEnabled: false }), QUIET_DESCRIPTION);
});

test("the watcher announces a changed digest once per snapshot change", async () => {
  const home = tempHome();
  const scope = "dev_token";
  const nowMs = Date.parse("2026-09-11T09:00:00.000Z");
  recordAgentRelayIndex(home, scope, { items: [] }, { nowMs });
  const board = createSessionDigest({ homeDir: home, accountScope: scope, sessionKey: "ses_5", nowMs });
  const announced = [];
  const watch = watchSessionDigest(board, { homeDir: home, accountScope: scope, intervalMs: 60_000, onChange: (description) => announced.push(description) });
  try {
    watch.tick();
    assert.deepEqual(announced, [], "nothing new, nothing announced");
    await new Promise((resolve) => setTimeout(resolve, 20));
    recordAgentRelayIndex(home, scope, { items: [relay(1, nowMs)] }, { nowMs: nowMs + 5000 });
    watch.tick();
    watch.tick();
    assert.equal(announced.length, 1);
    assert.match(announced[0], /relay_1/);
    board.take();
    assert.equal(board.refresh().description, QUIET_DESCRIPTION);
  } finally {
    watch.stop();
  }
});
