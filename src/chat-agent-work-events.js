import { createHash } from "node:crypto";

function string(value) {
  return String(value == null ? "" : value);
}

function clean(value) {
  return string(value).trim();
}

function atMs(value, fallback = null) {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hash(value) {
  return createHash("sha256").update(string(value)).digest("hex").slice(0, 20);
}

function safeId(value, fallback = "item") {
  return clean(value).replace(/[^A-Za-z0-9:._-]+/g, "-").slice(0, 180) || fallback;
}

function terminalState(state) {
  return ["completed", "failed", "stopped"].includes(clean(state).toLowerCase());
}

function terminalTurnStatus(state) {
  const value = clean(state).toLowerCase();
  if (value === "failed") return "failed";
  if (value === "stopped") return "cancelled";
  return "completed";
}

function providerState(session) {
  const state = clean(session?.state).toLowerCase() || "queued";
  const needsInput = state === "needs_input";
  const reconnecting = state === "reconnecting" || state === "waiting_for_device";
  return {
    state,
    label: needsInput ? "Needs input" : reconnecting ? "Reconnecting" : state === "running" ? "Working" : "",
    composerAvailable: !needsInput,
    requiresAction: needsInput,
  };
}

function eventId(event, prefix) {
  return `${prefix}:${safeId(event?.id || event?.sequence || hash(JSON.stringify(event || {})))}`;
}

function recordId(record, prefix, ordinal) {
  let fingerprint = "";
  try {
    fingerprint = JSON.stringify({
      text:record?.text,
      summary:record?.summary,
      message:record?.message,
      input:record?.input,
      ordinal,
    });
  } catch {
    fingerprint = String(ordinal);
  }
  const coordinate = record?.id || record?.toolUseId || record?.tool_use_id || [
    record?.at,
    record?.type,
    record?.role,
    record?.tool || record?.name,
    hash(fingerprint),
  ].join(":");
  return `${prefix}:${safeId(coordinate)}`;
}

function recordText(record) {
  return clean(record?.text || record?.summary || record?.output || record?.message);
}

function sameText(left, right) {
  return clean(left).replace(/\s+/g, " ") === clean(right).replace(/\s+/g, " ");
}

function workEvent(eventIdValue, method, emittedAtMs, turnId, params = {}) {
  return {
    eventId: eventIdValue,
    method,
    emittedAtMs,
    params: { turnId, ...params },
  };
}

function itemEvent(id, method, emittedAtMs, turnId, item) {
  const lifecycle = method === "item/started" ? "startedAtMs" : "completedAtMs";
  return workEvent(id, method, emittedAtMs, turnId, { [lifecycle]:emittedAtMs, item });
}

function toolPresentation(record) {
  const raw = clean(record?.tool || record?.name).replace(/^mcp__.*?__/, "");
  const tool = raw.toLowerCase();
  const command = ["exec", "exec_command", "bash", "shell"].includes(tool);
  const edit = ["apply_patch", "write", "edit"].includes(tool);
  const read = ["read", "view_image"].includes(tool);
  const search = ["grep", "glob", "search", "web_search", "websearch"].includes(tool);
  const kind = command ? "command" : edit ? "edit" : read ? "read" : search ? "search" : "call";
  const object = command ? "a command"
    : edit ? "files"
      : read ? "a file"
        : search ? "files"
          : raw.replace(/[_-]+/g, " ") || "a tool";
  return {
    kind,
    activeVerb:command ? "Running" : edit ? "Editing" : read ? "Reading" : search ? "Searching" : "Calling",
    doneVerb:command ? "Ran" : edit ? "Edited" : read ? "Read" : search ? "Searched" : "Called",
    object,
  };
}

function publicTurnSeeds(session, events) {
  const sessionKey = safeId(session?.id || "agent-session");
  const seeds = [{
    id:`chat-agent:${sessionKey}:turn:0`,
    text:clean(session?.instruction),
    clientMessageId:`trigger:${safeId(session?.triggerRelayId || session?.id || "initial")}`,
    at:atMs(session?.createdAt, 0),
    sequence:0,
  }];
  for (const event of events) {
    if (event?.type !== "user.turn.accepted" || !clean(event?.payload?.message)) continue;
    const coordinate = safeId(event?.sequence || event?.id || seeds.length);
    seeds.push({
      id:`chat-agent:${sessionKey}:turn:${coordinate}`,
      text:clean(event.payload.message),
      clientMessageId:clean(event.payload.clientMessageId) || `event:${safeId(event.id || coordinate)}`,
      at:atMs(event.occurredAt, seeds.at(-1)?.at ?? 0),
      sequence:Number(event.sequence || seeds.length),
    });
  }
  return seeds.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
}

function publicProgressRecords(events) {
  return events.filter((event) => event?.type === "agent.progress" && clean(event?.payload?.summary)).map((event) => ({
    type:"progress",
    id:event.id,
    text:clean(event.payload.summary),
    at:event.occurredAt,
    event,
  }));
}

/**
 * Translate the managed @Claude/@Codex session resource into the same raw Work
 * protocol consumed by provider-native Tasks. The provider prompt never enters
 * this adapter: user items are seeded only from the explicit public instruction
 * and accepted follow-up events.
 */
export function chatAgentSessionToWorkEvents({ session, events = [], records = [] } = {}) {
  if (!session) return [];
  const orderedEvents = [...events]
    .filter((event) => event && typeof event === "object")
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)
      || (atMs(left.occurredAt, 0) - atMs(right.occurredAt, 0)));
  const seeds = publicTurnSeeds(session, orderedEvents);
  const provider = clean(session.provider).toLowerCase() || "codex";
  const recordsAscending = [...records, ...publicProgressRecords(orderedEvents)]
    .filter((record) => record && typeof record === "object" && record.role !== "user")
    .sort((left, right) => atMs(left.at, 0) - atMs(right.at, 0));
  const completions = orderedEvents.filter((event) => event?.type === "agent.completed" && clean(event?.payload?.forHuman));
  const failures = orderedEvents.filter((event) => event?.type === "agent.failed");
  const terminal = terminalState(session.state);
  const state = providerState(session);
  const output = [];

  seeds.forEach((seed, turnIndex) => {
    const nextAt = seeds[turnIndex + 1]?.at ?? Infinity;
    const rows = recordsAscending.filter((record) => {
      const timestamp = atMs(record.at, null);
      return timestamp != null && timestamp >= seed.at && timestamp < nextAt;
    });
    const completion = completions.findLast((event) => {
      const timestamp = atMs(event.occurredAt, null);
      return timestamp != null && timestamp >= seed.at && timestamp < nextAt;
    });
    const failure = failures.findLast((event) => {
      const timestamp = atMs(event.occurredAt, null);
      return timestamp != null && timestamp >= seed.at && timestamp < nextAt;
    });
    const settled = turnIndex < seeds.length - 1 || terminal;
    const completedAt = turnIndex < seeds.length - 1
      ? Math.max(seed.at, nextAt - 1)
      : atMs(session.completedAt || session.stoppedAt || session.updatedAt, rows.length ? atMs(rows.at(-1)?.at, seed.at) : seed.at);
    const finalText = settled
      ? clean(completion?.payload?.forHuman || rows.filter((record) => record.type === "message" && record.role === "assistant").at(-1)?.text)
      : "";

    output.push(workEvent(`${seed.id}:started`, "turn/started", seed.at, seed.id, { startedAtMs:seed.at }));
    output.push(itemEvent(`${seed.id}:user:completed`, "item/completed", seed.at, seed.id, {
      id:`${seed.id}:user`,
      type:"userMessage",
      text:seed.text,
      displayText:seed.text,
      clientMessageId:seed.clientMessageId,
      status:"completed",
      provider,
    }));
    output.push(workEvent(`${seed.id}:provider:${state.state}`, "provider/state", seed.at, seed.id, {
      nativeState:state.state,
      nativeLabel:state.label,
      composerAvailable:state.composerAvailable,
      requiresAction:state.requiresAction,
    }));

    let lastProgress = "";
    rows.forEach((record, ordinal) => {
      const timestamp = atMs(record.at, seed.at + ordinal + 1);
      const id = recordId(record, `${seed.id}:record`, ordinal);
      const body = recordText(record);
      if (record.type === "progress") {
        if (!body || sameText(body, lastProgress) || (finalText && sameText(body, finalText))) return;
        lastProgress = body;
        output.push(itemEvent(`${id}:completed`, "item/completed", timestamp, seed.id, {
          id, type:"plan", text:body, status:"completed", provider,
        }));
        return;
      }
      if (record.type === "message" && record.role === "assistant") {
        if (!body || (finalText && sameText(body, finalText))) return;
        output.push(itemEvent(`${id}:completed`, "item/completed", timestamp, seed.id, {
          id, type:"agentMessage", phase:"commentary", text:body, status:"completed", provider,
        }));
        return;
      }
      if (record.type === "tool_call") {
        const presentation = toolPresentation(record);
        output.push(itemEvent(`${id}:started`, "item/started", timestamp, seed.id, {
          id, type:"dynamicToolCall", name:clean(record.tool || record.name || "Tool"),
          tool:clean(record.tool || record.name || "Tool"), status:"inProgress",
          presentation, provider,
        }));
        if (settled) output.push(itemEvent(`${id}:completed`, "item/completed", timestamp, seed.id, {
          id, type:"dynamicToolCall", name:clean(record.tool || record.name || "Tool"),
          tool:clean(record.tool || record.name || "Tool"), status:"completed", presentation, provider,
        }));
        return;
      }
      if (record.type === "error" && body) {
        output.push(workEvent(`${id}:error`, "error", timestamp, seed.id, {
          error:{ message:body, code:"AGENT_SESSION_ERROR", willRetry:false }, willRetry:false,
        }));
      }
    });

    if (finalText) {
      const timestamp = atMs(completion?.occurredAt, completedAt);
      output.push(itemEvent(`${seed.id}:final:${hash(finalText)}`, "item/completed", timestamp, seed.id, {
        id:`${seed.id}:final`, type:"agentMessage", phase:"final_answer", text:finalText,
        status:"completed", provider,
      }));
    }
    if (failure) {
      const message = clean(failure.payload?.error || "The Work session failed.");
      output.push(workEvent(eventId(failure, `${seed.id}:failure`), "error", atMs(failure.occurredAt, completedAt), seed.id, {
        error:{ message, code:"AGENT_SESSION_FAILED", willRetry:false }, willRetry:false,
      }));
    }
    if (settled) {
      const status = turnIndex < seeds.length - 1 ? "completed" : terminalTurnStatus(session.state);
      output.push(workEvent(`${seed.id}:completed:${status}`, "turn/completed", completedAt, seed.id, {
        completedAtMs:completedAt,
        status,
        ...(failure ? { error:{ message:clean(failure.payload?.error || "The Work session failed."), code:"AGENT_SESSION_FAILED" } } : {}),
      }));
    }
  });

  return output;
}
