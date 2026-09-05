import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";

export const LOCAL_MAX_BYTES = 160 * 1024 * 1024;
export function localDescriptorPath(env = process.env) {
  return env.RELAY_AGENT_LOCAL || path.join(env.RELAY_CONFIG_DIR || path.join(os.homedir(), ".relay"), "agent-local.json");
}
export function localEndpoint(file = localDescriptorPath()) {
  const digest = createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\relay-agent-${digest}` : path.join(path.dirname(file), `agent-${digest}.sock`);
}
export function readLocalDescriptor(file = localDescriptorPath()) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
    throw new Error("Relay's local connection file is not protected.");
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.version !== 1 || value.endpoint !== localEndpoint(file) || !/^[a-f0-9]{64}$/.test(value.capability || "")) {
    throw new Error("Relay's local connection is invalid. Restart Companion.");
  }
  return value;
}

// One bounded request per connection. No process launching, MCP, or host reload.
export function localRequest(descriptor, request, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(descriptor.endpoint);
    let bytes = 0;
    const chunks = [];
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Companion did not confirm the request. Retry with the same idempotency key.")), timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify({ ...request, capability: descriptor.capability }) + "\n"));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > LOCAL_MAX_BYTES) return finish(new Error("Relay's local response is too large."));
      chunks.push(chunk);
      if (chunk.includes(10)) {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
          if (result.error) return finish(Object.assign(new Error(result.message || result.error), { code: result.error, status: result.status }));
          finish(null, result.value);
        } catch (error) { finish(error); }
      }
    });
    socket.once("error", () => finish(new Error("Companion is unavailable. Reopen Relay and retry; your agent conversation can stay open.")));
    socket.once("end", () => { if (!finished) finish(new Error("Companion closed before confirming the request. Retry with the same idempotency key.")); });
  });
}
