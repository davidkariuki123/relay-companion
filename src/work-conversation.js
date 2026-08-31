/**
 * Canonical, provider-neutral Work conversation state.
 *
 * Codex app-server notifications are deliberately reduced here before the
 * renderer sees them.  A persisted log can be replayed, tailed with overlap,
 * or hydrate a half-finished turn without manufacturing duplicate messages.
 */

const VERSION = 1;
const MAX_SEEN_EVENT_KEYS = 4096;
const UTF8 = new TextEncoder();
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled"]);
const EXPLORATION = new Set(["read", "search", "list"]);
const HEADER_ITEMS = new Set([
  "plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall",
  "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch",
  "imageView", "imageGeneration", "claudeToolUse",
]);
const BINARY_PAYLOAD_KEY = /^(?:contentBase64|base64|data|dataUrl|data_url|image_url|imageUrl|file_data|fileData|bytes|blob)$/i;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function text(value) {
  return String(value == null ? "" : value);
}

function compact(value, max = 96) {
  const oneLine = text(value).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const head = oneLine.slice(0, Math.max(1, max - 1));
  const word = head.replace(/\s+\S*$/, "").trim();
  return `${word || head.trimEnd()}…`;
}

function safeActivityOutput(value) {
  return text(value)
    .replace(/\bauthorization\s*([:=])\s*[^\r\n]*/gi, "Authorization$1[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|authorization|cookie|api[-_]?key|credential)[\w.-]*)\s*([:=])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
    .slice(-64 * 1_024);
}

function redactStructured(value, key = "", seen = new WeakSet(), depth = 0) {
  if (/token|secret|password|authorization|cookie|api[-_]?key|credential/i.test(key)) return "[redacted]";
  if (typeof value === "string") return safeActivityOutput(value);
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((entry) => redactStructured(entry, key, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 500).map(([childKey, entry]) => [childKey, redactStructured(entry, childKey, seen, depth + 1)]));
}

function utf8Bytes(value) {
  return UTF8.encode(text(value)).byteLength;
}

function boundedPersistenceValue(value, budget, key = "", stack = new WeakSet(), depth = 0) {
  if (budget.remaining <= 0 || depth > 12) return null;
  // Provider items may carry inline images/files. Persistence keeps the
  // separately projected attachment metadata, never embedded bytes or data
  // URLs. This runs before cloning so a large payload cannot evade the
  // aggregate budget or briefly double memory use.
  const isFiniteByteCount = /^bytes$/i.test(key) && typeof value === "number" && Number.isFinite(value);
  const isSafeRemoteImage = /^(?:image_url|imageUrl)$/i.test(key)
    && typeof value === "string"
    && /^https:\/\//i.test(value.trim());
  if (BINARY_PAYLOAD_KEY.test(key) && !isFiniteByteCount && !isSafeRemoteImage) {
    const omitted = "[omitted binary payload]";
    budget.remaining -= Math.min(budget.remaining, utf8Bytes(JSON.stringify(omitted)));
    return omitted;
  }
  if (/token|secret|password|authorization|cookie|api[-_]?key|credential/i.test(key)) {
    const redacted = "[redacted]";
    budget.remaining -= Math.min(budget.remaining, utf8Bytes(JSON.stringify(redacted)));
    return redacted;
  }
  if (typeof value === "string") {
    const safe = safeActivityOutput(value);
    const allowance = Math.max(0, Math.min(budget.remaining - 2, budget.maxStringBytes ?? Infinity));
    let result = safe;
    if (utf8Bytes(result) > allowance) {
      result = result.slice(0, Math.min(result.length, allowance));
      while (result && utf8Bytes(result) > allowance) result = result.slice(0, Math.floor(result.length * 0.8));
    }
    budget.remaining -= Math.min(budget.remaining, utf8Bytes(JSON.stringify(result)));
    return result;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    budget.remaining -= Math.min(budget.remaining, utf8Bytes(JSON.stringify(value)));
    return value;
  }
  if (typeof value !== "object") return null;
  // Presentation deliberately aliases a unit through `units`, `users`, and
  // `final`. Detect only real recursive cycles, not repeated references.
  if (stack.has(value)) return "[circular]";
  stack.add(value);
  if (Array.isArray(value)) {
    const result = [];
    budget.remaining -= Math.min(budget.remaining, 2);
    for (const entry of value.slice(0, 1_000)) {
      if (budget.remaining <= 8) break;
      budget.remaining -= 1;
      result.push(boundedPersistenceValue(entry, budget, key, stack, depth + 1));
    }
    stack.delete(value);
    return result;
  }
  const result = {};
  budget.remaining -= Math.min(budget.remaining, 2);
  for (const [childKey, entry] of Object.entries(value).slice(0, 500)) {
    const keyCost = utf8Bytes(JSON.stringify(childKey)) + 2;
    if (budget.remaining <= keyCost + 4) break;
    budget.remaining -= keyCost;
    result[childKey] = boundedPersistenceValue(entry, budget, childKey, stack, depth + 1);
  }
  stack.delete(value);
  return result;
}

function safeUserAttachments(raw) {
  const direct = Array.isArray(raw?.attachments) ? raw.attachments : [];
  const blocks = Array.isArray(raw?.content)
    ? raw.content.filter((part) => /image|file|attachment/i.test(text(part?.type)))
    : [];
  return [...direct, ...blocks].slice(0, 20).map((entry, index) => {
    const source = entry && typeof entry === "object" ? entry : {};
    const candidatePath = text(source.localPath || source.path || source.filePath).trim();
    const candidateUrl = text(source.url || source.image_url || source.file_url).trim();
    const remoteUrl = /^https:\/\//i.test(candidateUrl) ? candidateUrl : "";
    const name = compact(source.name || source.fileName || source.filename
      || (candidatePath ? candidatePath.split(/[\\/]/).at(-1) : "")
      || (/image/i.test(text(source.type)) ? "Image" : `Attachment ${index + 1}`), 160);
    return {
      id: compact(source.id || source.attachmentId || `${text(raw?.id)}:${index}`, 160),
      kind: compact(source.kind || source.type || (/^image\//i.test(text(source.mimeType || source.contentType)) ? "image" : "file"), 64),
      name,
      mimeType: compact(source.mimeType || source.contentType || source.mediaType || "", 160) || null,
      size: Number.isFinite(Number(source.size ?? source.bytes)) ? Math.max(0, Number(source.size ?? source.bytes)) : null,
      // Local paths are references only; bytes/data URLs and arbitrary schemes
      // never enter the model or IPC projection. Main resolves allowed previews.
      path: candidatePath ? safeActivityOutput(candidatePath) : null,
      url: remoteUrl ? safeActivityOutput(remoteUrl) : null,
    };
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  let result = 2166136261;
  const source = text(value);
  for (let index = 0; index < source.length; index += 1) {
    result ^= source.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function eventKey(event) {
  const explicit = event?.eventId ?? event?.seq ?? event?.sequence ?? event?.logOffset;
  if (explicit != null) return `event:${explicit}`;
  const params = event?.params || {};
  const identity = [
    event?.method,
    params.turnId || params.turn?.id,
    params.itemId || params.item?.id,
    params.requestId || event?.id,
    event?.emittedAtMs,
    params.item?.status,
    hash(params.delta ?? params.textDelta ?? params.outputDelta ?? params.item?.text ?? stable(params.item || {})),
  ];
  return `native:${identity.map((part) => text(part)).join(":")}`;
}

function atMs(event, ...candidates) {
  for (const candidate of [...candidates, event?.emittedAtMs]) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function turnIdOf(event) {
  const params = event?.params || {};
  return text(params.turnId || params.turn?.id || params.item?.turnId || event?.turnId).trim();
}

function itemIdOf(event) {
  const params = event?.params || {};
  return text(params.itemId || params.item?.id || event?.itemId).trim();
}

function makeTurn(id, startedAtMs = null) {
  return {
    id,
    // Only a provider-authored turn/started establishes a Work turn. Session
    // materialization and historical terminal rows must never manufacture one.
    nativeStarted: false,
    status: "inProgress",
    startedAtMs,
    completedAtMs: null,
    durationMs: null,
    workStartedAtMs: null,
    finalStartedAtMs: null,
    error: null,
    itemOrder: [],
    items: {},
    pendingDeltas: {},
    deltaWatermarks: {},
    requestOrder: [],
    requests: {},
    optimistic: null,
    retryText: [],
    sleepObserved: false,
    hasActivityHeader: false,
    providerState: null,
    providerLabel: null,
    composerAvailable: true,
    requiresAction: false,
  };
}

export function createWorkConversation({ provider = "codex", sessionId = "" } = {}) {
  return {
    version: VERSION,
    provider: text(provider) || "codex",
    sessionId: text(sessionId),
    turnOrder: [],
    turns: {},
    pendingOptimisticTurnIds: [],
    seenEventKeys: [],
  };
}

function ensureTurn(state, id, startedAtMs = null) {
  const turnId = id || `turn:${state.turnOrder.length + 1}`;
  if (!state.turns[turnId]) {
    state.turns[turnId] = makeTurn(turnId, startedAtMs);
    state.turnOrder.push(turnId);
  } else if (state.turns[turnId].startedAtMs == null && startedAtMs != null) {
    state.turns[turnId].startedAtMs = startedAtMs;
  }
  return state.turns[turnId];
}

function appendItem(turn, item) {
  if (!turn.items[item.id] && !turn.itemOrder.includes(item.id)) turn.itemOrder.push(item.id);
  turn.items[item.id] = { ...(turn.items[item.id] || {}), ...item };
  return turn.items[item.id];
}

function rekeyTurn(state, oldId, nextId) {
  if (!oldId || !nextId || oldId === nextId || !state.turns[oldId]) return state.turns[nextId] || null;
  const optimistic = state.turns[oldId];
  const existing = state.turns[nextId];
  if (existing) {
    for (const itemId of optimistic.itemOrder) appendItem(existing, optimistic.items[itemId]);
    existing.optimistic = optimistic.optimistic || existing.optimistic;
    delete state.turns[oldId];
    state.turnOrder = state.turnOrder.filter((id) => id !== oldId);
    return existing;
  }
  delete state.turns[oldId];
  optimistic.id = nextId;
  state.turns[nextId] = optimistic;
  state.turnOrder = state.turnOrder.map((id) => id === oldId ? nextId : id);
  return optimistic;
}

/** Add the immediately visible right-side user bubble before transport starts. */
export function addOptimisticUser(inputState, {
  text: body,
  clientId,
  turnId = "",
  mode = "initial",
  atMs: timestamp = Date.now(),
} = {}) {
  const state = clone(inputState || createWorkConversation());
  const id = text(clientId || `local-${timestamp}`).trim();
  const requestedTurn = text(turnId).trim();
  const syntheticTurnId = requestedTurn || `optimistic:${id}`;
  const turn = ensureTurn(state, syntheticTurnId, timestamp);
  const itemId = `optimistic-user:${id}`;
  appendItem(turn, {
    id: itemId,
    type: "userMessage",
    role: "user",
    text: text(body),
    status: "pending",
    optimistic: true,
    optimisticMode: mode === "steer" ? "steer" : "initial",
    clientId: id,
    startedAtMs: timestamp,
    completedAtMs: null,
  });
  if (!requestedTurn) {
    turn.optimistic = { clientId: id, state: "pending", itemId };
    if (!state.pendingOptimisticTurnIds.includes(syntheticTurnId)) state.pendingOptimisticTurnIds.push(syntheticTurnId);
  }
  return state;
}

function bindOptimisticTurn(state, realTurnId, timestamp) {
  const candidateId = state.pendingOptimisticTurnIds.find((id) => state.turns[id]?.optimistic?.state === "pending");
  if (!candidateId) return ensureTurn(state, realTurnId, timestamp);
  const turn = rekeyTurn(state, candidateId, realTurnId);
  turn.startedAtMs = turn.startedAtMs ?? timestamp;
  turn.status = "inProgress";
  turn.optimistic.state = "accepted";
  const optimisticItem = turn.items[turn.optimistic.itemId];
  if (optimisticItem?.status === "pending") optimisticItem.status = "accepted";
  state.pendingOptimisticTurnIds = state.pendingOptimisticTurnIds.filter((id) => id !== candidateId);
  return turn;
}

/** Mark a transport-accepted initial/Steer bubble without waiting for an echo. */
export function acceptOptimisticUser(inputState, { clientId = "", turnId = "" } = {}) {
  const state = inputState || createWorkConversation();
  const wantedClient = text(clientId);
  const turns = turnId ? [state.turns[text(turnId)]] : state.turnOrder.map((id) => state.turns[id]);
  for (const turn of turns) {
    if (!turn) continue;
    const item = turn.itemOrder.map((id) => turn.items[id]).find((entry) => entry?.optimistic
      && (!wantedClient || entry.clientId === wantedClient));
    if (item && item.status === "pending") item.status = "accepted";
  }
  return state;
}

function deltaBucket(turn, itemId) {
  if (!turn.pendingDeltas[itemId]) {
    turn.pendingDeltas[itemId] = { text: "", summary: "", output: "", patch: "" };
  }
  return turn.pendingDeltas[itemId];
}

function deltaChannel(method) {
  const lower = text(method).toLowerCase();
  if (lower.includes("reasoning") && lower.includes("summary")) return "summary";
  if (lower.includes("reasoning")) return "raw";
  if (lower.includes("commandexecution")) return "output";
  if (lower.includes("filechange")) return "patch";
  return "text";
}

function applyDelta(turn, event) {
  const id = itemIdOf(event);
  if (!id) return;
  if (turn.items[id]?.status === "completed") return;
  const params = event.params || {};
  const value = text(params.delta ?? params.textDelta ?? params.outputDelta ?? params.patchDelta ?? params.text ?? "");
  if (!value) return;
  const channel = deltaChannel(event.method);
  if (channel === "raw") return; // private chain-of-thought never enters Relay's model
  const timestamp = atMs(event);
  const watermarkKey = `${id}:${channel}`;
  const nativeKey = eventKey(event);
  const watermark = turn.deltaWatermarks[watermarkKey];
  if (timestamp != null && watermark) {
    if (timestamp < watermark.at || (timestamp === watermark.at && watermark.keys.includes(nativeKey))) return;
  }
  if (timestamp != null) {
    turn.deltaWatermarks[watermarkKey] = timestamp === watermark?.at
      ? { at: timestamp, keys: [...watermark.keys, nativeKey].slice(-32) }
      : { at: timestamp, keys: [nativeKey] };
  }
  const bucket = deltaBucket(turn, id);
  const max = channel === "output" || channel === "patch" ? 64 * 1_024 : 256 * 1_024;
  bucket[channel] = (bucket[channel] + value).slice(-max);
  const existing = turn.items[id];
  if (existing) existing[channel] = (text(existing[channel]) + value).slice(-max);
}

function contentText(value) {
  if (typeof value === "string" || typeof value === "number") return text(value);
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (typeof value.input_text === "string") return value.input_text;
  if (typeof value.output_text === "string") return value.output_text;
  return "";
}

function itemText(item) {
  return contentText(item?.text ?? item?.content ?? item?.message?.text ?? item?.message ?? "");
}

/**
 * Provider transports put the human's optional note and Relay's private run
 * contract in one native user item. Only the note belongs in the visible
 * conversation. Keep this boundary in the canonical reducer so Codex, Claude,
 * Cowork, history hydration, and optimistic reconciliation cannot disagree.
 */
export function visibleWorkUserText(value) {
  const raw = text(value);
  if (/^\s*<task-notification\b/i.test(raw)) return "";
  const legacyBody = raw.match(/<relay-body>\s*([\s\S]*?)\s*<\/relay-body>/i);
  if (legacyBody) return text(legacyBody[1]).trim();
  return raw
    .replace(/<relay-envelope>[\s\S]*?<\/relay-envelope>/gi, "")
    .replace(/<relay-documents>[\s\S]*?<\/relay-documents>/gi, "")
    .replace(/<relay-runtime-contract>[\s\S]*?<\/relay-runtime-contract>/gi, "")
    .replace(/^\s*Begin the task as briefed\.\s*/i, "")
    .trim();
}

function rendererSafeRaw(raw) {
  const safe = redactStructured(raw || {});
  if (safe.type === "reasoning") {
    delete safe.rawContent;
    delete safe.content;
    delete safe.encryptedContent;
    delete safe.raw;
  }
  return safe;
}

function reasoningSummary(item) {
  if (typeof item?.summary === "string") return item.summary;
  if (Array.isArray(item?.summary)) return item.summary.map((part) => text(part?.text ?? part)).join("");
  return text(item?.summaryText || "");
}

function normalizeItem(raw, lifecycle, timestamp, pending = {}) {
  const type = text(raw?.type || "unknown");
  const item = {
    id: text(raw?.id),
    type,
    status: lifecycle === "completed" ? text(raw?.status || "completed") : text(raw?.status || "inProgress"),
    startedAtMs: lifecycle === "started" ? timestamp : null,
    completedAtMs: lifecycle === "completed" ? timestamp : null,
    raw: rendererSafeRaw(raw),
  };
  if (type === "userMessage" || type === "hookPrompt") {
    item.role = "user";
    item.text = visibleWorkUserText(itemText(raw) || pending.text);
  } else if (type === "agentMessage") {
    item.role = "assistant";
    item.phase = raw.phase || null;
    item.text = itemText(raw) || pending.text;
  } else if (type === "plan") {
    item.text = itemText(raw) || pending.text;
  } else if (type === "reasoning") {
    item.summary = reasoningSummary(raw) || pending.summary;
  } else if (type === "commandExecution") {
    item.output = safeActivityOutput(text(raw.aggregatedOutput || raw.output) || pending.output);
  } else if (type === "fileChange") {
    item.output = safeActivityOutput(text(raw.output) || pending.patch);
  } else if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView"].includes(type)) {
    item.result = redactStructured(raw.result ?? raw.output ?? null);
  } else if (type === "imageGeneration") {
    item.artifact = redactStructured(raw.result || raw.image || raw.output || null);
    item.text = itemText(raw);
  } else if (type === "contextCompaction") {
    item.text = itemText(raw) || "Context compacted";
  } else if (["requestUserInput", "commandApproval", "fileChangeApproval", "mcpElicitation", "permissionRequest"].includes(type)) {
    item.text = itemText(raw) || text(raw.question || raw.prompt || raw.reason || "Input required");
    item.request = redactStructured(raw);
  } else if (["error", "retry"].includes(type)) {
    item.text = itemText(raw) || text(raw.error?.message || raw.message);
  }
  return item;
}

function optimisticMatch(turn, raw) {
  if (raw?.type !== "userMessage") return null;
  const body = visibleWorkUserText(itemText(raw));
  return turn.itemOrder
    .map((id) => turn.items[id])
    .find((item) => item?.optimistic && ["pending", "accepted"].includes(item.status) && item.text.trim() === body) || null;
}

function applyItem(turn, event, lifecycle) {
  const raw = event?.params?.item || {};
  const id = text(raw.id || itemIdOf(event)).trim();
  if (!id) return;
  const timestamp = atMs(event, lifecycle === "started" ? event.params?.startedAtMs : event.params?.completedAtMs);
  const pending = turn.pendingDeltas[id] || {};
  const normalized = normalizeItem({ ...raw, id }, lifecycle, timestamp, pending);
  const optimistic = optimisticMatch(turn, raw);
  if (optimistic) {
    const index = turn.itemOrder.indexOf(optimistic.id);
    delete turn.items[optimistic.id];
    turn.itemOrder[index] = id;
    normalized.optimistic = false;
    normalized.clientId = optimistic.clientId;
    normalized.startedAtMs = optimistic.startedAtMs;
  }
  const previous = turn.items[id];
  if (previous) {
    normalized.startedAtMs = previous.startedAtMs ?? normalized.startedAtMs;
    if (lifecycle === "started") {
      normalized.completedAtMs = previous.completedAtMs;
      normalized.status = previous.status === "completed" ? "completed" : normalized.status;
    }
  }
  appendItem(turn, normalized);
  if (lifecycle === "completed") delete turn.pendingDeltas[id];
  if (normalized.type === "sleep") turn.sleepObserved = true;
  if (!["userMessage", "hookPrompt"].includes(normalized.type) && turn.workStartedAtMs == null) {
    turn.workStartedAtMs = timestamp;
  }
  if (HEADER_ITEMS.has(normalized.type)) turn.hasActivityHeader = true;
  if (normalized.type === "agentMessage" && normalized.phase === "final_answer" && turn.finalStartedAtMs == null) {
    turn.finalStartedAtMs = timestamp;
  }
}

function requestIdOf(event) {
  return text(event?.params?.requestId || event?.id || event?.requestId).trim();
}

function isRequestMethod(method) {
  return /requestApproval|requestUserInput|elicitation|permissions\/request/i.test(text(method));
}

function applyRequest(turn, event) {
  const id = requestIdOf(event);
  if (!id) return;
  if (!turn.requests[id]) turn.requestOrder.push(id);
  const request = {
    id,
    method: text(event.method),
    status: "pending",
    params: redactStructured(event.params || {}),
    startedAtMs: atMs(event),
    completedAtMs: null,
  };
  turn.requests[id] = request;
  appendItem(turn, {
    id: `request:${id}`,
    type: "request",
    role: "system",
    text: text(event.params?.question || event.params?.prompt || event.params?.reason || "Input required"),
    requestId: id,
    request: redactStructured(request.params),
    status: "pending",
    startedAtMs: request.startedAtMs,
    completedAtMs: null,
  });
}

function resolveRequest(state, event) {
  const id = requestIdOf(event) || text(event?.params?.id).trim();
  if (!id) return;
  const resultStatus = text(event?.params?.result?.status).toLowerCase();
  const status = resultStatus === "cancelled" || resultStatus === "canceled" ? "cancelled" : "resolved";
  for (const turnId of state.turnOrder) {
    const request = state.turns[turnId]?.requests[id];
    if (!request) continue;
    request.status = status;
    request.completedAtMs = atMs(event);
    request.result = redactStructured(event?.params?.result);
    const item = state.turns[turnId]?.items[`request:${id}`];
    if (item) {
      item.status = status;
      item.completedAtMs = request.completedAtMs;
      item.result = redactStructured(event?.params?.result);
    }
  }
}

function applyError(turn, event) {
  const error = event?.params?.error || event?.params || {};
  const message = safeActivityOutput(error.message || event?.params?.message || "Something went wrong").trim();
  const willRetry = Boolean(event?.params?.willRetry ?? error.willRetry);
  const id = `system:${willRetry ? "retry" : "error"}:${hash(eventKey(event))}`;
  appendItem(turn, {
    id,
    type: willRetry ? "retry" : "error",
    role: "system",
    text: message,
    willRetry,
    status: "completed",
    startedAtMs: atMs(event),
    completedAtMs: atMs(event),
  });
  if (!willRetry) turn.error = redactStructured(error);
}

function restoreUnacceptedOptimistic(turn) {
  for (const id of turn.itemOrder) {
    const item = turn.items[id];
    if (!item?.optimistic || item.status !== "pending" || item.optimisticMode !== "steer") continue;
    if (item.text && !turn.retryText.includes(item.text)) turn.retryText.push(item.text);
    item.status = "rejected";
  }
}

function completeTurn(turn, event) {
  const params = event.params || {};
  const rawTurn = params.turn || {};
  const status = text(rawTurn.status || params.status || "completed") || "completed";
  const completedAt = atMs(event, rawTurn.completedAtMs, params.completedAtMs);
  turn.status = status;
  turn.completedAtMs = completedAt;
  const suppliedDuration = Number(rawTurn.durationMs ?? params.durationMs);
  turn.durationMs = Number.isFinite(suppliedDuration) && suppliedDuration >= 0
    ? suppliedDuration
    : turn.startedAtMs != null && completedAt != null ? Math.max(0, completedAt - turn.startedAtMs) : null;
  turn.error = redactStructured(rawTurn.error || params.error || turn.error);
  if (["interrupted", "failed", "cancelled"].includes(status)) restoreUnacceptedOptimistic(turn);
  for (const [itemId, pending] of Object.entries(turn.pendingDeltas)) {
    const item = turn.items[itemId];
    if (!item) continue; // a late authoritative item still needs this buffer
    for (const channel of ["text", "summary", "output", "patch"]) {
      if (pending[channel] && !item[channel]) item[channel] = pending[channel];
    }
    delete turn.pendingDeltas[itemId];
  }
}

function pruneExpiredPendingDeltas(state, nowMs) {
  if (nowMs == null) return;
  for (const id of state.turnOrder) {
    const turn = state.turns[id];
    if (!TERMINAL.has(turn?.status) || turn.completedAtMs == null || nowMs - turn.completedAtMs < 60_000) continue;
    turn.pendingDeltas = {};
    turn.deltaWatermarks = {};
  }
}

/** Incremental reducer for one raw Codex app-server event. */
export function reduceWorkEvent(inputState, event) {
  // Intentionally mutates a single conversation accumulator. A native session
  // can contain tens of thousands of deltas; cloning the full replay state on
  // every token makes tailing quadratic. Callers that need snapshots clone at
  // their own boundary (conversationView already returns detached data).
  const state = inputState || createWorkConversation();
  if (!event || typeof event !== "object") return state;
  pruneExpiredPendingDeltas(state, atMs(event));
  const key = eventKey(event);
  if (state.seenEventKeys.includes(key)) return state;
  state.seenEventKeys.push(key);
  if (state.seenEventKeys.length > MAX_SEEN_EVENT_KEYS) {
    state.seenEventKeys.splice(0, state.seenEventKeys.length - MAX_SEEN_EVENT_KEYS);
  }
  const method = text(event.method);
  if (method === "serverRequest/resolved") {
    resolveRequest(state, event);
    return state;
  }
  // App-server logs contain many conversation-adjacent notifications (MCP
  // startup, account rate limits, thread status, skill changes, and so on)
  // that do not belong to a provider turn.  Never allocate a synthetic turn
  // merely because one of those protocol notifications was observed.  An
  // empty `turn:unknown` otherwise remains inProgress forever and restart
  // recovery can falsely report a completed historical run as disconnected.
  const isTurnEvent = method === "turn/started"
    || method === "provider/state"
    || method === "turn/completed"
    || method === "item/started"
    || method === "item/completed"
    || /\/delta$/i.test(method)
    || /Delta$/.test(method)
    || method === "error"
    || method.endsWith("/error")
    || method === "relay/connectionClosed"
    || isRequestMethod(method);
  if (!isTurnEvent) return state;
  const id = turnIdOf(event) || state.turnOrder.at(-1) || "turn:unknown";
  const timestamp = atMs(event, event?.params?.startedAtMs);
  if (method === "turn/started") {
    const turn = bindOptimisticTurn(state, id, timestamp);
    if (TERMINAL.has(turn.status)) return state; // overlapping historical tail
    turn.status = "inProgress";
    turn.nativeStarted = true;
    turn.startedAtMs = turn.startedAtMs ?? timestamp;
    turn.completedAtMs = null;
    turn.error = null;
    return state;
  }
  // Exact provider rows can be observed out of order during hydration, but a
  // row without its native start is not evidence that Relay started Work.
  // Ignore it; authoritative hydration/reconnect will replay the bounded turn
  // from turn/started. An optimistic user turn may exist, but it likewise does
  // not become provider Work until the native start binds it above.
  const turn = state.turns[id] || null;
  if (!turn?.nativeStarted) return state;
  if (method === "provider/state") {
    turn.providerState = compact(event?.params?.nativeState || "", 64) || null;
    turn.providerLabel = compact(event?.params?.nativeLabel || "", 96) || null;
    turn.composerAvailable = event?.params?.composerAvailable !== false;
    turn.requiresAction = Boolean(event?.params?.requiresAction);
  }
  else if (method === "turn/completed") completeTurn(turn, event);
  else if (method === "item/started") applyItem(turn, event, "started");
  else if (method === "item/completed") applyItem(turn, event, "completed");
  else if (/\/delta$/i.test(method) || /Delta$/.test(method)) applyDelta(turn, event);
  else if (method === "error" || method.endsWith("/error") || method === "relay/connectionClosed") {
    applyError(turn, event);
    if (method === "relay/connectionClosed") {
      turn.status = "failed";
      turn.completedAtMs = timestamp;
      restoreUnacceptedOptimistic(turn);
    }
  }
  else if (isRequestMethod(method)) applyRequest(turn, event);
  return state;
}

export function replayWorkEvents(events, initialState = createWorkConversation()) {
  return (events || []).reduce((state, event) => reduceWorkEvent(state, event), initialState);
}

/** Bounded reducer snapshot for persistence/resume (not a renderer payload). */
export function snapshotWorkConversation(inputState, { maxTurns = 20, maxItemsPerTurn = 1_000, maxBytes = 2 * 1_024 * 1_024 } = {}) {
  const source = inputState || createWorkConversation();
  const turnOrder = source.turnOrder.slice(-Math.max(1, maxTurns));
  const candidate = {
    version: source.version,
    provider: source.provider,
    sessionId: source.sessionId,
    createdAtMs: source.createdAtMs,
    updatedAtMs: source.updatedAtMs,
    turnOrder,
    // Traverse newest first under pressure, then restore chronological
    // turnOrder below. A small persistence budget must retain the turn the
    // user is currently looking at, never an obsolete oldest turn.
    turns: Object.fromEntries([...turnOrder].reverse().map((id) => {
      const original = source.turns[id];
      const itemOrder = original.itemOrder.slice(-Math.max(1, maxItemsPerTurn));
      const requestOrder = original.requestOrder.slice(-100);
      const turn = {
        ...original,
        itemOrder,
        items: Object.fromEntries(itemOrder.map((itemId) => [itemId, original.items[itemId]]).filter(([, item]) => item)),
        requestOrder,
        requests: Object.fromEntries(requestOrder.map((requestId) => [requestId, original.requests[requestId]]).filter(([, request]) => request)),
      };
      turn.pendingDeltas = Object.fromEntries(Object.entries(original.pendingDeltas || {})
      .slice(-Math.max(1, maxItemsPerTurn))
      .map(([itemId, pending]) => [itemId, Object.fromEntries(Object.entries(pending || {}).map(([channel, value]) => [channel, safeActivityOutput(value)]))]));
      turn.deltaWatermarks = Object.fromEntries(Object.entries(original.deltaWatermarks || {}).slice(-Math.max(1, maxItemsPerTurn * 5)));
      return [id, turn];
    })),
    pendingOptimisticTurnIds: source.pendingOptimisticTurnIds.filter((id) => turnOrder.includes(id)),
    seenEventKeys: source.seenEventKeys.slice(-MAX_SEEN_EVENT_KEYS),
  };
  const ceiling = Math.max(16 * 1_024, Number(maxBytes) || 0);
  // Reserve space for JSON punctuation and structural keys. The sanitizer
  // traverses references directly, so an enormous raw payload is never cloned
  // before the aggregate persistence cap is applied.
  const state = boundedPersistenceValue(candidate, { remaining: Math.floor(ceiling * 0.8) });
  state.version = VERSION;
  state.turnOrder = Array.isArray(state.turnOrder) ? state.turnOrder.filter((id) => state.turns?.[id]) : [];
  state.pendingOptimisticTurnIds = Array.isArray(state.pendingOptimisticTurnIds)
    ? state.pendingOptimisticTurnIds.filter((id) => state.turns?.[id])
    : [];
  return state;
}

export function hydrateWorkConversation(snapshot) {
  const value = clone(snapshot || {});
  const state = createWorkConversation({ provider: value.provider, sessionId: value.sessionId });
  state.seenEventKeys = Array.isArray(value.seenEventKeys) ? value.seenEventKeys.slice(-MAX_SEEN_EVENT_KEYS) : [];
  state.turnOrder = Array.isArray(value.turnOrder) ? value.turnOrder.map(text).filter(Boolean) : [];
  state.turns = {};
  for (const id of state.turnOrder) {
    const saved = value.turns?.[id] || {};
    state.turns[id] = {
      ...makeTurn(id, saved.startedAtMs ?? null),
      ...saved,
      id,
      itemOrder: Array.isArray(saved.itemOrder) ? saved.itemOrder.map(text) : [],
      items: saved.items && typeof saved.items === "object" ? saved.items : {},
      pendingDeltas: saved.pendingDeltas && typeof saved.pendingDeltas === "object" ? saved.pendingDeltas : {},
      deltaWatermarks: saved.deltaWatermarks && typeof saved.deltaWatermarks === "object" ? saved.deltaWatermarks : {},
      requestOrder: Array.isArray(saved.requestOrder) ? saved.requestOrder.map(text) : [],
      requests: saved.requests && typeof saved.requests === "object" ? saved.requests : {},
      retryText: Array.isArray(saved.retryText) ? saved.retryText.map(text) : [],
    };
  }
  state.pendingOptimisticTurnIds = Array.isArray(value.pendingOptimisticTurnIds)
    ? value.pendingOptimisticTurnIds.map(text).filter((id) => state.turns[id]) : [];
  return state;
}

function pathLabel(value) {
  const full = text(value).trim().replace(/[\\/]+$/, "");
  return { full, label: full.split(/[\\/]/).filter(Boolean).at(-1) || full };
}

function humanTool(value) {
  return text(value).replace(/^mcp__.*?__/, "").replace(/[_-]+/g, " ").trim();
}

const TOOL_ACTS = {
  Read: ["read", "Reading", "Read", "file_path"],
  Write: ["edit", "Writing", "Wrote", "file_path"],
  Edit: ["edit", "Editing", "Edited", "file_path"],
  Glob: ["search", "Searching files for", "Searched files for", "pattern"],
  ListFiles: ["list", "Listing", "Listed", "path"],
  Grep: ["search", "Searching for", "Searched for", "pattern"],
  WebFetch: ["web", "Reading", "Read", "url"],
  WebSearch: ["web", "Searching the web for", "Searched the web for", "query"],
  shell: ["command", "Running", "Ran", "command"],
  Bash: ["command", "Running", "Ran", "description", "command"],
  apply_patch: ["edit", "Editing", "Edited", "path", "file_path"],
};

function commandActivity(item) {
  const raw = item.raw || item;
  const action = (Array.isArray(raw.commandActions) ? raw.commandActions : []).at(-1) || {};
  if (action.type === "read") return semantic("read", "Reading", "Read", action.path || action.name || "a file", true);
  if (action.type === "listFiles") return semantic("list", "Listing", "Listed", action.path || "files", true);
  if (action.type === "search") return semantic("search", "Searching for", "Searched for", action.query || action.pattern || "files");
  return semantic("command", "Running", "Ran", action.command || raw.command || "a command");
}

function semantic(kind, activeVerb, doneVerb, object, isPath = false) {
  const path = isPath ? pathLabel(object) : null;
  return {
    kind,
    activeVerb,
    doneVerb,
    object: compact(path ? path.label : object),
    fullObject: path?.full || text(object),
    objectType: isPath ? "file" : null,
  };
}

/** Convert any Codex tool item to stable, human-facing activity semantics. */
export function normalizeActivity(item) {
  if (!item || typeof item !== "object") return null;
  const raw = item.raw || item;
  if (["sleep", "enteredReviewMode", "exitedReviewMode"].includes(raw.type)) return null;
  if (raw.type === "claudeToolUse") {
    const tool = text(raw.tool || raw.name || "Tool");
    const args = raw.input && typeof raw.input === "object" ? raw.input : {};
    const status = item.status || raw.status;
    const base = { id: item.id || raw.id, status, tool, nativeProvider: "claude", groupKey: raw.activityGroup || null };
    if (tool === "Read") return { ...base, ...semantic("read", "Reading", "Read", args.file_path || args.path || "a file", true) };
    if (tool === "Grep") return { ...base, ...semantic("search", "Searching for", "Searched for", args.pattern || "files") };
    if (tool === "Glob") return { ...base, ...semantic("list", "Listing", "Listed", args.path || args.pattern || "files", Boolean(args.path)) };
    if (["Write", "Edit", "NotebookEdit"].includes(tool)) return { ...base, ...semantic("edit", tool === "Write" ? "Writing" : "Editing", tool === "Write" ? "Wrote" : "Edited", args.file_path || args.notebook_path || args.path || "a file", true) };
    if (tool === "Bash") return { ...base, ...semantic("command", "Running", "Ran", args.description || args.command || "a command") };
    if (tool === "Agent" || tool === "Task") return { ...base, ...semantic("subagent", "Delegating", "Delegated", args.description || args.prompt || args.subagent_type || "an agent") };
    if (tool === "WebSearch") return { ...base, ...semantic("web", "Searching the web for", "Searched the web for", args.query || "the web") };
    if (tool === "WebFetch") return { ...base, ...semantic("web", "Reading", "Read", args.url || "a web page") };
    return { ...base, ...semantic("call", "Using", "Used", humanTool(tool) || "a tool") };
  }
  if (raw.type === "commandExecution") return { id: item.id || raw.id, ...commandActivity(item), status: item.status || raw.status, groupKey:"codex:commands" };
  if (raw.type === "fileChange") {
    const changes = Array.isArray(raw.changes) ? raw.changes : [];
    const first = changes[0] || {};
    const path = first.path || first.filePath || raw.path || raw.filePath || "files";
    const kinds = new Set(changes.map((change) => text(change.kind || change.type).toLowerCase()));
    const done = kinds.size === 1 && kinds.has("add") ? "Created" : kinds.size === 1 && kinds.has("delete") ? "Deleted" : "Edited";
    return { id: item.id || raw.id, ...semantic("edit", done === "Created" ? "Creating" : done === "Deleted" ? "Deleting" : "Editing", done, path, true), status: item.status || raw.status, count: changes.length || 1 };
  }
  if (raw.type === "webSearch") return { id: item.id || raw.id, ...semantic("web", "Searching the web for", "Searched the web for", raw.query || raw.action?.query || "the web"), status: item.status || raw.status };
  if (raw.type === "imageView") return { id: item.id || raw.id, ...semantic("read", "Viewing", "Viewed", raw.path || "an image", true), status: item.status || raw.status };
  if (raw.type === "mcpToolCall" || raw.type === "dynamicToolCall") {
    const tool = text(raw.tool || raw.name).replace(/^mcp__.*?__/, "");
    if (!tool || tool === "load_workspace_dependencies") return null;
    const args = raw.arguments || raw.input || {};
    const presentation = raw.presentation || raw.toolPresentation || raw.metadata?.presentation || {};
    if (presentation.hidden === true) return null;
    // Codex's code-mode `js` host is an execution surface, not an unknown MCP
    // call. Preserve the provider-authored title when present and let adjacent
    // calls coalesce into one semantic "Ran commands" group. Rendering five
    // consecutive "Called js" rows loses both meaning and native hierarchy.
    if (tool === "js") {
      return {
        id:item.id || raw.id,
        ...semantic("command", "Running", "Ran", args.title || raw.title || "JavaScript"),
        status:item.status || raw.status,
        tool,
        groupKey:"codex:javascript",
      };
    }
    if (presentation.kind || presentation.activeVerb || presentation.doneVerb) {
      const object = presentation.object || presentation.label || raw.title || raw.displayName || humanTool(tool);
      return {
        id: item.id || raw.id,
        ...semantic(
          presentation.kind || "call",
          presentation.activeVerb || presentation.runningLabel || "Calling",
          presentation.doneVerb || presentation.completedLabel || "Called",
          object,
          presentation.objectType === "file",
        ),
        status: item.status || raw.status,
        tool,
        server: text(raw.server),
        groupKey: (presentation.kind || "call") === "command" ? "codex:commands" : null,
      };
    }
    const spec = TOOL_ACTS[tool];
    if (spec) {
      const [kind, activeVerb, doneVerb, ...sources] = spec;
      let object = "";
      for (const source of sources) {
        if (Object.hasOwn(args, source) && text(args[source]).trim()) { object = args[source]; break; }
        if (!Object.hasOwn(args, source) && !object) object = source;
      }
      return { id: item.id || raw.id, ...semantic(kind, activeVerb, doneVerb, object || humanTool(tool), ["file_path", "path"].some((key) => Object.hasOwn(args, key))), status: item.status || raw.status, tool, groupKey:kind === "command" ? "codex:commands" : null };
    }
    // When a server does not supply presentation metadata, infer only the
    // broad action encoded by the tool name. Arguments remain private; an
    // arbitrary argument must never become a misleading sentence object.
    const readable = humanTool(raw.title || raw.displayName || tool) || "a tool";
    const inferred = /(^| )(search|find|lookup)( |$)/i.test(readable)
      ? ["search", "Searching", "Searched"]
      : /(^| )(list|browse)( |$)/i.test(readable)
        ? ["list", "Listing", "Listed"]
        : /(^| )(read|fetch|get|inspect)( |$)/i.test(readable)
          ? ["read", "Reading", "Read"]
          : ["call", "Calling", "Called"];
    return {
      id: item.id || raw.id,
      ...semantic(inferred[0], inferred[1], inferred[2], readable),
      status: item.status || raw.status,
      tool,
      server: text(raw.server),
    };
  }
  if (raw.type === "collabAgentToolCall" || raw.type === "subAgentActivity") {
    const action = text(raw.tool || raw.action || raw.name);
    if (/^(wait|wait_agent)$/i.test(action)) return null;
    return { id: item.id || raw.id, ...semantic("subagent", "Delegating", "Delegated", humanTool(action) || "an agent"), status: item.status || raw.status };
  }
  return null;
}

export function summarizeActivities(activities) {
  const counts = new Map();
  for (const activity of activities || []) {
    if (!activity) continue;
    const kind = EXPLORATION.has(activity.kind) ? "exploration" : activity.kind || "call";
    counts.set(kind, (counts.get(kind) || 0) + (Number(activity.count) || 1));
  }
  const phrase = {
    edit: (n) => `edited ${n === 1 ? "a file" : "files"}`,
    exploration: () => "read files",
    web: () => "searched the web",
    command: (n) => `ran ${n === 1 ? "a command" : "commands"}`,
    subagent: (n) => `delegated to ${n === 1 ? "an agent" : "agents"}`,
    call: (n) => `called ${n === 1 ? "a tool" : "tools"}`,
  };
  const parts = [...counts].map(([kind, count]) => (phrase[kind] || phrase.call)(count));
  if (!parts.length) return "Worked";
  const joined = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return joined[0].toUpperCase() + joined.slice(1);
}

export function activeActivitySummary(activities) {
  const active = [...(activities || [])].reverse().find((activity) => activity?.status === "inProgress")
    || [...(activities || [])].reverse().find(Boolean);
  if (!active) return "Thinking";
  if (active.kind === "edit") return "Editing files";
  if (active.kind === "web") return active.fullObject ? `Searching the web for ${active.fullObject}` : "Searching the web";
  if (EXPLORATION.has(active.kind)) {
    const object = text(active.fullObject || active.object);
    if (active.kind === "read") return object ? `Reading ${object}` : "Reading files";
    if (active.kind === "search") return object ? `Searching for ${object}` : "Searching files";
    if (active.kind === "list") return object ? `Listing files in ${object}` : "Listing files";
  }
  if (active.kind === "command") return active.fullObject || active.object ? `Running ${active.fullObject || active.object}` : "Running command";
  return text(active.activeVerb) ? `${active.activeVerb}${active.object ? ` ${active.object}` : ""}` : "Thinking";
}

function retryLabel(value) {
  const match = text(value).match(/^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/i);
  return match ? `Reconnecting ${match[1]}/${match[2]}` : text(value);
}

/**
 * Renderer-ready units. Exploration/reasoning is grouped, retry rows are
 * coalesced, and provider plumbing never escapes into the conversation.
 */
export function turnUnits(turn) {
  const units = [];
  const decorate = (unit) => {
    const final = unit.type === "message" && unit.role === "assistant" && unit.phase === "final_answer";
    const user = unit.type === "message" && unit.role === "user";
    const commentary = unit.type === "message" && unit.role === "assistant" && !final;
    const blocking = unit.type === "request" && !["resolved", "cancelled"].includes(unit.status);
    const collapsible = commentary || ["activity", "activityGroup", "exploration", "plan", "retry", "compaction"].includes(unit.type);
    const placement = user ? "user"
      : final ? "final"
        : blocking ? "blocking"
          : collapsible ? "collapsible"
            : ["artifact"].includes(unit.type) ? "standalone" : "post";
    return {
      persistent: user || final || unit.type === "request" || unit.type === "error",
      blocking,
      standalone: ["error", "request", "artifact"].includes(unit.type),
      collapsible,
      placement,
      ...unit,
    };
  };
  const push = (unit) => {
    unit = decorate(unit);
    const previous = units.at(-1);
    if (unit.type === "retry" && previous?.type === "retry") {
      previous.text = retryLabel(unit.text);
      previous.count += 1;
      return;
    }
    if (unit.type === "exploration" && previous?.type === "exploration") {
      for (const incoming of unit.items) {
        const activity = incoming.activity;
        const duplicate = activity && previous.items.some((entry) => entry.activity
          && entry.activity.kind === activity.kind
          && entry.activity.fullObject === activity.fullObject
          && entry.activity.status !== "inProgress"
          && activity.status !== "inProgress");
        if (!duplicate) previous.items.push(incoming);
      }
      previous.summary = summarizeActivities(previous.items.filter((entry) => entry.type === "activity").map((entry) => entry.activity));
      return;
    }
    if (unit.type === "activity" && previous?.type === "activityGroup") {
      previous.items.push(unit);
      previous.active = previous.items.some((entry) => entry.activity?.status === "inProgress");
      previous.summary = previous.items.every((entry) => entry.activity?.nativeProvider === "claude")
        ? `Used ${previous.items.length} ${previous.items.length === 1 ? "tool" : "tools"}`
        : summarizeActivities(previous.items.map((entry) => entry.activity));
      previous.activeSummary = activeActivitySummary(previous.items.map((entry) => entry.activity));
      return;
    }
    if (unit.type === "activity" && previous?.type === "activity") {
      units[units.length - 1] = decorate({
        // A turn can contain several disjoint runs of the same provider tool
        // group (for example JS calls separated by commentary). The renderer
        // reconciles units by id, so the group key alone is not an identity:
        // reusing it leaves orphan DOM nodes on every live update/Steer.
        // Anchor the group to its first native item instead.
        id: `activity-group:${previous.id}`,
        type: "activityGroup",
        groupKey: unit.activity.groupKey || previous.activity?.groupKey || "contiguous",
        items: [previous, unit],
        active: [previous, unit].some((entry) => entry.activity?.status === "inProgress"),
        activeSummary: activeActivitySummary([previous.activity, unit.activity]),
        summary: previous.activity?.nativeProvider === "claude" && unit.activity?.nativeProvider === "claude"
          ? "Used 2 tools"
          : summarizeActivities([previous.activity, unit.activity]),
      });
      return;
    }
    if (unit.type === "activity" && unit.activity?.status === "inProgress") {
      units.push(decorate({
        id:`activity-group:${unit.id}`,
        type:"activityGroup",
        groupKey:unit.activity.groupKey || "active",
        items:[unit],
        active:true,
        activeSummary:activeActivitySummary([unit.activity]),
        summary:summarizeActivities([unit.activity]),
      }));
      return;
    }
    units.push(unit);
  };
  for (const id of turn?.itemOrder || []) {
    const item = turn.items[id];
    if (!item) continue;
    if (["userMessage", "hookPrompt"].includes(item.type)) push({
      id,
      type: "message",
      side: "right",
      role: "user",
      source: item.type,
      text: item.text,
      status: item.status,
      optimistic: Boolean(item.optimistic),
      attachments: safeUserAttachments(item.raw),
    });
    else if (item.type === "agentMessage") push({ id, type: "message", side: "left", role: "assistant", phase: item.phase, text: item.text, status: item.status, final: item.phase === "final_answer" });
    else if (item.type === "plan") push({ id, type: "plan", side: "left", text: item.text, status: item.status });
    else if (item.type === "reasoning") push({ id: `explore:${id}`, type: "exploration", items: [{ id, type: "reasoning", text: item.summary }], summary: "Explored" });
    else if (item.type === "retry") push({ id, type: "retry", text: retryLabel(item.text), count: 1 });
    else if (item.type === "error") push({ id, type: "error", text: item.text });
    else if (["requestUserInput", "commandApproval", "fileChangeApproval", "mcpElicitation", "permissionRequest"].includes(item.type)) {
      push({ id, type: "request", method: item.type, text: item.text, status: item.status, request: item.raw?.request || null });
    }
    else if (item.type === "request") {
      const request = turn.requests[item.requestId];
      push({ id, type: "request", method: request?.method || "request", text: item.text, status: item.status, request: request?.params?.request || null });
    }
    else if (item.type === "imageGeneration") push({ id, type: "artifact", text: item.text || "Generated an image", status: item.status });
    else if (item.type === "contextCompaction") push({ id, type: "compaction", text: item.text, status: item.status });
    else {
      const activity = normalizeActivity(item);
      if (!activity) continue;
      activity.groupKey = text(item.raw?.presentation?.groupKey || item.raw?.metadata?.activityGroup || activity.groupKey || "") || null;
      if (item.type === "fileChange") {
        activity.changes = (item.raw?.changes || []).slice(0, 200).map((change) => ({
          path: text(change?.path || change?.filePath),
          kind: text(change?.kind || change?.type),
        }));
      }
      const entry = { id, type: "activity", activity };
      if (EXPLORATION.has(activity.kind) && activity.nativeProvider !== "claude") push({ id: `explore:${id}`, type: "exploration", items: [entry], summary: summarizeActivities([activity]) });
      else push(entry);
    }
  }
  return units;
}

export function turnTiming(turn, nowMs = Date.now()) {
  const terminal = TERMINAL.has(turn?.status);
  const cancelled = ["interrupted", "cancelled"].includes(turn?.status);
  const validHeader = Boolean(turn?.hasActivityHeader);
  if (turn?.sleepObserved || !validHeader) {
    return {
      state: cancelled ? "cancelled" : terminal ? "settled" : "active",
      durationMs: null,
      precise: false,
      suppressed: turn?.sleepObserved ? "sleep" : "no-activity-header",
    };
  }
  const preciseStart = turn?.workStartedAtMs;
  const preciseEnd = turn?.finalStartedAtMs ?? turn?.completedAtMs ?? (terminal ? null : nowMs);
  const precise = preciseStart != null && preciseEnd != null ? Math.max(0, preciseEnd - preciseStart) : null;
  const fallback = precise ?? (Number.isFinite(turn?.durationMs) ? turn.durationMs : null);
  return {
    state: cancelled ? "cancelled" : terminal ? "settled" : "active",
    durationMs: cancelled ? null : fallback,
    precise: precise != null,
    suppressed: null,
  };
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function turnSummary(turn, nowMs = Date.now()) {
  const timing = turnTiming(turn, nowMs);
  if (timing.state === "cancelled" || timing.suppressed) return "";
  const duration = formatDuration(timing.durationMs);
  if (timing.state === "active") return duration ? `Working for ${duration}` : "Working";
  if (!isFinalEligible(turn)) return "";
  return duration ? `Worked for ${duration}` : "";
}

export function isFinalEligible(turn) {
  return (turn?.itemOrder || []).some((id) => {
    const item = turn.items[id];
    return item?.type === "agentMessage" && item.phase === "final_answer" && item.status === "completed" && Boolean(text(item.text).trim());
  });
}

export function conversationView(state, nowMs = Date.now()) {
  return (state?.turnOrder || []).map((id) => {
    const model = turnPresentation(state.turns[id], nowMs);
    return { id, ...model };
  });
}

/** Exact single-turn contract consumed by the Work renderer adapter. */
export function turnPresentation(turn, nowMs = Date.now()) {
  const units = turnUnits(turn);
  const final = [...units].reverse().find((unit) => unit.type === "message"
    && unit.role === "assistant" && unit.phase === "final_answer") || null;
  const users = units.filter((unit) => unit.type === "message" && unit.role === "user");
  const user = users[0] || null;
  const timing = turnTiming(turn, nowMs);
  const finalEligible = isFinalEligible(turn);
  const canCollapse = timing.state === "settled"
    && finalEligible
    && units.some((unit) => unit.collapsible)
    && timing.state !== "cancelled";
  return {
    key: turn?.id || "",
    nativeStarted: Boolean(turn?.nativeStarted),
    startedAtMs: Number.isFinite(turn?.startedAtMs) ? turn.startedAtMs : null,
    completedAtMs: Number.isFinite(turn?.completedAtMs) ? turn.completedAtMs : null,
    status: turn?.status || "",
    active: timing.state === "active",
    settled: timing.state === "settled",
    cancelled: timing.state === "cancelled",
    user,
    users,
    units,
    final,
    finalEligible,
    canCollapse,
    timing,
    summary: turnSummary(turn, nowMs),
    empty: units.length === 0,
    retryText: [...(turn?.retryText || [])],
    providerState: turn?.providerState || null,
    providerLabel: turn?.providerLabel || null,
    composerAvailable: turn?.composerAvailable !== false,
    requiresAction: Boolean(turn?.requiresAction),
    error: turn?.error ? {
      message: safeActivityOutput(turn.error.message || "Something went wrong"),
      code: compact(turn.error.code || turn.error.type || "", 64) || null,
      willRetry: Boolean(turn.error.willRetry),
    } : null,
  };
}

/** Bounded, renderer-safe push payload. It contains no reducer internals. */
export function workPresentationSnapshot(state, nowMs = Date.now(), {
  maxTurns = 20,
  maxUnitsPerTurn = 500,
  maxStringChars = 64 * 1_024,
  maxBytes = 2 * 1_024 * 1_024,
} = {}) {
  const turnIds = (state?.turnOrder || []).slice(-Math.max(1, maxTurns));
  const result = {
    version: VERSION,
    provider: text(state?.provider),
    sessionId: text(state?.sessionId),
    turns: [],
  };
  const ceiling = Math.max(16 * 1_024, Number(maxBytes) || 0);
  const budget = { remaining: Math.floor(ceiling * 0.8) };
  budget.remaining -= utf8Bytes(JSON.stringify({ ...result, turns: [] }));
  for (const id of [...turnIds].reverse()) {
    if (budget.remaining <= 1_024) break;
    const model = turnPresentation(state.turns[id], nowMs);
    const sourceUnits = model.units;
    const finalId = model.final?.id;
    const essential = sourceUnits.filter((unit) => unit.id === finalId
      || unit.role === "user" || unit.blocking || unit.type === "error");
    const optional = sourceUnits.filter((unit) => !essential.includes(unit));
    // The strict final is first under byte pressure, followed by human turns
    // and blockers. Optional activity can be truncated; the answer cannot.
    const priorityUnits = [
      ...essential.filter((unit) => unit.id === finalId),
      ...essential.filter((unit) => unit.id !== finalId),
      ...optional.slice(-Math.max(0, maxUnitsPerTurn - essential.length)),
    ].slice(0, Math.max(1, maxUnitsPerTurn));
    const unitOrder = new Map(sourceUnits.map((unit, index) => [unit.id, index]));
    const transportFields = Object.fromEntries(Object.entries(model).filter(([key]) => !["key", "status", "units", "user", "users", "final"].includes(key)));
    const transportModel = {
      key: model.key,
      status: model.status,
      units: priorityUnits,
      ...transportFields,
      ...(priorityUnits.length < sourceUnits.length ? { truncated: true } : {}),
    };
    // Keep the per-string ceiling as a secondary readability guard, while the
    // shared budget below is the actual IPC memory boundary. Reserve room for
    // the compatibility `users`/`user`/`final` views derived from these units;
    // JSON has no object-reference encoding and serializes those aliases again.
    const stringBounded = boundedPersistenceValue(transportModel, {
      remaining: Math.min(Math.floor(budget.remaining * 0.4), Math.max(1_024, maxStringChars) * Math.max(1, transportModel.units.length)),
      maxStringBytes: Math.max(1_024, maxStringChars),
    });
    stringBounded.units = (stringBounded.units || [])
      .filter((unit) => unit && typeof unit === "object" && unit.id)
      .sort((left, right) => (unitOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (unitOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    stringBounded.users = stringBounded.units.filter((unit) => unit.role === "user");
    stringBounded.user = stringBounded.users[0] || null;
    stringBounded.final = stringBounded.units.find((unit) => unit.id === finalId) || null;
    const bytes = utf8Bytes(JSON.stringify(stringBounded)) + 1;
    if (bytes > budget.remaining) continue;
    budget.remaining -= bytes;
    result.turns.unshift(stringBounded);
  }
  return result;
}
