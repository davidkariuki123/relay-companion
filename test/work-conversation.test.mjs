import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptOptimisticUser,
  addOptimisticUser,
  conversationView,
  createWorkConversation,
  formatDuration,
  hydrateWorkConversation,
  isFinalEligible,
  normalizeActivity,
  reduceWorkEvent,
  replayWorkEvents,
  summarizeActivities,
  snapshotWorkConversation,
  turnSummary,
  turnTiming,
  turnPresentation,
  visibleWorkUserText,
  workPresentationSnapshot,
  turnUnits,
} from "../src/work-conversation.js";

test("underscored MCP namespaces preserve Codex JS execution semantics", () => {
  const js = normalizeActivity({ type:"mcpToolCall", tool:"mcp__node_repl__js", arguments:{ title:"Count UI lines" }, status:"completed" });
  assert.equal(js.kind, "command");
  assert.equal(js.doneVerb, "Ran");
  assert.equal(js.object, "Count UI lines");
  assert.equal(js.groupKey, "codex:javascript");
});

function turn(method, id, status, at, extra = {}) {
  return { method, eventId: `${method}:${id}:${at}`, emittedAtMs: at, params: { turn: { id, status, ...extra } } };
}

function item(method, turnId, value, at) {
  return { method, eventId: `${method}:${value.id}:${at}`, emittedAtMs: at, params: { turnId, item: value } };
}

function delta(method, turnId, itemId, value, at) {
  return { method, eventId: `${method}:${itemId}:${at}`, emittedAtMs: at, params: { turnId, itemId, delta: value } };
}

test("internal Relay transport text never becomes the human's visible message", () => {
  const historical = [
    "Begin now and return only the requested marker.",
    "<relay-runtime-contract>Relay Task return contract with internal settlement machinery.</relay-runtime-contract>",
  ].join("\n\n");
  assert.equal(visibleWorkUserText(historical), "Begin now and return only the requested marker.");
  assert.equal(visibleWorkUserText("Begin the task as briefed."), "");

  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u1", type: "userMessage", text: historical, status: "completed" }, 1_100),
  ]);
  const visible = conversationView(state, 1_200)[0].units.find((unit) => unit.placement === "user");
  assert.equal(visible.text, "Begin now and return only the requested marker.");
  assert.doesNotMatch(JSON.stringify(workPresentationSnapshot(state)), /relay-runtime-contract|internal settlement/);
});

test("provider protocol notifications never manufacture a ghost active turn", () => {
  const events = [
    { method: "remoteControl/status/changed", eventId: "remote:1", emittedAtMs: 900, params: { status: "disabled" } },
    { method: "mcpServer/startupStatus/updated", eventId: "mcp:1", emittedAtMs: 950, params: { threadId: "thread-1", name: "relay", status: "ready" } },
    { method: "thread/status/changed", eventId: "thread:idle", emittedAtMs: 975, params: { threadId: "thread-1", status: { type: "idle" } } },
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u1", type: "userMessage", text: "Run it", status: "completed" }, 1_100),
    item("item/completed", "t1", { id: "a1", type: "agentMessage", phase: "final_answer", text: "Done", status: "completed" }, 1_200),
    turn("turn/completed", "t1", "completed", 1_300),
    { method: "account/rateLimits/updated", eventId: "limits:1", emittedAtMs: 1_350, params: { rateLimits: { primary: { usedPercent: 1 } } } },
    { method: "skills/changed", eventId: "skills:1", emittedAtMs: 1_400, params: {} },
  ];
  const state = replayWorkEvents(events, createWorkConversation({ provider: "codex" }));
  assert.deepEqual(state.turnOrder, ["t1"]);
  const presentation = workPresentationSnapshot(state);
  assert.equal(presentation.turns.length, 1);
  assert.equal(presentation.turns[0].status, "completed");
  assert.equal(presentation.turns[0].final.text, "Done");
});

test("staged or historical rows without native turn started never create Work", () => {
  const state = replayWorkEvents([
    { method: "provider/state", eventId: "staged", emittedAtMs: 900, params: { nativeState: "completed" } },
    item("item/completed", "historical", { id: "old-final", type: "agentMessage", phase: "final_answer", text: "Old answer", status: "completed" }, 1_000),
    turn("turn/completed", "historical", "completed", 1_100),
  ], createWorkConversation({ provider: "codex", sessionId: "materialized-only" }));
  assert.deepEqual(state.turnOrder, []);
  assert.deepEqual(workPresentationSnapshot(state).turns, []);
});

