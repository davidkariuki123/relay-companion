// `relay claude-hook` — the Claude Code hook runtime behind Open-in-current-chat.
//
// Installed into ~/.claude/settings.json for PostToolUse / Stop /
// UserPromptSubmit / SessionStart (see install.js installClaudeHooks; settings
// hooks hot-reload in Claude Code, so no restart is needed after install).
// Claude invokes it with the hook event JSON on stdin:
//   { hook_event_name, session_id, cwd, transcript_path, ... }
//
// Behavior:
//   1. ALWAYS append/refresh the rendezvous file
//      RELAY_HOME/claude-sessions/<session_id>.json — this is how the pill
//      finds the user's live session (terminal Claude Code has no desktop
//      metadata, so the rendezvous is its only presence signal).
//   2. If a pending injection exists for THIS session (or the any.json
//      broadcast), consume it once (atomic rename-then-read) and emit the
//      event-appropriate JSON on stdout:
//        PostToolUse / UserPromptSubmit / SessionStart ->
//          {"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<instruction>}}
//        Stop -> {"decision":"block","reason":<instruction>}  (wakes a
//          just-finished session into a new turn)
//      Unknown/other events exit 0 silently and never consume the injection.
//
// FAILURE CONTRACT: this process must NEVER crash or emit garbage — a broken
// hook must never break the user's Claude session. Any error path exits 0 with
// no output.

import {
  consumeInjection,
  hookResponseFor,
  isDeliverableHookEvent,
  isSubagentHookEvent,
  owningClaudeCliPid,
  writeRendezvous,
} from "./claude-inject.cjs";
import { storeDir } from "./host-paths.js";
import { deviceToken } from "./config.js";
import agentRelayContext from "./agent-relay-context.cjs";

const { claimAgentRelayHookContext } = agentRelayContext;

const STDIN_TIMEOUT_MS = 2500;
const MAX_HOOK_INPUT_CHARS = 1_000_000;

function readAll(stream, timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(data || "");
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (data === null) return;
        if (data.length + chunk.length > MAX_HOOK_INPUT_CHARS) {
          // Keep draining the pipe so the host writer is never surprised by
          // EPIPE, but do not retain bug-controlled unbounded input.
          data = null;
          return;
        }
        data += chunk;
      });
      stream.on("end", () => {
        clearTimeout(timer);
        finish();
      });
      stream.on("error", () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export async function runClaudeHook({
  input = process.stdin,
  output = process.stdout,
  homeDir = storeDir(),
  accountScope = deviceToken(),
} = {}) {
  let relayClaim = null;
  try {
    const raw = await readAll(input);
    const event = JSON.parse(String(raw || ""));
    const sessionId = String((event && event.session_id) || "").trim();
    if (!sessionId) return;
    const eventName = String((event && event.hook_event_name) || "").trim();
    // Subagent events report the parent session id but run in a context the
    // user never sees: they must neither claim "this session is current"
    // (rendezvous) nor swallow a pending injection meant for the main loop.
    if (isSubagentHookEvent(event.transcript_path)) return;
    writeRendezvous(homeDir, sessionId, {
      cwd: event.cwd,
      transcriptPath: event.transcript_path,
      eventName,
      // This hook runs INSIDE the session, so its process tree reaches the CLI
      // that owns the chat — the identifier a channel wake is addressed to.
      cliPid: owningClaudeCliPid(),
    });
    // Only consume when this event can actually deliver the instruction —
    // consuming on an undeliverable event would silently lose the injection.
    if (!isDeliverableHookEvent(eventName)) return;
    const injection = consumeInjection(homeDir, sessionId);
    // The automatic title index is independent of the explicit click-to-open
    // injection. Contain its failure so advisory context can never suppress a
    // user's staged instruction.
    try {
      relayClaim = claimAgentRelayHookContext(homeDir, accountScope, {
        sessionId: `claude:${sessionId}`,
        eventName,
        stopHookActive: Boolean(event.stop_hook_active),
      });
    } catch {}
    const instruction = [injection?.instruction, relayClaim?.text].filter(Boolean).join("\n\n");
    if (!instruction) return;
    const response = hookResponseFor(eventName, instruction);
    if (!response) return;
    await new Promise((resolve, reject) => {
      try {
        output.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
    relayClaim?.commit();
  } catch {
    try { relayClaim?.rollback(); } catch {}
    // exit 0 with no output — see the failure contract above
  } finally {
    try {
      input.pause();
      if (typeof input.destroy === "function") input.destroy();
    } catch {}
  }
}
