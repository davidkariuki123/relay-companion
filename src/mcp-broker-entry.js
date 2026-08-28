import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import {
  MCP_BROKER_IDLE_TIMEOUT_MS,
  brokerRunDir,
  isMainModule,
  mcpBrokerLogPath,
  packageRootForModule,
  readMcpBrokerProvisioning,
} from "./mcp-broker-state.js";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => String(value).startsWith(prefix))?.slice(prefix.length) || "";
}

function appendLog(logPath, event, detail = "") {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const suffix = detail ? ` ${String(detail).replace(/[\r\n]+/g, " ").slice(0, 180)}` : "";
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${event}${suffix}\n`, { mode: 0o600 });
  } catch {}
}

function probe(endpoint) {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const done = (live) => {
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 300).unref?.();
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

async function bindEndpoint(server, { endpoint, runDir, platform = process.platform }) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runDir, 0o700); } catch {}
  try {
    await listen(server, endpoint);
    return true;
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    if (platform === "win32" || await probe(endpoint)) return false;

    const lockDir = path.join(runDir, ".stale-recovery.lock");
    try {
      fs.mkdirSync(lockDir);
    } catch (lockError) {
      if (lockError?.code === "EEXIST") return false;
      throw lockError;
    }
    try {
      if (await probe(endpoint)) return false;
      const stat = fs.lstatSync(endpoint);
      if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("refusing to replace an endpoint not owned by this user");
      }
      fs.unlinkSync(endpoint);
      await listen(server, endpoint);
      return true;
    } finally {
      try { fs.rmdirSync(lockDir); } catch {}
    }
  }
}

export async function runMcpBrokerEntry({
  env = process.env,
  platform = process.platform,
  packageRoot = packageRootForModule(import.meta.url),
} = {}) {
  const provisioning = readMcpBrokerProvisioning({ env, packageRoot, platform });
  if (argument("config-scope") !== provisioning.identity.configScopeId || argument("domain") !== provisioning.identity.domainId) {
    throw new Error("broker command identity does not match its protected configuration");
  }
  const runDir = brokerRunDir({ env, identity: provisioning.identity, platform });
  const logPath = mcpBrokerLogPath(provisioning.identity);
  const pending = [];
  let handler = null;
  let connections = 0;
  let idleTimer = null;
  let stopping = false;
  const idleMs = Math.max(10, Number(env.RELAY_MCP_BROKER_IDLE_MS) || MCP_BROKER_IDLE_TIMEOUT_MS);
  const server = net.createServer((socket) => {
    socket.pause();
    if (handler) {
      void handler(socket);
      return;
    }
    if (pending.length >= 32) {
      socket.destroy();
      return;
    }
    pending.push(socket);
  });

  const closeEndpoint = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    for (const socket of pending.splice(0)) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    if (platform !== "win32") {
      try { fs.rmSync(provisioning.endpoint, { force: true }); } catch {}
    }
    appendLog(logPath, "stop", `domain=${provisioning.identity.domainId.slice(0, 12)} code=${code}`);
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (connections > 0 || pending.length > 0 || stopping) return;
    idleTimer = setTimeout(() => {
      void closeEndpoint(0).then(() => process.exit(0));
    }, idleMs);
    idleTimer.unref?.();
  };
  const opened = () => {
    connections += 1;
    clearTimeout(idleTimer);
  };
  const closed = () => {
    connections = Math.max(0, connections - 1);
    armIdle();
  };

  const won = await bindEndpoint(server, { endpoint: provisioning.endpoint, runDir, platform });
  if (!won) return { won: false };
  if (platform !== "win32") {
    try { fs.chmodSync(provisioning.endpoint, 0o600); } catch {}
  }
  appendLog(logPath, "start", `domain=${provisioning.identity.domainId.slice(0, 12)}`);
  armIdle();

  const { createBrokerConnectionHandler } = await import("./mcp-broker.js");
  handler = createBrokerConnectionHandler({
    identity: provisioning.identity,
    capability: provisioning.capability,
    onConnectionOpened: opened,
    onConnectionClosed: closed,
    log: (event, detail) => appendLog(logPath, event, detail),
  });
  for (const socket of pending.splice(0)) void handler(socket);

  const shutdown = () => void closeEndpoint(0).then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { won: true, server, close: closeEndpoint };
}

if (isMainModule(import.meta.url)) {
  runMcpBrokerEntry().then((result) => {
    if (!result.won) process.exit(0);
  }).catch((error) => {
    try {
      const provisioning = readMcpBrokerProvisioning();
      appendLog(mcpBrokerLogPath(provisioning.identity), "fatal", error.message);
    } catch {}
    process.exit(1);
  });
}
