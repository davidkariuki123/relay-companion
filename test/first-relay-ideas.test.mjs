import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { firstRelayOnboardingCall } from "../src/mcp.js";
import { startDesktopOnboardingBridge, callDesktopOnboarding } from "../src/desktop-onboarding-bridge.js";

// YOUR FIRST RELAY, PICKED IN THE PILL (2026-10-10). The AI writes four ideas
// into a file the pill draws; the person taps one; a waiting AI takes it, and
// with none waiting the pill opens the AI again with the idea typed in.

const require = createRequire(import.meta.url);
const { createFirstRelayIdeas, validateIdeas, WAITER_LIVE_MS, HEARTBEAT_MS, WAIT_MAX_MS, HELPER_WAIT_MAX_MS } = require("../src/first-relay-ideas.cjs");
const { recentWork } = require("../src/recent-work.cjs");

const idea = (n, extra = {}) => ({ title: `Review pricing copy ${n}`, line: "Ask for a second pair of eyes", kind: "review", prompt: `Make me a Relay asking for review ${n}.`, ...extra });
const four = () => [1, 2, 3, 4].map((n) => idea(n));
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-first-ideas-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function clock(start = Date.parse("2026-10-10T09:00:00Z")) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("ideas are exactly four, each a short title, a short line, a known kind and a full prompt", () => {
  assert.deepEqual(validateIdeas(four()).map((item) => item.id), ["idea-1", "idea-2", "idea-3", "idea-4"]);
  assert.throws(() => validateIdeas(four().slice(0, 3)), /exactly 4 ideas; got 3/);
  assert.throws(() => validateIdeas(null), /exactly 4 ideas; got none/);
  // Every problem is named at once, so the AI shortens them all in one retry.
  const bad = four();
  bad[0] = idea(1, { title: "One two three four five six seven" });
  bad[2] = idea(3, { line: "one two three four five six seven eight nine ten" });
  bad[3] = idea(4, { kind: "chat", prompt: "" });
  assert.throws(() => validateIdeas(bad), (error) => {
    assert.equal(error.code, "ideas_invalid");
    assert.match(error.message, /^Nothing was shown yet\./);
    assert.match(error.message, /idea 1: title "One two three four five six seven" is 7 words; use at most 6/);
    assert.match(error.message, /idea 3: line .* is 10 words; use at most 9/);
    assert.match(error.message, /idea 4: kind must be one of review, answer, handoff, update/);
    assert.match(error.message, /idea 4: prompt is empty/);
    return true;
  });
  // One very long word is too long for a row even under the word limit.
  assert.throws(() => validateIdeas([idea(1, { title: "x".repeat(60) }), ...four().slice(1)]), /idea 1: title/);
  const cleaned = validateIdeas([idea(1, { title: "  Ask   Sam  ", kind: "Answer", recipientName: " Sam " }), ...four().slice(1)]);
  assert.deepEqual(cleaned[0], { id: "idea-1", title: "Ask Sam", line: "Ask for a second pair of eyes", kind: "answer", prompt: "Make me a Relay asking for review 1.", recipientName: "Sam" });
});

