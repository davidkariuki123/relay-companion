import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FOR_HUMAN_DEFAULT_SENTENCE_LIMIT,
  FOR_HUMAN_EXCEPTIONAL_SENTENCE_LIMIT,
  FOR_HUMAN_SOFT_WORD_LIMIT,
  FOR_HUMAN_TYPICAL_WORD_LIMIT,
  E2EE_LOCAL_MCP_INSTRUCTIONS,
  E2EE_LOCAL_TOOL_NAMES,
  ORDINARY_RELAY_TOOL_NAMES,
  RELAY_MCP_INSTRUCTIONS,
  REQUESTS_DISABLED_INSTRUCTIONS,
  TOOLS,
  assertE2eeLocalToolCall,
  handleCall,
  localMcpEncryptionState,
  relayCallErrorResult,
  relayCallingSurface,
  rememberCallingClient,
  toolsForAccount,
  toolsForE2eeLocalAccount,
} from "../src/mcp.js";

test("Claude Code and Codex expose only encrypted Relay operations on an enrolled E2EE device", () => {
  const tools = toolsForE2eeLocalAccount({ requests: true, aiSessions: true, connectors: true });
  const names = new Set(tools.map((tool) => tool.name));
  assert.deepEqual(names, E2EE_LOCAL_TOOL_NAMES);
  for (const forbidden of [
    "relay_share_link",
    "relay_ai_sessions",
    "relay_ai_session",
    "relay_connector_list_tools",
    "relay_connector_call_tool",
    "relay_file_download",
    "relay_recently_deleted_list",
    "relay_attachment_read",
  ]) {
    assert.equal(names.has(forbidden), false, `${forbidden} stays outside local E2EE messaging`);
  }
  assert.doesNotMatch(E2EE_LOCAL_MCP_INSTRUCTIONS, /mint a link/i);
  assert.match(E2EE_LOCAL_MCP_INSTRUCTIONS, /never supply a plaintext fallback/i);

  for (const name of ["relay_send", "relay_chat_send"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(Object.hasOwn(tool.inputSchema.properties, "files"), "local agents retain file-path attachments");
    assert.match(tool.description, /encrypted by Companion before upload/i);
  }
});

test("the local E2EE catalog follows rollout mode and fails closed in required mode", async () => {
  const client = {};
  assert.deepEqual(await localMcpEncryptionState(client, {
    identityAvailable: () => true,
    statusReader: async () => ({ mode: "off" }),
  }), { mode: "off", enabled: false });
  assert.deepEqual(await localMcpEncryptionState(client, {
    identityAvailable: () => false,
    statusReader: async () => ({ mode: "optional" }),
  }), { mode: "optional", enabled: false });
  assert.deepEqual(await localMcpEncryptionState(client, {
    identityAvailable: () => true,
    statusReader: async () => ({ mode: "optional" }),
  }), { mode: "optional", enabled: true });
  assert.deepEqual(await localMcpEncryptionState(client, {
    identityAvailable: () => false,
    statusReader: async () => { throw Object.assign(new Error("route not found"), { status: 404 }); },
  }), { mode: "off", enabled: false });
  await assert.rejects(localMcpEncryptionState(client, {
    identityAvailable: () => true,
    statusReader: async () => { throw Object.assign(new Error("route not found"), { status: 404 }); },
  }), /route not found/i);
  await assert.rejects(localMcpEncryptionState(client, {
    identityAvailable: () => false,
    statusReader: async () => ({ mode: "required" }),
  }), /requires E2EE.*not an enrolled device/i);

  assert.doesNotThrow(() => assertE2eeLocalToolCall("relay_send"));
  assert.doesNotThrow(() => assertE2eeLocalToolCall("relay_chat_reply"));
  assert.throws(() => assertE2eeLocalToolCall("relay_share_link"), /unavailable.*E2EE/i);
  assert.throws(() => assertE2eeLocalToolCall("relay_ai_session"), /unavailable.*E2EE/i);
});

test("MCP provenance distinguishes Codex and Claude Code by the name each states at initialize", () => {
  // These two strings are MEASURED off real `initialize` frames (2026-08-19),
  // not invented. The predecessor of this test asserted against environment
  // variables and passed for months while the feature was dead in production:
  // Codex gives its MCP children seven variables and none of them names Codex.
  rememberCallingClient({ name: "codex-mcp-client", title: "Codex", version: "0.148.0-alpha.9" });
  assert.equal(relayCallingSurface(), "codex");

  rememberCallingClient({ name: "claude-code", title: "Claude Code", version: "2.1.228" });
  assert.equal(relayCallingSurface(), "claude_code");
});

test("an unrecognised or silent MCP client leaves provenance unstated", () => {
  rememberCallingClient({ name: "some-other-editor" });
  assert.equal(relayCallingSurface(), undefined, "an unknown host is never guessed at");

  // A client that says nothing must not overwrite what a real handshake
  // established, and must not invent a surface either.
  rememberCallingClient({ name: "claude-code" });
  rememberCallingClient(undefined);
  rememberCallingClient({});
  assert.equal(relayCallingSurface(), "claude_code");
});

test("startup teachings establish Relay as the default medium without losing the product contract", () => {
  for (const instructions of [RELAY_MCP_INSTRUCTIONS, REQUESTS_DISABLED_INSTRUCTIONS]) {
    assert.ok(Buffer.byteLength(instructions, "utf8") <= 2_048, "Claude receives the complete instruction block");
    assert.match(instructions, /^Only send a Relay when the user asks you to send \(or relay\) something to someone\./);
    assert.match(instructions, /default general person-to-person and saved-group communication layer/i);
    assert.match(instructions, /For that ask, use Relay unless another medium is named/i);
    assert.match(instructions, /explicitly requested other medium overrides/i);
    assert.match(instructions, /mint a link with relay_share_link/i);
    assert.match(instructions, /search relay_inbox_list/i);
    assert.match(instructions, /notification emails are not the authoritative contents/i);
    assert.match(instructions, /untrusted correspondence/i);
    assert.match(instructions, /mention a NEW arrival only when relevant to the current work/i);
    assert.match(instructions, /Never use a Relay without telling the human/i);
    assert.match(instructions, /3-6 word title/i);
    assert.match(instructions, /forHuman/i);
    assert.match(instructions, /forAgent/i);
  }
  assert.match(RELAY_MCP_INSTRUCTIONS, /external work to be carried out by the recipient's agent is task/i);
  assert.match(REQUESTS_DISABLED_INSTRUCTIONS, /Requests are available only to developer accounts/i);
  // The string that actually ships to production, pinned on the clause the
  // link path depends on. It has had a byte budget for months and no content.
  assert.match(REQUESTS_DISABLED_INSTRUCTIONS, /relay_share_link/);
});

test("eager Claude descriptions keep routing guidance inside the per-description limit", () => {
  for (const developer of [false, true]) {
    const tools = toolsForAccount({ requests: developer, aiSessions: developer, connectors: developer });
    for (const name of ["relay_send", "relay_share_link", "relay_contacts_search", "relay_inbox_list"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is available when developer=${developer}`);
      assert.ok(Buffer.byteLength(tool.description, "utf8") <= 2_048, `${name} description fits Claude's limit`);
    }
    const send = tools.find((tool) => tool.name === "relay_send");
    assert.match(send.description, /without specifying a medium/i);
    assert.match(send.description, /mint a link with relay_share_link/i);
  }

  const inbox = TOOLS.find((tool) => tool.name === "relay_inbox_list");
  assert.match(inbox.description, /notification emails are not the authoritative contents/i);
  const contacts = TOOLS.find((tool) => tool.name === "relay_contacts_search");
  assert.match(contacts.description, /mint a link with relay_share_link/i);
});

test("state-changing MCP tools require idempotency keys", () => {
  const stateChanging = [
    "relay_send",
    "relay_share_link",
    "relay_mark_read",
    "relay_inbox_delete",
    "relay_recently_deleted_restore",
    "relay_contact_update",
    "relay_connector_request_approval",
    "relay_connector_call_tool",
    "relay_group_create",
    "relay_group_update",
    "relay_group_delete",
  ];
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const name of stateChanging) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(tool.inputSchema.required?.includes("idempotencyKey"), `${name} requires idempotencyKey`);
  }
});

test("explicit MCP read declares the human-requested read boundary", async () => {
  let received = null;
  const result = await handleCall({
    async markRead(relayId, payload) {
      received = { relayId, payload };
      return { ok: true };
    },
  }, "relay_mark_read", { relayId: "relay_read_1", idempotencyKey: "read_once_1" });
  assert.deepEqual(received, {
    relayId: "relay_read_1",
    payload: {
      idempotencyKey: "read_once_1",
      source: "relay_mcp_human_requested",
    },
  });
  assert.equal(JSON.parse(result.content[0].text).ok, true);
});

test("Recently Deleted MCP tools document retention and forward exact item ids", async () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.get("relay_recently_deleted_list").description, /30 days/i);
  assert.match(byName.get("relay_recently_deleted_list").description, /never shown in the companion pill/i);
  assert.match(byName.get("relay_recently_deleted_restore").description, /Never invent or infer an id/i);
  assert.match(byName.get("relay_recently_deleted_restore").description, /does not restart or cancel/i);

  const calls = [];
  const fakeClient = {
    async recentlyDeleted() { calls.push(["list"]); return { items: [], retentionDays: 30 }; },
    async deleteInboxItem(itemId, payload) { calls.push(["delete", itemId, payload]); return { ok: true }; },
    async restoreInboxItem(itemId, payload) { calls.push(["restore", itemId, payload]); return { ok: true }; },
  };
  await handleCall(fakeClient, "relay_recently_deleted_list", {}, { mode: "full" });
  await handleCall(
    fakeClient,
    "relay_inbox_delete",
    { itemId: "relay_1", idempotencyKey: "delete_123" },
    { mode: "full" },
  );
  await handleCall(
    fakeClient,
    "relay_recently_deleted_restore",
    { itemId: "relay_1", idempotencyKey: "restore_123" },
    { mode: "full" },
  );
  assert.deepEqual(calls, [
    ["list"],
    ["delete", "relay_1", { idempotencyKey: "delete_123" }],
    ["restore", "relay_1", { idempotencyKey: "restore_123" }],
  ]);
});

