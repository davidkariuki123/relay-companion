// `relay codex-hook` — private, title-only recent Relay context for Codex.
// Every failure exits silently so an advisory hook can never break a turn.

import agentRelayContext from "./agent-relay-context.cjs";
import { deviceToken } from "./config.js";
import { readRolloutMeta } from "./codex-inject.js";
import { storeDir } from "./host-paths.js";

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
          data = null;
          return;
        }
        data += chunk;
      });
      stream.on("end", () => { clearTimeout(timer); finish(); });
      stream.on("error", () => { clearTimeout(timer); finish(); });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function isRootCodexEvent(event, eventName, readMeta = readRolloutMeta) {
  const transcriptPath = String(event?.transcript_path || "").trim();
  if (/(?:^|[\\/])subagents(?:[\\/]|$)/i.test(transcriptPath)) return false;
  // Codex subagent tool hooks reuse the parent's session_id and do not carry an
  // agent_type discriminator. For mid-turn delivery, require a readable root
  // rollout and consult its native session_meta before touching the cursor.
  if (eventName === "PostToolUse") {
    if (!transcriptPath) return false;
    const meta = readMeta(transcriptPath);
    return Boolean(meta && !meta.subagent);
  }
  if (!transcriptPath) return true;
  const meta = readMeta(transcriptPath);
  return Boolean(meta && !meta.subagent);
}

function responseFor(eventName, text) {
  if (eventName === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } };
}

export async function runCodexHook({
  input = process.stdin,
  output = process.stdout,
  homeDir = storeDir(),
  accountScope = deviceToken(),
  readRolloutMetaImpl = readRolloutMeta,
} = {}) {
  let claim = null;
  try {
    const event = JSON.parse(String(await readAll(input) || ""));
    const sessionId = String(event?.session_id || "").trim();
    const eventName = String(event?.hook_event_name || "").trim();
    if (!sessionId || !["UserPromptSubmit", "PostToolUse", "Stop"].includes(eventName)) return;
    if (!isRootCodexEvent(event, eventName, readRolloutMetaImpl)) return;
    claim = claimAgentRelayHookContext(homeDir, accountScope, {
      sessionId: `codex:${sessionId}`,
      eventName,
      stopHookActive: Boolean(event?.stop_hook_active),
    });
    if (!claim?.text) return;
    const response = responseFor(eventName, claim.text);
    await new Promise((resolve, reject) => {
      try {
        output.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
    claim.commit();
  } catch {
    try { claim?.rollback(); } catch {}
  } finally {
    try {
      input.pause();
      if (typeof input.destroy === "function") input.destroy();
    } catch {}
  }
}
