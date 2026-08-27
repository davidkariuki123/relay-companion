#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  canonicalRuntimeLayout,
  readCanonicalRuntime,
  verifyCanonicalCandidate,
} from "../src/canonical-runtime.js";

const {
  exactRuntimeHealth,
  installedServiceProcessRows,
} = createRequire(import.meta.url)("../bootstrap/runtime-health.cjs");

const MAC_SERVICE_LABELS = ["work.relay.companion.pill", "work.relay.companion"];
const LINUX_SERVICE_UNITS = ["work.relay.companion.pill.service", "work.relay.companion.service"];

function linuxCanaryPaths(homeDir, env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return {
    units: LINUX_SERVICE_UNITS.map((unit) => path.join(configHome, "systemd", "user", unit)),
    application: path.join(dataHome, "applications", "relay.desktop"),
    autostart: path.join(configHome, "autostart", "work.relay.companion.pill.desktop"),
    starter: path.join(homeDir, ".relay", "bin", "relay-pill-start"),
  };
}

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function commandOk(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function expectedVersionValue(version) {
  const expectedVersion = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error("Thin setup canary requires an exact version");
  return expectedVersion;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

export function verifyThinSetupCanary({
  version,
  homeDir = os.homedir(),
  platform = process.platform,
  healthCheck = exactRuntimeHealth,
  run = defaultRun,
} = {}) {
  const expectedVersion = expectedVersionValue(version);
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Thin setup canary runs only on an isolated macOS or Linux runner");
  }
  const layout = canonicalRuntimeLayout({ homeDir, platform });
  const runtime = readCanonicalRuntime({ homeDir, platform });
  if (!runtime || runtime.active !== true || runtime.state !== "active") {
    throw new Error("Thin setup did not commit an active canonical runtime");
  }
  if (runtime.version !== expectedVersion) {
    throw new Error(`Thin setup activated ${runtime.version || "unknown"}, expected ${expectedVersion}`);
  }
  const relativeRoot = path.relative(layout.releasesDir, runtime.packageRoot);
  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    throw new Error("Thin setup activated a package outside its isolated release directory");
  }
  const verified = verifyCanonicalCandidate(runtime.packageRoot, expectedVersion, { platform });
  if (!verified.ok) {
    throw new Error(`Thin setup target verification failed (${verified.reason}${verified.detail ? `: ${verified.detail}` : ""})`);
  }
  const health = healthCheck(runtime, { platform });
  if (!health?.ok) throw new Error(`Thin setup services failed exact-root health (${JSON.stringify(health)})`);
  if (platform === "darwin") {
    for (const label of MAC_SERVICE_LABELS) {
      const plist = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
      const contents = fs.readFileSync(plist, "utf8");
      if (!contents.includes(runtime.packageRoot)) throw new Error(`${label} does not name the active package root`);
    }
  } else {
    const linux = linuxCanaryPaths(homeDir);
    for (const unit of linux.units) {
      const contents = fs.readFileSync(unit, "utf8");
      if (!contents.includes(runtime.packageRoot)) throw new Error(`${path.basename(unit)} does not name the active package root`);
    }
    const daemonEnabled = run("systemctl", ["--user", "is-enabled", "--quiet", "work.relay.companion.service"]);
    if (!commandOk(daemonEnabled)) throw new Error("Thin setup did not enable the Relay daemon for the next login");
    for (const surface of [linux.application, linux.autostart, linux.starter]) {
      if (!fs.existsSync(surface)) throw new Error(`Thin setup did not install ${surface}`);
    }
  }
  return { runtime, verified, health };
}