test("relay_send forwards an ordinary relay payload to the API client", async () => {
  let payload;
  const fakeClient = {
    async sendRelay(input) {
      payload = input;
      return { relayId: "relay_1", deliveredVia: "email" };
    },
  };

  await handleCall(fakeClient, "relay_send", {
    recipient: { email: "sven@example.com" },
    kind: "message",
    title: "Checking in today",
    forHuman: "How are you doing?",
    idempotencyKey: "idem_relay_send_1",
  });

  assert.deepEqual(payload.recipient, { email: "sven@example.com" });
  assert.equal(payload.kind, "message");
  assert.equal(payload.title, "Checking in today");
  assert.equal(payload.forHuman, "How are you doing?");
  assert.equal(payload.idempotencyKey, "idem_relay_send_1");
  assert.equal(payload.source.host, "relay-mcp");
  // Sends also stamp the sending agent's repo IDENTITY so the recipient's
  // companion can open the relay in their own copy of the same repo. It is
  // absent outside a git repo, so assert the shape only when it is present
  // (this suite runs from a checkout, but CI sandboxes may not).
  if (payload.source.repo) {
    const { repo } = payload.source;
    assert.equal(typeof repo.originKey, "string");
    assert.ok(repo.originKey.length > 0);
    // Never a local path, and never embedded credentials.
    assert.ok(!repo.originKey.startsWith("/"));
    assert.ok(!repo.originKey.includes("@"));
    assert.equal(JSON.stringify(repo).includes(process.env.HOME || "\0"), false);
  }
});

test("ordinary Relay MCP directs Claude and Codex to the membership-scoped Granular employee contact", () => {
  const send = TOOLS.find((tool) => tool.name === "relay_send");
  const search = TOOLS.find((tool) => tool.name === "relay_contacts_search");
  assert.match(send.description, /workspace-labelled contactId/);
  assert.match(send.description, /exact matching workspace-labelled contactId/);
  assert.match(send.description, /ordinary relay/i);
  assert.doesNotMatch(send.description, /coordination-workflow|relay_task_create/i);
  assert.match(search.description, /workspace name/);
  assert.match(search.description, /several workspaces/);
  assert.match(send.description, /recipient\.self=true/);
  assert.equal(send.inputSchema.properties.recipient.properties.self.type, "boolean");

  const titleDescription = send.inputSchema.properties.title.description;
  const humanDescription = send.inputSchema.properties.forHuman.description;
  // A title is only the compact gist of this Relay. Agents must never invent a
  // second visible name for a thread/topic.
  assert.match(titleDescription, /3-6 word gist/i);
  assert.match(titleDescription, /ask, outcome, update, or decision/i);
  assert.doesNotMatch(titleDescription, /threadTitle|conversation name/i);
  assert.doesNotMatch(titleDescription, /ONLY thing shown on the recipient's card/i);
  assert.doesNotMatch(titleDescription, /characters|8-20 words|4-12 words/i);
  assert.equal(send.inputSchema.properties.threadTitle, undefined);
  // The body is GHOSTWRITTEN in the sender's inferred voice (the voice
  // contract, David 2026-08-12): substance fidelity + inferred voice +
  // their relationship register, with real sent messages as the gold standard.
  assert.match(humanDescription, /ghostwritten in the sender's voice/i);
  assert.match(humanDescription, /recipient-specific vocabulary, rhythm, directness, formality, warmth, emphasis, and sign-off/i);
  assert.match(humanDescription, /relay_sent_list/);
  assert.match(humanDescription, /relay_chat_fetch/);
  assert.match(humanDescription, /know, answer, feel, discuss, or decide/i);
  assert.match(humanDescription, /USE THE FEWEST WORDS THAT FAITHFULLY PRESERVE IT/);
  assert.match(humanDescription, /1-3 normally sized sentences/i);
  assert.match(humanDescription, /45 words or fewer/i);
  assert.match(humanDescription, /60 words triggers mandatory review; it is NOT A TARGET OR BUDGET/);
  assert.match(humanDescription, /Never pad toward it or hide detail in long compound sentences/i);
  assert.match(humanDescription, /teaches voice and relationship register, not target length/i);
  assert.match(humanDescription, /Lots of detail never justifies a longer human message/i);
  assert.match(humanDescription, /mechanisms, evidence, code, paths, logs, reproduction steps/i);
  assert.match(humanDescription, /No headings, lists, tables, code blocks, title repetition/i);
  const longConfirmation = send.inputSchema.properties.longForHumanConfirmed;
  assert.equal(longConfirmation.type, "boolean");
  assert.match(longConfirmation.description, /already rejected this exact over-60-word draft/i);
  assert.match(longConfirmation.description, /Never set it preemptively/i);
  const agentDescription = send.inputSchema.properties.forAgent.description;
  assert.match(agentDescription, /complete document/i);
  assert.match(agentDescription, /under-sending here is worse than over-sending/i);
  assert.match(agentDescription, /do not repeat forHuman/i);
  assert.equal(send.inputSchema.required.includes("forAgent"), false);
  assert.doesNotMatch(send.description, /REQUEST RETURN CHANNEL/);
  assert.match(send.description, /attach their provider's final answer automatically/);
  assert.match(send.description, /do not call relay_send merely/i);
  assert.equal(send.inputSchema.properties.type, undefined, "legacy completion control stays out of the model schema");
});

test("ordinary accounts list only messaging tools and reject developer operations before any client call", async () => {
  const ordinaryFeatures = { requests: false, aiSessions: false, connectors: false };
  const listed = toolsForAccount(ordinaryFeatures);
  assert.deepEqual(
    new Set(listed.map((tool) => tool.name)),
    ORDINARY_RELAY_TOOL_NAMES,
  );
  assert.ok(listed.every((tool) => !/task|connector|approval|result|file/i.test(tool.name)));
  assert.deepEqual(toolsForAccount({ requests: true, aiSessions: true, connectors: true }), TOOLS);

  const calls = [];
  const client = new Proxy(
    {
      async sendRelay(payload) {
        calls.push(["sendRelay", payload]);
        return { relayId: "relay_messages_only_1", deliveredVia: "device" };
      },
    },
    {
      get(target, property) {
        if (property in target) return target[property];
        return (...args) => {
          calls.push([String(property), ...args]);
          throw new Error(`unexpected client call: ${String(property)}`);
        };
      },
    },
  );

  await handleCall(
    client,
    "relay_send",
    {
      recipient: { relayUserId: "usr_employee" },
      kind: "message",
      title: "Owner message update",
      forHuman: "Please handle this.",
      idempotencyKey: "messages_only_send_1",
    },
    { features: ordinaryFeatures },
  );
  await assert.rejects(
    handleCall(
      client,
      "relay_task_create",
      { title: "Forbidden", objective: "Forbidden", idempotencyKey: "forbidden_1" },
      { features: ordinaryFeatures },
    ),
    /available only to Relay developer accounts/i,
  );
  await assert.rejects(
    handleCall(client, "relay_inbox_delete", { itemId: "task_completed:task_1" }, { features: ordinaryFeatures }),
    /available only to Relay developer accounts/,
  );
  assert.deepEqual(calls.map(([name]) => name), ["sendRelay"]);
});

test("relay_send turns local files into inline ordinary relay attachments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-mcp-"));
  const filePath = path.join(dir, "guide.pdf");
  const body = Buffer.from("%PDF local guide");
  await fs.writeFile(filePath, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  let payload;
  const fakeClient = {
    async sendRelay(input) {
      payload = input;
      return { relayId: "relay_1", deliveredVia: "email" };
    },
  };

  await handleCall(fakeClient, "relay_send", {
    recipient: { email: "sven@example.com" },
    kind: "message",
    title: "Local guide attached",
    forHuman: "Here you go",
    files: [filePath],
    idempotencyKey: "idem_relay_file_1",
  });

  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].name, "guide.pdf");
  assert.equal(payload.attachments[0].contentType, "application/pdf");
  assert.equal(payload.attachments[0].bytes, body.length);
  assert.equal(payload.attachments[0].sha256, sha256);
  assert.equal(Buffer.from(payload.attachments[0].contentBase64, "base64").toString(), body.toString());
});

test("relay_send delivers a zero-byte local attachment directly to self", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-mcp-self-"));
  const filePath = path.join(dir, "TestDoc.txt");
  await fs.writeFile(filePath, Buffer.alloc(0));
  let payload;
  const fakeClient = {
    async sendRelay(input) {
      payload = input;
      return { relayId: "relay_self_1", deliveredVia: "device" };
    },
  };

  await handleCall(fakeClient, "relay_send", {
    recipient: { self: true },
    kind: "message",
    title: "Test document for myself",
    forHuman: "Saving this here.",
    files: [filePath],
    idempotencyKey: "idem_relay_self_file_1",
  });

  assert.deepEqual(payload.recipient, { self: true });
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].name, "TestDoc.txt");
  assert.equal(payload.attachments[0].contentType, "text/plain");
  assert.equal(payload.attachments[0].bytes, 0);
  assert.equal(payload.attachments[0].sha256, createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal(payload.attachments[0].contentBase64, "");
});

test("relay_send scopes generated ordinary attachment ids to the send idempotency key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-mcp-"));
  const filePath = path.join(dir, "guide.pdf");
  await fs.writeFile(filePath, Buffer.from("%PDF repeatable guide"));
  const payloads = [];
  const fakeClient = {
    async sendRelay(input) {
      payloads.push(input);
      return { relayId: `relay_${payloads.length}`, deliveredVia: "email" };
    },
  };

  for (const idempotencyKey of ["idem_relay_file_a", "idem_relay_file_b", "idem_relay_file_a"]) {
    await handleCall(fakeClient, "relay_send", {
      recipient: { email: "sven@example.com" },
      kind: "message",
      title: "Repeatable guide attached",
      forHuman: "Here you go",
      files: [filePath],
      idempotencyKey,
    });
  }

  assert.notEqual(payloads[0].attachments[0].id, payloads[1].attachments[0].id);
  assert.equal(payloads[0].attachments[0].id, payloads[2].attachments[0].id);
});

