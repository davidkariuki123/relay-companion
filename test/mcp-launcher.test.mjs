import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ensureStableMcpLauncher,
  mcpLaunchCommand,
  stableMcpLauncherPath,
  STABLE_MCP_LAUNCHER_ENV,
} from "../src/mcp-launcher.js";

test("a packaged native bridge replaces the per-session Node launcher", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-launcher-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");
  fs.writeFileSync(nativeBridge, "native-bridge-fixture", { mode: 0o700 });
  const installed = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge });
  assert.match(installed, /mcp-bridge-[0-9a-f]{16}(?:\.exe)?$/);
  assert.equal(fs.readFileSync(installed, "utf8"), "native-bridge-fixture");
  assert.deepEqual(mcpLaunchCommand({ mcpBin: installed, node: process.execPath }), {
    command: installed,
    args: ["--descriptor", path.join(homeDir, ".relay", "run", "mcp", "broker-v1.json")],
    env: {},
  });
  const descriptor = JSON.parse(fs.readFileSync(path.join(homeDir, ".relay", "run", "mcp", "broker-v1.json"), "utf8"));
  assert.equal(descriptor.brokerNode, process.execPath);
  assert.match(descriptor.brokerEntry.replaceAll("\\", "/"), /node_modules\/relay-companion\/src\/mcp-broker-entry\.js$/);
});

test("the MCP launcher lives outside the replaceable package tree and records the current target", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-launcher-"));
  const targetBin = path.join(homeDir, ".relay", "lib", "node_modules", "relay-companion", "bin", "relay.js");
  const launcher = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir });
  assert.equal(launcher, stableMcpLauncherPath(homeDir));
  assert.equal(launcher.startsWith(path.dirname(targetBin)), false);
  const source = fs.readFileSync(launcher, "utf8");
  assert.match(source, /initiallyMissing \? 60000 : 30000/);
  assert.match(source, /setTimeout\(launch, 250\)/);
  assert.ok(source.includes(`process.env.${STABLE_MCP_LAUNCHER_ENV} = "1"`));
  // Compare against the path AS THE FILE STORES IT: launcherSource embeds it with
  // JSON.stringify, which escapes backslashes, so a raw Windows path turned into a
  // regex looks for `C:\Users\…` while the file legitimately holds `C:\\Users\\…`
  // and can never match — green on POSIX, permanently red on Windows.
  assert.ok(
    source.includes(`const target = ${JSON.stringify(path.resolve(path.dirname(targetBin), "../src/mcp-bridge.js"))};`),
    "the launcher records the current release's bridge verbatim",
  );
});

test("the MCP launcher waits through a missing-tree window and then execs the restored target", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-launcher-wait-"));
  const targetBin = path.join(homeDir, "live", "bin", "relay.js");
  const launcher = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir });
  const child = spawn(process.execPath, [launcher, "probe"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bridge = path.resolve(path.dirname(targetBin), "../src/mcp-bridge.js");
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'export async function runMcpBridge() { console.log("restored:" + process.argv[2]); return 0; }\n');
  const output = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  assert.match(output, /restored:probe/);
});
