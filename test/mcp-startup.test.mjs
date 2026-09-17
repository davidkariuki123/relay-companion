import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  ORDINARY_RELAY_TOOL_NAMES,
  ORG_ADMIN_TOOL_NAMES,
  RELAY_MCP_INSTRUCTIONS,
  TOOLS,
  startupInstructionsFor,
} from "../src/mcp.js";

const relayBin = fileURLToPath(new URL("../bin/relay.js", import.meta.url));

// ORDINARY_RELAY_TOOL_NAMES is the ordinary-messaging profile; these are the
// members of it still gated to developer accounts on dev, so a production
// session never sees them. Todo joined this list once its catalog gate existed:
// productFeatures has always had it on the developer row and the Companion
// overlay has always hidden its tab. Editing and deleting a sent message left
// this list on 2026-09-17: they ship to every account, like sending.
const PRODUCTION_ORDINARY_RELAY_TOOL_NAMES = new Set(ORDINARY_RELAY_TOOL_NAMES);
for (const gated of ["relay_todo_update", "relay_todo_visibility", "relay_todo_reorder", "relay_topics_list", "relay_topic_fetch", "relay_topic_context", "relay_topic_threads", "relay_topic_edit", "relay_topic_post", "relay_topic_create", "relay_topic_invite", "relay_topic_member"]) {
  PRODUCTION_ORDINARY_RELAY_TOOL_NAMES.delete(gated);
}
// Organisation onboarding is internal staff work, so a session that is not
// staff (no canViewAdminDashboard) never lists it, on any channel.
for (const staffOnly of ORG_ADMIN_TOOL_NAMES) PRODUCTION_ORDINARY_RELAY_TOOL_NAMES.delete(staffOnly);
// Tasks are on for every account on every deployment (2026-09-17): the Task
// tools and the inbox housekeeping that rides the same row ship to production.
for (const task of ["relay_task_start", "relay_task_complete", "relay_task_unclaim", "relay_inbox_delete", "relay_recently_deleted_list", "relay_recently_deleted_restore", "relay_file_download"]) {
  PRODUCTION_ORDINARY_RELAY_TOOL_NAMES.add(task);
}
// Production has Tasks but not Topics, so its startup block teaches the Task
// close rule and stays silent about boards.
const PRODUCTION_INSTRUCTIONS = startupInstructionsFor({ requests: true, topics: false });

async function inspectMcp({ developer = false, staff = false, updateChannel = "stable" }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-startup-"));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_test", email: "test@example.com", accountKind: "human", isDeveloper: developer, ...(staff ? { canViewAdminDashboard: true } : {}) },
    updateChannel,
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayBin, "mcp"],
    env: {
      ...process.env,
      RELAY_CONFIG_DIR: configDir,
      RELAY_HOME: configDir,
      RELAY_COMPANION_HOME: configDir,
      RELAY_UPDATE_CHANNEL: updateChannel,
    },
    stderr: "pipe",
  });
  let childStderr = "";
  transport.stderr?.on("data", (chunk) => { childStderr += String(chunk); });
  const client = new Client({ name: "relay-startup-test", version: "1.0.0" }, { capabilities: {} });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`${error?.message || error}${childStderr ? `\n${childStderr}` : ""}`);
    }
    return {
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    };
  } finally {
    await client.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test("MCP initialize returns complete startup teachings before tools are selected", async () => {
  const messages = await inspectMcp({ developer: false });
  assert.equal(messages.instructions, PRODUCTION_INSTRUCTIONS);
  assert.match(messages.instructions, /relay_task_start/);
  assert.doesNotMatch(messages.instructions, /Topic/);
  assert.deepEqual(
    new Set(messages.tools.map((tool) => tool.name)),
    PRODUCTION_ORDINARY_RELAY_TOOL_NAMES,
  );

  const productionDeveloper = await inspectMcp({ developer: true });
  assert.equal(productionDeveloper.instructions, PRODUCTION_INSTRUCTIONS);
  assert.deepEqual(
    new Set(productionDeveloper.tools.map((tool) => tool.name)),
    PRODUCTION_ORDINARY_RELAY_TOOL_NAMES,
  );

  const developerNotStaff = await inspectMcp({ developer: true, updateChannel: "dev" });
  assert.ok(developerNotStaff.tools.every((tool) => !ORG_ADMIN_TOOL_NAMES.has(tool.name)), "org onboarding is staff-only even for developers");

  const full = await inspectMcp({ developer: true, staff: true, updateChannel: "dev" });
  assert.equal(full.instructions, RELAY_MCP_INSTRUCTIONS);
  const pausedTodoTools = new Set(["relay_todo_update", "relay_todo_visibility", "relay_todo_reorder"]);
  assert.deepEqual(
    full.tools.map((tool) => tool.name),
    TOOLS.filter((tool) => !pausedTodoTools.has(tool.name)).map((tool) => tool.name),
  );
  assert.doesNotMatch(full.instructions, /relay_todo_update|todoStatuses/);
  assert.deepEqual(Object.keys(full.tools.find((tool) => tool.name === "relay_inbox_list").inputSchema.properties), ["relayIds"]);
});

// The 0%-reachable failure this catches: runtimeEnvironment returns
// "production" for anything off the dev channel, so features.requests is false
// for EVERY account including David's, and toolsForAccount serves
// ORDINARY_RELAY_TOOL_NAMES alone. A share tool left out of that set tests
// perfectly on a dev-channel developer install and does not exist in
// production. Both iterations run on the stable channel, which is the only
// configuration production ships.
test("a production session can see and be told about share links", async () => {
  for (const developer of [false, true]) {
    const messages = await inspectMcp({ developer });
    const share = messages.tools.find((tool) => tool.name === "relay_share_link");
    assert.ok(share, `relay_share_link is ordinary messaging, not a dev-channel tool (developer=${developer})`);
    assert.equal(share._meta?.["anthropic/alwaysLoad"], true);
    assert.match(messages.instructions, /relay_share_link/);
  }
});

test("tools/list survives account drift; only calls refuse", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-drift-"));
  const configPath = path.join(configDir, "config.json");
  const bound = {
    user: { id: "usr_bound", email: "bound@example.com", accountKind: "human", isDeveloper: false },
    deviceId: "dev_bound",
    deviceToken: "dev_token_bound",
    updateChannel: "stable",
  };
  fs.writeFileSync(configPath, JSON.stringify(bound));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayBin, "mcp"],
    env: {
      ...process.env,
      RELAY_CONFIG_DIR: configDir,
      RELAY_HOME: configDir,
      RELAY_COMPANION_HOME: configDir,
      RELAY_UPDATE_CHANNEL: "stable",
      // A dead endpoint: the profile lookup must fail fast, not reach a server.
      RELAY_API_URL: "http://127.0.0.1:9",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "relay-drift-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const before = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(before.includes("relay_inbox_list"));

    // The pill signs out underneath the running session.
    fs.writeFileSync(configPath, JSON.stringify({ updateChannel: "stable" }));
    const after = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(after, before, "the catalog must not empty when the credential is gone");

    const call = await client.callTool({ name: "relay_inbox_list", arguments: {} });
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /signed out/i);
    assert.match(call.content[0].text, /bound@example\.com/);
  } finally {
    await client.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