test("relay_send tells the agent to clean up an auto-created contact", async () => {
  const fakeClient = {
    async sendRelay() {
      return {
        relayId: "relay_1",
        deliveredVia: "email",
        contact: {
          contactId: "con_1",
          name: "sven@example.com",
          firstName: "sven@example.com",
          surname: "",
          email: "sven@example.com",
          emails: ["sven@example.com"],
          autoCreated: true,
          needsNameReview: true,
        },
      };
    },
  };

  const result = await handleCall(fakeClient, "relay_send", {
    recipient: { email: "sven@example.com" },
    kind: "message",
    title: "Checking in today",
    forHuman: "How are you doing?",
    idempotencyKey: "idem_relay_send_2",
  });

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.contact.contactId, "con_1");
  assert.equal(body.contact.autoCreated, true);
  assert.equal(body.nextRecommendedTool, "relay_contact_update");
  assert.match(body.agentInstruction, /auto-added sven@example\.com/);
  assert.match(body.agentInstruction, /firstName and surname/);
  assert.match(body.agentInstruction, /ask the human for clarification/i);
});

function sentItem(overrides = {}) {
  return {
    relayId: "relay_x",
    state: "delivered",
    createdAt: "2026-08-06T12:02:47.339Z",
    kind: "message",
    title: "Pill restyle — implemented",
    displayTitle: "Sven: Pill restyle — implemented",
    recipient: { name: "Dave Kariuki", email: "dave@example.com", onRelay: true },
    preview: "…",
    forHuman: "x".repeat(5000),
    threadId: "relay_x",
    hasAttachments: false,
    attachments: [],
    ...overrides,
  };
}

test("relay_sent_list gives an agent ids without choosing a reply target", async () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const tool = byName.get("relay_sent_list");
  assert.ok(tool, "relay_sent_list is registered");
  assert.ok(
    ORDINARY_RELAY_TOOL_NAMES.has("relay_sent_list"),
    "ordinary messaging must be able to thread its own follow-ups",
  );
  // The whole point of the tool: own sends are unreachable any other way.
  assert.match(tool.description, /never appear in relay_inbox_list/i);
  assert.match(tool.description, /replyToRelayId/);
  assert.match(tool.description, /never makes the first item an automatic reply target/i);

  const fakeClient = {
    async sent() {
      return {
        items: [
          sentItem({ relayId: "relay_3", createdAt: "2026-08-07T10:45:39.724Z", title: "Round 6" }),
          sentItem({ relayId: "relay_2", title: "Round 5" }),
          sentItem({
            relayId: "relay_1b",
            recipient: { name: "Shane Acton", email: "shane@example.com", onRelay: true },
            title: "Postmark DNS",
          }),
          sentItem({ relayId: "relay_1", threadId: "relay_0", threadTitle: "Legacy ignored name", inReplyToRelayId: "relay_0" }),
        ],
      };
    },
  };

  const all = JSON.parse((await handleCall(fakeClient, "relay_sent_list", {}, { mode: "full" })).content[0].text);
  assert.equal(all.items.length, 4);
  assert.equal(all.matched, 4);
  assert.equal(all.truncated, undefined, "a complete list is not flagged truncated");
  // Bodies are the reason a raw sent list overruns an agent's context.
  assert.equal(all.items[0].forHuman, undefined);
  assert.equal(all.items[0].preview, undefined);
  assert.equal(all.items[0].attachments, undefined);
  // Internal reply-chain fields survive compaction, but legacy visible names
  // are deliberately omitted from the model-facing response.
  assert.equal(all.items[3].relayId, "relay_1");
  assert.equal(all.items[3].threadId, "relay_0");
  assert.equal(all.items[3].threadTitle, undefined);
  assert.equal(all.items[3].inReplyToRelayId, "relay_0");
  assert.equal(all.items[0].recipient.email, "dave@example.com");
  assert.match(all.agentInstruction, /replyToRelayId/);

  // A recipient filter narrows to one correspondent, newest first, so the first
  // item is the relay a follow-up should reply to.
  const filtered = JSON.parse(
    (await handleCall(fakeClient, "relay_sent_list", { recipient: "DAVE@example.com" }, { mode: "full" })).content[0]
      .text,
  );
  assert.equal(filtered.matched, 3);
  assert.equal(filtered.items[0].relayId, "relay_3");
  assert.ok(filtered.items.every((item) => item.recipient.email === "dave@example.com"));
  assert.equal(filtered.recipientFilter, "DAVE@example.com");

  // Matching on name works too, since agents rarely have the address to hand.
  const byPerson = JSON.parse(
    (await handleCall(fakeClient, "relay_sent_list", { recipient: "shane" }, { mode: "full" })).content[0].text,
  );
  assert.equal(byPerson.matched, 1);
  assert.equal(byPerson.items[0].relayId, "relay_1b");

  // A truncated list says so rather than reading as the whole history.
  const capped = JSON.parse(
    (await handleCall(fakeClient, "relay_sent_list", { limit: 2 }, { mode: "full" })).content[0].text,
  );
  assert.equal(capped.items.length, 2);
  assert.equal(capped.matched, 4);
  assert.equal(capped.truncated, true);

  const empty = JSON.parse(
    (await handleCall(fakeClient, "relay_sent_list", { recipient: "nobody" }, { mode: "full" })).content[0].text,
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.agentInstruction, undefined);
});

test("relay_send separates room addressing from an explicit quoted reply", async () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const send = byName.get("relay_send");
  assert.match(send.description, /Addressing a person, group, or chat never implies a reply/i);
  assert.match(send.description, /replyToRelayId only when/i);
  assert.match(send.inputSchema.properties.replyToRelayId.description, /exact Relay/i);
  assert.match(send.inputSchema.properties.replyToRelayId.description, /Omit for an ordinary message/i);
  assert.equal(send.inputSchema.properties.threadTitle, undefined);
  assert.match(byName.get("relay_inbox_list").description, /relay_sent_list/);

  const hint = {
    reason: "unthreaded_follow_up",
    message: "Use relay_sent_list next time to link a related Relay.",
    candidate: {
      relayId: "relay_prev",
      threadId: "relay_prev",
      title: "Pill restyle round 5",
      createdAt: "2026-08-06T19:20:12.086Z",
      direction: "outbound",
    },
  };
  const fakeClient = {
    async sendRelay(payload) {
      assert.equal(payload.threadTitle, undefined);
      return { relayId: "relay_new", deliveredVia: "device", threadId: "relay_new", threadingHint: hint };
    },
  };
  const body = JSON.parse(
    (
      await handleCall(fakeClient, "relay_send", {
        recipient: { relayUserId: "usr_dave" },
        kind: "message",
        title: "Pill restyle final for now",
        forHuman: "…",
        threadTitle: "Legacy caller value must be dropped",
        idempotencyKey: "idem_relay_send_hint",
      })
    ).content[0].text,
  );
  assert.equal(body.threadingHint.candidate.relayId, "relay_prev");
  assert.match(body.agentInstruction, /relay_sent_list next time/);
  assert.equal(body.nextRecommendedTool, "relay_send", "threading is the correction to make next");
});

test("a send with no threading hint and a clean contact is passed through untouched", async () => {
  const fakeClient = {
    async sendRelay() {
      return { relayId: "relay_1", deliveredVia: "device", threadId: "relay_1" };
    },
  };
  const body = JSON.parse(
    (
      await handleCall(fakeClient, "relay_send", {
        recipient: { relayUserId: "usr_dave" },
        kind: "message",
        title: "Checking in today",
        forHuman: "…",
        idempotencyKey: "idem_relay_send_clean",
      })
    ).content[0].text,
  );
  assert.equal(body.agentInstruction, undefined);
  assert.equal(body.nextRecommendedTool, undefined);
  assert.equal(body.threadId, "relay_1");
});

test("relay_contact_update forwards first name and surname to the API client", async () => {
  let contactId;
  let payload;
  const fakeClient = {
    async updateContact(id, input) {
      contactId = id;
      payload = input;
      return { contactId: id, firstName: input.firstName, surname: input.surname };
    },
  };

  await handleCall(fakeClient, "relay_contact_update", {
    contactId: "con_1",
    firstName: "Sven",
    surname: "Wellmann",
    idempotencyKey: "idem_contact_update_1",
  });

  assert.equal(contactId, "con_1");
  assert.deepEqual(payload, {
    firstName: "Sven",
    surname: "Wellmann",
    name: undefined,
    email: undefined,
    emails: undefined,
    notes: undefined,
    idempotencyKey: "idem_contact_update_1",
  });
});

test("relay_connector_call_tool supports direct non-task connector use", () => {
  const tool = TOOLS.find((item) => item.name === "relay_connector_call_tool");
  assert.ok(tool, "relay_connector_call_tool is registered");
  assert.ok(tool.inputSchema.properties?.taskId, "taskId can be provided for task-scoped calls");
  assert.ok(tool.inputSchema.properties?.senderAgentSessionId, "senderAgentSessionId can be provided for task-scoped calls");
  assert.equal(tool.inputSchema.required?.includes("taskId"), false);
  assert.equal(tool.inputSchema.required?.includes("senderAgentSessionId"), false);
  assert.ok(tool.inputSchema.required?.includes("provider"));
  assert.ok(tool.inputSchema.required?.includes("toolName"));
});

