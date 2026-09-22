import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { localEndpoint } from "../skill/relay/scripts/relay-local.mjs";

const helper = fileURLToPath(new URL("../skill/relay/scripts/relay-protocol.mjs", import.meta.url));
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-direct-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const state = { status: 200, userId: "usr_test" };
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: req.url, method: req.method, body });
    res.setHeader("content-type", "application/json");
    res.statusCode = state.status;
    if (state.status !== 200) return res.end(JSON.stringify({ error: state.status === 401 ? "invalid_token" : "forbidden" }));
    if (req.url === "/v1/me") return res.end(JSON.stringify({ user: { id: state.userId } }));
    if (req.url === "/v1/relays" && req.method === "POST") return res.end(JSON.stringify({ relayId: "relay_once", state: "sent" }));
    if (req.url.startsWith("/v1/relays/")) return res.end(JSON.stringify({ packet: { forHuman: "Human text", forAgent: "Full agent context" } }));
    return res.end(JSON.stringify(state.response ?? { groups: [], items: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = path.join(root, "agent-protocol.json");
  const descriptor = path.join(root, "agent-local.json");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const grant = { consentVersion: 2, local: true, apiUrl, account: { relayUserId: "usr_test" }, accessToken: "web_fixture_only_0123456789012345" };
  fs.writeFileSync(config, JSON.stringify(grant));
  const env = { ...process.env, RELAY_AGENT_TRANSPORT: "auto", RELAY_CONFIG_DIR: root, RELAY_AGENT_CONFIG: config, RELAY_AGENT_LOCAL: descriptor, RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  const run = (args, body) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(body === undefined ? "" : JSON.stringify(body));
  });
  const local = async (respond) => {
    const endpoint = localEndpoint(descriptor);
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, endpoint, capability: "a".repeat(64), accountId: "usr_test", apiUrl, toolCatalogVersion: 1 }), { mode: 0o600 });
    const socketServer = net.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (input.includes("\n")) respond(socket, JSON.parse(input.trim()));
      });
    });
    await new Promise((resolve) => socketServer.listen(endpoint, resolve));
    t.after(() => new Promise((resolve) => socketServer.close(resolve)));
  };
  return { root, config, descriptor, grant, calls, state, run, local };
}

test("direct chat tools omit redundant presentation without changing raw HTTP responses", async (t) => {
  const f = await fixture(t);
  const full = { relayId: "relay_one", threadId: "root", inReplyToRelayId: "parent", forHuman: "Full text", forAgent: "Full evidence\nSecond line", taskState: "started" };
  const summary = { relayId: "relay_two", forHuman: "", preview: "Summary only" };
  f.state.response = { chatId: "chat_one", threadIds: ["root"], items: [{ ...full, preview: "Full text" }, summary], nextBeforeCursor: "opaque" };
  const result = await f.run(["--transport=https", "call", "relay_chat_fetch"], { chatId: "chat_one" });
  assert.equal(result.code, 0, result.stderr);
  const text = JSON.parse(result.stdout).content[0].text;
  assert.equal(text.includes("\n"), false);
  assert.deepEqual(JSON.parse(text), { chatId: "chat_one", items: [full, summary], nextBeforeCursor: "opaque" });
  const raw = await f.run(["--transport=https", "request", "GET", "/v1/chats/chat_one"]);
  assert.equal(raw.code, 0, raw.stderr);
  assert.deepEqual(JSON.parse(raw.stdout), f.state.response);
});

test("explicit HTTPS ignores a corrupt local descriptor for status, discovery, reads and sends", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.descriptor, "broken local installation");
  const status = await f.run(["--transport=https", "status"]);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).transport, "https");
  assert.equal(JSON.parse(status.stdout).account.relayUserId, "usr_test");
  const tools = await f.run(["--transport=https", "tools"]);
  assert.equal(tools.code, 0, tools.stderr);
  const names = JSON.parse(tools.stdout).tools.map((tool) => tool.name);
  assert.ok(names.includes("relay_send"));
  assert.ok(!names.includes("relay_ai_session"));
  const read = await f.run(["--transport=https", "call", "relay_inbox_list"], { relayIds: ["relay_example"] });
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(JSON.parse(read.stdout).content[0].text).items[0].packet.forAgent, "Full agent context");
  assert.equal(f.calls.some((call) => call.path.endsWith("/read")), false);
  const body = { kind: "message", title: "Recovery test", recipient: { self: true }, forHuman: "Hello", forAgent: "Full context", idempotencyKey: "direct-send-once" };
  for (let i = 0; i < 2; i++) {
    const sent = await f.run(["--transport=https", "call", "relay_send"], body);
    assert.equal(sent.code, 0, sent.stderr);
  }
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(f.calls.find((call) => call.method === "POST").body, { ...body, attachments: [] });
  const changed = await f.run(["--transport=https", "call", "relay_send"], { ...body, forHuman: "Changed" });
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /different message/);
});

