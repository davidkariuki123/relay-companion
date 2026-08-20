import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  coworkNativeEventsToWorkEvents,
  reconcileCoworkNativeEvents,
  subscribeManagedProviderRefresh,
} from "../src/provider-work-feed.js";
import {
  createWorkConversation,
  replayWorkEvents,
  snapshotWorkConversation,
  hydrateWorkConversation,
  workPresentationSnapshot,
} from "../src/work-conversation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/codex-parity/cowork-native-families.json"), "utf8"));
const golden = JSON.parse(fs.readFileSync(path.join(here, "fixtures/codex-parity/cowork-native-work.json"), "utf8"));

function view(rows, options = {}) {
  const sessionId = options.sessionId || fixture.sessionId;
  const state = replayWorkEvents(
    coworkNativeEventsToWorkEvents(rows, { sessionId, session: options.session || fixture.session }),
    createWorkConversation({ provider: "cowork", sessionId }),
  );
  return { state, presentation: workPresentationSnapshot(state, Date.parse("2026-08-15T13:00:00Z")) };
}

function units(presentation) {
  return presentation.turns.flatMap((turn) => turn.units);
}

test("Cowork pages reconcile by numeric sequence and stable event identity", () => {
  const rows = [
    { sequence_num: "10", event_id: "ten", payload: { type: "assistant" } },
    { sequence_num: "2", event_id: "two", payload: { type: "user", message: { content: "two" } } },
    { sequence_num: "2", event_id: "two", payload: { type: "user", message: { content: "richer two" } } },
    { sequence_num: "9", event_id: "nine", payload: { type: "assistant" } },
  ];
  const reconciled = reconcileCoworkNativeEvents(rows);
  assert.deepEqual(reconciled.map((row) => row.event_id), ["two", "nine", "ten"]);
  assert.equal(reconciled[0].payload.message.content, "richer two");
});

test("duplicate and out-of-order Cowork refresh pages replay to one identical presentation", () => {
  const canonical = view(golden.events, { sessionId: golden.sessionId, session: golden.session }).presentation;
  const scrambled = [
    ...golden.events.slice(10).reverse(),
    ...golden.events.slice(0, 14),
    ...golden.events.slice(5, 18),
  ];
  const overlap = view(scrambled, { sessionId: golden.sessionId, session: golden.session }).presentation;
  assert.deepEqual(overlap, canonical);
});

test("tool_result user frames never become human bubbles and runtime seed remains private", () => {
  const { presentation } = view(fixture.events);
  const visible = units(presentation).filter((unit) => unit.placement === "user");
  assert.deepEqual(visible, []);
  const serialized = JSON.stringify(presentation);
  assert.doesNotMatch(serialized, /relay-runtime-contract|private<|result-read/);
});

test("Cowork families preserve native goal, tool, compaction, authentication and retry semantics", () => {
  const { presentation } = view(fixture.events);
  const all = units(presentation);
  assert.ok(all.some((unit) => unit.type === "plan" && unit.text === "Audit the release"));
  const activityRows = all.flatMap((unit) => unit.type === "exploration" ? unit.items : [unit]);
  const read = activityRows.find((unit) => unit.type === "activity" && unit.activity?.kind === "read");
  assert.deepEqual({ active: read.activity.activeVerb, done: read.activity.doneVerb, object: read.activity.object, status: read.activity.status }, {
    active: "Reading", done: "Read", object: "README.md", status: "completed",
  });
  assert.equal(all.filter((unit) => unit.type === "compaction").length, 1);
  assert.ok(all.some((unit) => unit.type === "request" && /Gmail needs authentication/i.test(unit.text)));
  assert.ok(all.some((unit) => unit.type === "retry" && /Try again shortly/i.test(unit.text)));
  assert.ok(all.some((unit) => unit.type === "message" && unit.phase === "commentary" && /verifying/i.test(unit.text)));
  const cancelled = all.find((unit) => unit.type === "request" && /Ship the release/i.test(unit.text));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.blocking, false, "cancelled native request history remains visible but never blocking");
});

test("hidden setup controls allocate no turn while live permission requests block then disappear on native cancel", () => {
  const seed = golden.events.filter((event) => Number(event.sequence_num) <= 16);
  const pendingEvents = coworkNativeEventsToWorkEvents(seed, { sessionId: golden.sessionId, session: golden.session });
  const starts = pendingEvents.filter((event) => event.method === "turn/started");
  assert.equal(starts.length, 2, "pre-prompt protocol controls must not create an orphan turn");
  const requestIndex = pendingEvents.findIndex((event) => event.method === "cowork/permissions/request");
  assert.ok(requestIndex > -1);
  assert.deepEqual(pendingEvents[requestIndex].params.request.questions[0], {
    id: null,
    header: null,
    question: "Deploy to production?",
    multiSelect: false,
    options: [],
  });
  const pending = view(seed, { sessionId: golden.sessionId, session: golden.session }).presentation;
  assert.ok(units(pending).some((unit) => unit.type === "request" && /Deploy to production/i.test(unit.text)));

  const cancel = {
    sequence_num: "17",
    event_id: "cowork-permission-cancel",
    payload: { type: "control_cancel_request", uuid: "cowork-permission-cancel", request_id: "permission-1" },
  };
  const resolvedEvents = coworkNativeEventsToWorkEvents([...seed, cancel], {
    sessionId: golden.sessionId,
    session: { ...golden.session, status_bucket: "working", worker_status: "working", requires_action_details_list: [] },
  });
  assert.ok(resolvedEvents.findIndex((event) => event.method === "serverRequest/resolved") > requestIndex);
  const resolved = replayWorkEvents(resolvedEvents, createWorkConversation({ provider: "cowork", sessionId: golden.sessionId }));
  const historical = units(workPresentationSnapshot(resolved)).find((unit) => unit.type === "request" && /Deploy to production/i.test(unit.text));
  assert.equal(historical.status, "cancelled");
  assert.equal(historical.blocking, false);
});

