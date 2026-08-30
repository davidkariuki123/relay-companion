import { createHash } from "node:crypto";
import fs from "node:fs";

const MAX_ROWS = 4_000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function string(value) {
  return String(value == null ? "" : value);
}

function hash(value) {
  return createHash("sha256").update(string(value)).digest("hex").slice(0, 24);
}

function atMs(value, fallback = null) {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function contentBlocks(row) {
  return Array.isArray(row?.message?.content) ? row.message.content : [];
}

function hasToolResult(row) {
  return contentBlocks(row).some((block) => block?.type === "tool_result");
}

function isUserAttachmentBlock(block) {
  return block && /^(?:image|file|attachment)$/i.test(string(block.type));
}

function hasUserAttachment(row) {
  return contentBlocks(row).some(isUserAttachmentBlock);
}

function safeClaudeUserAttachments(row) {
  return contentBlocks(row).filter(isUserAttachmentBlock).slice(0, 20).map((block, index) => {
    const source = block?.source && typeof block.source === "object" ? block.source : {};
    const mimeType = string(
      block.mimeType || block.contentType || block.mediaType
      || source.media_type || source.mimeType || source.contentType,
    ).trim();
    const kind = /^image(?:\/|$)/i.test(mimeType) || /^image$/i.test(string(block.type)) ? "image" : "file";
    return {
      id: `claude-attachment:${hash(`${string(row?.uuid || row?.promptId)}\0${index}`)}`,
      kind,
      name: string(block.name || block.fileName || block.filename).trim() || (kind === "image" ? "Image" : `Attachment ${index + 1}`),
      mimeType: mimeType || null,
      size: Number.isFinite(Number(block.size ?? block.bytes)) ? Math.max(0, Number(block.size ?? block.bytes)) : null,
      path: null,
      url: null,
    };
  });
}

function internalRelayPrompt(value) {
  const body = string(value).trim();
  return /^<relay-envelope>/i.test(body)
    || /^<relay-documents>/i.test(body)
    || /<relay-runtime-contract>/i.test(body);
}

function isHumanPrompt(row) {
  if (row?.type !== "user" || hasToolResult(row)) return false;
  if (row.isCompactSummary || row.isVisibleInTranscriptOnly || row.isMeta) return false;
  if (row.sourceToolAssistantUUID || row.toolUseResult) return false;
  if (["task-notification", "hook", "system", "compact-summary"].includes(string(row?.origin?.kind))) return false;
  const body = textContent(row.message?.content);
  if ((!body && !hasUserAttachment(row)) || internalRelayPrompt(body) || /<task-notification>[\s\S]*<\/task-notification>/i.test(body)) return false;
  return true;
}

function stableNativeCoordinate(row) {
  const event = row?.event || {};
  const timestamp = string(row?.timestamp ?? event.timestamp);
  const offset = string(
    row?.nativeOffset ?? row?.native_offset ?? row?.offset ?? row?.sequence ?? row?.sequence_num
    ?? event.nativeOffset ?? event.native_offset ?? event.offset ?? event.sequence ?? event.sequence_num,
  );
  return `${timestamp}|${offset}|${string(row?.event_id ?? event.id)}`;
}

function rowKey(row) {
  if (row?.uuid) return `uuid:${row.uuid}`;
  if (row?.event_id) return `event:${row.event_id}`;
  if (row?.type === "stream_event") {
    const event = row.event || {};
    const request = row.requestId || row.request_id || event.requestId || event.request_id || "";
    const identity = event.message?.id || row.message?.id || "";
    const block = event.index ?? event.content_block?.id ?? "";
    const coordinate = stableNativeCoordinate(row);
    const delta = event.delta?.text ?? event.content_block?.text ?? event.delta?.type ?? "";
    return `stream:${request}:${identity}:${block}:${event.type}:${coordinate}:${hash(delta)}`;
  }
  return `row:${row?.type || "unknown"}:${hash(JSON.stringify(row || {}))}`;
}

function canonicalClaudeDagRows(inputRows) {
  const rows = Array.isArray(inputRows) ? inputRows : [];
  const latestPrompt = rows.findLast((row) => row?.type === "last-prompt" && string(row.leafUuid));
  const byUuid = new Map(rows.filter((row) => string(row?.uuid)).map((row) => [string(row.uuid), row]));
  const chain = new Set();
  let cursor = string(latestPrompt?.leafUuid);
  if (!cursor) cursor = string(rows.findLast((row) => isHumanPrompt(row))?.uuid);
  if (!cursor) return rows.filter((row) => row?.type !== "last-prompt");
  if (!latestPrompt) {
    const children = new Map();
    for (const row of rows) {
      const parent = string(row?.parentUuid);
      const uuid = string(row?.uuid);
      if (!parent || !uuid || !["user", "assistant", "system", "attachment"].includes(string(row?.type))) continue;
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(uuid);
    }
    if (![...children.values()].some((set) => set.size > 1)) {
      return rows.filter((row) => row?.type !== "last-prompt");
    }
  }
  while (cursor && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = string(byUuid.get(cursor)?.parentUuid);
  }
  // Without a persisted last-prompt leaf, the newest genuine human prompt is
  // the authoritative branch anchor. Keep its ancestors and every descendant
  // on that branch; a later-written stale sibling cannot replace its answer.
  if (!latestPrompt) {
    const descendants = new Set([string(rows.findLast((row) => isHumanPrompt(row))?.uuid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const uuid = string(row?.uuid);
        if (!uuid || descendants.has(uuid) || !descendants.has(string(row?.parentUuid))) continue;
        descendants.add(uuid);
        chain.add(uuid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => {
    if (row?.type === "last-prompt") return false;
    const uuid = string(row?.uuid);
    // Stream-json transport records generally have no transcript UUID. Their
    // request/message identity is reconciled against the selected transcript
    // branch later; UUID-bearing persisted records must be on the canonical
    // ancestor path and can never win merely because they occur later.
    const dagRecord = ["user", "assistant", "system", "attachment"].includes(string(row?.type));
    return !dagRecord || !uuid || chain.has(uuid);
  });
}

function itemId(turn, kind, nativeId, ordinal = 0) {
  return `claude:${kind}:${hash(`${turn.id}\0${nativeId || ordinal}`)}`;
}

function nativeToolInput(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function questionText(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const parts = [];
  for (const question of questions.slice(0, 3)) {
    const prompt = string(question?.question || question?.prompt || question?.header).trim();
    const options = Array.isArray(question?.options)
      ? question.options.slice(0, 8).map((option) => string(option?.label || option).trim()).filter(Boolean)
      : [];
    if (prompt) parts.push(options.length ? `${prompt} ${options.join(" · ")}` : prompt);
  }
  return parts.join("\n") || string(input?.question || input?.prompt || "Claude needs your input.");
}

function backgroundUpdate(row) {
  const started = [];
  const finished = [];
  const direct = row?.toolUseResult?.backgroundTaskId
    || row?.tool_use_result?.backgroundTaskId
    || row?.tool_use_result?.background_task_id;
  if (direct) started.push(string(direct));
  const body = textContent(row?.message?.content);
  const start = body.match(/background with ID:\s*([a-zA-Z0-9_-]+)/i);
  if (start) started.push(start[1]);
  for (const match of body.matchAll(/<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|stopped|cancelled)<\/status>[\s\S]*?<\/task-notification>/gi)) {
    finished.push({ id: match[1].trim(), status: match[2].toLowerCase() });
  }
  return { started: [...new Set(started)], finished };
}

function makeTurn(sessionId, seed, ordinal, startedAtMs, hiddenSeed = false) {
  return {
    id: `claude-turn:${hash(`${sessionId}\0${seed || ordinal}`)}`,
    ordinal,
    startedAtMs,
    completedAtMs: null,
    status: "inProgress",
    hiddenSeed,
    items: [],
    itemById: new Map(),
    toolByUseId: new Map(),
    backgroundById: new Map(),
    pendingBackground: new Set(),
    pendingRequests: new Set(),
    textSlots: [],
    currentStreamText: null,
    result: null,
    sawEndTurn: false,
    error: null,
  };
}

function addItem(turn, item) {
  const previous = turn.itemById.get(item.id);
  if (previous) {
    Object.assign(previous, item);
    return previous;
  }
  turn.itemById.set(item.id, item);
  turn.items.push(item);
  return item;
}

function finishPreviousTurn(turn, completedAtMs) {
  if (!turn || turn.status !== "inProgress") return;
  if (turn.pendingRequests.size || turn.pendingBackground.size) return;
  turn.status = turn.error ? "failed" : "completed";
  turn.completedAtMs = completedAtMs;
}

function nativeToolItem(turn, row, block, timestamp, activityGroup = null) {
  const toolUseId = string(block.id || `${row.uuid}:tool:${turn.items.length}`);
  const input = nativeToolInput(block.input);
  const requestId = string(row.requestId || row.request_id);
  const assistantUuid = string(row.uuid);
  const base = {
    id: itemId(turn, "tool", toolUseId),
    type: "claudeToolUse",
    status: "inProgress",
    startedAtMs: timestamp,
    completedAtMs: null,
    nativeProvider: "claude",
    nativeType: "tool_use",
    tool: string(block.name || "Tool"),
    toolUseId,
    input,
    requestId: requestId || null,
    promptId: string(row.promptId) || null,
    assistantUuid: assistantUuid || null,
    parentUuid: string(row.parentUuid) || null,
    activityGroup,
  };
  return addItem(turn, base);
}

function streamTextItem(turn, timestamp, messageId = "") {
  if (turn.currentStreamText) return turn.currentStreamText;
  const slot = turn.textSlots.length;
  const item = addItem(turn, {
    id: itemId(turn, "text", slot),
    type: "assistantText",
    text: "",
    phase: "commentary",
    status: "inProgress",
    startedAtMs: timestamp,
    completedAtMs: null,
    nativeProvider: "claude",
    nativeType: "text_delta",
    messageId: messageId || null,
    authoritative: false,
  });
  turn.textSlots.push(item);
  turn.currentStreamText = item;
  return item;
}

function authoritativeTextItem(turn, row, block, timestamp) {
  const body = string(block.text);
  const messageId = string(row.message?.id);
  let item = turn.textSlots.find((candidate) => candidate.authoritative
    && candidate.text === body
    && (!messageId || !candidate.messageId || candidate.messageId === messageId));
  if (!item) item = turn.textSlots.find((candidate) => !candidate.authoritative
    && (candidate.text === body || body.startsWith(candidate.text) || candidate.text.startsWith(body)));
  if (!item) {
    const slot = turn.textSlots.length;
    item = addItem(turn, {
      id: itemId(turn, "text", slot),
      type: "assistantText",
      startedAtMs: timestamp,
    });
    turn.textSlots.push(item);
  }
  Object.assign(item, {
    text: body,
    phase: row.message?.stop_reason === "end_turn" ? "final_candidate" : "commentary",
    status: "completed",
    completedAtMs: timestamp,
    nativeProvider: "claude",
    nativeType: "text",
    assistantUuid: string(row.uuid) || null,
    parentUuid: string(row.parentUuid) || null,
    requestId: string(row.requestId || row.request_id) || null,
    messageId: string(row.message?.id) || item.messageId || null,
    stopReason: string(row.message?.stop_reason) || null,
    authoritative: true,
  });
  if (turn.currentStreamText === item) turn.currentStreamText = null;
  if (row.message?.stop_reason === "end_turn") turn.sawEndTurn = true;
  return item;
}

function parseClaudeRows(inputRows, options) {
  const sessionId = string(options.sessionId || "claude");
  const rows = [];
  const seen = new Set();
  const allRows = canonicalClaudeDagRows(inputRows);
  const cutoff = Math.max(0, allRows.length - MAX_ROWS * 2);
  const selectedRows = allRows.slice(cutoff);
  if (cutoff > 0) {
    const boundary = allRows.slice(0, cutoff).findLast((row) => isHumanPrompt(row));
    if (boundary) selectedRows.unshift(boundary);
  }
  for (const [index, row] of selectedRows.entries()) {
    if (!row || typeof row !== "object" || row.isSidechain === true) continue;
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ row, index });
  }

  const turns = [];
  const toolIndex = new Map();
  const backgroundIndex = new Map();
  let current = null;
  let lastAt = null;
  const ensureTurn = (row, timestamp, hiddenSeed = false) => {
    if (!current) {
      current = makeTurn(sessionId, row?.uuid || row?.promptId || `seed:${turns.length}`, turns.length, timestamp, hiddenSeed);
      turns.push(current);
    }
    return current;
  };

  for (const { row, index } of rows) {
    const timestamp = atMs(row.timestamp, lastAt == null ? index : lastAt + 1);
    lastAt = timestamp;

    if (isHumanPrompt(row)) {
      finishPreviousTurn(current, timestamp);
      current = makeTurn(sessionId, row.uuid || row.promptId || `human:${turns.length}`, turns.length, timestamp, false);
      turns.push(current);
      addItem(current, {
        id: itemId(current, "user", row.uuid || row.promptId || index),
        type: "human",
        text: textContent(row.message?.content),
        status: "completed",
        startedAtMs: timestamp,
        completedAtMs: timestamp,
        nativeProvider: "claude",
        nativeType: "user",
        uuid: string(row.uuid) || null,
        promptId: string(row.promptId) || null,
        parentUuid: string(row.parentUuid) || null,
        attachments: safeClaudeUserAttachments(row),
      });
      continue;
    }

    if (row.type === "user") {
      const turn = ensureTurn(row, timestamp, true);
      const update = backgroundUpdate(row);
      for (const backgroundId of update.started) {
        const tool = contentBlocks(row).find((block) => block?.type === "tool_result")?.tool_use_id;
        const indexed = toolIndex.get(string(tool));
        if (indexed) {
          indexed.turn.pendingBackground.add(backgroundId);
          indexed.turn.backgroundById.set(backgroundId, indexed.item);
          backgroundIndex.set(backgroundId, indexed);
        }
      }
      for (const finished of update.finished) {
        const indexed = backgroundIndex.get(finished.id) || { turn, item: turn.backgroundById.get(finished.id) };
        if (!indexed?.item) continue;
        indexed.turn.pendingBackground.delete(finished.id);
        indexed.item.status = finished.status === "completed" ? "completed" : "failed";
        indexed.item.completedAtMs = timestamp;
        if (finished.status !== "completed") indexed.turn.error ||= { message: `Background work ${finished.status}.`, code: "CLAUDE_BACKGROUND_FAILED" };
      }
      for (const block of contentBlocks(row)) {
        if (block?.type !== "tool_result") continue;
        const indexed = toolIndex.get(string(block.tool_use_id));
        if (!indexed) continue;
        const isError = Boolean(block.is_error || row.toolDenialKind || row.interruptedByShutdown);
        const background = update.started.length > 0;
        if (!background) {
          indexed.item.status = isError ? "failed" : "completed";
          indexed.item.completedAtMs = timestamp;
        }
        indexed.item.nativeResult = {
          nativeType: "tool_result",
          toolUseId: string(block.tool_use_id),
          sourceToolAssistantUUID: string(row.sourceToolAssistantUUID) || null,
          isError,
          denialKind: string(row.toolDenialKind) || null,
        };
        if (indexed.item.tool === "AskUserQuestion") {
          indexed.turn.pendingRequests.delete(indexed.item.toolUseId);
          indexed.item.resolvedAtMs = timestamp;
        }
        if (isError) {
          const detail = textContent(block.content) || string(block.content) || "Tool use was rejected.";
          indexed.turn.error ||= { message: detail, code: row.toolDenialKind || "CLAUDE_TOOL_FAILED" };
          addItem(indexed.turn, {
            id: itemId(indexed.turn, "tool-error", block.tool_use_id),
            type: "error",
            text: detail,
            status: "completed",
            startedAtMs: timestamp,
            completedAtMs: timestamp,
          });
        }
      }
      continue;
    }

    if (row.type === "assistant") {
      const turn = ensureTurn(row, timestamp, true);
      // Claude can serialize a terminal provider failure as an assistant row:
      // the readable failure lives in a text block while `error` carries the
      // machine code (for example `authentication_failed`). It is not
      // assistant commentary. Projecting both made Work render the same
      // failure as prose and again as a provider error.
      const nativeError = string(row.error || row.message?.error);
      if (nativeError) {
        const detail = contentBlocks(row)
          .filter((block) => block?.type === "text")
          .map((block) => string(block.text))
          .filter(Boolean)
          .join("\n\n") || nativeError;
        turn.error ||= { message: detail, code: nativeError };
        addItem(turn, {
          id: itemId(turn, "error", row.uuid || row.message?.id || index),
          type: "error",
          text: detail,
          status: "completed",
          startedAtMs: timestamp,
          completedAtMs: timestamp,
          nativeProvider: "claude",
          nativeType: "assistant_error",
          errorCode: nativeError,
        });
        continue;
      }
      const toolBlocks = contentBlocks(row).filter((block) => block?.type === "tool_use");
      const activityGroup = toolBlocks.length > 1 ? `claude-tools:${string(row.uuid || row.message?.id || index)}` : null;
      for (const block of contentBlocks(row)) {
        if (!block || block.type === "thinking" || block.type === "redacted_thinking" || block.type === "signature") continue;
        if (block.type === "text" && block.text) authoritativeTextItem(turn, row, block, timestamp);
        if (block.type === "tool_use") {
          const item = nativeToolItem(turn, row, block, timestamp, activityGroup);
          toolIndex.set(item.toolUseId, { turn, item });
          if (item.tool === "AskUserQuestion") {
            turn.pendingRequests.add(item.toolUseId);
            item.question = questionText(item.input);
          }
        }
      }
      continue;
    }

    if (row.type === "stream_event") {
      const turn = ensureTurn(row, timestamp, true);
      const stream = row.event || {};
      if (stream.type === "message_start") turn.currentStreamText = null;
      if (stream.type === "content_block_start" && stream.content_block?.type === "text") {
        const item = streamTextItem(turn, timestamp, stream.message?.id);
        item.text += string(stream.content_block.text);
      }
      if (stream.type === "content_block_delta" && stream.delta?.type === "text_delta") {
        const item = streamTextItem(turn, timestamp, stream.message?.id);
        item.text += string(stream.delta.text);
      }
      if (stream.type === "message_stop") turn.currentStreamText = null;
      continue;
    }

    if (row.type === "system") {
      const turn = ensureTurn(row, timestamp, true);
      const subtype = string(row.subtype).toLowerCase();
      if (subtype === "api_error") {
        const attempt = Number(row.retryAttempt || 1);
        const maxRetries = Number(row.maxRetries || attempt);
        addItem(turn, {
          id: itemId(turn, "retry", row.uuid || `${attempt}:${timestamp}`),
          type: "retry",
          text: `Reconnecting ${attempt}/${Math.max(attempt, maxRetries)}`,
          status: "completed",
          startedAtMs: timestamp,
          completedAtMs: timestamp,
          nativeProvider: "claude",
          nativeType: "api_error",
          retryAttempt: attempt,
          maxRetries,
        });
        if (attempt >= maxRetries) turn.error ||= { message: string(row.error || "Claude could not reconnect."), code: "CLAUDE_RETRY_EXHAUSTED" };
      } else if (subtype === "compact_boundary" || subtype === "context_compaction") {
        addItem(turn, {
          id: itemId(turn, "compaction", row.uuid || timestamp),
          type: "compaction",
          text: "Context compacted",
          status: "completed",
          startedAtMs: timestamp,
          completedAtMs: timestamp,
          nativeProvider: "claude",
          nativeType: subtype,
        });
      } else if (/permission.*request/.test(subtype)) {
        const requestId = string(row.requestId || row.uuid || `permission:${timestamp}`);
        turn.pendingRequests.add(requestId);
        addItem(turn, {
          id: itemId(turn, "permission", requestId),
          type: "permission",
          requestId,
          text: string(row.question || row.prompt || row.reason || "Claude needs permission to continue."),
          status: "pending",
          startedAtMs: timestamp,
          completedAtMs: null,
          nativeProvider: "claude",
          nativeType: subtype,
        });
      }
      continue;
    }

    if (row.type === "permission-request" || row.type === "permission_request") {
      const turn = ensureTurn(row, timestamp, true);
      const requestId = string(row.requestId || row.uuid || `permission:${timestamp}`);
      turn.pendingRequests.add(requestId);
      addItem(turn, {
        id: itemId(turn, "permission", requestId),
        type: "permission",
        requestId,
        text: string(row.question || row.prompt || row.reason || "Claude needs permission to continue."),
        status: "pending",
        startedAtMs: timestamp,
        completedAtMs: null,
        nativeProvider: "claude",
        nativeType: row.type,
      });
      continue;
    }

    if (row.type === "result") {
      const turn = ensureTurn(row, timestamp, true);
      turn.result = row;
      const failed = Boolean(row.is_error) || ["error", "failed"].includes(string(row.subtype).toLowerCase());
      if (failed) {
        const message = string(row.result || row.error || row.message || `Claude ended ${row.terminal_reason || row.subtype || "with an error"}.`);
        turn.error = { message, code: string(row.terminal_reason || row.subtype || "CLAUDE_RESULT_ERROR") };
        addItem(turn, {
          id: itemId(turn, "result-error", row.uuid || timestamp),
          type: "error",
          text: message,
          status: "completed",
          startedAtMs: timestamp,
          completedAtMs: timestamp,
        });
        turn.status = "failed";
        turn.completedAtMs = timestamp;
      } else if (!turn.pendingBackground.size && !turn.pendingRequests.size && string(row.stop_reason) !== "tool_use") {
        const resultText = string(row.result).trim();
        const resultItem = resultText
          ? turn.textSlots.findLast((item) => item.text.trim() === resultText)
          : turn.textSlots.findLast((item) => item.text.trim());
        if (resultItem && !resultItem.stopReason) {
          resultItem.stopReason = "end_turn";
          resultItem.authoritative = true;
          resultItem.status = "completed";
          resultItem.completedAtMs = timestamp;
          turn.sawEndTurn = true;
        }
        turn.status = "completed";
        turn.completedAtMs = timestamp;
      }
    }
  }

  const latest = turns.at(-1);
  if (latest?.status === "inProgress" && !latest.pendingBackground.size && !latest.pendingRequests.size) {
    // A provider-authored end_turn is terminal truth even when the Task itself
    // remains open. Task lifecycle and native-turn lifecycle are independent;
    // using an open Task as expectedActive previously converted a successful
    // turn into CLAUDE_OWNER_DETACHED after the worker exited normally.
    if (!options.ownerAlive && latest.sawEndTurn && !latest.error) {
      latest.status = "completed";
      latest.completedAtMs = lastAt;
    } else if (!options.ownerAlive && options.expectedActive) {
      latest.error ||= { message: "Claude Code is no longer connected. Restart this turn to continue.", code: "CLAUDE_OWNER_DETACHED" };
      addItem(latest, {
        id: itemId(latest, "detached", latest.id),
        type: "error",
        text: latest.error.message,
        status: "completed",
        startedAtMs: lastAt,
        completedAtMs: lastAt,
      });
      latest.status = "failed";
      latest.completedAtMs = lastAt;
    }
  }

  for (const turn of turns) {
    const terminal = turn.status === "completed";
    const candidates = turn.textSlots.filter((item) => item.authoritative && item.stopReason === "end_turn" && item.text.trim());
    const final = terminal ? candidates.at(-1) : null;
    for (const item of turn.textSlots) item.phase = item === final ? "final_answer" : "commentary";
  }
  return turns;
}

function canonicalEvents(turns) {
  const events = [];
  for (const turn of turns.slice(-20)) {
    events.push({
      eventId: `${turn.id}:started`, method: "turn/started", emittedAtMs: turn.startedAtMs,
      params: { turnId: turn.id, startedAtMs: turn.startedAtMs },
    });
    for (const item of turn.items) {
      if (item.type === "human") {
        events.push({
          eventId: `${item.id}:completed`, method: "item/completed", emittedAtMs: item.completedAtMs,
          params: { turnId: turn.id, completedAtMs: item.completedAtMs, item: { ...item, type: "userMessage" } },
        });
      } else if (item.type === "assistantText") {
        if (!item.text) continue;
        const lifecycle = item.status === "completed" ? "completed" : "started";
        events.push({
          eventId: `${item.id}:${lifecycle}:${item.phase}:${hash(item.text)}`, method: `item/${lifecycle}`, emittedAtMs: item.completedAtMs ?? item.startedAtMs,
          params: {
            turnId: turn.id,
            [lifecycle === "completed" ? "completedAtMs" : "startedAtMs"]: item.completedAtMs ?? item.startedAtMs,
            item: { ...item, type: "agentMessage" },
          },
        });
      } else if (item.type === "claudeToolUse") {
        if (item.tool === "AskUserQuestion") {
          events.push({
            eventId: `${item.id}:request`, method: "claude/requestUserInput", emittedAtMs: item.startedAtMs,
            params: { turnId: turn.id, requestId: item.toolUseId, question: item.question, native: item },
          });
          if (item.resolvedAtMs != null) events.push({
            eventId: `${item.id}:resolved`, method: "serverRequest/resolved", emittedAtMs: item.resolvedAtMs,
            params: { requestId: item.toolUseId, result: { answered: true } },
          });
          continue;
        }
        events.push({
          eventId: `${item.id}:started`, method: "item/started", emittedAtMs: item.startedAtMs,
          params: { turnId: turn.id, startedAtMs: item.startedAtMs, item: { ...item } },
        });
        if (["completed", "failed"].includes(item.status)) events.push({
          eventId: `${item.id}:completed:${item.status}`, method: "item/completed", emittedAtMs: item.completedAtMs,
          params: { turnId: turn.id, completedAtMs: item.completedAtMs, item: { ...item } },
        });
      } else if (item.type === "retry") {
        events.push({
          eventId: `${item.id}:completed`, method: "item/completed", emittedAtMs: item.completedAtMs,
          params: { turnId: turn.id, completedAtMs: item.completedAtMs, item: { ...item } },
        });
      } else if (item.type === "compaction") {
        events.push({
          eventId: `${item.id}:completed`, method: "item/completed", emittedAtMs: item.completedAtMs,
          params: { turnId: turn.id, completedAtMs: item.completedAtMs, item: { ...item, type: "contextCompaction" } },
        });
      } else if (item.type === "permission") {
        events.push({
          eventId: `${item.id}:request`, method: "claude/permissions/request", emittedAtMs: item.startedAtMs,
          params: { turnId: turn.id, requestId: item.requestId, question: item.text, native: item },
        });
      } else if (item.type === "error") {
        events.push({
          eventId: `${item.id}:error`, method: "error", emittedAtMs: item.completedAtMs,
          params: { turnId: turn.id, error: { message: item.text, code: turn.error?.code, willRetry: false } },
        });
      }
    }
    if (turn.status !== "inProgress") {
      events.push({
        eventId: `${turn.id}:completed:${turn.status}:${turn.completedAtMs}`,
        method: "turn/completed", emittedAtMs: turn.completedAtMs,
        params: {
          turnId: turn.id,
          completedAtMs: turn.completedAtMs,
          status: turn.status,
          ...(turn.error ? { error: turn.error } : {}),
        },
      });
    }
  }
  return events;
}

/**
 * Translate Claude Code's own stream-json/transcript event families without
 * routing them through the legacy provider-neutral transcript projection.
 */
export function claudeNativeEventsToWorkEvents(rows, options = {}) {
  return canonicalEvents(parseClaudeRows(rows, options));
}

/**
 * Incremental live reconciler. Persisted history is reduced once. Thereafter
 * only the current native turn is reparsed as its exact callback rows arrive;
 * completed history and the transcript file are never rescanned per token.
 */
export function createClaudeNativeWorkEventReconciler(initialRows = [], options = {}) {
  const source = canonicalClaudeDagRows(Array.isArray(initialRows) ? initialRows : []);
  let currentOptions = { ...options };
  let baseline = claudeNativeEventsToWorkEvents(source, currentOptions);
  const emitted = new Set(baseline.map((event) => event.eventId));
  const lastHuman = source.findLastIndex((row) => isHumanPrompt(row));
  let currentRows = source.slice(Math.max(0, lastHuman));

  return {
    snapshotEvents() {
      return baseline.slice();
    },
    push(row, nextOptions = {}) {
      if (!row || typeof row !== "object") return [];
      currentOptions = { ...currentOptions, ...nextOptions };
      const humanBoundary = isHumanPrompt(row);
      currentRows.push(row);
      if (currentRows.length > MAX_ROWS) currentRows = currentRows.slice(-MAX_ROWS);
      const events = claudeNativeEventsToWorkEvents(currentRows, currentOptions);
      const fresh = [];
      for (const event of events) {
        if (emitted.has(event.eventId)) continue;
        emitted.add(event.eventId);
        fresh.push(event);
      }
      // Parse the boundary together with the preceding live turn once so its
      // end-turn text can transition from commentary to final and the turn can
      // settle. Subsequent rows only need the new native turn.
      if (humanBoundary) currentRows = [row];
      return fresh;
    },
  };
}

/** Read a bounded chronological tail of the native Claude transcript. */
export function readClaudeNativeTranscriptRows(filePath, {
  maxRows = MAX_ROWS,
  maxBytes = MAX_TRANSCRIPT_BYTES,
} = {}) {
  const target = string(filePath);
  if (!target) return [];
  let fd;
  try {
    fd = fs.openSync(target, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, Math.max(1, Number(maxBytes) || MAX_TRANSCRIPT_BYTES));
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let source = buffer.toString("utf8");
    if (start > 0) source = source.slice(Math.max(0, source.indexOf("\n") + 1));
    const parsed = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try { parsed.push(JSON.parse(line)); } catch {}
    }
    const limit = Math.max(1, Number(maxRows) || MAX_ROWS);
    if (parsed.length <= limit) return parsed;
    const tail = parsed.slice(-limit);
    const boundary = parsed.slice(0, -limit).findLast((row) => isHumanPrompt(row));
    return boundary ? [boundary, ...tail] : tail;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
