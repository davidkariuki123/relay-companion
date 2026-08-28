import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MCP_BROKER_HELLO_MAX_BYTES,
  MCP_BROKER_HELLO_TIMEOUT_MS,
  MCP_BROKER_MAX_OLD_SPACE_MB,
  MCP_BROKER_PROTOCOL,
  MCP_BROKER_STARTUP_TIMEOUT_MS,
  isMainModule,
  packageRootForModule,
  readMcpBrokerProvisioning,
} from "./mcp-broker-state.js";

const SESSION_ENV_KEYS = Object.freeze([
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "RELAY_CALLING_NATIVE_SESSION_ID",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function bridgeSessionContext({ argv = process.argv, env = process.env, cwd = process.cwd() } = {}) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  let channelEnabled = String(env.RELAY_CHANNEL_PUMP || "") === "1";
  let channelSource = channelEnabled ? "relay-channel-pump-env" : "none";
  for (let i = 0; !channelEnabled && i < args.length; i += 1) {
    if (args[i] !== "--channels" && args[i] !== "--dangerously-load-development-channels") continue;
    const value = args[i + 1] || "";
    if (/(^|,)server:relay(,|$)/.test(value) || /(^|,)plugin:relay(@|,|$)/.test(value)) {
      channelEnabled = true;
      channelSource = "relay-channel-argv";
    }
  }
  const sessionEnv = {};
  for (const key of SESSION_ENV_KEYS) {
    if (env[key]) sessionEnv[key] = String(env[key]);
  }
  return { cwd: path.resolve(cwd), channelEnabled, channelSource, env: sessionEnv };
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const onError = (error) => {
      socket.removeListener("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function readBoundedLine(socket, { maxBytes = MCP_BROKER_HELLO_MAX_BYTES, timeoutMs = MCP_BROKER_HELLO_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Relay MCP broker handshake timed out")), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error, value) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("Relay MCP broker closed during handshake"));
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > maxBytes) return finish(new Error("Relay MCP broker handshake exceeded its size limit"));
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffered.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      const remainder = buffered.subarray(newline + 1);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      finish(null, line);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function brokerEnvironment(env) {
  const childEnv = { ...env };
  for (const key of [...SESSION_ENV_KEYS, "RELAY_CHANNEL_PUMP"]) delete childEnv[key];
  return childEnv;
}

function startBroker({ packageRoot, provisioning, env = process.env }) {
  const entry = path.join(packageRoot, "src", "mcp-broker-entry.js");
  const child = spawn(process.execPath, [
    `--max-old-space-size=${MCP_BROKER_MAX_OLD_SPACE_MB}`,
    entry,
    `--config-scope=${provisioning.identity.configScopeId}`,
    `--domain=${provisioning.identity.domainId}`,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: brokerEnvironment(env),
  });
  child.once("error", () => {});
  child.unref();
}

async function authenticatedConnection({ provisioning, sessionContext, deadline, packageRoot, env }) {
  const delays = [25, 50, 100, 200, 400, 500];
  let attempt = 0;
  let started = false;
  let lastError = null;
  while (Date.now() < deadline) {
    let socket;
    try {
      socket = await connect(provisioning.endpoint);
      const hello = {
        type: "relay-mcp-broker/hello",
        protocol: MCP_BROKER_PROTOCOL,
        capability: provisioning.capability.toString("base64url"),
        domainId: provisioning.identity.domainId,
        bridgePid: process.pid,
        ...sessionContext,
      };
      socket.write(`${JSON.stringify(hello)}\n`);
      const remaining = Math.max(1, deadline - Date.now());
      const line = await readBoundedLine(socket, { timeoutMs: remaining });
      const response = JSON.parse(line);
      if (response?.type !== "relay-mcp-broker/ready" || response?.protocol !== MCP_BROKER_PROTOCOL) {
        throw new Error(String(response?.message || "Relay MCP broker rejected the bridge"));
      }
      socket.resume();
      return socket;
    } catch (error) {
      lastError = error;
      socket?.destroy();
      const retryable = ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(error?.code || ""))
        || /closed during handshake|timed out/i.test(String(error?.message || ""));
      if (!started && retryable) {
        startBroker({ packageRoot, provisioning, env });
        started = true;
      } else if (!retryable) {
        throw error;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
  }
  throw new Error(`Relay MCP broker did not become ready before the startup deadline${lastError?.message ? `: ${lastError.message}` : ""}`);
}

export async function runMcpBridge({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  packageRoot = packageRootForModule(import.meta.url),
  deadline = Number(env.RELAY_MCP_START_DEADLINE_MS) || Date.now() + MCP_BROKER_STARTUP_TIMEOUT_MS,
} = {}) {
  const provisioning = readMcpBrokerProvisioning({ env, packageRoot });
  const sessionContext = bridgeSessionContext({ argv, env, cwd });
  const socket = await authenticatedConnection({ provisioning, sessionContext, deadline, packageRoot, env });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let inputEnded = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, onSignal);
      input.unpipe(socket);
      socket.unpipe(output);
      if (error) reject(error);
      else resolve(code);
    };
    const onSignal = () => socket.destroy();
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);
    input.once("end", () => {
      inputEnded = true;
      socket.end();
    });
    input.once("error", (error) => {
      socket.destroy();
      finish(error);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (inputEnded) finish(null, 0);
      else finish(new Error("Relay MCP broker connection closed; reload Relay MCP in this host"));
    });
    socket.pipe(output, { end: false });
    input.pipe(socket);
    input.resume();
  });
}

if (isMainModule(import.meta.url)) {
  runMcpBridge().catch((error) => {
    process.stderr.write(`relay: ${error.message}\n`);
    process.exit(1);
  });
}