test("relay_connector_call_tool forwards sender agent session id to the API client", async () => {
  let payload;
  const fakeClient = {
    async callTool(input) {
      payload = input;
      return { ok: true };
    },
  };

  await handleCall(fakeClient, "relay_connector_call_tool", {
    taskId: "task_1",
    senderAgentSessionId: "tsess_1",
    provider: "google_calendar",
    toolName: "GOOGLECALENDAR_LIST_EVENTS",
    arguments: { calendarId: "primary" },
    provenance: [{ source: "test" }],
    idempotencyKey: "idem_connector_call",
  }, { mode: "full" });

  assert.equal(payload.senderAgentSessionId, "tsess_1");
  assert.equal(payload.taskId, "task_1");
  assert.equal(payload.provider, "google_calendar");
});

test("relay_connector_call_tool can call read-only connector tools without a task session", async () => {
  let payload;
  const fakeClient = {
    async callTool(input) {
      payload = input;
      return { ok: true };
    },
  };

  await handleCall(fakeClient, "relay_connector_call_tool", {
    provider: "gmail",
    toolName: "GMAIL_FETCH_EMAILS",
    arguments: { query: "from:jordan" },
    idempotencyKey: "idem_direct_connector_call",
  }, { mode: "full" });

  assert.equal(payload.taskId, undefined);
  assert.equal(payload.senderAgentSessionId, undefined);
  assert.equal(payload.provider, "gmail");
});

// ---- 0.1.93: agents manage groups exactly like the human's UI does ---------

test("group management tools exist for ordinary accounts and document the semantics", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ["relay_group_create", "relay_group_update", "relay_group_delete"]) {
    assert.ok(byName.get(name), `${name} is registered`);
    assert.ok(ORDINARY_RELAY_TOOL_NAMES.has(name), `${name} is available to ordinary accounts`);
  }
  // The read tool no longer claims groups are website-only/read-only.
  assert.doesNotMatch(byName.get("relay_groups_list").description, /read-only/i);
  assert.match(byName.get("relay_groups_list").description, /relay_group_create \/ relay_group_update \/ relay_group_delete/);
  // Create: unique names -> list first; members are searched contactIds.
  assert.match(byName.get("relay_group_create").description, /relay_groups_list first/);
  assert.match(byName.get("relay_group_create").description, /relay_contacts_search/);
  // Update: partial application is explicit, removal is non-destructive.
  assert.match(byName.get("relay_group_update").description, /applied independently/);
  assert.match(byName.get("relay_group_update").description, /never deletes the contact/);
  // Delete: destructive, confirm-first.
  assert.match(byName.get("relay_group_delete").description, /confirm with the human first/);
  assert.match(byName.get("relay_group_delete").description, /every member remains/i);
});

test("relay_group_create makes the group then adds each member, reporting partial failures", async () => {
  const calls = [];
  const fakeClient = {
    async createGroup(body) { calls.push(["create", body]); return { id: "grp_1", name: body.name, members: [] }; },
    async addGroupMember(groupId, contactId) {
      calls.push(["add", groupId, contactId]);
      if (contactId === "con_bad") throw new Error("contact_not_found");
      return { id: groupId, name: "Founders", members: [{ contactId }] };
    },
  };
  const res = await handleCall(
    fakeClient,
    "relay_group_create",
    { name: "Founders", memberContactIds: ["con_a", "con_bad", "con_b"], idempotencyKey: "k1" },
    { mode: "messages-only" },
  );
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(calls, [
    ["create", { name: "Founders" }],
    ["add", "grp_1", "con_a"],
    ["add", "grp_1", "con_bad"],
    ["add", "grp_1", "con_b"],
  ]);
  assert.deepEqual(payload.added, ["con_a", "con_b"], "successful adds are reported");
  assert.equal(payload.failed.length, 1, "the failed member is surfaced, not swallowed");
  assert.equal(payload.failed[0].contactId, "con_bad");
  assert.equal(payload.group.id, "grp_1", "the created group is returned even with a partial failure");
});

test("relay_group_update renames and applies both member deltas, returning real state", async () => {
  const calls = [];
  const fakeClient = {
    async renameGroup(id, body) { calls.push(["rename", id, body]); return { id, name: body.name, members: [] }; },
    async addGroupMember(id, contactId) { calls.push(["add", id, contactId]); return { id, members: [{ contactId }] }; },
    async removeGroupMember(id, contactId) { calls.push(["remove", id, contactId]); return { id, members: [] }; },
    async groups() { calls.push(["list"]); return { groups: [{ id: "grp_1", name: "Founders", members: [] }] }; },
  };
  const res = await handleCall(
    fakeClient,
    "relay_group_update",
    { groupId: "grp_1", name: "Founders", addContactIds: ["con_a"], removeContactIds: ["con_z"], idempotencyKey: "k2" },
    { mode: "messages-only" },
  );
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(calls, [
    ["rename", "grp_1", { name: "Founders" }],
    ["add", "grp_1", "con_a"],
    ["remove", "grp_1", "con_z"],
  ]);
  assert.deepEqual(payload.added, ["con_a"]);
  assert.deepEqual(payload.removed, ["con_z"]);

  // A no-op update still returns the group's true state (fetched from the list).
  const res2 = await handleCall(fakeClient, "relay_group_update", { groupId: "grp_1", idempotencyKey: "k3" }, { mode: "messages-only" });
  assert.equal(JSON.parse(res2.content[0].text).group.name, "Founders");
});

test("relay_group_delete forwards the exact group id", async () => {
  const calls = [];
  const fakeClient = { async deleteGroup(id) { calls.push(["delete", id]); return { ok: true, groupId: id }; } };
  const res = await handleCall(fakeClient, "relay_group_delete", { groupId: "grp_9", idempotencyKey: "k4" }, { mode: "messages-only" });
  assert.deepEqual(calls, [["delete", "grp_9"]]);
  assert.equal(JSON.parse(res.content[0].text).groupId, "grp_9");
});

test("chat tools are registered for ordinary accounts and teach the ontology", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ["relay_chats_list", "relay_chat_fetch", "relay_chat_send"]) {
    assert.ok(byName.get(name), `${name} is registered`);
    assert.ok(ORDINARY_RELAY_TOOL_NAMES.has(name), `${name} is available to ordinary accounts`);
  }
  // A model that has only read these descriptions must come away knowing what a
  // chat IS, or it will keep treating threads as conversations.
  const list = byName.get("relay_chats_list").description;
  // Two kinds of room: a group is a stable container identified by its own id;
  // a direct chat is the one conversation between a pair.
  assert.match(list, /identified by the group's own id/i);
  assert.match(list, /two groups with the same people are two different chats/i);
  assert.match(list, /every Relay between the same pair appears in that one room/i);
  assert.match(list, /never separate the chat into topics/i);

  // Choosing between the two read tools has to be unambiguous.
  const fetch = byName.get("relay_chat_fetch").description;
  assert.match(fetch, /no user-visible threads or topics/i);
  assert.match(fetch, /Prefer this whenever/i);
  assert.match(byName.get("relay_thread_fetch").description, /Prefer relay_chat_fetch/);
  assert.match(byName.get("relay_inbox_list").description, /relay_chats_list and relay_chat_fetch/);

  const reply = byName.get("relay_chat_send").description;
  assert.match(reply, /chatId addresses the room/i);
  assert.match(reply, /does not imply a reply to the newest message/i);
  assert.match(reply, /replyToRelayId only when/i);
  assert.ok(byName.get("relay_chat_send").inputSchema.required.includes("idempotencyKey"));
  assert.equal(byName.get("relay_chat_send").inputSchema.properties.threadTitle, undefined);
});

test("the retired relay_chat_reply alias is unlisted but still sends", async () => {
  // It was byte-identical to relay_chat_send -- same schema, same handler -- so
  // every session carried two copies of one tool. Removing it from the catalog
  // is the point; still answering to it is what keeps a session that already
  // holds the old name working.
  assert.equal(TOOLS.find((tool) => tool.name === "relay_chat_reply"), undefined, "not advertised");
  assert.equal(ORDINARY_RELAY_TOOL_NAMES.has("relay_chat_reply"), false, "not in the ordinary catalog");

  for (const features of [
    { requests: false, aiSessions: false, connectors: false },
    { requests: true, aiSessions: true, connectors: true },
  ]) {
    const sends = [];
    const fakeClient = {
      async chat(id) { return { chatId: id, items: [] }; },
      async sendRelay(body) { sends.push(body); return { relayId: "relay_alias_1", state: "delivered" }; },
    };
    await handleCall(
      fakeClient,
      "relay_chat_reply",
      { chatId: "chat_a", forHuman: "Still routed.", idempotencyKey: "kalias1" },
      { features },
    );
    assert.equal(sends.length, 1, "an ordinary account is not refused for using the old name");
    assert.deepEqual(sends[0].recipient, { chatId: "chat_a" });
  }
});

test("relay_chat_fetch resolves a chat by id or by any thread in it, and refuses to guess", async () => {
  const calls = [];
  const fakeClient = {
    async chat(id) { calls.push(["chat", id]); return { chatId: id, replyToRelayId: "legacy_latest", items: [] }; },
    async chatForThread(id) { calls.push(["byThread", id]); return { chatId: "chat_x", items: [] }; },
  };
  const fetched = await handleCall(fakeClient, "relay_chat_fetch", { chatId: "chat_a" }, { mode: "messages-only" });
  assert.equal(JSON.parse(fetched.content[0].text).replyToRelayId, undefined,
    "the rolling-server compatibility hint is never exposed to current agents");
  await handleCall(fakeClient, "relay_chat_fetch", { threadId: "relay_root" }, { mode: "messages-only" });
  assert.deepEqual(calls, [["chat", "chat_a"], ["byThread", "relay_root"]]);

  // Naming nothing must fail loudly rather than act on some default conversation.
  await assert.rejects(
    () => handleCall(fakeClient, "relay_chat_fetch", {}, { mode: "messages-only" }),
    /pass chatId .*or threadId/i,
  );
});

