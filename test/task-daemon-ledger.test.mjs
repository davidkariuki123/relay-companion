import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ledgerContentSignature ignores the per-write updatedAt stamp", async () => {
  const daemon = await import("../src/task-daemon.js");
  const a = { sessions: {}, processedMessages: { m1: { taskId: "t1" } }, updatedAt: "2026-01-01T00:00:00Z" };
  const b = { sessions: {}, processedMessages: { m1: { taskId: "t1" } }, updatedAt: "2026-02-02T00:00:00Z" };
  const c = { sessions: {}, processedMessages: { m1: { taskId: "OTHER" } }, updatedAt: "2026-01-01T00:00:00Z" };
  assert.equal(daemon.ledgerContentSignature(a), daemon.ledgerContentSignature(b));
  assert.notEqual(daemon.ledgerContentSignature(a), daemon.ledgerContentSignature(c));
});

test("idle polls stop rewriting an unchanged task ledger; a staging poll still writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-daemon-ledger-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const daemon = await import("../src/task-daemon.js");
  const { default: agentContext } = await import("../src/agent-relay-context.cjs");
  const ledgerPath = path.join(dir, "task-ledger.json");
  const idleClient = {
    token: "snapshot-account",
    inbox: async () => ({ items: [] }),
    fetchRelay: async () => ({ packet: {}, attachmentUrls: {} }),
  };

  // First poll may write once (it materializes the ledger's default maps).
  await daemon.pollOrdinaryRelayOnce({ client: idleClient, log: () => {}, agentContextHome: dir });
  const first = fs.statSync(ledgerPath);
  const snapshotFile = agentContext.snapshotPath(dir, "snapshot-account");

  // Steady state: an idle poll must not touch the file at all.
  await sleep(25);
  await daemon.pollOrdinaryRelayOnce({ client: idleClient, log: () => {}, agentContextHome: dir });
  const second = fs.statSync(ledgerPath);
  assert.equal(second.mtimeMs, first.mtimeMs, "unchanged ledger was rewritten on an idle poll");

  // A poll that stages something must still persist its dedupe state.
  const relayCreatedAt = new Date().toISOString();
  const stagingClient = {
    token: "snapshot-account",
    inbox: async () => ({
      items: [
        {
          relayId: "relay_ledger_test",
          state: "delivered",
          updatedAt: "2026-08-05T00:00:00.000Z",
          createdAt: relayCreatedAt,
          title: "Ledger test relay",
          sender: { name: "Ledger Tester" },
          body: "must never enter the title index",
        },
      ],
    }),
    fetchRelay: async () => ({ packet: { relayId: "relay_ledger_test" }, attachmentUrls: {} }),
  };
  await sleep(25);
  await daemon.pollOrdinaryRelayOnce({
    client: stagingClient,
    log: () => {},
    stagePlainRelay: () => {},
    agentContextHome: dir,
  });
  const third = fs.statSync(ledgerPath);
  assert.notEqual(third.mtimeMs, second.mtimeMs, "a staging poll must write the ledger");
  const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.ok(persisted.plainRelays.relay_ledger_test, "dedupe entry persisted");
  const snapshot = fs.readFileSync(snapshotFile, "utf8");
  assert.match(snapshot, /Ledger test relay/);
  assert.doesNotMatch(snapshot, /must never enter|\"body\"/);
  const stagedSnapshot = fs.statSync(snapshotFile).mtimeMs;
  await sleep(25);
  await daemon.pollOrdinaryRelayOnce({
    client: stagingClient,
    log: () => {},
    stagePlainRelay: () => {},
    agentContextHome: dir,
  });
  assert.equal(
    fs.statSync(snapshotFile).mtimeMs,
    stagedSnapshot,
    "an unchanged daemon inbox snapshot was rewritten",
  );
});

// ---- self-exit after a launched update: the replaced daemon must not outlive its replacement ----
//
// Field report (Shane, 2026-08-17): the old daemon kept running after "self-update
// launched", survived `schtasks /End` (not in the task's tree via the WMI escape hatch),
// held daemon.log open so the /Run'd replacement's cmd wrapper exited 1, then re-fired
// the same update from its stale in-memory version and raced the tree into an
// unbootable state.

function fakeTimers() {
  // Deterministic setInterval/clearInterval + clock, so the test needs no real waiting.
  let nowMs = 0;
  const intervals = new Map();
  let nextId = 1;
  return {
    now: () => nowMs,
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    advance(ms) {
      // Fire every live interval once per tick boundary crossed, in ms steps.
      const end = nowMs + ms;
      while (nowMs < end) {
        nowMs += 1;
        for (const [id, iv] of [...intervals]) {
          if (nowMs % iv.ms === 0 && intervals.has(id)) iv.fn();
        }
      }
    },
    liveCount: () => intervals.size,
  };
}

test("scheduleSelfUpdateExit exits once the tree on disk is a different version than the running one", async () => {
  const daemon = await import("../src/task-daemon.js");
  const t = fakeTimers();
  let onDisk = "0.1.20";
  const exits = [];
  const logs = [];
  daemon.scheduleSelfUpdateExit({
    runningVersion: "0.1.20",
    packageRoot: "C:\irrelevant",
    readVersion: () => onDisk,
    exitImpl: (code) => exits.push(code),
    log: (m) => logs.push(m),
    pollMs: 10,
    ceilingMs: 10_000,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
    now: t.now,
  });
  t.advance(50);
  assert.deepEqual(exits, [], "must NOT exit while disk still carries the running version");
  onDisk = "0.1.21"; // the updater committed the new tree
  t.advance(20);
  assert.deepEqual(exits, [0], "exits (code 0) as soon as the new tree is observed");
  assert.equal(t.liveCount(), 0, "the poll timer is cleared after exiting");
  assert.ok(logs.some((m) => /new tree 0\.1\.21 is on disk \(was running 0\.1\.20\)/.test(m)), logs.join("\n"));
});

