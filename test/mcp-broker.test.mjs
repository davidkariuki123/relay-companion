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
  healMcpBrokerProvisioning,
  isMainModule,
  readMcpBrokerProvisioning,
  removeMcpBrokerProvisioning,
} from "../src/mcp-broker-state.js";
import { canonicalRuntimeLayout } from "../src/canonical-runtime.js";
import { startMcpBrokerDescriptorGuard } from "../src/task-daemon.js";
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
      // Leave enough idle time for all eight bridges to reach the broker under CI load.
      env: { ...env, RELAY_HOME: configDir, RELAY_COMPANION_HOME: configDir, RELAY_MCP_BROKER_IDLE_MS: "15000" },
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

function canonicalPointer(homeDir, releaseId = "0.1.510-test") {
  const layout = canonicalRuntimeLayout({ homeDir, releaseId });
  fs.mkdirSync(layout.packageRoot, { recursive: true });
  const pointer = {
    schema: 1,
    active: true,
    version: "0.1.510",
    releaseId: layout.releaseId,
    releaseRoot: layout.releaseRoot,
    packageRoot: layout.packageRoot,
    bin: layout.bin,
    node: process.execPath,
    committedAt: 1,
  };
  fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
  fs.writeFileSync(layout.pointerPath, `${JSON.stringify(pointer)}\n`);
  return { pointer, layout };
}

test("a private checkout provisions its own descriptor and never touches the canonical one", { skip: process.platform === "win32" }, (t) => {
  const { root, env } = tempConfig();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { layout } = canonicalPointer(root);
  const canonical = ensureMcpBrokerProvisioned({ env, packageRoot: layout.packageRoot, homeDir: root });
  assert.equal(canonical.files.shared, true);
  assert.equal(path.basename(canonical.files.descriptor), "broker-v1.json");
  const before = fs.readFileSync(canonical.files.descriptor, "utf8");

  const checkout = path.join(root, "src", "relay-worktree", "packages", "companion");
  fs.mkdirSync(checkout, { recursive: true });
  const priv = ensureMcpBrokerProvisioned({ env, packageRoot: checkout, homeDir: root });
  assert.equal(priv.files.shared, false);
  assert.match(path.basename(priv.files.descriptor), /^broker-v1\.private-[0-9a-f]{16}\.json$/);
  assert.equal(fs.readFileSync(canonical.files.descriptor, "utf8"), before, "the canonical descriptor is untouched");
  assert.equal(readMcpBrokerProvisioning({ env, packageRoot: checkout, homeDir: root }).endpoint, brokerEndpoint({ env, identity: priv.identity }));
  assert.equal(readMcpBrokerProvisioning({ env, packageRoot: layout.packageRoot, homeDir: root }).endpoint, brokerEndpoint({ env, identity: canonical.identity }));
  assert.deepEqual(priv.capability, canonical.capability, "one owner-only capability serves both");

  // Another release of the canonical runtime shares the file: an update hands
  // the descriptor over rather than forking it.
  const other = canonicalRuntimeLayout({ homeDir: root, releaseId: "0.1.511-test" });
  fs.mkdirSync(other.packageRoot, { recursive: true });
  assert.equal(brokerProvisioningPaths({ env, identity: brokerIdentity({ env, packageRoot: other.packageRoot }), homeDir: root }).shared, true);
});

test("without a canonical runtime every package root shares the descriptor", { skip: process.platform === "win32" }, (t) => {
  const { root, env } = tempConfig();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ensureMcpBrokerProvisioned({ env, packageRoot: companionRoot, homeDir: root }).files;
  assert.equal(files.shared, true);
  assert.equal(path.basename(files.descriptor), "broker-v1.json");
});

