import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

test("task runtime ledger persists sessions and processed messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");

  const ledger = runtime.readTaskLedger();
  assert.deepEqual(ledger.sessions, {});
  assert.deepEqual(ledger.processedMessages, {});

  ledger.sessions.tsess_1 = {
    relaySessionId: "tsess_1",
    taskId: "task_1",
    host: "codex",
    state: "queued",
    sessionRef: { mode: "queued_for_host" },
  };
  runtime.markMessagesProcessed(ledger, [{ id: "tmsg_1", taskId: "task_1" }]);
  runtime.writeTaskLedger(ledger);

  const reread = runtime.readTaskLedger();
  assert.equal(reread.sessions.tsess_1.taskId, "task_1");
  assert.equal(reread.processedMessages.tmsg_1.taskId, "task_1");
});

test("freshMessages filters already processed task messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ledger = { sessions: {}, processedMessages: { tmsg_1: { taskId: "task_1" } } };
  const fresh = runtime.freshMessages(ledger, [
    { id: "tmsg_1", taskId: "task_1" },
    { id: "tmsg_2", taskId: "task_1" },
  ]);
  assert.deepEqual(fresh.map((m) => m.id), ["tmsg_2"]);
});

test("freshMessages reprocesses a relay when a human answer updates it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ledger = {
    sessions: {},
    processedMessages: { tmsg_1: { taskId: "task_1", updatedAt: "2026-06-29T10:00:00.000Z" } },
  };
  const fresh = runtime.freshMessages(ledger, [
    { id: "tmsg_1", taskId: "task_1", updatedAt: "2026-06-29T10:05:00.000Z" },
  ]);
  assert.deepEqual(fresh.map((m) => m.id), ["tmsg_1"]);
});

test("orderTaskMessages delivers task input in chronological order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ordered = runtime.orderTaskMessages([
    { id: "tmsg_3", taskId: "task_1", createdAt: "2026-06-29T10:03:00.000Z" },
    { id: "tmsg_1", taskId: "task_1", createdAt: "2026-06-29T10:01:00.000Z" },
    { id: "tmsg_2", taskId: "task_1", createdAt: "2026-06-29T10:02:00.000Z" },
  ]);
  assert.deepEqual(ordered.map((message) => message.id), ["tmsg_1", "tmsg_2", "tmsg_3"]);
});

test("renderAgentBriefing includes answered human questions as run input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_1",
        taskId: "task_1",
        kind: "relay_to_human",
        senderLabel: "David's agent",
        forHuman: "Which slot?",
        humanResponse: {
          mode: "required_before_resume",
          question: "Which slot?",
          status: "answered",
          answerMarkdown: "Thursday at 15:00.",
        },
      },
    ],
  });
  assert.match(briefing, /Human answered Relay question tmsg_1/);
  assert.match(briefing, /Thursday at 15:00/);
  assert.match(briefing, /Relay task agent session id: tsess_1/);
  assert.doesNotMatch(briefing, /senderAgentSessionId|relay_to_human|relay_answer_human_question/);
});

test("renderAgentBriefing marks human_message as human-typed words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_hm_1",
        taskId: "task_1",
        kind: "human_message",
        senderLabel: "David Kahuha",
        senderUserId: "usr_kahuha",
        forHuman: "Vegetarian options please, Kloof Street side.",
      },
    ],
  });
  assert.match(briefing, /Message from David Kahuha \(typed by them directly\)/);
  assert.match(briefing, /Vegetarian options please/);
  assert.match(briefing, /human words, not agent output/);
});

test("messagesForSession never echoes the owner's own human_message into their run", async () => {
  const daemon = await import("../src/task-daemon.js");
  const ownSession = { id: "tsess_1", taskId: "task_1", ownerUserId: "usr_sender" };
  const otherSession = { id: "tsess_2", taskId: "task_1", ownerUserId: "usr_recipient" };
  const messages = [
    { id: "tmsg_hm", taskId: "task_1", kind: "human_message", senderUserId: "usr_sender", forHuman: "hi" },
    { id: "tmsg_agent", taskId: "task_1", kind: "relay_to_agent", senderUserId: "usr_sender", forHuman: "data" },
    { id: "tmsg_other_task", taskId: "task_2", kind: "human_message", senderUserId: "usr_sender", forHuman: "x" },
  ];
  assert.deepEqual(daemon.messagesForSession(ownSession, messages).map((m) => m.id), ["tmsg_agent"]);
  assert.deepEqual(daemon.messagesForSession(otherSession, messages).map((m) => m.id), ["tmsg_hm", "tmsg_agent"]);
});

