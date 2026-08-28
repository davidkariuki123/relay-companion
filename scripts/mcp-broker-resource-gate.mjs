#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureStableMcpLauncher, mcpLaunchCommand } from "../src/mcp-launcher.js";
import {
  brokerIdentity,
} from "../src/mcp-broker-state.js";

const MIB = 1024 * 1024;
const companionRoot = fileURLToPath(new URL("..", import.meta.url));
const companionBin = fileURLToPath(new URL("../bin/relay.js", import.meta.url));

function numericArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
}

function posixMemory(pids) {
  if (!pids.length) return new Map();
  const result = spawnSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "ps failed");
  const out = new Map();
  for (const line of String(result.stdout || "").trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) out.set(Number(match[1]), Number(match[2]) * 1024);
  }
  return out;
}

function windowsMemory(pids) {
  if (!pids.length) return new Map();
  const ids = pids.join(",");
  const script = `$ErrorActionPreference='Stop'; Get-Process -Id ${ids} | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "Get-Process failed");
  const parsed = JSON.parse(result.stdout || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(rows.map((row) => [Number(row.Id), Number(row.PrivateMemorySize64)]));
}

function brokerPids(domainId) {
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -like '*mcp-broker-entry.js*' -and $_.CommandLine -like '*--domain=${domainId}*' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(result.stderr || "broker process lookup failed");
    const parsed = JSON.parse(result.stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(Number);
  }
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "broker process lookup failed");
  return String(result.stdout || "").split("\n").flatMap((line) => {
    if (!line.includes("mcp-broker-entry.js") || !line.includes(`--domain=${domainId}`)) return [];
    const pid = Number(line.trim().match(/^(\d+)/)?.[1]);
    return pid ? [pid] : [];
  });
}

async function main() {
  const count = numericArgument("clients", 25);
  const enforce = process.argv.includes("--enforce");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mcp-resource-"));
  const configDir = path.join(root, ".relay");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    user: { id: "usr_resource_gate", email: "resource@example.test", accountKind: "human", isDeveloper: false },
    updateChannel: "stable",
  }));
  const env = {
    ...process.env,
    HOME: root,
    RELAY_CONFIG_DIR: configDir,
    RELAY_HOME: configDir,
    RELAY_COMPANION_HOME: configDir,
    RELAY_MCP_BROKER_IDLE_MS: "2000",
  };
  const nativeBridge = path.join(root, process.platform === "win32" ? "mcp-bridge.exe" : "mcp-bridge");
  const build = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", nativeBridge, "."], {
    cwd: path.join(companionRoot, "native-bridge"),
    env: { ...process.env, CGO_ENABLED: "0" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 5 * 60_000,
  });
  if (build.error || build.status !== 0) throw new Error(`native bridge build failed: ${build.error?.message || build.stderr || build.status}`);
  const launcher = ensureStableMcpLauncher({ targetBin: companionBin, homeDir: root, env, nativeBridge });
  const launch = mcpLaunchCommand({ mcpBin: launcher, node: process.execPath });
  const identity = brokerIdentity({ env, packageRoot: companionRoot });
  const sessions = [];
  const starts = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: index % 2 ? "claude-code" : "codex-mcp-client", version: "resource-gate" }, { capabilities: {} });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      sessions.push({ client, transport, stderr: () => stderr });
    }
    const connectSession = async ({ client, transport }, index) => {
      const started = performance.now();
      await client.connect(transport);
      process.stdout.write(`resource-gate: client ${index} initialized\n`);
      await client.listTools();
      process.stdout.write(`resource-gate: client ${index} listed tools\n`);
      starts.push(performance.now() - started);
    };
    // Start the broker through one real cold client, then exercise the remaining
    // twenty-four bridges concurrently. The gate is about steady 25-session
    // cost and concurrent isolation, not a synthetic 25-process election storm.
    try {
      await connectSession(sessions[0], 0);
      await Promise.all(sessions.slice(1).map((session, index) => connectSession(session, index + 1)));
    } catch (error) {
      let brokerLog = "";
      try { brokerLog = fs.readFileSync(path.join(configDir, "logs", "broker.log"), "utf8"); } catch {}
      const bridgeErrors = sessions
        .map(({ stderr }, index) => ({ index, text: stderr().trim() }))
        .filter(({ text }) => text)
        .map(({ index, text }) => `bridge ${index}: ${text}`)
        .join("\n");
      throw new Error(`${error?.message || error}${bridgeErrors ? `\n${bridgeErrors}` : ""}${brokerLog ? `\nbroker log:\n${brokerLog}` : ""}`);
    }
    await delay(150);
    const bridgePids = sessions.map(({ transport }) => transport.pid).filter(Boolean);
    const brokers = brokerPids(identity.domainId);
    if (bridgePids.length !== count) throw new Error(`expected ${count} live bridges, found ${bridgePids.length}`);
    if (brokers.length !== 1) throw new Error(`expected one live broker, found ${brokers.length}`);
    const memory = process.platform === "win32"
      ? windowsMemory([...bridgePids, ...brokers])
      : posixMemory([...bridgePids, ...brokers]);
    const bridgeBytes = bridgePids.map((pid) => memory.get(pid) || 0);
    const brokerBytes = brokers.map((pid) => memory.get(pid) || 0);
    const totalBytes = [...bridgeBytes, ...brokerBytes].reduce((sum, value) => sum + value, 0);
    const result = {
      platform: process.platform,
      clients: count,
      relayProcessCount: bridgePids.length + brokers.length,
      brokerCount: brokers.length,
      memoryMetric: process.platform === "win32" ? "private-bytes" : "rss-bytes",
      totalMemoryBytes: totalBytes,
      totalMemoryMiB: Number((totalBytes / MIB).toFixed(1)),
      averageBridgeMemoryMiB: Number((bridgeBytes.reduce((sum, value) => sum + value, 0) / bridgeBytes.length / MIB).toFixed(1)),
      maxBridgeMemoryMiB: Number((Math.max(...bridgeBytes) / MIB).toFixed(1)),
      brokerMemoryMiB: Number((brokerBytes[0] / MIB).toFixed(1)),
      startupP95Ms: Number(percentile(starts, 0.95).toFixed(1)),
      startupMaxMs: Number(Math.max(...starts).toFixed(1)),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (enforce && process.platform === "win32") {
      const failures = [];
      if (totalBytes > 500 * MIB) failures.push(`total private memory ${result.totalMemoryMiB} MiB exceeds 500 MiB`);
      if (result.averageBridgeMemoryMiB > 15) failures.push(`average bridge private memory ${result.averageBridgeMemoryMiB} MiB exceeds 15 MiB`);
      if (result.startupP95Ms > 30_000) failures.push(`startup p95 ${result.startupP95Ms} ms exceeds 30000 ms`);
      if (failures.length) throw new Error(failures.join("; "));
    }
  } finally {
    await Promise.allSettled(sessions.map(({ client }) => client.close()));
    await delay(2250);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`mcp-broker-resource-gate: ${error.message}\n`);
  process.exit(1);
});
