// Codex `app-server` JSON-RPC client. Ported verbatim from
// granular/tools/relay-companion/src/codex-app-server.js (require -> import only).
// Drives thread/start, thread/name/set, thread/read against a short-lived
// `codex app-server` process so a Relay row becomes a real native Codex thread.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

export class CodexAppServerClient {
  constructor({
    command = defaultCodexCommand(),
    args = ["app-server"],
    cwd = process.cwd(),
    notificationOptOutMethods = ["item/agentMessage/delta", "command/exec/outputDelta", "process/outputDelta"],
    onNotification = () => {},
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.notificationOptOutMethods = notificationOptOutMethods;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.proc = null;
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc.stderr.on("data", (chunk) => {
      if (process.env.RELAY_DEBUG) process.stderr.write(chunk);
    });
    this.proc.on("error", (error) => {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
    });
    readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      // The app-server occasionally prints a non-JSON diagnostic line to stdout; an
      // unguarded parse there would throw inside the readline callback and abort the
      // whole open (every pending request left hanging). Skip non-JSON lines.
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        if (process.env.RELAY_DEBUG) process.stderr.write(`relay: ignoring non-JSON app-server line: ${line}\n`);
        return;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      } else {
        this.notifications.push(message);
        try { this.onNotification(message); } catch {}
      }
    });
    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited with ${signal || code}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "granular_relay_companion",
        title: "Relay Companion",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: this.notificationOptOutMethods,
      },
    });
    this.notify("initialized", {});
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }

  async request(method, params = {}) {
    if (!this.proc) throw new Error("Codex app-server is not started");
    const id = this.nextId++;
    const payload = { method, id, params };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, Number(process.env.RELAY_APP_SERVER_TIMEOUT_MS || 60000));
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method, params = {}) {
    if (!this.proc) throw new Error("Codex app-server is not started");
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async waitForNotification(predicate, { timeoutMs = 60 * 60 * 1000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    for (;;) {
      while (cursor < this.notifications.length) {
        const message = this.notifications[cursor++];
        if (predicate(message)) return message;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex App Server event");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export async function withCodexAppServer(fn, options = {}) {
  const client = new CodexAppServerClient(options);
  await client.start();
  try {
    return await fn(client);
  } finally {
    await client.stop();
  }
}

async function resolveWebSocketImpl() {
  if (typeof WebSocket === "function") return WebSocket;
  const mod = await import("ws");
  return mod.default || mod.WebSocket || mod;
}

function socketListen(socket, event, handler) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, handler);
  else socket.on(event, handler);
}

export class CodexWebSocketClient {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.onNotification = options.onNotification || (() => {});
    socketListen(socket, "message", (event) => {
      const raw = event?.data ?? event;
      let message;
      try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); }
      catch { return; }
      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
        try { this.onNotification(message); } catch {}
      }
    });
    const fail = () => {
      const error = new Error("Codex remote app-server connection closed");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    socketListen(socket, "close", fail);
    socketListen(socket, "error", fail);
  }

  async initialize(notificationOptOutMethods = ["item/agentMessage/delta", "command/exec/outputDelta", "process/outputDelta"]) {
    await this.request("initialize", {
      clientInfo: { name: "relay_companion_terminal", title: "Relay Companion", version: "0.1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: notificationOptOutMethods },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, Number(process.env.RELAY_APP_SERVER_TIMEOUT_MS || 60000));
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ method, id, params }));
    return promise;
  }

  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  async waitForNotification(predicate, { timeoutMs = 60 * 60 * 1000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    for (;;) {
      while (cursor < this.notifications.length) {
        const message = this.notifications[cursor++];
        if (predicate(message)) return message;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex App Server event");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function connectWebSocket(endpoint, { attempts = 80, delayMs = 50 } = {}) {
  const WebSocketImpl = await resolveWebSocketImpl();
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const socket = new WebSocketImpl(endpoint);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Codex remote socket timed out")), 2_000);
        socketListen(socket, "open", () => { clearTimeout(timer); resolve(); });
        socketListen(socket, "error", (error) => { clearTimeout(timer); reject(error?.error || error); });
      });
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Could not connect to Codex remote app-server");
}

export async function connectCodexRemoteAppServer(endpoint, options = {}) {
  const socket = await connectWebSocket(endpoint, options);
  const client = new CodexWebSocketClient(socket, options);
  await client.initialize(options.notificationOptOutMethods);
  return {
    client,
    endpoint,
    close: () => { try { socket.close(); } catch {} },
  };
}

let sharedServerPromise = null;
let sharedServerProcess = null;

// The remote owner is intentionally long-lived, but it must never outlive
// Relay itself. An `exit` handler has to be synchronous, which is enough to
// signal the child before Electron disappears.
process.once("exit", () => {
  try { sharedServerProcess?.kill("SIGTERM"); } catch {}
});

export async function sharedCodexAppServer(options = {}) {
  if (sharedServerPromise) return sharedServerPromise;
  sharedServerPromise = (async () => {
    const port = options.port || await availableLoopbackPort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const proc = spawn(options.command || defaultCodexCommand(), ["app-server", "--listen", endpoint], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    sharedServerProcess = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
      if (process.env.RELAY_DEBUG) process.stderr.write(chunk);
    });
    const onEarlyExit = (code, signal) => {
      sharedServerPromise = null;
      if (sharedServerProcess === proc) sharedServerProcess = null;
      rejectEarlyExit(new Error(`codex remote app-server exited with ${signal || code}: ${stderr.trim()}`));
    };
    const onEarlyError = (error) => {
      sharedServerPromise = null;
      if (sharedServerProcess === proc) sharedServerProcess = null;
      rejectEarlyExit(error);
    };
    let rejectEarlyExit;
    const earlyExit = new Promise((_, reject) => { rejectEarlyExit = reject; });
    proc.once("exit", onEarlyExit);
    proc.once("error", onEarlyError);
    let socket;
    try {
      socket = await Promise.race([connectWebSocket(endpoint), earlyExit]);
    } finally {
      proc.off("exit", onEarlyExit);
      proc.off("error", onEarlyError);
    }
    proc.once("exit", () => {
      sharedServerPromise = null;
      if (sharedServerProcess === proc) sharedServerProcess = null;
    });
    const client = new CodexWebSocketClient(socket, options);
    await client.initialize(options.notificationOptOutMethods);
    const stop = async () => {
      try { socket.close(); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
      if (sharedServerProcess === proc) sharedServerProcess = null;
      sharedServerPromise = null;
    };
    return { client, endpoint, proc, stop };
  })().catch((error) => {
    sharedServerPromise = null;
    throw error;
  });
  return sharedServerPromise;
}

export async function withSharedCodexAppServer(fn, options = {}) {
  const server = await sharedCodexAppServer(options);
  return fn(server.client, server);
}

export async function stopSharedCodexAppServer() {
  if (!sharedServerPromise) return;
  try { await (await sharedServerPromise).stop(); } catch {}
  sharedServerPromise = null;
}

export function defaultCodexCommand() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  for (const appBundledCodex of [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ]) {
    if (fs.existsSync(appBundledCodex)) return appBundledCodex;
  }
  return "codex";
}