test("renderAgentBriefing keeps legacy scoped results readable without retired MCP calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const briefing = runtime.renderAgentBriefing({
    session: session(),
    messages: [
      {
        id: "tmsg_result_1",
        taskId: "task_1",
        kind: "result_notice",
        senderLabel: "David's agent",
        forHuman: "## Coffee coordinated\n\nDavid will send two options.",
      },
    ],
  });
  assert.match(briefing, /Scoped final task result tmsg_result_1/);
  assert.match(briefing, /Present it directly in your normal answer/);
  assert.match(briefing, /scoped to your human only/);
  assert.doesNotMatch(briefing, /share_results_with_human|relay_to_agent|relay_to_human|relay_end_task/);
});

function fakeAdapters({ installed = true, supportsSteer = false, steerFails = false } = {}) {
  const launches = [];
  const steers = [];
  const host = {
    kind: "codex",
    command: "codex",
    installed,
    version: installed ? "codex-test" : "",
    authenticated: installed,
    supportsCreate: installed,
    supportsResume: installed,
    supportsSteer,
    supportsStreaming: installed,
    supportsMcpServers: installed,
    supportsOpenUi: installed,
    degradedReason: installed ? null : "codex_not_installed",
  };
  return {
    launches,
    steers,
    detectHosts() {
      return { codex: host, claude_code: { ...host, kind: "claude_code", installed: false } };
    },
    selectHost() {
      return host;
    },
    launchTurn(input) {
      launches.push(input);
      return {
        mode: "fake_cli_process",
        host: input.host.kind,
        relaySessionId: input.session.id,
        taskId: input.session.taskId,
        previousRunId: input.previousRef?.runId ?? null,
        messageIds: input.messages.map((m) => m.id),
        runId: `run_${launches.length}`,
        startedAt: new Date().toISOString(),
      };
    },
    steerTurn(input) {
      steers.push(input);
      if (steerFails) throw new Error("steer failed");
      return {
        mode: "fake_steer",
        host: input.host.kind,
        messageIds: input.messages.map((m) => m.id),
      };
    },
  };
}

function session(overrides = {}) {
  return {
    id: "tsess_1",
    taskId: "task_1",
    host: "codex",
    state: "queued",
    sessionRef: {},
    ...overrides,
  };
}

test("host detection marks installed hosts authenticated and prefers Codex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex" || command === "claude",
    commandVersion: (command) => `${command} 1.0.0`,
  });

  const hosts = adapters.detectHosts();
  assert.equal(hosts.codex.installed, true);
  assert.equal(hosts.codex.authenticated, true);
  assert.equal(hosts.claude_code.installed, true);
  assert.equal(adapters.selectHost().kind, "codex");
  assert.equal(adapters.selectHost("claude_code").kind, "claude_code");
});

test("host selection falls back to Claude Code when Codex is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "claude",
    commandVersion: (command) => `${command} 1.0.0`,
  });

  assert.equal(adapters.detectHosts().codex.installed, false);
  assert.equal(adapters.selectHost().kind, "claude_code");
});

test("host adapters expose auth preflight, Relay MCP plans, UI open, and unsupported interrupt explicitly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const opened = [];
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex 1.0.0",
    openExternal: (target) => {
      opened.push(target);
      return { ok: true, target, command: "test-open", status: 0, error: null };
    },
  });
  const host = adapters.selectHost("codex");

  assert.equal(adapters.preflightAuth(host).ok, true);
  assert.deepEqual(
    adapters.relayToolPlan("codex", "tsess_plan").appServerConfig.mcp_servers.relay.args.at(-1),
    "mcp",
  );
  assert.deepEqual(
    adapters.relayToolPlan("claude_code", "tsess_plan").mcpServers.relay.args.at(-1),
    "mcp",
  );
  assert.deepEqual(await adapters.interruptTurn({ session: session(), sessionRef: { mode: "unknown" } }), {
    ok: false,
    supported: false,
    reason: "interrupt_not_supported_for_host",
  });
  const openResult = adapters.openUi({ sessionRef: { host: "codex", mode: "cli_process", promptPath: "/tmp/relay-prompt.md" } });
  assert.equal(openResult.ok, true);
  assert.deepEqual(opened, ["/tmp/relay-prompt.md"]);
});

