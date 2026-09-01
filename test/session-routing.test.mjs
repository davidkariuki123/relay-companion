import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CODEX_ID = "11111111-1111-4111-8111-111111111111";

function targetFor(sessionPath, state = "idle") {
  return {
    provider: "codex",
    nativeId: CODEX_ID,
    title: "Existing task",
    cwd: "/tmp/project",
    state,
    lastActiveAt: new Date().toISOString(),
    capabilities: { send: true },
    nativeRef: { sessionPath },
  };
}

test("lists the current native task separately from five recents", async () => {
  const delivery = await import(`../src/session-delivery.js?list=${Date.now()}`);
  const rows = Array.from({ length: 8 }, (_, index) => ({
    ...targetFor(`/tmp/${index}.jsonl`),
    nativeId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    title: `Task ${index}`,
    lastActiveAt: new Date(Date.now() - index * 1_000).toISOString(),
  }));
  const result = delivery.listRelayDestinations("codex", {
    currentNativeId: rows[2].nativeId,
    discover: () => rows,
  });
  assert.equal(result.current.nativeId, rows[2].nativeId);
  assert.equal(result.recent.length, 5);
  assert.ok(result.recent.every((row) => row.nativeId !== rows[2].nativeId));
});

test("working tasks displace the oldest inactive picker rows", async () => {
  const delivery = await import(`../src/session-delivery.js?working=${Date.now()}`);
  const now = Date.now();
  const rows = Array.from({ length: 7 }, (_, index) => ({
    ...targetFor(`/tmp/rank-${index}.jsonl`),
    nativeId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    title: `Task ${index}`,
    state: "idle",
    lastActiveAt: new Date(now - index * 1_000).toISOString(),
  }));
  rows[6] = { ...rows[6], title: "Older but working", state: "active" };

  const result = delivery.listRelayDestinations("codex", { discover: () => rows });
  assert.equal(result.recent.length, 5);
  assert.ok(result.recent.some((row) => row.title === "Older but working"));
  assert.ok(!result.recent.some((row) => row.title === "Task 4"));
  assert.equal(result.recent[0].title, "Older but working");
});

test("delivers once to an exact idle task, binds it, then only continues it", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-delivery-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_1: { id: "relay_1" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?deliver=${Date.now()}`);
    const target = targetFor(rollout);
    const sends = [];
    const options = {
      relayId: "relay_1",
      target,
      discover: () => [target],
      submitCodex: async (input) => {
        sends.push(input);
        return { submitted: true, ran: true, clientUserMessageId: "message-1" };
      },
      notifyCodex: async () => ({ ok: true }),
      pollMs: 1,
    };
    const first = await delivery.deliverRelayToSession(options);
    assert.equal(first.delivered, true);
    assert.equal(first.binding.nativeId, CODEX_ID);
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /relay_1/);
    const second = await delivery.deliverRelayToSession(options);
    assert.equal(second.continued, true);
    assert.equal(sends.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("a sent Relay can supply its reference-only conversation lookup prompt", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sent-session-delivery-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { sent_relay_4: { id:"sent_relay_4" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?sent=${Date.now()}`);
    const target = targetFor(rollout);
    let submitted = "";
    const prompt = "A Relay you sent has been selected: relay_4. Use relay_sent_list, then relay_chat_fetch.";
    await delivery.deliverRelayToSession({
      relayId:"sent_relay_4",
      target,
      prompt,
      discover:() => [target],
      submitCodex:async ({ text }) => {
        submitted = text;
        return { submitted:true, ran:true, clientUserMessageId:"message-sent" };
      },
      notifyCodex:async () => ({ ok:true }),
      pollMs:1,
    });
    assert.equal(submitted, prompt);
    assert.doesNotMatch(submitted, /relay_inbox_list/);
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("queues the Relay behind an active native turn", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-queue-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_2: { id: "relay_2" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?queue=${Date.now()}`);
    const target = targetFor(rollout, "active");
    let probes = 0;
    let sends = 0;
    const result = await delivery.deliverRelayToSession({
      relayId: "relay_2",
      target,
      discover: () => [{ ...target, state: ++probes < 3 ? "active" : "idle" }],
      submitCodex: async () => {
        sends += 1;
        return { submitted: true, ran: true, clientUserMessageId: "message-2" };
      },
      notifyCodex: async () => ({ ok: true }),
      pollMs: 1,
    });
    assert.equal(result.delivered, true);
    assert.equal(sends, 1);
    assert.ok(probes >= 3);
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("a cold Claude session finishes its background owner before Relay opens it", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-claude-"));
  const transcript = path.join(root, "claude.jsonl");
  fs.writeFileSync(transcript, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_3: { id: "relay_3" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?claude=${Date.now()}`);
    const events = [];
    const target = {
      provider: "claude",
      nativeId: "22222222-2222-4222-8222-222222222222",
      title: "Existing Claude session",
      cwd: root,
      state: "idle",
      lastActiveAt: new Date().toISOString(),
      capabilities: { send: true },
      nativeRef: { transcriptPath: transcript },
    };
    const result = await delivery.deliverRelayToSession({
      relayId: "relay_3",
      target,
      discover: () => [target],
      spawnClaude: ({ sessionId, prompt }) => {
        events.push("spawn");
        fs.appendFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
        return { sessionId };
      },
      waitForClaudeCompletion: async () => { events.push("complete"); },
      pollMs: 1,
    });
    assert.deepEqual(events, ["spawn", "complete"]);
    assert.equal(result.delivery.adapter, "claude_background_resume");
    assert.equal(result.url, `claude://resume?session=${target.nativeId}`);
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});
