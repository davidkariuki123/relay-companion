import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  E2EE_REMOTE_MCP_INSTRUCTIONS,
  E2EE_REMOTE_TOOL_NAMES,
  handleCall,
  toolsForE2eeRemoteAccount,
} from "../src/mcp.js";
import {
  assertE2eeRemoteReady,
  assertE2eeRemoteToolCall,
  readE2eeRemoteAttachment,
  sanitizeE2eeRemoteToolResult,
  startE2eeRemoteMcpHttpServer,
} from "../src/e2ee-remote-mcp.js";

function fakeClient() {
  return {
    identity: { userId: "user_1", deviceId: "device_1", deviceToken: "device-token" },
    accountDrift() { return { status: "same", bound: this.identity, current: this.identity }; },
    async ensureE2eeReady() { this.prepared = (this.prepared || 0) + 1; },
  };
}

const readiness = {
  identityAvailable: () => true,
  statusReader: async () => ({ mode: "required" }),
};

test("remote Claude exposes only the E2EE messaging surface", () => {
  const tools = toolsForE2eeRemoteAccount({ requests: true, aiSessions: true, connectors: true });
  const names = new Set(tools.map((tool) => tool.name));
  assert.deepEqual(names, E2EE_REMOTE_TOOL_NAMES);
  for (const forbidden of [
    "relay_share_link",
    "relay_ai_sessions",
    "relay_ai_session",
    "relay_connector_list_tools",
    "relay_connector_call_tool",
    "relay_file_download",
    "relay_recently_deleted_list",
  ]) {
    assert.equal(names.has(forbidden), false, `${forbidden} stays outside the E2EE connector`);
  }
  assert.doesNotMatch(E2EE_REMOTE_MCP_INSTRUCTIONS, /mint a link/i);
  assert.match(E2EE_REMOTE_MCP_INSTRUCTIONS, /never supply a plaintext fallback/i);

  for (const name of ["relay_send", "relay_chat_send"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "files"), false);
    const properties = tool.inputSchema.properties.attachments.items.properties;
    assert.equal(Object.hasOwn(properties, "path"), false);
    assert.equal(Object.hasOwn(properties, "filePath"), false);
    assert.ok(Object.hasOwn(properties, "contentBase64"));
  }
});

test("remote Claude fails closed unless the local device is enrolled and E2EE is enabled", async () => {
  const client = fakeClient();
  await assert.rejects(
    assertE2eeRemoteReady(client, { identityAvailable: () => false }),
    /not an enrolled E2EE device/i,
  );
  await assert.rejects(assertE2eeRemoteReady(client, {
    identityAvailable: () => true,
    statusReader: async () => ({ mode: "off" }),
  }), /disabled until.*enables E2EE/i);
  await assertE2eeRemoteReady(client, {
    identityAvailable: () => true,
    statusReader: async () => ({ mode: "optional" }),
  });
  await assertE2eeRemoteReady(client, readiness);
  assert.equal(client.prepared, 2);
});

test("remote Claude cannot call hidden tools or read local attachment paths", () => {
  assert.throws(() => assertE2eeRemoteToolCall("relay_share_link", {}), /outside the E2EE Claude connector/);
  assert.throws(
    () => assertE2eeRemoteToolCall("relay_send", { files: ["C:\\secret.txt"] }),
    /cannot read files from the Relay device/i,
  );
  assert.throws(
    () => assertE2eeRemoteToolCall("relay_chat_send", { attachments: [{ path: "/secret.txt" }] }),
    /cannot read attachment paths/i,
  );
  assert.doesNotThrow(() => assertE2eeRemoteToolCall("relay_send", {
    attachments: [{ filename: "note.txt", contentBase64: "aGVsbG8=" }],
  }));
});

test("remote message results expose attachment ids but never device paths or file keys", () => {
  const result = sanitizeE2eeRemoteToolResult({ content: [{ type: "text", text: JSON.stringify({
    relayId: "erelay_1",
    attachments: [{
      id: "eatt_1", name: "plan.txt", contentType: "text/plain", bytes: 5, sha256: "abc",
      localPath: "C:\\Users\\person\\.relay\\attachments\\plan.txt",
      key: "secret-file-key", fileIv: "secret-iv", downloadUrl: "https://ciphertext.invalid/file",
    }],
  }) }] });
  const text = result.content[0].text;
  assert.doesNotMatch(text, /Users|secret-file-key|ciphertext\.invalid/);
  assert.match(text, /relay_attachment_read/);
  assert.match(text, /erelay_1/);
  assert.match(text, /eatt_1/);
});

test("remote attachment reads are bound to one authenticated Relay attachment", async () => {
  const file = new URL("./fixtures/e2ee-remote-attachment.txt", import.meta.url);
  const body = Buffer.from("hello encrypted attachment", "utf8");
  const client = {
    async fetchRelayPackets(ids) {
      assert.deepEqual(ids, ["erelay_1"]);
      return { packets: { erelay_1: { packet: { attachments: [{
        id: "eatt_1",
        name: "note.txt",
        contentType: "text/plain",
        bytes: body.length,
        sha256: "f84602b44c08d30f5a6e110a1711f1f7bb915fc23dfdf6dcfe42ec560f928b65",
        localPath: file,
      }] } } } };
    },
  };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(file, body));
  try {
    const result = await readE2eeRemoteAttachment(client, { relayId: "erelay_1", attachmentId: "eatt_1" });
    const opened = JSON.parse(result.content[0].text);
    assert.equal(Buffer.from(opened.attachment.contentBase64, "base64").toString("utf8"), body.toString("utf8"));
    assert.equal(opened.readStateChanged, false);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(file, { force: true }));
  }
});

test("an empty E2EE contact search never consults the plaintext share-link path", async () => {
  let legacyShareReads = 0;
  const result = await handleCall({
    async searchContacts() { return { matches: [], groups: [] }; },
    async sent() { legacyShareReads += 1; return { items: [] }; },
  }, "relay_contacts_search", { query: "Priya" }, {
    features: { requests: true },
    shareLinks: false,
  });
  assert.equal(legacyShareReads, 0);
  assert.match(result.content[0].text, /Public share links are unavailable here/);
  assert.match(result.content[0].text, /must first join or be added to Relay/);
});

test("loopback Streamable HTTP MCP requires its bearer and lists the safe tools", async (t) => {
  const runtime = await startE2eeRemoteMcpHttpServer({
    client: fakeClient(),
    features: { requests: true, aiSessions: true, connectors: true },
    readiness,
    token: "test-runtime-secret",
  });
  t.after(() => runtime.close());

  const unauthorized = await fetch(runtime.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(unauthorized.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL(runtime.url), {
    requestInit: { headers: { Authorization: "Bearer test-runtime-secret" } },
  });
  const client = new Client({ name: "claude-ai", version: "test" });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), E2EE_REMOTE_TOOL_NAMES);
});

test("the device endpoint refuses non-loopback exposure", async () => {
  await assert.rejects(
    startE2eeRemoteMcpHttpServer({
      host: "0.0.0.0",
      client: fakeClient(),
      features: { requests: true },
      readiness,
    }),
    /must bind to loopback/i,
  );
});
