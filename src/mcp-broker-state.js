import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { atomicWriteFileSync, atomicWriteJsonSync } = require("./atomic-json.cjs");
const { withJsonLockStrict } = require("./state-lock.cjs");

export const MCP_BROKER_PROTOCOL = 1;
export const MCP_BRIDGE_MAX_OLD_SPACE_MB = 32;
export const MCP_BROKER_MAX_OLD_SPACE_MB = 512;
export const MCP_BROKER_FRAME_MAX_BYTES = 160 * 1024 * 1024;
export const MCP_BROKER_IN_FLIGHT_MAX_BYTES = 192 * 1024 * 1024;
export const MCP_BROKER_HELLO_MAX_BYTES = 16 * 1024;
export const MCP_BROKER_HELLO_TIMEOUT_MS = 2_000;
export const MCP_BROKER_STARTUP_TIMEOUT_MS = 30_000;
export const MCP_BROKER_UPDATE_TIMEOUT_MS = 60_000;
export const MCP_BROKER_IDLE_TIMEOUT_MS = 30_000;

const DEFAULT_API_URL = "https://api.sendrelays.com";
const DESCRIPTOR_NAME = `broker-v${MCP_BROKER_PROTOCOL}.json`;
const CAPABILITY_NAME = `broker-v${MCP_BROKER_PROTOCOL}.key`;

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizedPath(value, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const resolved = pathApi.resolve(String(value || ""));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isMainModule(moduleUrl, argvEntry = process.argv[1], platform = process.platform) {
  if (!argvEntry) return false;
  const moduleFile = fileURLToPath(moduleUrl, { windows: platform === "win32" });
  return normalizedPath(moduleFile, platform) === normalizedPath(argvEntry, platform);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function relayConfigRoot(env = process.env, homeDir = os.homedir()) {
  if (env.RELAY_CONFIG) return path.dirname(path.resolve(env.RELAY_CONFIG));
  return path.resolve(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"));
}

export function effectiveApiBaseUrl(env = process.env, configRoot = relayConfigRoot(env)) {
  const configured = env.RELAY_API_URL || readJson(env.RELAY_CONFIG || path.join(configRoot, "config.json")).apiUrl || DEFAULT_API_URL;
  return String(configured).trim().replace(/\/+$/, "").toLowerCase();
}

export function packageRootForModule(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function brokerIdentity({
  env = process.env,
  packageRoot = packageRootForModule(),
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const configRoot = normalizedPath(relayConfigRoot(env, homeDir), platform);
  const apiBaseUrl = effectiveApiBaseUrl(env, configRoot);
  const explicitToken = String(env.RELAY_DEVICE_TOKEN || "");
  const credentialScope = explicitToken ? `pinned:${digest(explicitToken)}` : "config";
  const runtimeRoot = normalizedPath(packageRoot, platform);
  const configScopeId = digest(configRoot).slice(0, 32);
  const domainId = digest(JSON.stringify({
    protocol: MCP_BROKER_PROTOCOL,
    runtimeRoot,
    configRoot,
    apiBaseUrl,
    credentialScope,
  }));
  return { protocol: MCP_BROKER_PROTOCOL, runtimeRoot, configRoot, apiBaseUrl, credentialScope, configScopeId, domainId };
}

export function brokerRunDir({ env = process.env, identity = brokerIdentity({ env }), platform = process.platform } = {}) {
  const preferred = path.join(identity.configRoot, "run", "mcp");
  if (platform === "win32" || Buffer.byteLength(path.join(preferred, `b-v1-${identity.domainId.slice(0, 16)}.sock`)) < 100) {
    return preferred;
  }
  const userKey = typeof process.getuid === "function" ? String(process.getuid()) : digest(os.userInfo().username).slice(0, 12);
  return path.join("/tmp", `relay-mcp-${userKey}-${identity.configScopeId.slice(0, 12)}`);
}

export function brokerEndpoint({ env = process.env, identity = brokerIdentity({ env }), platform = process.platform } = {}) {
  if (platform === "win32") {
    const userHash = digest(`${os.userInfo().username}:${identity.configScopeId}`).slice(0, 16);
    return `\\\\.\\pipe\\relay-mcp-v${MCP_BROKER_PROTOCOL}-${userHash}-${identity.domainId.slice(0, 32)}`;
  }
  return path.join(brokerRunDir({ env, identity, platform }), `b-v${MCP_BROKER_PROTOCOL}-${identity.domainId.slice(0, 16)}.sock`);
}

export function brokerProvisioningPaths({ env = process.env, identity = brokerIdentity({ env }) } = {}) {
  const dir = path.join(identity.configRoot, "run", "mcp");
  return { dir, descriptor: path.join(dir, DESCRIPTOR_NAME), capability: path.join(dir, CAPABILITY_NAME) };
}

function assertProtectedFile(file, { bytes = null, platform = process.platform } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Relay MCP broker state is not a regular file: ${file}`);
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Relay MCP broker state has unsafe permissions: ${file}`);
  const body = fs.readFileSync(file);
  if (bytes !== null && body.length !== bytes) throw new Error(`Relay MCP broker state has an invalid length: ${file}`);
  return body;
}

export function protectWindowsCapability(file, { run = spawnSync } = {}) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const spawnOptions = {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    env: process.env,
  };
  const whoami = run(path.join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], spawnOptions);
  const sid = String(whoami?.stdout || "").match(/S-\d-(?:\d+-)+\d+/)?.[0];
  if (whoami?.error || whoami?.status !== 0 || !sid) {
    throw new Error(`Relay could not identify the current Windows account for its MCP capability ACL (${whoami?.error?.message || String(whoami?.stderr || "").trim() || "SID lookup failed"})`);
  }
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  const protectedAcl = run(icacls, [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`], spawnOptions);
  const verified = protectedAcl?.status === 0
    ? run(icacls, [file, "/verify"], spawnOptions)
    : protectedAcl;
  if (verified?.error || verified?.status !== 0) {
    throw new Error(`Relay could not protect its MCP capability with an owner-only Windows ACL (${verified?.error?.message || String(verified?.stderr || "").trim() || "icacls failed"})`);
  }
}

export function ensureMcpBrokerProvisioned({
  env = process.env,
  packageRoot = packageRootForModule(),
  brokerNode = process.execPath,
  platform = process.platform,
  windowsAclProtector = protectWindowsCapability,
} = {}) {
  const identity = brokerIdentity({ env, packageRoot, platform });
  const files = brokerProvisioningPaths({ env, identity });
  fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(files.dir, 0o700); } catch {}
  const locked = withJsonLockStrict(files.descriptor, () => {
    let capability = null;
    try { capability = assertProtectedFile(files.capability, { bytes: 32, platform }); } catch {}
    if (!capability) {
      capability = randomBytes(32);
      atomicWriteFileSync(files.capability, capability, { mode: 0o600 });
      try { fs.chmodSync(files.capability, 0o600); } catch {}
    }
    if (platform === "win32") {
      try {
        windowsAclProtector(files.capability);
      } catch (error) {
        try { fs.rmSync(files.capability, { force: true }); } catch {}
        throw error;
      }
    }
    atomicWriteJsonSync(files.descriptor, {
      protocol: MCP_BROKER_PROTOCOL,
      configScopeId: identity.configScopeId,
      domainId: identity.domainId,
      capabilityFile: CAPABILITY_NAME,
      endpoint: brokerEndpoint({ env, identity, platform }),
      brokerNode: path.resolve(brokerNode),
      brokerEntry: path.join(packageRoot, "src", "mcp-broker-entry.js"),
      ...(platform === "win32" ? { windowsAclProtected: true } : {}),
    }, { mode: 0o600 });
    try { fs.chmodSync(files.descriptor, 0o600); } catch {}
    if (platform === "win32") {
      try {
        windowsAclProtector(files.descriptor);
      } catch (error) {
        try { fs.rmSync(files.descriptor, { force: true }); } catch {}
        throw error;
      }
    }
    return { identity, files, capability };
  }, { timeoutMs: 10_000, staleMs: 30_000 });
  if (!locked.ok) throw new Error(`Relay could not provision its MCP broker state (${locked.reason}); run relay repair-installation.`);
  return locked.value;
}

export function readMcpBrokerProvisioning({
  env = process.env,
  packageRoot = packageRootForModule(),
  platform = process.platform,
} = {}) {
  const identity = brokerIdentity({ env, packageRoot, platform });
  const files = brokerProvisioningPaths({ env, identity });
  let descriptor;
  try {
    descriptor = JSON.parse(assertProtectedFile(files.descriptor, { platform }).toString("utf8"));
  } catch (error) {
    throw new Error(`Relay MCP broker state is missing or unsafe; run relay repair-installation (${error.message}).`);
  }
  if (
    Number(descriptor.protocol) !== MCP_BROKER_PROTOCOL ||
    descriptor.configScopeId !== identity.configScopeId ||
    descriptor.domainId !== identity.domainId ||
    descriptor.endpoint !== brokerEndpoint({ env, identity, platform })
  ) {
    throw new Error("Relay MCP broker state does not match this installation; run relay repair-installation.");
  }
  if (descriptor.capabilityFile !== CAPABILITY_NAME || (platform === "win32" && descriptor.windowsAclProtected !== true)) {
    throw new Error("Relay MCP broker state does not name a protected capability; run relay repair-installation.");
  }
  const capability = assertProtectedFile(files.capability, { bytes: 32, platform });
  return { identity, files, capability, endpoint: brokerEndpoint({ env, identity, platform }) };
}

export function removeMcpBrokerProvisioning({
  env = process.env,
  packageRoot = packageRootForModule(),
  platform = process.platform,
} = {}) {
  const identity = brokerIdentity({ env, packageRoot, platform });
  const files = brokerProvisioningPaths({ env, identity });
  const endpoint = brokerEndpoint({ env, identity, platform });
  if (platform !== "win32") {
    try { fs.rmSync(endpoint, { force: true }); } catch {}
  }
  for (const file of [files.descriptor, files.capability, `${files.descriptor}.lock`]) {
    try { fs.rmSync(file, { recursive: true, force: true }); } catch {}
  }
  return { identity, files, endpoint };
}

export function mcpBrokerLogPath(identity = brokerIdentity()) {
  return path.join(identity.configRoot, "logs", "broker.log");
}
