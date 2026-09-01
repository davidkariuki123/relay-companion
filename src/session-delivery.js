import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withCodexAppServer } from "./codex-app-server.js";
import {
  codexRolloutHasClientMessage,
  notifyCodexDesktopThreads,
  submitTurnToCodexDesktopThread,
} from "./codex-desktop.js";
import { waitForCodexIdle, waitForRolloutGrowth, rolloutSize } from "./codex-inject.js";
import { storeDir } from "./host-paths.js";
import { discoverSessions } from "./session-directory.js";
import { sendClaudeSocket, spawnBackgroundClaude, waitForClaudeCompletion } from "./session-controller.js";
import { withJsonLockStrict } from "./state-lock.cjs";

const DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const EXPLICIT_PICKER_DELIVERY = "explicit_picker";
const NEW_SESSION_TARGET = "__relay_new_session__";
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
    `A Relay was selected for this task: ${String(relayId || "").trim()}.`,
    "Use relay_inbox_list to fetch that exact Relay, then handle it in this task.",
  ].join(" ");
}

export function relaySessionBinding(relayId) {
  const binding = readState()?.packets?.[relayId]?.sessionBinding;
  return binding?.nativeId ? binding : null;
}

export function bindRelaySession(relayId, target, delivery = {}, { claimId = "" } = {}) {
  if (!relayId || !target?.provider || !target?.nativeId) {
    throw new Error("A Relay id and exact native session are required");
  }
  const locked = withJsonLockStrict(statePath(), () => {
    const state = readState();
    state.packets ||= {};
    const row = state.packets[relayId] || { id: relayId };
    if (claimId && row.sessionDelivery?.claimId !== claimId) {
      if (sameDeliveryTarget(row.sessionBinding, target)) return row.sessionBinding;
      const error = new Error("The picker delivery claim changed before it could be bound");
      error.code = "SESSION_DELIVERY_CLAIM_CHANGED";
      throw error;
    }
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
    const next = { ...row, sessionBinding: binding, updatedAt: new Date().toISOString() };
    delete next.sessionDelivery;
    state.packets[relayId] = next;
    writeState(state);
    return binding;
  });
  if (!locked.ok) {
    const error = new Error("Relay could not lock its delivery state");
    error.code = "SESSION_DELIVERY_LOCK_UNAVAILABLE";
    throw error;
  }
  return locked.value;
}

function sameDeliveryTarget(delivery, target) {
  return delivery?.provider === target?.provider && delivery?.nativeId === target?.nativeId;
}

function processIsAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function materializedNativeSession(row, provider) {
  if (provider === "codex") {
    const nativeId = String(row?.codexThreadId || "").trim();
    return nativeId ? {
      provider: "codex",
      nativeId,
      title: row?.displayTitle || row?.title || "Relay",
      cwd: row?.openCwd || "",
      url: `codex://threads/${encodeURIComponent(nativeId)}`,
      openedInHost: false,
      skipExternalOpen: false,
    } : null;
  }
  const native = row?.claudeNativeSession;
  const nativeId = String(native?.sessionId || "").trim();
  if (!nativeId) return null;
  return {
    provider: "claude",
    nativeId,
    title: row?.displayTitle || row?.title || "Relay",
    cwd: row?.openCwd || native?.cwd || "",
    url: native?.deepLink || native?.desktopImport?.deepLink || `claude://resume?session=${encodeURIComponent(nativeId)}`,
    openedInHost: false,
    skipExternalOpen: false,
    claudeFreshlyForged: false,
  };
}

function claimRelaySessionDelivery(relayId, target, prompt) {
  const locked = withJsonLockStrict(statePath(), () => {
    const state = readState();
    state.packets ||= {};
    const row = state.packets[relayId] || { id: relayId };
    if (row.sessionBinding?.nativeId) return { kind: "bound", binding: row.sessionBinding };
    if (row.sessionDelivery) {
      if (!sameDeliveryTarget(row.sessionDelivery, target)) {
        const error = new Error("This Relay already has a picker delivery in progress for another session");
        error.code = "SESSION_DELIVERY_PENDING";
        throw error;
      }
      // A claim is safe to take over only while it is durably marked as
      // waiting: no provider submission can have started yet. Once dispatching,
      // a dead owner is ambiguous and must be reconciled rather than replayed.
      if (row.sessionDelivery.status !== "waiting" || processIsAlive(row.sessionDelivery.ownerPid)) {
        return { kind: "existing", claim: row.sessionDelivery };
      }
    }
    const now = new Date().toISOString();
    const previousMaterialization = target.nativeId === NEW_SESSION_TARGET
      ? materializedNativeSession(row, target.provider)
      : null;
    const claim = {
      claimId: randomUUID(),
      mode: target.nativeId === NEW_SESSION_TARGET ? "new_session" : EXPLICIT_PICKER_DELIVERY,
      status: "waiting",
      ownerPid: process.pid,
      provider: target.provider,
      nativeId: target.nativeId,
      prompt,
      clientUserMessageId: target.provider === "codex" ? randomUUID() : null,
      requestId: target.provider === "codex" ? randomUUID() : null,
      previousNativeId: previousMaterialization?.nativeId || null,
      claimedAt: now,
      updatedAt: now,
    };
    state.packets[relayId] = { ...row, sessionDelivery: claim, updatedAt: now };
    writeState(state);
    return { kind: "claimed", claim };
  });
  if (!locked.ok) {
    const error = new Error("Relay could not lock its delivery state");
    error.code = "SESSION_DELIVERY_LOCK_UNAVAILABLE";
    throw error;
  }
  return locked.value;
}

