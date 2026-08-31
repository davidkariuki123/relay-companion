// Start Claude Code through the official standalone CLI and its supported
// subscription-login lifecycle. Relay never reads, copies, refreshes or stores
// Claude credentials: `claude auth login --claudeai` owns authentication and
// the worker below simply invokes that already-authorized CLI.

import crypto from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adoptClaudeSessionIntoDesktop } from "./claude-session-writer.js";

const liveWorkers = new Map();
const MAX_NATIVE_EVENTS = 4_096;

function recordNativeEvent(state, event) {
  if (!state || !event || typeof event !== "object") return event;
  state.nativeEventOffset = Number(state.nativeEventOffset || 0) + 1;
  const stamped = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
    nativeOffset: event.nativeOffset ?? state.nativeEventOffset,
  };
  state.nativeEvents.push(stamped);
  if (state.nativeEvents.length > MAX_NATIVE_EVENTS) {
    state.nativeEvents.splice(0, state.nativeEvents.length - MAX_NATIVE_EVENTS);
  }
  return stamped;
}

function notifyNativeWorker(state, event) {
  if (!state) return;
  for (const listener of state.nativeListeners) {
    try { listener(event || { type: "worker-state", timestamp: new Date().toISOString() }); } catch {}
  }
}
const continuationChains = new Map();

function supportedClaudeCliBinary() {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".local", "bin", "claude"),
  ].filter(Boolean);
  const binary = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (binary) return binary;
  // Preserve PATH installations. spawn() will return the native ENOENT if the
  // command is missing, which Settings turns into a precise install message.
  return "claude";
}

function transcriptPathFor(cwd, sessionId, homedir = os.homedir()) {
  return path.join(homedir, ".claude", "projects", String(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function permissionArgs(permissionMode) {
  const mode = String(permissionMode || "auto");
  return mode === "bypassPermissions"
    ? ["--permission-mode", mode, "--allow-dangerously-skip-permissions"]
    : ["--permission-mode", mode];
}

/**
 * Reuse the trusted local Relay server registration for a Task worker. The
 * server resolves developer capability from the signed-in Relay account; this
 * copy also strips mode flags left behind by older registrations.
 */
export function relayTaskMcpConfig(homedir = os.homedir(), {
  execPath = process.execPath,
  electron = Boolean(process.versions?.electron),
  binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/relay.js"),
  env = process.env,
} = {}) {
  // The live pill is an Electron process. Reusing its persistent host
  // registration here can route a private Claude worker through an updater
  // launcher that another runtime is concurrently refreshing. More
  // importantly, process.execPath is Electron, not Node: it needs the official
  // run-as-Node switch or Claude waits out its MCP deadline before dropping the
  // Relay tools. A provider-owned worker should bind to the exact runtime that
  // created it and must not rewrite the user's persistent registration.
  if (electron) {
    const childEnv = { ELECTRON_RUN_AS_NODE: "1" };
    for (const key of ["RELAY_API_URL", "RELAY_DEVICE_TOKEN", "RELAY_CONFIG_DIR"]) {
      if (env[key]) childEnv[key] = env[key];
    }
    return JSON.stringify({ mcpServers: { relay: {
      type: "stdio",
      command: execPath,
      args: [binPath, "mcp"],
      env: childEnv,
    } } });
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(homedir, ".claude.json"), "utf8"));
  } catch {
    return "";
  }
  const registered = config?.mcpServers?.relay;
  if (!registered || typeof registered !== "object" || !registered.command) return "";
  const args = (Array.isArray(registered.args) ? registered.args : [])
    .map((arg) => String(arg))
    .filter((arg) => arg !== "--messages-only" && arg !== "--full");
  const relay = {
    type: registered.type || "stdio",
    command: String(registered.command),
    args,
    ...(registered.env && typeof registered.env === "object" ? { env: registered.env } : {}),
  };
  return JSON.stringify({ mcpServers: { relay } });
}

function parseStreamLine(line) {
  try {
    return JSON.parse(String(line || "").trim());
  } catch {
    return null;
  }
}

function eventText(event) {
  const content = event?.message?.content ?? event?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (typeof block?.text === "string") return block.text;
    if (typeof block?.content === "string") return block.content;
    return "";
  }).filter(Boolean).join("\n");
}

