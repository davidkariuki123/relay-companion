import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prepareOrdinaryRelayAttachments } from "../src/attachments.js";
import { bridgeSessionContext } from "../src/mcp-bridge.js";
import { createAttachmentGate } from "../src/mcp-broker.js";
import {
  BrokerFrameBudget,
  BrokerStdioTransport,
} from "../src/mcp-broker-transport.js";
import {
  MCP_BRIDGE_MAX_OLD_SPACE_MB,
  brokerEndpoint,
  brokerIdentity,
  brokerProvisioningPaths,
  ensureMcpBrokerProvisioned,
  isMainModule,
  readMcpBrokerProvisioning,
  removeMcpBrokerProvisioning,
} from "../src/mcp-broker-state.js";
import { ensureStableMcpLauncher } from "../src/mcp-launcher.js";

const companionBin = fileURLToPath(new URL("../bin/relay.js", import.meta.url));
const companionRoot = fileURLToPath(new URL("..", import.meta.url));

function tempConfig(prefix = "relay-mcp-broker-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, ".relay");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_broker_test", email: "broker@example.test", accountKind: "human", isDeveloper: false },
    updateChannel: "stable",
  }));
  return { root, configDir, env: { ...process.env, HOME: root, RELAY_CONFIG_DIR: configDir } };
}

test("broker domains isolate exact runtime, config root, API origin, and pinned credentials", () => {
  const base = { RELAY_CONFIG_DIR: "/tmp/relay-a", RELAY_API_URL: "https://api-a.example" };
  const first = brokerIdentity({ env: base, packageRoot: "/runtime/a" });
  assert.equal(first.domainId, brokerIdentity({ env: { ...base }, packageRoot: "/runtime/a" }).domainId);
  assert.notEqual(first.domainId, brokerIdentity({ env: base, packageRoot: "/runtime/b" }).domainId);
  assert.notEqual(first.domainId, brokerIdentity({ env: { ...base, RELAY_CONFIG_DIR: "/tmp/relay-b" }, packageRoot: "/runtime/a" }).domainId);
  assert.notEqual(first.domainId, brokerIdentity({ env: { ...base, RELAY_API_URL: "https://api-b.example" }, packageRoot: "/runtime/a" }).domainId);
  const pinned = brokerIdentity({ env: { ...base, RELAY_DEVICE_TOKEN: "secret-a" }, packageRoot: "/runtime/a" });
  assert.notEqual(first.domainId, pinned.domainId);
  assert.notEqual(pinned.domainId, brokerIdentity({ env: { ...base, RELAY_DEVICE_TOKEN: "secret-b" }, packageRoot: "/runtime/a" }).domainId);
  assert.doesNotMatch(pinned.domainId, /secret/);
});

test("long POSIX config roots fall back to a short owner-scoped socket", () => {
  const env = { RELAY_CONFIG_DIR: `/tmp/${"very-long-config-root-".repeat(8)}` };
  const endpoint = brokerEndpoint({ env, platform: "darwin" });
  assert.ok(Buffer.byteLength(endpoint) < 100, endpoint);
  assert.match(endpoint.replaceAll("\\", "/"), /^\/tmp\/relay-mcp-/);
});

test("broker entrypoint detection uses native paths on POSIX and Windows", () => {
  assert.equal(isMainModule("file:///opt/relay/src/mcp-broker-entry.js", "/opt/relay/src/mcp-broker-entry.js", "linux"), true);
  assert.equal(isMainModule("file:///C:/Relay/src/mcp-broker-entry.js", "C:\\Relay\\src\\mcp-broker-entry.js", "win32"), true);
  assert.equal(isMainModule("file:///C:/Relay/src/mcp-broker-entry.js", "C:\\Elsewhere\\mcp-broker-entry.js", "win32"), false);
});

test("POSIX provisioning is stable, owner-only, and carries no secret in JSON", { skip: process.platform === "win32" }, (t) => {
  const { root, env } = tempConfig();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = ensureMcpBrokerProvisioned({ env, packageRoot: companionRoot });
  const second = readMcpBrokerProvisioning({ env, packageRoot: companionRoot });
  assert.deepEqual(second.capability, first.capability);
  assert.equal(first.capability.length, 32);
  assert.equal(fs.statSync(first.files.capability).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.files.descriptor).mode & 0o777, 0o600);
  const descriptor = fs.readFileSync(first.files.descriptor, "utf8");
  assert.doesNotMatch(descriptor, new RegExp(first.capability.toString("base64url")));
});

