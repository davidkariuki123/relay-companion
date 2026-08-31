function text(value) {
  return String(value == null ? "" : value).trim();
}

function atMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeId(value) {
  return text(value).replace(/[^A-Za-z0-9:._-]+/g, "-").slice(0, 160);
}

function terminalState(state) {
  return ["completed", "failed", "stopped"].includes(text(state).toLowerCase());
}

function toolActivity(record, active) {
  const raw = text(record?.tool).replace(/^mcp__.*?__/, "");
  const tool = raw.toLowerCase();
  const command = ["exec", "exec_command", "bash", "shell"].includes(tool);
  const edit = ["apply_patch", "write", "edit"].includes(tool);
  const read = ["read", "view_image"].includes(tool);
  const search = ["grep", "glob", "search", "web_search", "websearch"].includes(tool);
  const kind = command ? "command" : edit ? "edit" : read ? "read" : search ? "search" : "call";
  const label = command ? "a command"
    : edit ? "files"
      : read ? "a file"
        : search ? "files"
          : raw.replace(/[_-]+/g, " ") || "a tool";
  return {
    status: active ? "inProgress" : "completed",
    kind,
    activeVerb: command ? "Running" : edit ? "Editing" : read ? "Reading" : search ? "Searching" : "Calling",
    doneVerb: command ? "Ran" : edit ? "Edited" : read ? "Read" : search ? "Searched" : "Called",
    object: label,
    fullObject: label,
    nativeProvider: "relay-agent-session",
  };
}

function durationSummary(start, end, active) {
  if (active) return "Working";
  if (start == null || end == null) return "Worked";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return seconds < 60 ? `Worked for ${seconds} sec` : `Worked for ${Math.floor(seconds / 60)} min`;
}

/**
 * Project a locally-owned tagged @Claude/@Codex session into the exact bounded
 * conversation contract consumed by the existing Task runner. Native records
 * stay in main; the renderer receives only explicit user/commentary/activity/
 * final placements and never sees the controller prompt carried by the native
 * session's first user row.
 */
export function chatAgentWorkPresentation({ session, events = [], records = [] } = {}) {
  const provider = text(session?.provider).toLowerCase();
  const sessionId = text(session?.relaySessionId || session?.id);
  const orderedEvents = [...events].sort((left, right) => (atMs(left?.occurredAt) ?? 0) - (atMs(right?.occurredAt) ?? 0));
  const seeds = [{
    id: `${safeId(session?.id || "agent")}:turn:0`,
    text: text(session?.instruction),
    at: atMs(session?.createdAt),
  }];
  for (const event of orderedEvents) {
    if (event?.type !== "user.turn.accepted" || !text(event?.payload?.message)) continue;
    seeds.push({
      id: `${safeId(session?.id || "agent")}:turn:${safeId(event?.sequence || event?.id || seeds.length)}`,
      text: text(event.payload.message),
      at: atMs(event.occurredAt),
    });
  }

  const orderedRecords = [...records]
    .filter((record) => record && typeof record === "object")
    .sort((left, right) => (atMs(left.at) ?? 0) - (atMs(right.at) ?? 0));
  const completions = orderedEvents.filter((event) => event?.type === "agent.completed" && text(event?.payload?.forHuman));
  const terminal = terminalState(session?.state);

  const turns = seeds.map((seed, turnIndex) => {
    const nextAt = seeds[turnIndex + 1]?.at ?? Infinity;
    const rows = orderedRecords.filter((record) => {
      const time = atMs(record.at);
      return time != null && (seed.at == null || time >= seed.at) && time < nextAt && record.role !== "user";
    });
    const settled = turnIndex < seeds.length - 1 || terminal;
    const completion = [...completions].reverse().find((event) => {
      const time = atMs(event.occurredAt);
      return time != null && (seed.at == null || time >= seed.at) && time < nextAt;
    });
    const assistantRows = rows.filter((record) => record.type === "message" && record.role === "assistant" && text(record.text));
    const finalText = settled ? text(completion?.payload?.forHuman || assistantRows.at(-1)?.text) : "";
    const units = [];
    if (seed.text) units.push({
      id:`${seed.id}:user`, type:"message", role:"user", side:"right", text:seed.text,
      placement:"user", persistent:true, collapsible:false, status:"completed",
    });

    let toolOrdinal = 0;
    for (const record of rows) {
      if (record.type === "message" && record.role === "assistant") {
        const body = text(record.text);
        if (!body || (finalText && body === finalText)) continue;
        units.push({
          id:`${seed.id}:assistant:${safeId(record.at || units.length)}`, type:"message", role:"assistant",
          text:body, placement:"collapsible", collapsible:true, persistent:false, status:"completed",
        });
        continue;
      }
      if (record.type === "tool_call") {
        const laterResult = rows.slice(rows.indexOf(record) + 1).find((candidate) => candidate.type === "tool_result" || candidate.type === "tool_call");
        const active = !settled && (!laterResult || laterResult.type !== "tool_result");
        units.push({
          id:`${seed.id}:tool:${toolOrdinal++}`, type:"activity", placement:"collapsible", collapsible:true,
          persistent:false, activity:toolActivity(record, active),
        });
        continue;
      }
      if (record.type === "error") {
        units.push({
          id:`${seed.id}:error:${safeId(record.at || units.length)}`, type:"error", placement:"post",
          persistent:true, standalone:true, collapsible:false, text:text(record.text || record.output || "The run hit an error"),
        });
      }
    }
    if (finalText) units.push({
      id:`${seed.id}:final`, type:"message", role:"assistant", side:"left", phase:"final_answer", text:finalText,
      placement:"final", final:true, persistent:true, collapsible:false, status:"completed",
    });

    const completedAt = turnIndex < seeds.length - 1 ? seeds[turnIndex + 1].at : atMs(session?.completedAt);
    const hasCollapsible = units.some((unit) => unit.placement === "collapsible");
    const terminalStatus = text(session?.state).toLowerCase();
    const state = settled
      ? terminalStatus === "stopped" ? "cancelled" : terminalStatus === "failed" ? "failed" : "completed"
      : "inProgress";
    return {
      key:seed.id,
      status:state,
      active:!settled,
      settled,
      cancelled:state === "cancelled",
      units,
      final:units.find((unit) => unit.placement === "final") || null,
      finalEligible:Boolean(finalText),
      canCollapse:settled && Boolean(finalText) && hasCollapsible,
      timing:{ state:settled ? "settled" : "active", durationMs:seed.at != null && completedAt != null ? Math.max(0, completedAt - seed.at) : null, precise:false },
      summary:durationSummary(seed.at, completedAt, !settled),
      empty:units.length === 0,
      retryText:[],
      providerState:text(session?.state),
      providerLabel:"",
      composerAvailable:true,
      requiresAction:false,
      error:null,
    };
  });

  return { version:1, provider, sessionId, turns };
}