function updateRelaySessionDelivery(relayId, claimId, update) {
  const locked = withJsonLockStrict(statePath(), () => {
    const state = readState();
    const row = state?.packets?.[relayId];
    if (!row?.sessionDelivery || row.sessionDelivery.claimId !== claimId) return false;
    if (update === null) delete row.sessionDelivery;
    else row.sessionDelivery = { ...row.sessionDelivery, ...update, updatedAt: new Date().toISOString() };
    row.updatedAt = new Date().toISOString();
    writeState(state);
    return true;
  });
  if (!locked.ok) {
    const error = new Error("Relay could not lock its delivery state");
    error.code = "SESSION_DELIVERY_LOCK_UNAVAILABLE";
    throw error;
  }
  return locked.value;
}

function existingDeliveryError(delivery = {}) {
  const status = delivery?.status || "waiting";
  const uncertain = status === "uncertain" || (status === "dispatching" && !processIsAlive(delivery?.ownerPid));
  const host = delivery?.provider === "claude" ? "Claude Code" : "Codex";
  const error = new Error(uncertain
    ? `This picker selection may already have reached ${host}, but Relay has not confirmed it`
    : "This picker selection is already being delivered");
  error.code = uncertain ? "SESSION_DELIVERY_UNCERTAIN" : "SESSION_DELIVERY_PENDING";
  return error;
}

export function claimRelayNewSession(relayId, provider) {
  if (!relayId) throw new Error("Relay id is required");
  const cleanProvider = provider === "codex" ? "codex" : "claude";
  const claimed = claimRelaySessionDelivery(
    relayId,
    { provider: cleanProvider, nativeId: NEW_SESSION_TARGET },
    "",
  );
  if (claimed.kind !== "existing") return claimed;
  const row = readState()?.packets?.[relayId];
  const recovered = materializedNativeSession(row, cleanProvider);
  if (recovered?.nativeId && recovered.nativeId !== claimed.claim.previousNativeId) {
    return { kind: "recovered", claim: claimed.claim, opened: recovered };
  }
  throw existingDeliveryError(claimed.claim);
}

export function markRelaySessionDispatching(relayId, claimId) {
  return updateRelaySessionDelivery(relayId, claimId, { status: "dispatching", ownerPid: process.pid });
}

export function markRelaySessionUncertain(relayId, claimId, errorCode = "SESSION_DELIVERY_FAILED") {
  return updateRelaySessionDelivery(relayId, claimId, { status: "uncertain", errorCode });
}

export function releaseRelaySessionClaim(relayId, claimId) {
  return updateRelaySessionDelivery(relayId, claimId, null);
}