test("scheduleSelfUpdateExit keeps the daemon alive at the ceiling when no replacement committed", async () => {
  const daemon = await import("../src/task-daemon.js");
  const t = fakeTimers();
  const exits = [];
  const logs = [];
  let resumptions = 0;
  daemon.scheduleSelfUpdateExit({
    runningVersion: "0.1.20",
    packageRoot: "C:\irrelevant",
    readVersion: () => "0.1.20", // never changes (e.g. install failed, or unreadable)
    exitImpl: (code) => exits.push(code),
    onCeiling: () => { resumptions += 1; },
    log: (m) => logs.push(m),
    pollMs: 10,
    ceilingMs: 100,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
    now: t.now,
  });
  t.advance(95);
  assert.deepEqual(exits, [], "not before the ceiling");
  t.advance(20);
  assert.deepEqual(exits, [], "a failed update cannot take a logon-only Windows daemon offline");
  assert.equal(resumptions, 1, "the updater loop is released to retry with its normal backoff");
  assert.equal(t.liveCount(), 0, "the observation timer is cleared at the ceiling");
  assert.ok(logs.some((m) => /without a verified replacement; keeping the current daemon alive/.test(m)), logs.join("\n"));
});

test("scheduleSelfUpdateExit tolerates an unreadable package.json and resumes only once", async () => {
  const daemon = await import("../src/task-daemon.js");
  const t = fakeTimers();
  const exits = [];
  let resumptions = 0;
  daemon.scheduleSelfUpdateExit({
    runningVersion: "0.1.20",
    packageRoot: "C:\irrelevant",
    readVersion: () => null, // mid-swap: package.json briefly absent
    exitImpl: (code) => exits.push(code),
    onCeiling: () => { resumptions += 1; },
    pollMs: 10,
    ceilingMs: 30,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
    now: t.now,
  });
  t.advance(200); // well past the ceiling, many ticks
  assert.deepEqual(exits, []);
  assert.equal(resumptions, 1, "many post-ceiling ticks cannot release the updater loop twice");
});

test("canonical self-exit waits for the active pointer instead of timing immutable staging", async () => {
  const daemon = await import("../src/task-daemon.js");
  const t = fakeTimers();
  const exits = [];
  let selected = false;
  daemon.scheduleSelfUpdateExit({
    runningVersion: "0.1.240",
    packageRoot: "/immutable/old",
    readVersion: () => "0.1.240",
    replacementReady: () => selected,
    exitImpl: (code) => exits.push(code),
    pollMs: 10,
    ceilingMs: 1_000,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
    now: t.now,
  });
  t.advance(900);
  assert.deepEqual(exits, [], "slow staging does not change the immutable running tree or force an early exit");
  selected = true;
  t.advance(20);
  assert.deepEqual(exits, [0], "active pointer selection is the commit observation");
});

test("startAutoUpdateLoop arms the self-exit exactly once per launched update", async () => {
  const daemon = await import("../src/task-daemon.js");
  const t = fakeTimers();
  let status = "updating";
  const armed = [];
  const autoUpdater = { tick: async () => ({ status, current: "0.1.20", latest: "0.1.21" }) };
  const loop = daemon.startAutoUpdateLoop({
    autoUpdater,
    log: () => {},
    intervalMs: 10,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
    onUpdateLaunched: (u) => armed.push(u.latest),
  });
  await loop.run(); // immediate check
  await loop.run(); // a re-tick while the updater is still installing
  await loop.run();
  assert.deepEqual(armed, ["0.1.21"], "re-ticks must not re-arm (or re-exit) the daemon");
  status = "up-to-date";
  await loop.run();
  assert.deepEqual(armed, ["0.1.21"]);
  loop.stop();
});

test("startAutoUpdateLoop quiesces the replacing daemon after one external launch", async () => {
  const { startAutoUpdateLoop } = await import("../src/task-daemon.js");
  let ticks = 0;
  const loop = startAutoUpdateLoop({
    autoUpdater: { tick: async () => { ticks += 1; return { status: "updating", current: "0.1.20", latest: "0.1.21" }; } },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    onUpdateLaunched: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await loop.run()).status, "replacement-pending");
  assert.equal((await loop.run()).status, "replacement-pending");
  assert.equal(ticks, 1, "the orphan cannot re-fire from stale in-memory state");
});

test("startAutoUpdateLoop resumes after an updater times out without a verified replacement", async () => {
  const { startAutoUpdateLoop } = await import("../src/task-daemon.js");
  let ticks = 0;
  let status = "updating";
  let resumeChecks = null;
  const loop = startAutoUpdateLoop({
    autoUpdater: { tick: async () => { ticks += 1; return { status, current: "0.1.20", latest: "0.1.21" }; } },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    onUpdateLaunched: (_update, controls) => { resumeChecks = controls.resumeChecks; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await loop.run()).status, "replacement-pending");
  status = "up-to-date";
  resumeChecks();
  assert.equal((await loop.run()).status, "up-to-date");
  assert.equal(ticks, 2, "the live daemon returns to normal checks after the failed attempt");
});
