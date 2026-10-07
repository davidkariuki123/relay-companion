// Which agent is calling Relay's MCP server: the app it runs in (desktop, CLI,
// IDE, web), the model behind it, and the MCP host's own name. The API keeps
// this with the agent's Relay reads (agent_opened / agent_presented events) so
// "how do people read their Relays" has an answer beyond "not in the pill".
//
// Everything here is read from what the host already writes: Claude Code's
// CLAUDE_CODE_ENTRYPOINT and session transcript, Codex's rollout file. Nothing
// is guessed. A field that cannot be read is left out, and any failure leaves
// the identity smaller, never the tool call broken.

import fs from "node:fs";
import path from "node:path";
import { claudeHome, codexHome } from "./host-paths.js";

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
const IDENTITY_TTL_MS = 30_000;

function word(value, max = 80) {
  const text = String(value || "").replace(/[^\x20-\x7e]/g, "_").trim().slice(0, max);
  return text || "";
}

/** Claude Code's CLAUDE_CODE_ENTRYPOINT as the app a person sees. */
export function claudeAppFromEntrypoint(entrypoint) {
  const value = word(entrypoint, 40).toLowerCase();
  if (!value) return "";
  if (value === "cli") return "cli";
  if (value === "claude-desktop") return "desktop";
  if (/vscode|jetbrains|cursor|ide/.test(value)) return "ide";
  if (value === "remote" || /web/.test(value)) return "web";
  if (value.startsWith("sdk")) return "sdk";
  return value;
}

/** A Codex rollout's originator as the app a person sees. */
export function codexAppFromOriginator(originator) {
  const value = word(originator, 40).toLowerCase();
  if (!value) return "";
  if (/desktop/.test(value)) return "desktop";
  if (/exec/.test(value)) return "exec";
  if (/vscode|ide/.test(value)) return "ide";
  if (/relay|granular/.test(value)) return "relay";
  if (/cli/.test(value)) return "cli";
  return value;
}

// MCP hosts that are the agent itself rather than an app wrapped around one.
const AGENT_HOSTS = new Set(["claude-code", "codex-mcp-client"]);

/**
 * The app a person drives the agent from when that is not the agent's own:
 * Conductor (which runs the real Claude Code and Codex in its workspaces) or
 * Cursor. Conductor gives its workspaces CONDUCTOR_* variables and keeps them
 * under .../conductor/workspaces/, and its Codex says hello as codex-local;
 * Cursor's agent says hello as cursor-vscode, and Cursor's terminal sets
 * CURSOR_TRACE_ID for a Claude Code or Codex started inside it. Any other MCP
 * host that is not an agent itself is named as it named itself.
 */
export function agentHarness({ env = {}, cwd = "", hostName = "" } = {}) {
  const host = word(hostName, 60).toLowerCase();
  if (host === "codex-local"
    || ["CONDUCTOR_WORKSPACE_NAME", "CONDUCTOR_WORKSPACE_PATH", "CONDUCTOR_ROOT_PATH"].some((key) => String(env[key] || "").trim())
    || /[\\/]conductor[\\/]workspaces[\\/]/i.test(String(cwd || ""))) return "conductor";
  if (host.startsWith("cursor") || String(env.CURSOR_TRACE_ID || "").trim()) return "cursor";
  if (host && !AGENT_HOSTS.has(host)) return host;
  return "";
}

function lines(text) {
  return String(text || "").split("\n").filter((line) => line.trim());
}

/** The model of the newest assistant turn in a slice of a Claude transcript. */
export function lastClaudeModel(text) {
  const rows = lines(text);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = rows[i];
    if (!line.includes('"assistant"')) continue;
    let model = "";
    try {
      const row = JSON.parse(line);
      if (row?.type === "assistant" || row?.message?.role === "assistant") model = String(row?.message?.model || "");
    } catch {
      model = line.match(/"model":"([^"]+)"/)?.[1] || "";
    }
    // Claude Code writes "<synthetic>" for turns no model produced.
    if (model && !model.startsWith("<")) return word(model);
  }
  return "";
}

