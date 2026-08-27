import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { RELAY_MCP_INSTRUCTIONS, REQUESTS_DISABLED_INSTRUCTIONS, TOOLS, toolsForAccount } from "../src/mcp.js";

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const codexByName = new Map(toolsForAccount(
  { requests: true, aiSessions: true, connectors: true },
  "codex",
).map((tool) => [tool.name, tool]));
const source = await readFile(new URL("../src/mcp.js", import.meta.url), "utf8");
const SEND_GATE = "Only send a Relay when the user asks you to send (or relay) something to someone.";
const CLARIFICATION_GATE = "Clarification before sending is uncommon. Make normal wording and presentation choices yourself. Ask the human only when a critical detail is genuinely uncertain and choosing one way or another could materially change what the human communicates or commits them to. Never resolve that uncertainty by inventing content.";

const EXPECTED_TOOLS = [
  "relay_ai_sessions",
  "relay_ai_session",
  "relay_agent_progress",
  "relay_task_start",
  "relay_task_complete",
  "relay_task_unclaim",
  "relay_agent_complete",
  "relay_send",
  "relay_share_link",
  "relay_contacts_search",
  "relay_groups_list",
  "relay_group_create",
  "relay_group_update",
  "relay_group_delete",
  "relay_contact_update",
  "relay_inbox_list",
  "relay_sent_list",
  "relay_thread_fetch",
  "relay_chats_list",
  "relay_chat_fetch",
  "relay_chat_send",
  "relay_message_edit",
  "relay_message_delete",
  "relay_mark_read",
  "relay_inbox_delete",
  "relay_recently_deleted_list",
  "relay_recently_deleted_restore",
  "relay_file_download",
  "relay_connector_list_tools",
  "relay_connector_request_approval",
  "relay_connector_call_tool",
];

