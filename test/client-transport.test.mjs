import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RelayClient, closeRelayConnections, secureRelayApiUrl } from "../src/client.js";

// Transport tests exercise tiny fake HTTP servers. They must not discover the
// developer's real enrolled device and add E2EE status traffic those servers do
// not implement. A test run is hermetic regardless of who runs it.
const previousRelayConfig = process.env.RELAY_CONFIG;
const transportConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-client-transport-"));
process.env.RELAY_CONFIG = path.join(transportConfigDir, "config.json");
after(() => {
  if (previousRelayConfig === undefined) delete process.env.RELAY_CONFIG;
  else process.env.RELAY_CONFIG = previousRelayConfig;
  fs.rmSync(transportConfigDir, { recursive: true, force: true });
});

const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtimeDependencies = JSON.parse(fs.readFileSync(new URL("../runtime-dependencies.json", import.meta.url), "utf8"));

test("every API call goes over a kept-alive connection, not a fresh handshake", () => {
  // Measured against production: a cold call costs ~0.95s and a warm one ~0.22s,
  // while the server answers in ~1ms. Node's built-in fetch holds an idle socket
  // for only 4s — exactly the daemon's poll interval — so bare fetch re-did the
  // TCP and TLS handshake on essentially every request. This was the single
  // largest source of the "chat is slow" report.
  assert.match(client, /keepAliveTimeout: 60_000/);
  assert.match(client, /keepAliveMaxTimeout: 300_000/);
  if (pkg.relayDistribution === "bridge-runtime") {
    assert.deepEqual(pkg.dependencies, runtimeDependencies, "the bridge carries exactly the signed runtime graph");
  } else {
    assert.deepEqual(pkg.dependencies, {}, "the first-contact installer remains dependency-free");
  }
  assert.ok(runtimeDependencies.undici, "the signed native runtime carries the configurable dispatcher");

  // The request path must use the kept-alive wrapper, never bare fetch.
  assert.match(client, /const res = await keepAliveFetch\(`\$\{this\.url\}\$\{path\}`/);
  const requestBody = client.slice(client.indexOf("async #req("), client.indexOf("me()"));
  assert.doesNotMatch(requestBody, /await fetch\(/, "no bare fetch on the request path");

  // A missing undici must degrade to working-but-slower, never to a crash.
  assert.match(client, /fetch: \(u, i\) => fetch\(u, i\)/);
});

test("the connection pool can be closed, so a short-lived CLI still exits", () => {
  assert.match(client, /export async function closeRelayConnections\(\)/);
  assert.match(client, /pool\.close\(\)\.catch/);
});

test("remote Relay traffic requires HTTPS while localhost remains available", () => {
  assert.equal(secureRelayApiUrl("https://api.sendrelays.com/"), "https://api.sendrelays.com");
  assert.equal(secureRelayApiUrl("http://127.0.0.1:4000/"), "http://127.0.0.1:4000");
  assert.throws(
    () => new RelayClient({ url: "http://api.example.com", token: "secret" }),
    /requires HTTPS/,
  );
});

async function flakyTransportServer(t, responseBody = { ok: true }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      if (requests.length === 1) {
        // Model the App Runner cutover exactly: the old revision accepts a
        // kept-alive request, then its socket vanishes before the response.
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(responseBody));
    });
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function captureTransportWarnings(t) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = original; });
  return warnings;
}

test("a read survives one App Runner socket cutover on a fresh pool", async (t) => {
  const { requests, url } = await flakyTransportServer(t, { user: { id: "user_after_cutover" } });
  const warnings = captureTransportWarnings(t);
  const relay = new RelayClient({ url, token: "dev_test" });

  assert.deepEqual(await relay.me(), { user: { id: "user_after_cutover" } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "GET"]);
  assert.match(warnings.join("\n"), /UND_ERR_SOCKET.*retrying GET once with a fresh connection/);
});

test("an idempotency-protected write retries with the exact same body", async (t) => {
  const { requests, url } = await flakyTransportServer(t, { relayId: "relay_after_cutover" });
  const warnings = captureTransportWarnings(t);
  const relay = new RelayClient({ url, token: "dev_test" });
  const payload = {
    kind: "message",
    recipient: { self: true },
    forHuman: "still once",
    idempotencyKey: "cutover-send-once",
  };

  assert.deepEqual(await relay.sendRelay(payload), { relayId: "relay_after_cutover" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => JSON.parse(request.body)), [payload, payload]);
  assert.match(warnings.join("\n"), /UND_ERR_SOCKET.*retrying POST once with a fresh connection/);
});

