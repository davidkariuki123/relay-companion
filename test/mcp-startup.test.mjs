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

const PRODUCTION_ORDINARY_RELAY_TOOL_NAMES = new Set(ORDINARY_RELAY_TOOL_NAMES);
PRODUCTION_ORDINARY_RELAY_TOOL_NAMES.delete("relay_message_edit");
PRODUCTION_ORDINARY_RELAY_TOOL_NAMES.delete("relay_message_delete");

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
  assert.equal(messages.instructions, REQUESTS_DISABLED_INSTRUCTIONS);
  assert.deepEqual(
    new Set(messages.tools.map((tool) => tool.name)),
    PRODUCTION_ORDINARY_RELAY_TOOL_NAMES,
  );

  const productionDeveloper = await inspectMcp({ developer: true });
  assert.equal(productionDeveloper.instructions, REQUESTS_DISABLED_INSTRUCTIONS);
  assert.deepEqual(
    new Set(productionDeveloper.tools.map((tool) => tool.name)),
    PRODUCTION_ORDINARY_RELAY_TOOL_NAMES,
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

test("tools/list survives an unreachable E2EE status route on a paired, never-encrypted device", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-e2ee-status-"));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_paired", email: "paired@example.com", accountKind: "human", isDeveloper: false },
    deviceId: "dev_paired",
    deviceToken: "dev_token_paired",
    updateChannel: "stable",
  }));
  // What every pairing leaves behind: an enrolled identity, no verified mode yet.
  fs.writeFileSync(path.join(configDir, "e2ee-device-identity.json"), JSON.stringify({
    version: 1,
    protocol: "mls10",
    cipherSuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    signaturePublicKey: "A".repeat(43),
    fingerprint: "B".repeat(43),
    privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43), d: "C".repeat(43) },
    createdAt: new Date().toISOString(),
    deviceId: "dev_paired",
    userId: "usr_paired",
  }), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayBin, "mcp"],
    env: {
      ...process.env,
      RELAY_CONFIG_DIR: configDir,
      RELAY_HOME: configDir,
      RELAY_COMPANION_HOME: configDir,
      RELAY_UPDATE_CHANNEL: "stable",
      // The API is unreachable: GET /v1/e2ee/status fails with "fetch failed".
      RELAY_API_URL: "http://127.0.0.1:9",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "relay-e2ee-status-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("relay_inbox_list"), `plaintext catalog expected, got ${names.length} tools`);
    assert.ok(names.includes("relay_send"));
  } finally {
    await client.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