/** Native Claude Code represents Bash `run_in_background` as a tool result with
 * a backgroundTaskId and later emits a task-notification for that id. A result
 * event between those two records ends only the model turn, not the task. */
export function claudeBackgroundTaskUpdate(event) {
  const started = new Set();
  const finished = new Set();
  const direct = event?.toolUseResult?.backgroundTaskId
    || event?.tool_use_result?.backgroundTaskId
    || event?.tool_use_result?.background_task_id;
  if (direct) started.add(String(direct));
  const text = eventText(event);
  const startMatch = text.match(/background with ID:\s*([a-zA-Z0-9_-]+)/i);
  if (startMatch) started.add(startMatch[1]);
  for (const match of text.matchAll(/<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|stopped|cancelled)<\/status>[\s\S]*?<\/task-notification>/gi)) {
    finished.add(String(match[1]).trim());
  }
  return { started: [...started], finished: [...finished] };
}

export function claudePendingBackgroundTasksFromTranscript(sessionPath) {
  const pending = new Set();
  let text = "";
  try { text = fs.readFileSync(sessionPath, "utf8"); } catch { return pending; }
  for (const line of text.split("\n")) {
    const event = parseStreamLine(line);
    if (!event) continue;
    const update = claudeBackgroundTaskUpdate(event);
    for (const id of update.started) pending.add(id);
    for (const id of update.finished) pending.delete(id);
  }
  return pending;
}

function userMessage(sessionId, text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: String(text || "") },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