test("golden replay preserves commentary and final answer as distinct left-side messages", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/started", "t1", { id: "u1", type: "userMessage", text: "Please investigate", status: "inProgress" }, 1_100),
    item("item/completed", "t1", { id: "u1", type: "userMessage", text: "Please investigate", status: "completed" }, 1_101),
    item("item/started", "t1", { id: "a1", type: "agentMessage", phase: "commentary", status: "inProgress" }, 1_200),
    delta("item/agentMessage/delta", "t1", "a1", "I’m checking", 1_210),
    item("item/completed", "t1", { id: "a1", type: "agentMessage", phase: "commentary", text: "I’m checking now.", status: "completed" }, 1_300),
    item("item/started", "t1", { id: "a2", type: "agentMessage", phase: "final_answer", status: "inProgress" }, 1_500),
    delta("item/agentMessage/delta", "t1", "a2", "Fixed", 1_510),
    item("item/completed", "t1", { id: "a2", type: "agentMessage", phase: "final_answer", text: "Fixed and verified.", status: "completed" }, 1_600),
    turn("turn/completed", "t1", "completed", 1_700),
  ];
  const state = replayWorkEvents(events);
  const model = conversationView(state, 2_000)[0];
  assert.deepEqual(model.units.filter((unit) => unit.type === "message").map(({ side, phase, text }) => ({ side, phase, text })), [
    { side: "right", phase: undefined, text: "Please investigate" },
    { side: "left", phase: "commentary", text: "I’m checking now." },
    { side: "left", phase: "final_answer", text: "Fixed and verified." },
  ]);
  assert.equal(model.finalEligible, true);
  assert.equal(model.summary, "", "messages alone do not manufacture an orphan activity header");
});

test("item completion drains pending deltas before becoming authoritative", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    delta("item/agentMessage/delta", "t1", "a1", "First ", 1_100),
    delta("item/agentMessage/delta", "t1", "a1", "answer", 1_101),
    item("item/completed", "t1", { id: "a1", type: "agentMessage", phase: "final_answer", status: "completed" }, 1_200),
  ];
  const state = replayWorkEvents(events);
  assert.equal(state.turns.t1.items.a1.text, "First answer");
  assert.deepEqual(state.turns.t1.pendingDeltas, {});
  assert.equal(isFinalEligible(state.turns.t1), true);

  const authoritative = replayWorkEvents([
    ...events.slice(0, -1),
    item("item/completed", "t1", { id: "a1", type: "agentMessage", phase: "final_answer", text: "Authoritative answer", status: "completed" }, 1_200),
  ]);
  assert.equal(authoritative.turns.t1.items.a1.text, "Authoritative answer");
});

test("a terminal notification drains known items but preserves an out-of-order delta until its item arrives", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    delta("item/agentMessage/delta", "t1", "late", "Late final", 1_100),
    turn("turn/completed", "t1", "completed", 1_200),
    item("item/completed", "t1", { id: "late", type: "agentMessage", phase: "final_answer", status: "completed" }, 1_150),
  ];
  const state = replayWorkEvents(events);
  assert.equal(state.turns.t1.status, "completed");
  assert.equal(state.turns.t1.items.late.text, "Late final");
  assert.deepEqual(state.turns.t1.pendingDeltas, {});
  assert.equal(isFinalEligible(state.turns.t1), true);
});

test("structured message parts normalize and private reasoning never enters shared state", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u", type: "userMessage", content: [{ type: "input_text", text: "Hello " }, { type: "input_text", text: "world" }], status: "completed" }, 1_100),
    delta("item/reasoning/textDelta", "t1", "r", "private delta", 1_200),
    delta("item/reasoning/summaryTextDelta", "t1", "r", "Public summary", 1_210),
    item("item/completed", "t1", { id: "r", type: "reasoning", summary: ["Public summary"], rawContent: "private final", encryptedContent: "cipher", status: "completed" }, 1_300),
  ]);
  assert.equal(state.turns.t1.items.u.text, "Hello world");
  assert.equal(state.turns.t1.items.r.summary, "Public summary");
  assert.doesNotMatch(JSON.stringify(state), /private delta|private final|cipher/);
});

test("replaying overlapping log tails is idempotent", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/started", "t1", { id: "c1", type: "commandExecution", command: "pwd", status: "inProgress" }, 1_100),
    delta("item/commandExecution/outputDelta", "t1", "c1", "/tmp\n", 1_200),
    item("item/completed", "t1", { id: "c1", type: "commandExecution", command: "pwd", aggregatedOutput: "/tmp\n", status: "completed" }, 1_300),
    turn("turn/completed", "t1", "completed", 1_400),
  ];
  const once = replayWorkEvents(events);
  const snapshot = structuredClone(once);
  const twice = replayWorkEvents(events, once);
  assert.deepEqual(twice, snapshot);
  assert.equal(twice.turns.t1.itemOrder.length, 1);
});

test("optimistic initial user and steer bubbles reconcile without duplicates", () => {
  let state = addOptimisticUser(createWorkConversation(), { text: "Start this", clientId: "local-1", atMs: 900 });
  state = reduceWorkEvent(state, turn("turn/started", "t1", "inProgress", 1_000));
  state = reduceWorkEvent(state, item("item/completed", "t1", { id: "u1", type: "userMessage", text: "Start this", status: "completed" }, 1_050));
  state = addOptimisticUser(state, { text: "Also check tests", clientId: "local-2", turnId: "t1", mode: "steer", atMs: 1_100 });
  assert.deepEqual(turnUnits(state.turns.t1).filter((unit) => unit.type === "message").map((unit) => unit.text), ["Start this", "Also check tests"]);
  state = reduceWorkEvent(state, item("item/completed", "t1", { id: "u2", type: "userMessage", text: "Also check tests", status: "completed" }, 1_200));
  assert.deepEqual(state.turns.t1.itemOrder, ["u1", "u2"]);
  assert.equal(state.turns.t1.items.u2.optimistic, false);
});