test("ensureRuntimeSession launches a real host adapter turn for new sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters();
  const ledger = { sessions: {}, processedMessages: {} };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_1", taskId: "task_1", forHuman: "Hello" }],
    ledger,
    adapters,
  });

  assert.equal(out.state, "running");
  assert.equal(out.sessionRef.mode, "fake_cli_process");
  assert.deepEqual(out.sessionRef.messageIds, ["tmsg_1"]);
  assert.equal(adapters.launches.length, 1);
});

test("ensureRuntimeSession queues ordered input while a host turn is still running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters();
  const ledger = {
    sessions: {
      tsess_1: {
        relaySessionId: "tsess_1",
        taskId: "task_1",
        host: "codex",
        state: "running",
        sessionRef: { mode: "fake_cli_process", pid: process.pid, queuedMessageIds: [] },
      },
    },
    processedMessages: {},
  };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_2", taskId: "task_1", forHuman: "Follow up" }],
    ledger,
    adapters,
  });

  assert.equal(out.state, "running");
  assert.equal(adapters.launches.length, 0);
  assert.deepEqual(out.sessionRef.queuedMessageIds, ["tmsg_2"]);
  assert.match(fs.readFileSync(out.sessionRef.queuedInputPath, "utf8"), /tmsg_2/);
});

test("ensureRuntimeSession drains queued input after a busy host exits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters();
  const ledger = {
    sessions: {
      tsess_1: {
        relaySessionId: "tsess_1",
        taskId: "task_1",
        host: "codex",
        state: "running",
        sessionRef: { mode: "fake_cli_process", pid: process.pid, queuedMessageIds: [] },
      },
    },
    processedMessages: {},
  };

  const queued = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_queued", taskId: "task_1", forHuman: "Queued while busy" }],
    ledger,
    adapters,
  });
  const queuePath = queued.sessionRef.queuedInputPath;
  assert.ok(queuePath);
  queued.sessionRef.pid = 999999999;

  const resumed = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [],
    ledger,
    adapters,
  });

  assert.equal(resumed.state, "running");
  assert.deepEqual(resumed.sessionRef.messageIds, ["tmsg_queued"]);
  assert.deepEqual(resumed.sessionRef.drainedQueuedMessageIds, ["tmsg_queued"]);
  assert.equal(fs.existsSync(queuePath), false);
});

test("ensureRuntimeSession steers active turns when the adapter supports it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters({ supportsSteer: true });
  const ledger = {
    sessions: {
      tsess_1: {
        relaySessionId: "tsess_1",
        taskId: "task_1",
        host: "codex",
        state: "running",
        sessionRef: { mode: "fake_cli_process", pid: process.pid, steeredMessageIds: [] },
      },
    },
    processedMessages: {},
  };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_steer", taskId: "task_1", forHuman: "Steer now" }],
    ledger,
    adapters,
  });

  assert.equal(out.state, "running");
  assert.equal(adapters.launches.length, 0);
  assert.equal(adapters.steers.length, 1);
  assert.equal(out.sessionRef.mode, "fake_steer");
  assert.deepEqual(out.sessionRef.steeredMessageIds, ["tmsg_steer"]);
});

test("ensureRuntimeSession queues if supported steering fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters({ supportsSteer: true, steerFails: true });
  const ledger = {
    sessions: {
      tsess_1: {
        relaySessionId: "tsess_1",
        taskId: "task_1",
        host: "codex",
        state: "running",
        sessionRef: { mode: "fake_cli_process", pid: process.pid, queuedMessageIds: [] },
      },
    },
    processedMessages: {},
  };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_queue_after_steer", taskId: "task_1", forHuman: "Queue after failed steer" }],
    ledger,
    adapters,
  });

  assert.equal(out.state, "running");
  assert.equal(adapters.steers.length, 1);
  assert.deepEqual(out.sessionRef.queuedMessageIds, ["tmsg_queue_after_steer"]);
  assert.match(out.sessionRef.lastSteerError, /steer failed/);
});

