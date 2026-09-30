// One turn in an existing Codex thread through a private, short-lived
// `codex app-server`, for Codex Desktop builds whose window Relay can no longer
// drive (see requestCodexInspector in codex-desktop.js).
//
// Codex allows one writer per thread (~/.codex/thread-writer-locks). Desktop
// takes that lock when a thread is opened in its window and keeps it until the
// app quits, so this route only reaches threads the person has not opened in
// this app session. On a thread Desktop holds, thread/resume fails with
// "already has an active writer" before anything is written: a clean,
// definitive refusal (THREAD_OPEN_IN_DESKTOP) rather than a possible duplicate.
//
// The private server holds the lock only while its turn runs, then exits so
// Desktop can open the thread normally.

import { CodexAppServerClient } from "./codex-app-server.js";

export const THREAD_OPEN_IN_DESKTOP = "thread-open-in-desktop";
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1_000;

function message(error) {
  return String(error?.message || error || "");
}

export async function submitCodexTurnPrivately({
  threadId,
  text,
  cwd = process.cwd(),
  turnTimeoutMs = Number(process.env.RELAY_CODEX_PRIVATE_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS),
  createClient = (options) => new CodexAppServerClient(options),
  log = () => {},
} = {}) {
  const cleanThreadId = String(threadId || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanThreadId || !cleanText) return { submitted: false, reason: "missing-thread-or-text" };

  const client = createClient({ cwd });
  try {
    await client.start();
  } catch (error) {
    return { submitted: false, reason: "private-app-server-unavailable", error: message(error) };
  }

  let handedOff = false;
  try {
    try {
      await client.request("thread/resume", { threadId: cleanThreadId, cwd, excludeTurns: false });
    } catch (error) {
      if (/already has an active writer/i.test(message(error))) return { submitted: false, reason: THREAD_OPEN_IN_DESKTOP };
      return { submitted: false, reason: "thread-resume-failed", error: message(error) };
    }
    const started = await client.request("turn/start", {
      threadId: cleanThreadId,
      input: [{ type: "text", text: cleanText, text_elements: [] }],
    });
    const turnId = String(started?.turn?.id || started?.turnId || "");
    // The turn runs inside this server, so it must outlive the caller's return.
    // It stops (and releases the thread) when the turn completes or times out.
    const finished = client.waitForNotification(
      (note) => note?.method === "turn/completed" && (!turnId || note?.params?.turn?.id === turnId),
      { timeoutMs: turnTimeoutMs },
    ).then(() => true, () => false).then(async (completed) => {
      if (!completed) {
        log(`private Codex turn in ${cleanThreadId} did not complete within ${turnTimeoutMs}ms; stopping it`);
        await client.request("turn/interrupt", { threadId: cleanThreadId, turnId }).catch(() => {});
      }
      await client.stop();
      return completed;
    });
    handedOff = true;
    return { submitted: true, turnId, finished };
  } catch (error) {
    return { submitted: false, reason: "private-turn-failed", error: message(error) };
  } finally {
    if (!handedOff) await client.stop().catch(() => {});
  }
}