test("a setup belongs to one account and one AI, survives a restart, and ends", (t) => {
  const directory = sandbox(t);
  const store = createFirstRelayIdeas({ directory });
  assert.throws(() => store.begin({ accountId: "usr_a", host: "chatgpt" }), /Claude Code, Codex or Conductor/);
  const first = store.begin({ accountId: "usr_a", host: "codex", kind: "invite", inviter: { name: "Sam Rivera", relayUserId: "usr_sam" } });
  assert.equal(store.begin({ accountId: "usr_a", host: "codex", kind: "invite", inviter: { name: "Sam Rivera", relayUserId: "usr_sam" } }).id, first.id, "same account and AI keep the setup");
  assert.notEqual(store.begin({ accountId: "usr_a", host: "claude-code" }).id, first.id, "another AI starts afresh");
  const again = store.begin({ accountId: "usr_a", host: "codex", kind: "invite", inviter: { name: "Sam Rivera", relayUserId: "usr_sam" } });
  // A second process (the MCP broker) reads the same file.
  const other = createFirstRelayIdeas({ directory });
  assert.equal(other.current({ accountId: "usr_b" }).active, false, "another account's setup is not this session's");
  const seen = other.current({ accountId: "usr_a" });
  assert.equal(seen.active, true);
  assert.equal(seen.kind, "invite");
  assert.deepEqual(seen.inviter, { name: "Sam Rivera", relayUserId: "usr_sam" });
  assert.match(seen.agentInstruction, /all about what to send Sam Rivera/);
  assert.match(seen.agentInstruction, /run no setup commands and do not mention signing in/);
  const snapshot = store.snapshot("usr_a");
  assert.equal(snapshot.id, again.id);
  assert.ok(snapshot.agentSeenAt, "the pill learns the AI has started");
  assert.equal(snapshot.inviterFirstName, "Sam");
  assert.equal(store.snapshot("usr_b"), null);
  store.markOpened();
  assert.ok(store.snapshot("usr_a").openedAt);
  store.end();
  assert.equal(store.snapshot("usr_a"), null);
  assert.equal(other.current({ accountId: "usr_a" }).active, false);
});

test("a tap with an AI waiting is left for it; the wait returns the pick and claims it once", async (t) => {
  const directory = sandbox(t);
  const time = clock();
  const pill = createFirstRelayIdeas({ directory, now: time.now });
  const agent = createFirstRelayIdeas({ directory, now: time.now });
  pill.begin({ accountId: "usr_a", host: "codex" });
  agent.setIdeas(four(), { accountId: "usr_a" });
  assert.equal(pill.snapshot("usr_a").ideas.length, 4);
  assert.equal(pill.snapshot("usr_a").ideas[0].prompt, undefined, "the pill draws titles and lines, not prompts");
  // The ideas tool's own heartbeat covers the gap before the wait starts.
  assert.equal(pill.waiterLive(), true);
  let polls = 0;
  const waiting = agent.waitForPick({ accountId: "usr_a", pollMs: 1000, sleep: async (ms) => {
    polls += 1;
    if (polls === 3) assert.equal(pill.pick("idea-3", { accountId: "usr_a" }).mode, "waiter");
    time.advance(ms);
  } });
  const result = await waiting;
  assert.equal(result.picked.id, "idea-3");
  assert.equal(result.picked.prompt, "Make me a Relay asking for review 3.");
  // No inviter: write from what is known and mint at once, without approval.
  assert.match(result.agentInstruction, /do not open other conversations or files to research it/);
  assert.match(result.agentInstruction, /mint it at once with relay_share_link: minting sends nothing, so it needs no approval/);
  assert.equal(pill.snapshot("usr_a").pick.claimed, true);
  // A repeated tap or wait is the same pick, never a second one.
  assert.equal(pill.pick("idea-1", { accountId: "usr_a" }).idea.id, "idea-3");
  assert.equal((await agent.waitForPick({ accountId: "usr_a", sleep: async () => {} })).picked.id, "idea-3");
  assert.throws(() => agent.setIdeas(four(), { accountId: "usr_a" }), /already picked/);
});

