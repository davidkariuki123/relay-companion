// Translate ACP updates once, at the boundary, into Relay's Work event model.
// The UI and persisted Work log never depend on a provider's wire format.
function withoutBinary(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (value.type === "image" || value.type === "audio") return { type: value.type, mimeType: value.mimeType };
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:blob|contentBase64|base64)$/i.test(key)).map(([key, entry]) => [key, withoutBinary(entry)]));
}
export class AcpWorkEvents {
  constructor({ sessionId, turnId, emit }) {
    Object.assign(this, { sessionId, turnId, emit });
    this.sequence = 0;
    this.items = new Map();
    this.text = "";
    this.messageIndex = 0;
    this.messageId = null;
  }
  event(method, params) {
    this.emit({ method, params: withoutBinary({ threadId: this.sessionId, turnId: this.turnId, ...params }), eventId: `${this.turnId}:${++this.sequence}`, emittedAtMs: Date.now() });
  }
  start(prompt) {
    this.event("turn/started", { turn: { id: this.turnId, status: "inProgress" } });
    this.event("item/completed", { item: { id: `${this.turnId}:user`, type: "userMessage", content: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt } });
  }
  finishMessage() {
    if (!this.messageId) return;
    this.event("item/completed", { item: this.items.get(this.messageId) });
    this.messageId = null;
  }
  get finalText() {
    const item = this.items.get(`${this.turnId}:message:${this.messageIndex}`);
    return this.messageId || item?.phase === "final_answer" ? item?.text || "" : "";
  }
  update(update) {
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      if (!this.messageId) {
        this.messageId = `${this.turnId}:message:${++this.messageIndex}`;
        const item = { id: this.messageId, type: "agentMessage", phase: "commentary", text: "" };
        this.items.set(item.id, item);
        this.event("item/started", { item: { ...item } });
      }
      const delta = update.content.text;
      this.text += delta;
      this.items.get(this.messageId).text += delta;
      this.event("item/agentMessage/delta", { itemId: this.messageId, delta });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.finishMessage();
      const id = update.toolCallId;
      const previous = this.items.get(id);
      const item = {
        ...(previous || { id, type: "dynamicToolCall" }),
        ...(update.title != null ? { tool: update.title } : {}),
        ...(update.rawInput != null ? { arguments: update.rawInput } : {}),
        ...(update.content != null ? { content: update.content } : {}),
        ...(update.rawOutput != null ? { output: update.rawOutput } : {}),
        ...(update.status != null ? { status: update.status } : {}),
      };
      this.items.set(id, item);
      this.event(["completed", "failed"].includes(item.status) ? "item/completed" : "item/started", { item: { ...item } });
    } else if (update.sessionUpdate === "plan") {
      this.event("turn/plan/updated", { plan: (update.entries || []).map(entry => ({ step: entry.content, status: entry.status })) });
    }
  }
  finish(result, error) {
    if (!error && result?.stopReason === "end_turn" && this.messageId) this.items.get(this.messageId).phase = "final_answer";
    this.finishMessage();
    const status = error ? "failed" : result?.stopReason === "cancelled" ? "interrupted" : "completed";
    this.event("turn/completed", { turn: { id: this.turnId, status, ...(error ? { error: { message: error.message } } : {}) } });
  }
}