function workerArgs({ sessionId, title, model, effort, permissionMode, resume = false, relayMcpConfig = "" }) {
  return [
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--effort", effort,
    "--model", model,
    "--name", title,
    ...permissionArgs(permissionMode),
    "--include-partial-messages",
    "--replay-user-messages",
    "--setting-sources=user,project,local",
    ...(relayMcpConfig ? ["--mcp-config", relayMcpConfig] : []),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
}

async function launchWorker({
  sessionId,
  cwd,
  title,
  prompt,
  model,
  effort,
  permissionMode,
  resume = false,
  command,
  spawn,
  adopt,
  homedir,
  initTimeoutMs = 20_000,
  displayPrompt = "",
}) {
  const runtime = command || supportedClaudeCliBinary();
  const relayMcpConfig = relayTaskMcpConfig(homedir);
  const env = {
    ...process.env,
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: "true",
    CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: "false",
    MCP_CONNECTION_NONBLOCKING: "true",
    NODE_USE_SYSTEM_CA: "1",
  };
  const child = spawn(runtime, workerArgs({ sessionId, title, model, effort, permissionMode, resume, relayMcpConfig }), {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child || !child.stdin || !child.stdout) {
    throw new Error("Claude Code did not create its streaming worker.");
  }

  const sessionPath = transcriptPathFor(cwd, sessionId, homedir);
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveMaterialized;
  const materialized = new Promise((resolve) => { resolveMaterialized = resolve; });
  const state = {
    child,
    sessionId,
    sessionPath,
    cwd,
    title,
    model,
    effort,
    permissionMode,
    stderr: "",
    settled: false,
    pendingBackgroundTasks: new Set(),
    closed: false,
    closedPromise: closed,
    materializing: false,
    materialized: false,
    materialization: null,
    materializedPromise: materialized,
    turnStartedAt: new Date().toISOString(),
    userText: String(displayPrompt || ""),
    partialAssistantText: "",
    lastStreamAt: null,
    nativeEvents: [],
    nativeEventOffset: 0,
    nativeListeners: new Set(),
  };
  liveWorkers.set(sessionId, state);

  let stdoutBuffer = "";
  let sawInit = false;
  let sawResult = false;
  let resolveInit;
  let rejectInit;
  const initialized = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
  const timer = setTimeout(() => {
    if (!sawInit) {
      // A timed-out worker must not stay registered and later collide with a
      // Retry. Close its input and terminate it; the close handler owns final
      // cleanup. This is the old "Claude Code crashed" zombie path.
      try { child.stdin?.end?.(); } catch {}
      try { child.kill?.("SIGTERM"); } catch {}
      rejectInit(new Error("Claude Code did not initialize its native session."));
    }
  }, initTimeoutMs);
  // launchWorker is actively awaiting this deadline. Unref'ing it lets Node
  // exit (and cancel the pending test/request) when the child is a silent
  // worker with no other referenced handles — exactly the initialization
  // failure this timer is responsible for resolving.

  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on?.("data", (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-16_000); });
  child.stdout.setEncoding?.("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk || "");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseStreamLine(line);
      if (!event) continue;
      state.lastStreamAt = new Date().toISOString();
      const nativeEvent = recordNativeEvent(state, event);
      if (event.type === "stream_event") {
        const stream = event.event || {};
        if (stream.type === "message_start") state.partialAssistantText = "";
        if (stream.type === "content_block_start" && stream.content_block?.type === "text") {
          state.partialAssistantText += String(stream.content_block.text || "");
        }
        if (stream.type === "content_block_delta" && stream.delta?.type === "text_delta") {
          state.partialAssistantText += String(stream.delta.text || "");
        }
      }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const text = event.message.content
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text || ""))
          .join("\n");
        if (text) state.partialAssistantText = text;
      }
      if (!sawInit && (event.type === "system" || event.session_id || event.sessionId)) {
        sawInit = true;
        clearTimeout(timer);
        resolveInit(event);
      }
      const background = claudeBackgroundTaskUpdate(event);
      for (const id of background.started) state.pendingBackgroundTasks.add(id);
      for (const id of background.finished) state.pendingBackgroundTasks.delete(id);
      if (event.type === "result") {
        sawResult = true;
        // Native task notifications are persisted as queue-operation records
        // but are not always replayed on stream-json stdout. Rebuild from the
        // canonical transcript before deciding whether this result is final.
        // The canonical transcript is authoritative once it exists. During
        // the first few streamed records it may not have been flushed yet;
        // never replace already-observed stdout state with an empty read of a
        // file that does not exist.
        if (fs.existsSync(sessionPath)) {
          state.pendingBackgroundTasks = claudePendingBackgroundTasksFromTranscript(sessionPath);
        }
        state.settled = state.pendingBackgroundTasks.size === 0;
        // A result closes one model turn, not a native background task. Keep
        // the streaming worker (and therefore its child process supervisor)
        // alive until Claude receives the terminal task-notification and
        // produces the real final turn. Closing here is what truncated the
        // 1..15 proof at 12 and leaked a `status=stopped` notification.
        if (state.settled) setTimeout(() => child.stdin?.end?.(), 50).unref?.();
      }
      notifyNativeWorker(state, nativeEvent);
    }
  });
  child.once("error", (error) => {
    clearTimeout(timer);
    const nativeEvent = recordNativeEvent(state, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: error?.message || String(error),
    });
    notifyNativeWorker(state, nativeEvent);
    if (!sawInit) rejectInit(error);
  });
  child.once("close", async (code) => {
    clearTimeout(timer);
    state.closed = true;
    const nativeEvent = recordNativeEvent(state, { type: "worker-state", state: "closed", code });
    notifyNativeWorker(state, nativeEvent);
    resolveClosed({ code });
    if (!sawInit && code !== 0) {
      rejectInit(new Error(`Claude Code launch failed: ${state.stderr.trim() || `exit ${code}`}`));
      resolveMaterialized({ attempted: false, reason: "launch-failed", code });
      if (liveWorkers.get(sessionId) === state) liveWorkers.delete(sessionId);
      return;
    }
    if (!sawResult || code !== 0) {
      resolveMaterialized({ attempted: false, reason: !sawResult ? "no-result" : "worker-failed", code });
      if (liveWorkers.get(sessionId) === state) liveWorkers.delete(sessionId);
      return;
    }
    state.materializing = true;
    try {
      // Materialize only after Relay's external streaming worker has exited.
      // Importing here fires claude://resume and silently starts a competing
      // Desktop worker. The UI performs that import only on an explicit Open.
      state.materialization = await adopt({
        sessionId,
        title,
        cwd,
        model,
        effort,
        sessionPath,
        importIntoDesktop: false,
      });
      state.materialized = state.materialization?.attempted === true;
      resolveMaterialized(state.materialization);
    } catch (error) {
      state.materialization = { attempted: false, reason: "materialization-failed", error: error?.message || String(error) };
      resolveMaterialized(state.materialization);
    } finally {
      state.materializing = false;
      if (liveWorkers.get(sessionId) === state) liveWorkers.delete(sessionId);
    }
  });

  child.stdin.write(`${userMessage(sessionId, prompt)}\n`);
  await initialized;
  return state;
}

