import { createHash } from "node:crypto";
export * from "./claude-native-work-feed.js";

const MAX_NATIVE_EVENTS = 8_000;
const HIDDEN_CONTROL_SUBTYPES = new Set([
  "set_permission_mode", "set_max_thinking_tokens", "mcp_set_servers",
  "mcp_toggle", "apply_flag_settings",
]);
const CONTROL_RESOLUTION_TYPES = new Set([
  "control_response", "control_cancel", "control_cancel_request",
]);

function string(value) {
  return String(value == null ? "" : value);
}

function hash(value) {
  return createHash("sha256").update(string(value)).digest("hex").slice(0, 20);
}

function parseTime(...values) {
  for (const value of values) {
    const parsed = Date.parse(string(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sequence(event) {
  const value = BigInt(string(event?.sequence_num || event?.sequenceNum || "0").replace(/[^0-9-]/g, "") || "0");
  return value;
}

function nativeIdentity(event, ordinal = 0) {
  return string(event?.event_id || event?.id || event?.payload?.uuid).trim()
    || `cowork:${string(event?.sequence_num || event?.sequenceNum || ordinal)}:${hash(JSON.stringify(event?.payload || event || {}))}`;
}

/**
 * Cowork pages overlap and occasionally return a previous page boundary again.
 * Event identity, not object identity or arrival order, is authoritative. The
 * highest sequence wins when a later page contains a richer copy.
 */
export function reconcileCoworkNativeEvents(input) {
  const rows = Array.isArray(input) ? input : [];
  const byId = new Map();
  rows.forEach((row, ordinal) => {
    if (!row || typeof row !== "object") return;
    const key = nativeIdentity(row, ordinal);
    const previous = byId.get(key);
    const rowJson = JSON.stringify(row);
    const previousJson = previous ? JSON.stringify(previous.row) : "";
    const newer = !previous || sequence(row) > sequence(previous.row);
    const richer = previous && sequence(row) === sequence(previous.row)
      && (rowJson.length > previousJson.length || (rowJson.length === previousJson.length && rowJson > previousJson));
    if (newer || richer) byId.set(key, { row, ordinal });
  });
  const ordered = [...byId.values()].sort((left, right) => {
    const delta = sequence(left.row) - sequence(right.row);
    if (delta < 0n) return -1;
    if (delta > 0n) return 1;
    const byEvent = nativeIdentity(left.row, left.ordinal).localeCompare(nativeIdentity(right.row, right.ordinal));
    return byEvent || left.ordinal - right.ordinal;
  }).map((entry) => entry.row);
  if (ordered.length <= MAX_NATIVE_EVENTS) return ordered;
  const start = ordered.length - MAX_NATIVE_EVENTS;
  const boundary = ordered.slice(0, start).findLast(isTrueHuman);
  return boundary ? [boundary, ...ordered.slice(start)] : ordered.slice(start);
}

function payloadOf(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : event || {};
}

function typeOf(event) {
  const payload = payloadOf(event);
  return string(payload.type || event?.event_type || event?.type).toLowerCase();
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object");
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function publicText(content) {
  return contentBlocks(content)
    .filter((block) => block.type === "text")
    .map((block) => string(block.text))
    .filter(Boolean)
    .join("\n");
}

function messageText(payload) {
  if (typeof payload?.message === "string") return payload.message;
  return publicText(payload?.message?.content ?? payload?.content);
}

function hasToolResult(payload) {
  const type = string(payload?.type).toLowerCase();
  if (/tool_result/.test(type)) return true;
  return contentBlocks(payload?.message?.content ?? payload?.content)
    .some((block) => block.type === "tool_result" || block.type === "custom_tool_result");
}

function isRuntimeSeed(text) {
  const value = string(text);
  return /<relay-documents\b|<relay-runtime-contract\b|<for-agent\b|Begin the task as briefed\.?/i.test(value);
}

function isTrueHuman(event) {
  const payload = payloadOf(event);
  if (typeOf(event) !== "user" || hasToolResult(payload)) return false;
  // Cowork also labels worker protocol frames as `user`. Only the independent
  // outer client provenance plus its Desktop-platform corroboration proves a
  // real human boundary; prose and role labels are not evidence.
  if (string(event?.source).toLowerCase() !== "client" || !string(payload.client_platform).trim()) return false;
  if (string(payload.source).toLowerCase() === "worker" || payload.isSynthetic || payload.isCompactSummary
    || payload.isVisibleInTranscriptOnly || payload.synthetic || payload.internal) return false;
  return Boolean(messageText(payload).trim());
}

function sourceUuid(event) {
  const payload = payloadOf(event);
  return string(payload.uuid || event?.event_id || event?.id).trim();
}

function eventTime(event) {
  const payload = payloadOf(event);
  return parseTime(payload.timestamp, payload.created_at, payload.processed_at, event?.created_at, event?.processed_at);
}

function workEvent(event, suffix, method, turnId, params = {}) {
  const sourceId = nativeIdentity(event);
  const at = eventTime(event);
  return {
    eventId: `cowork:${sourceId}:${suffix}`,
    method,
    emittedAtMs: at,
    params: { turnId, ...params },
  };
}

function itemEvent(event, suffix, turnId, item, lifecycle = "completed") {
  const at = eventTime(event);
  return workEvent(event, suffix, `item/${lifecycle}`, turnId, {
    [`${lifecycle}AtMs`]: at,
    item: {
      provider: "cowork",
      nativeType: typeOf(event),
      nativeEventId: nativeIdentity(event),
      ...item,
    },
  });
}

function compactObject(value) {
  return string(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function basename(value) {
  const clean = string(value).replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean;
}

function coworkToolPresentation(name, input = {}) {
  const tool = string(name || "Tool");
  const path = basename(input.file_path || input.path || input.filename || "a file");
  const query = compactObject(input.query || input.pattern || input.search_term || "files");
  const description = compactObject(input.description || input.task || input.prompt || "");
  if (/^(Read|View|Open)$/i.test(tool)) return { kind: "read", activeVerb: "Reading", doneVerb: "Read", object: path, objectType: "file" };
  if (/^(Write|Create)$/i.test(tool)) return { kind: "edit", activeVerb: "Creating", doneVerb: "Created", object: path, objectType: "file" };
  if (/^(Edit|MultiEdit|ApplyPatch)$/i.test(tool)) return { kind: "edit", activeVerb: "Editing", doneVerb: "Edited", object: path, objectType: "file" };
  if (/^(Grep|Glob|Search|Find)$/i.test(tool)) return { kind: "search", activeVerb: "Searching", doneVerb: "Searched", object: query };
  if (/^(WebFetch|Fetch)$/i.test(tool)) return { kind: "web", activeVerb: "Fetching", doneVerb: "Fetched", object: compactObject(input.url || "the web") };
  if (/^(WebSearch)$/i.test(tool)) return { kind: "web", activeVerb: "Searching", doneVerb: "Searched", object: query || "the web" };
  if (/^(Bash|Shell|Execute|RunCommand)$/i.test(tool)) return {
    kind: "command", activeVerb: "Running", doneVerb: "Ran", object: compactObject(input.command || description || "command"),
  };
  if (/^(Agent|Task|Subagent)$/i.test(tool)) return { kind: "subagent", activeVerb: "Running", doneVerb: "Ran", object: description || "agent" };
  if (/Skill/i.test(tool)) return { kind: "call", activeVerb: "Running", doneVerb: "Ran", object: description || "skill" };
  if (/ToolSearch|FindTools/i.test(tool)) return { kind: "search", activeVerb: "Finding", doneVerb: "Found", object: "tools" };
  if (/SendMessage/i.test(tool)) return { kind: "call", activeVerb: "Sending", doneVerb: "Sent", object: "message" };
  if (/PresentFiles/i.test(tool)) return { kind: "call", activeVerb: "Presenting", doneVerb: "Presented", object: "files" };
  if (/TaskOutput|CommandOutput/i.test(tool)) return { kind: "read", activeVerb: "Checking", doneVerb: "Checked", object: "command output" };
  if (/Multi/i.test(tool)) return { kind: "call", activeVerb: "Multitasking", doneVerb: "Multitasked", object: "" };
  return { kind: "call", activeVerb: "Using", doneVerb: "Used", object: compactObject(tool.replace(/[_-]+/g, " ")) || "tool" };
}

function nativeToolItem(block, event, status = "inProgress") {
  const toolUseId = string(block.id || block.tool_use_id || payloadOf(event).tool_use_id || nativeIdentity(event));
  const name = string(block.name || block.tool_name || payloadOf(event).tool_name || "Tool");
  return {
    id: `cowork-tool:${toolUseId}`,
    type: "dynamicToolCall",
    name,
    tool: name,
    status,
    presentation: coworkToolPresentation(name, block.input || {}),
    metadata: { provider: "cowork", nativeToolUseId: toolUseId },
  };
}

function questionText(payload) {
  const request = payload?.request || {};
  const questions = request.questions || request.input?.questions || payload.questions || [];
  const rows = Array.isArray(questions) ? questions : [];
  const prompt = rows.map((question) => string(question?.question || question?.prompt || question)).filter(Boolean).join("\n");
  const fallback = string(request.question || request.prompt || payload.question || payload.prompt || payload.reason);
  const header = string(rows[0]?.header || request.header).trim();
  const text = prompt || fallback || "Input required";
  return header && !text.toLowerCase().includes(header.toLowerCase()) ? `${header}: ${text}` : text;
}

function requestId(payload, event) {
  return string(payload?.request_id || payload?.requestId || payload?.request?.request_id || payload?.response?.request_id || nativeIdentity(event));
}

function controlSubtype(payload) {
  return string(payload?.request?.subtype || payload?.response?.subtype || payload?.subtype).toLowerCase();
}

function resultFailed(payload) {
  const subtype = string(payload?.subtype).toLowerCase();
  return Boolean(payload?.is_error) || ["error", "failed", "failure"].includes(subtype)
    || ["provider_error", "failed", "error"].includes(string(payload?.terminal_reason).toLowerCase());
}

function retryDisposition(payload) {
  return string(payload?.error?.retry_status?.type || payload?.retry_status?.type || payload?.retry_status).toLowerCase();
}

function errorText(payload, fallback = "Cowork could not finish this turn.") {
  return string(payload?.error?.message || payload?.error || payload?.result || payload?.message || payload?.status_detail || fallback).trim();
}

function latestSummary(turn) {
  return turn.rows.filter((event) => typeOf(event) === "system" && /post_turn_summary/i.test(string(payloadOf(event).subtype))).at(-1) || null;
}

function summaryState(turn) {
  const summary = latestSummary(turn);
  const payload = payloadOf(summary);
  return {
    event: summary,
    category: string(payload.status_category).toLowerCase(),
    detail: string(payload.status_detail).trim(),
    action: string(payload.needs_action).trim(),
    summarizesUuid: string(payload.summarizes_uuid).trim(),
  };
}

function resultFor(turn) {
  return turn.rows.filter((event) => typeOf(event) === "result").at(-1) || null;
}

function sessionRequiresAction(session) {
  return Array.isArray(session?.requires_action_details_list) && session.requires_action_details_list.length > 0;
}

function providerStateFor(turn, session, isLatest) {
  const summary = summaryState(turn);
  const result = resultFor(turn);
  const failed = result && resultFailed(payloadOf(result));
  const pendingRequest = turn.pendingRequestCount > 0;
  const sessionBlocked = isLatest && (string(session?.status_bucket).toLowerCase() === "blocked"
    || string(session?.worker_status).toLowerCase() === "requires_action" || sessionRequiresAction(session));
  if (failed) return { state: "failed", label: "Needs attention", terminal: true };
  if (summary.category === "blocked" || pendingRequest || sessionBlocked) return { state: "blocked", label: "Needs input", terminal: false };
  if (result || summary.category === "review_ready") return { state: "review_ready", label: "Ready for review", terminal: true };
  const worker = string(session?.worker_status).toLowerCase();
  const bucket = string(session?.status_bucket).toLowerCase();
  if (isLatest && bucket === "review_ready") return { state: "review_ready", label: "Ready for review", terminal: true };
  if (isLatest && (worker === "idle" || ["completed", "archived"].includes(bucket))) return { state: "completed", label: "Completed", terminal: true };
  return { state: "working", label: "Working", terminal: false };
}

function assistantTextRows(turn) {
  const rows = [];
  for (const event of turn.rows) {
    if (typeOf(event) !== "assistant") continue;
    const payload = payloadOf(event);
    const value = publicText(payload?.message?.content ?? payload?.content).trim();
    if (value) rows.push({ event, uuid: sourceUuid(event), text: value });
  }
  return rows;
}

function finalAssistantUuid(turn) {
  const summary = summaryState(turn);
  if (summary.summarizesUuid) return summary.summarizesUuid;
  const result = resultFor(turn);
  const resultPayload = payloadOf(result);
  if (!result || resultFailed(resultPayload)) return "";
  const exact = assistantTextRows(turn).findLast(({ text }) => text.trim() === string(resultPayload.result).trim());
  return exact?.uuid || (string(resultPayload.stop_reason).toLowerCase() === "end_turn" ? assistantTextRows(turn).at(-1)?.uuid || "" : "");
}

function turnStartEvent(turn) {
  const source = turn.seed || turn.rows[0];
  const startedAtMs = eventTime(source);
  return workEvent(source, "turn-start", "turn/started", turn.id, { startedAtMs });
}

function nativeStateEvent(turn, source, state) {
  return workEvent(source || turn.seed || turn.rows.at(-1), `native-state:${state.state}`, "provider/state", turn.id, {
    nativeState: state.state,
    nativeLabel: state.label,
    composerAvailable: true,
    requiresAction: state.state === "blocked",
  });
}

function assignTurns(events, sessionId) {
  const turns = [];
  const byUserUuid = new Map();
  const byRequestId = new Map();
  let current = null;
  const ensure = (seed = null) => {
    if (current) return current;
    const uuid = sourceUuid(seed) || `orphan-${turns.length}`;
    current = { id: `cowork-turn:${sessionId}:${uuid}`, seed, rows: [], byRequestId, pendingRequestCount: 0 };
    turns.push(current);
    return current;
  };
  for (const event of events) {
    const payload = payloadOf(event);
    const type = typeOf(event);
    if (isTrueHuman(event)) {
      const uuid = sourceUuid(event) || nativeIdentity(event);
      current = { id: `cowork-turn:${sessionId}:${uuid}`, seed: event, rows: [], byRequestId, pendingRequestCount: 0 };
      turns.push(current);
      byUserUuid.set(uuid, current);
      current.rows.push(event);
      continue;
    }
    if (type === "result" && payload.user_message_uuid && byUserUuid.has(string(payload.user_message_uuid))) {
      byUserUuid.get(string(payload.user_message_uuid)).rows.push(event);
      continue;
    }
    if (type === "control_request") {
      if (!current && HIDDEN_CONTROL_SUBTYPES.has(controlSubtype(payload))) continue;
      const owner = ensure(event);
      byRequestId.set(requestId(payload, event), owner);
      owner.rows.push(event);
      continue;
    }
    if (CONTROL_RESOLUTION_TYPES.has(type)) {
      const owner = byRequestId.get(requestId(payload, event));
      if (!owner) continue; // response to hidden Desktop protocol, not a human turn
      owner.rows.push(event);
      continue;
    }
    // Startup/configuration noise before the first actual prompt is not a turn.
    if (!current && ["env_manager_log", "control_request", "control_response", "system", "rate_limit_event"].includes(type)) continue;
    ensure(event).rows.push(event);
  }
  return turns;
}

function resolvedRequestIds(turn) {
  const ids = new Set();
  for (const event of turn.rows) {
    if (CONTROL_RESOLUTION_TYPES.has(typeOf(event))) ids.add(requestId(payloadOf(event), event));
  }
  return ids;
}

function explicitControlToolIds(turn) {
  const ids = new Set();
  for (const event of turn.rows) {
    if (typeOf(event) !== "control_request") continue;
    const payload = payloadOf(event);
    if (controlSubtype(payload) === "can_use_tool") ids.add(string(payload.request?.tool_use_id));
  }
  return ids;
}

function toolResultBlocks(payload) {
  const direct = /tool_result/.test(string(payload?.type)) ? [payload] : [];
  return [...direct, ...contentBlocks(payload?.message?.content ?? payload?.content)
    .filter((block) => block.type === "tool_result" || block.type === "custom_tool_result")];
}

function toolUseBlocks(payload) {
  const direct = /tool_use/.test(string(payload?.type)) ? [payload] : [];
  return [...direct, ...contentBlocks(payload?.message?.content ?? payload?.content)
    .filter((block) => block.type === "tool_use" || block.type === "custom_tool_use")];
}

function publicQuestionDetails(payload) {
  const request = payload?.request || payload || {};
  const questions = request.questions || request.input?.questions || payload?.questions || [];
  return {
    subtype: controlSubtype(payload) || null,
    questions: (Array.isArray(questions) ? questions : []).slice(0, 20).map((question) => ({
      id: string(question?.id || question?.question_id).trim() || null,
      header: string(question?.header).trim() || null,
      question: string(question?.question || question?.prompt || question).trim(),
      multiSelect: Boolean(question?.multiSelect || question?.multi_select),
      options: (Array.isArray(question?.options) ? question.options : []).slice(0, 50).map((option) => ({
        label: string(option?.label || option?.value || option).trim(),
        description: string(option?.description).trim() || null,
      })),
    })),
  };
}

function requestEvent(event, turnId, id, text, method = "cowork/requestUserInput", details = null) {
  return {
    eventId: `cowork:${nativeIdentity(event)}:request:${id}`,
    id,
    method,
    emittedAtMs: eventTime(event),
    params: {
      turnId,
      requestId: id,
      question: string(text).trim() || "Input required",
      provider: "cowork",
      request: details && typeof details === "object" ? details : undefined,
    },
  };
}

function buildTurnEvents(turn, { session, isLatest }) {
  const events = [turnStartEvent(turn)];
  const resolved = resolvedRequestIds(turn);
  const controlledToolIds = explicitControlToolIds(turn);
  const summary = summaryState(turn);
  const result = resultFor(turn);
  const resultPayload = payloadOf(result);
  const finalUuid = finalAssistantUuid(turn);
  const hasLaterSuccess = Boolean(result && !resultFailed(resultPayload));
  const requestIds = new Set();
  const nativeTools = new Map();
  for (const candidate of turn.rows) {
    for (const block of toolUseBlocks(payloadOf(candidate))) {
      nativeTools.set(string(block.id || block.tool_use_id || sourceUuid(candidate)), block);
    }
  }

  for (const event of turn.rows) {
    const payload = payloadOf(event);
    const type = typeOf(event);
    const uuid = sourceUuid(event) || nativeIdentity(event);
    if (event === turn.seed && isTrueHuman(event) && !isRuntimeSeed(messageText(payload))) {
      events.push(itemEvent(event, "human", turn.id, {
        id: `cowork-user:${uuid}`,
        type: "userMessage",
        text: messageText(payload),
        status: "completed",
        attachments: contentBlocks(payload?.message?.content ?? payload?.content)
          .filter((block) => ["image", "document", "file", "attachment"].includes(block.type)),
      }));
      continue;
    }
    if (type === "assistant") {
      const text = publicText(payload?.message?.content ?? payload?.content).trim();
      if (text) events.push(itemEvent(event, `assistant:${finalUuid === uuid ? "final" : "commentary"}`, turn.id, {
        id: `cowork-message:${uuid}`,
        type: "agentMessage",
        text,
        phase: finalUuid === uuid ? "final_answer" : "commentary",
        status: "completed",
      }));
      for (const block of toolUseBlocks(payload)) {
        const toolUseId = string(block.id || block.tool_use_id || uuid);
        if (/AskUserQuestion/i.test(string(block.name))) {
          if (!controlledToolIds.has(toolUseId)) {
            const id = `ask:${toolUseId}`;
            const questions = Array.isArray(block.input?.questions) ? block.input.questions : [];
            const question = questions.map((entry) => string(entry?.question || entry)).filter(Boolean).join("\n") || "Input required";
            events.push(requestEvent(event, turn.id, id, question, "cowork/requestUserInput", publicQuestionDetails(block.input || {})));
            if (!resolved.has(id)) requestIds.add(id);
          }
          continue;
        }
        events.push(itemEvent(event, `tool-start:${toolUseId}`, turn.id, nativeToolItem(block, event, "inProgress"), "started"));
      }
      continue;
    }
    if (type === "user" || /tool_result/.test(type)) {
      for (const block of toolResultBlocks(payload)) {
        const toolUseId = string(block.tool_use_id || block.id || uuid);
        const existing = nativeTools.get(toolUseId);
        const item = nativeToolItem(existing || { id: toolUseId, name: block.tool_name || "Tool", input: {} }, event,
          block.is_error ? "failed" : "completed");
        events.push(itemEvent(event, `tool-result:${toolUseId}`, turn.id, item));
        if (block.is_error) events.push(workEvent(event, `tool-error:${toolUseId}`, "error", turn.id, {
          error: { message: publicText(block.content) || string(block.content) || `${item.name} failed`, code: "COWORK_TOOL_FAILED" },
        }));
      }
      continue;
    }
    if (type === "tool_progress") {
      const progressKind = string(payload.kind || payload.subtype).toLowerCase();
      if (["heartbeat", "subagent_retry", "auth_status", "tool_use_summary"].includes(progressKind)) continue;
      const toolUseId = string(payload.tool_use_id || payload.id || uuid);
      events.push(itemEvent(event, `tool-progress:${toolUseId}`, turn.id,
        nativeToolItem({ id: toolUseId, name: payload.tool_name || "Tool", input: payload.input || {} }, event, "inProgress"), "started"));
      continue;
    }
    if (type === "active_goal") {
      const goal = payload.goal || payload.active_goal || payload.value || {};
      const text = string(goal.title || goal.description || goal.condition || payload.title || payload.detail).trim();
      if (text) events.push(itemEvent(event, "active-goal", turn.id, {
        id: `cowork-goal:${uuid}`, type: "plan", text, status: /complete|done/i.test(string(goal.status)) ? "completed" : "inProgress",
      }));
      continue;
    }
    if (type === "autocompact_state" || (type === "system" && /compact/i.test(string(payload.subtype)))) {
      const state = string(payload.state || payload.status || payload.subtype).toLowerCase();
      if (/compact(?:ed|ion)|complete|done/.test(state)) events.push(itemEvent(event, "compaction", turn.id, {
        id: `cowork-compaction:${uuid}`, type: "contextCompaction", text: "Context compacted", status: "completed",
      }));
      continue;
    }
    if (type === "system" && string(payload.subtype).toLowerCase() === "task_summary") {
      const detail = string(payload.detail || payload.status_detail || payload.summary).trim();
      if (detail) events.push(itemEvent(event, "task-summary", turn.id, {
        id: `cowork-summary:${uuid}`, type: "plan", text: detail, status: "inProgress",
      }));
      continue;
    }
    if (type === "control_request") {
      const subtype = controlSubtype(payload);
      if (HIDDEN_CONTROL_SUBTYPES.has(subtype)) continue;
      const id = requestId(payload, event);
      if (subtype === "can_use_tool" || /question|permission|confirm|approve/.test(subtype)) {
        events.push(requestEvent(event, turn.id, id, questionText(payload),
          subtype === "can_use_tool" ? "cowork/permissions/request" : `cowork/${subtype || "requestUserInput"}`,
          publicQuestionDetails(payload)));
        if (!resolved.has(id)) requestIds.add(id);
      }
      continue;
    }
    if (CONTROL_RESOLUTION_TYPES.has(type)) {
      const id = requestId(payload, event);
      events.push({
        eventId: `cowork:${nativeIdentity(event)}:request-resolved:${id}`,
        method: "serverRequest/resolved",
        emittedAtMs: eventTime(event),
        params: { turnId: turn.id, requestId: id, result: { status: /cancel/.test(type) ? "cancelled" : "resolved" } },
      });
      continue;
    }
    if (type === "mcp_auth_required") {
      // A later successful result proves this historical authentication gate
      // was cleared. Cowork keeps the raw event in session history.
      if (hasLaterSuccess && sequence(result) > sequence(event)) continue;
      const id = `mcp-auth:${uuid}`;
      events.push(requestEvent(event, turn.id, id,
        `${string(payload.server_name || payload.mcp_server_name || "MCP server")} needs authentication. Connect it to continue.`,
        "cowork/mcp/elicitation/request", {
          subtype: "mcp_auth_required",
          action: "authenticate",
          serverName: string(payload.server_name || payload.mcp_server_name || "MCP server"),
          questions: [],
        }));
      requestIds.add(id);
      continue;
    }
    if (type === "rate_limit_event") {
      const info = payload.rate_limit_info || payload;
      if (string(info.overageStatus).toLowerCase() === "allowed" || info.overageInUse === true) continue;
      const disposition = retryDisposition(info);
      events.push(workEvent(event, "rate-limit", disposition === "retrying" ? "error" : "error", turn.id, {
        error: {
          message: string(info.message || "Cowork is temporarily rate limited."),
          code: "COWORK_RATE_LIMITED",
          willRetry: disposition === "retrying",
        },
        willRetry: disposition === "retrying",
      }));
      continue;
    }
    if (type === "session.error" || type === "error") {
      const disposition = retryDisposition(payload);
      events.push(workEvent(event, "native-error", "error", turn.id, {
        error: { message: errorText(payload), code: string(payload.error?.type || payload.type || "COWORK_ERROR"), willRetry: disposition === "retrying" },
        willRetry: disposition === "retrying",
      }));
      continue;
    }
    // env_manager_log, generic system frames, protocol controls and result
    // bookkeeping intentionally do not become visible transcript units.
  }

  if (summary.category === "blocked") {
    if (requestIds.size === 0) {
      const id = `post-turn:${nativeIdentity(summary.event)}`;
      events.push(requestEvent(summary.event, turn.id, id, summary.action || summary.detail || "Cowork needs input."));
      requestIds.add(id);
    }
  }
  if (isLatest && sessionRequiresAction(session)) {
    for (const [index, detail] of session.requires_action_details_list.entries()) {
      const id = string(detail?.request_id || detail?.event_id || `session-action-${index}`);
      if (requestIds.has(id) || resolved.has(id)) continue;
      const source = turn.rows.at(-1) || turn.seed;
      events.push(requestEvent(source, turn.id, id,
        detail?.question || detail?.message || detail?.status_detail || "Cowork needs your input to continue.",
        `cowork/${string(detail?.type || "requires_action")}`));
      requestIds.add(id);
    }
  }
  if (isLatest && string(session?.status_bucket).toLowerCase() === "blocked" && requestIds.size === 0) {
    const source = turn.rows.at(-1) || turn.seed;
    const id = `session-blocked:${turn.id}`;
    events.push(requestEvent(source, turn.id, id, "Cowork needs your input to continue."));
    requestIds.add(id);
  }
  turn.pendingRequestCount = requestIds.size;
  const nativeState = providerStateFor(turn, session, isLatest);

  if (result && resultFailed(resultPayload)) {
    events.push(workEvent(result, "result-error", "error", turn.id, {
      error: { message: errorText(resultPayload), code: string(resultPayload.terminal_reason || resultPayload.subtype || "COWORK_FAILED") },
    }));
    events.push(workEvent(result, "turn-failed", "turn/completed", turn.id, {
      status: "failed", completedAtMs: eventTime(result), durationMs: Number(resultPayload.duration_ms) || null,
      error: { message: errorText(resultPayload), code: string(resultPayload.terminal_reason || resultPayload.subtype || "COWORK_FAILED") },
    }));
  } else if (nativeState.terminal) {
    const source = result || summary.event || turn.rows.at(-1);
    events.push(workEvent(source, `turn-completed:${nativeState.state}`, "turn/completed", turn.id, {
      status: "completed", completedAtMs: eventTime(source), durationMs: Number(resultPayload.duration_ms) || null,
    }));
  }
  events.push(nativeStateEvent(turn, result || summary.event || turn.rows.at(-1), nativeState));
  return events;
}

/**
 * Convert raw Claude Desktop Cowork events directly to the bounded Work event
 * envelope. This bypasses the lossy legacy transcript projection entirely:
 * native sequence/event identity, blocking controls and result association are
 * retained before shared rendering primitives are used.
 */
export function coworkNativeEventsToWorkEvents(input, { sessionId = "", session = {} } = {}) {
  const rows = reconcileCoworkNativeEvents(input);
  const turns = assignTurns(rows, string(sessionId || session?.id || "cowork"));
  return turns.flatMap((turn, index) => buildTurnEvents(turn, {
    session,
    isLatest: index === turns.length - 1,
  }));
}

/**
 * One bounded main-process refresh owner. Cowork's current Desktop transport is
 * paged rather than token-delta streaming; refreshing authoritative pages must
 * never be represented to the renderer as fabricated token streaming.
 */
export function subscribeManagedProviderRefresh(refresh, listener, {
  intervalMs = 1_000,
  maxIntervalMs = 15_000,
  maxEventsPerRefresh = 8_192,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let closed = false;
  let running = false;
  let timer = null;
  let delay = Math.max(250, Number(intervalMs) || 1_000);
  const ceiling = Math.max(delay, Number(maxIntervalMs) || 15_000);
  const schedule = () => {
    if (closed) return;
    timer = setTimer(run, delay);
    timer?.unref?.();
  };
  const run = async () => {
    if (closed || running) return;
    running = true;
    try {
      const result = await refresh();
      if (closed) return;
      const events = Array.isArray(result) ? result : result?.events;
      for (const event of (Array.isArray(events) ? events : []).slice(-Math.max(1, maxEventsPerRefresh))) listener(event);
      delay = Math.max(250, Number(intervalMs) || 1_000);
      if (result?.terminal) closed = true;
    } catch (error) {
      if (!closed) listener({
        eventId: `provider-refresh-error:${Date.now()}`,
        method: "error",
        emittedAtMs: Date.now(),
        params: { error: { message: string(error?.message || "Provider refresh failed"), code: "PROVIDER_REFRESH_FAILED", willRetry: true }, willRetry: true },
      });
      delay = Math.min(ceiling, delay * 2);
    } finally {
      running = false;
      schedule();
    }
  };
  void run();
  return () => {
    closed = true;
    if (timer != null) clearTimer(timer);
  };
}

// Transitional shared entry point. Provider-specific adapters live in their
// own modules so Claude and Cowork can evolve independently.
export * from "./claude-native-work-feed.js";