test("the canonical runtime heals a descriptor another tree overwrote; a foreign tree leaves it alone", { skip: process.platform === "win32" }, (t) => {
  const { root, env } = tempConfig();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { layout } = canonicalPointer(root);
  const canonical = ensureMcpBrokerProvisioned({ env, packageRoot: layout.packageRoot, homeDir: root });
  assert.deepEqual(healMcpBrokerProvisioning({ env, packageRoot: layout.packageRoot, homeDir: root }), { healed: false, reason: "healthy" });

  // What an older checkout without private descriptors did on 2026-09-13:
  // the shared file named a socket nothing listened on and a broker command
  // that did not exist.
  const poisoned = {
    ...JSON.parse(fs.readFileSync(canonical.files.descriptor, "utf8")),
    domainId: "d03cc7d14c5e7ab75d972a21ab3344a34ef8c7c89073c2c05fdb761a0b65261b",
    endpoint: path.join(canonical.files.dir, "b-v1-d03cc7d14c5e7ab7.sock"),
    brokerNode: "/Applications/Relay.app/Contents/MacOS/Relay",
    brokerEntry: "/private/tmp/relay-long-paste/packages/companion/src/mcp-broker-entry.js",
  };
  fs.writeFileSync(canonical.files.descriptor, JSON.stringify(poisoned), { mode: 0o600 });
  assert.throws(() => readMcpBrokerProvisioning({ env, packageRoot: layout.packageRoot, homeDir: root }), /does not match this installation/);

  const foreign = path.join(root, "src", "relay-other", "packages", "companion");
  fs.mkdirSync(foreign, { recursive: true });
  const refused = healMcpBrokerProvisioning({ env, packageRoot: foreign, homeDir: root });
  assert.equal(refused.healed, false);
  assert.equal(refused.reason, "private-checkout");
  assert.equal(JSON.parse(fs.readFileSync(canonical.files.descriptor, "utf8")).brokerNode, poisoned.brokerNode, "a private checkout never rewrites the shared descriptor");

  const stale = canonicalRuntimeLayout({ homeDir: root, releaseId: "0.1.400-old" });
  fs.mkdirSync(stale.packageRoot, { recursive: true });
  assert.equal(healMcpBrokerProvisioning({ env, packageRoot: stale.packageRoot, homeDir: root }).reason, "canonical-release");
  assert.equal(JSON.parse(fs.readFileSync(canonical.files.descriptor, "utf8")).brokerNode, poisoned.brokerNode, "a non-current release never rewrites it either");

  const healed = healMcpBrokerProvisioning({ env, packageRoot: layout.packageRoot, brokerNode: process.execPath, homeDir: root });
  assert.equal(healed.healed, true);
  assert.equal(healed.reason, "canonical-current");
  assert.match(healed.fault, /does not match this installation/);
  const repaired = readMcpBrokerProvisioning({ env, packageRoot: layout.packageRoot, homeDir: root });
  assert.equal(repaired.endpoint, brokerEndpoint({ env, identity: canonical.identity }));
  assert.equal(JSON.parse(fs.readFileSync(canonical.files.descriptor, "utf8")).brokerEntry, path.join(layout.packageRoot, "src", "mcp-broker-entry.js"));
});

test("the daemon guard heals once and logs a foreign descriptor once", () => {
  const logs = [];
  const outcomes = [
    { healed: false, reason: "healthy" },
    { healed: true, reason: "canonical-current", fault: "Relay MCP broker state does not match this installation" },
    { healed: false, reason: "private-checkout", fault: "mismatch" },
    { healed: false, reason: "private-checkout", fault: "mismatch" },
  ];
  const guard = startMcpBrokerDescriptorGuard({
    log: (line) => logs.push(line),
    packageRoot: "/runtime/current",
    heal: () => outcomes.shift(),
    setIntervalImpl: () => ({ unref() {} }),
  });
  guard.check();
  guard.check();
  guard.check();
  assert.deepEqual(logs, [
    "MCP broker descriptor rewritten for this runtime (canonical-current); it read: Relay MCP broker state does not match this installation",
    "MCP broker descriptor does not belong to this runtime (private-checkout); leaving it: mismatch",
  ]);
});