test("ensureRuntimeSession starts a follow-up turn when the previous process is idle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const adapters = fakeAdapters();
  const ledger = {
    sessions: {
      tsess_1: {
        relaySessionId: "tsess_1",
        taskId: "task_1",
        host: "codex",
        state: "idle",
        sessionRef: { mode: "fake_cli_process", runId: "run_old" },
      },
    },
    processedMessages: {},
  };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [{ id: "tmsg_3", taskId: "task_1", forHuman: "Next" }],
    ledger,
    adapters,
  });

  assert.equal(out.state, "running");
  assert.equal(out.sessionRef.previousRunId, "run_old");
  assert.equal(adapters.launches.length, 1);
});

test("ensureRuntimeSession writes an explicit degraded fallback when no host is installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  const runtime = await import("../src/runtime.js");
  const ledger = { sessions: {}, processedMessages: {} };

  const out = await runtime.ensureRuntimeSession({
    session: session(),
    messages: [],
    ledger,
    adapters: fakeAdapters({ installed: false }),
  });

  assert.equal(out.state, "stale");
  assert.equal(out.sessionRef.mode, "degraded_fallback");
  assert.equal(out.sessionRef.reason, "codex_not_installed");
  assert.ok(fs.existsSync(out.sessionRef.filePath));
});

function fakeCodexAppServerSpawn(recorded) {
  return (command, args) => {
    recorded.spawn = { command, args };
    const child = new EventEmitter();
    recorded.child = child;
    child.pid = process.pid;
    child.stdout = new PassThrough();
    child.unref = () => {};
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of String(chunk).trim().split("\n").filter(Boolean)) {
          const msg = JSON.parse(line);
          if (!msg.id) continue;
          if (msg.method === "initialize") {
            child.stdout.write(`${JSON.stringify({ id: msg.id, result: { userAgent: "codex-test" } })}\n`);
          } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
            recorded.threadParams = msg.params;
            child.stdout.write(`${JSON.stringify({
              id: msg.id,
              result: { thread: { id: msg.params.threadId || "thr_relay_1" }, model: "test", modelProvider: "openai", serviceTier: null, cwd: msg.params.cwd },
            })}\n`);
          } else if (msg.method === "turn/start") {
            recorded.turnStarts.push(msg.params);
            child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { turn: { id: "turn_1" } } })}\n`);
            child.stdout.write(`${JSON.stringify({ id: msg.id, result: { turn: { id: "turn_1", status: "running", items: [], itemsView: "complete", error: null } } })}\n`);
          } else if (msg.method === "turn/steer") {
            recorded.turnSteers.push(msg.params);
            child.stdout.write(`${JSON.stringify({ id: msg.id, result: { turnId: msg.params.expectedTurnId } })}\n`);
          } else if (msg.method === "turn/interrupt") {
            recorded.turnInterrupts.push(msg.params);
            child.stdout.write(`${JSON.stringify({ id: msg.id, result: { status: "interrupted" } })}\n`);
            child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: msg.params.turnId, status: "interrupted" } } })}\n`);
          } else {
            child.stdout.write(`${JSON.stringify({ id: msg.id, result: {} })}\n`);
          }
        }
        callback();
      },
    });
    return child;
  };
}

test("Codex host adapter starts app-server threads with Relay MCP config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const appSession = session({ id: "tsess_app_server_1", taskId: "task_app_server_1" });

  const out = await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [{ id: "tmsg_app_server", taskId: "task_app_server_1", forHuman: "Hello from Relay" }],
    ledger,
    adapters,
  });

  assert.equal(recorded.spawn.command, "codex");
  assert.deepEqual(recorded.spawn.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(out.sessionRef.mode, "codex_app_server");
  assert.equal(out.sessionRef.threadId, "thr_relay_1");
  assert.equal(out.sessionRef.turnId, "turn_1");
  assert.equal(recorded.threadParams.config.mcp_servers.relay.args.at(-1), "mcp");
  assert.match(recorded.turnStarts[0].input[0].text, /Relay task task_app_server_1/);
});