test("the wait beats its heart, returns waiting at its deadline, and a stale heart means no waiter", async (t) => {
  const directory = sandbox(t);
  const time = clock();
  const store = createFirstRelayIdeas({ directory, now: time.now });
  store.begin({ accountId: "usr_a", host: "claude-code" });
  store.setIdeas(four(), { accountId: "usr_a" });
  time.advance(WAITER_LIVE_MS + 1);
  assert.equal(store.waiterLive(), false, "ideas written and left: nobody is listening");
  const beats = [];
  const result = await store.waitForPick({ accountId: "usr_a", timeoutMs: 20_000, pollMs: 1000, sleep: async (ms) => {
    beats.push(JSON.parse(fs.readFileSync(path.join(directory, "first-relay-waiter.json"), "utf8")).at);
    time.advance(ms);
  } });
  assert.equal(result.waiting, true);
  assert.match(result.agentInstruction, /Call relay_onboarding_wait_pick again/);
  assert.match(result.agentInstruction, /No rush\. When you pick an idea in Relay, I’ll write it\./);
  assert.ok(new Set(beats).size >= Math.floor(20_000 / HEARTBEAT_MS) - 1, "the heartbeat moves every few seconds");
  assert.equal(store.waiterLive(), true, "right after a wait the pill still sees a listener");
  time.advance(WAITER_LIVE_MS + 1);
  assert.equal(store.waiterLive(), false);
  // A deadline is capped at the four-minute ceiling, and an abort ends it early.
  const controller = new AbortController();
  controller.abort();
  assert.equal((await store.waitForPick({ accountId: "usr_a", timeoutMs: 10 * WAIT_MAX_MS, signal: controller.signal, sleep: async () => {} })).waiting, true);
  assert.equal((await store.waitForPick({ accountId: "usr_a", shouldYield: () => true, sleep: async () => {} })).waiting, true, "an update starting ends the wait");
  assert.ok(HELPER_WAIT_MAX_MS < 120_000, "the helper's wait fits the daemon's call budget");
});

test("with an inviter, the picked idea is shown and approved before it is sent to them", async (t) => {
  const directory = sandbox(t);
  const store = createFirstRelayIdeas({ directory });
  store.begin({ accountId: "usr_a", host: "codex", kind: "invite", inviter: { name: "Sam Rivera", relayUserId: "usr_sam" } });
  store.setIdeas(four(), { accountId: "usr_a" });
  store.pick("idea-1", { accountId: "usr_a" });
  const result = await store.waitForPick({ accountId: "usr_a", sleep: async () => {} });
  assert.deepEqual(result.inviter, { name: "Sam Rivera", relayUserId: "usr_sam" });
  assert.match(result.agentInstruction, /ask for explicit approval of that exact message, and only then send it with relay_send to relayUserId usr_sam/);
  assert.doesNotMatch(result.agentInstruction, /relay_share_link/);
  assert.match(store.current({ accountId: "usr_a" }).agentInstruction, /explicit approval/);
});

test("a tap with no AI waiting is opened elsewhere, and a late wait leaves it alone", async (t) => {
  const directory = sandbox(t);
  const time = clock();
  const store = createFirstRelayIdeas({ directory, now: time.now });
  store.begin({ accountId: "usr_a", host: "codex" });
  store.setIdeas(four(), { accountId: "usr_a" });
  time.advance(WAITER_LIVE_MS + 1);
  const tapped = store.pick("idea-2", { accountId: "usr_a" });
  assert.equal(tapped.mode, "reopened");
  assert.equal(tapped.idea.prompt, "Make me a Relay asking for review 2.", "the caller opens the AI with this prompt");
  const late = await store.waitForPick({ accountId: "usr_a", sleep: async () => {} });
  assert.equal(late.picked, null);
  assert.equal(late.openedElsewhere.id, "idea-2");
  assert.match(late.agentInstruction, /Do not write it here/);
  assert.match(store.current({ accountId: "usr_a" }).agentInstruction, /opened it in a new conversation/);
  assert.throws(() => store.pick("idea-9", { accountId: "usr_b" }), /setup has ended/);
});

