// Relay's managed execution transport. Provider binaries are supplied by the
// pinned ACP packages; there is deliberately no CLI/app-server runner fallback.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { acpProviderBinary } from "./acp-provider-binary.js";

const require = createRequire(import.meta.url);
const PACKAGES = { claude: "@agentclientprotocol/claude-agent-acp", codex: "@agentclientprotocol/codex-acp" };
export function acpProvider(provider) { return provider === "claude_code" ? "claude" : provider; }
export function acpLaunchSpec(provider, { env = process.env, execPath = process.execPath } = {}) {
  const name = PACKAGES[acpProvider(provider)];
  if (!name) throw new Error(`Unsupported ACP provider: ${provider}`);
  const entry = require.resolve(`${name}/dist/index.js`);
  const childEnv = { ...env, NODE_USE_SYSTEM_CA: "1" };
  // Explicitly bind execution and sign-in to the same packaged provider.
  childEnv[acpProvider(provider) === "claude" ? "CLAUDE_CODE_EXECUTABLE" : "CODEX_PATH"] = acpProviderBinary(provider);
  // A provider started by another agent must be an independent native session.
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_PARENT_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"]) delete childEnv[key];
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";
  return { command: execPath, args: [entry], env: childEnv };
}
export function acpAvailable(provider) {
  try { return fs.existsSync(acpLaunchSpec(provider).args[0]); } catch { return false; }
}
export function acpMcpServers(servers) {
  return Object.entries(servers || {}).map(([name, server]) => ({
    name, ...server,
    ...(server.command ? { env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value: String(value) })) } : {}),
  }));
}
export function acpModelOption(options, requested, provider) {
  const direct = options.find(option => option.value === requested);
  if (direct) return direct.value;
  // Versioned selections must match the advertised generation exactly.
  const normalize = value => String(value || "").toLowerCase().replace(/^claude[ -]?/, "").replace(/[^a-z0-9]/g, "");
  const matches = options.filter(option => normalize(option.name) === normalize(requested));
  if (matches.length) return matches.length === 1 ? matches[0].value : null;
  // Chat preferences and the Todo steward use Claude family aliases. ACP may
  // advertise only a context-qualified alias or a concrete model id. Resolve
  // an unversioned family only when the provider offers one matching choice.
  if (acpProvider(provider) === "claude" && /^(opus|fable|sonnet|haiku)$/.test(requested)) {
    const family = new RegExp(`^(?:claude[ -])?${requested}(?:$|\\[|[ -]\\d)`, "i");
    const choices = options.filter(option => family.test(option.value || "") || family.test(option.name || ""));
    if (choices.length === 1) return choices[0].value;
  }
  return null;
}

