import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./host-paths.js";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const DEFAULT_ITEM_CHARS = 12_000;
const MAX_ITEM_CHARS = 40_000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_CHARS = 700_000;
const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

function opaqueAgentId(provider, nativeId) {
  return `aiagent_${createHash("sha256").update(`${provider}\0${nativeId}`).digest("hex").slice(0, 24)}`;
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} characters]`;
}

function redactObject(value, maxChars) {
  const seen = new WeakSet();
  const scrub = (item, key = "") => {
    if (/token|secret|password|authorization|cookie|api[-_]?key/i.test(key)) return "[redacted]";
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => scrub(child));
    return Object.fromEntries(Object.entries(item).slice(0, 100).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
  };
  try {
    return truncate(JSON.stringify(scrub(value)), maxChars);
  } catch {
    return "[unavailable]";
  }
}

function textFromContent(content, maxChars) {
  if (typeof content === "string") return truncate(content, maxChars);
  if (!Array.isArray(content)) return "";
  return truncate(content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if (["text", "input_text", "output_text"].includes(block.type) && typeof block.text === "string") return [block.text];
    return [];
  }).join("\n"), maxChars);
}

function timestamp(row) {
  const value = row?.timestamp || row?.payload?.timestamp || row?.payload?.created_at || null;
  return typeof value === "string" ? value : null;
}

function normalizeClaude(row, maxChars) {
  if (!row || !["user", "assistant"].includes(row.type) || !row.message) return [];
  const role = row.message.role || row.type;
  const content = row.message.content;
  const records = [];
  const plain = textFromContent(content, maxChars);
  if (plain) records.push({ type: "message", role, text: plain, at: timestamp(row) });
  if (!Array.isArray(content)) return records;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") {
      records.push({
        type: "tool_call",
        tool: String(block.name || "tool"),
        input: redactObject(block.input ?? {}, maxChars),
        at: timestamp(row),
      });
    } else if (block.type === "tool_result") {
      const output = textFromContent(block.content, maxChars) || (typeof block.content === "string" ? truncate(block.content, maxChars) : redactObject(block.content, maxChars));
      records.push({ type: "tool_result", output, isError: Boolean(block.is_error), at: timestamp(row) });
    }
    // Deliberately exclude thinking/signature blocks. They are provider-private
    // reasoning artifacts, not user-visible transcript content.
  }
  return records;
}

function normalizeCodex(row, maxChars) {
  if (!row || typeof row !== "object") return [];
  if (row.type === "response_item") {
    const item = row.payload || {};
    if (item.type === "message" && ["user", "assistant"].includes(item.role)) {
      const text = textFromContent(item.content, maxChars);
      const attachments = Array.isArray(item.content)
        ? item.content.filter((block) => ["input_image", "image", "localImage"].includes(block?.type))
          .map(() => ({ name: "Image", image: true }))
        : [];
      return text || attachments.length ? [{ type: "message", role: item.role, text, attachments, at: timestamp(row) }] : [];
    }
    if (["function_call", "custom_tool_call", "tool_call"].includes(item.type)) {
      return [{
        type: "tool_call",
        tool: String(item.name || item.tool_name || item.call_id || "tool"),
        input: truncate(typeof item.arguments === "string" ? item.arguments : redactObject(item.arguments ?? item.input ?? {}, maxChars), maxChars),
        at: timestamp(row),
      }];
    }
    if (["function_call_output", "custom_tool_call_output", "tool_result"].includes(item.type)) {
      return [{ type: "tool_result", output: truncate(item.output ?? item.content ?? "", maxChars), at: timestamp(row) }];
    }
    // Reasoning summaries are intentionally not returned. Codex progress below
    // is the supported user-visible surface; encrypted reasoning never leaves.
    return [];
  }
  if (row.type === "event_msg") {
    const event = row.payload || {};
    if (["agent_reasoning", "task_started", "task_complete", "turn_aborted", "sub_agent_activity"].includes(event.type)) {
      const text = event.text || event.message || event.status || event.type.replaceAll("_", " ");
      return [{ type: "progress", text: truncate(text, maxChars), at: timestamp(row) }];
    }
  }
  return [];
}

function collectFiles(root, accept, maxFiles = 2000) {
  const found = [];
  const visit = (dir) => {
    if (found.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && accept(entry.name, full)) found.push(full);
    }
  };
  visit(root);
  return found;
}

function readFirstJsonLine(filePath, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    for (const line of buffer.toString("utf8").split("\n")) {
      try { return JSON.parse(line); } catch {}
    }
  } catch {}
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function claudeAgents(target) {
  const mainPath = String(target?.nativeRef?.transcriptPath || "");
  if (!mainPath || !fs.existsSync(mainPath)) throw new Error("Claude transcript is not available on this computer");
  const agents = [{ id: "main", provider: "claude", role: "orchestrator", parentId: null, status: target.state, filePath: mainPath }];
  const root = path.join(path.dirname(mainPath), path.basename(mainPath, ".jsonl"));
  for (const filePath of collectFiles(root, (name) => /^agent-.*\.jsonl$/.test(name))) {
    const nativeId = path.basename(filePath, ".jsonl").replace(/^agent-/, "");
    const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
    agents.push({
      id: opaqueAgentId("claude", nativeId),
      provider: "claude",
      role: String(meta.agentType || "subagent"),
      parentId: "main",
      depth: Number(meta.spawnDepth || 1),
      status: "recorded",
      filePath,
    });
  }
  return agents;
}

function codexMeta(filePath) {
  const row = readFirstJsonLine(filePath);
  const payload = row?.type === "session_meta" ? row.payload || {} : {};
  const source = payload.source?.subagent?.thread_spawn || payload.source?.subagent || {};
  return {
    nativeId: String(payload.id || payload.session_id || ""),
    parentNativeId: String(payload.parent_thread_id || source.parent_thread_id || ""),
    subagent: payload.thread_source === "subagent" || Boolean(payload.source?.subagent),
    role: String(payload.agent_nickname || payload.agent_path || "subagent"),
    depth: Number(source.depth || 1),
  };
}

function codexAgents(target) {
  const mainPath = String(target?.nativeRef?.sessionPath || "");
  if (!mainPath || !fs.existsSync(mainPath)) throw new Error("Codex transcript is not available on this computer");
  const mainNativeId = String(target.nativeId || target.nativeRef?.threadId || codexMeta(mainPath).nativeId);
  const found = collectFiles(path.join(codexHome(), "sessions"), (name) => name.endsWith(".jsonl"), 10_000);
  const metas = found.map((filePath) => ({ filePath, ...codexMeta(filePath) })).filter((row) => row.nativeId);
  const descendants = new Set([mainNativeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of metas) {
      if (row.subagent && descendants.has(row.parentNativeId) && !descendants.has(row.nativeId)) {
        descendants.add(row.nativeId);
        changed = true;
      }
    }
  }
  const idFor = (nativeId) => nativeId === mainNativeId ? "main" : opaqueAgentId("codex", nativeId);
  const agents = [{ id: "main", provider: "codex", role: "orchestrator", parentId: null, status: target.state, filePath: mainPath }];
  for (const row of metas.filter((item) => item.subagent && descendants.has(item.nativeId))) {
    agents.push({
      id: idFor(row.nativeId),
      provider: "codex",
      role: row.role,
      parentId: idFor(row.parentNativeId),
      depth: row.depth,
      status: "recorded",
      filePath: row.filePath,
    });
  }
  return agents;
}

function sessionAgents(target) {
  if (target.provider === "claude") return claudeAgents(target);
  if (target.provider === "codex") return codexAgents(target);
  throw new Error(`Unsupported AI-session provider: ${target.provider}`);
}

function encodeCursor(agentId, before) {
  return Buffer.from(JSON.stringify({ v: 1, agentId, before })).toString("base64url");
}

function decodeCursor(cursor, agentId, size) {
  if (!cursor) return size;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (parsed.v !== 1 || parsed.agentId !== agentId) throw new Error();
    return Math.max(0, Math.min(size, Number(parsed.before) || 0));
  } catch {
    throw new Error("Invalid transcript cursor");
  }
}

async function scanBackwards(filePath, { provider, agentId, cursor, limit, maxChars, query = "" }) {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const size = (await fd.stat()).size;
    let end = decodeCursor(cursor, agentId, size);
    let carry = Buffer.alloc(0);
    let droppingOversize = false;
    let scanned = 0;
    let skippedOversize = 0;
    let resultChars = 0;
    const records = [];
    const needle = query.toLocaleLowerCase();
    const rowNormalizer = provider === "claude"
      ? (row) => normalizeClaude(row, maxChars)
      : (row) => normalizeCodex(row, maxChars);

    while (end > 0 && scanned < MAX_SCAN_BYTES && records.length < limit) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      await fd.read(chunk, 0, chunk.length, start);
      scanned += chunk.length;
      let data = chunk;
      if (droppingOversize) {
        const boundary = data.lastIndexOf(0x0a);
        if (boundary < 0) { end = start; continue; }
        data = data.subarray(0, boundary + 1);
        droppingOversize = false;
      } else {
        data = Buffer.concat([data, carry]);
      }
      const newlines = [];
      for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) newlines.push(i);
      if (!newlines.length && start > 0) {
        if (data.length > MAX_LINE_BYTES) {
          carry = Buffer.alloc(0);
          droppingOversize = true;
          skippedOversize += 1;
        } else carry = data;
        end = start;
        continue;
      }
      const starts = [0, ...newlines.map((index) => index + 1)];
      const ends = [...newlines, data.length];
      const firstComplete = start === 0 ? 0 : 1;
      for (let i = starts.length - 1; i >= firstComplete && records.length < limit && resultChars < MAX_RESULT_CHARS; i -= 1) {
        const bytes = data.subarray(starts[i], ends[i]);
        if (!bytes.length) continue;
        if (bytes.length > MAX_LINE_BYTES) { skippedOversize += 1; continue; }
        let row;
        try { row = JSON.parse(bytes.toString("utf8")); } catch { continue; }
        const normalized = rowNormalizer(row, maxChars);
        for (let j = normalized.length - 1; j >= 0; j -= 1) {
          const record = normalized[j];
          const serialized = JSON.stringify(record);
          if (!needle || serialized.toLocaleLowerCase().includes(needle)) {
            if (records.length && resultChars + serialized.length > MAX_RESULT_CHARS) break;
            records.push(record);
            resultChars += serialized.length;
          }
        }
        if (records.length >= limit || resultChars >= MAX_RESULT_CHARS) {
          const before = start + starts[i];
          return { records, nextCursor: before > 0 ? encodeCursor(agentId, before) : null, scannedBytes: scanned, skippedOversize };
        }
      }
      carry = start === 0 ? Buffer.alloc(0) : data.subarray(0, newlines[0]);
      end = start;
    }
    return {
      records,
      nextCursor: end > 0 ? encodeCursor(agentId, end) : null,
      scannedBytes: scanned,
      skippedOversize,
      scanLimitReached: end > 0 && scanned >= MAX_SCAN_BYTES,
    };
  } finally {
    await fd.close();
  }
}

function publicAgent(agent) {
  const { filePath, ...safe } = agent;
  return safe;
}

/** Inspect one user-owned native Claude Code or Codex AI session. */
export async function inspectAiSession(target, input = {}) {
  const action = String(input.action || "read");
  const agents = sessionAgents(target);
  if (action === "agents") {
    return { aiSessionId: target.id, provider: target.provider, agents: agents.map(publicAgent) };
  }
  const agentId = String(input.agentId || "main");
  const agent = agents.find((row) => row.id === agentId);
  if (!agent) throw new Error("AI-session agent not found");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(input.limit) || DEFAULT_LIMIT));
  const maxChars = Math.min(MAX_ITEM_CHARS, Math.max(500, Number(input.maxCharsPerItem) || DEFAULT_ITEM_CHARS));
  const query = action === "search" ? String(input.query || "").trim() : "";
  if (action === "search" && !query) throw new Error("query is required for AI-session search");
  const page = await scanBackwards(agent.filePath, { provider: target.provider, agentId, cursor: input.cursor, limit, maxChars, query });
  return {
    aiSessionId: target.id,
    provider: target.provider,
    agent: publicAgent(agent),
    order: "newest_first",
    ...(query ? { query } : {}),
    ...page,
  };
}
