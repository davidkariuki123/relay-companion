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
  RELAY_MCP_INSTRUCTIONS,
  REQUESTS_DISABLED_INSTRUCTIONS,
  TOOLS,
} from "../src/mcp.js";

const relayBin = fileURLToPath(new URL("../bin/relay.js", import.meta.url));

async function inspectMcp({ developer = false, updateChannel = "stable" }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-startup-"));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_test", email: "test@example.com", accountKind: "human", isDeveloper: developer },
    updateChannel,
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayBin, "mcp"],
    env: {
      ...process.env,
      RELAY_CONFIG_DIR: configDir,
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
  assert.equal(messages.instructions, REQUESTS_DISABLED_INSTRUCTIONS);
  assert.deepEqual(
    new Set(messages.tools.map((tool) => tool.name)),
    ORDINARY_RELAY_TOOL_NAMES,
  );

  const productionDeveloper = await inspectMcp({ developer: true });
  assert.equal(productionDeveloper.instructions, REQUESTS_DISABLED_INSTRUCTIONS);
  assert.deepEqual(
    new Set(productionDeveloper.tools.map((tool) => tool.name)),
    ORDINARY_RELAY_TOOL_NAMES,
  );

  const full = await inspectMcp({ developer: true, updateChannel: "dev" });
  assert.equal(full.instructions, RELAY_MCP_INSTRUCTIONS);
  assert.deepEqual(full.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
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