export class AcpClient {
  constructor({ provider, cwd = process.cwd(), spawnProcess = spawn, launch, env, onUpdate = () => {}, onPermission, onSpawn, timeoutMs = 60_000 } = {}) {
    this.provider = acpProvider(provider);
    this.cwd = path.resolve(cwd);
    this.spawnProcess = spawnProcess;
    this.launch = launch;
    this.env = env;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.onSpawn = onSpawn;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.permissions = new Map();
    this.sessions = new Set();
    this.busy = new Set();
    this.nextId = 0;
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error("ACP connection is closed");
    if (this.initialized) return this.initialized;
    const spec = this.launch || acpLaunchSpec(this.provider, { env: this.env || process.env });
    this.child = this.spawnProcess(spec.command, spec.args, { cwd: this.cwd, env: spec.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.parentExit = () => this.kill();
    process.once("exit", this.parentExit);
    const fail = (error) => this.fail(error);
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.stderr?.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-16_384); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) return fail(new Error("ACP response exceeded the transport limit"));
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch (error) { fail(error); }
      }
    });
    this.exited = new Promise(resolve => this.child.once("close", code => {
      process.removeListener("exit", this.parentExit);
      this.fail(new Error(`ACP ${this.provider} exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr}` : ""}`)); resolve();
    }));
    try {
      this.onSpawn?.(this.child.pid);
      this.initialized = await this.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "relay", version: "1" },
        // Native provider tools own filesystem/terminal access and its policy.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (this.initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
      return this.initialized;
    } catch (error) { await this.stop(); throw error; }
  }
  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error("ACP connection is closed");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ACP ${method} timed out`);
        error.code = "ACP_TIMEOUT";
        reject(error);
        // An uncertain mutation must never leave a live worker for a retry.
        void this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (!message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "ACP request failed");
        error.code = message.error.code; error.data = message.error.data;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      this.onUpdate(message.params);
    } else if (message.id !== undefined) {
      if (message.method === "session/request_permission") void this.permission(message);
      else this.send({ id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
    }
  }
  async permission({ id, params }) {
    const abort = new AbortController();
    this.permissions.set(id, { sessionId: params.sessionId, abort });
    let outcome = { outcome: "cancelled" };
    try {
      if (!this.sessions.has(params.sessionId)) throw new Error("Permission requested for an unknown ACP session");
      if (this.onPermission) {
        const optionId = await Promise.race([
          this.onPermission(params, { signal: abort.signal }),
          new Promise(resolve => abort.signal.addEventListener("abort", () => resolve(null), { once: true })),
        ]);
        if (!abort.signal.aborted && params.options?.some(option => option.optionId === optionId)) outcome = { outcome: "selected", optionId };
      }
    } catch { /* Cancel on a missing, failed or stale approval UI. */ }
    finally {
      this.permissions.delete(id);
      if (!this.closed) this.send({ id, result: { outcome } });
    }
  }
  async session({ sessionId, mcpServers = [], model = "", effort = "", mode = "" } = {}) {
    await this.start();
    if (sessionId && !this.initialized.agentCapabilities?.loadSession) throw new Error("ACP adapter cannot load native sessions");
    let result;
    try {
      result = await this.request(sessionId ? "session/load" : "session/new", { cwd: this.cwd, mcpServers, ...(sessionId ? { sessionId } : {}) });
      const actual = result?.sessionId || sessionId;
      if (!actual || (sessionId && actual !== sessionId)) throw new Error("ACP returned a different or missing native session id");
      this.sessions.add(actual);
      if (mode) {
        const available = result?.modes?.availableModes || [];
        if (!available.some(option => option.id === mode)) throw new Error(`ACP ${this.provider} does not support permission mode ${mode}`);
        await this.request("session/set_mode", { sessionId: actual, modeId: mode });
      }
      let configOptions = result?.configOptions || [];
      for (const [category, value] of [["model", model], ["thought_level", effort]]) {
        if (!value || value === "auto") continue;
        const option = configOptions.find(option => option.category === category || option.id === category);
        if (!option) throw new Error(`ACP ${this.provider} does not expose ${category} selection`);
        const options = (option.options || []).flatMap(entry => entry.options || [entry]);
        const selectedValue = category === "model" ? acpModelOption(options, value, this.provider) : options.find(entry => entry.value === value)?.value;
        if (!selectedValue) throw new Error(`ACP ${this.provider} does not support ${category} ${value}`);
        const selected = await this.request("session/set_config_option", { sessionId: actual, configId: option.id, value: selectedValue });
        configOptions = selected?.configOptions || configOptions;
      }
      return { ...result, sessionId: actual };
    } catch (error) { await this.stop(); throw error; }
  }
  async prompt(sessionId, prompt, { timeoutMs = 12 * 60 * 60 * 1000 } = {}) {
    if (!this.sessions.has(sessionId)) throw new Error("ACP session has not been opened");
    if (this.busy.has(sessionId)) throw new Error("ACP session already has an active turn");
    this.busy.add(sessionId);
    try { return await this.request("session/prompt", { sessionId, prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt }, timeoutMs); }
    finally { this.busy.delete(sessionId); }
  }
  cancel(sessionId) {
    for (const pending of this.permissions.values()) if (pending.sessionId === sessionId) pending.abort.abort();
    this.send({ method: "session/cancel", params: { sessionId } });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const pending of this.permissions.values()) pending.abort.abort();
    this.permissions.clear();
    this.busy.clear();
    this.kill();
  }
  kill() {
    if (!this.child || this.child.exitCode != null) return;
    // The adapter owns a provider child and MCP children. Reap that exact tree,
    // never a provider-name process search that could kill the person's app.
    if (this.child.pid && this.spawnProcess === spawn) {
      if (process.platform === "win32") {
        spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      } else { try { process.kill(-this.child.pid, "SIGTERM"); } catch {} }
    }
    this.child.kill?.();
  }
  async stop() {
    if (!this.child) return;
    for (const sessionId of this.busy) { try { this.cancel(sessionId); } catch {} }
    this.fail(new Error("ACP connection stopped"));
    this.child.stdin?.end?.();
    let timer;
    await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => { this.child.kill?.("SIGKILL"); resolve(); }, 2000); })]);
    clearTimeout(timer);
  }
}