test("a write without an idempotency key is never replayed after a lost response", async (t) => {
  const { requests, url } = await flakyTransportServer(t, { ok: true });
  const warnings = captureTransportWarnings(t);
  const relay = new RelayClient({ url, token: "dev_test" });

  const error = await relay.createMcpBrowserHandoff().then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error);
  assert.equal(requests.length, 1);
  assert.equal(error.relayTransportCode, "UND_ERR_SOCKET");
  assert.equal(error.relayTransportCauseName, "SocketError");
  assert.equal(error.relayTransportAttempts, 1);
  assert.match(warnings.join("\n"), /UND_ERR_SOCKET.*POST was not retried/);
});

test("bodyless delete requests do not claim to contain JSON", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relay = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });

  await relay.deleteContact("contact 1");
  await relay.deleteGroup("group 1");
  await relay.removeGroupMember("group 2", "contact 2");

  assert.deepEqual(requests, [
    { method: "DELETE", url: "/v1/contacts/contact%201", contentType: undefined, body: "" },
    { method: "DELETE", url: "/v1/contact-groups/group%201", contentType: undefined, body: "" },
    {
      method: "DELETE",
      url: "/v1/contact-groups/group%202/members/contact%202",
      contentType: undefined,
      body: "",
    },
  ]);
});

test("a batch of human reads fans out to the recipient-scoped route, never the no-op shim", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : {} });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relay = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });

  const result = await relay.markManyRead(["relay one", "relay two", "relay one"], {
    idempotencyKey: "preview-chat-read",
    source: "relay_pill_open",
  });
  assert.deepEqual(result.relayIds, ["relay one", "relay two"]);
  // POST /v1/inbox/read is retained only so older companions do not 404. It
  // answers 200 having updated nothing, so a human read routed through it is
  // lost in silence: nothing may reach it.
  assert.deepEqual(requests.filter((entry) => entry.url === "/v1/inbox/read"), []);
  assert.deepEqual(
    requests.sort((a, b) => a.url.localeCompare(b.url)),
    [
      {
        method: "POST",
        url: "/v1/relays/relay%20one/read",
        body: { source: "relay_pill_open", idempotencyKey: "preview-chat-read:relay one" },
      },
      {
        method: "POST",
        url: "/v1/relays/relay%20two/read",
        body: { source: "relay_pill_open", idempotencyKey: "preview-chat-read:relay two" },
      },
    ],
  );
});

test("opening a canonical chat uses the accepted pill source and qualifies the visible surface", async (t) => {
  let request;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      request = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relay = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });

  await relay.markChatRead("chat code", "pill-chat-read-code", "slack", { includeSlack: true });

  assert.deepEqual(request, {
    method: "POST",
    url: "/v1/chats/chat%20code/read",
    body: {
      source: "relay_pill_open",
      idempotencyKey: "pill-chat-read-code",
      surface: "slack",
      includeSlack: true,
    },
  });
});

test("a locally reviewed long relay completes the API's exact-draft soft review", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.setHeader("content-type", "application/json");
      if (!parsed.longForHumanReviewToken) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "human_message_review_required", reviewToken: "review_exact_draft" }));
      } else {
        res.end(JSON.stringify({ relayId: "relay_sent" }));
      }
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relayClient = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });
  const payload = { forHuman: "long draft", longForHumanConfirmed: true, idempotencyKey: "review-key" };
  const result = await relayClient.sendRelay(payload);
  assert.equal(result.relayId, "relay_sent");
  assert.deepEqual(requests, [payload, { ...payload, longForHumanReviewToken: "review_exact_draft" }]);
});

test("an unreviewed client receives the API soft review without automatic bypass", async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.statusCode = 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "human_message_review_required", reviewToken: "not_auto_used" }));
    });
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relayClient = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });
  await assert.rejects(relayClient.sendRelay({ forHuman: "long draft", idempotencyKey: "review-key" }), /human_message_review_required/);
  assert.equal(calls, 1);
});

test("a moved share chat reaches the caller with the id it moved to", async (t) => {
  const server = http.createServer((req, res) => {
    res.statusCode = 410;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "chat_moved",
        chatId: "chat_0123456789abcdef01234567",
        message: "That conversation moved when the recipient claimed the link.",
        details: { instruction: "Fetch it again with the chatId in this response." },
      }),
    );
  });
  t.after(async () => {
    await closeRelayConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const relay = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_test" });

  // A share chat re-keys the instant its link is claimed, so the id the caller
  // was holding stops resolving. Carrying only the message would leave every
  // caller printing "conversation deleted" at a live conversation.
  const err = await relay.chat("chat_stale").then(
    () => null,
    (error) => error,
  );
  assert.ok(err, "a 410 is still an error");
  assert.equal(err.status, 410);
  assert.equal(err.body.error, "chat_moved");
  assert.equal(err.body.chatId, "chat_0123456789abcdef01234567");
  assert.equal(err.message, "That conversation moved when the recipient claimed the link.");
});