export async function createClaudeDesktopCodeSession({
  cwd,
  title,
  content,
  model = "claude-opus-5",
  effort = "high",
  permissionMode = "auto",
  command = "",
  spawn = spawnChild,
  adopt = adoptClaudeSessionIntoDesktop,
  homedir = os.homedir(),
  sessionId = crypto.randomUUID(),
  initTimeoutMs,
} = {}) {
  const resolvedCwd = path.resolve(String(cwd || homedir));
  const resolvedTitle = String(title || "Relay Task");
  // `--name` already gives the native session its title. Repeating that title
  // inside the provider prompt manufactures a user message the human never
  // sent and makes prompt-sanitizing renderers leak it into the conversation.
  const prompt = String(content || "");
  const worker = await launchWorker({
    sessionId,
    cwd: resolvedCwd,
    title: resolvedTitle,
    prompt,
    model,
    effort,
    permissionMode,
    command,
    spawn,
    adopt,
    homedir,
    initTimeoutMs,
    displayPrompt: String(content || ""),
  });
  return {
    sessionId,
    desktopSessionId: `local_${sessionId}`,
    sessionPath: worker.sessionPath,
    cwd: resolvedCwd,
    title: resolvedTitle,
    model,
    effort,
    permissionMode,
  };
}

async function waitForRetiringWorker(worker, timeoutMs = 5_000) {
  if (!worker) return;
  if (worker.closed) {
    await waitForWorkerMaterialization(worker, timeoutMs);
    return;
  }
  let timeout;
  const expired = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const closed = await Promise.race([worker.closedPromise.then(() => true), expired]);
  clearTimeout(timeout);
  if (closed) {
    await waitForWorkerMaterialization(worker, timeoutMs);
    return;
  }
  try { worker.child?.stdin?.end?.(); } catch {}
  try { worker.child?.kill?.("SIGTERM"); } catch {}
  throw new Error("Claude Code's previous turn did not close cleanly. Try the follow-up again.");
}

