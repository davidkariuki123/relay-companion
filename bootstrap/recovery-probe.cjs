"use strict";
const net = require("node:net"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { atomicFile } = require("./mac-registration-transaction.cjs");
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const endpointPath = (homeDir, role) => path.join(homeDir, ".relay", "recovery", "probes", `${role}.json`);

async function startRecoveryResponder({ role, packageRoot, version, homeDir = os.homedir(),
  ready = async () => true, pid = process.pid } = {}) {
  if (!["daemon", "pill"].includes(role)) throw Error("invalid-probe-role");
  const instance = crypto.randomUUID(), token = crypto.randomBytes(32).toString("hex");
  const file = endpointPath(homeDir, role), clients = new Set();
  const server = net.createServer(socket => {
    if (clients.size >= 4) { socket.destroy(); return; }
    clients.add(socket); socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {}); socket.once("close", () => clients.delete(socket));
    let buffer = "", handled = false;
    socket.setEncoding("utf8");
    socket.on("data", async chunk => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 2048) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      handled = true;
      try {
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (request.token !== token || !/^[a-f0-9]{32}$/.test(request.nonce)) { socket.destroy(); return; }
        const responsive = await ready();
        if (!socket.destroyed) socket.end(JSON.stringify({ schema: 1, ok: responsive === true, role, pid, packageRoot, version, instance, nonce: request.nonce }) + "\n");
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.on("error", () => {}); server.unref();
  const stop = () => {
    for (const client of clients) client.destroy();
    server.close();
    if (read(file)?.instance === instance) { try { fs.unlinkSync(file); } catch {} }
  };
  try { atomicFile(file, JSON.stringify({ schema: 1, port: server.address().port, token, instance, role, pid, packageRoot, version })); }
  catch (error) { stop(); throw error; }
  return { stop, instance };
}

async function requestProbe(role, target, { homeDir, timeoutMs }) {
  const endpoint = read(endpointPath(homeDir, role));
  if (endpoint?.schema !== 1 || endpoint.role !== role || endpoint.packageRoot !== target.packageRoot || endpoint.version !== target.version
    || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || !/^[a-f0-9]{64}$/.test(endpoint.token || "")) return { ok: false, reason: `${role}-probe-unavailable` };
  return new Promise(resolve => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
    let buffer = "", done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, reason: `${role}-probe-timeout` }), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ token: endpoint.token, nonce }) + "\n"));
    socket.on("error", () => finish({ ok: false, reason: `${role}-probe-failed` }));
    socket.on("end", () => finish({ ok: false, reason: `${role}-probe-closed` }));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 2048) { finish({ ok: false, reason: "probe-response-too-large" }); return; }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        const ok = response.schema === 1 && response.ok === true && response.nonce === nonce && response.role === role
          && response.instance === endpoint.instance && response.pid === endpoint.pid && response.packageRoot === target.packageRoot && response.version === target.version;
        finish({ ok, pid: response.pid, instance: response.instance });
      } catch { finish({ ok: false, reason: "probe-response-invalid" }); }
    });
  });
}

async function probeRuntime(target, { homeDir = os.homedir(), timeoutMs = 2000 } = {}) {
  // Older stock builds cannot answer this protocol. Preserve their migration
  // route, but never promote that weaker observation to proven release health.
  if (!fs.existsSync(path.join(target.packageRoot, "bootstrap", "recovery-probe.cjs"))) return { ok: true, legacy: true };
  const [daemon, pill] = await Promise.all(["daemon", "pill"].map(role => requestProbe(role, target, { homeDir, timeoutMs })));
  return { ok: daemon.ok && pill.ok, daemon, pill, identity: `${daemon.instance}:${pill.instance}` };
}
module.exports = { startRecoveryResponder, probeRuntime, requestProbe, endpointPath };
