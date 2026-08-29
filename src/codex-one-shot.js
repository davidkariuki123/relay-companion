import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CodexAppServerClient, defaultCodexCommand } from "./codex-app-server.js";
import { storeDir } from "./host-paths.js";

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 90 * 60 * 1000;
// A timeout override for a server that is not present in the user's Codex
// config creates an incomplete mcp_servers table. Current Codex rejects that
// table as an invalid transport before starting the run, so defaults must not
// invent server names. Callers may still bound MCP servers they explicitly
// know are configured.
const DEFAULT_MCP_TOOL_TIMEOUTS = Object.freeze({});

const RELAY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    forHuman: { type: "string" },
    forAgent: { type: "string" },
  },
  required: ["forHuman", "forAgent"],
  additionalProperties: false,
};

export function codexOneShotAppServerArgs({ mcpToolTimeouts = DEFAULT_MCP_TOOL_TIMEOUTS } = {}) {
  const args = ["app-server"];
  for (const [server, seconds] of Object.entries(mcpToolTimeouts || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(server) || !Number.isFinite(seconds) || seconds <= 0) continue;
    args.push("--config", `mcp_servers.${server}.tool_timeout_sec=${seconds}`);
  }
  return args;
}

export function ensureCodexRelayOutputSchema(baseDir = storeDir()) {
  const schemaPath = path.join(baseDir, "codex-chat-agent-output.schema.json");
  const body = `${JSON.stringify(RELAY_OUTPUT_SCHEMA, null, 2)}\n`;
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = fs.readFileSync(schemaPath, "utf8"); } catch {}
  if (current !== body) fs.writeFileSync(schemaPath, body, { mode: 0o600 });
  return schemaPath;
}

export function codexOneShotArgs({
  model = "",
  effort = "",
  fullAccess = false,
  schemaPath,
  mcpToolTimeouts = DEFAULT_MCP_TOOL_TIMEOUTS,
}) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
  ];
  // --approve-for-me already selects Codex's reviewed workspace-write mode.
  // Passing an explicit --sandbox alongside it is rejected by the CLI before
  // the run starts. Full-access runs opt into their sandbox directly instead.
  if (fullAccess) args.push("--sandbox", "danger-full-access");
  else args.push("--approve-for-me");
  if (model) args.push("--model", model);
  if (effort && effort !== "auto") args.push("--config", `model_reasoning_effort=${JSON.stringify(effort)}`);
  // Preserve the user's MCP setup, but do not let a provenance service hold an
  // anonymous chat answer forever. Codex receives the timeout as a normal
  // config layer; the server and all of its tools remain available to the run.
  for (const [server, seconds] of Object.entries(mcpToolTimeouts || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(server) || !Number.isFinite(seconds) || seconds <= 0) continue;
    args.push("--config", `mcp_servers.${server}.tool_timeout_sec=${seconds}`);
  }
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push("-");
  return args;
}

function cleanStatus(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length <= 280 ? value : `${value.slice(0, 277).trimEnd()}…`;
}

export function codexExecEventStatus(event) {
  const item = event?.item || {};
  if (event?.type === "turn.started") return "Codex has started working on your laptop.";
  if (event?.type === "item.completed" && item.type === "agent_message") {
    const text = String(item.text || "").trim();
    if (!text || parseStructuredOutput(text)) return "";
    return cleanStatus(text);
  }
  if (event?.type !== "item.started") return "";
  if (["mcp_tool_call", "mcpToolCall"].includes(item.type)) {
    const tool = String(item.tool || item.name || "an agent tool").replace(/^mcp__/, "").replace(/__/g, " · ");
    return cleanStatus(`Codex is using ${tool}.`);
  }
  if (["custom_tool_call", "tool_call", "function_call"].includes(item.type)) return "Codex is working through its agent tools.";
  if (["command_execution", "commandExecution"].includes(item.type)) return "Codex is running a command.";
  if (["file_change", "fileChange"].includes(item.type)) return "Codex is updating files.";
  if (["web_search", "webSearch"].includes(item.type)) return "Codex is checking the web.";
  if (item.type === "plan") return cleanStatus(item.text || "Codex is planning the work.");
  return "";
}

