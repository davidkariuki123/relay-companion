import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ensureStableMcpLauncher,
  mcpLaunchCommand,
  nativeMcpBridgeFingerprintPath,
  referencedMcpBridgePaths,
  removeStableMcpLauncher,
  stableMcpLauncherPath,
  stableNativeMcpBridgePath,
  STABLE_MCP_LAUNCHER_ENV,
} from "../src/mcp-launcher.js";

// Every host on this machine has to be invisible to these tests, or a developer's
// own ~/.claude.json decides whether a prune runs.
function isolatedEnv(homeDir, overrides = {}) {
  return {
    HOME: homeDir,
    CLAUDE_USER_DATA_DIR: path.join(homeDir, "desktop"),
    CLAUDE_CODE_CONFIG: path.join(homeDir, ".claude.json"),
    CODEX_CONFIG: path.join(homeDir, ".codex", "config.toml"),
    ...overrides,
  };
}

function fingerprintOf(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex").slice(0, 16);
}

test("a packaged native bridge replaces the per-session Node launcher", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-launcher-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");
  fs.writeFileSync(nativeBridge, "native-bridge-fixture", { mode: 0o700 });
  const installed = ensureStableMcpLauncher({
    targetBin, node: process.execPath, homeDir, nativeBridge, env: isolatedEnv(homeDir),
  });
  // The installed name carries no fingerprint: it is the path host configs keep
  // across updates, and a name that moves is the whole bug.
  assert.equal(installed, stableNativeMcpBridgePath(homeDir));
  assert.equal(fs.readFileSync(installed, "utf8"), "native-bridge-fixture");
  assert.equal(
    fs.readFileSync(nativeMcpBridgeFingerprintPath(homeDir), "utf8").trim(),
    fingerprintOf("native-bridge-fixture"),
  );
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

test("a second install replaces the stable bridge in place and updates the sidecar", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-replace-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const env = isolatedEnv(homeDir);
  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");

  fs.writeFileSync(nativeBridge, "bridge-release-1", { mode: 0o700 });
  const first = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge, env });
  const firstIno = fs.statSync(first).ino;

  fs.writeFileSync(nativeBridge, "bridge-release-2", { mode: 0o700 });
  const second = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge, env });

  assert.equal(second, first, "the registered path does not move between releases");
  assert.equal(fs.readFileSync(second, "utf8"), "bridge-release-2");
  assert.equal(
    fs.readFileSync(nativeMcpBridgeFingerprintPath(homeDir), "utf8").trim(),
    fingerprintOf("bridge-release-2"),
  );
  // A rename swaps a NEW inode into the name; writing in place would keep the old
  // one and let a host read a half-written binary.
  assert.notEqual(fs.statSync(second).ino, firstIno);

  // A third install of the same binary is a no-op: the sidecar already matches.
  const beforeIno = fs.statSync(second).ino;
  ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge, env });
  assert.equal(fs.statSync(second).ino, beforeIno);
});

test("a fingerprinted bridge a host config still names survives; an unreferenced one is swept", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-prune-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const env = isolatedEnv(homeDir);
  const binDir = path.join(homeDir, ".relay", "bin");
  const referenced = path.join(binDir, "mcp-bridge-aaaaaaaaaaaaaaaa");
  const orphan = path.join(binDir, "mcp-bridge-bbbbbbbbbbbbbbbb");
  const justReplaced = path.join(binDir, "mcp-bridge-cccccccccccccccc");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(referenced, "old-release-still-registered");
  fs.writeFileSync(orphan, "old-release-nobody-runs");
  // An app that was open when its registration moved to the stable name still
  // holds this path; only age, not the config, says when it is safe to drop.
  fs.writeFileSync(justReplaced, "release-before-the-stable-name");
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(orphan, monthAgo, monthAgo);

  fs.mkdirSync(env.CLAUDE_USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.CLAUDE_USER_DATA_DIR, "claude_desktop_config.json"),
    JSON.stringify({ mcpServers: { relay: { command: referenced, args: ["--descriptor", "/d"] } } }),
  );

  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");
  fs.writeFileSync(nativeBridge, "bridge-release-next", { mode: 0o700 });
  const installed = ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge, env });

  assert.equal(installed, stableNativeMcpBridgePath(homeDir));
  assert.equal(fs.existsSync(referenced), true, "a bridge Claude Desktop still execs is never deleted");
  assert.equal(fs.existsSync(orphan), false, "nothing points at this one and it is old, so it goes");
  assert.equal(fs.existsSync(justReplaced), true, "an unreferenced bridge younger than the retention window survives");
});