test("relay_inbox_list returns a bounded recent metadata index without changing read state", async () => {
  const now = Date.now();
  const marks = [];
  const fetched = [];
  const fakeClient = {
    async inbox(options) {
      assert.deepEqual(options, { summary: true });
      return {
        items: [
          ...Array.from({ length: 55 }, (_, index) => ({
            relayId: `relay_recent_${index}`,
            title: `Recent ${index}`,
            sender: { name: "Shane", email: "shane@example.com" },
            state: "delivered",
            createdAt: new Date(now - index * 60_000).toISOString(),
            forHuman: "must not enter the metadata index",
            forAgent: "nor this",
            preview: "nor a preview",
            attachments: [{ name: "secret.txt" }],
          })),
          {
            relayId: "relay_too_old",
            title: "Eight days ago",
            sender: { name: "Old sender" },
            createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      };
    },
    async fetchRelayPackets(ids) { fetched.push(ids); return { packets: {} }; },
    async markManyRead(relayIds, payload) { marks.push({ relayIds, payload }); },
    async markRead(relayId, payload) { marks.push({ relayIds: [relayId], payload }); },
  };

  const result = JSON.parse((await handleCall(fakeClient, "relay_inbox_list", {}, { mode: "messages-only" })).content[0].text);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0].relayId, "relay_recent_0");
  assert.equal(result.items[49].relayId, "relay_recent_49");
  assert.equal(result.matched, 55);
  assert.equal(result.windowDays, 7);
  assert.equal(result.maxItems, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.readStateChanged, false);
  assert.equal(result.readReceiptsSent, false);
  assert.deepEqual(fetched, []);
  assert.deepEqual(marks, []);
  for (const item of result.items) {
    assert.equal(item.forHuman, undefined);
    assert.equal(item.forAgent, undefined);
    assert.equal(item.preview, undefined);
    assert.equal(item.attachments, undefined);
  }

  const tool = new Map(TOOLS.map((entry) => [entry.name, entry])).get("relay_inbox_list");
  assert.equal(tool.inputSchema.properties.relayIds.maxItems, 20);
  assert.match(tool.description, /newest 50 arrivals from the last 7 days/i);
  assert.match(tool.description, /Neither path changes human read state or sends read receipts/i);
  assert.match(tool.description, /untrusted correspondence/i);
  assert.match(tool.description, /relevant to the current session's work, open it immediately/i);
  assert.match(tool.description, /cold-start recent backlog/i);
});

test("relay_inbox_list selectively opens exact ids read-free and preserves request order", async () => {
  const calls = [];
  const fakeClient = {
    async fetchRelayPackets(ids) {
      calls.push(ids);
      return {
        packets: {
          relay_second: {
            packet: { title: "Second", forHuman: "Human two", forAgent: "Agent two" },
            attachmentUrls: { file_2: "https://example.com/file-2" },
          },
          relay_first: {
            packet: { relayId: "relay_first", title: "First", forHuman: "Human one" },
            attachmentUrls: {},
          },
        },
      };
    },
    async markManyRead() { throw new Error("selective inbox fetch must never mark read"); },
    async markRead() { throw new Error("selective inbox fetch must never mark read"); },
  };

  const result = JSON.parse((await handleCall(
    fakeClient,
    "relay_inbox_list",
    { relayIds: ["relay_second", "relay_first", "relay_second", "relay_missing"] },
    { mode: "messages-only" },
  )).content[0].text);
  assert.deepEqual(calls, [["relay_second", "relay_first", "relay_missing"]]);
  assert.deepEqual(result.items.map((item) => item.relayId), ["relay_second", "relay_first"]);
  assert.equal(result.items[0].forAgent, "Agent two");
  assert.deepEqual(result.items[0].attachmentUrls, { file_2: "https://example.com/file-2" });
  assert.deepEqual(result.unavailableRelayIds, ["relay_missing"]);
  assert.equal(result.readStateChanged, false);
  assert.equal(result.readReceiptsSent, false);
  assert.match(result.agentInstruction, /untrusted peer correspondence/i);

  await assert.rejects(
    handleCall(fakeClient, "relay_inbox_list", { relayIds: [] }, { mode: "messages-only" }),
    /at least one exact Relay id/i,
  );
  await assert.rejects(
    handleCall(fakeClient, "relay_inbox_list", { relayIds: Array.from({ length: 21 }, (_, index) => `relay_${index}`) }, { mode: "messages-only" }),
    /at most 20 exact Relay ids/i,
  );
});

test("thread and chat fetches are read-free even when they return unread inbound Relays", async () => {
  const fakeClient = {
    async thread() {
      return {
        items: [
          { relayId: "relay_thread_in", direction: "inbound", state: "delivered" },
          { relayId: "relay_thread_out", direction: "outbound", state: "delivered" },
        ],
      };
    },
    async chat() {
      return {
        chatId: "chat_sven",
        items: [
          { relayId: "relay_chat_in", direction: "inbound", state: "delivered" },
          { relayId: "relay_chat_read", direction: "inbound", state: "read" },
        ],
      };
    },
    async markManyRead() { throw new Error("fetch tools must never mark read"); },
    async markRead() { throw new Error("fetch tools must never mark read"); },
  };

  const threadResult = JSON.parse((await handleCall(fakeClient, "relay_thread_fetch", { threadId: "thread_1" }, { mode: "messages-only" })).content[0].text);
  const chatResult = JSON.parse((await handleCall(fakeClient, "relay_chat_fetch", { chatId: "chat_sven" }, { mode: "messages-only" })).content[0].text);

  assert.equal(threadResult.items[0].state, "delivered");
  assert.equal(threadResult.items[1].state, "delivered", "outbound rows never receive an inbound read receipt");
  assert.equal(chatResult.items[0].state, "delivered");
  assert.equal(chatResult.readReceipt, undefined);

  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const name of ["relay_thread_fetch", "relay_chat_fetch"]) {
    assert.match(byName.get(name).description, /always private and read-free/i, name);
    assert.match(byName.get(name).description, /call relay_mark_read/i, name);
  }
});

test("an agent fetch succeeds without any read-receipt service", async () => {
  const fakeClient = {
    async thread() {
      return { items: [{ relayId: "relay_unreceipted", direction: "inbound", state: "delivered" }] };
    },
    async markManyRead() { throw new Error("receipt service unavailable"); },
    async markRead() { throw new Error("receipt service unavailable"); },
  };
  const result = JSON.parse((await handleCall(
    fakeClient,
    "relay_thread_fetch",
    { threadId: "thread_1" },
    { mode: "messages-only" },
  )).content[0].text);
  assert.equal(result.items[0].state, "delivered");
});

test("relay_chat_send addresses the room and quotes only an explicitly selected message", async () => {
  const sends = [];
  const fakeClient = {
    async chat(id) { return { chatId: id, items: [] }; },
    async sendRelay(body) { sends.push(body); return { relayId: "relay_new", state: "delivered" }; },
  };
  await handleCall(
    fakeClient,
    "relay_chat_send",
    { chatId: "chat_a", forHuman: "Re-running the board tonight.\nWill report back.", idempotencyKey: "kchat1" },
    { mode: "messages-only" },
  );
  assert.equal(sends.length, 1);
  const sent = sends[0];
  assert.deepEqual(sent.recipient, { chatId: "chat_a" });
  assert.equal(sent.inReplyToRelayId, undefined, "ordinary room text does not quote anything");
  assert.equal(sent.title, undefined, "a typed text is sent untitled — titlelessness is the marker");
  assert.equal(sent.idempotencyKey, "kchat1");

  await handleCall(fakeClient, "relay_chat_send", {
    chatId: "chat_a", replyToRelayId: "relay_exact", forHuman: "Exactly this one.", idempotencyKey: "kchat2",
  }, { mode: "messages-only" });
  assert.equal(sends[1].inReplyToRelayId, "relay_exact");
});

test("relay_chat_send has relay_send attachment parity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-chat-send-"));
  const filePath = path.join(dir, "notes.txt");
  await fs.writeFile(filePath, "room attachment");
  let sent;
  const client = {
    async chat(id) { return { chatId: id, items: [] }; },
    async sendRelay(body) { sent = body; return { relayId: "relay_file" }; },
  };
  await handleCall(client, "relay_chat_send", {
    chatId: "chat_files", forHuman: "Here it is.", files: [filePath], idempotencyKey: "chat_file_1",
  }, { mode: "messages-only" });
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].name, "notes.txt");
  assert.equal(Buffer.from(sent.attachments[0].contentBase64, "base64").toString(), "room attachment");
});

test("sent-message edit and delete forward exact ids and optimistic versions", async () => {
  const calls = [];
  const client = {
    async editMessage(id, body) { calls.push(["edit", id, body]); return { ok: true, relayId: id }; },
    async deleteMessage(id, body) { calls.push(["delete", id, body]); return { ok: true, relayId: id }; },
  };
  await handleCall(client, "relay_message_edit", {
    relayId: "relay_1", forHuman: "Corrected.", expectedUpdatedAt: "2026-08-18T10:00:00.000Z", idempotencyKey: "edit_0001",
  }, { mode: "messages-only" });
  await handleCall(client, "relay_message_delete", {
    relayId: "relay_1", expectedUpdatedAt: "2026-08-18T10:01:00.000Z", idempotencyKey: "delete_01",
  }, { mode: "messages-only" });
  assert.deepEqual(calls, [
    ["edit", "relay_1", { forHuman: "Corrected.", expectedUpdatedAt: "2026-08-18T10:00:00.000Z", idempotencyKey: "edit_0001" }],
    ["delete", "relay_1", { expectedUpdatedAt: "2026-08-18T10:01:00.000Z", idempotencyKey: "delete_01" }],
  ]);
});

test("relay_message_edit keeps the MCP-only human-writing review", async () => {
  let edits = 0;
  const client = { async editMessage() { edits += 1; return { ok: true, relayId: "relay_1" }; } };
  const args = {
    relayId: "relay_1", forHuman: Array.from({ length: 61 }, (_, i) => `word${i}`).join(" "),
    idempotencyKey: "edit_review_1", longForHumanConfirmed: true,
  };
  await assert.rejects(handleCall(client, "relay_message_edit", args, { mode: "messages-only" }), /mandatory-review threshold/);
  assert.equal(edits, 0);
  await handleCall(client, "relay_message_edit", args, { mode: "messages-only" });
  assert.equal(edits, 1);
});