function decodePartialJsonString(source, start) {
  let value = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') return { value, complete: true };
    if (char !== "\\") {
      value += char;
      continue;
    }
    if (index + 1 >= source.length) return { value, complete: false };
    const escaped = source[index + 1];
    index += 1;
    if (escaped === "u") {
      const hex = source.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, complete: false };
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    const escapes = { '"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t" };
    if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
  }
  return { value, complete: false };
}

/** Extract the already-authored human answer from an in-flight structured JSON response. */
export function partialCodexRelayHuman(source) {
  const text = String(source || "");
  const match = /"forHuman"\s*:\s*"/.exec(text);
  if (!match) return "";
  return decodePartialJsonString(text, match.index + match[0].length).value;
}

function partialAnswerStatus(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length < 8) return "";
  const visible = clean.length <= 245 ? clean : `…${clean.slice(-244)}`;
  return cleanStatus(`Codex is answering: ${visible}`);
}

function appServerItemStatus(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "mcpToolCall") {
    const server = String(item.server || "mcp").replace(/^mcp__/, "");
    const tool = String(item.tool || "tool").replace(/^mcp__/, "").replace(/__/g, " · ");
    return cleanStatus(`Codex is using ${server} · ${tool}.`);
  }
  return codexExecEventStatus({ type:"item.started", item });
}

/**
 * A fresh, in-memory Codex thread over the CLI app-server protocol.
 *
 * Unlike `codex exec`, app-server exposes token deltas and does not pay the
 * non-interactive runner's cold setup cost before every answer. `ephemeral`
 * keeps the invocation out of both Codex history and Relay's session list.
 */