export async function verifyThinSetupUninstalled({
  version,
  homeDir = os.homedir(),
  platform = process.platform,
  run = defaultRun,
  readRuntime = readCanonicalRuntime,
  processRows = installedServiceProcessRows,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  deadlineMs = 10_000,
  pollMs = 250,
} = {}) {
  const expectedVersion = expectedVersionValue(version);
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Thin setup cleanup canary runs only on an isolated macOS or Linux runner");
  }
  const runtime = readRuntime({ homeDir, platform });
  if (!runtime || runtime.active !== true || runtime.state !== "active") {
    throw new Error("Ordinary uninstall unexpectedly removed or invalidated the canonical runtime pointer");
  }
  if (runtime.version !== expectedVersion) {
    throw new Error(`Thin setup cleanup inspected ${runtime.version || "unknown"}, expected ${expectedVersion}`);
  }
  if (platform === "darwin") {
    for (const label of MAC_SERVICE_LABELS) {
      const plist = path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
      if (fs.existsSync(plist)) throw new Error(`Ordinary uninstall left ${label}.plist registered`);
    }
  } else {
    const linux = linuxCanaryPaths(homeDir);
    for (const file of [...linux.units, linux.application, linux.autostart, linux.starter]) {
      if (fs.existsSync(file)) throw new Error(`Ordinary uninstall left ${file} registered`);
    }
  }

  const domain = `gui/${uid}`;
  const deadline = now() + Math.max(0, Number(deadlineMs) || 0);
  while (true) {
    const loadedLabels = [];
    if (platform === "darwin") {
      // Prove the launchd domain itself is queryable before treating a failed
      // per-label lookup as absence. This keeps the cleanup check fail-closed.
      const domainResult = run("/bin/launchctl", ["print", domain]);
      if (!commandOk(domainResult)) {
        const detail = domainResult?.error?.message || String(domainResult?.stderr || domainResult?.stdout || "").trim();
        throw new Error(`Could not inspect the launchd user domain after uninstall${detail ? `: ${detail}` : ""}`);
      }
      for (const label of MAC_SERVICE_LABELS) {
        const result = run("/bin/launchctl", ["print", `${domain}/${label}`]);
        if (commandOk(result)) loadedLabels.push(label);
        else if (!result || result.error || !Number.isInteger(result.status)) {
          const detail = result?.error?.message || String(result?.stderr || result?.stdout || "").trim();
          throw new Error(`Could not inspect launchd label ${label} after uninstall${detail ? `: ${detail}` : ""}`);
        }
      }
    } else {
      const manager = run("systemctl", ["--user", "show-environment"]);
      if (!commandOk(manager)) {
        const detail = manager?.error?.message || String(manager?.stderr || manager?.stdout || "").trim();
        throw new Error(`Could not inspect the systemd user manager after uninstall${detail ? `: ${detail}` : ""}`);
      }
      for (const unit of LINUX_SERVICE_UNITS) {
        const result = run("systemctl", ["--user", "is-active", "--quiet", unit]);
        if (commandOk(result)) loadedLabels.push(unit);
        else if (!result || result.error || !Number.isInteger(result.status)) {
          const detail = result?.error?.message || String(result?.stderr || result?.stdout || "").trim();
          throw new Error(`Could not inspect systemd unit ${unit} after uninstall${detail ? `: ${detail}` : ""}`);
        }
      }
    }
    const processes = processRows(runtime, { run, includeTarget: true });
    if (!processes?.ok) {
      throw new Error(`Could not inspect installed Relay processes after uninstall (${processes?.reason || "unknown"}${processes?.detail ? `: ${processes.detail}` : ""})`);
    }
    if (!loadedLabels.length && processes.rows.length === 0) {
      return {
        runtime,
        stoppedLabels: platform === "darwin" ? [...MAC_SERVICE_LABELS] : [...LINUX_SERVICE_UNITS],
        processes: [],
      };
    }
    if (now() >= deadline) {
      const problems = [];
      if (loadedLabels.length) problems.push(`service registrations still active: ${loadedLabels.join(", ")}`);
      if (processes.rows.length) problems.push(`installed Relay service processes still running: ${processes.rows.map((row) => row.pid).join(", ")}`);
      throw new Error(`Ordinary uninstall did not quiesce Relay (${problems.join("; ")})`);
    }
    await sleep(Math.max(1, Number(pollMs) || 1));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--expect-uninstalled")) {
      const result = await verifyThinSetupUninstalled({ version: option("--version"), homeDir: option("--home") || os.homedir() });
      console.log(`Verified ordinary uninstall stopped both services for stock thin setup ${result.runtime.version}.`);
    } else {
      const result = verifyThinSetupCanary({ version: option("--version"), homeDir: option("--home") || os.homedir() });
      console.log(`Verified stock thin setup ${result.runtime.version} at ${result.runtime.packageRoot}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