test("explicit display text and client identity beat provider prompt rewriting", () => {
  let state = addOptimisticUser(createWorkConversation(), {
    text:"what's this about?", clientId:"client-visible-1", atMs:900,
  });
  state = reduceWorkEvent(state, turn("turn/started", "t1", "inProgress", 1_000));
  state = reduceWorkEvent(state, item("item/completed", "t1", {
    id:"provider-user-1",
    type:"userMessage",
    text:"Harden Relay send guidance\n\n<relay-documents>private provider context</relay-documents>\n\nwhat's this about?",
    displayText:"what's this about?",
    clientMessageId:"client-visible-1",
    status:"completed",
  }, 1_050));
  const messages = turnUnits(state.turns.t1).filter((unit) => unit.role === "user");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "what's this about?");
  assert.equal(messages[0].clientMessageId, "client-visible-1");
  assert.equal(state.turns.t1.itemOrder.includes("optimistic-user:client-visible-1"), false);
  assert.doesNotMatch(JSON.stringify(workPresentationSnapshot(state)), /Harden Relay send guidance|relay-documents|private provider context/);
});

test("an unaccepted steer is restored after failure while an echoed steer is not", () => {
  let state = replayWorkEvents([turn("turn/started", "t1", "inProgress", 1_000)]);
  state = addOptimisticUser(state, { text: "Retry this note", clientId: "pending", turnId: "t1", mode: "steer", atMs: 1_100 });
  state = reduceWorkEvent(state, turn("turn/completed", "t1", "failed", 1_200));
  assert.deepEqual(state.turns.t1.retryText, ["Retry this note"]);
  assert.equal(state.turns.t1.items["optimistic-user:pending"].status, "rejected");

  let accepted = replayWorkEvents([turn("turn/started", "t2", "inProgress", 2_000)]);
  accepted = addOptimisticUser(accepted, { text: "Accepted note", clientId: "accepted", turnId: "t2", mode: "steer", atMs: 2_100 });
  accepted = reduceWorkEvent(accepted, item("item/completed", "t2", { id: "u2", type: "userMessage", text: "Accepted note", status: "completed" }, 2_200));
  accepted = reduceWorkEvent(accepted, turn("turn/completed", "t2", "interrupted", 2_300));
  assert.deepEqual(accepted.turns.t2.retryText, []);
});

test("retry errors coalesce and terminal failures remain explicit", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    { method: "error", eventId: "retry-1", emittedAtMs: 1_100, params: { turnId: "t1", willRetry: true, error: { message: "Reconnecting... 1/3" } } },
    { method: "error", eventId: "retry-2", emittedAtMs: 1_200, params: { turnId: "t1", willRetry: true, error: { message: "Reconnecting 2/3" } } },
    { method: "error", eventId: "fatal", emittedAtMs: 1_300, params: { turnId: "t1", willRetry: false, error: { message: "Provider stopped" } } },
    turn("turn/completed", "t1", "failed", 1_400, { error: { message: "Provider stopped" } }),
  ];
  const state = replayWorkEvents(events);
  const units = turnUnits(state.turns.t1);
  assert.deepEqual(units.slice(0, 2).map((unit) => [unit.type, unit.text, unit.count]), [
    ["retry", "Reconnecting 2/3", 2],
    ["error", "Provider stopped", undefined],
  ]);
  assert.equal(state.turns.t1.status, "failed");
  assert.equal(state.turns.t1.error.message, "Provider stopped");
});

test("semantic normalizer preserves exploration, command, patch, web, MCP, and dynamic meaning", () => {
  const rows = [
    normalizeActivity({ id: "r", type: "commandExecution", commandActions: [{ type: "read", path: "/tmp/brief.md" }] }),
    normalizeActivity({ id: "l", type: "commandExecution", commandActions: [{ type: "listFiles", path: "/tmp/src" }] }),
    normalizeActivity({ id: "s", type: "commandExecution", commandActions: [{ type: "search", query: "needle" }] }),
    normalizeActivity({ id: "c", type: "commandExecution", command: "npm test" }),
    normalizeActivity({ id: "p", type: "fileChange", changes: [{ path: "/tmp/a.js", kind: "update" }, { path: "/tmp/b.js", kind: "update" }] }),
    normalizeActivity({ id: "w", type: "webSearch", query: "official docs" }),
    normalizeActivity({ id: "m", type: "mcpToolCall", server: "messages", tool: "deliver_result", arguments: {}, presentation: { kind: "call", activeVerb: "Delivering", doneVerb: "Delivered", object: "the result" } }),
    normalizeActivity({ id: "d", type: "dynamicToolCall", tool: "create_report", arguments: { private: "never render" } }),
  ];
  assert.deepEqual(rows.map((row) => [row.kind, row.doneVerb, row.object]), [
    ["read", "Read", "brief.md"],
    ["list", "Listed", "src"],
    ["search", "Searched for", "needle"],
    ["command", "Ran", "npm test"],
    ["edit", "Edited", "a.js"],
    ["web", "Searched the web for", "official docs"],
    ["call", "Delivered", "the result"],
    ["call", "Called", "create report"],
  ]);
  assert.equal(rows.some((row) => JSON.stringify(row).includes("never render")), false);
  assert.equal(normalizeActivity({ type: "dynamicToolCall", tool: "load_workspace_dependencies" }), null);
  assert.equal(normalizeActivity({ type: "collabAgentToolCall", tool: "wait" }), null);
  assert.equal(normalizeActivity({ type: "sleep" }), null);
});