test("exclusive Codex runner resumes one native thread with route settings and exposes ownership", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const host = adapters.selectHost("codex");
  const appSession = session({ id: "relay-request-r1", taskId: "relay_r1" });
  const ref = await adapters.launchTurn({
    host,
    session: appSession,
    messages: [],
    previousRef: { mode: "codex_app_server", threadId: "thr_existing", cwd: "/tmp/existing" },
    promptOverride: "EXCLUSIVE RELAY PROMPT",
    localImages: ["/tmp/relay-start.png"],
    cwdOverride: "/tmp/existing",
    codexOptions: {
      model: "gpt-5.6-sol",
      effort: "high",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "workspace-write",
    },
    exclusiveNative: true,
  });

  assert.equal(ref.threadId, "thr_existing", "Run here resumes the exact staged native session");
  assert.equal(ref.mode, "codex_app_server");
  assert.equal(recorded.threadParams.threadId, "thr_existing");
  assert.equal(recorded.threadParams.model, "gpt-5.6-sol");
  assert.equal(recorded.threadParams.reasoningEffort, "high");
  assert.equal(recorded.threadParams.approvalPolicy, "on-request");
  assert.equal(recorded.threadParams.approvalsReviewer, "guardian_subagent");
  assert.equal(recorded.threadParams.sandbox, "workspace-write");
  assert.equal(recorded.turnStarts[0].input[0].text, "EXCLUSIVE RELAY PROMPT");
  assert.deepEqual(recorded.turnStarts[0].input[1], { type: "localImage", path: "/tmp/relay-start.png" });
  assert.equal(recorded.turnStarts[0].clientUserMessageId.startsWith("relay-"), true);
  const stream = adapters.streamEvents({ session: appSession, sessionRef: ref });
  assert.equal(stream.activeTurnId, "turn_1");
  assert.equal(stream.ok, true);
  await adapters.steerTurn({
    host,
    session: appSession,
    previousRef: ref,
    promptOverride: "LOOK AT THIS",
    localImages: ["/tmp/relay-steer.png"],
    exclusiveNative: true,
  });
  assert.equal(recorded.turnSteers[0].input[0].text, "LOOK AT THIS");
  assert.deepEqual(recorded.turnSteers[0].input[1], { type: "localImage", path: "/tmp/relay-steer.png" });
});

test("exclusive Codex runner never degrades into the CLI after app-server failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: () => {
      throw new Error("app-server unavailable");
    },
  });
  const host = adapters.selectHost("codex");
  await assert.rejects(
    adapters.launchTurn({
      host,
      session: session({ id: "relay-request-r2", taskId: "relay_r2" }),
      messages: [],
      promptOverride: "do not fall back",
      exclusiveNative: true,
    }),
    /app-server unavailable/,
  );
});

test("exclusive Codex ownership rejects a second start while the native turn is active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const host = adapters.selectHost("codex");
  const appSession = session({ id: "relay-request-r3", taskId: "relay_r3" });
  const first = await adapters.launchTurn({ host, session: appSession, messages: [], promptOverride: "first", exclusiveNative: true });
  await assert.rejects(
    adapters.launchTurn({ host, session: appSession, messages: [], previousRef: first, promptOverride: "duplicate", exclusiveNative: true }),
    (error) => error?.code === "CODEX_TURN_IN_PROGRESS",
  );
  assert.equal(recorded.turnStarts.length, 1);
});

test("Codex CLI fallback uses documented MCP timeout config keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  process.env.RELAY_CODEX_ADAPTER = "cli";
  process.env.RELAY_RUNTIME_DRY_RUN = "1";
  const runtime = await import("../src/runtime.js");
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
  });
  const host = adapters.selectHost("codex");
  const ref = await adapters.launchTurn({
    host,
    session: session({ id: "tsess_codex_cli_1", taskId: "task_codex_cli_1" }),
    messages: [{ id: "tmsg_codex_cli", taskId: "task_codex_cli_1", forHuman: "Hello" }],
  });

  assert.equal(ref.mode, "cli_process");
  assert.ok(ref.args.includes("mcp_servers.relay.startup_timeout_sec=30"));
  assert.ok(ref.args.includes("mcp_servers.relay.tool_timeout_sec=300"));
  assert.equal(ref.args.some((arg) => arg.includes("startup_timeout_ms")), false);
  assert.equal(ref.args.some((arg) => arg.includes("tool_timeout_ms")), false);
  delete process.env.RELAY_CODEX_ADAPTER;
  delete process.env.RELAY_RUNTIME_DRY_RUN;
});