/** The originator from a rollout's head, and the newest turn's model from its tail. */
export function codexRolloutFacts(headText, tailText) {
  const originator = String(headText || "").match(/"originator":"([^"]+)"/)?.[1] || "";
  let model = "";
  const rows = lines(tailText);
  for (let i = rows.length - 1; i >= 0 && !model; i -= 1) {
    if (rows[i].includes('"turn_context"')) model = rows[i].match(/"model":"([^"]+)"/)?.[1] || "";
  }
  return { originator: word(originator, 40), model: word(model) };
}

function readSlice(file, { fromEnd = 0, fromStart = 0 } = {}) {
  let handle = null;
  try {
    handle = fs.openSync(file, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, fromEnd || fromStart);
    if (!length) return "";
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, fromEnd ? size - length : 0);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== null) try { fs.closeSync(handle); } catch {}
  }
}

async function claudeTranscript(cwd, sessionId) {
  const { claudeTranscriptPath } = await import("./session-directory.js");
  return claudeTranscriptPath(process.env.CLAUDE_CONFIG_DIR || claudeHome(), cwd, sessionId) || "";
}

async function codexRollout(threadId) {
  const { listRecentRollouts } = await import("./codex-inject.js");
  const found = listRecentRollouts(path.join(codexHome(), "sessions"), { dayLookback: 7 }).get(threadId);
  return found?.sessionPath || "";
}

/**
 * The calling agent's identity for one MCP session: { app, model, host, harness }.
 * Cached briefly on the session context, since every Relay read asks.
 */
export async function agentIdentity(sessionContext, binding = {}, {
  findClaudeTranscript = claudeTranscript,
  findCodexRollout = codexRollout,
  nowMs = Date.now(),
} = {}) {
  const cached = sessionContext?.agentIdentityCache;
  if (cached && nowMs - cached.at < IDENTITY_TTL_MS) return cached.value;
  const env = sessionContext?.env || {};
  const identity = {};
  const hostName = word(sessionContext?.callingClientName, 60);
  const hostVersion = word(sessionContext?.callingClientVersion, 40);
  if (hostName) identity.host = hostVersion ? `${hostName}/${hostVersion}` : hostName;
  try {
    if (binding.sourceProvider === "claude") {
      const app = claudeAppFromEntrypoint(env.CLAUDE_CODE_ENTRYPOINT);
      if (app) identity.app = app;
      const transcript = binding.sourceNativeId ? await findClaudeTranscript(sessionContext?.cwd || "", binding.sourceNativeId) : "";
      const model = transcript ? lastClaudeModel(readSlice(transcript, { fromEnd: TAIL_BYTES })) : "";
      if (model) identity.model = model;
    } else if (binding.sourceProvider === "codex") {
      const rollout = binding.sourceNativeId ? await findCodexRollout(binding.sourceNativeId) : "";
      const facts = rollout
        ? codexRolloutFacts(readSlice(rollout, { fromStart: HEAD_BYTES }), readSlice(rollout, { fromEnd: TAIL_BYTES }))
        : { originator: "", model: "" };
      const app = codexAppFromOriginator(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || facts.originator);
      if (app) identity.app = app;
      if (facts.model) identity.model = facts.model;
    }
  } catch {
    // An unreadable transcript leaves the identity without app or model.
  }
  const harness = agentHarness({ env, cwd: sessionContext?.cwd, hostName });
  if (harness) {
    identity.harness = harness;
    // Conductor drives Claude Code through its SDK, which says nothing about
    // where the person sits; Conductor is a desktop app and Cursor an editor.
    if (harness === "conductor" && (!identity.app || identity.app === "sdk")) identity.app = "desktop";
    if (harness === "cursor" && !identity.app) identity.app = "ide";
  }
  if (sessionContext) sessionContext.agentIdentityCache = { at: nowMs, value: identity };
  return identity;
}
