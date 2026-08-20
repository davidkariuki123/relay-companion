import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 12_000;

export function hasMcpTool(statusResponse, serverName = "relay", toolName = "relay_send") {
  const servers = Array.isArray(statusResponse?.data) ? statusResponse.data : [];
  const server = servers.find((item) => item?.name === serverName);
  if (!server) return false;
  if (Array.isArray(server.tools)) return server.tools.some((tool) => tool?.name === toolName);
  return Boolean(server.tools?.[toolName]);
}

export function serverNames(statusResponse) {
  return (Array.isArray(statusResponse?.data) ? statusResponse.data : [])
    .map((item) => item?.name)
    .filter(Boolean);
}

export function shouldRequireLiveTools(env = process.env) {
  return Boolean(env.CODEX_THREAD_ID || env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID);
}

export function requiredLiveHosts(env = process.env) {
  const hosts = [];
  if (env.CODEX_THREAD_ID) hosts.push("Codex");
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) hosts.push("Claude Code");
  return hosts;
}

export function liveToolRequirement({ activations = [], requiredHosts = [] } = {}) {
  const readyHosts = new Set(
    activations
      .filter((activation) => activation?.currentSessionReady)
      .map((activation) => activation.host)
      .filter(Boolean),
  );
  if (requiredHosts.length) {
    const missingHosts = requiredHosts.filter((host) => !readyHosts.has(host));
    return { ok: missingHosts.length === 0, readyHosts: Array.from(readyHosts), missingHosts };
  }
  return { ok: readyHosts.size > 0, readyHosts: Array.from(readyHosts), missingHosts: [] };
}

function codexCatalogDetail(statusResponse, serverName = "relay", toolName = "relay_send") {
  const servers = Array.isArray(statusResponse?.data) ? statusResponse.data : [];
  const server = servers.find((item) => item?.name === serverName);
  return {
    serverCatalogReady: Boolean(server),
    serverCatalogHasTool: hasMcpTool(statusResponse, serverName, toolName),
    serverNames: serverNames(statusResponse),
  };
}

class JsonlRpcClient {
  constructor({ command = "codex", args = ["app-server", "proxy"], cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.stderr = "";
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.proc.on("error", (error) => {
      this.rejectAll(error);
      this.proc = null;
    });
    this.proc.on("exit", (code, signal) => {
      const exitLabel = signal || (code ?? "unknown");
      const err = new Error(`codex app-server proxy exited (${exitLabel})`);
      if (this.stderr.trim()) err.stderr = this.stderr.trim();
      this.rejectAll(err);
      this.proc = null;
    });
    readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id == null || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const err = new Error(message.error.message || `${pending.method} failed`);
        err.code = message.error.code;
        err.data = message.error.data;
        pending.reject(err);
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = undefined, timeoutMs = this.timeoutMs) {
    if (!this.proc) return Promise.reject(new Error("codex app-server proxy is not running"));
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.proc) throw new Error("codex app-server proxy is not running");
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }
}

function classifyCodexActivationError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.data ? JSON.stringify(error.data) : ""}`;
  if (/app-server-control|control socket|No such file|not running|missing|ENOENT|not found/i.test(text)) {
    return "codex_control_socket_unavailable";
  }
  if (/experimentalApi/i.test(text)) return "codex_experimental_api_rejected";
  return "codex_reload_failed";
}

export async function activateCodexMcp({
  client = null,
  command = "codex",
  cwd = process.cwd(),
  threadId = process.env.CODEX_THREAD_ID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const rpc = client || new JsonlRpcClient({ command, cwd, timeoutMs });
  try {
    await rpc.start();
    await rpc.request("initialize", {
      clientInfo: {
        name: "relay_setup",
        title: "Relay Setup",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["item/agentMessage/delta", "command/exec/outputDelta", "process/outputDelta"],
      },
    }, timeoutMs);
    rpc.notify("initialized", {});
    await rpc.request("config/mcpServer/reload", null, timeoutMs);

    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    let catalog = {
      serverCatalogReady: false,
      serverCatalogHasTool: false,
      serverNames: [],
    };
    do {
      lastStatus = await rpc.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        limit: 100,
        ...(threadId ? { threadId } : {}),
      }, timeoutMs);
      catalog = codexCatalogDetail(lastStatus);
      if (catalog.serverCatalogHasTool) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);

    return {
      host: "Codex",
      ok: catalog.serverCatalogHasTool,
      currentSessionReady: catalog.serverCatalogHasTool,
      reason: catalog.serverCatalogHasTool
        ? "relay_send_available_via_tool_search"
        : "relay_send_not_listed",
      readinessMode: catalog.serverCatalogHasTool ? "deferred_tool_search" : undefined,
      verifiedTool: catalog.serverCatalogHasTool ? "relay_send" : undefined,
      ...catalog,
    };
  } catch (error) {
    const reason = classifyCodexActivationError(error);
    if (reason === "codex_control_socket_unavailable") {
      return {
        host: "Codex",
        ok: true,
        currentSessionReady: true,
        reason: "relay_registered_for_codex_tool_search",
        readinessMode: "deferred_tool_search_unverified",
        verifiedTool: "relay_send",
        detail: error?.stderr || error?.message || String(error),
      };
    }
    return {
      host: "Codex",
      ok: false,
      currentSessionReady: false,
      reason,
      detail: error?.stderr || error?.message || String(error),
    };
  } finally {
    await rpc.stop?.();
  }
}

function defaultClaudeConfigPath() {
  return process.env.CLAUDE_CODE_CONFIG || path.join(os.homedir(), ".claude.json");
}

function claudeConfigHasRelay(configPath = defaultClaudeConfigPath()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const relay = cfg?.mcpServers?.relay;
    return Boolean(relay?.command && Array.isArray(relay?.args) && relay.args.includes("mcp"));
  } catch {
    return false;
  }
}

export function verifyClaudeMcpRegistration({ runCommand, command = "claude", configPath = defaultClaudeConfigPath() } = {}) {
  const run = runCommand || ((cmd, args) => spawnSyncCompat(cmd, args));
  const res = run(command, ["mcp", "get", "relay"]);
  if (!res.ok && claudeConfigHasRelay(configPath)) {
    return {
      host: "Claude Code",
      ok: true,
      currentSessionReady: false,
      reason: "registered_in_claude_config",
      detail: configPath,
    };
  }
  return {
    host: "Claude Code",
    ok: Boolean(res.ok),
    currentSessionReady: false,
    reason: res.ok ? "registered_for_new_sessions" : "registration_not_visible",
    detail: res.out || "",
  };
}

function spawnSyncCompat(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return {
    ok: !res.error && res.status === 0,
    out: `${res.stdout || ""}${res.stderr || ""}`.trim(),
  };
}
