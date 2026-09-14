import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import context from "../src/agent-relay-context.cjs";

const {
  readAgentTopicIndex,
  recordAgentTopicIndex,
  CONTEXT_MAX_ITEMS,
  INDEX_MAX_ITEMS,
  claimAgentRelayHookContext,
  normalizeMetadata,
  recordAgentRelayIndex,
  snapshotPath,
} = context;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-context-"));
}

function relay(number, nowMs, extra = {}) {
  const offset = typeof number === "number" ? number * 1000 : 0;
  return {
    relayId: `relay_${number}`,
    title: `Title ${number}`,
    sender: { name: `Sender ${number}` },
    createdAt: new Date(nowMs - offset).toISOString(),
    kind: "message",
    ...extra,
  };
}

test("title index is account-isolated, sanitized, body-free, seven-day, and capped at 50", () => {
  const home = tempHome();
  const nowMs = Date.now();
  const items = Array.from({ length: 55 }, (_, i) => relay(i + 1, nowMs));
  items.push(relay("old", nowMs, { createdAt: new Date(nowMs - 8 * 86400_000).toISOString() }));
  items.push({
    ...relay("unsafe", nowMs),
    title: "\u001b[31mQuarterly\u202e report\u0000",
    sender: { name: "A\u200bda" },
    body: "TOP SECRET BODY",
    packet: { body: "ALSO SECRET" },
  });
  items.push(items[0]);

  const written = recordAgentRelayIndex(home, "account-a", { items }, { nowMs });
  assert.equal(written.changed, true);
  assert.equal(written.snapshot.items.length, INDEX_MAX_ITEMS);
  assert.equal(written.snapshot.recentCount, 56, "old and duplicate rows are excluded");
  assert.equal(written.snapshot.truncated, true);
  const disk = fs.readFileSync(snapshotPath(home, "account-a"), "utf8");
  assert.doesNotMatch(disk, /TOP SECRET|ALSO SECRET|\"body\"|\"packet\"/);
  assert.doesNotMatch(disk, /\u001b|\u202e|\u0000|\u200b/);
  assert.equal(fs.existsSync(snapshotPath(home, "account-b")), false);
  assert.equal(claimAgentRelayHookContext(home, "account-b", {
    sessionId: "same-session",
    eventName: "UserPromptSubmit",
    nowMs,
  }), null);
  assert.equal(normalizeMetadata("\u001b[31m hi\u202e\u0000"), "hi");
});

test("unchanged title snapshot is not rewritten", async () => {
  const home = tempHome();
  const nowMs = Date.now();
  const response = { items: Array.from({ length: 55 }, (_, index) => relay(index + 1, nowMs)) };
  recordAgentRelayIndex(home, "account", response, { nowMs });
  const file = snapshotPath(home, "account");
  const firstContents = fs.readFileSync(file, "utf8");
  const first = fs.statSync(file).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = recordAgentRelayIndex(home, "account", response, { nowMs: nowMs + 25 });
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), firstContents, "truncated rows do not advance the sequence");
  assert.equal(fs.statSync(file).mtimeMs, first);
});

test("the MCP process can read the daemon topic snapshot for a session with no hook", () => {
  const home = tempHome();
  const scope = "topic-index-account";
  assert.deepEqual(readAgentTopicIndex(home, scope), []);
  recordAgentTopicIndex(home, scope, { topics: [
    { id: "tpc_dev", name: "Dev work and deploys", mandate: "Deploys.", mandateVersion: 1, postCount: 2, latestPostAt: "2026-09-10T19:00:00.000Z", membership: { state: "active", mandateCurrent: true } },
    { id: "tpc_old", name: "Declined", mandate: "x", mandateVersion: 1, postCount: 0, membership: { state: "declined", mandateCurrent: false } },
  ] });
  const topics = readAgentTopicIndex(home, scope);
  assert.deepEqual(topics.map((topic) => [topic.topicId, topic.standing, topic.postCount]), [["tpc_dev", "current", 2]]);
});

test("a read flip rewrites the snapshot exactly once, without idle churn", () => {
  const home = tempHome();
  const nowMs = Date.now();
  const unread = { items: [relay("flips", nowMs, { state: "delivered" })] };
  const read = { items: [relay("flips", nowMs, { state: "read" })] };
  assert.equal(recordAgentRelayIndex(home, "account", unread, { nowMs }).changed, true);
  // Identical poll: no rewrite. Read state must not reintroduce the four-second
  // idle disk write that the daemon call site guards against.
  assert.equal(recordAgentRelayIndex(home, "account", unread, { nowMs: nowMs + 4000 }).changed, false);
  const flipped = recordAgentRelayIndex(home, "account", read, { nowMs: nowMs + 8000 });
  assert.equal(flipped.changed, true, "a genuine read flip is a real change");
  assert.equal(flipped.snapshot.items[0].read, true);
  assert.equal(recordAgentRelayIndex(home, "account", read, { nowMs: nowMs + 12000 }).changed, false);
});

test("retired claims never read snapshots or advance session state", () => {
  for (const eventName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const trap = new Proxy({}, { get() { throw new Error("retired context inspected input"); } });
    assert.equal(claimAgentRelayHookContext(trap, trap, { eventName }), null);
  }
});

test("retired hooks stay silent regardless of the account feature row", () => {
  for (const todo of [true, false]) {
    assert.equal(claimAgentRelayHookContext("ignored", "ignored", { sessionId: "s", eventName: "UserPromptSubmit", todo }), null);
  }
});
