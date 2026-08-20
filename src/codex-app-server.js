// Codex `app-server` JSON-RPC client. Ported verbatim from
// granular/tools/relay-companion/src/codex-app-server.js (require -> import only).
// Drives thread/start, thread/name/set, thread/read against a short-lived
// `codex app-server` process so a Relay row becomes a real native Codex thread.

import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

export class CodexAppServerClient {
  constructor({ command = defaultCodexCommand(), args = ["app-server"], cwd = process.cwd() } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
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
        optOutNotificationMethods: ["item/agentMessage/delta", "command/exec/outputDelta", "process/outputDelta"],
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
