import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./host-paths.js";

const contexts = new AsyncLocalStorage();
export const readContext = () => contexts.getStore();
export const CHAT_READ_TOOLS = new Set(["relay_chat_fetch", "relay_thread_fetch", "relay_chats_list", "relay_inbox_list", "relay_sent_list"]);

export function readTimeout() {
  return Object.assign(new Error("Relay could not finish this read within its time budget. Retry the read; for an inbound Relay, fetch it with relay_inbox_list relayIds. For a conversation, request a smaller limit and continue with its cursors."),
    { code: "relay_timeout", retryable: true });
}

/** Fixed fields only: never write arguments, message bodies, URLs, tokens or account IDs. */
export function recordReadTiming(event) {
  const context = readContext();
  if (!context) return;
  const record = { at: new Date().toISOString(), requestId: context.requestId, tool: context.tool, ...event };
  try {
    if (context.record) { context.record(record); return; }
    const file = path.join(storeDir(), "logs", "reads.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must not break messaging. */ }
}

export async function withReadContext(tool, fn, { signal, budgetMs = 24_000, record } = {}) {
  const context = { tool, requestId: randomUUID(), deadline: Date.now() + budgetMs,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs), record };
  return contexts.run(context, async () => {
    const started = performance.now();
    let onAbort;
    try {
      context.signal.throwIfAborted();
      // A slow initialization step may not observe the signal itself. Return on
      // cancellation regardless; downstream HTTP still receives the same signal.
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(context.signal.reason);
        context.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(fn), aborted]);
      context.signal.throwIfAborted();
      const serializeAt = performance.now();
      const bytes = Buffer.byteLength(JSON.stringify(result));
      recordReadTiming({ phase: "tool", outcome: "success", elapsedMs: Math.round(performance.now() - started),
        envelopeSerializationMs: Math.round(performance.now() - serializeAt), responseBytes: bytes });
      return result;
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const timedOut = context.signal.aborted || error?.name === "TimeoutError" || error?.code === "relay_timeout";
      recordReadTiming({ phase: "tool", outcome: cancelled ? "cancelled" : timedOut ? "timeout" : "error", elapsedMs: Math.round(performance.now() - started) });
      if (cancelled) throw Object.assign(new Error("The caller cancelled this Relay read."), { code: "relay_cancelled", retryable: false, requestId: context.requestId });
      if (timedOut) throw Object.assign(readTimeout(), { requestId: context.requestId });
      throw error;
    } finally {
      if (onAbort) context.signal.removeEventListener("abort", onAbort);
    }
  });
}