test("relay_chat_reply reviews an overlong human message before reading or sending", async () => {
  const calls = [];
  const fakeClient = {
    async chat(id) {
      calls.push(["chat", id]);
      return { chatId: id, items: [] };
    },
    async sendRelay(body) {
      calls.push(["send", body]);
      return { relayId: "relay_reviewed_reply", state: "delivered" };
    },
  };
  const args = {
    chatId: "chat_a",
    forHuman: Array.from({ length: 61 }, (_, index) => `reply${index + 1}`).join(" "),
    longForHumanConfirmed: true,
    idempotencyKey: "long_chat_review_1",
  };

  await assert.rejects(
    handleCall(fakeClient, "relay_chat_reply", args, { mode: "messages-only" }),
    /mandatory-review threshold is 60 words[\s\S]*not a target or budget[\s\S]*Nothing was sent/i,
  );
  assert.deepEqual(calls, [], "review happens before the content-bearing chat fetch or delivery");

  await handleCall(fakeClient, "relay_chat_reply", args, { mode: "messages-only" });
  assert.deepEqual(calls.map(([name]) => name), ["chat", "send"]);
  assert.equal(calls[1][1].longForHumanConfirmed, true, "the reviewed attempt reaches the API soft-review gate");
});

test("relay_send teaches the relay-vs-REQUEST decision — David's discernment law", () => {
  const send = TOOLS.find((tool) => tool.name === "relay_send");
  assert.ok(send, "relay_send exists");
  const kind = send.inputSchema.properties.kind;
  assert.deepEqual(kind.enum, ["message", "task"]);
  assert.ok(send.inputSchema.required.includes("kind"), "the model must make the classification explicitly");
  assert.match(send.description, /classify the outcome, not the sentence's addressee/i);
  assert.equal(send.inputSchema.properties.type, undefined, "legacy completion controls are not model-facing");
  assert.match(kind.description, /old 'handoff' kind no longer exists/i);
  assert.match(kind.description, /including a forAgent document never turns a message into one|forAgent can contain dense implementation context without making it a Request/i);
  assert.match(kind.description, /Start control/i);
  assert.match(kind.description, /requested outcome/i);
  assert.match(kind.description, /Imperative wording addressed as 'you' is still a Request/i);
  assert.match(kind.description, /Switch your Relay install to dev and confirm the version\/channel/i);
  assert.match(kind.description, /MUST be kind='task', not kind='message'/i);
  assert.match(kind.description, /small or quick operation is still a Request/i);
  assert.match(kind.description, /Do you think we should switch to dev\?' is kind='message'/i);
  assert.match(kind.description, /exactly one recipient and no group/i);
  assert.match(kind.description, /PERSON'S opinion, memory, judgment.*decision/i);
  assert.doesNotMatch(kind.description, /relay_task_create/i);
  // And it is available in the default messages-only profile: a task is an
  // ordinary relay, sent by the same tool as every message.
  assert.ok(ORDINARY_RELAY_TOOL_NAMES.has("relay_send"));
});

test("relay_send refuses to guess the recipient experience", async () => {
  const client = { async sendRelay() { throw new Error("must not send"); } };
  const base = {
    recipient: { relayUserId: "usr_sven" },
    title: "Review the launch",
    forHuman: "Can you take a look?",
    idempotencyKey: "explicit-kind-1",
  };
  await assert.rejects(() => handleCall(client, "relay_send", base), /kind is required/i);
  await assert.rejects(
    () => handleCall(client, "relay_send", { ...base, recipient: {}, kind: "message" }),
    /recipient must set self=true or include contactId, relayUserId, email, groupId, or chatId/i,
  );
  await assert.rejects(
    () => handleCall(client, "relay_send", { ...base, kind: "task", recipient: { groupId: "grp_founders" } }),
    /exactly one recipient/i,
  );
});

test("relay_send rejects report headlines before delivery", async () => {
  let calls = 0;
  const client = {
    async sendRelay() {
      calls += 1;
      return { relay: { id: "relay_should_not_send" } };
    },
  };
  await assert.rejects(
    handleCall(client, "relay_send", {
      recipient: { email: "shane@example.com" },
      kind: "message",
      title: "Security review of the companion reveals three defaults that fail every external review",
      forHuman: "The review found three defaults we should fix before the next release.",
      forAgent: "Complete technical findings.",
      idempotencyKey: "security_review_retry_1",
    }),
    /title must be a 3-6 word gist; received 13 words[\s\S]*findings into forAgent[\s\S]*same idempotencyKey/i,
  );
  assert.equal(calls, 0, "an invalid draft never reaches the API");
});

test("relay_send requires an exact second review for human messages over 60 words", async () => {
  assert.equal(FOR_HUMAN_SOFT_WORD_LIMIT, 60);
  assert.equal(FOR_HUMAN_TYPICAL_WORD_LIMIT, 45);
  assert.equal(FOR_HUMAN_DEFAULT_SENTENCE_LIMIT, 3);
  assert.equal(FOR_HUMAN_EXCEPTIONAL_SENTENCE_LIMIT, 4);
  const calls = [];
  const client = {
    async sendRelay(payload) {
      calls.push(payload);
      return { relayId: "relay_long_reviewed", state: "delivered" };
    },
  };
  const forHuman = Array.from({ length: 61 }, (_, index) => `word${index + 1}`).join(" ");
  const args = {
    recipient: { relayUserId: "usr_sven" },
    kind: "message",
    title: "Read receipt design",
    forHuman,
    forAgent: "The complete technical document.",
    // A model must not be able to preempt the review by setting this on its
    // first call. The same exact draft may pass only after Relay rejects it.
    longForHumanConfirmed: true,
    idempotencyKey: "long_human_review_1",
  };

  await assert.rejects(
    handleCall(client, "relay_send", args),
    /forHuman is 61 words[\s\S]*not a target or budget[\s\S]*Nothing was sent[\s\S]*Review this exact draft again[\s\S]*longForHumanConfirmed: true/i,
  );
  assert.equal(calls.length, 0, "the first over-limit attempt has no delivery side effects");

  const changedDraft = { ...args, forHuman: `${forHuman} changed` };
  await assert.rejects(
    handleCall(client, "relay_send", changedDraft),
    /forHuman is 62 words[\s\S]*Review this exact draft again/i,
  );
  assert.equal(calls.length, 0, "editing the rejected draft requires a fresh review");

  await handleCall(client, "relay_send", changedDraft);
  assert.equal(calls.length, 1, "the exact reviewed draft can be deliberately confirmed");
  assert.equal(calls[0].forHuman, changedDraft.forHuman);
  assert.equal(calls[0].longForHumanConfirmed, true, "the API can require its own exact-draft review token");
});

test("relay_send accepts the 60-word review boundary without making it a target", async () => {
  const calls = [];
  const client = {
    async sendRelay(payload) {
      calls.push(payload);
      return { relayId: "relay_at_review_boundary", state: "delivered" };
    },
  };
  const forHuman = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(" ");
  await handleCall(client, "relay_send", {
    recipient: { relayUserId: "usr_sven" },
    kind: "message",
    title: "Review boundary proof",
    forHuman,
    idempotencyKey: "human_review_boundary_1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].forHuman, forHuman);
});

test("obsolete coordination protocol is absent and rejected before any API call", async () => {
  const removed = [
    "relay_acknowledge",
    "relay_task_create",
    "relay_task_status",
    "relay_to_agent",
    "relay_to_human",
    "relay_answer_human_question",
    "relay_file_prepare_upload",
    "relay_end_task",
    "share_results_with_human",
  ];
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of removed) assert.equal(names.has(name), false, `${name} is not advertised`);
  // The catalog also exposes explicit room send plus sent-message edit/delete.
  // state an agent sets on its own, so a human-initiated pull clears unread
  // and sends the read receipt — without it the sender sees "delivered"
  // forever). relay_acknowledge stays retired.
  assert.equal(TOOLS.length, 26, "the full model catalog contains only current product tools");

  const client = new Proxy({}, {
    get() { throw new Error("removed tool must not touch the API client"); },
  });
  for (const name of removed) {
    const result = await handleCall(client, name, {}, { mode: "full" });
    assert.match(JSON.parse(result.content[0].text).error, /Unknown tool/i);
  }
});

test("MCP read and reply tools preserve one chat while hiding the legacy reply-chain ontology", () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.get("relay_inbox_list").description, /ordinary Relays and direct Requests/i);
  assert.match(byName.get("relay_sent_list").description, /ordinary Relays and direct Requests/i);
  assert.match(byName.get("relay_thread_fetch").description, /legacy tool and field names say 'thread' only for API compatibility/i);
  assert.match(byName.get("relay_thread_fetch").description, /not a product object, visible thread\/topic, title, chat, or UI destination/i);
  assert.match(byName.get("relay_chat_send").description, /always sends kind='message'/i);
  assert.match(byName.get("relay_chat_send").description, /use relay_send for a Request/i);
});

test("the send path is annotated anthropic/alwaysLoad so no serving mode defers it", () => {
  // Claude Desktop drops the config-level alwaysLoad key when it re-serializes
  // server configs; the _meta annotation on the live tools/list response is the
  // only signal that survives every registration path.
  const alwaysOn = new Set([
    "relay_send",
    "relay_share_link",
    "relay_contacts_search",
    "relay_groups_list",
    "relay_inbox_list",
    "relay_sent_list",
  ]);
  for (const developer of [true, false]) {
    const tools = toolsForAccount({ requests: developer, aiSessions: developer, connectors: developer });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of alwaysOn) {
      assert.equal(
        byName.get(name)?._meta?.["anthropic/alwaysLoad"],
        true,
        `${name} must stay directly callable when developer=${developer}`,
      );
    }
    for (const tool of tools) {
      if (alwaysOn.has(tool.name)) continue;
      assert.equal(tool._meta?.["anthropic/alwaysLoad"], undefined, `${tool.name} may defer behind ToolSearch`);
    }
  }
});

// ---------- relay_share_link ----------
//
// A link is the send path when there is no address. Relay delivers nothing on
// it, so every assertion below exists to stop the one failure that would make
// the feature worse than useless: an agent reporting a mint as a delivery.

function shareParse(result) {
  return JSON.parse(result.content[0].text);
}

test("a mint carries only what the human supplied, and never an address", async () => {
  let payload;
  const fakeClient = {
    async mintShareLink(input) {
      payload = input;
      return { url: "https://sendrelays.com/s/tok", relayId: "relay_share_1", state: "unopened" };
    },
  };

  await handleCall(fakeClient, "relay_share_link", {
    title: "Saturday session plan",
    forHuman: "Here's the plan for Saturday.",
    idempotencyKey: "idem_share_mint_1",
  });
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["attachments", "forAgent", "forHuman", "idempotencyKey", "source", "title"],
    "an unnamed recipient sends no recipientName key at all",
  );
  assert.equal(payload.title, "Saturday session plan");
  assert.equal(payload.forHuman, "Here's the plan for Saturday.");
  assert.equal(payload.forAgent, "");
  assert.deepEqual(payload.attachments, []);
  assert.equal(payload.idempotencyKey, "idem_share_mint_1");
  assert.equal(payload.source.host, "relay-mcp");

  await handleCall(fakeClient, "relay_share_link", {
    recipientName: "Priya from the gym",
    forHuman: "Here's the plan for Saturday.",
    idempotencyKey: "idem_share_mint_2",
  });
  assert.equal(payload.recipientName, "Priya from the gym");
  // An untitled mint is a typed text, exactly as an untitled ordinary send is.
  assert.equal(Object.hasOwn(payload, "title"), false);
});

