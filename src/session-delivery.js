import fs from "node:fs";
import path from "node:path";
import { withCodexAppServer } from "./codex-app-server.js";
import { notifyCodexDesktopThreads, submitTurnToCodexDesktopThread } from "./codex-desktop.js";
import { waitForCodexIdle, waitForRolloutGrowth, rolloutSize } from "./codex-inject.js";
import { storeDir } from "./host-paths.js";
import { discoverSessions } from "./session-directory.js";
import { sendClaudeSocket, spawnBackgroundClaude, waitForClaudeCompletion } from "./session-controller.js";
import { withJsonLock } from "./state-lock.cjs";

const DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statePath() {
  return path.join(storeDir(), "state.json");
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")) || {}; }
  catch { return {}; }
}

function writeState(state) {
  const filePath = statePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function publicSession(session) {
  return {
    provider: session.provider,
    nativeId: session.nativeId,
    title: session.title,
    cwd: session.cwd,
    projectName: session.projectName,
    state: session.state,
    lastActiveAt: session.lastActiveAt,
  };
}

export function relayReferencePrompt(relayId) {
  return [
    `A Relay has arrived: ${String(relayId || "").trim()}.`,
    "Use relay_inbox_list to fetch that exact Relay, then handle it in this task.",
  ].join(" ");
}

export function relaySessionBinding(relayId) {
  const binding = readState()?.packets?.[relayId]?.sessionBinding;
  return binding?.nativeId ? binding : null;
}

export function bindRelaySession(relayId, target, delivery = {}) {
  if (!relayId || !target?.provider || !target?.nativeId) {
    throw new Error("A Relay id and exact native session are required");
  }
  return withJsonLock(statePath(), () => {
    const state = readState();
    state.packets ||= {};
    const row = state.packets[relayId] || { id: relayId };
    const binding = {
      provider: target.provider,
      nativeId: target.nativeId,
      title: target.title || "",
      cwd: target.cwd || "",
      boundAt: new Date().toISOString(),
      delivery: {
        adapter: delivery.adapter || null,
        nativeTurnId: delivery.turnId || delivery.userMessageId || null,
        verifiedAt: new Date().toISOString(),
      },
    };
    state.packets[relayId] = { ...row, sessionBinding: binding, updatedAt: new Date().toISOString() };
    writeState(state);
    return binding;
  });
}

export function listRelayDestinations(provider, {
  limit = 5,
  currentNativeId = "",
  discover = discoverSessions,
} = {}) {
  const cleanProvider = provider === "codex" ? "codex" : "claude";
  const rows = discover()
    .filter((session) => session.provider === cleanProvider && session.capabilities?.send !== false)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  const current = rows.find((session) => session.nativeId === currentNativeId) || null;
  const candidates = rows.filter((session) => session.nativeId !== current?.nativeId);
  const working = candidates.filter((session) => ["active", "needs_input"].includes(session.state));
  const inactive = candidates.filter((session) => !["active", "needs_input"].includes(session.state));
  // A working task is a safer and more useful destination than an idle task
  // whose only advantage is a newer timestamp. Reserve the fixed picker rows
  // for live work first, then fill the remaining slots with the freshest idle
  // tasks. Each group already retains native recency order from `rows`.
  const recent = [...working, ...inactive].slice(0, limit);
  return {
    provider: cleanProvider,
    current: current ? publicSession(current) : null,
    recent: recent.map(publicSession),
  };
}

function findExactSession(target, discover = discoverSessions) {
  return discover().find(
    (session) => session.provider === target.provider && session.nativeId === target.nativeId,
  ) || null;
}

export async function waitForSessionIdle(target, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 1_000,
  discover = discoverSessions,
  onState = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exact = findExactSession(target, discover);
    if (!exact) throw new Error(`Native ${target.provider} session ${target.nativeId} no longer exists`);
    onState(exact.state);
    if (!["active", "needs_input"].includes(exact.state)) return exact;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${target.provider} session ${target.nativeId} to become idle`);
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function appendedText(filePath, offset) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return "";
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(filePath, "r");
    try { fs.readSync(handle, buffer, 0, length, offset); }
    finally { fs.closeSync(handle); }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

async function waitForPrompt(filePath, offset, prompt, { timeoutMs = 15_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appendedText(filePath, offset).includes(prompt)) return true;
    await sleep(pollMs);
  }
  return appendedText(filePath, offset).includes(prompt);
}

async function deliverCodexWithAppServer(target, prompt, {
  appServer = withCodexAppServer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sessionPath = String(target.nativeRef?.sessionPath || "");
  if (!sessionPath) throw new Error("Codex rollout path is unavailable");
  const baseline = rolloutSize(sessionPath);
  return appServer(async (client) => {
    const resumed = await client.request("thread/resume", {
      threadId: target.nativeId,
      cwd: target.cwd || process.cwd(),
      excludeTurns: false,
    });
    if (resumed?.thread?.id && resumed.thread.id !== target.nativeId) {
      throw new Error("Codex resumed a different native task");
    }
    const started = await client.request("turn/start", {
      threadId: target.nativeId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    const turnId = started?.turn?.id || "";
    const growth = await waitForRolloutGrowth(sessionPath, baseline, { timeoutMs: 15_000, pollMs: 250 });
    if (!growth.grew || !appendedText(sessionPath, baseline).includes(prompt)) {
      throw new Error("Codex accepted the request without appending the Relay turn to the selected task");
    }
    if (turnId) {
      await client.waitForNotification(
        (message) => message?.method === "turn/completed" && message?.params?.turn?.id === turnId,
        { timeoutMs },
      );
    }
    return { provider: "codex", nativeId: target.nativeId, adapter: "codex_app_server_resume", turnId };
  }, { cwd: target.cwd || process.cwd() });
}

async function deliverCodex(target, prompt, options = {}) {
  const sessionPath = String(target.nativeRef?.sessionPath || "");
  if (!sessionPath) throw new Error("Codex rollout path is unavailable");
  const idle = await (options.waitForCodexIdle || waitForCodexIdle)(sessionPath, {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    pollMs: options.pollMs || 1_000,
  });
  if (!idle.idle) throw new Error("Codex task did not become idle");
  const submit = options.submitCodex || submitTurnToCodexDesktopThread;
  const owner = await submit({
    threadId: target.nativeId,
    text: prompt,
    cwd: target.cwd || process.cwd(),
    rolloutPath: sessionPath,
  });
  if (owner?.submitted && owner?.ran !== false) {
    return {
      provider: "codex",
      nativeId: target.nativeId,
      adapter: "codex_desktop_owner",
      userMessageId: owner.clientUserMessageId || null,
    };
  }
  // A bridge acknowledgement followed by an unconfirmed rollout is
  // ambiguous: Desktop may already have accepted the turn. Starting a second
  // App Server here is never a safe fallback because Desktop remains the
  // thread's writer. Fail closed and let the user retry through the same owner;
  // do not duplicate the Relay or trigger Codex's active-writer guard.
  if (owner?.submitted) {
    const error = new Error("Codex Desktop accepted the delivery request but the Relay turn was not verified");
    error.code = "CODEX_DELIVERY_UNCONFIRMED";
    throw error;
  }
  if (owner?.reason === "turn-in-progress") throw new Error("Codex task is busy");
  return deliverCodexWithAppServer(target, prompt, options);
}

export function publicSessionDeliveryError(error, provider = "") {
  const message = String(error?.message || error || "");
  const cleanProvider = provider === "claude" ? "Claude Code" : "Codex";
  if (error?.code === "CODEX_DELIVERY_UNCONFIRMED") {
    return "Codex did not confirm the Relay in that task. Relay did not open another task; please try again.";
  }
  if (/already has an active writer/i.test(message)) {
    return "Codex still owns that task. Relay did not open another task; please try again.";
  }
  if (/turn-in-progress|task is busy|did not become idle|timed out waiting/i.test(message)) {
    return `${cleanProvider} is still working in that session. Try again when the current turn finishes.`;
  }
  return `Relay could not deliver to that ${cleanProvider} session. Please try again.`;
}

async function deliverClaude(target, prompt, options = {}) {
  const transcriptPath = String(target.nativeRef?.transcriptPath || "");
  if (!transcriptPath) throw new Error("Claude transcript path is unavailable");
  let offset = 0;
  try { offset = fs.statSync(transcriptPath).size; } catch {}
  const socketPath = String(target.nativeRef?.messagingSocketPath || "");
  let adapter;
  if (socketPath && fs.existsSync(socketPath)) {
    await (options.sendClaude || sendClaudeSocket)(socketPath, prompt, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 30_000));
    adapter = "claude_inbox_socket";
  } else {
    let baselineMtime = 0;
    try { baselineMtime = fs.statSync(transcriptPath).mtimeMs; } catch {}
    const launched = (options.spawnClaude || spawnBackgroundClaude)({
      sessionId: target.nativeId,
      title: target.title || "Relay Claude session",
      cwd: target.cwd || process.cwd(),
      prompt,
      resume: true,
    });
    if (launched.sessionId !== target.nativeId) throw new Error("Claude resumed a different native session");
    adapter = "claude_background_resume";
    await (options.waitForClaudeCompletion || waitForClaudeCompletion)(target.nativeId, {
      baselineMtime,
      transcriptPath,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      pollMs: options.pollMs || 1_000,
    });
  }
  if (!(await waitForPrompt(transcriptPath, offset, prompt, { timeoutMs: 15_000, pollMs: 250 }))) {
    throw new Error("Claude accepted the request without appending the Relay turn to the selected session");
  }
  return { provider: "claude", nativeId: target.nativeId, adapter };
}

export async function deliverRelayToSession({
  relayId,
  target,
  prompt: suppliedPrompt = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...options
} = {}) {
  if (!relayId) throw new Error("Relay id is required");
  if (!target?.provider || !target?.nativeId) throw new Error("An exact native destination is required");
  const existing = relaySessionBinding(relayId);
  if (existing) {
    if (existing.provider !== target.provider || existing.nativeId !== target.nativeId) {
      throw new Error(`This Relay is already bound to ${existing.title || existing.nativeId}`);
    }
    return { continued: true, binding: existing, ...(await focusSession(existing, options)) };
  }
  const exact = await waitForSessionIdle(target, { timeoutMs, ...options });
  const prompt = String(suppliedPrompt || "").trim() || relayReferencePrompt(relayId);
  const delivery = exact.provider === "codex"
    ? await deliverCodex(exact, prompt, { timeoutMs, ...options })
    : await deliverClaude(exact, prompt, { timeoutMs, ...options });
  const binding = bindRelaySession(relayId, exact, delivery);
  return { delivered: true, delivery, binding, ...(await focusSession(binding, options)) };
}

export async function focusSession(target, { notifyCodex = notifyCodexDesktopThreads } = {}) {
  if (!target?.provider || !target?.nativeId) throw new Error("An exact native destination is required");
  if (target.provider === "codex") {
    const result = await notifyCodex({
      threadIds: [target.nativeId],
      openThreadId: target.nativeId,
      primeOpen: false,
    });
    return {
      openedInHost: Boolean(result?.ok),
      skipExternalOpen: Boolean(result?.ok),
      url: `codex://threads/${encodeURIComponent(target.nativeId)}`,
    };
  }
  return {
    openedInHost: false,
    skipExternalOpen: false,
    url: `claude://resume?session=${encodeURIComponent(target.nativeId)}`,
  };
}
