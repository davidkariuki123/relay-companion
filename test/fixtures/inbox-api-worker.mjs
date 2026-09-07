import http from "node:http";
import { parentPort } from "node:worker_threads";

let version = 0;
const items = [];
const waiting = new Set();
const json = (res, data) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/v1/account-events/wait") {
    const since = url.searchParams.get("since");
    if (since === null || since !== String(version)) return json(res, { version: String(version), changed: since !== null });
    waiting.add(res); res.on("close", () => waiting.delete(res)); parentPort.postMessage({ waiting: true }); return;
  }
  if (url.pathname === "/v1/inbox") return json(res, { items });
  if (url.pathname === "/v1/relays/packets") {
    let body = ""; req.on("data", (part) => { body += part; });
    req.on("end", () => json(res, { packets: Object.fromEntries(JSON.parse(body).ids.map((id) => [id, {
      packet: { relayId: id, forHuman: "Local fixture", forAgent: "", attachments: [], sender: { name: "Fixture" } },
    }])) })); return;
  }
  res.statusCode = 404; json(res, { error: "unknown fixture route" });
});
parentPort.on("message", (message) => {
  if (!message.deliver) return;
  setTimeout(() => {
    const createdAt = new Date().toISOString();
    items.push({ relayId: message.deliver, createdAt, updatedAt: createdAt, state: "delivered", sender: { name: "Fixture" } });
    version++;
    for (const res of waiting) json(res, { version: String(version), changed: true });
    waiting.clear();
  }, message.delayMs || 0);
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage({ url: `http://127.0.0.1:${server.address().port}` }));