test("exploration coalesces with reasoning and aggregate grammar is stable", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "why", type: "reasoning", summary: ["Finding the source"], status: "completed" }, 1_100),
    item("item/completed", "t1", { id: "read", type: "commandExecution", commandActions: [{ type: "read", path: "/tmp/a.js" }], status: "completed" }, 1_200),
    item("item/completed", "t1", { id: "search", type: "commandExecution", commandActions: [{ type: "search", query: "needle" }], status: "completed" }, 1_300),
    item("item/completed", "t1", { id: "cmd", type: "commandExecution", command: "npm test", status: "completed" }, 1_400),
  ]);
  const units = turnUnits(state.turns.t1);
  assert.equal(units[0].type, "exploration");
  assert.equal(units[0].items.length, 3);
  assert.equal(units[0].summary, "Read files");
  assert.equal(units[1].type, "activity");
  const read = normalizeActivity({ type: "commandExecution", commandActions: [{ type: "read", path: "a" }] });
  const command = normalizeActivity({ type: "commandExecution", command: "pwd" });
  const edit = normalizeActivity({ type: "fileChange", changes: [{ path: "a", kind: "update" }] });
  assert.equal(summarizeActivities([command, command]), "Ran commands");
  assert.equal(summarizeActivities([read, command]), "Read files and ran a command");
  assert.equal(summarizeActivities([read, command, edit]), "Read files, ran a command, and edited a file");
});

test("timing uses first work and first final boundaries, with safe historical fallback", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/started", "t1", { id: "u", type: "userMessage", text: "go" }, 1_100),
    item("item/started", "t1", { id: "reason", type: "reasoning" }, 2_000),
    item("item/started", "t1", { id: "comment", type: "agentMessage", phase: "commentary" }, 2_500),
    item("item/started", "t1", { id: "final", type: "agentMessage", phase: "final_answer" }, 5_500),
    item("item/completed", "t1", { id: "final", type: "agentMessage", phase: "final_answer", text: "done", status: "completed" }, 5_600),
    turn("turn/completed", "t1", "completed", 6_000, { durationMs: 99_000 }),
  ]);
  assert.deepEqual(turnTiming(state.turns.t1, 7_000), { state: "settled", durationMs: 3_500, precise: true, suppressed: null });
  assert.equal(turnSummary(state.turns.t1, 7_000), "Worked for 4 sec");
  const historical = {
    status: "completed", durationMs: 12_400, hasActivityHeader: true,
    itemOrder: ["final"],
    items: { final: { id: "final", type: "agentMessage", phase: "final_answer", text: "done", status: "completed" } },
  };
  assert.deepEqual(turnTiming(historical), { state: "settled", durationMs: 12_400, precise: false, suppressed: null });
  assert.equal(turnSummary(historical), "Worked for 12 sec");
  assert.equal(formatDuration(3_661_000), "1 h 1 min");
  assert.equal(turnSummary({ ...historical, status: "interrupted" }), "");
  assert.equal(turnSummary({ status: "completed", durationMs: 12_400, itemOrder: [], items: {} }), "");
  assert.equal(turnSummary({ ...historical, sleepObserved: true }), "");
});

test("presentation exposes stable typed units, strict final, and disclosure flags", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u", type: "userMessage", text: "go", status: "completed" }, 1_010),
    item("item/completed", "t1", { id: "p", type: "plan", text: "Check it", status: "completed" }, 1_020),
    item("item/completed", "t1", { id: "c", type: "agentMessage", phase: "commentary", text: "Checking", status: "completed" }, 1_030),
    item("item/completed", "t1", { id: "a", type: "imageGeneration", result: { image_url: "data:image/png;base64,x" }, status: "completed" }, 1_040),
    item("item/completed", "t1", { id: "f", type: "agentMessage", phase: "final_answer", text: "Done", status: "completed" }, 1_050),
    turn("turn/completed", "t1", "completed", 1_060),
  ]);
  const model = turnPresentation(state.turns.t1, 2_000);
  assert.equal(model.key, "t1");
  assert.equal(model.settled, true);
  assert.equal(model.user.id, "u");
  assert.equal(model.final.id, "f");
  assert.equal(model.final.phase, "final_answer");
  assert.deepEqual(model.units.map((unit) => unit.type), ["message", "plan", "message", "artifact", "message"]);
  assert.equal(model.units.find((unit) => unit.type === "artifact").standalone, true);
  assert.equal(model.units.every((unit) => typeof unit.persistent === "boolean"), true);
  assert.deepEqual(model.units.map((unit) => unit.placement), ["user", "collapsible", "collapsible", "standalone", "final"]);
  assert.equal(model.canCollapse, true);
});