test("a mint tells the agent nothing was delivered, and hands it back to the human", async () => {
  const fakeClient = {
    async mintShareLink() {
      return { url: "https://sendrelays.com/s/tok", relayId: "relay_share_1", state: "unopened" };
    },
  };
  const minted = shareParse(await handleCall(fakeClient, "relay_share_link", {
    forHuman: "Here's the plan for Saturday.",
    idempotencyKey: "idem_share_mint_3",
  }));
  assert.match(minted.agentInstruction, /^Nothing has been delivered\./);
  // The next actor is the human, not a tool: relaySendResultForAgent sets one
  // and this must not, or the model chains straight past the paste.
  assert.equal(Object.hasOwn(minted, "nextRecommendedTool"), false);
});

test("a duplicate live link is offered instead of the new one", async () => {
  const fakeClient = {
    async mintShareLink() {
      return {
        url: "https://sendrelays.com/s/new",
        relayId: "relay_share_2",
        state: "unopened",
        duplicateHint: { relayId: "relay_share_1", url: "https://sendrelays.com/s/old", createdAt: "2026-08-19T09:00:00.000Z" },
      };
    },
  };
  const minted = shareParse(await handleCall(fakeClient, "relay_share_link", {
    forHuman: "Here's the plan for Saturday.",
    idempotencyKey: "idem_share_mint_4",
  }));
  assert.match(minted.agentInstruction, /A live unclaimed link/);
});

test("revoke stops one url and says so without claiming the message was withdrawn", async () => {
  let received;
  const fakeClient = {
    async revokeShareLink(relayId) {
      received = relayId;
      return { ok: true, revokedAt: "2026-08-19T09:00:00.000Z" };
    },
  };
  const revoked = shareParse(await handleCall(fakeClient, "relay_share_link", {
    action: "revoke",
    relayId: "relay_share_1",
    idempotencyKey: "idem_share_revoke_1",
  }));
  assert.equal(received, "relay_share_1");
  assert.match(revoked.agentInstruction, /That url no longer resolves\./);
  assert.match(revoked.agentInstruction, /do not tell this human it was unsent or withdrawn/);

  await assert.rejects(
    handleCall(fakeClient, "relay_share_link", { action: "revoke", idempotencyKey: "idem_share_revoke_2" }),
    /needs the relayId of the message whose link should stop resolving/,
  );
});

test("a Request is refused rather than quietly minted as a message", async () => {
  let called = false;
  const fakeClient = { async mintShareLink() { called = true; return {}; } };
  await assert.rejects(
    handleCall(fakeClient, "relay_share_link", {
      kind: "task",
      forHuman: "Switch your Relay install to dev.",
      idempotencyKey: "idem_share_task_1",
    }),
    /will not quietly turn a Request into a message/,
  );
  assert.equal(called, false, "nothing reaches the API on a refused kind");
});

test("a supplied share title obeys the 3-6 word gate and an omitted one does not", async () => {
  let payload = null;
  const fakeClient = {
    async mintShareLink(input) {
      payload = input;
      return { url: "https://sendrelays.com/s/tok", relayId: "relay_share_1", state: "unopened" };
    },
  };
  await assert.rejects(
    handleCall(fakeClient, "relay_share_link", {
      title: "Plan",
      forHuman: "Here's the plan for Saturday.",
      idempotencyKey: "idem_share_title_1",
    }),
    /title must be a 3-6 word gist; received 1 words\./,
  );
  assert.equal(payload, null);

  await handleCall(fakeClient, "relay_share_link", {
    forHuman: "Here's the plan for Saturday.",
    idempotencyKey: "idem_share_title_2",
  });
  assert.equal(Object.hasOwn(payload, "title"), false);
});

test("a mint runs the 60-word review before it reads a single file", async () => {
  const draft = Array.from({ length: 70 }, (_, index) => `word${index}`).join(" ");
  let minted = 0;
  const fakeClient = {
    async mintShareLink() {
      minted += 1;
      return { url: "https://sendrelays.com/s/tok", relayId: "relay_share_1", state: "unopened" };
    },
  };
  await assert.rejects(
    handleCall(fakeClient, "relay_share_link", {
      files: ["/nonexistent/relay-share-test-file"],
      forHuman: draft,
      idempotencyKey: "idem_share_review_1",
    }),
    /mandatory-review threshold/,
    "the refusal arrives before prepareOrdinaryRelayAttachments touches the disk",
  );
  assert.equal(minted, 0);

  await handleCall(fakeClient, "relay_share_link", {
    forHuman: draft,
    longForHumanConfirmed: true,
    idempotencyKey: "idem_share_review_1",
  });
  assert.equal(minted, 1);

  // The review key is `${toolName}:${idempotencyKey}`, so a confirmation earned
  // by a relay_send draft can never satisfy a mint of the same key.
  await assert.rejects(
    handleCall({ async sendRelay() { return { relayId: "relay_1" }; } }, "relay_send", {
      recipient: { email: "sven@example.com" },
      kind: "message",
      title: "Checking in today",
      forHuman: draft,
      idempotencyKey: "idem_share_review_2",
    }),
    /mandatory-review threshold/,
  );
  await assert.rejects(
    handleCall(fakeClient, "relay_share_link", {
      forHuman: draft,
      longForHumanConfirmed: true,
      idempotencyKey: "idem_share_review_2",
    }),
    /mandatory-review threshold/,
  );
  assert.equal(minted, 1);
});

test("attachments over the inline budget are refused with the remedy, before the network", async () => {
  const nineteenMb = 19 * 1024 * 1024;
  const file = path.join(os.tmpdir(), `relay-share-budget-${process.pid}.bin`);
  await fs.writeFile(file, Buffer.alloc(nineteenMb));
  let called = false;
  try {
    await assert.rejects(
      handleCall({ async mintShareLink() { called = true; return {}; } }, "relay_share_link", {
        files: [file],
        forHuman: "The recording is attached.",
        idempotencyKey: "idem_share_budget_1",
      }),
      /Attachments total 19\.0 MB\. A share link carries its files inline/,
    );
  } finally {
    await fs.rm(file, { force: true });
  }
  assert.equal(called, false);
});

test("a managed account is told the one path it has, on both actions", async () => {
  const forbidden = () => {
    const error = new Error("managed_account_route_forbidden");
    error.status = 403;
    error.body = { error: "managed_account_route_forbidden" };
    throw error;
  };
  const fakeClient = { async mintShareLink() { forbidden(); }, async revokeShareLink() { forbidden(); } };
  for (const args of [
    { forHuman: "Here's the plan.", idempotencyKey: "idem_share_managed_1" },
    { action: "revoke", relayId: "relay_share_1", idempotencyKey: "idem_share_managed_2" },
  ]) {
    await assert.rejects(
      handleCall(fakeClient, "relay_share_link", args),
      /A managed Granular account has no human to paste a url/,
    );
  }
});

test("an empty contact search is where the link is offered, and where a live one is reused", async () => {
  const searched = { matches: [], groups: [] };
  const noLinks = shareParse(await handleCall({
    async searchContacts() { return searched; },
    async sent() { return { items: [] }; },
  }, "relay_contacts_search", { query: "Priya" }));
  assert.match(noLinks.agentInstruction, /mint a link with relay_share_link/);
  assert.match(noLinks.agentInstruction, /load it by that exact name first/);
  assert.equal(Object.hasOwn(noLinks, "existingShareLink"), false);

  const reuse = shareParse(await handleCall({
    async searchContacts() { return searched; },
    async sent() {
      return {
        items: [{
          relayId: "relay_share_1",
          recipient: { name: "Priya from the gym" },
          shareLink: { id: "shl_1", url: "https://sendrelays.com/s/old", state: "unopened" },
        }],
      };
    },
  }, "relay_contacts_search", { query: "priya" }));
  assert.match(reuse.agentInstruction, /You already minted a link for that name/);
  assert.match(reuse.agentInstruction, /https:\/\/sendrelays\.com\/s\/old$/);
  assert.deepEqual(reuse.existingShareLink, {
    url: "https://sendrelays.com/s/old",
    relayId: "relay_share_1",
    state: "unopened",
  });

  // A sent-list lookup can never break a search: it runs only on the failure
  // path and its errors are swallowed.
  const thrown = shareParse(await handleCall({
    async searchContacts() { return searched; },
    async sent() { throw new Error("network down"); },
  }, "relay_contacts_search", { query: "Priya" }));
  assert.match(thrown.agentInstruction, /mint a link with relay_share_link/);

  // A hit is a bare passthrough: no instruction, no extra round trip.
  const found = shareParse(await handleCall({
    async searchContacts() { return { matches: [{ id: "ctc_1", name: "Priya" }], groups: [] }; },
    async sent() { throw new Error("sent must not be called on a hit"); },
  }, "relay_contacts_search", { query: "Priya" }));
  assert.equal(Object.hasOwn(found, "agentInstruction"), false);
});