export async function runCodexAppServerOneShot({
  command = defaultCodexCommand(),
  cwd = process.cwd(),
  prompt,
  model = "",
  effort = "",
  fullAccess = false,
  ephemeral = true,
  title = "",
  stallTimeoutMs = Number(process.env.RELAY_CHAT_AGENT_STALL_TIMEOUT_MS || DEFAULT_STALL_TIMEOUT_MS),
  runTimeoutMs = Number(process.env.RELAY_CHAT_AGENT_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS),
  heartbeatIntervalMs = 30_000,
  mcpToolTimeouts = DEFAULT_MCP_TOOL_TIMEOUTS,
  onEvent = () => {},
  onThreadStarted = async () => {},
  onTurnStarted = async () => {},
  appServerFactory = (options) => new CodexAppServerClient(options),
} = {}) {
  const actualCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  let appServer;
  let threadId = "";
  let turnId = "";
  let finalMessage = "";
  let streamedMessage = "";
  let lastPartialStatusAt = 0;
  let lastPartialLength = 0;
  let lastActivityAt = Date.now();
  let lastPhase = "starting Codex";
  let terminalResolve;
  let terminalReject;
  const terminal = new Promise((resolve, reject) => {
    terminalResolve = resolve;
    terminalReject = reject;
  });
  let settled = false;
  let stallTimer;
  let runTimer;
  let heartbeatTimer;
  const emit = (event, status = "") => {
    lastActivityAt = Date.now();
    if (status) lastPhase = status;
    try { void onEvent(event, status); } catch {}
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    terminalReject(error instanceof Error ? error : new Error(String(error)));
  };
  const complete = () => {
    if (settled) return;
    settled = true;
    terminalResolve();
  };
  const onNotification = (message) => {
    const params = message?.params || {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (turnId && params.turnId && params.turnId !== turnId) return;
    lastActivityAt = Date.now();
    if (message?.method === "thread/started") {
      emit({ type:"thread.started", thread_id:params.thread?.id || threadId }, "Codex has started working on your laptop.");
      return;
    }
    if (message?.method === "turn/started") {
      emit({ type:"turn.started" }, "Codex has started working on your laptop.");
      return;
    }
    if (message?.method === "item/started") {
      const status = appServerItemStatus(params.item);
      emit({ type:"item.started", item:params.item }, status);
      return;
    }
    if (message?.method === "item/agentMessage/delta") {
      streamedMessage += String(params.delta || "");
      const partial = partialCodexRelayHuman(streamedMessage);
      const now = Date.now();
      const enoughNewText = partial.length >= lastPartialLength + 12;
      const paragraphFinished = /\n\n$/.test(partial);
      if (partial && enoughNewText && (paragraphFinished || now - lastPartialStatusAt >= 700)) {
        const status = partialAnswerStatus(partial);
        if (status) {
          lastPartialLength = partial.length;
          lastPartialStatusAt = now;
          emit({ type:"item.agent_message.delta", item:{ type:"agent_message", text:partial } }, status);
        }
      }
      return;
    }
    if (message?.method === "item/completed" && params.item?.type === "agentMessage") {
      finalMessage = String(params.item.text || "").trim() || finalMessage;
      const parsed = parseStructuredOutput(finalMessage);
      emit({ type:"item.completed", item:{ type:"agent_message", text:finalMessage } }, parsed ? "" : cleanStatus(finalMessage));
      return;
    }
    if (message?.method === "turn/completed") {
      const status = String(params.turn?.status || "completed").toLowerCase();
      if (["failed", "error"].includes(status)) fail(new Error(params.turn?.error?.message || "Codex reported a failed run."));
      else complete();
      return;
    }
    if (message?.method === "error") fail(new Error(params.error?.message || params.message || "Codex reported a failed run."));
  };

  try {
    appServer = appServerFactory({
      command,
      args: codexOneShotAppServerArgs({ mcpToolTimeouts }),
      cwd: actualCwd,
      notificationOptOutMethods: ["command/exec/outputDelta", "process/outputDelta"],
      onNotification,
    });
    await appServer.start();
    const thread = await appServer.request("thread/start", {
      cwd: actualCwd,
      approvalPolicy: fullAccess ? "never" : "on-request",
      ...(fullAccess ? {} : { approvalsReviewer:"auto_review" }),
      sandbox: fullAccess ? "danger-full-access" : "workspace-write",
      ...(ephemeral ? { ephemeral:true } : {}),
      threadSource: ephemeral ? "appServer" : "user",
      serviceName: "relay_owned_agent",
      ...(model ? { model } : {}),
    });
    threadId = String(thread?.thread?.id || "");
    if (!threadId) throw new Error("Codex did not return a thread id");
    if (title) await appServer.request("thread/name/set", { threadId, name:title });
    await onThreadStarted({ threadId, appServer });
    emit({ type:"thread.started", thread_id:threadId }, "Codex has started working on your laptop.");
    const turn = await appServer.request("turn/start", {
      threadId,
      input: [{ type:"text", text:String(prompt || ""), text_elements:[] }],
      outputSchema: RELAY_OUTPUT_SCHEMA,
      ...(effort && effort !== "auto" ? { effort } : {}),
    });
    turnId = String(turn?.turn?.id || "");
    if (!turnId) throw new Error("Codex did not return a turn id");
    await onTurnStarted({ threadId, turnId, appServer });
    emit({ type:"turn.started", turn_id:turnId }, "Codex has started working on your laptop.");

    stallTimer = setInterval(() => {
      if (Date.now() - lastActivityAt <= stallTimeoutMs) return;
      fail(new Error(`Codex stopped producing activity while ${lastPhase}.`));
    }, Math.min(10_000, Math.max(10, Math.floor(stallTimeoutMs / 4))));
    heartbeatTimer = setInterval(() => {
      const idleSeconds = Math.max(1, Math.round((Date.now() - lastActivityAt) / 1000));
      emit({ type:"relay.heartbeat" }, `Codex is still active on your laptop (${idleSeconds}s since its last event).`);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    runTimer = setTimeout(() => fail(new Error("Codex reached Relay's run time limit.")), runTimeoutMs);
    await terminal;
    return { threadId, finalMessage: finalMessage || streamedMessage };
  } catch (error) {
    // Older Codex CLIs may have `exec` but not the ephemeral app-server fields.
    // Falling back is safe only before a turn id proves model work was accepted;
    // a timed-out turn/start response is ambiguous and must not duplicate work.
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!turnId && !/Timed out waiting for turn\/start/i.test(failure.message)) {
      failure.relayExecFallbackSafe = true;
    }
    throw failure;
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (runTimer) clearTimeout(runTimer);
    await appServer?.stop().catch(() => {});
  }
}

function parseStructuredOutput(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  const candidates = [source];
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.forHuman === "string" && typeof parsed?.forAgent === "string") return parsed;
    } catch {}
  }
  return null;
}

