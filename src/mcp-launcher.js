import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ensureMcpBrokerProvisioned,
  MCP_BRIDGE_MAX_OLD_SPACE_MB,
} from "./mcp-broker-state.js";
import { claudeDesktopConfigDirs, claudeDesktopConfigPathIn } from "./desktop-hosts.js";

export const STABLE_MCP_LAUNCHER_ENV = "RELAY_STABLE_MCP_LAUNCHER";

// Both shapes a host config can legitimately hold: the stable `mcp-bridge` we
// install today, and the `mcp-bridge-<fingerprint>` name shipped by releases
// before the stable path existed. Every matcher here has to accept both for as
// long as an old registration can still be sitting in someone's config.
const MCP_BRIDGE_NAME = /^mcp-bridge(?:-[0-9a-f]{16})?(?:\.exe)?$/i;
const FINGERPRINTED_MCP_BRIDGE_NAME = /^mcp-bridge-[0-9a-f]{16}(?:\.exe)?$/i;

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

/**
 * The hash of the binary currently sitting at the stable path.
 *
 * One name on both platforms — it is metadata, not an executable, and pairing
 * it with `mcp-bridge.exe` would only make the two harder to find together.
 */
export function nativeMcpBridgeFingerprintPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "bin", "mcp-bridge.sha256");
}

export function packagedNativeMcpBridgePath(packageRoot, platform = process.platform) {
  return path.join(packageRoot, "native", nativeMcpBridgeName(platform));
}

function bridgeBasename(command) {
  return String(command || "").trim().split(/[/\\]/).pop() || "";
}

