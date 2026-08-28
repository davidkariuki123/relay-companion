import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ensureMcpBrokerProvisioned,
  MCP_BRIDGE_MAX_OLD_SPACE_MB,
} from "./mcp-broker-state.js";

export const STABLE_MCP_LAUNCHER_ENV = "RELAY_STABLE_MCP_LAUNCHER";

export function stableMcpLauncherPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "bin", "mcp-launcher.cjs");
}

export function nativeMcpBridgeName(platform = process.platform) {
  return platform === "win32" ? "mcp-bridge.exe" : "mcp-bridge";
}

export function stableNativeMcpBridgePath(homeDir = os.homedir(), platform = process.platform, fingerprint = "") {
  const suffix = fingerprint ? `-${fingerprint}` : "";
  return path.join(homeDir, ".relay", "bin", platform === "win32" ? `mcp-bridge${suffix}.exe` : `mcp-bridge${suffix}`);
}

export function packagedNativeMcpBridgePath(packageRoot, platform = process.platform) {
  return path.join(packageRoot, "native", nativeMcpBridgeName(platform));
}

function launcherSource(targetBin) {
  const bridgeModule = path.resolve(path.dirname(targetBin), "../src/mcp-bridge.js");
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const target = ${JSON.stringify(bridgeModule)};
const initiallyMissing = !fs.existsSync(target);
const deadline = Date.now() + (initiallyMissing ? 60000 : 30000);
process.env.RELAY_MCP_START_DEADLINE_MS = String(deadline);
async function launch() {
  if (!fs.existsSync(target)) {
    if (Date.now() < deadline) return setTimeout(launch, 250);
    console.error("Relay is updating and its MCP entrypoint did not return within 60 seconds: " + target);
    process.exit(1);
  }
  process.env.${STABLE_MCP_LAUNCHER_ENV} = "1";
  try {
    const { runMcpBridge } = await import(pathToFileURL(target).href);
    const code = await runMcpBridge();
    process.exitCode = Number.isInteger(code) ? code : 0;
  } catch (error) {
    console.error("Relay MCP launcher failed: " + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  }
}
void launch();
`;
}

/** Write the upgrade-surviving MCP launcher outside the replaceable npm tree. */
export function ensureStableMcpLauncher({
  targetBin,
  node = process.execPath,
  homeDir = os.homedir(),
  env = process.env,
  nativeBridge,
  platform = process.platform,
} = {}) {
  const packageRoot = path.resolve(path.dirname(targetBin), "..");
  const brokerEnv = { ...env, ...(env.RELAY_CONFIG || env.RELAY_CONFIG_DIR ? {} : { RELAY_CONFIG_DIR: path.join(homeDir, ".relay") }) };
  ensureMcpBrokerProvisioned({
    env: brokerEnv,
    packageRoot,
    brokerNode: node,
  });
  const nativeSource = nativeBridge || packagedNativeMcpBridgePath(packageRoot, platform);
  if (fs.existsSync(nativeSource)) {
    const fingerprint = createHash("sha256").update(fs.readFileSync(nativeSource)).digest("hex").slice(0, 16);
    const bridgePath = stableNativeMcpBridgePath(homeDir, platform, fingerprint);
    fs.mkdirSync(path.dirname(bridgePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(bridgePath)) {
      const tmp = `${bridgePath}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(nativeSource, tmp);
      try { fs.chmodSync(tmp, 0o700); } catch {}
      fs.renameSync(tmp, bridgePath);
    }
    for (const name of fs.readdirSync(path.dirname(bridgePath))) {
      if (name === path.basename(bridgePath) || !/^mcp-bridge-[0-9a-f]{16}(?:\.exe)?$/.test(name)) continue;
      try { fs.rmSync(path.join(path.dirname(bridgePath), name), { force: true }); } catch {}
    }
    return bridgePath;
  }

  const launcherPath = stableMcpLauncherPath(homeDir);
  const source = launcherSource(path.resolve(targetBin));
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = fs.readFileSync(launcherPath, "utf8"); } catch {}
  if (current !== source) {
    const tmp = `${launcherPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, source, { mode: 0o700 });
    fs.renameSync(tmp, launcherPath);
  }
  try { fs.chmodSync(launcherPath, 0o700); } catch {}
  return launcherPath;
}

export function mcpLaunchCommand({
  mcpBin,
  node = process.execPath,
  platform = process.platform,
} = {}) {
  if (/^mcp-bridge(?:-[0-9a-f]{16})?(?:\.exe)?$/i.test(path.basename(mcpBin))) {
    const descriptor = path.join(path.resolve(path.dirname(mcpBin), ".."), "run", "mcp", "broker-v1.json");
    return { command: mcpBin, args: ["--descriptor", descriptor], env: {} };
  }
  return {
    command: node,
    args: [`--max-old-space-size=${MCP_BRIDGE_MAX_OLD_SPACE_MB}`, mcpBin, "mcp"],
    env: {},
  };
}

export function removeStableMcpLauncher(homeDir = os.homedir()) {
  const launcherPath = stableMcpLauncherPath(homeDir);
  try { fs.rmSync(launcherPath, { force: true }); } catch {}
  for (const platform of ["darwin", "win32"]) {
    try { fs.rmSync(stableNativeMcpBridgePath(homeDir, platform), { force: true }); } catch {}
  }
  try {
    for (const name of fs.readdirSync(path.dirname(launcherPath))) {
      if (/^mcp-bridge-[0-9a-f]{16}(?:\.exe)?$/.test(name)) {
        try { fs.rmSync(path.join(path.dirname(launcherPath), name), { force: true }); } catch {}
      }
    }
  } catch {}
  return launcherPath;
}

export { MCP_BRIDGE_MAX_OLD_SPACE_MB };
