"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAC_HELPER_EXECUTABLES = [
  ["Electron Helper.app", "Electron Helper"],
  ["Electron Helper (GPU).app", "Electron Helper (GPU)"],
  ["Electron Helper (Plugin).app", "Electron Helper (Plugin)"],
  ["Electron Helper (Renderer).app", "Electron Helper (Renderer)"],
];

function platformName(value = process.platform) {
  return String(value).split("-")[0];
}

function pathsFor(platform) {
  return platformName(platform) === "win32" ? path.win32 : path.posix;
}

function runtimeExecutableInventory(packageRoot, {
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const name = platformName(platform);
  const api = pathsFor(name);
  const roots = [api.join(packageRoot, "node_modules", "electron"), api.join(api.dirname(packageRoot), "electron")];
  const mainRelative = name === "win32"
    ? api.join("dist", "electron.exe")
    : name === "darwin"
      ? api.join("dist", "Electron.app", "Contents", "MacOS", "Electron")
      : api.join("dist", "electron");
  const electronRoot = roots.find((root) => {
    try { return existsSync(api.join(root, mainRelative)); } catch { return false; }
  });
  if (!electronRoot) return { ok: false, reason: "candidate-electron-missing", paths: [] };

  const entries = [{ role: "electron", path: api.join(electronRoot, mainRelative) }];
  if (name === "darwin") {
    const frameworks = api.join(electronRoot, "dist", "Electron.app", "Contents", "Frameworks");
    for (const [app, executable] of MAC_HELPER_EXECUTABLES) {
      entries.push({ role: `helper:${executable}`, path: api.join(frameworks, app, "Contents", "MacOS", executable) });
    }
    entries.push({
      role: "helper:chrome_crashpad_handler",
      path: api.join(
        frameworks,
        "Electron Framework.framework",
        "Versions",
        "A",
        "Helpers",
        "chrome_crashpad_handler",
      ),
    });
  }
  return { ok: true, electronRoot, electronPath: entries[0].path, paths: entries };
}

function verifyRuntimeExecutables(packageRoot, {
  platform = process.platform,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  accessSync = fs.accessSync,
} = {}) {
  const name = platformName(platform);
  const inventory = runtimeExecutableInventory(packageRoot, { platform: name, existsSync });
  if (!inventory.ok) return inventory;
  for (const entry of inventory.paths) {
    try {
      if (!existsSync(entry.path)) return { ok: false, reason: "candidate-executable-missing", detail: entry.role };
      if (!statSync(entry.path).isFile()) return { ok: false, reason: "candidate-executable-invalid", detail: entry.role };
      if (name !== "win32") accessSync(entry.path, fs.constants.X_OK);
    } catch (error) {
      return {
        ok: false,
        reason: error?.code === "ENOENT" ? "candidate-executable-missing" : "candidate-not-executable",
        detail: entry.role,
      };
    }
  }
  return { ...inventory, ok: true };
}

/**
 * Restore execute metadata only for the CLI and the finite Electron process
 * inventory whose bytes were already authenticated by Relay's signed runtime
 * artifact. Archive extraction can lose mode bits without changing file bytes;
 * no discovered or caller-supplied path is ever chmodded here.
 */
function repairRuntimeExecutablePermissions(packageRoot, {
  platform = process.platform,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  accessSync = fs.accessSync,
  chmodSync = fs.chmodSync,
} = {}) {
  const name = platformName(platform);
  const inventory = runtimeExecutableInventory(packageRoot, { platform: name, existsSync });
  if (!inventory.ok) return inventory;
  if (name === "win32") return { ...inventory, ok: true, repaired: [] };

  const api = pathsFor(name);
  const entries = [
    { role: "relay-cli", path: api.join(packageRoot, "bin", "relay.js") },
    ...inventory.paths,
  ];
  const repaired = [];
  for (const entry of entries) {
    try {
      if (!existsSync(entry.path)) return { ok: false, reason: "candidate-executable-missing", detail: entry.role };
      if (!statSync(entry.path).isFile()) return { ok: false, reason: "candidate-executable-invalid", detail: entry.role };
      try {
        accessSync(entry.path, fs.constants.X_OK);
        continue;
      } catch {}
      chmodSync(entry.path, 0o700);
      accessSync(entry.path, fs.constants.X_OK);
      repaired.push(entry.role);
    } catch (error) {
      return {
        ok: false,
        reason: "candidate-executable-permission-repair-failed",
        detail: entry.role,
        error: error?.message || String(error),
      };
    }
  }
  return { ...inventory, ok: true, repaired };
}

module.exports = {
  MAC_HELPER_EXECUTABLES,
  repairRuntimeExecutablePermissions,
  runtimeExecutableInventory,
  verifyRuntimeExecutables,
};