test("the MCP tools run the whole conversation on this computer's files", async (t) => {
  const directory = sandbox(t);
  const store = createFirstRelayIdeas({ directory });
  const client = { identity: { userId: "usr_a" } };
  const call = (name, args = {}, extra = {}) => firstRelayOnboardingCall(client, name, args, { store, readRecentWork: () => ({ days: 7, items: [{ app: "Codex", title: "", ask: "rewrite the pricing page", project: "site", at: "2026-10-10T08:00:00.000Z" }], sources: { codex: "threads", claudeCode: "none" } }), ...extra });
  assert.equal((await call("relay_onboarding_current")).active, false);
  assert.deepEqual((await call("relay_onboarding_recent_work")).items, [], "nothing is read without an active setup");
  store.begin({ accountId: "usr_a", host: "codex" });
  assert.equal((await call("relay_onboarding_current")).active, true);
  const work = await call("relay_onboarding_recent_work");
  assert.equal(work.items[0].ask, "rewrite the pricing page");
  assert.match(work.agentInstruction, /Do not recite this list/);
  await assert.rejects(call("relay_onboarding_ideas", { ideas: four().slice(0, 2) }), /exactly 4 ideas/);
  const shown = await call("relay_onboarding_ideas", { ideas: four() });
  assert.equal(shown.shown, true);
  assert.match(shown.agentInstruction, /first explain Relay in one or two sentences/);
  store.pick("idea-4", { accountId: "usr_a" });
  const picked = await call("relay_onboarding_wait_pick");
  assert.equal(picked.picked.id, "idea-4");
  // Another account's session never sees this setup.
  assert.equal((await firstRelayOnboardingCall({ identity: { userId: "usr_b" } }, "relay_onboarding_current", {}, { store })).active, false);
});

test("the helper's wait is shorter than an MCP host's", async (t) => {
  const directory = sandbox(t);
  const limits = [];
  const store = { waitForPick: async ({ timeoutMs }) => { limits.push(timeoutMs); return { waiting: true }; } };
  await firstRelayOnboardingCall({ identity: { userId: "usr_a" } }, "relay_onboarding_wait_pick", {}, { store });
  await firstRelayOnboardingCall({ identity: { userId: "usr_a" } }, "relay_onboarding_wait_pick", {}, { store, sessionContext: { sourceHost: "relay-agent-protocol" } });
  assert.deepEqual(limits, [WAIT_MAX_MS, HELPER_WAIT_MAX_MS]);
  assert.ok(directory);
});