async function waitForWorkerMaterialization(worker, timeoutMs = 30_000) {
  if (!worker?.materializedPromise) return null;
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Claude Code session materialization timed out.")), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([worker.materializedPromise, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

async function continueClaudeDesktopCodeSessionOnce({
  sessionId,
  cwd,
  title = "Relay Task",
  content,
  model = "claude-opus-5",
  effort = "high",
  permissionMode = "auto",
  command = "",
  spawn = spawnChild,
  adopt = adoptClaudeSessionIntoDesktop,
  homedir = os.homedir(),
  initTimeoutMs,
} = {}) {
  if (!sessionId) throw new Error("Claude session id is required.");
  const existing = liveWorkers.get(String(sessionId));
  if (existing && !existing.settled && !existing.closed && existing.child?.stdin?.writable && !existing.child.stdin.writableEnded && !existing.child.stdin.destroyed) {
    existing.child.stdin.write(`${userMessage(String(sessionId), content)}\n`);
    existing.settled = false;
    return { sessionId: String(sessionId), resumed: false, live: true };
  }
  // The result event arrives just before stdin is closed. A fast Steer used to
  // write into that retiring worker during the 50ms window, after which its
  // scheduled end swallowed the message or made Desktop mark the session as
  // crashed. Wait for a settled worker to exit before starting --resume.
  if (existing) await waitForRetiringWorker(existing);
  const resolvedCwd = path.resolve(String(cwd || homedir));
  const worker = await launchWorker({
    sessionId: String(sessionId),
    cwd: resolvedCwd,
    title: String(title || "Relay Task"),
    prompt: String(content || ""),
    model,
    effort,
    permissionMode,
    resume: true,
    command,
    spawn,
    adopt,
    homedir,
    initTimeoutMs,
    displayPrompt: String(content || ""),
  });
  return { sessionId: String(sessionId), resumed: true, live: true, sessionPath: worker.sessionPath };
}

export async function continueClaudeDesktopCodeSession(options = {}) {
  const key = String(options.sessionId || "");
  if (!key) throw new Error("Claude session id is required.");
  // One native transcript may have only one writer. Double-clicks and two
  // quick Steers are serialized onto the same provider session instead of
  // spawning competing --resume processes.
  const previous = continuationChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => continueClaudeDesktopCodeSessionOnce(options));
  continuationChains.set(key, current);
  try {
    return await current;
  } finally {
    if (continuationChains.get(key) === current) continuationChains.delete(key);
  }
}

export function claudeDesktopCodeWorker(sessionId) {
  return liveWorkers.get(String(sessionId || "")) || null;
}

// The pill polls this projection while the native worker is alive. It exposes
// conversation text and timing, never process handles, credentials or private
// provider events.
export function claudeDesktopCodeWorkerSnapshot(sessionId) {
  const worker = claudeDesktopCodeWorker(sessionId);
  if (!worker || worker.closed) return null;
  return {
    sessionId: worker.sessionId,
    startedAt: worker.turnStartedAt,
    userText: worker.userText,
    assistantText: worker.partialAssistantText,
    updatedAt: worker.lastStreamAt,
    settled: Boolean(worker.settled),
  };
}

// Provider-native Work consumes the exact stream-json rows rather than the
// legacy text projection above. The clone prevents renderer-facing code from
// retaining mutable worker state or process handles.
export function claudeDesktopCodeNativeSnapshot(sessionId) {
  const worker = claudeDesktopCodeWorker(sessionId);
  if (!worker) return null;
  return {
    sessionId: worker.sessionId,
    transcriptPath: worker.sessionPath,
    ownerAlive: !worker.closed,
    expectedActive: !worker.settled,
    settled: Boolean(worker.settled),
    events: worker.nativeEvents.map((event) => structuredClone(event)),
  };
}

export function subscribeClaudeDesktopCodeWorker(sessionId, listener) {
  const worker = claudeDesktopCodeWorker(sessionId);
  if (!worker || typeof listener !== "function") return () => {};
  worker.nativeListeners.add(listener);
  return () => worker.nativeListeners.delete(listener);
}

export async function waitForClaudeDesktopCodeMaterialization(sessionId, { timeoutMs = 30_000 } = {}) {
  const worker = liveWorkers.get(String(sessionId || ""));
  if (!worker) return null;
  if (!worker.closed) {
    throw new Error("Claude Code is still working. Open becomes available after this run settles.");
  }
  return waitForWorkerMaterialization(worker, timeoutMs);
}