test("failed/no-final and cancelled turns cannot become a completed disclosure", () => {
  const failed = replayWorkEvents([
    turn("turn/started", "failed", "inProgress", 1_000),
    item("item/completed", "failed", { id: "read", type: "commandExecution", commandActions: [{ type: "read", path: "a" }], status: "failed" }, 1_100),
    turn("turn/completed", "failed", "failed", 1_200),
  ]).turns.failed;
  assert.equal(turnPresentation(failed).canCollapse, false);
  assert.equal(turnPresentation(failed).summary, "");
  const cancelled = { ...failed, id: "cancelled", status: "interrupted" };
  assert.equal(turnPresentation(cancelled).cancelled, true);
  assert.equal(turnPresentation(cancelled).canCollapse, false);
  assert.equal(turnPresentation(cancelled).summary, "");
});

test("presentation metadata coalesces visualization command and patch while redundant reads collapse", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "r1", type: "commandExecution", commandActions: [{ type: "read", path: "/tmp/a.js" }], status: "completed" }, 1_100),
    item("item/completed", "t1", { id: "r2", type: "commandExecution", commandActions: [{ type: "read", path: "/tmp/a.js" }], status: "completed" }, 1_200),
    item("item/completed", "t1", { id: "v1", type: "commandExecution", command: "render chart", presentation: { groupKey: "visual-1" }, status: "completed" }, 1_300),
    item("item/completed", "t1", { id: "v2", type: "fileChange", changes: [{ path: "/tmp/chart.svg", kind: "add" }], presentation: { groupKey: "visual-1" }, status: "completed" }, 1_400),
  ]);
  const units = turnUnits(state.turns.t1);
  assert.equal(units[0].type, "exploration");
  assert.equal(units[0].items.length, 1);
  assert.equal(units[1].type, "activityGroup");
  assert.equal(units[1].items.length, 2);
  assert.equal(units[1].summary, "Ran a command and edited a file");
});

test("event reduction mutates one bounded accumulator instead of cloning per delta", () => {
  const state = createWorkConversation();
  const same = reduceWorkEvent(state, turn("turn/started", "t1", "inProgress", 1_000));
  assert.strictEqual(same, state);
  for (let index = 0; index < 5_000; index += 1) {
    reduceWorkEvent(state, delta("item/agentMessage/delta", "t1", "a", "x", 2_000 + index));
  }
  assert.ok(state.seenEventKeys.length <= 4_096);
  assert.equal(state.turns.t1.pendingDeltas.a.text.length, 5_000);
  const snapshot = structuredClone(state);
  for (let index = 0; index < 5_000; index += 1) {
    reduceWorkEvent(state, delta("item/agentMessage/delta", "t1", "a", "x", 2_000 + index));
  }
  assert.deepEqual(state, snapshot, "an overlap larger than the bounded event cache is still rejected by delta watermarks");
});

test("bounded snapshots hydrate and resume without duplicates", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u", type: "userMessage", text: "go", status: "completed" }, 1_100),
    item("item/completed", "t1", { id: "read", type: "commandExecution", commandActions: [{ type: "read", path: "a" }], status: "completed" }, 1_200),
  ];
  const state = replayWorkEvents(events);
  const snapshot = snapshotWorkConversation(state);
  const hydrated = hydrateWorkConversation(JSON.parse(JSON.stringify(snapshot)));
  const before = structuredClone(hydrated);
  replayWorkEvents(events, hydrated);
  assert.deepEqual(hydrated, before);
  const completed = replayWorkEvents([
    item("item/completed", "t1", { id: "final", type: "agentMessage", phase: "final_answer", text: "done", status: "completed" }, 1_300),
    turn("turn/completed", "t1", "completed", 1_400),
  ], hydrated);
  assert.deepEqual(completed.turns.t1.itemOrder, ["u", "read", "final"]);
  const ipc = workPresentationSnapshot(completed, 2_000, { maxTurns: 1, maxUnitsPerTurn: 2, maxStringChars: 1_024 });
  assert.equal(ipc.turns.length, 1);
  assert.equal(ipc.turns[0].units.length, 2);
  assert.equal(ipc.turns[0].units[0].id, "u", "the initial user survives bounded tail truncation");
  assert.equal(ipc.turns[0].units[1].id, "final");
  assert.ok(JSON.stringify(ipc).length < 20_000);
});

test("multi-turn user and Steer chronology remains exact", () => {
  let state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id: "u1", type: "userMessage", text: "Initial", status: "completed" }, 1_010),
    item("item/completed", "t1", { id: "c1", type: "agentMessage", phase: "commentary", text: "Working", status: "completed" }, 1_020),
  ]);
  state = addOptimisticUser(state, { text: "Steer", clientId: "s1", turnId: "t1", mode: "steer", atMs: 1_030 });
  state = replayWorkEvents([
    item("item/completed", "t1", { id: "u2", type: "userMessage", text: "Steer", status: "completed" }, 1_040),
    item("item/completed", "t1", { id: "f1", type: "agentMessage", phase: "final_answer", text: "First done", status: "completed" }, 1_050),
    turn("turn/completed", "t1", "completed", 1_060),
    turn("turn/started", "t2", "inProgress", 2_000),
    item("item/completed", "t2", { id: "u3", type: "userMessage", text: "Next turn", status: "completed" }, 2_010),
  ], state);
  assert.deepEqual(turnUnits(state.turns.t1).map((unit) => unit.id), ["u1", "c1", "u2", "f1"]);
  assert.deepEqual(turnPresentation(state.turns.t1).users.map((unit) => unit.text), ["Initial", "Steer"]);
  assert.deepEqual(state.turnOrder, ["t1", "t2"]);
  assert.equal(turnPresentation(state.turns.t2).user.text, "Next turn");
});