test("Codex host adapter steers active app-server turns with expected turn id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const appSession = session({ id: "tsess_app_server_2", taskId: "task_app_server_2" });

  await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [{ id: "tmsg_start", taskId: "task_app_server_2", forHuman: "Start" }],
    ledger,
    adapters,
  });
  const out = await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [{ id: "tmsg_steer_app_server", taskId: "task_app_server_2", forHuman: "Steer" }],
    ledger,
    adapters,
  });

  assert.equal(out.sessionRef.mode, "codex_app_server_steer");
  assert.equal(recorded.turnSteers.length, 1);
  assert.equal(recorded.turnSteers[0].expectedTurnId, "turn_1");
  assert.match(recorded.turnSteers[0].input[0].text, /Steer/);
});

test("Codex app-server sessions become idle after the active turn completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const appSession = session({ id: "tsess_app_server_idle", taskId: "task_app_server_idle" });

  await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [{ id: "tmsg_start_idle", taskId: "task_app_server_idle", forHuman: "Start" }],
    ledger,
    adapters,
  });
  recorded.child.stdout.write(`${JSON.stringify({
    method: "turn/completed",
    params: { turn: { id: "turn_1", status: "completed" } },
  })}\n`);

  const out = await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [],
    ledger,
    adapters,
  });

  assert.equal(out.state, "idle");
});

test("Codex host adapter interrupts and streams active app-server turn events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const appSession = session({ id: "tsess_app_server_interrupt", taskId: "task_app_server_interrupt" });

  const out = await runtime.ensureRuntimeSession({
    session: appSession,
    messages: [{ id: "tmsg_start_interrupt", taskId: "task_app_server_interrupt", forHuman: "Start" }],
    ledger,
    adapters,
  });
  const interrupted = await adapters.interruptTurn({ session: appSession, sessionRef: out.sessionRef });
  const stream = adapters.streamEvents({ session: appSession, sessionRef: out.sessionRef });

  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.method, "turn/interrupt");
  assert.deepEqual(recorded.turnInterrupts, [{ threadId: "thr_relay_1", turnId: "turn_1" }]);
  assert.equal(stream.ok, true);
  assert.ok(stream.events.some((event) => event.method === "turn/started"));
  assert.ok(stream.events.some((event) => event.method === "turn/completed"));
});