export function completeRelayNewSession(relayId, opened, claimId) {
  if (!opened?.provider || !opened?.nativeId) throw new Error("A materialized native session is required");
  return bindRelaySession(relayId, opened, {
    adapter: `${opened.provider}_new_session_materialization`,
  }, { claimId });
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
  if (!idle.idle) {
    const error = new Error("Codex task did not become idle");
    error.code = "SESSION_TARGET_BUSY";
    throw error;
  }
  const submit = options.submitCodex || submitTurnToCodexDesktopThread;
  const owner = await submit({
    threadId: target.nativeId,
    text: prompt,
    cwd: target.cwd || process.cwd(),
    rolloutPath: sessionPath,
    clientUserMessageId: options.clientUserMessageId,
    requestId: options.requestId,
  });
  if (owner?.ran === true || (owner?.submitted && owner?.ran !== false)) {
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
  // thread's writer. Fail closed; the durable picker claim can reconcile a
  // late acknowledgement, but it will not duplicate the Relay or trigger
  // Codex's active-writer guard.
  if (owner?.submitted || owner?.deliveryAmbiguous) {
    const error = new Error(owner?.submitted
      ? "Codex Desktop accepted the delivery request but the Relay turn was not verified"
      : "Relay could not confirm whether Codex Desktop accepted the delivery request");
    error.code = "CODEX_DELIVERY_UNCONFIRMED";
    error.deliveryAmbiguous = Boolean(owner?.deliveryAmbiguous && !owner?.submitted);
    throw error;
  }
  if (owner?.reason === "turn-in-progress") {
    const error = new Error("Codex task is busy");
    error.code = "SESSION_TARGET_BUSY";
    throw error;
  }
  return deliverCodexWithAppServer(target, prompt, options);
}

export function publicSessionDeliveryError(error, provider = "") {
  const message = String(error?.message || error || "");
  const cleanProvider = provider === "claude" ? "Claude Code" : "Codex";
  if (error?.code === "CODEX_DELIVERY_UNCONFIRMED") {
    if (error?.deliveryAmbiguous) {
      return "Relay could not confirm whether Codex accepted this Relay. It will not resend automatically, to avoid a duplicate.";
    }
    return "Codex accepted this Relay but has not confirmed it yet. Relay will not resend it automatically, to avoid a duplicate.";
  }
  if (error?.code === "SESSION_DELIVERY_PENDING") {
    return "Relay is already delivering that selection. It will not send a second copy.";
  }
  if (error?.code === "SESSION_DELIVERY_UNCERTAIN") {
    return "That selection was already submitted but is not confirmed yet. Relay will not resend it automatically, to avoid a duplicate.";
  }
  if (/already has an active writer/i.test(message)) {
    return "Codex still owns that task. Relay did not open another writer or resend the Relay.";
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
  deliveryMode = "",
  prompt: suppliedPrompt = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...options
} = {}) {
  if (!relayId) throw new Error("Relay id is required");
  if (!target?.provider || !target?.nativeId) throw new Error("An exact native destination is required");
  if (deliveryMode !== EXPLICIT_PICKER_DELIVERY) {
    const error = new Error("Visible session delivery is reserved for an explicit picker selection");
    error.code = "SESSION_DELIVERY_MODE_REQUIRED";
    throw error;
  }
  const existing = relaySessionBinding(relayId);
  if (existing) {
    if (existing.provider !== target.provider || existing.nativeId !== target.nativeId) {
      throw new Error(`This Relay is already bound to ${existing.title || existing.nativeId}`);
    }
    return { continued: true, binding: existing, ...(await focusSession(existing, options)) };
  }
  const prompt = String(suppliedPrompt || "").trim() || relayReferencePrompt(relayId);
  const claimed = claimRelaySessionDelivery(relayId, target, prompt);
  if (claimed.kind === "bound") {
    const binding = claimed.binding;
    if (binding.provider !== target.provider || binding.nativeId !== target.nativeId) {
      throw new Error(`This Relay is already bound to ${binding.title || binding.nativeId}`);
    }
    return { continued: true, binding, ...(await focusSession(binding, options)) };
  }
  if (claimed.kind === "existing") {
    const exact = findExactSession(target, options.discover || discoverSessions);
    const sessionPath = String(exact?.nativeRef?.sessionPath || "");
    const hasClientMessage = options.hasCodexClientMessage || codexRolloutHasClientMessage;
    if (exact?.provider === "codex"
      && sessionPath
      && claimed.claim.clientUserMessageId
      && hasClientMessage(sessionPath, claimed.claim.clientUserMessageId)) {
      const delivery = {
        provider: "codex",
        nativeId: exact.nativeId,
        adapter: "codex_desktop_owner_recovered",
        userMessageId: claimed.claim.clientUserMessageId,
      };
      const binding = bindRelaySession(relayId, exact, delivery, { claimId: claimed.claim.claimId });
      return { recovered: true, delivery, binding, ...(await focusSession(binding, options)) };
    }
    throw existingDeliveryError(claimed.claim);
  }

  const claim = claimed.claim;
  let exact;
  try {
    exact = await waitForSessionIdle(target, { timeoutMs, ...options });
  } catch (error) {
    updateRelaySessionDelivery(relayId, claim.claimId, null);
    throw error;
  }
  if (!markRelaySessionDispatching(relayId, claim.claimId)) {
    const error = new Error("The picker delivery claim changed before provider submission");
    error.code = "SESSION_DELIVERY_CLAIM_CHANGED";
    throw error;
  }

  let delivery;
  try {
    delivery = exact.provider === "codex"
      ? await deliverCodex(exact, prompt, {
        timeoutMs,
        ...options,
        clientUserMessageId: claim.clientUserMessageId,
        requestId: claim.requestId,
      })
      : await deliverClaude(exact, prompt, { timeoutMs, ...options });
  } catch (error) {
    if (error?.code === "SESSION_TARGET_BUSY") {
      updateRelaySessionDelivery(relayId, claim.claimId, null);
    } else {
      updateRelaySessionDelivery(relayId, claim.claimId, {
        status: "uncertain",
        errorCode: error?.code || "SESSION_DELIVERY_FAILED",
      });
      if (error?.code !== "CODEX_DELIVERY_UNCONFIRMED") {
        const uncertain = error instanceof Error ? error : new Error(String(error || "Session delivery failed"));
        uncertain.code = "SESSION_DELIVERY_UNCERTAIN";
        throw uncertain;
      }
    }
    throw error;
  }
  const binding = bindRelaySession(relayId, exact, delivery, { claimId: claim.claimId });
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
