// Cowork is intentionally disabled. This module retains only pure historical
// event projection so an already-recorded session can be explained without
// reading a browser cookie, process environment, token cache, or Keychain.

function disabled() {
  throw new Error("Claude Cowork is temporarily unavailable in Relay.");
}

export async function listCoworkSessions() { return disabled(); }
export async function discoverCoworkConnectorProfile() { return disabled(); }
export async function createAndSeedCoworkSession() { return disabled(); }
export async function readCoworkSession() { return disabled(); }
export async function appendCoworkMessage() { return disabled(); }
export async function archiveCoworkSession() { return disabled(); }

export function selectCoworkEnvironment() { return ""; }

export function coworkSessionLifecycle(session, events) {
  const actual = String(session?.status || "").toLowerCase();
  const bucket = String(session?.status_bucket || "").toLowerCase();
  const rows = Array.isArray(events) ? events : [];
  const lastUserIndex = rows.findLastIndex((event) => {
    const payload = event?.payload || event || {};
    return payload.type === "user" || event?.event_type === "user";
  });
  const resultIndex = rows.findLastIndex((event) => {
    const payload = event?.payload || event || {};
    return payload.type === "result" || event?.event_type === "result";
  });
  const result = resultIndex > lastUserIndex ? rows[resultIndex] : null;
  const resultPayload = result?.payload || result || {};
  if (result) {
    const failed = Boolean(resultPayload.is_error) || ["error", "failed"].includes(String(resultPayload.subtype || "").toLowerCase());
    return {
      liveState: failed ? "failed" : "completed",
      terminal: true,
      endedAt: resultPayload.timestamp || resultPayload.created_at || result?.created_at || session?.updated_at || session?.last_activity_at || null,
    };
  }
  if (["active", "working", "starting", "queued"].includes(actual)) return { liveState: "working", terminal: false, endedAt: null };
  const terminal = ["review_ready", "completed", "failed", "idle", "archived", "stopped", "blocked"].includes(actual)
    ? actual
    : ["completed", "failed", "idle", "archived", "stopped", "blocked"].includes(bucket) ? bucket : "";
  return terminal
    ? { liveState: terminal, terminal: true, endedAt: session?.updated_at || session?.last_activity_at || null }
    : { liveState: actual || bucket || "unknown", terminal: false, endedAt: null };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text").map((block) => String(block.text || "")).join("\n");
}

export function coworkFinalAssistantText(events) {
  const rows = Array.isArray(events) ? events : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const payload = rows[index]?.payload || rows[index] || {};
    if (payload.type !== "assistant" || !payload.message) continue;
    const text = textFromContent(payload.message.content).trim();
    if (text) return text;
  }
  return "";
}

export function coworkEventsToRecords(events) {
  const records = [];
  let lastAssistantText = "";
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event?.payload || event || {};
    const at = payload.timestamp || payload.created_at || event?.created_at || null;
    if (["user", "assistant"].includes(payload.type) && payload.message) {
      const text = textFromContent(payload.message.content);
      if (text) {
        const role = payload.message.role || payload.type;
        records.push({ type: "message", role, text, at });
        if (role === "assistant") lastAssistantText = text.trim();
      }
      for (const block of Array.isArray(payload.message.content) ? payload.message.content : []) {
        if (block?.type === "tool_use") records.push({ type: "tool_call", tool: String(block.name || "tool"), input: JSON.stringify(block.input || {}), at });
        if (block?.type === "tool_result") records.push({ type: "tool_result", output: textFromContent(block.content) || String(block.content || ""), isError: Boolean(block.is_error), at });
      }
    } else if (["env_manager_log", "system", "rate_limit_event", "result"].includes(payload.type)) {
      const text = payload?.data?.content || payload.message || payload.status_detail || payload.text || payload.error || payload.result || "";
      const normalized = typeof text === "string" ? text.trim() : "";
      if (normalized && !(payload.type === "result" && normalized === lastAssistantText)) records.push({ type: "progress", text: normalized, at });
    }
  }
  return records.reverse();
}