test("recent work is short, newest first, read-only, and leaves out Relay's own setup and subagents", (t) => {
  const root = sandbox(t);
  const now = Date.parse("2026-10-10T12:00:00Z");
  const projects = path.join(root, "claude", "projects");
  fs.mkdirSync(path.join(projects, "-Users-me-site"), { recursive: true });
  const session = (name, lines, mtime) => {
    const file = path.join(projects, "-Users-me-site", name);
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  session("a.jsonl", [
    { type: "custom-title", customTitle: "Pricing page rewrite" },
    { type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } },
    { type: "user", cwd: "/Users/me/site", message: { content: [{ type: "text", text: "Rewrite the **pricing** page so the tiers are clearer" }] } },
  ], now - 60_000);
  session("b.jsonl", [{ type: "user", cwd: "/Users/me/site", message: { content: "Set up Relay with me." } }], now - 30_000);
  session("old.jsonl", [{ type: "user", cwd: "/Users/me/site", message: { content: "Something from last month" } }], now - 20 * 86_400_000);
  // Codex: no sqlite here, so the rollouts are read.
  const day = path.join(root, "codex", "sessions", "2026", "10", "10");
  fs.mkdirSync(day, { recursive: true });
  const rollout = (name, lines, mtime) => {
    const file = path.join(day, name);
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  rollout("rollout-1.jsonl", [
    { type: "session_meta", payload: { cwd: "/Users/me/api", source: "vscode", thread_source: "user" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\nFix the flaky login test" } },
  ], now - 10_000);
  rollout("rollout-2.jsonl", [
    { type: "session_meta", payload: { cwd: "/Users/me/api", source: { subagent: { other: "guardian" } }, thread_source: "subagent" } },
    { type: "event_msg", payload: { type: "user_message", message: "Review this diff" } },
  ], now - 5_000);
  const before = fs.readdirSync(projects, { recursive: true }).length;
  const result = recentWork({ codexHome: path.join(root, "codex"), claudeProjectsDir: projects, now, spawn: () => ({ status: 1 }) });
  assert.deepEqual(result.items.map((item) => [item.app, item.title, item.ask, item.project]), [
    ["Codex", "", "Fix the flaky login test", "api"],
    ["Claude Code", "Pricing page rewrite", "Rewrite the pricing page so the tiers are clearer", "site"],
  ]);
  assert.deepEqual(result.sources, { codex: "sessions", claudeCode: "sessions" });
  assert.equal(fs.readdirSync(projects, { recursive: true }).length, before, "nothing is written");
  assert.ok(result.items.every((item) => !("rawAsk" in item) && !item.project.includes("/")), "only folder names, never paths");
  // Asks are cut to a short snippet.
  session("long.jsonl", [{ type: "user", cwd: "/x", message: { content: "word ".repeat(200) } }], now - 1000);
  const long = recentWork({ claudeProjectsDir: projects, now, limit: 1 }).items[0];
  assert.ok(long.ask.length <= 180 && long.ask.endsWith("…"));
});

test("choosing a local AI finishes the account step in the app, with no browser and no agent command", async (t) => {
  const directory = sandbox(t);
  let signIns = 0;
  const bridge = await startDesktopOnboardingBridge({ directory,
    authorization: { signIn: async () => { signIns++; }, state: async () => ({ status: "pending_identity" }), resume: async () => {}, cancel: async () => {} },
    isPaired: () => true,
    verifyAccount: async () => ({ id: "usr_local", onboardingContext: { inviter: { name: "Sam", relayUserId: "usr_sam" } } }),
  });
  try {
    await assert.rejects(bridge.prepareLocalAgent("chatgpt"), /Claude Code, Codex or Conductor/);
    const run = await bridge.prepareLocalAgent("conductor");
    assert.equal(run.stage, "teaching");
    assert.equal(run.accountId, "usr_local");
    assert.equal(run.host, "conductor");
    assert.deepEqual(run.context.inviter, { name: "Sam", relayUserId: "usr_sam" });
    assert.equal(signIns, 0, "a signed-in app never opens the browser");
    assert.equal((await bridge.prepareLocalAgent("codex")).stage, "teaching", "idempotent");
    // An AI following an older pasted prompt still gets the same answer.
    const old = await callDesktopOnboarding({ directory, operation: "start", run: run.id, host: "codex", guideVersion: 1 });
    assert.equal(old.stage, "teaching");
    const { saveDesktopTeachingContext } = await import("../src/desktop-teaching-context.js");
    saveDesktopTeachingContext({ directory, run: bridge.state(), apiUrl: "https://api.relay.test" });
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "agent-protocol.json"), "utf8"));
    assert.equal(saved.account.relayUserId, "usr_local");
    assert.equal(saved.consentVersion, 2);
    assert.equal(saved.tutorial.state, "pending");
  } finally { await bridge.close(); }
});

test("a signed-out app refuses the account step instead of opening a browser for the AI", async (t) => {
  const directory = sandbox(t);
  let signIns = 0;
  const bridge = await startDesktopOnboardingBridge({ directory,
    authorization: { signIn: async () => { signIns++; }, state: async () => ({ status: "pending_identity" }), resume: async () => {}, cancel: async () => {} },
    isPaired: () => false,
    verifyAccount: async () => ({ id: "usr_local" }),
  });
  try {
    await assert.rejects(bridge.prepareLocalAgent("codex"), /Sign in to Relay first/);
    assert.equal(bridge.state().stage, "prompt");
    assert.equal(signIns, 0);
  } finally { await bridge.close(); }
});