test("Windows provisioning applies explicit owner-only ACLs outside the bridge hot path", (t) => {
  const { root, env } = tempConfig("relay-mcp-win-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protectedFiles = [];
  const first = ensureMcpBrokerProvisioned({
    env,
    packageRoot: companionRoot,
    platform: "win32",
    windowsAclProtector: (file) => protectedFiles.push(file),
  });
  const second = readMcpBrokerProvisioning({ env, packageRoot: companionRoot, platform: "win32" });
  assert.deepEqual(second.capability, first.capability);
  const files = brokerProvisioningPaths({ env, identity: first.identity });
  assert.deepEqual(protectedFiles, [files.capability, files.descriptor]);
  assert.equal(fs.existsSync(files.capability), true);
  assert.match(fs.readFileSync(files.descriptor, "utf8"), /windowsAclProtected/);
  removeMcpBrokerProvisioning({ env, packageRoot: companionRoot, platform: "win32" });
});

test("the bridge sends only bounded session context and a canonical channel decision", () => {
  const context = bridgeSessionContext({
    argv: ["node", "bridge", "--channels", "server:relay"],
    env: {
      CODEX_THREAD_ID: "thr_1",
      RELAY_DEVICE_TOKEN: "must-not-cross-the-socket",
      RANDOM_SECRET: "also-no",
    },
    cwd: ".",
  });
  assert.equal(context.channelEnabled, true);
  assert.equal(context.channelSource, "relay-channel-argv");
  assert.deepEqual(context.env, { CODEX_THREAD_ID: "thr_1" });
  assert.equal(path.isAbsolute(context.cwd), true);
});

test("frame accounting is held until the response and shared across connections", async () => {
  const budget = new BrokerFrameBudget(96);
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new BrokerStdioTransport(input, output, { maxBufferSize: 80, budget });
  const messages = [];
  transport.onmessage = (message) => messages.push(message);
  await transport.start();
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`;
  input.write(request);
  await delay(0);
  assert.equal(messages.length, 1);
  assert.equal(budget.usedBytes, Buffer.byteLength(request));
  await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(budget.usedBytes, 0);
  await transport.close();
});

test("aggregate frame pressure fails closed instead of buffering every client", async () => {
  const firstInput = new PassThrough();
  const secondInput = new PassThrough();
  const budget = new BrokerFrameBudget(90);
  const first = new BrokerStdioTransport(firstInput, new PassThrough(), { maxBufferSize: 80, budget });
  const second = new BrokerStdioTransport(secondInput, new PassThrough(), { maxBufferSize: 80, budget });
  let secondError = "";
  second.onerror = (error) => { secondError = error.message; };
  await first.start();
  await second.start();
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })}\n`;
  firstInput.write(request);
  secondInput.write(request.replace('"id":1', '"id":2'));
  await delay(0);
  assert.match(secondError, /aggregate frame budget exceeded/);
  assert.equal(second.closed, true);
  await first.close();
  assert.equal(budget.usedBytes, 0);
});

test("attachment admission is one fail-fast broker-wide token", () => {
  const gate = createAttachmentGate();
  const release = gate.tryAcquire();
  assert.equal(typeof release, "function");
  assert.equal(gate.tryAcquire(), null);
  release();
  assert.equal(typeof gate.tryAcquire(), "function");
});

test("relative attachment paths remain scoped to the calling bridge cwd", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-cwd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "from the bridge cwd");
  const [attachment] = await prepareOrdinaryRelayAttachments(
    { files: ["notes.txt"], idempotencyKey: "cwd-relative-1" },
    { baseDir: dir },
  );
  assert.equal(attachment.name, "notes.txt");
  assert.equal(Buffer.from(attachment.contentBase64, "base64").toString("utf8"), "from the bridge cwd");
});

test("eight simultaneous hosts share exactly one broker and all retain MCP parity", { timeout: 90_000 }, async (t) => {
  const { root, configDir, env } = tempConfig("relay-mcp-fanout-");
  const launcher = ensureStableMcpLauncher({ targetBin: companionBin, homeDir: root, env });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(({ client }) => client.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 8; index += 1) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [`--max-old-space-size=${MCP_BRIDGE_MAX_OLD_SPACE_MB}`, launcher, "mcp"],
      env: { ...env, RELAY_HOME: configDir, RELAY_COMPANION_HOME: configDir, RELAY_MCP_BROKER_IDLE_MS: "2000" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: index % 2 ? "claude-code" : "codex-mcp-client", version: "test" }, { capabilities: {} });
    clients.push({ client, transport, stderr: () => stderr });
  }
  try {
    await Promise.all(clients.map(({ client, transport }) => client.connect(transport)));
  } catch (error) {
    let brokerLog = "";
    try { brokerLog = fs.readFileSync(path.join(configDir, "logs", "broker.log"), "utf8"); } catch {}
    const bridgeErrors = clients.map(({ stderr }, index) => `bridge ${index}: ${stderr()}`).filter((line) => !line.endsWith(": ")).join("\n");
    throw new Error(`${error?.message || error}\n${bridgeErrors}\nbroker log:\n${brokerLog}`);
  }
  const catalogs = await Promise.all(clients.map(({ client }) => client.listTools()));
  const expected = catalogs[0].tools.map((tool) => tool.name);
  for (const catalog of catalogs) assert.deepEqual(catalog.tools.map((tool) => tool.name), expected);
  const log = fs.readFileSync(path.join(configDir, "logs", "broker.log"), "utf8");
  assert.equal(log.split("\n").filter((line) => / start domain=/.test(line)).length, 1, log);
});
