// Unit tests for the Codex Open-in-current-chat plumbing (src/codex-inject.js):
// rollout-tail busy/idle parsing, current-thread resolution across
// session_index recency + rollout mtime, the near-now heartbeat automation
// writer (exact TOML shape) + stale cleanup, and the instruction builder shared
// with the Claude path. Everything runs in temp dirs — never the real ~/.codex.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import claudeInject from "../src/claude-inject.cjs";
import {
  OPEN_AUTOMATION_MAX_AGE_MS,
  THREAD_MAX_AGE_MS,
  buildInjectionInstruction,
  buildNearNowHeartbeatRrule,
  buildOpenAutomationToml,
  cleanupStaleOpenAutomations,
  listRecentRollouts,
  openAutomationId,
  parseRolloutActivity,
  parseSessionIndex,
  readRolloutActivity,
  readRolloutMeta,
  resolveCurrentCodexThread,
  rolloutSize,
  waitForCodexIdle,
  waitForRolloutGrowth,
  writeOpenAutomation,
} from "../src/codex-inject.js";

const TZ = "Africa/Johannesburg"; // fixed zone (+02:00, no DST) for deterministic RRULEs

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-inject-"));
}

function rolloutLine(type, payload, timestamp = new Date().toISOString()) {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMetaLine({ cwd = "/w", threadSource = null, source = null } = {}) {
  const payload = { session_id: "s", id: "s", cwd };
  if (threadSource) payload.thread_source = threadSource;
  if (source) payload.source = source;
  return rolloutLine("session_meta", payload);
}

function taskStarted(turnId, timestamp) {
  return rolloutLine("event_msg", { type: "task_started", turn_id: turnId, started_at: 1 }, timestamp);
}

function taskComplete(turnId, timestamp) {
  return rolloutLine("event_msg", { type: "task_complete", turn_id: turnId, completed_at: 2 }, timestamp);
}

// Write a rollout under <home>/sessions/YYYY/MM/DD (UTC date of mtimeMs) and
// stamp its mtime, mirroring the real layout rollout-<ts>-<uuid>.jsonl.
function writeRollout(home, threadId, lines, { mtimeMs = Date.now() } = {}) {
  const at = new Date(mtimeMs);
  const pad = (v) => String(v).padStart(2, "0");
  const dir = path.join(home, "sessions", String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString().slice(0, 19).replace(/:/g, "-");
  const filePath = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  return filePath;
}

function writeIndex(home, rows) {
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

const T1 = "019fa000-0000-7000-8000-000000000001";
const T2 = "019fa000-0000-7000-8000-000000000002";
const T3 = "019fa000-0000-7000-8000-000000000003";

// ---- rollout tail parsing ---------------------------------------------------

test("a task_started with no close means BUSY with that turn id", () => {
  const activity = parseRolloutActivity([sessionMetaLine(), taskStarted("turn-1")].join("\n"));
  assert.equal(activity.busy, true);
  assert.equal(activity.openTurnId, "turn-1");
  assert.equal(activity.lifecycleObserved, true);
});

test("a tail containing only streamed progress reports that lifecycle context was truncated", () => {
  const activity = parseRolloutActivity(
    rolloutLine("event_msg", { type: "agent_reasoning", text: "still working" }),
    { truncatedHead: true },
  );
  assert.equal(activity.busy, false);
  assert.equal(activity.lifecycleObserved, false);
});

test("task_complete closes the open turn -> idle", () => {
  const activity = parseRolloutActivity([sessionMetaLine(), taskStarted("turn-1"), taskComplete("turn-1")].join("\n"));
  assert.equal(activity.busy, false);
  assert.equal(activity.openTurnId, null);
});

test("turn_aborted closes the open turn -> idle", () => {
  const lines = [
    taskStarted("turn-1"),
    rolloutLine("event_msg", { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" }),
  ];
  assert.equal(parseRolloutActivity(lines.join("\n")).busy, false);
});

test("a close for a DIFFERENT turn does not close the open one (conservative busy)", () => {
  const activity = parseRolloutActivity([taskStarted("turn-2"), taskComplete("turn-1")].join("\n"));
  assert.equal(activity.busy, true);
  assert.equal(activity.openTurnId, "turn-2");
});

test("malformed lines are skipped without losing the busy signal", () => {
  const lines = [
    "not json at all",
    '{"broken": ',
    taskStarted("turn-9"),
    '{"type":"event_msg"}', // payload missing
    "",
  ];
  const activity = parseRolloutActivity(lines.join("\n"));
  assert.equal(activity.busy, true);
  assert.equal(activity.openTurnId, "turn-9");
});

test("a fresh task_started after a complete reopens busy state", () => {
  const activity = parseRolloutActivity(
    [taskStarted("turn-1"), taskComplete("turn-1"), taskStarted("turn-2")].join("\n"),
  );
  assert.deepEqual({ busy: activity.busy, openTurnId: activity.openTurnId }, { busy: true, openTurnId: "turn-2" });
});

test("readRolloutActivity drops the partial first line of a truncated tail read", () => {
  const home = fixture();
  // First line is huge; a small tailBytes window starts mid-line. The partial
  // line must be discarded, not parsed as garbage, and later events still count.
  const filler = rolloutLine("event_msg", { type: "agent_message", message: "x".repeat(4096) });
  const filePath = writeRollout(home, T1, [sessionMetaLine(), filler, taskStarted("turn-3")]);
  const activity = readRolloutActivity(filePath, { tailBytes: 512 });
  assert.equal(activity.busy, true);
  assert.equal(activity.openTurnId, "turn-3");
});

test("readRolloutMeta reads cwd and flags subagent rollouts", () => {
  const home = fixture();
  const plain = writeRollout(home, T1, [sessionMetaLine({ cwd: "/repo" }), taskStarted("t")]);
  assert.deepEqual(readRolloutMeta(plain), { cwd: "/repo", subagent: false });
  const forked = writeRollout(home, T2, [
    sessionMetaLine({ cwd: "/repo", threadSource: "subagent", source: { subagent: { depth: 1 } } }),
  ]);
  assert.equal(readRolloutMeta(forked).subagent, true);
  assert.equal(readRolloutMeta(path.join(home, "missing.jsonl")), null);
});

// ---- current-thread resolution ---------------------------------------------

test("parseSessionIndex dedupes by id keeping the newest updated_at", () => {
  const rows = [
    { id: T1, thread_name: "old name", updated_at: "2026-08-05T09:00:00Z" },
    { id: T1, thread_name: "new name", updated_at: "2026-08-05T10:00:00Z" },
    { id: T2, thread_name: "other", updated_at: "2026-08-05T08:00:00Z" },
  ];
  const byId = parseSessionIndex(rows.map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(byId.get(T1).threadName, "new name");
  assert.equal(byId.get(T2).threadName, "other");
});

test("resolveCurrentCodexThread picks the most recently active rollout and reports busy state", () => {
  const home = fixture();
  const now = Date.now();
  writeRollout(home, T1, [sessionMetaLine({ cwd: "/old" }), taskStarted("a"), taskComplete("a")], {
    mtimeMs: now - 2 * 60 * 60 * 1000,
  });
  writeRollout(home, T2, [sessionMetaLine({ cwd: "/current" }), taskStarted("open-turn")], {
    mtimeMs: now - 5 * 60 * 1000,
  });
  writeIndex(home, [
    { id: T1, thread_name: "Older thread", updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
    { id: T2, thread_name: "Current thread", updated_at: new Date(now - 6 * 60 * 1000).toISOString() },
  ]);
  const found = resolveCurrentCodexThread({ homeDir: home, nowMs: now });
  assert.equal(found.threadId, T2);
  assert.equal(found.threadName, "Current thread");
  assert.equal(found.cwd, "/current");
  assert.equal(found.busy, true);
  assert.equal(found.openTurnId, "open-turn");
});

test("session_index recency counts when it is newer than the rollout mtime", () => {
  const home = fixture();
  const now = Date.now();
  // T1's file was touched 20m ago but the index saw activity 1m ago; T2's file
  // is 10m old. max(index, mtime) must rank T1 first.
  writeRollout(home, T1, [sessionMetaLine(), taskStarted("x"), taskComplete("x")], { mtimeMs: now - 20 * 60 * 1000 });
  writeRollout(home, T2, [sessionMetaLine(), taskStarted("y"), taskComplete("y")], { mtimeMs: now - 10 * 60 * 1000 });
  writeIndex(home, [{ id: T1, thread_name: "Index-fresh", updated_at: new Date(now - 60 * 1000).toISOString() }]);
  assert.equal(resolveCurrentCodexThread({ homeDir: home, nowMs: now }).threadId, T1);
});

test("threads idle beyond the 6h window are not current; none -> null", () => {
  const home = fixture();
  const now = Date.now();
  writeRollout(home, T1, [sessionMetaLine(), taskStarted("a"), taskComplete("a")], {
    mtimeMs: now - (THREAD_MAX_AGE_MS + 60 * 1000),
  });
  assert.equal(resolveCurrentCodexThread({ homeDir: home, nowMs: now }), null);
  assert.equal(resolveCurrentCodexThread({ homeDir: path.join(home, "empty"), nowMs: now }), null);
});

test("subagent rollouts are skipped in favor of the next real thread", () => {
  const home = fixture();
  const now = Date.now();
  writeRollout(home, T1, [sessionMetaLine({ cwd: "/real" }), taskStarted("a"), taskComplete("a")], {
    mtimeMs: now - 10 * 60 * 1000,
  });
  writeRollout(home, T2, [sessionMetaLine({ cwd: "/fork", threadSource: "subagent" }), taskStarted("b")], {
    mtimeMs: now - 60 * 1000,
  });
  const found = resolveCurrentCodexThread({ homeDir: home, nowMs: now });
  assert.equal(found.threadId, T1);
});

test("listRecentRollouts keeps the newest file per thread id", () => {
  const home = fixture();
  const now = Date.now();
  writeRollout(home, T3, [sessionMetaLine()], { mtimeMs: now - 26 * 60 * 60 * 1000 }); // yesterday's file
  const fresh = writeRollout(home, T3, [sessionMetaLine(), taskStarted("z")], { mtimeMs: now - 60 * 1000 });
  const byId = listRecentRollouts(path.join(home, "sessions"), { nowMs: now });
  assert.equal(byId.get(T3).sessionPath, fresh);
});

test("a continued Codex task keeps its root id and newest live rollout", () => {
  const home = fixture();
  const now = Date.now();
  const original = writeRollout(home, T1, [sessionMetaLine(), taskStarted("old"), taskComplete("old")], {
    mtimeMs: now - 2 * 60 * 60 * 1000,
  });
  const continuationId = "019fa000-0000-7000-8000-000000000099";
  const continued = original.replace(`${T1}.jsonl`, `${T1}_${continuationId}.jsonl`);
  fs.writeFileSync(continued, `${[sessionMetaLine(), taskStarted("live")].join("\n")}\n`);
  fs.utimesSync(continued, new Date(now - 1_000), new Date(now - 1_000));

  const byId = listRecentRollouts(path.join(home, "sessions"), { nowMs: now });
  assert.equal(byId.size, 1);
  assert.equal(byId.get(T1).threadId, T1);
  assert.equal(byId.get(T1).sessionPath, continued);
  assert.equal(resolveCurrentCodexThread({ homeDir: home, nowMs: now }).threadId, T1);
  assert.equal(resolveCurrentCodexThread({ homeDir: home, nowMs: now }).busy, true);
});

// ---- idle waiting + growth verification ------------------------------------

test("waitForCodexIdle returns once a close event lands, and times out while busy", async () => {
  const home = fixture();
  const busyPath = writeRollout(home, T1, [sessionMetaLine(), taskStarted("t")]);
  const timedOut = await waitForCodexIdle(busyPath, { timeoutMs: 120, pollMs: 30 });
  assert.equal(timedOut.idle, false);

  setTimeout(() => fs.appendFileSync(busyPath, `${taskComplete("t")}\n`), 60);
  const idled = await waitForCodexIdle(busyPath, { timeoutMs: 2000, pollMs: 25 });
  assert.equal(idled.idle, true);
});

test("waitForRolloutGrowth sees an append and times out without one", async () => {
  const home = fixture();
  const filePath = writeRollout(home, T1, [sessionMetaLine()]);
  const baseline = rolloutSize(filePath);
  assert.ok(baseline > 0);
  const none = await waitForRolloutGrowth(filePath, baseline, { timeoutMs: 100, pollMs: 25 });
  assert.equal(none.grew, false);

  setTimeout(() => fs.appendFileSync(filePath, `${taskStarted("new")}\n`), 50);
  const grew = await waitForRolloutGrowth(filePath, baseline, { timeoutMs: 2000, pollMs: 25 });
  assert.equal(grew.grew, true);
});

// ---- shared instruction builder --------------------------------------------

test("the instruction builder IS the claude-inject builder (sender content never inlined)", () => {
  assert.equal(buildInjectionInstruction, claudeInject.buildInjectionInstruction);
  const instruction = buildInjectionInstruction({ relayId: "r_1", senderName: "Ada", title: "Ship it" });
  assert.match(instruction, /relay r_1 from Ada: 'Ship it'/);
  assert.match(instruction, /relay_inbox_list/);
});

// ---- automation writer + cleanup -------------------------------------------

test("buildNearNowHeartbeatRrule fires on the next whole minute past the delay, in the given zone", () => {
  const nowMs = Date.UTC(2026, 7, 5, 10, 0, 30); // 12:00:30 in Johannesburg
  const { rrule, fireAtMs } = buildNearNowHeartbeatRrule({ nowMs, delayMs: 90 * 1000, timeZone: TZ });
  assert.equal(fireAtMs, Date.UTC(2026, 7, 5, 10, 2, 0)); // ceil(10:02:00Z)
  assert.equal(
    rrule,
    `DTSTART;TZID=${TZ}:20260805T120200\nRRULE:FREQ=DAILY;BYHOUR=12;BYMINUTE=2;BYSECOND=0;COUNT=1`,
  );
});

test("writeOpenAutomation writes the exact heartbeat TOML the app's own writer produces", () => {
  const home = fixture();
  const nowMs = Date.UTC(2026, 7, 5, 10, 0, 0);
  const result = writeOpenAutomation({
    homeDir: home,
    relayId: "relay_ABC.123",
    threadId: T1,
    instruction: 'Open relay "now"\nplease',
    nowMs,
    delayMs: 90 * 1000,
    timeZone: TZ,
  });
  assert.equal(result.id, "relay-open-relay-abc-123");
  const text = fs.readFileSync(result.path, "utf8");
  assert.equal(
    text,
    [
      "version = 1",
      'id = "relay-open-relay-abc-123"',
      'kind = "heartbeat"',
      'name = "Relay open relay_ABC.123"',
      'prompt = "Open relay \\"now\\"\\nplease"',
      'status = "ACTIVE"',
      `rrule = "DTSTART;TZID=${TZ}:20260805T120200\\nRRULE:FREQ=DAILY;BYHOUR=12;BYMINUTE=2;BYSECOND=0;COUNT=1"`,
      `target_thread_id = "${T1}"`,
      `created_at = ${nowMs}`,
      `updated_at = ${nowMs}`,
      "",
    ].join("\n"),
  );
});

test("openAutomationId slugs unsafe relay ids and never returns a bare prefix", () => {
  assert.equal(openAutomationId("relay_ABC.123"), "relay-open-relay-abc-123");
  assert.equal(openAutomationId("///"), "relay-open-relay");
  assert.equal(openAutomationId(""), "relay-open-relay");
});

test("writeOpenAutomation supersedes an older relay-open automation for the SAME thread", () => {
  const home = fixture();
  const nowMs = Date.now();
  const first = writeOpenAutomation({ homeDir: home, relayId: "first", threadId: T1, instruction: "one", nowMs, timeZone: TZ });
  const second = writeOpenAutomation({
    homeDir: home,
    relayId: "second",
    threadId: T1,
    instruction: "two",
    nowMs: nowMs + 1000,
    timeZone: TZ,
  });
  assert.equal(fs.existsSync(first.dir), false, "older automation for the same thread is superseded");
  assert.equal(fs.existsSync(second.path), true);
});

test("cleanupStaleOpenAutomations removes only relay-open dirs older than 1h", () => {
  const home = fixture();
  const nowMs = Date.now();
  const stale = writeOpenAutomation({
    homeDir: home,
    relayId: "stale",
    threadId: T1,
    instruction: "old",
    nowMs: nowMs - OPEN_AUTOMATION_MAX_AGE_MS - 60 * 1000,
    timeZone: TZ,
  });
  const young = writeOpenAutomation({
    homeDir: home,
    relayId: "young",
    threadId: T2,
    instruction: "new",
    nowMs: nowMs - 5 * 60 * 1000,
    timeZone: TZ,
  });
  // A user's own automation must never be touched, stale or not.
  const foreignDir = path.join(home, "automations", "passport-collection-reminder");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "automation.toml"), 'version = 1\nid = "passport-collection-reminder"\n');

  const removed = cleanupStaleOpenAutomations({ homeDir: home, nowMs });
  assert.deepEqual(removed, [stale.id]);
  assert.equal(fs.existsSync(stale.dir), false);
  assert.equal(fs.existsSync(young.dir), true);
  assert.equal(fs.existsSync(foreignDir), true);
});

test("cleanup on a missing automations dir is a quiet no-op", () => {
  assert.deepEqual(cleanupStaleOpenAutomations({ homeDir: path.join(fixture(), "nope") }), []);
});

test("writeOpenAutomation requires a thread id", () => {
  assert.throws(() => writeOpenAutomation({ homeDir: fixture(), relayId: "x", instruction: "i" }), /threadId/);
});
