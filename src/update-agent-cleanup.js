import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalRuntimeLayout } from "./canonical-runtime.js";

export const MAC_UPDATE_AGENT_LABEL = "work.relay.companion.update";
export const MAC_UPDATE_AGENT_LABEL_PREFIX = `${MAC_UPDATE_AGENT_LABEL}.`;
export const ACTIVE_UPDATE_WORKER_ENV = "RELAY_CANONICAL_UPDATE_WORKER_ACTIVE";

function commandOk(result) {
  return Boolean(result && (result.ok === true || (!result.error && result.status === 0)));
}

function commandOutput(result) {
  return String(result?.stdout ?? result?.out ?? result?.stderr ?? "").trim();
}

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
}

export function updateAgentLabelsFromLaunchctl(output) {
  const labels = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const label = parts.length >= 3 ? parts[2] : "";
    if (label === MAC_UPDATE_AGENT_LABEL || label.startsWith(MAC_UPDATE_AGENT_LABEL_PREFIX)) labels.add(label);
  }
  return [...labels].sort();
}

function relayUpdatePlists({ homeDir, fsImpl, preserveCurrentWorker }) {
  const launchAgentsDir = path.posix.join(homeDir, "Library", "LaunchAgents");
  const runtimeDir = canonicalRuntimeLayout({ homeDir, platform: "darwin" }).root;
  const files = new Set([path.posix.join(launchAgentsDir, `${MAC_UPDATE_AGENT_LABEL}.plist`)]);
  if (!preserveCurrentWorker) files.add(path.posix.join(runtimeDir, "update-worker.plist"));

  for (const [directory, matches] of [
    [launchAgentsDir, (name) => name.startsWith(MAC_UPDATE_AGENT_LABEL_PREFIX) && name.endsWith(".plist")],
    [runtimeDir, (name) => name.startsWith("update-worker-") && name.endsWith(".plist")],
  ]) {
    try {
      for (const name of fsImpl.readdirSync(directory)) {
        if (matches(name)) files.add(path.posix.join(directory, name));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...files];
}

/**
 * Remove every launchd job and plist owned by Relay's retired update workers.
 * The one exception is the currently admitted canonical worker: repair-runtime
 * runs as its child, so booting out that fixed label mid-repair would kill the
 * transaction that is making the new runtime authoritative.
 */
export function cleanupMacUpdateAgents({
  platform = process.platform,
  homeDir = os.homedir(),
  userId = typeof process.getuid === "function" ? process.getuid() : 0,
  runCommand = defaultRun,
  fsImpl = fs,
  preserveCurrentWorker = process.env[ACTIVE_UPDATE_WORKER_ENV] === "1",
} = {}) {
  if (platform !== "darwin") return { ok: true, skipped: true, removedLabels: [], removedFiles: [], failures: [] };

  const failures = [];
  const listing = runCommand("/bin/launchctl", ["list"]);
  const listed = commandOk(listing);
  if (!listed) {
    failures.push({ kind: "enumerate", detail: commandOutput(listing) || "launchctl list failed" });
  }

  const listedLabels = new Set(updateAgentLabelsFromLaunchctl(commandOutput(listing)));
  const labels = new Set(listedLabels);
  if (!preserveCurrentWorker) labels.add(MAC_UPDATE_AGENT_LABEL);
  else labels.delete(MAC_UPDATE_AGENT_LABEL);
  const removedLabels = [];
  const domain = `gui/${userId}`;
  for (const label of [...labels].sort()) {
    runCommand("/bin/launchctl", ["bootout", `${domain}/${label}`]);
    runCommand("/bin/launchctl", ["remove", label]);
    const remaining = listedLabels.has(label)
      ? runCommand("/bin/launchctl", ["print", `${domain}/${label}`])
      : null;
    if (remaining && commandOk(remaining)) {
      failures.push({ kind: "label", label, detail: "launchd job is still loaded" });
    } else {
      removedLabels.push(label);
    }
  }

  const removedFiles = [];
  let files = [];
  try {
    files = relayUpdatePlists({ homeDir, fsImpl, preserveCurrentWorker });
  } catch (error) {
    failures.push({ kind: "enumerate-files", detail: error?.message || String(error) });
  }
  for (const file of files) {
    try {
      fsImpl.unlinkSync(file);
      removedFiles.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push({ kind: "file", file, detail: error?.message || String(error) });
    }
  }

  return { ok: failures.length === 0, removedLabels, removedFiles, failures, preserveCurrentWorker };
}

export function updateAgentCleanupDetail(result) {
  return (result?.failures || [])
    .map((failure) => failure.label || failure.file || failure.detail || failure.kind)
    .filter(Boolean)
    .join("; ");
}