test("user presentation preserves bounded attachment metadata without embedding bytes", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", {
      id: "u1",
      type: "userMessage",
      text: "Inspect these",
      status: "completed",
      attachments: [{ id: "a1", name: "report.pdf", contentType: "application/pdf", bytes: 1234, localPath: "/tmp/report.pdf", data: "TOKEN=do-not-leak" }],
      content: [{ type: "input_image", image_url: "data:image/png;base64,TOKEN=do-not-leak" }],
    }, 1_010),
  ]);
  const user = turnPresentation(state.turns.t1).users[0];
  assert.deepEqual(user.attachments, [
    { id: "a1", kind: "file", name: "report.pdf", mimeType: "application/pdf", size: 1234, path: "/tmp/report.pdf", url: null },
    { id: "u1:1", kind: "input_image", name: "Image", mimeType: null, size: null, path: null, url: null },
  ]);
  assert.doesNotMatch(JSON.stringify(workPresentationSnapshot(state)), /do-not-leak|base64/);
});

test("transport acceptance settles an optimistic user without a provider echo", () => {
  let state = addOptimisticUser(createWorkConversation(), {
    text: "Continue",
    clientId: "client-accepted",
    turnId: "t1",
    mode: "steer",
    atMs: 1_000,
  });
  state = acceptOptimisticUser(state, { clientId: "client-accepted", turnId: "t1" });
  const user = turnPresentation(state.turns.t1).users[0];
  assert.equal(user.text, "Continue");
  assert.equal(user.status, "accepted");
  assert.equal(user.optimistic, true);
});

test("presentation and persistence boundaries redact secrets, bound deltas, and prune terminal orphans", () => {
  const secret = "TOKEN=do-not-leak";
  const arbitraryOutput = "private arbitrary command output";
  let state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    delta("item/commandExecution/outputDelta", "t1", "cmd", `${"x".repeat(70_000)}\n${secret}`, 1_100),
    {
      method: "item/commandExecution/requestApproval",
      id: "approval",
      eventId: "approval-event",
      emittedAtMs: 1_200,
      params: { turnId: "t1", question: "Proceed?", apiKey: "do-not-leak" },
    },
    item("item/completed", "t1", {
      id: "cmd", type: "commandExecution", command: "run", status: "completed",
      aggregatedOutput: `${arbitraryOutput}\n${secret}`, metadata: { password: "do-not-leak" },
    }, 1_300),
    { method: "turn/error", eventId: "error-secret", emittedAtMs: 1_400, params: { turnId: "t1", error: { message: secret, authorization: "do-not-leak" } } },
    {
      method: "serverRequest/resolved",
      eventId: "resolved-secret",
      emittedAtMs: 1_450,
      params: { requestId: "approval", result: { authorization: "Bearer super-secret", note: secret } },
    },
    turn("turn/completed", "t1", "failed", 1_500),
  ]);
  const serialized = JSON.stringify({
    units: turnUnits(state.turns.t1),
    view: conversationView(state),
    snapshot: snapshotWorkConversation(state),
    ipc: workPresentationSnapshot(state),
  });
  assert.doesNotMatch(serialized, /do-not-leak/);
  assert.match(serialized, /\[redacted\]/);
  assert.ok(JSON.stringify(snapshotWorkConversation(state)).length < 200_000);
  assert.doesNotMatch(JSON.stringify(workPresentationSnapshot(state)), /private arbitrary command output/);
  assert.equal("output" in turnUnits(state.turns.t1).find((unit) => unit.type === "activity").activity, false);

  state = reduceWorkEvent(state, turn("turn/started", "t2", "inProgress", 62_000));
  assert.deepEqual(state.turns.t1.pendingDeltas, {});
  assert.deepEqual(state.turns.t1.deltaWatermarks, {});
});

test("persistence snapshot enforces one aggregate byte ceiling before cloning raw payloads", () => {
  const state = createWorkConversation();
  for (let turnIndex = 0; turnIndex < 20; turnIndex += 1) {
    const turnId = `huge-${turnIndex}`;
    reduceWorkEvent(state, turn("turn/started", turnId, "inProgress", turnIndex * 1_000));
    for (let itemIndex = 0; itemIndex < 40; itemIndex += 1) {
      reduceWorkEvent(state, item("item/completed", turnId, {
        id: `${turnId}-${itemIndex}`,
        type: "commandExecution",
        command: `echo ${itemIndex}`,
        status: "completed",
        aggregatedOutput: `${"payload".repeat(12_000)} Authorization: Bearer super-secret`,
      }, turnIndex * 1_000 + itemIndex + 1));
    }
  }
  const snapshot = snapshotWorkConversation(state, { maxBytes: 100_000 });
  const serialized = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 100_000, Buffer.byteLength(serialized, "utf8"));
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotThrow(() => hydrateWorkConversation(snapshot));
});