test("HTTPS never contacts a live Companion, changes identities, or bypasses revoked grants", async (t) => {
  const f = await fixture(t);
  let localCalls = 0;
  await f.local((socket) => { localCalls++; socket.end(JSON.stringify({ value: { groups: [] } }) + "\n"); });
  f.state.userId = "usr_other";
  assert.match((await f.run(["--transport=https", "groups"])).stderr, /different account/);
  f.state.userId = "usr_test";
  f.state.status = 401;
  const revoked = await f.run(["--transport=https", "status"]);
  assert.equal(revoked.code, 1);
  assert.equal(JSON.parse(revoked.stdout).connected, false);
  assert.equal(JSON.parse(revoked.stdout).status, 401);
  f.state.status = 403;
  assert.equal((await f.run(["--transport=https", "groups"])).code, 1);
  assert.equal(localCalls, 0);
  assert.ok(f.calls.every((call) => call.path === "/v1/me"));
});

test("direct HTTPS chat reads default to 25 and carry opaque paging cursors", async (t) => {
  const f = await fixture(t);
  const first = await f.run(["--transport=https", "call", "relay_chat_fetch"], { chatId: "chat_one" });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(f.calls.at(-1).path, "/v1/chats/chat_one?surface=relay&limit=25");
  const older = await f.run(["--transport=https", "call", "relay_chat_fetch"], { chatId: "chat_one", limit: 10, beforeCursor: "opaque+/=" });
  assert.equal(older.code, 0, older.stderr);
  const query = new URL(f.calls.at(-1).path, "http://localhost").searchParams;
  assert.equal(query.get("beforeCursor"), "opaque+/=");
  assert.equal(query.get("limit"), "10");
  const invalid = await f.run(["--transport=https", "call", "relay_chat_fetch"], { chatId: "chat_one", beforeCursor: "a", afterCursor: "b" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /not both/);
});

test("missing, expired and guest credentials give independent recovery without consulting Companion", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.descriptor, "invalid");
  for (const credential of [undefined, { ...f.grant, accessToken: "guest_key_only" }, { ...f.grant, expiresAt: "2020-01-01" }, { ...f.grant, expiresAt: "invalid" }]) {
    if (credential) fs.writeFileSync(f.config, JSON.stringify(credential));
    else fs.rmSync(f.config);
    const result = await f.run(["--transport=https", "status"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).connected, false);
    assert.match(result.stdout, /connect-start/);
    assert.doesNotMatch(result.stdout + result.stderr, /guest_key_only|web_fixture_only/);
  }
  assert.equal(f.calls.length, 0);
});

test("auto tools recovers from a lost local read but never replays a dispatched tool mutation", async (t) => {
  const f = await fixture(t);
  await f.local((socket) => socket.end());
  const tools = await f.run(["tools"]);
  assert.equal(tools.code, 0, tools.stderr);
  assert.equal(JSON.parse(tools.stdout).transport, "https");
  f.calls.length = 0;
  const sent = await f.run(["call", "relay_send"], { idempotencyKey: "not-enough-for-replay" });
  assert.equal(sent.code, 1);
  assert.equal(f.calls.length, 0);
  const localOnly = await f.run(["--transport=local", "tools"]);
  assert.equal(localOnly.code, 1);
  assert.equal(f.calls.length, 0);
});

test("only exact local route absence falls back; application 404 and permission failures remain authoritative", async (t) => {
  const f = await fixture(t);
  let failure = { error: "local_route_unavailable", status: 404 };
  await f.local((socket) => socket.end(JSON.stringify(failure) + "\n"));
  assert.equal((await f.run(["groups"])).code, 0);
  for (const refused of [{ error: "not_found", status: 404 }, { error: "forbidden", status: 403 }]) {
    failure = refused;
    f.calls.length = 0;
    assert.equal((await f.run(["groups"])).code, 1);
    assert.equal(f.calls.length, 0);
  }
});

test("direct catalog excludes higher-consent operations and refuses unsupported fields and local work", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ ...f.grant, consentVersion: 1 }));
  const catalog = JSON.parse((await f.run(["--transport=https", "tools"])).stdout);
  assert.ok(!catalog.tools.some((tool) => tool.name === "relay_send"));
  const refused = await f.run(["--transport=https", "call", "relay_inbox_list"], { todoStatuses: ["triage"] });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not supported over direct HTTPS/);
  assert.equal((await f.run(["--transport=https", "deliver"], {})).code, 1);
  assert.ok(f.calls.every((call) => call.path === "/v1/me"));
});

