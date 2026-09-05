import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  DEFAULT_CADENCE_MS,
  IDLE_CADENCE_MS,
  LIVELY_WINDOW_MS,
  MIN_GAP_MS,
  SETTLE_MS,
  STEWARD_ROUTES,
  boardSignature,
  buildStewardPrompt,
  chooseStewardProvider,
  claudeStewardArgs,
  readStewardState,
  requestStewardRun,
  runClaudeSteward,
  runTodoStewardOnce,
  saveStewardPreferences,
  stewardBoardSnapshot,
  stewardResultFromText,
  stewardShouldRun,
} from "../src/todo-steward.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-steward-"));
}

test("provider choice: both installed → Codex 5.6 Sol medium; Claude only → Opus 5 high", () => {
  assert.deepEqual(chooseStewardProvider({ codexAvailable: true, claudeAvailable: true }), STEWARD_ROUTES.codex);
  assert.equal(STEWARD_ROUTES.codex.model, "gpt-5.6-sol");
  assert.equal(STEWARD_ROUTES.codex.effort, "medium");
  assert.deepEqual(chooseStewardProvider({ codexAvailable: false, claudeAvailable: true }), STEWARD_ROUTES.claude);
  assert.equal(STEWARD_ROUTES.claude.model, "opus");
  assert.equal(STEWARD_ROUTES.claude.effort, "high");
  assert.deepEqual(chooseStewardProvider({ codexAvailable: true, claudeAvailable: false }), STEWARD_ROUTES.codex);
  assert.equal(chooseStewardProvider({}), null);
  // An explicit preference wins only when that agent is actually present.
  assert.deepEqual(chooseStewardProvider({ codexAvailable: true, claudeAvailable: true, preference: "claude" }), STEWARD_ROUTES.claude);
  assert.deepEqual(chooseStewardProvider({ codexAvailable: true, claudeAvailable: false, preference: "claude" }), STEWARD_ROUTES.codex);
});

test("when to run: manual beats everything, changes settle first, cadence fills the quiet", () => {
  const now = 10_000_000;
  const fresh = { lastRun: { startedAt: now - 60_000 } };
  assert.deepEqual(stewardShouldRun({ state: fresh, nowMs: now, attention: 3 }), { run: false, reason: "fresh" });
  assert.deepEqual(stewardShouldRun({ state: {}, nowMs: now, attention: 0 }), { run: false, reason: "nothing_to_check" });
  assert.deepEqual(stewardShouldRun({ state: {}, nowMs: now, attention: 2 }), { run: true, reason: "cadence" });
  assert.deepEqual(stewardShouldRun({ state: fresh, nowMs: now, attention: 3, todoEnabled: false }), { run: false, reason: "todo_off" });
  assert.deepEqual(stewardShouldRun({ state: { ...fresh, prefs: { enabled: false } }, nowMs: now, attention: 3 }), { run: false, reason: "disabled" });
  assert.deepEqual(stewardShouldRun({ state: { ...fresh, run: { startedAt: now - 1000, heartbeatAt: now - 1000 } }, nowMs: now, attention: 3 }), { run: false, reason: "running" });
  // A dead run (no heartbeat for a long time) does not block forever.
  assert.equal(stewardShouldRun({ state: { run: { startedAt: now - 60 * 60_000, heartbeatAt: now - 60 * 60_000 } }, nowMs: now, attention: 3 }).run, true);
  // The list moved: wait for it to settle, then respect the minimum gap.
  const moved = { lastRun: { startedAt: now - 60_000 }, signatureChangedAt: now - 10_000 };
  assert.deepEqual(stewardShouldRun({ state: moved, nowMs: now, attention: 3 }), { run: false, reason: "settling" });
  assert.deepEqual(stewardShouldRun({ state: moved, nowMs: now + SETTLE_MS, attention: 3 }), { run: false, reason: "too_soon" });
  assert.deepEqual(stewardShouldRun({ state: moved, nowMs: now + MIN_GAP_MS, attention: 3 }), { run: true, reason: "changed" });
  // Check now, even with nothing in the attention lists (it still writes a fresh stamp).
  assert.deepEqual(stewardShouldRun({ state: { ...fresh, requestedAt: now }, nowMs: now, attention: 0 }), { run: true, reason: "manual" });
  assert.deepEqual(stewardShouldRun({ state: { lastRun: { startedAt: now - 5_000 }, requestedAt: now }, nowMs: now, attention: 1 }), { run: false, reason: "manual_too_soon" });
  assert.deepEqual(stewardShouldRun({ state: { lastRun: { startedAt: now - DEFAULT_CADENCE_MS } }, nowMs: now, attention: 1 }), { run: true, reason: "cadence" });
  // A still board (no movement for hours) is read every two hours, not every thirty minutes.
  const still = { lastRun: { startedAt: now - DEFAULT_CADENCE_MS - 1000 }, signatureChangedAt: now - LIVELY_WINDOW_MS - 1000 };
  assert.deepEqual(stewardShouldRun({ state: still, nowMs: now, attention: 2 }), { run: false, reason: "fresh" });
  assert.deepEqual(stewardShouldRun({ state: { ...still, lastRun: { startedAt: now - IDLE_CADENCE_MS } }, nowMs: now, attention: 2 }), { run: true, reason: "idle_cadence" });
  // The moment it moves again the half-hour cadence is back (after settle + gap).
  assert.deepEqual(stewardShouldRun({ state: { ...still, signatureChangedAt: now - SETTLE_MS - 1000 }, nowMs: now, attention: 2 }), { run: true, reason: "changed" });
});

