import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { allowed, atomicWrite } from "../skill/relay/scripts/relay-protocol.mjs";
import { LOCAL_MAX_BYTES, localDescriptorPath, localEndpoint, readLocalDescriptor } from "../skill/relay/scripts/relay-local.mjs";
import outboxModule from "./outbox.cjs";
import { relayReferencePrompt } from "./session-delivery.js";

// The daemon owns the credential, encrypted client and durable outgoing queue.
// MCP and command clients share RelayClient operations, not transport framing.
export function createAgentDispatcher({ client, outboxFile, listDestinations, deliver, accountId }) {
  function assertAccount(expected = accountId) {
    if (expected !== accountId || client.identity?.userId !== accountId || client.accountDrift().status !== "same") {
      throw new Error("Relay's account changed. Reconnect this agent to the intended account. Nothing was sent or read.");
    }
  }
  const queue = outboxModule.createOutbox({
    file: outboxFile,
    writeStore: atomicWrite,
    send: async (entry) => { assertAccount(); return client.sendRelay(entry.protocolBody); },
  });
  async function dispatch({ method, path: route, body, accountId: expected }) {
    assertAccount(expected);
    const url = new URL(route, "http://relay.local");
    const parts = url.pathname.split("/").map(decodeURIComponent);
    if (method === "GET" && url.pathname === "/local/outbox") return { items: queue.list().map(({ idempotencyKey, state, relayId, lastError }) => ({ idempotencyKey, state, relayId, lastError })) };
    if (method === "POST" && route === "/local/outbox/retry") {
      const item = queue.list().find((entry) => entry.idempotencyKey === body?.idempotencyKey);
      if (!item) throw new Error("That outgoing message is not in this account's queue.");
      if (item.state !== "sent") { queue.retry(item.id); await queue.flush(); }
      const result = queue.list().find((entry) => entry.id === item.id);
      return { idempotencyKey: result.idempotencyKey, state: result.state, relayId: result.relayId, lastError: result.lastError };
    }
    if (method === "GET" && /^\/local\/destinations\/(claude|codex)$/.test(route)) return listDestinations(parts[3]);
    if (method === "POST" && route === "/local/deliver") {
      if (body?.approved !== true || !body.relayId || !["claude", "codex"].includes(body.target?.provider) || !body.target?.nativeId) {
        throw new Error("Delivery requires an explicitly approved Relay and exact discovered agent destination.");
      }
      await client.fetchRelay(body.relayId); // Verify account access before any local work.
      return deliver({ relayId: body.relayId, target: { provider: body.target.provider, nativeId: body.target.nativeId }, prompt: relayReferencePrompt(body.relayId, { agentProtocol: true }), deliveryMode: "explicit_picker", timeoutMs: 20000 });
    }
    if (!allowed(method, route)) throw new Error("This operation is not part of the Relay agent protocol.");
    if (method === "GET") {
      if (url.pathname === "/v1/me") return client.me();
      if (url.pathname === "/v1/inbox") return client.inbox();
      if (url.pathname === "/v1/sent") return client.sent();
      if (url.pathname === "/v1/contacts/search") return client.searchContacts(url.searchParams.get("q") || "");
      if (url.pathname === "/v1/contact-groups") return client.groups();
      if (url.pathname === "/v1/chats") return client.chats();
      if (parts[2] === "chats") return client.chat(parts[3]);
      if (parts[2] === "threads") {
        if (/^(erelay_|egmsg_)/.test(parts[3])) return client.chatForThread(parts[3]);
        return client.thread(parts[3]);
      }
      if (parts[2] === "relays" && parts[4] === "attachments") {
        if (/^(erelay_|egmsg_)/.test(parts[3])) {
          const fetched = await client.fetchRelay(parts[3]);
          const attachment = fetched.packet?.attachments?.find((item) => item.id === parts[5]);
          if (!attachment?.localPath) throw new Error("This attachment is unavailable on this device.");
          return { attachmentId: parts[5], localPath: attachment.localPath, name: attachment.name, contentType: attachment.contentType };
        }
        return client.attachmentDownloadUrl(parts[3], parts[5]);
      }
      if (parts[2] === "relays") return client.fetchRelay(parts[3]);
    }
    if (method === "POST") {
      if (url.pathname === "/v1/invite-link" || url.pathname === "/v1/invites-v2/link") return client.inviteLink();
      if (parts[4] === "read") return client.markRead(parts[3], body);
      if (url.pathname === "/v1/relays") {
        if (typeof body?.idempotencyKey !== "string" || body.idempotencyKey.length < 8) throw new Error("A stable idempotency key is required.");
        const protocolBody = { ...body, source: { ...body.source, host: "relay-agent-protocol" } };
        const hash = createHash("sha256").update(JSON.stringify(protocolBody)).digest("hex");
        const existing = queue.list().find((item) => item.idempotencyKey === body.idempotencyKey);
        if (existing && existing.protocolHash !== hash) throw new Error("That idempotency key belongs to a different message.");
        queue.enqueue({ idempotencyKey: body.idempotencyKey, recipient: body.recipient, protocolBody, protocolHash: hash });
        await queue.flush();
        const result = queue.list().find((item) => item.idempotencyKey === body.idempotencyKey);
        if (result.state === "failed") throw new Error(result.lastError || "Relay could not send this message.");
        return { relayId: result.relayId, groupSendId: result.groupSendId, threadId: result.threadId, state: result.state === "sent" ? "sent" : "queued", queuedOnDevice: result.state !== "sent", idempotencyKey: result.idempotencyKey };
      }
    }
    throw new Error("Unsupported Relay operation.");
  }
  return { dispatch, start: () => queue.start(), stop: async () => { queue.stop(); await queue.flush(); } };
}

export async function startAgentLocalServer({ client, accountId, apiUrl, file = localDescriptorPath(), listDestinations, deliver }) {
  const endpoint = localEndpoint(file);
  const prior = readLocalDescriptor(file);
  if (prior) {
    const live = await new Promise((resolve) => {
      const probe = net.createConnection(endpoint);
      const done = (value) => { probe.destroy(); resolve(value); };
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
      probe.setTimeout(500, () => done(true));
    });
    if (live) throw new Error("Another Companion owns the local agent connection.");
  }
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const stat = fs.lstatSync(endpoint);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error("Unsafe Relay local endpoint.");
    fs.unlinkSync(endpoint);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const capability = randomBytes(32).toString("hex");
  const dispatcher = createAgentDispatcher({ client, accountId, listDestinations, deliver, outboxFile: path.join(path.dirname(file), `agent-outbox-${createHash("sha256").update(accountId + apiUrl).digest("hex").slice(0, 24)}.json`) });
  let chain = Promise.resolve();
  const server = net.createServer((socket) => {
    let size = 0;
    let consumed = false;
    const chunks = [];
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (consumed) return;
      size += chunk.length;
      if (size > LOCAL_MAX_BYTES) return socket.destroy();
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      consumed = true;
      chain = chain.then(async () => {
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
          const actual = Buffer.from(String(request.capability || ""));
          const expected = Buffer.from(capability);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Local Relay authorization failed.");
          const value = await dispatcher.dispatch(request);
          socket.end(JSON.stringify({ value }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: error.code || "local_request_failed", status: error.status, message: error.message }) + "\n");
        }
      });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
  try {
    atomicWrite(file, { version: 1, endpoint, capability, accountId, apiUrl, pid: process.pid });
    dispatcher.start();
  } catch (error) { dispatcher.stop(); server.close(); throw error; }
  return { close: async () => { await dispatcher.stop(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(file, { force: true }); } };
}