test("a config we cannot parse means keep everything, never delete everything", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-malformed-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const env = isolatedEnv(homeDir);
  const binDir = path.join(homeDir, ".relay", "bin");
  const orphan = path.join(binDir, "mcp-bridge-bbbbbbbbbbbbbbbb");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(orphan, "old-release");

  fs.mkdirSync(env.CLAUDE_USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_USER_DATA_DIR, "claude_desktop_config.json"), "{not json");

  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");
  fs.writeFileSync(nativeBridge, "bridge-release-next", { mode: 0o700 });
  ensureStableMcpLauncher({ targetBin, node: process.execPath, homeDir, nativeBridge, env });

  assert.equal(fs.existsSync(orphan), true, "an unreadable config references everything, not nothing");
});

test("referencedMcpBridgePaths reads Claude Code and Codex as well as Claude Desktop", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-referenced-"));
  const env = isolatedEnv(homeDir);
  fs.mkdirSync(path.dirname(env.CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(
    env.CLAUDE_CODE_CONFIG,
    JSON.stringify({ mcpServers: { relay: { command: "/h/.relay/bin/mcp-bridge-aaaaaaaaaaaaaaaa" }, other: { command: "/bin/psql" } } }),
  );
  fs.writeFileSync(
    env.CODEX_CONFIG,
    '[mcp_servers.relay]\ncommand = "/h/.relay/bin/mcp-bridge"\nargs = ["--descriptor", "/d"]\n',
  );

  const { paths, all } = referencedMcpBridgePaths({ homeDir, env, platform: "darwin" });
  assert.equal(all, false);
  assert.deepEqual(paths.sort(), ["/h/.relay/bin/mcp-bridge", "/h/.relay/bin/mcp-bridge-aaaaaaaaaaaaaaaa"]);

  // An unreadable Codex file is unknown, so every bridge counts as referenced.
  fs.writeFileSync(env.CLAUDE_CODE_CONFIG, "{not json");
  assert.equal(referencedMcpBridgePaths({ homeDir, env, platform: "darwin" }).all, true);
});

test("a bridge locked by a running host falls back to a fingerprinted name for this run", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-busy-"));
  const targetBin = path.join(homeDir, ".relay", "runtime", "current", "node_modules", "relay-companion", "bin", "relay.js");
  const env = isolatedEnv(homeDir);
  const stable = stableNativeMcpBridgePath(homeDir, "win32");
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, "bridge-in-use");

  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; });
  fs.renameSync = (from, to) => {
    if (path.basename(to) === "mcp-bridge.exe") {
      const error = new Error("EBUSY: resource busy or locked");
      error.code = "EBUSY";
      throw error;
    }
    return realRename(from, to);
  };

  const nativeBridge = path.join(homeDir, "candidate-mcp-bridge");
  fs.writeFileSync(nativeBridge, "bridge-release-next", { mode: 0o700 });
  const installed = ensureStableMcpLauncher({
    targetBin, node: process.execPath, homeDir, nativeBridge, env, platform: "win32",
  });

  assert.equal(installed, stableNativeMcpBridgePath(homeDir, "win32", fingerprintOf("bridge-release-next")));
  assert.equal(fs.readFileSync(installed, "utf8"), "bridge-release-next");
  // The locked file is left exactly as it was — it is still the path every
  // already-running host names — and the sidecar does not claim the new hash.
  assert.equal(fs.readFileSync(stable, "utf8"), "bridge-in-use");
  assert.equal(fs.existsSync(nativeMcpBridgeFingerprintPath(homeDir)), false);
});

test("uninstall removes the stable bridge, its sidecar and every fingerprinted leftover", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-native-remove-"));
  const binDir = path.join(homeDir, ".relay", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const files = [
    stableNativeMcpBridgePath(homeDir),
    stableNativeMcpBridgePath(homeDir, "win32"),
    nativeMcpBridgeFingerprintPath(homeDir),
    path.join(binDir, "mcp-bridge-aaaaaaaaaaaaaaaa"),
    path.join(binDir, "mcp-bridge-bbbbbbbbbbbbbbbb.exe"),
  ];
  for (const file of files) fs.writeFileSync(file, "x");
  fs.writeFileSync(path.join(binDir, "keep-me"), "x");

  removeStableMcpLauncher(homeDir);
  for (const file of files) assert.equal(fs.existsSync(file), false, `${path.basename(file)} removed`);
  assert.equal(fs.existsSync(path.join(binDir, "keep-me")), true);
});
