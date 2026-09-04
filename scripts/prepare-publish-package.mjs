#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");

export function publishPackageJson(packageJson, { mode, version, runtimeDependencies } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) throw new Error("An exact publish version is required");
  if (!['bridge', 'thin'].includes(mode)) throw new Error("Distribution mode must be bridge or thin");
  const next = { ...packageJson, version };
  if (mode === "bridge") {
    next.relayDistribution = "bridge-runtime";
    next.bin = { relay: "bin/relay.js" };
    next.main = "bin/relay.js";
    next.dependencies = runtimeDependencies;
    next.files = ["bin", "bootstrap", "skill", "src", "overlay", "THIRD_PARTY_NOTICES.md", "licenses", "npm-shrinkwrap.json"];
    next.scripts = { mcp: "node src/mcp.js", daemon: "node src/task-daemon.js" };
  } else {
    next.relayDistribution = "thin-installer";
    next.bin = { relay: "bootstrap/relay-setup.cjs" };
    next.main = "bootstrap/relay-setup.cjs";
    next.dependencies = {};
    next.files = ["bootstrap", "skill"];
    next.scripts = {};
  }
  return next;
}

export function bridgeShrinkwrap(runtimeLock, { version, runtimeDependencies } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) throw new Error("An exact bridge version is required");
  if (runtimeLock?.lockfileVersion !== 3 || !runtimeLock?.packages?.[""]) {
    throw new Error("The committed runtime lock is not an npm v3 package lock");
  }
  if (JSON.stringify(runtimeLock.packages[""].dependencies) !== JSON.stringify(runtimeDependencies)) {
    throw new Error("The committed runtime lock does not match runtime-dependencies.json");
  }
  const shrinkwrap = structuredClone(runtimeLock);
  shrinkwrap.name = "relay-companion";
  shrinkwrap.version = version;
  shrinkwrap.packages[""] = {
    name: "relay-companion",
    version,
    dependencies: structuredClone(runtimeDependencies),
  };
  return shrinkwrap;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const runtimeDependencies = JSON.parse(fs.readFileSync(path.join(root, "runtime-dependencies.json"), "utf8"));
  const mode = option("--mode");
  const next = publishPackageJson(packageJson, { mode, version: option("--version"), runtimeDependencies });
  fs.writeFileSync(packagePath, `${JSON.stringify(next, null, 2)}\n`);
  const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
  if (mode === "bridge") {
    const runtimeLock = JSON.parse(fs.readFileSync(path.join(root, "runtime-lock", "package-lock.json"), "utf8"));
    const shrinkwrap = bridgeShrinkwrap(runtimeLock, { version: next.version, runtimeDependencies });
    fs.writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  } else {
    fs.rmSync(shrinkwrapPath, { force: true });
  }
  console.log(`Prepared ${next.name}@${next.version} as ${next.relayDistribution}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