test("persistence strips inline attachment bytes while retaining safe attachment metadata", () => {
  const state = replayWorkEvents([
    turn("turn/started", "attachment-turn", "inProgress", 1_000),
    item("item/completed", "attachment-turn", {
      id: "attachment-user",
      type: "userMessage",
      text: "Inspect these files",
      status: "completed",
      attachments: [{
        id: "attachment-1",
        name: "proof.png",
        mimeType: "image/png",
        size: 123,
        contentBase64: "payload-secret",
        dataUrl: "data:image/png;base64,payload-secret-url",
        file_data: "payload-secret-file",
      }],
      content: [{ type: "input_image", image_url: "data:image/png;base64,payload-secret-block", data: "payload-secret-data" }],
    }, 1_100),
    turn("turn/completed", "attachment-turn", "completed", 1_200),
  ]);

  const persisted = snapshotWorkConversation(state);
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, /payload-secret/);
  assert.match(serialized, /omitted binary payload/);

  const user = conversationView(hydrateWorkConversation(persisted))[0].users[0];
  assert.equal(user.attachments[0].name, "proof.png");
  assert.equal(user.attachments[0].mimeType, "image\/png");
  assert.equal(user.attachments[0].size, 123);
});

test("persistence keeps numeric attachment size and safe remote image metadata", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", {
      id: "u1",
      type: "userMessage",
      content: "Inspect these",
      attachments: [{ id: "a1", name: "proof.png", contentType: "image/png", bytes: 123 }],
      image_url: "https://cdn.example.test/proof.png",
      status: "completed",
    }, 1_010),
  ]);
  const restored = hydrateWorkConversation(snapshotWorkConversation(state));
  const user = conversationView(restored)[0].users[0];
  assert.equal(user.attachments[0].size, 123);
  assert.match(JSON.stringify(restored), /https:\/\/cdn\.example\.test\/proof\.png/);
});

test("connection closure fails the active turn with a persistent honest error", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    { method: "relay/connectionClosed", params: { message: "Worker exited unexpectedly" }, timestamp: 1_100 },
  ]);
  const presentation = conversationView(state)[0];
  assert.equal(presentation.status, "failed");
  assert.equal(presentation.active, false);
  assert.equal(presentation.settled, true);
  assert.ok(presentation.units.some((unit) => unit.type === "error" && /Worker exited unexpectedly/.test(unit.text)));
});

test("separate worker crashes terminate their exact turns without deduping", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    { method: "relay/connectionClosed", eventId: "closed:1", emittedAtMs: 1_100, params: { turnId: "t1", message: "Worker exited" } },
    turn("turn/started", "t2", "inProgress", 2_000),
    { method: "relay/connectionClosed", eventId: "closed:2", emittedAtMs: 2_100, params: { turnId: "t2", message: "Worker exited" } },
  ]);
  const [first, second] = conversationView(state);
  assert.equal(first.status, "failed");
  assert.equal(second.status, "failed");
  assert.equal(state.turns.t1.completedAtMs, 1_100);
  assert.equal(state.turns.t2.completedAtMs, 2_100);
  assert.equal(first.units.filter((unit) => unit.type === "error").length, 1);
  assert.equal(second.units.filter((unit) => unit.type === "error").length, 1);
});

test("tight persistence and IPC budgets retain newest turns and redact auth schemes", () => {
  const state = createWorkConversation();
  for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
    const turnId = `t${turnIndex}`;
    reduceWorkEvent(state, turn("turn/started", turnId, "inProgress", turnIndex * 1_000));
    for (let itemIndex = 0; itemIndex < 300; itemIndex += 1) {
      reduceWorkEvent(state, item("item/completed", turnId, {
        id: `${turnId}-${itemIndex}`,
        type: "agentMessage",
        phase: itemIndex === 299 ? "final_answer" : "commentary",
        text: `${"large commentary ".repeat(4_000)} authorization=Basic dXNlcjpwYXNz`,
        status: "completed",
      }, turnIndex * 1_000 + itemIndex + 1));
    }
    reduceWorkEvent(state, turn("turn/completed", turnId, "completed", turnIndex * 1_000 + 900));
  }
  const persisted = snapshotWorkConversation(state, { maxBytes: 30_000 });
  assert.deepEqual(persisted.turnOrder, ["t2"]);
  const persistenceJson = JSON.stringify(persisted);
  assert.ok(Buffer.byteLength(persistenceJson, "utf8") <= 30_000);
  assert.doesNotMatch(persistenceJson, /dXNlcjpwYXNz/);

  const projection = workPresentationSnapshot(state, Date.now(), { maxBytes: 100_000 });
  const projectionJson = JSON.stringify(projection);
  assert.equal(projection.turns.at(-1)?.key, "t2");
  assert.ok(Buffer.byteLength(projectionJson, "utf8") <= 100_000);
  assert.doesNotMatch(projectionJson, /dXNlcjpwYXNz/);

  const squeezed = workPresentationSnapshot(state, Date.now(), { maxBytes: 16_000, maxStringChars: 4_096 });
  assert.equal(squeezed.turns.at(-1)?.key, "t2");
  assert.equal(squeezed.turns.at(-1)?.final?.id, "t2-299", "the final answer survives before optional commentary");
  assert.ok(squeezed.turns.at(-1)?.units.some((unit) => unit.id === "t2-299"));
});