test("blocked Cowork keeps composer available and exports the native Needs input state", () => {
  const { presentation } = view(golden.events, { sessionId: golden.sessionId, session: golden.session });
  const latest = presentation.turns.at(-1);
  assert.equal(latest.active, true);
  assert.equal(latest.providerState, "blocked");
  assert.equal(latest.providerLabel, "Needs input");
  assert.equal(latest.requiresAction, true);
  assert.equal(latest.composerAvailable, true);
});

test("Ready for review, Working and Completed remain distinct Cowork states", () => {
  const blocked = view(fixture.events, { session: fixture.session }).presentation.turns.at(-1);
  assert.deepEqual([blocked.providerState, blocked.providerLabel, blocked.active], ["blocked", "Needs input", true]);

  const workingRows = fixture.events.filter((row) => !["auth", "rate"].includes(row.event_id));
  const working = view(workingRows, {
    session: { ...fixture.session, status_bucket: "working", worker_status: "working", requires_action_details_list: [] },
  }).presentation.turns.at(-1);
  assert.deepEqual([working.providerState, working.providerLabel, working.active], ["working", "Working", true]);

  const reviewSession = { ...fixture.session, status_bucket: "review_ready", worker_status: "idle" };
  const review = view(workingRows, { session: reviewSession }).presentation.turns.at(-1);
  assert.deepEqual([review.providerState, review.providerLabel, review.status], ["review_ready", "Ready for review", "completed"]);

  const completedSession = { ...fixture.session, status_bucket: "completed", worker_status: "idle" };
  const completed = view(workingRows, { session: completedSession }).presentation.turns.at(-1);
  assert.deepEqual([completed.providerState, completed.providerLabel, completed.status], ["completed", "Completed", "completed"]);
});

test("successful result cannot erase a later blocked summary; error result defeats review metadata", () => {
  const blockedRows = golden.events.filter((row) => Number(row.sequence_num) <= 13).map((row) => row.event_id === "cowork-post-summary"
    ? { ...row, payload: { ...row.payload, status_category: "blocked", status_detail: "waiting", needs_action: "Choose a target" } }
    : row);
  const blocked = view(blockedRows, {
    sessionId: "blocked",
    session: { status: "active", status_bucket: "review_ready", worker_status: "idle", requires_action_details_list: [] },
  }).presentation.turns.at(-1);
  assert.equal(blocked.active, true);
  assert.equal(blocked.providerState, "blocked");

  const failedRows = blockedRows.map((row) => row.event_id === "cowork-result"
    ? { ...row, payload: { ...row.payload, subtype: "error", is_error: true, result: "Native provider rejected the operation." } }
    : row);
  const failed = view(failedRows, {
    sessionId: "failed",
    session: { status: "active", status_bucket: "review_ready", worker_status: "idle", requires_action_details_list: [] },
  }).presentation.turns.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.providerState, "failed");
  assert.ok(failed.units.some((unit) => unit.type === "error" && /rejected/i.test(unit.text)));
});

test("provider state survives bounded persistence and hydration", () => {
  const { state } = view(golden.events, { sessionId: golden.sessionId, session: golden.session });
  const restored = hydrateWorkConversation(snapshotWorkConversation(state));
  const latest = workPresentationSnapshot(restored).turns.at(-1);
  assert.equal(latest.providerState, "blocked");
  assert.equal(latest.providerLabel, "Needs input");
  assert.equal(latest.composerAvailable, true);
});

test("paged Cowork refresh is non-overlapping, bounded and never invents text deltas", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let callback;
  let calls = 0;
  const seen = [];
  const stop = subscribeManagedProviderRefresh(async () => {
    calls += 1;
    await gate;
    return { events: Array.from({ length: 20 }, (_, index) => ({ method: "provider/page", eventId: `page-${index}` })) };
  }, (event) => seen.push(event), {
    maxEventsPerRefresh: 5,
    setTimer: (fn) => { callback = fn; return 4; },
    clearTimer: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  void callback?.();
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.map((event) => event.eventId), ["page-15", "page-16", "page-17", "page-18", "page-19"]);
  assert.equal(seen.some((event) => /delta/i.test(event.method)), false);
  stop();
});
