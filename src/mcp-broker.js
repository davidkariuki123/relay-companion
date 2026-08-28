import { timingSafeEqual } from "node:crypto";
import {
  MCP_BROKER_FRAME_MAX_BYTES,
  MCP_BROKER_HELLO_MAX_BYTES,
  MCP_BROKER_HELLO_TIMEOUT_MS,
  MCP_BROKER_IN_FLIGHT_MAX_BYTES,
  MCP_BROKER_PROTOCOL,
} from "./mcp-broker-state.js";
import { BrokerFrameBudget, BrokerStdioTransport } from "./mcp-broker-transport.js";
import { createMcpSessionContext, createRelayMcpSession } from "./mcp.js";

export function createAttachmentGate() {
  let active = false;
  return {
    get active() { return active; },
    tryAcquire() {
      if (active) return null;
      active = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = false;
      };
    },
  };
}

function readHello(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
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
    const onClose = () => finish(new Error("bridge closed during hello"));
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MCP_BROKER_HELLO_MAX_BYTES) return finish(new Error("hello_too_large"));
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffered.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      const remainder = buffered.subarray(newline + 1);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      try {
        finish(null, JSON.parse(line));
      } catch {
        finish(new Error("hello_invalid_json"));
      }
    };
    const timer = setTimeout(() => finish(new Error("hello_timeout")), MCP_BROKER_HELLO_TIMEOUT_MS);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function validCapability(received, expected) {
  let candidate;
  try { candidate = Buffer.from(String(received || ""), "base64url"); } catch { return false; }
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function validateHello(hello, { identity, capability }) {
  if (hello?.type !== "relay-mcp-broker/hello") throw new Error("hello_type_mismatch");
  if (Number(hello.protocol) !== MCP_BROKER_PROTOCOL) throw new Error("protocol_mismatch");
  if (hello.domainId !== identity.domainId) throw new Error("domain_mismatch");
  if (!validCapability(hello.capability, capability)) throw new Error("capability_rejected");
  const bridgePid = Number(hello.bridgePid);
  if (!Number.isInteger(bridgePid) || bridgePid <= 1) throw new Error("bridge_pid_invalid");
  try { process.kill(bridgePid, 0); } catch { throw new Error("bridge_pid_not_live"); }
  const cwd = String(hello.cwd || "");
  if (!cwd || !cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new Error("bridge_cwd_invalid");
  const env = {};
  for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "RELAY_CALLING_NATIVE_SESSION_ID"]) {
    if (hello.env?.[key]) env[key] = String(hello.env[key]).slice(0, 4096);
  }
  return {
    env,
    cwd,
    bridgePid,
    argv: [],
    channelEnabled: hello.channelEnabled === true,
    channelSource: String(hello.channelSource || "none").slice(0, 64),
  };
}

function boundedReason(error) {
  return String(error?.message || error || "broker_error").replace(/[\r\n]+/g, " ").slice(0, 180);
}

export function createBrokerConnectionHandler({
  identity,
  capability,
  onConnectionOpened = () => {},
  onConnectionClosed = () => {},
  log = () => {},
} = {}) {
  const frameBudget = new BrokerFrameBudget(MCP_BROKER_IN_FLIGHT_MAX_BYTES);
  const attachmentGate = createAttachmentGate();

  return async function handleBrokerSocket(socket) {
    onConnectionOpened();
    let session = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onConnectionClosed();
    };
    socket.once("close", finish);
    try {
      const hello = await readHello(socket);
      const context = validateHello(hello, { identity, capability });
      const transport = new BrokerStdioTransport(socket, socket, {
        maxBufferSize: MCP_BROKER_FRAME_MAX_BYTES,
        budget: frameBudget,
      });
      session = await createRelayMcpSession({
        transport,
        sessionContext: createMcpSessionContext({ ...context, attachmentGate }),
        onClose: finish,
      });
      socket.write(`${JSON.stringify({ type: "relay-mcp-broker/ready", protocol: MCP_BROKER_PROTOCOL })}\n`);
      socket.resume();
    } catch (error) {
      const reason = boundedReason(error);
      log("connection_rejected", reason);
      try { socket.end(`${JSON.stringify({ type: "relay-mcp-broker/error", protocol: MCP_BROKER_PROTOCOL, message: reason })}\n`); } catch {}
      setTimeout(() => socket.destroy(), 25).unref?.();
      finish();
    }
    return session;
  };
}