test("the board signature reacts to arrivals, reads and status changes only", () => {
  const base = { counts: { triage: 2, backlog: 0, todo: 0, in_progress: 0, done: 40 }, groups: [
    { status: "triage", items: [{ relayId: "a", state: "delivered", todoStatus: "triage", todoVersion: 1 }] },
  ] };
  const same = boardSignature(base);
  assert.equal(boardSignature({ ...base, counts: { ...base.counts, done: 41 } }), same, "Done moving alone is not a reason to run");
  assert.notEqual(boardSignature({ ...base, groups: [{ status: "triage", items: [{ relayId: "a", state: "read", todoStatus: "triage", todoVersion: 1 }] }] }), same);
  assert.notEqual(boardSignature({ ...base, counts: { ...base.counts, triage: 3 } }), same);
});

test("the brief carries the person, the rules, the local transcript paths and the board in order", () => {
  const snapshot = stewardBoardSnapshot({
    triage: [
      { relayId: "r1", todoStatus: "triage", todoVersion: 2, attentionRank: 1, kind: "message", title: "What's your GitHub username?", sender: { name: "Schalk Dormehl", email: "s@x.com" }, createdAt: "2026-09-02T11:30:00Z", state: "read", threadId: "r1", preview: "Hey David…",
        sessions: [{ provider: "codex", nativeSessionId: "01a0-thread", touches: 2, lastSeenAt: "2026-09-02T12:00:00Z" }, { provider: "claude", nativeSessionId: "8d86682-claude", touches: 1, lastSeenAt: "2026-09-02T11:40:00Z", cwd: "/Users/david/src/relay" }] },
      { relayId: "r2", todoStatus: "triage", todoVersion: 1, kind: "task", title: "Ship it", sender: { name: "Sven" }, createdAt: "2026-09-01T11:30:00Z", state: "delivered", recipientGroupName: "Granular", assessment: "You started this", assessedAt: "2026-09-02T10:00:00Z" },
    ],
    done: [{ relayId: "d1", todoStatus: "done", todoVersion: 3, kind: "message", title: "Old", sender: { name: "X" }, createdAt: "2026-08-01T00:00:00Z", state: "read" }],
  }, { resolveSession: (touch) => touch.provider === "codex" ? { title: "Design Todo ontology", cwd: "/Users/david/src/relay", transcriptPath: "/Users/david/.codex/sessions/rollout-01a0.jsonl", state: "idle" } : null });
  assert.equal(snapshot.triage[0].rank, undefined, "the board is a plain newest-first list; there is no rank to reason about");
  assert.deepEqual(snapshot.triage[0].openedIn, [
    { provider: "codex", id: "01a0-thread", title: "Design Todo ontology", cwd: "/Users/david/src/relay", transcriptPath: "/Users/david/.codex/sessions/rollout-01a0.jsonl", state: "idle", lastOpenedAt: "2026-09-02T12:00:00Z" },
    { provider: "claude", id: "8d86682-claude", cwd: "/Users/david/src/relay", lastOpenedAt: "2026-09-02T11:40:00Z" },
  ], "the sessions a Relay was opened in ride along with their transcripts resolved on this machine");
  assert.equal(snapshot.triage[1].openedIn, undefined);
  const textSnap = stewardBoardSnapshot({ triage: [{ relayId: "t1", todoStatus: "triage", todoVersion: 1, kind: "message", sender: { name: "Sven" }, createdAt: "2026-09-04T16:48:00Z", state: "read", preview: "On 3. is there a way to send a message that the link would open?" }] });
  assert.equal(textSnap.triage[0].kind, "text");
  assert.equal(textSnap.triage[0].title, undefined);
  assert.match(textSnap.triage[0].preview, /is there a way/);
  assert.equal(snapshot.triage[0].read, true);
  assert.equal(snapshot.triage[1].channel, "Granular");
  assert.equal(snapshot.triage[1].previousNote, "You started this");
  assert.equal(snapshot.recentDone.length, 1);
  const prompt = buildStewardPrompt({
    user: { name: "David Kariuki", email: "david@granular.work" },
    snapshot,
    route: STEWARD_ROUTES.codex,
    nowMs: Date.parse("2026-09-02T12:40:00Z"),
    timeZone: "Africa/Johannesburg",
    homeDir: "/Users/david",
    aiSessionTools: true,
    reason: "manual",
  });
  assert.match(prompt, /David Kariuki's own computer as Codex/);
  assert.match(prompt, /David just pressed Check now/);
  assert.match(prompt, /Africa\/Johannesburg/);
  assert.match(prompt, /relay_todo_update/);
  assert.match(prompt, /relay_todo_reorder/);
  assert.match(prompt, /relay_ai_sessions/);
  assert.match(prompt, /\/Users\/david\/\.claude\/projects/);
  assert.match(prompt, /\/Users\/david\/\.codex\/sessions/);
  assert.match(prompt, /never call relay_mark_read, never send or reply/);
  assert.match(prompt, /Only three statuses exist for you: triage \(Needs attention\), in_progress, done/);
  assert.match(prompt, /Never use backlog, todo, canceled or duplicate/);
  assert.match(prompt, /Start with openedIn: those are the exact Claude Code \/ Codex sessions this Relay was opened in/);
  assert.match(prompt, /Never reorder\. Needs attention is a plain list, newest arrival first/);
  assert.match(prompt, /previousNote is a claim to re-test, never a fact to repeat/);
  assert.match(prompt, /Tasks are yours to move too/);
  assert.match(prompt, /A text that asks a question is exactly as owed as a titled Relay/);
  assert.match(prompt, /Judge 'merged' against origin\/main, never against a local HEAD/);
  assert.doesNotMatch(prompt, /HOW TO ORDER/);
  assert.doesNotMatch(prompt, /SHIPPING FACTS \(measured/, "no facts block when none were measured");
  const withFacts = buildStewardPrompt({ snapshot, homeDir: "/Users/david", facts: ["- Production (stable) Companion right now: 0.1.454."] });
  assert.match(withFacts, /SHIPPING FACTS \(measured just now by Relay/);
  assert.match(withFacts, /Production \(stable\) Companion right now: 0\.1\.454/);
  assert.match(prompt, /"transcriptPath": "\/Users\/david\/\.codex\/sessions\/rollout-01a0\.jsonl"/);
  assert.doesNotMatch(prompt, /backlog: only when they/);
  assert.match(prompt, /"What's your GitHub username\?"/);
  assert.match(prompt, /Answer with JSON only/);
  assert.match(prompt, /Write nothing else: the person reads your notes on the items, never a report\./);
  assert.doesNotMatch(prompt, /"summary"/);
  const withoutSessions = buildStewardPrompt({ snapshot, aiSessionTools: false, homeDir: "/Users/david" });
  assert.doesNotMatch(withoutSessions, /relay_ai_sessions/);
  assert.match(withoutSessions, /\.codex\/sessions/);
});

test("the final answer is read from JSON, fenced JSON, or falls back to the prose", () => {
  assert.deepEqual(stewardResultFromText('{"checked":4,"changed":2}'), { checked: 4, changed: 2 });
  assert.deepEqual(stewardResultFromText('Done.\n```json\n{"checked":"3","changed":0}\n```'), { checked: 3, changed: 0 });
  assert.deepEqual(stewardResultFromText("I looked at everything and nothing changed."), { checked: 0, changed: 0 }, "prose is never surfaced; only counts survive");
  assert.equal(stewardResultFromText(""), null);
});

test("claude -p arguments grant only Relay tools and read-only shell, and carry model/effort/permission", () => {
  const args = claudeStewardArgs({ model: "opus", effort: "high", permissionMode: "auto", mcpConfigPath: "/tmp/relay-mcp.json", mcpServerNames: ["granular-brain", "relay"] });
  assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "json", "--model", "opus"]);
  assert.ok(args.includes("--effort") && args[args.indexOf("--effort") + 1] === "high");
  assert.ok(args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "auto");
  assert.ok(args.includes("--mcp-config"));
  assert.ok(args.includes("mcp__relay"));
  assert.ok(args.includes("mcp__granular-brain"), "the person's own MCP servers ride along, exactly as in their sessions");
  assert.equal(args.filter((arg) => arg === "mcp__relay").length, 1);
  assert.ok(!args.includes("--strict-mcp-config"), "the person's own MCP config stays loaded");
  assert.ok(args.includes("Bash(git log:*)"));
  assert.ok(!args.some((arg) => /Bash\(git push|Bash\(rm|Write|Edit/.test(arg)));
  assert.ok(!args.includes("--allow-dangerously-skip-permissions"));
  assert.ok(claudeStewardArgs({ permissionMode: "bypassPermissions" }).includes("--allow-dangerously-skip-permissions"));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 143; return true; };
  return child;
}

test("the Claude lane feeds the brief over stdin and reads the JSON result envelope", async () => {
  const child = fakeChild();
  let stdin = "";
  child.stdin.on("data", (chunk) => { stdin += chunk; });
  const pending = runClaudeSteward({ command: "claude", cwd: os.tmpdir(), prompt: "BRIEF", args: ["-p"], spawnProcess: () => child });
  await new Promise((resolve) => setTimeout(resolve, 10));
  child.stdout.write(JSON.stringify({ type: "result", is_error: false, result: '{"checked":2,"changed":0}' }));
  child.exitCode = 0;
  child.emit("exit", 0);
  const result = await pending;
  assert.equal(stdin, "BRIEF");
  assert.deepEqual(stewardResultFromText(result.finalMessage), { checked: 2, changed: 0 });
});

test("one daemon tick fingerprints the board, runs when due, and records what happened", async () => {
  const baseDir = tempDir();
  const calls = [];
  const overview = { counts: { triage: 1, backlog: 0, todo: 0, in_progress: 0, done: 3 }, groups: [
    { status: "triage", count: 1, items: [{ relayId: "r1", state: "delivered", todoStatus: "triage", todoVersion: 1, title: "Hi", sender: { name: "Sven" }, createdAt: "2026-09-02T10:00:00Z" }] },
  ] };
  const client = {
    async todo(input) {
      calls.push(input);
      if (input.statuses.length > 1) return overview;
      return { mode: "continuous", counts: overview.counts, items: input.statuses[0] === "triage" ? overview.groups[0].items : [] };
    },
  };
  let received = null;
  const runProvider = async ({ route, prompt, heartbeat }) => {
    received = { route, prompt };
    heartbeat("Codex is checking");
    return { finalMessage: '{"checked":1,"changed":1}' };
  };
  // Nothing installed: the tick reports it instead of crashing.
  requestStewardRun(baseDir, 5_000_000);
  const none = await runTodoStewardOnce({ client, features: { todo: true }, baseDir, nowMs: 5_000_000, providers: {}, runProvider });
  assert.equal(none.reason, "no_provider");
  assert.match(readStewardState(baseDir).lastRun.error, /Neither Codex nor Claude Code/);
  // Both installed: a manual request runs on Codex and leaves a summary for the pill.
  requestStewardRun(baseDir, 5_100_000);
  const ran = await runTodoStewardOnce({
    client, features: { todo: true, aiSessions: true }, user: { name: "David" }, baseDir, nowMs: 5_100_000,
    providers: { codex: true, claude: true }, runProvider,
  });
  assert.equal(ran.ran, true);
  assert.equal(ran.reason, "manual");
  assert.equal(received.route.provider, "codex");
  assert.match(received.prompt, /David just pressed Check now/);
  assert.match(received.prompt, /"relayId": "r1"/);
  const state = readStewardState(baseDir);
  assert.equal(state.run, null);
  assert.equal(state.lastRun.ok, true);
  assert.equal(state.lastRun.summary, undefined, "no report is kept; the notes on the items are the output");
  assert.equal(state.lastRun.changed, 1);
  assert.equal(state.requestedAt, 0);
  // A second tick seconds later does nothing: fresh, and the signature check is rate limited.
  const before = calls.length;
  const idle = await runTodoStewardOnce({ client, features: { todo: true }, baseDir, nowMs: 5_101_000, providers: { codex: true }, runProvider });
  assert.equal(idle.ran, false);
  assert.equal(calls.length, before);
  // Todo off on this account: never runs, never fetches.
  const off = await runTodoStewardOnce({ client, features: { todo: false }, baseDir, nowMs: 9_000_000, providers: { codex: true }, runProvider });
  assert.deepEqual(off, { ran: false, reason: "todo_off" });
  // Preferences persist beside the run state.
  saveStewardPreferences(baseDir, { enabled: false, provider: "claude" });
  assert.deepEqual(readStewardState(baseDir).prefs, { enabled: false, provider: "claude" });
  assert.equal((await runTodoStewardOnce({ client, features: { todo: true }, baseDir, nowMs: 9_000_000, providers: { codex: true }, runProvider })).reason, "disabled");
});

test("a provider failure is recorded and never leaves a live run behind", async () => {
  const baseDir = tempDir();
  const client = { async todo() { return { counts: { triage: 1 }, groups: [], items: [] }; } };
  requestStewardRun(baseDir, 1_000_000);
  const result = await runTodoStewardOnce({
    client, features: { todo: true }, baseDir, nowMs: 1_000_000, providers: { claude: true },
    runProvider: async () => { throw new Error("claude: not signed in"); },
  });
  assert.equal(result.ran, true);
  assert.equal(result.error, "claude: not signed in");
  const state = readStewardState(baseDir);
  assert.equal(state.run, null);
  assert.equal(state.lastRun.ok, false);
  assert.equal(state.lastRun.provider, "claude");
});
