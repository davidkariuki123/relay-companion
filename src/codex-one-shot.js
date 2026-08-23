import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { defaultCodexCommand } from "./codex-app-server.js";
import { storeDir } from "./host-paths.js";

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_MCP_TOOL_TIMEOUTS = Object.freeze({ agentos: 45 });

const RELAY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    forHuman: { type: "string" },
    forAgent: { type: "string" },
  },
  required: ["forHuman", "forAgent"],
  additionalProperties: false,
};

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
  if (item.type === "command_execution") return "Codex is running a command.";
  if (item.type === "file_change") return "Codex is updating files.";
  if (item.type === "web_search") return "Codex is checking the web.";
  if (item.type === "plan") return cleanStatus(item.text || "Codex is planning the work.");
  return "";
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