// One link is one person, and a claim is irreversible: whoever opens the url is
// bound to the message permanently. The reuse guard is the one place that hands
// an existing url to a name it was not minted for, so it matches whole words
// only and refuses anything it cannot resolve to exactly one link.
test("a link minted for one name is never offered to a different one", async () => {
  const searched = { matches: [], groups: [] };
  const linkFor = (name, id) => ({
    relayId: `relay_${id}`,
    recipient: { name },
    shareLink: { id, url: `https://sendrelays.com/s/${id}`, state: "unopened" },
  });
  const searchFor = async (query, items) =>
    shareParse(await handleCall({
      async searchContacts() { return searched; },
      async sent() { return { items }; },
    }, "relay_contacts_search", { query }));

  // A substring is not a person: "Dan" is not Danielle and "Sam" is not Samantha.
  for (const [query, stored] of [["Dan", "Danielle"], ["Sam", "Samantha"], ["ann", "Joanne"]]) {
    const miss = await searchFor(query, [linkFor(stored, "shl_other")]);
    assert.equal(Object.hasOwn(miss, "existingShareLink"), false, `${query} must not reuse ${stored}'s link`);
    assert.match(miss.agentInstruction, /mint a link with relay_share_link/);
  }

  // An unaddressed link was minted for nobody, so it can never be the link for
  // a name — and its four ordinary words would otherwise answer "the" or "link".
  for (const query of ["someone", "link", "the"]) {
    const anon = await searchFor(query, [linkFor("Someone with the link", "shl_anon")]);
    assert.equal(Object.hasOwn(anon, "existingShareLink"), false, `${query} must not reuse an unaddressed link`);
  }

  // Two unopened links for the same name: guessing binds the message to whoever
  // opens first, so an ambiguous reuse mints a new one instead.
  const both = await searchFor("Priya", [linkFor("Priya Nair", "shl_a"), linkFor("Priya Nair", "shl_b")]);
  assert.equal(Object.hasOwn(both, "existingShareLink"), false);

  // The case the guard exists for still works, whole words and all.
  const reused = await searchFor("Priya", [linkFor("Priya from the gym", "shl_hit")]);
  assert.equal(reused.existingShareLink.url, "https://sendrelays.com/s/shl_hit");
});

// A direct chat id is derived from the people in the room, so a claim that
// swaps the guest for a real account changes the id an agent is holding. The
// room is alive: an error naming no id leaves the model with nowhere to go, and
// details.instruction alone tells it to use an id it was never shown.
test("a chat that moved when its link was claimed answers with the id it moved to", async () => {
  const moved = () => {
    const error = new Error("That conversation moved when the recipient claimed the link.");
    error.status = 410;
    error.body = {
      error: "chat_moved",
      chatId: "chat_after",
      message: error.message,
      details: { instruction: "Fetch it again with the chatId in this response." },
    };
    throw error;
  };
  const result = shareParse(await handleCall({ async chat() { moved(); } }, "relay_chat_fetch", { chatId: "chat_before" }));
  assert.equal(result.chatId, "chat_after");
  assert.match(result.agentInstruction, /Fetch it again with the chatId in this response\./);

  // Every other failure is still a failure.
  await assert.rejects(
    handleCall({ async chat() { const e = new Error("not_found"); e.status = 404; e.body = { error: "not_found" }; throw e; } },
      "relay_chat_fetch", { chatId: "chat_gone" }),
    /not_found/,
  );
});

test("relay_sent_list states a link's own state and never makes a guest mailbox searchable", async () => {
  const items = [
    {
      relayId: "relay_share_1",
      title: "Saturday session plan",
      recipient: { name: "Priya from the gym", email: "shl_abc@guests.sendrelays.com" },
      createdAt: "2026-08-19T09:00:00.000Z",
      state: "pending",
      shareLink: { id: "shl_abc", url: "https://sendrelays.com/s/tok", state: "unopened" },
    },
    {
      relayId: "relay_ordinary_1",
      title: "Postmark DKIM go/no-go",
      recipient: { name: "Sven Wellmann", email: "sven@wellmann.example" },
      createdAt: "2026-08-19T08:00:00.000Z",
      state: "delivered",
    },
  ];
  const fakeClient = { async sent() { return { items }; } };

  const all = shareParse(await handleCall(fakeClient, "relay_sent_list", {}));
  assert.deepEqual(all.items[0].share, { state: "unopened", url: "https://sendrelays.com/s/tok", opened: false });
  assert.equal(Object.hasOwn(all.items[1], "share"), false);
  assert.match(all.agentInstruction, /Items carrying a `share` block were handed over as links, not delivered\./);

  const ordinaryOnly = shareParse(await handleCall(fakeClient, "relay_sent_list", { recipient: "Sven" }));
  assert.equal(ordinaryOnly.matched, 1);
  assert.doesNotMatch(ordinaryOnly.agentInstruction, /handed over as links/);

  // The guest domain is an internal key. Searching it must match nothing, or a
  // single filter returns every share relay in the account at once.
  assert.equal(shareParse(await handleCall(fakeClient, "relay_sent_list", { recipient: "guests" })).matched, 0);
  assert.equal(shareParse(await handleCall(fakeClient, "relay_sent_list", { recipient: "priya" })).matched, 1);
  // An ordinary relay's address is still searchable, domain included.
  assert.equal(shareParse(await handleCall(fakeClient, "relay_sent_list", { recipient: "wellmann.example" })).matched, 1);
});

test("a service's remedy reaches the model whether it rode top-level or inside details", () => {
  const nested = new Error("No contact matches \"Priya\".");
  nested.body = { error: "recipient_unknown", message: nested.message, details: { instruction: "Mint a link instead." } };
  assert.equal(
    relayCallErrorResult(nested).content[0].text,
    "Relay error: No contact matches \"Priya\".\nMint a link instead.",
  );

  const top = new Error("Nothing was minted.");
  top.body = { error: "share_links_disabled", instruction: "Retry in a few minutes." };
  assert.equal(relayCallErrorResult(top).content[0].text, "Relay error: Nothing was minted.\nRetry in a few minutes.");

  // A zod 400 still wins: field-level issues are more actionable than prose.
  const invalid = new Error("HTTP 400");
  invalid.body = { error: "invalid_request", issues: [{ path: ["forHuman"], message: "Required" }], details: { instruction: "unused" } };
  assert.equal(relayCallErrorResult(invalid).content[0].text, "Relay error: HTTP 400\n- forHuman: Required");

  // The shape the API actually sends for the commonest refusal in the funnel:
  // the remedy is already the tail of `message`, and carrying it in details too
  // printed the same sentence twice in one tool result.
  const remedy =
    "Do not ask this human for an email address and do not switch to another medium."
    + " Mint a link with relay_share_link and hand them the url to paste themselves.";
  const production = new Error(`No contact matches "Priya". ${remedy}`);
  production.body = { error: "recipient_unknown", message: production.message, details: { candidates: [] } };
  const printed = relayCallErrorResult(production).content[0].text;
  assert.equal(printed, `Relay error: No contact matches "Priya". ${remedy}`);
  assert.equal(printed.split(remedy).length - 1, 1, "the remedy reaches the model once");
});

test("a rate-limited or disabled mint carries its own remedy into the model's text", async () => {
  for (const [code, expected] of [
    ["rate_limited", /This account has minted its hourly limit of links\./],
    ["share_links_disabled", /Relay's link service is briefly unavailable, not missing\./],
  ]) {
    const failing = {
      async mintShareLink() {
        const error = new Error("Nothing was minted.");
        error.status = code === "rate_limited" ? 429 : 503;
        error.body = { error: code, message: "Nothing was minted." };
        throw error;
      },
    };
    const err = await handleCall(failing, "relay_share_link", {
      forHuman: "Here's the plan.",
      idempotencyKey: `idem_share_${code}`,
    }).then(() => null, (error) => error);
    assert.ok(err, `${code} still fails the call`);
    assert.match(relayCallErrorResult(err).content[0].text, expected);
  }
});

test("a claimed relay reaches the inbox as ordinary correspondence, with no trace of the link", async () => {
  // relay_inbox_list needs no share edit and the reason is worth pinning: before
  // a claim the recipient has no account and no inbox, and after one the relay's
  // recipientUserId is the claimer, so it arrives through the existing path with
  // the sender's real name.
  const claimed = shareParse(await handleCall({
    async inbox() {
      return {
        items: [{
          relayId: "relay_share_1",
          title: "Saturday session plan",
          sender: { name: "Priya Nair", email: "priya@example.com" },
          createdAt: "2026-08-19T09:00:00.000Z",
          arrivedAt: "2026-08-19T11:00:00.000Z",
          state: "delivered",
        }],
      };
    },
  }, "relay_inbox_list", {}));
  const serialized = JSON.stringify(claimed);
  assert.doesNotMatch(serialized, /Someone with the link/);
  assert.doesNotMatch(serialized, /@guests\.sendrelays\.com/);
  assert.equal(claimed.items[0].sender.name, "Priya Nair");
});