export function codexRelayCompletion(text) {
  const structured = parseStructuredOutput(text);
  if (structured) {
    const forHuman = structured.forHuman.trim();
    const forAgent = structured.forAgent.trim();
    if (forHuman && forAgent) return { forHuman, forAgent };
  }
  const fallback = String(text || "").trim();
  if (!fallback) return null;
  return { forHuman: fallback, forAgent: fallback };
}

export function runCodexOneShot({
  command = defaultCodexCommand(),
  cwd = process.cwd(),
  prompt,
  model = "",
  effort = "",
  fullAccess = false,
  schemaPath = ensureCodexRelayOutputSchema(),
  stallTimeoutMs = Number(process.env.RELAY_CHAT_AGENT_STALL_TIMEOUT_MS || DEFAULT_STALL_TIMEOUT_MS),
  runTimeoutMs = Number(process.env.RELAY_CHAT_AGENT_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS),
  heartbeatIntervalMs = 30_000,
  mcpToolTimeouts = DEFAULT_MCP_TOOL_TIMEOUTS,
  onEvent = () => {},
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const args = codexOneShotArgs({ model, effort, fullAccess, schemaPath, mcpToolTimeouts });
    const child = spawnProcess(command, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let terminal = false;
    let lastActivityAt = Date.now();
    let lastAgentMessage = "";
    let threadId = "";
    let lastPhase = "starting Codex";
    let stderr = "";
    let stallTimer;
    let runTimer;
    let heartbeatTimer;

    const cleanup = () => {
      if (stallTimer) clearInterval(stallTimer);
      if (runTimer) clearTimeout(runTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.exitCode == null) child.kill("SIGTERM");
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ threadId, finalMessage: lastAgentMessage });
    };
    const emit = (event) => {
      lastActivityAt = Date.now();
      if (event?.type === "thread.started") threadId = String(event.thread_id || event.threadId || "");
      if (event?.type === "item.completed" && event.item?.type === "agent_message") {
        lastAgentMessage = String(event.item.text || "").trim() || lastAgentMessage;
      }
      const status = codexExecEventStatus(event);
      if (status) lastPhase = status;
      try { void onEvent(event, status); } catch {}
      if (event?.type === "turn.completed") terminal = true;
      if (event?.type === "turn.failed" || event?.type === "error") {
        const message = event?.error?.message || event?.message || "Codex reported a failed run.";
        fail(new Error(String(message)));
      }
    };

    child.once("error", fail);
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      try { emit(JSON.parse(line)); }
      catch { lastActivityAt = Date.now(); }
    });
    child.stderr.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code === 0 && terminal && lastAgentMessage) finish();
      else fail(new Error(
        stderr.trim()
          || `Codex exited before returning an answer (${signal || code || "unknown"}).`,
      ));
    });
    child.stdin.once("error", fail);

    stallTimer = setInterval(() => {
      if (Date.now() - lastActivityAt <= stallTimeoutMs) return;
      fail(new Error(`Codex stopped producing activity while ${lastPhase}.`));
    }, Math.min(10_000, Math.max(10, Math.floor(stallTimeoutMs / 4))));
    heartbeatTimer = setInterval(() => {
      const idleSeconds = Math.max(1, Math.round((Date.now() - lastActivityAt) / 1000));
      try { void onEvent({ type: "relay.heartbeat" }, `Codex is still active on your laptop (${idleSeconds}s since its last event).`); } catch {}
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    runTimer = setTimeout(() => fail(new Error("Codex reached Relay's one-shot run time limit.")), runTimeoutMs);
    child.stdin.end(String(prompt || ""));
  });
}