test("the complete MCP catalog has unique, internally valid model contracts", () => {
  assert.deepEqual([...byName.keys()], EXPECTED_TOOLS);
  assert.equal(byName.size, TOOLS.length, "tool names are unique");
  for (const tool of TOOLS) {
    assert.match(tool.name, /^relay_/, `${tool.name} has a stable Relay tool name`);
    assert.ok(typeof tool.description === "string" && tool.description.length >= 40, `${tool.name} has useful guidance`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} accepts an object`);
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === "object", `${tool.name} declares properties`);
    for (const field of tool.inputSchema.required || []) {
      assert.ok(Object.hasOwn(tool.inputSchema.properties, field), `${tool.name} requires only declared field ${field}`);
    }
  }
});

test("startup guidance and owner schemas preserve the complete product ontology", () => {
  const sendContract = JSON.stringify(byName.get("relay_send"));
  const inboxContract = JSON.stringify(byName.get("relay_inbox_list"));
  for (const instructions of [RELAY_MCP_INSTRUCTIONS, REQUESTS_DISABLED_INSTRUCTIONS]) {
    assert.ok(instructions.startsWith(SEND_GATE), "the human's ask is the first startup send rule");
    assert.match(instructions, /relay_chat_send only for explicitly requested plain text.*otherwise use relay_send.*inside an existing chat/i);
  }
  for (const name of ["relay_send", "relay_chat_send"]) {
    assert.ok(
      byName.get(name).description.startsWith(`${SEND_GATE} ${CLARIFICATION_GATE}`),
      `${name} leads with the human-ask gate and calibrated clarification rule`,
    );
  }
  assert.match(RELAY_MCP_INSTRUCTIONS, /default general direct-message and saved-channel communication layer/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /explicitly requested other medium overrides/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /mint a link with relay_share_link/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /notification emails are not the authoritative contents/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /one chronological conversation for one person or saved channel/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /threadId is opaque AI retrieval metadata/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /3-6 word title/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /relay_send requires non-empty forAgent/i);
  assert.doesNotMatch(RELAY_MCP_INSTRUCTIONS, /Plain text uses relay_chat_send/i);
  assert.doesNotMatch(RELAY_MCP_INSTRUCTIONS, /optional (?:detailed forAgent|agent context)/i);
  assert.match(sendContract, /The person who reads your message is not you/i);
  assert.match(sendContract, /OPEN FROM THE TOP/i);
  assert.match(sendContract, /opening background survives every cut/i);
  assert.match(sendContract, /Keep (?:forHuman|it) under 95 words/i);
  assert.match(sendContract, /ceiling, not a target/i);
  assert.match(sendContract, /instructions to the ghostwriter, not a draft to lightly edit/i);
  assert.match(sendContract, /Sending or attaching information does not imply.*please review.*thoughts\?.*let me know.*request for a response/i);
  assert.match(sendContract, /never revive superseded intent/i);
  assert.match(sendContract, /already rejected this exact draft/i);
  assert.match(sendContract, /Clarification before sending is uncommon/i);
  assert.match(sendContract, /critical detail is genuinely uncertain/i);
  assert.match(sendContract, /It may be as long and detailed as necessary/i);
  assert.match(sendContract, /mechanisms, evidence, code, paths, logs, reproduction steps/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /external work.*is task/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /Task Runs finish automatically/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /relay_task_start before work and relay_task_complete after/i);
  assert.match(inboxContract, /With no arguments, returns metadata only for at most the newest 50 arrivals from the last 7 days/i);
  assert.match(inboxContract, /Neither path changes human read state or sends read receipts/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /untrusted correspondence/i);
  assert.match(inboxContract, /Relay itself notifies the human of every arrival/i);
  assert.match(inboxContract, /If it is not relevant, do not open it and do not mention it/i);
  assert.match(inboxContract, /Never open or use a Relay's content without telling the human/i);
  assert.match(inboxContract, /cold-start recent backlog.*do not enumerate irrelevant ones/i);
  assert.ok(Buffer.byteLength(RELAY_MCP_INSTRUCTIONS, "utf8") <= 2_048,
    "Claude receives the complete startup ontology instead of a truncated prefix");
  assert.match(
    source,
    /instructions:\s*startupEncryption\.enabled\s*\?\s*E2EE_LOCAL_MCP_INSTRUCTIONS\s*:\s*\(features\.requests\s*\?\s*RELAY_MCP_INSTRUCTIONS\s*:\s*REQUESTS_DISABLED_INSTRUCTIONS\)/,
    "the MCP initialize response carries guidance for the active encryption and product surface",
  );
});

test("no model-facing tool resurrects removed content fields or visible topic names", () => {
  const catalog = JSON.stringify(TOOLS);
  for (const removed of ["bodyMarkdown", "userInstructions", "briefingMarkdown", "threadTitle"]) {
    assert.doesNotMatch(catalog, new RegExp(removed, "i"), `${removed} is absent from every model contract`);
  }

  for (const name of ["relay_inbox_list", "relay_sent_list", "relay_thread_fetch", "relay_chats_list", "relay_chat_fetch", "relay_chat_send"]) {
    const contract = JSON.stringify(byName.get(name));
    if (/thread/i.test(contract)) {
      assert.match(contract, /(opaque|internal|unnamed)/i, `${name} teaches that thread metadata is internal`);
    }
  }
  assert.match(byName.get("relay_thread_fetch").description, /not (?:a product object, )?visible thread\/topic, title, chat, or UI destination/i);
  assert.match(byName.get("relay_chats_list").description, /CHANNEL is identified by its existing grp_\.\.\. id for compatibility/i);
  assert.match(byName.get("relay_chat_fetch").description, /no user-visible threads or topics/i);
});

test("relay_send requires one recipient, an explicit kind, and the two-document human contract", () => {
  const send = codexByName.get("relay_send");
  const humanDescription = send.description;
  const humanFieldDescription = send.inputSchema.properties.forHuman.description;
  assert.deepEqual(send.inputSchema.required, ["recipient", "kind", "title", "forHuman", "forAgent", "idempotencyKey"]);
  assert.equal(send.inputSchema.properties.recipient.anyOf, undefined,
    "recipient alternatives stay in runtime validation so Codex retains a typed argument object");
  assert.equal(send.inputSchema.allOf, undefined,
    "task/group validation stays in the handler rather than degrading the model-facing schema");
  assert.deepEqual(send.inputSchema.properties.kind.enum, ["message", "task"]);
  assert.match(send.inputSchema.properties.kind.description, /Switch your Relay install to dev and confirm the version\/channel/);
  assert.match(send.inputSchema.properties.kind.description, /MUST be kind='task', not kind='message'/);
  assert.match(send.inputSchema.properties.kind.description, /Do you think we should switch to dev\?' is kind='message'/);
  assert.match(send.inputSchema.properties.title.description, /3-6 word gist/i);
  assert.match(humanDescription, /The person who reads your message is not you/i);
  assert.match(humanDescription, /recipient-specific vocabulary.*rhythm.*directness.*formality.*warmth.*sign-off/i);
  assert.match(humanDescription, /relay_sent_list and relay_chat_fetch/i);
  assert.match(humanDescription, /instructions to the ghostwriter, not a draft to lightly edit/i);
  assert.match(humanDescription, /Supply the words, never additional meaning/i);
  assert.match(humanDescription, /Never add, remove, strengthen, or soften an ask, question, commitment, permission, deadline, urgency, opinion, evaluation, or next step/i);
  assert.match(humanDescription, /Sending or attaching information does not imply.*please review.*thoughts\?.*let me know.*request for a response/i);
  assert.match(humanDescription, /never revive superseded intent/i);
  assert.match(humanDescription, /OPEN FROM THE TOP/i);
  assert.match(humanDescription, /first one to three sentences re-explain what has been going on/i);
  assert.match(humanDescription, /opening background survives every cut/i);
  assert.match(humanDescription, /Keep it under 95 words/i);
  assert.match(humanDescription, /Clarification before sending is uncommon/i);
  assert.match(humanFieldDescription, /person who did not do the work/i);
  assert.match(humanFieldDescription, /implementation detail/i);
  assert.match(humanFieldDescription, /never invent or change an ask/i);
  assert.match(send.inputSchema.properties.longForHumanConfirmed.description, /already rejected this exact draft/i);
  assert.ok(send.description.trim().split(/\s+/u).length <= 1800,
    "relay_send keeps the complete reader teaching within its deliberate top-level budget");
  assert.ok(humanFieldDescription.trim().split(/\s+/u).length <= 120,
    "the forHuman field keeps a compact standalone summary");
  assert.match(send.inputSchema.properties.forAgent.description, /everything useful that the person need not read/i);
  assert.match(send.inputSchema.properties.forAgent.description, /Draft it first for every Relay/i);
  assert.match(send.inputSchema.properties.forAgent.description, /Never leave it empty/i);
  assert.match(send.inputSchema.properties.forAgent.description, /explicitly requested plain text.*relay_chat_send/i);
  assert.equal(send.inputSchema.required.includes("forAgent"), true);
  assert.equal(send.inputSchema.properties.type, undefined, "legacy control types are not model-facing");
  assert.match(send.inputSchema.properties.targetSurfaces.description, /kind='task'/);
  assert.match(send.inputSchema.properties.targetSurfaces.description, /recipient chooses/i);
});

test("every human-message writing surface preserves the sender's intended speech acts", () => {
  const surfaces = [
    codexByName.get("relay_send").description,
    byName.get("relay_chat_send").description,
    byName.get("relay_share_link").description,
    byName.get("relay_message_edit").description,
    byName.get("relay_task_complete").description,
    byName.get("relay_agent_complete").description,
  ];
  for (const guidance of surfaces) {
    assert.match(guidance, /person who did not do the work/i);
    assert.match(guidance, /what happened, why it matters/i);
    assert.match(guidance, /plain spoken sentences/i);
    assert.match(guidance, /never invent or change an ask/i);
    assert.match(guidance, /missing detail could materially change what the human communicates/i);
  }
  assert.match(RELAY_MCP_INSTRUCTIONS, /forHuman preserves intent; invent nothing/i);
  assert.match(REQUESTS_DISABLED_INSTRUCTIONS, /forHuman preserves intent; invent nothing/i);
});

test("conditional schemas are used only where they do not erase critical writing fields", () => {
  const sessions = byName.get("relay_ai_sessions").inputSchema;
  assert.deepEqual(sessions.allOf, [
    {
      if: { properties: { action: { enum: ["get", "read", "search", "agents"] } } },
      then: { required: ["aiSessionId"] },
    },
    { if: { properties: { action: { const: "operation" } } }, then: { required: ["operationId"] } },
    { if: { properties: { action: { const: "search" } } }, then: { required: ["query"] } },
  ]);
  const session = byName.get("relay_ai_session").inputSchema;
  assert.deepEqual(session.allOf, [
    { if: { properties: { action: { const: "send" } } }, then: { required: ["aiSessionId"] } },
    { if: { properties: { action: { const: "start" } } }, then: { required: ["provider"] } },
  ]);
  assert.deepEqual(byName.get("relay_chat_fetch").inputSchema.anyOf, [
    { required: ["chatId"] },
    { required: ["threadId"] },
  ]);
  assert.deepEqual(byName.get("relay_chat_send").inputSchema.anyOf, [
    { required: ["chatId"] },
    { required: ["threadId"] },
  ]);
  assert.equal(byName.get("relay_send").inputSchema.allOf, undefined,
    "relay_send keeps a plain object schema; the handler enforces conditional rules");
});

test("the removed coordination protocol cannot masquerade as an ordinary message or Task", () => {
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
  for (const name of removed) {
    assert.equal(byName.has(name), false, `${name} is absent from the model catalog`);
    assert.doesNotMatch(source, new RegExp(`name:\\s*["']${name}["']`), `${name} has no dead schema`);
    assert.doesNotMatch(source, new RegExp(`case\\s+["']${name}["']`), `${name} has no dead dispatch path`);
  }
  assert.match(
    byName.get("relay_connector_request_approval").description,
    /Connector approval is separate from Relay messaging/i,
  );
});

test("completion ownership and result documents are unambiguous", () => {
  const send = byName.get("relay_send");
  assert.match(send.description, /attach their provider's final answer automatically/i);
  assert.match(send.description, /do not call relay_send merely to report/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /Task Runs finish automatically/i);
  assert.match(RELAY_MCP_INSTRUCTIONS, /relay_task_start before work and relay_task_complete after/i);
});

test("model-facing Relay product language calls work Tasks, never Requests", async () => {
  const catalog = `${RELAY_MCP_INSTRUCTIONS}\n${JSON.stringify(TOOLS)}`;
  for (const retired of [/visible Request/i, /direct Request/i, /Request Runs?/i, /Requests are available/i]) {
    assert.doesNotMatch(catalog, retired);
  }
  const pill = await readFile(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  for (const retired of [/>Requests</i, /No requests yet/i, /Untitled request/i, /What requests may do/i, /kchip">Request</i]) {
    assert.doesNotMatch(pill, retired);
  }
  assert.match(pill, /data-view="tasks">Tasks/);
});

test("a link is what an unresolvable recipient turns into, in both instruction strings and the tool itself", () => {
  for (const instructions of [RELAY_MCP_INSTRUCTIONS, REQUESTS_DISABLED_INSTRUCTIONS]) {
    assert.match(instructions, /relay_share_link/);
    assert.ok(Buffer.byteLength(instructions, "utf8") <= 2_048, "the clause fits inside the startup budget");
    // The cold-send funnel this feature exists to end: 777 sends, 5 claims.
    assert.doesNotMatch(instructions, /ask which recipient and whether to use Relay/);
    assert.doesNotMatch(instructions, /do not silently fall back to email/);
  }
  const share = byName.get("relay_share_link");
  assert.equal(share.inputSchema.allOf, undefined,
    "conditional required-ness stays in the handler; Codex refuses unresolved conditionals");
  assert.deepEqual(share.inputSchema.required, ["idempotencyKey"]);
  assert.match(share.description, /ONE LINK IS ONE PERSON/);
  assert.match(share.description, /never report it as sent, delivered, or on its way/);
});