test("blocking server requests resolve without leaving stale UI units", () => {
  const request = {
    method: "item/commandExecution/requestApproval",
    id: 44,
    eventId: "request-44",
    emittedAtMs: 1_100,
    params: { turnId: "t1", command: "git push" },
  };
  let state = replayWorkEvents([turn("turn/started", "t1", "inProgress", 1_000), request]);
  assert.equal(turnUnits(state.turns.t1).at(-1).type, "request");
  reduceWorkEvent(state, item("item/completed", "t1", { id: "after", type: "agentMessage", phase: "commentary", text: "Waiting", status: "completed" }, 1_150));
  assert.deepEqual(turnUnits(state.turns.t1).map((unit) => unit.id), ["request:44", "after"]);
  state = reduceWorkEvent(state, { method: "serverRequest/resolved", eventId: "resolved-44", emittedAtMs: 1_200, params: { requestId: "44", result: { approved: true } } });
  const resolved = turnUnits(state.turns.t1).find((unit) => unit.type === "request");
  assert.equal(resolved.blocking, false);
  assert.equal(resolved.persistent, true);
  assert.equal(state.turns.t1.requests[44].status, "resolved");
});

test("adjacent Codex js calls become one semantic command group with generated titles", () => {
  const state = replayWorkEvents([
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id:"js-1", type:"dynamicToolCall", name:"js", arguments:{ title:"Count UI lines", code:"text(1)" }, status:"completed" }, 1_100),
    item("item/completed", "t1", { id:"js-2", type:"dynamicToolCall", name:"js", arguments:{ title:"Count disclosure selectors", code:"text(2)" }, status:"completed" }, 1_200),
  ]);
  const units = turnUnits(state.turns.t1);
  assert.equal(units.length, 1);
  assert.equal(units[0].type, "activityGroup");
  assert.equal(units[0].summary, "Ran commands");
  assert.deepEqual(units[0].items.map((entry) => `${entry.activity.doneVerb} ${entry.activity.object}`), [
    "Ran Count UI lines",
    "Ran Count disclosure selectors",
  ]);
  assert.doesNotMatch(JSON.stringify(units), /Called js/);
});

test("separate Codex js groups have stable unique reconciliation identities", () => {
  const events = [
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/completed", "t1", { id:"js-1", type:"mcpToolCall", server:"node_repl", tool:"js", arguments:{ title:"Count UI lines" }, status:"completed" }, 1_100),
    item("item/completed", "t1", { id:"js-2", type:"mcpToolCall", server:"node_repl", tool:"js", arguments:{ title:"Count activity labels" }, status:"completed" }, 1_200),
    item("item/completed", "t1", { id:"note", type:"agentMessage", phase:"commentary", text:"Now inspecting disclosure behavior.", status:"completed" }, 1_300),
    item("item/completed", "t1", { id:"js-3", type:"mcpToolCall", server:"node_repl", tool:"js", arguments:{ title:"Inspect disclosure selectors" }, status:"completed" }, 1_400),
    item("item/completed", "t1", { id:"js-4", type:"mcpToolCall", server:"node_repl", tool:"js", arguments:{ title:"Rank activity identifiers" }, status:"completed" }, 1_500),
  ];
  const state = replayWorkEvents(events);
  const groups = turnUnits(state.turns.t1).filter((unit) => unit.type === "activityGroup");
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map((group) => group.id)).size, 2, "disjoint groups must never share a DOM reconciliation key");
  assert.deepEqual(groups.map((group) => group.items.map((entry) => entry.activity.object)), [
    ["Count UI lines", "Count activity labels"],
    ["Inspect disclosure selectors", "Rank activity identifiers"],
  ]);

  for (const event of events) reduceWorkEvent(state, cloneEvent(event));
  assert.deepEqual(
    turnUnits(state.turns.t1).filter((unit) => unit.type === "activityGroup"),
    groups,
    "hydration/live overlap and Steer repaint cannot multiply semantic groups",
  );
});

test("property-style duplicate insertion never changes a completed replay", () => {
  const base = [
    turn("turn/started", "t1", "inProgress", 1_000),
    item("item/started", "t1", { id: "a", type: "agentMessage", phase: "commentary" }, 1_100),
    delta("item/agentMessage/delta", "t1", "a", "hello", 1_200),
    item("item/completed", "t1", { id: "a", type: "agentMessage", phase: "commentary", text: "hello", status: "completed" }, 1_300),
    item("item/completed", "t1", { id: "f", type: "agentMessage", phase: "final_answer", text: "done", status: "completed" }, 1_400),
    turn("turn/completed", "t1", "completed", 1_500),
  ];
  const expected = replayWorkEvents(base);
  let seed = 0x12345678;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let trial = 0; trial < 100; trial += 1) {
    const expanded = base.flatMap((event) => random() < 0.65 ? [event, cloneEvent(event)] : [event]);
    assert.deepEqual(replayWorkEvents(expanded), expected);
  }
});

function cloneEvent(value) {
  return JSON.parse(JSON.stringify(value));
}
