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

test("visible user-turn delivery requires the explicit picker contract", async () => {
  const delivery = await import(`../src/session-delivery.js?contract=${Date.now()}`);
  assert.match(delivery.relayReferencePrompt("relay_contract"), /was selected for this task/);
  assert.doesNotMatch(delivery.relayReferencePrompt("relay_contract"), /has arrived/);
  await assert.rejects(
    delivery.deliverRelayToSession({ relayId: "relay_contract", target: targetFor("/tmp/contract.jsonl") }),
    (error) => error?.code === "SESSION_DELIVERY_MODE_REQUIRED",
  );
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
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
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
      deliveryMode:delivery.EXPLICIT_PICKER_DELIVERY,
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
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
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

test("concurrent picker selections share one durable claim and submit one visible turn", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-concurrent-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_once: { id: "relay_once" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?concurrent=${Date.now()}`);
    const target = targetFor(rollout);
    let releaseSubmit;
    let submitStarted;
    const started = new Promise((resolve) => { submitStarted = resolve; });
    let sends = 0;
    const options = {
      relayId: "relay_once",
      target,
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
      discover: () => [target],
      waitForCodexIdle: async () => ({ idle: true }),
      submitCodex: async () => {
        sends += 1;
        submitStarted();
        await new Promise((resolve) => { releaseSubmit = resolve; });
        return { submitted: true, ran: true, clientUserMessageId: "message-once" };
      },
      notifyCodex: async () => ({ ok: true }),
      pollMs: 1,
    };
    const first = delivery.deliverRelayToSession(options);
    await started;
    await assert.rejects(
      delivery.deliverRelayToSession(options),
      (error) => error?.code === "SESSION_DELIVERY_PENDING",
    );
    releaseSubmit();
    const result = await first;
    assert.equal(result.delivered, true);
    assert.equal(sends, 1);
    assert.equal(delivery.relaySessionBinding("relay_once").nativeId, CODEX_ID);
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("a dead pre-dispatch owner is safely replaced because no provider call could have started", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-waiting-restart-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    packets: {
      relay_restart: {
        id: "relay_restart",
        sessionDelivery: {
          claimId: "dead-waiting-claim",
          mode: "explicit_picker",
          status: "waiting",
          ownerPid: 99999999,
          provider: "codex",
          nativeId: CODEX_ID,
          clientUserMessageId: "never-dispatched",
          requestId: "never-dispatched-request",
        },
      },
    },
  }));
  try {
    const delivery = await import(`../src/session-delivery.js?waiting-restart=${Date.now()}`);
    const target = targetFor(rollout);
    let sends = 0;
    let replacementIdentity = "";
    const result = await delivery.deliverRelayToSession({
      relayId: "relay_restart",
      target,
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
      discover: () => [target],
      waitForCodexIdle: async () => ({ idle: true }),
      submitCodex: async (input) => {
        sends += 1;
        replacementIdentity = input.clientUserMessageId;
        return { submitted: true, ran: true, clientUserMessageId: replacementIdentity };
      },
      notifyCodex: async () => ({ ok: true }),
    });
    assert.equal(result.delivered, true);
    assert.equal(sends, 1);
    assert.notEqual(replacementIdentity, "never-dispatched");
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("new-session picker materialization is claimed once and recovered from persisted native state", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-new-claim-"));
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    packets: { relay_new_once: { id: "relay_new_once", title: "New once" } },
  }));
  try {
    const delivery = await import(`../src/session-delivery.js?new-claim=${Date.now()}`);
    const first = delivery.claimRelayNewSession("relay_new_once", "codex");
    assert.equal(first.kind, "claimed");
    assert.throws(
      () => delivery.claimRelayNewSession("relay_new_once", "codex"),
      (error) => error?.code === "SESSION_DELIVERY_PENDING",
      "a concurrent New task click cannot forceFresh a second task",
    );
    assert.equal(delivery.markRelaySessionDispatching("relay_new_once", first.claim.claimId), true);
    const statePath = path.join(root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.packets.relay_new_once.codexThreadId = "thread_new_once";
    state.packets.relay_new_once.openCwd = root;
    fs.writeFileSync(statePath, JSON.stringify(state));

    const recovered = delivery.claimRelayNewSession("relay_new_once", "codex");
    assert.equal(recovered.kind, "recovered");
    assert.equal(recovered.opened.nativeId, "thread_new_once");
    assert.equal(recovered.opened.url, "codex://threads/thread_new_once");
    const binding = delivery.completeRelayNewSession(
      "relay_new_once",
      recovered.opened,
      recovered.claim.claimId,
    );
    assert.equal(binding.nativeId, "thread_new_once");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).packets.relay_new_once.sessionDelivery, undefined);

    const failedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    failedState.packets.relay_new_error = { id: "relay_new_error", title: "No cwd" };
    fs.writeFileSync(statePath, JSON.stringify(failedState));
    const failed = delivery.claimRelayNewSession("relay_new_error", "codex");
    assert.equal(delivery.markRelaySessionDispatching("relay_new_error", failed.claim.claimId), true);
    assert.equal(delivery.releaseRelaySessionClaim("relay_new_error", failed.claim.claimId), true);
    assert.equal(
      delivery.claimRelayNewSession("relay_new_error", "codex").kind,
      "claimed",
      "a proven no-side-effect materializer error does not strand the New task row",
    );
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("an acknowledged but unverified Desktop delivery never starts a competing App Server", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-owner-only-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_owner: { id: "relay_owner" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?owner-only=${Date.now()}`);
    const target = targetFor(rollout);
    let appServerCalls = 0;
    let submitCalls = 0;
    let clientUserMessageId = "";
    await assert.rejects(
      delivery.deliverRelayToSession({
        relayId: "relay_owner",
        target,
        deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
        discover: () => [target],
        waitForCodexIdle: async () => ({ idle: true }),
        submitCodex: async (input) => {
          submitCalls += 1;
          clientUserMessageId = input.clientUserMessageId;
          return {
            attempted: true,
            submitted: true,
            ran: false,
            clientUserMessageId,
          };
        },
        appServer: async () => {
          appServerCalls += 1;
          throw new Error("must not run");
        },
        pollMs: 1,
      }),
      (error) => error?.code === "CODEX_DELIVERY_UNCONFIRMED",
    );
    assert.equal(appServerCalls, 0);
    assert.equal(submitCalls, 1);
    assert.equal(delivery.relaySessionBinding("relay_owner"), null);
    const uncertain = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"))
      .packets.relay_owner.sessionDelivery;
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.clientUserMessageId, clientUserMessageId);
    assert.doesNotMatch(
      delivery.publicSessionDeliveryError(new Error("thread secret-id already has an active writer"), "codex"),
      /secret-id|active writer/i,
    );

    fs.appendFileSync(
      rollout,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", client_id: clientUserMessageId, content: [{ type: "input_text", text: "selected" }] },
        },
      })}\n`,
    );
    const recovered = await delivery.deliverRelayToSession({
      relayId: "relay_owner",
      target,
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
      discover: () => [target],
      submitCodex: async () => {
        submitCalls += 1;
        throw new Error("must not resubmit");
      },
      notifyCodex: async () => ({ ok: true }),
      pollMs: 1,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.binding.nativeId, CODEX_ID);
    assert.equal(submitCalls, 1, "recovery binds the accepted identity without another turn/start");
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
  }
});

test("an ambiguous inspector dispatch fails closed instead of opening the App Server fallback", async () => {
  const previousHome = process.env.RELAY_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-ambiguous-owner-"));
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  process.env.RELAY_HOME = root;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ packets: { relay_ambiguous: { id: "relay_ambiguous" } } }));
  try {
    const delivery = await import(`../src/session-delivery.js?ambiguous-owner=${Date.now()}`);
    const target = targetFor(rollout);
    let appServerCalls = 0;
    await assert.rejects(
      delivery.deliverRelayToSession({
        relayId: "relay_ambiguous",
        target,
        deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
        discover: () => [target],
        waitForCodexIdle: async () => ({ idle: true }),
        submitCodex: async () => ({
          attempted: true,
          submitted: false,
          ran: false,
          deliveryAmbiguous: true,
        }),
        appServer: async () => {
          appServerCalls += 1;
          throw new Error("must not run");
        },
      }),
      (error) => error?.code === "CODEX_DELIVERY_UNCONFIRMED",
    );
    assert.equal(appServerCalls, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"))
        .packets.relay_ambiguous.sessionDelivery.status,
      "uncertain",
    );
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
      deliveryMode: delivery.EXPLICIT_PICKER_DELIVERY,
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
