import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { brokerIdentity } from "../src/mcp-broker-state.js";
import { ensureStableMcpLauncher, mcpLaunchCommand } from "../src/mcp-launcher.js";

const companionRoot = fileURLToPath(new URL("..", import.meta.url));
const companionBin = path.join(companionRoot, "bin", "relay.js");
const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

function brokerPids(domainId) {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return String(listed.stdout || "").split("\n")
    .filter((line) => line.includes("mcp-broker-entry.js") && line.includes(`--domain=${domainId}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

async function until(what, condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Claude Desktop never restarts a stdio server it lost. An update stops the old
// release's broker, so the bridge the host spawned has to outlive it.
test("the native bridge keeps a host session alive across a broker restart", {
  skip: process.platform === "win32" || !goAvailable ? "needs go and a POSIX ps" : false,
  timeout: 120_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-reconnect-"));
  const configDir = path.join(root, ".relay");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_bridge_reconnect", email: "bridge@example.test", accountKind: "human", isDeveloper: false },
    updateChannel: "stable",
  }));
  const env = {
    ...process.env,
    HOME: root,
    RELAY_CONFIG_DIR: configDir,
    RELAY_HOME: configDir,
    RELAY_COMPANION_HOME: configDir,
  };
  const nativeBridge = path.join(root, "mcp-bridge-build");
  const build = spawnSync("go", ["build", "-trimpath", "-o", nativeBridge, "."], {
    cwd: path.join(companionRoot, "native-bridge"),
    env: { ...process.env, CGO_ENABLED: "0" },
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  assert.equal(build.status, 0, build.stderr);
  const registered = ensureStableMcpLauncher({ targetBin: companionBin, homeDir: root, env, nativeBridge });
  const launch = mcpLaunchCommand({ mcpBin: registered, node: process.execPath });
  assert.equal(path.basename(launch.command), "mcp-bridge");
  const { domainId } = brokerIdentity({ env, packageRoot: companionRoot });

  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let closed = false;
  transport.onclose = () => { closed = true; };
  const client = new Client({ name: "claude-ai", version: "test" }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
  t.after(async () => {
    await client.close().catch(() => {});
    for (const pid of brokerPids(domainId)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  const before = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(before.includes("relay_send"), `catalogue: ${before.join(", ")}`);
  const [firstBroker] = await until("the broker process", () => brokerPids(domainId).length === 1 && brokerPids(domainId));

  // What the updater does to an old release's broker when it gives up waiting.
  process.kill(firstBroker, "SIGKILL");
  await until("a replacement broker", () => {
    const pids = brokerPids(domainId);
    return pids.length === 1 && pids[0] !== firstBroker;
  });
  await until("tools/list_changed", () => listChanged > 0);

  assert.equal(closed, false, `the host transport closed:\n${stderr}`);
  const after = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(after, before);
  await client.ping();
  assert.match(stderr, /reconnected/);
});