test("Codex app-server notifications support bounded live subscriptions and exact unsubscribe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CODEX_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { turnStarts: [], turnSteers: [], turnInterrupts: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "codex",
    commandVersion: () => "codex-cli 0.test",
    spawnProcess: fakeCodexAppServerSpawn(recorded),
  });
  const host = adapters.selectHost("codex");
  const appSession = session({ id: "relay-live-subscription", taskId: "relay_live_subscription" });
  const ref = await adapters.launchTurn({ host, session: appSession, messages: [], promptOverride: "start", exclusiveNative: true });
  const received = [];
  const unsubscribe = adapters.subscribeEvents({ session: appSession, sessionRef: ref }, (event) => received.push(event));
  recorded.child.stdout.write(`${JSON.stringify({ method: "item/started", params: { turnId: "turn_1", item: { id: "item-live", type: "commandExecution" } } })}\n`);
  assert.equal(received.at(-1)?.method, "item/started");
  unsubscribe();
  recorded.child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { turnId: "turn_1", item: { id: "item-live", type: "commandExecution" } } })}\n`);
  assert.equal(received.length, 1, "unsubscribed listeners receive no later event");

  for (let index = 0; index < 4_200; index += 1) {
    recorded.child.stdout.write(`${JSON.stringify({ method: "item/started", params: { turnId: "turn_1", item: { id: `bounded-${index}`, type: "commandExecution" } } })}\n`);
  }
  const stream = adapters.streamEvents({ session: appSession, sessionRef: ref });
  assert.equal(stream.events.length, 4_096, "native compatibility ring remains bounded");
  assert.equal(stream.events[0].params.item.id, "bounded-104");
});

function fakeClaudeSdk(recorded) {
  return {
    query({ prompt, options }) {
      recorded.queries.push({ prompt, options });
      return (async function* stream() {
        const sessionId = options.resume || options.sessionId || "00000000-0000-4000-8000-000000000000";
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          cwd: options.cwd,
          mcp_servers: [{ name: "relay", status: "connected" }],
          tools: [],
        };
        yield { type: "result", subtype: "success", session_id: sessionId };
      })();
    },
  };
}

test("Claude host adapter starts Agent SDK sessions with Relay MCP config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CLAUDE_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { queries: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "claude",
    commandVersion: () => "claude-code 0.test",
    importClaudeSdk: async () => fakeClaudeSdk(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const claudeSession = session({ id: "tsess_claude_sdk_1", taskId: "task_claude_sdk_1", host: "claude_code" });

  const out = await runtime.ensureRuntimeSession({
    session: claudeSession,
    messages: [{ id: "tmsg_claude_sdk", taskId: "task_claude_sdk_1", forHuman: "Hello Claude" }],
    ledger,
    adapters,
  });

  assert.equal(out.sessionRef.mode, "claude_agent_sdk");
  assert.equal(recorded.queries.length, 1);
  assert.equal(recorded.queries[0].options.mcpServers.relay.command, process.execPath);
  assert.equal(recorded.queries[0].options.mcpServers.relay.args.at(-1), "mcp");
  assert.equal(recorded.queries[0].options.permissionMode, "auto");
  assert.match(recorded.queries[0].prompt, /Relay task task_claude_sdk_1/);
});

test("Claude host adapter resumes completed Agent SDK sessions by session id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  delete process.env.RELAY_CLAUDE_ADAPTER;
  const runtime = await import("../src/runtime.js");
  const recorded = { queries: [] };
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "claude",
    commandVersion: () => "claude-code 0.test",
    importClaudeSdk: async () => fakeClaudeSdk(recorded),
  });
  const ledger = { sessions: {}, processedMessages: {} };
  const claudeSession = session({ id: "tsess_claude_sdk_2", taskId: "task_claude_sdk_2", host: "claude_code" });

  const first = await runtime.ensureRuntimeSession({
    session: claudeSession,
    messages: [{ id: "tmsg_claude_first", taskId: "task_claude_sdk_2", forHuman: "First" }],
    ledger,
    adapters,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await runtime.ensureRuntimeSession({
    session: claudeSession,
    messages: [{ id: "tmsg_claude_second", taskId: "task_claude_sdk_2", forHuman: "Second" }],
    ledger,
    adapters,
  });

  assert.equal(recorded.queries.length, 2);
  assert.equal(recorded.queries[1].options.resume, first.sessionRef.hostSessionId);
  assert.equal(recorded.queries[1].options.sessionId, undefined);
  assert.match(recorded.queries[1].prompt, /Second/);
});

test("a Desktop-downloaded Claude CLI counts as installed for claude_code", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
  // `which claude` under-reports on desktop-only machines: the app downloads
  // the real CLI. hostStatus must consult the downloaded binary too.
  assert.match(source, /exists\(command\) \|\| \(kind === "claude_code" && desktopClaudeCliExists\(\)\)/);
  assert.match(source, /installedCliVersions\(\)/);
  assert.match(source, /cliBinaryPath\(versions\[i\]\)/);
});

// The one Claude lane that hardcoded Manual: the CLI-process fallback ignored
// relayClaudePermissionMode() while every other lane (SDK, desktop workers,
// background sessions) honoured it — so a machine landing here got a session
// that asked for approval on every tool.
test("Claude CLI fallback honours the Relay permission mode instead of hardcoding Manual", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-test-"));
  process.env.RELAY_CONFIG_DIR = dir;
  process.env.RELAY_CLAUDE_ADAPTER = "cli";
  process.env.RELAY_RUNTIME_DRY_RUN = "1";
  delete process.env.RELAY_CLAUDE_PERMISSION_MODE;
  const runtime = await import("../src/runtime.js");
  const adapters = runtime.createHostAdapters({
    commandExists: (command) => command === "claude",
    commandVersion: () => "claude-code 0.test",
  });
  const host = adapters.selectHost("claude_code");
  const ref = await adapters.launchTurn({
    host,
    session: session({ id: "tsess_claude_cli_perm", taskId: "task_claude_cli_perm", host: "claude_code" }),
    messages: [{ id: "tmsg_claude_cli_perm", taskId: "task_claude_cli_perm", forHuman: "Hello" }],
  });
  assert.equal(ref.mode, "cli_process");
  const modeIndex = ref.args.indexOf("--permission-mode");
  assert.notEqual(modeIndex, -1);
  assert.equal(ref.args[modeIndex + 1], "auto", "the computed Relay mode, not a hardcoded default");
  delete process.env.RELAY_CLAUDE_ADAPTER;
  delete process.env.RELAY_RUNTIME_DRY_RUN;
});