function comparablePath(value, platform) {
  const resolved = path.resolve(String(value || ""));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Every `mcp-bridge*` command path a host config on this machine still names.
 *
 * Host apps read their MCP config once, at start, and keep it: Claude Desktop
 * will happily exec a path we deleted an hour ago and report "server
 * disconnected" until the user quits the app entirely. So a bridge file may only
 * be removed once nothing on disk points at it.
 *
 * A config we cannot read or cannot parse sets `all`, meaning "assume every
 * bridge is referenced". Reading an unreadable file as referencing NOTHING is
 * exactly the mistake that deletes a live registration's binary. Pure except for
 * the injectable `readFile`, so it is testable against a temp home.
 */
export function referencedMcpBridgePaths({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  readFile = (file) => fs.readFileSync(file, "utf8"),
} = {}) {
  const paths = new Set();
  let all = false;

  const add = (command) => {
    const value = String(command || "").trim();
    if (value && MCP_BRIDGE_NAME.test(bridgeBasename(value))) paths.add(value);
  };

  const read = (file) => {
    try {
      return readFile(file);
    } catch (error) {
      // A missing file is a real answer — that host is simply not installed.
      // Anything else (permissions, an unreadable mount) is unknown, not empty.
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      all = true;
      return null;
    }
  };

  const readJsonServers = (file) => {
    const text = read(file);
    if (text === null || text === undefined) return;
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      all = true;
      return;
    }
    const servers = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg.mcpServers : null;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
    for (const entry of Object.values(servers)) {
      if (entry && typeof entry === "object") add(entry.command);
    }
  };

  // `homeDir` is the authority for whose install we are pruning, so it wins over
  // an inherited HOME; an explicit CLAUDE_USER_DATA_DIR still takes precedence
  // inside claudeDesktopConfigDirs.
  for (const dir of claudeDesktopConfigDirs({ env: { ...env, HOME: homeDir }, platform })) {
    readJsonServers(claudeDesktopConfigPathIn(dir));
  }
  readJsonServers(env.CLAUDE_CODE_CONFIG || path.join(homeDir, ".claude.json"));

  // Codex holds `command` as a TOML string. Scanning for that key finds our
  // registration without dragging a TOML parser into the install path; matching
  // an unrelated host's `command` only ever keeps a file alive.
  const codexText = read(env.CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml"));
  if (codexText !== null && codexText !== undefined) {
    for (const [, basic, literal] of codexText.matchAll(/^[ \t]*command[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gm)) {
      if (literal !== undefined) {
        add(literal);
        continue;
      }
      // TOML basic-string escapes are a subset of JSON's, so JSON does the unescaping.
      try { add(JSON.parse(`"${basic}"`)); } catch { add(basic); }
    }
  }

  return { paths: [...paths], all };
}

/**
 * Drop fingerprinted bridges left by older releases, but only the ones nothing
 * points at. The stable name is never a candidate — it is the path every fresh
 * registration carries.
 */
// How long a fingerprinted bridge outlives its last config reference. A host
// app reads its config once at launch and keeps it: the day a registration
// moves to the stable name, the app that is still open holds the old path, and
// the daemon's next registration pass would otherwise sweep that file while the
// app can still spawn it. Two weeks comfortably outlasts any app session.
export const MCP_BRIDGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function pruneUnreferencedMcpBridges({ binDir, registered, homeDir, env, platform, retainRecentMs = MCP_BRIDGE_RETENTION_MS, now = Date.now() }) {
  let referenced;
  try {
    referenced = referencedMcpBridgePaths({ homeDir, env, platform });
  } catch {
    return;
  }
  if (referenced.all) return;
  const keep = new Set(referenced.paths.map((value) => comparablePath(value, platform)));
  keep.add(comparablePath(registered, platform));
  let names = [];
  try { names = fs.readdirSync(binDir); } catch { return; }
  for (const name of names) {
    if (!FINGERPRINTED_MCP_BRIDGE_NAME.test(name)) continue;
    const file = path.join(binDir, name);
    if (keep.has(comparablePath(file, platform))) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < retainRecentMs) continue;
    } catch {
      continue;
    }
    try { fs.rmSync(file, { force: true }); } catch {}
  }
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
  retainRecentMs = MCP_BRIDGE_RETENTION_MS,
  now = Date.now(),
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
    // The Go build embeds VCS metadata, so the bridge's hash changes on every
    // release. Registering that hash in the filename meant each update handed
    // host apps a path the next update deleted — and Claude Desktop, which keeps
    // the config it read at launch, spawned the deleted path until the user
    // fully quit the app. The installed name is therefore constant, and the hash
    // lives beside it purely to decide whether a copy is needed.
    const fingerprint = createHash("sha256").update(fs.readFileSync(nativeSource)).digest("hex").slice(0, 16);
    const bridgePath = stableNativeMcpBridgePath(homeDir, platform);
    const binDir = path.dirname(bridgePath);
    const fingerprintPath = nativeMcpBridgeFingerprintPath(homeDir);
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });

    let installed = "";
    try { installed = fs.readFileSync(fingerprintPath, "utf8").trim(); } catch {}
    let registered = bridgePath;
    if (installed !== fingerprint || !fs.existsSync(bridgePath)) {
      const tmp = `${bridgePath}.${process.pid}.${Date.now()}.tmp`;
      fs.copyFileSync(nativeSource, tmp);
      try { fs.chmodSync(tmp, 0o700); } catch {}
      try {
        // Atomic: a host may be executing the old binary at this instant, and on
        // POSIX the rename swaps the name out from under it without disturbing
        // the running process.
        fs.renameSync(tmp, bridgePath);
        fs.writeFileSync(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 });
      } catch (error) {
        // Windows locks a running .exe, so the rename fails outright while a host
        // still has the bridge open. Register a fingerprinted copy for this run
        // instead and leave the old stable file in place — it is still the path
        // every existing config names, so nothing breaks; the next install, with
        // nothing holding the file, takes the stable name back.
        if (platform !== "win32" || !["EBUSY", "EPERM"].includes(error && error.code)) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
          throw error;
        }
        registered = stableNativeMcpBridgePath(homeDir, platform, fingerprint);
        if (fs.existsSync(registered)) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
        } else {
          fs.renameSync(tmp, registered);
          try { fs.chmodSync(registered, 0o700); } catch {}
        }
      }
    }
    pruneUnreferencedMcpBridges({ binDir, registered, homeDir, env, platform, retainRecentMs, now });
    return registered;
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
  if (MCP_BRIDGE_NAME.test(path.basename(mcpBin))) {
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
  try { fs.rmSync(nativeMcpBridgeFingerprintPath(homeDir), { force: true }); } catch {}
  try {
    for (const name of fs.readdirSync(path.dirname(launcherPath))) {
      if (FINGERPRINTED_MCP_BRIDGE_NAME.test(name)) {
        try { fs.rmSync(path.join(path.dirname(launcherPath), name), { force: true }); } catch {}
      }
    }
  } catch {}
  return launcherPath;
}

export { MCP_BRIDGE_MAX_OLD_SPACE_MB };