test("reply selection and share links retain the approved wire contract", async (t) => {
  const f = await fixture(t);
  const sent = await f.run(["--transport=https", "call", "relay_send"], {
    recipient: { self: true }, kind: "message", title: "Selected reply", forHuman: "Human", forAgent: "Context",
    replyToRelayId: "relay_selected", nature: ["finding"], asks: [], idempotencyKey: "selected-reply-1",
  });
  assert.equal(sent.code, 0, sent.stderr);
  const body = f.calls.find((call) => call.method === "POST").body;
  assert.equal(body.inReplyToRelayId, "relay_selected");
  assert.equal(Object.hasOwn(body, "replyToRelayId"), false);
  assert.deepEqual(body.nature, ["finding"]);
  assert.deepEqual(body.asks, []);
  const minted = await f.run(["--transport=https", "call", "relay_share_link"], {
    forHuman: "A letter for a guest", forAgent: "Guest context", idempotencyKey: "direct-link-1", nature: ["finding"], asks: [],
  });
  assert.equal(minted.code, 0, minted.stderr);
  assert.ok(f.calls.some((call) => call.path === "/v1/share-links" && call.body.forAgent === "Guest context"));
  const linkBody = f.calls.find((call) => call.path === "/v1/share-links").body;
  assert.deepEqual(linkBody.nature, ["finding"]);
  assert.deepEqual(linkBody.asks, []);
  const revoked = await f.run(["--transport=https", "call", "relay_share_link"], { action: "revoke", relayId: "relay_link", idempotencyKey: "direct-revoke-1" });
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.ok(f.calls.some((call) => call.path === "/v1/share-links/relay_link" && call.method === "DELETE"));
});

test("direct HTTPS can edit and delete the person's own sent messages under the messaging grant", async (t) => {
  const f = await fixture(t);
  const catalog = JSON.parse((await f.run(["--transport=https", "tools"])).stdout);
  for (const name of ["relay_message_edit", "relay_message_delete"]) {
    assert.ok(catalog.tools.some((tool) => tool.name === name), `${name} is in the direct catalog`);
  }
  const edited = await f.run(["--transport=https", "call", "relay_message_edit"], {
    relayId: "relay_sent", forHuman: "Corrected.", forAgent: "Corrected context.", nature: ["finding"], asks: [],
    idempotencyKey: "direct-edit-1", longForHumanConfirmed: true,
  });
  assert.equal(edited.code, 0, edited.stderr);
  const patch = f.calls.find((call) => call.method === "PATCH");
  assert.equal(patch.path, "/v1/messages/relay_sent");
  assert.deepEqual(patch.body, { forHuman: "Corrected.", forAgent: "Corrected context.", nature: ["finding"], asks: [], idempotencyKey: "direct-edit-1" });
  // The review flag is the helper's business; the wire body never carries it.
  assert.equal(Object.hasOwn(patch.body, "longForHumanConfirmed"), false);
  const nothing = await f.run(["--transport=https", "call", "relay_message_edit"], { relayId: "relay_sent", idempotencyKey: "direct-edit-2" });
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /requires forHuman, forAgent, nature or asks/);
  const removed = await f.run(["--transport=https", "call", "relay_message_delete"], { relayId: "relay_sent", idempotencyKey: "direct-delete-1" });
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(f.calls.some((call) => call.method === "DELETE" && call.path === "/v1/messages/relay_sent" && call.body.idempotencyKey === "direct-delete-1"));
  // A version-1 grant never had message writes; the operations stay out of its catalog.
  fs.writeFileSync(f.config, JSON.stringify({ ...f.grant, consentVersion: 1 }));
  const older = JSON.parse((await f.run(["--transport=https", "tools"])).stdout);
  assert.ok(!older.tools.some((tool) => tool.name === "relay_message_edit" || tool.name === "relay_message_delete"));
});

test("a key alone does not make arbitrary protocol mutations replayable", async (t) => {
  const f = await fixture(t);
  await f.local((socket) => socket.end());
  const result = await f.run(["request", "POST", "/v1/invite-link"], { idempotencyKey: "arbitrary-key-1" });
  assert.equal(result.code, 1);
  assert.equal(f.calls.length, 0);
});

test("direct status identifies an unreachable API without claiming to be connected", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ ...f.grant, apiUrl: "http://127.0.0.1:1" }));
  const result = await f.run(["--transport=https", "status"]);
  assert.equal(result.code, 1);
  const status = JSON.parse(result.stdout);
  assert.equal(status.connected, false);
  assert.match(status.message, /Direct HTTPS could not reach http:\/\/127\.0\.0\.1:1/);
});
