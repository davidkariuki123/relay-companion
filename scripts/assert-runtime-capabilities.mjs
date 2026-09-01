#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RUNTIME_CAPABILITIES = {
  exactSessionRouting: {
    "src/session-delivery.js": [
      "export function listRelayDestinations",
      "export async function deliverRelayToSession",
      "Codex accepted the request without appending the Relay turn",
      "Claude accepted the request without appending the Relay turn",
    ],
    "src/session-directory.js": ["export function discoverSessions"],
    "overlay/main.cjs": [
      "async function sessionPicker(",
      'ipcMain.handle("relay:sessionPicker"',
      'ipcMain.handle("relay:deliverToSession"',
    ],
    "overlay/preload.cjs": [
      'sessionPicker: (id, provider, source, surface) => ipcRenderer.invoke("relay:sessionPicker"',
      'deliverToSession: (id, selection) => ipcRenderer.invoke("relay:deliverToSession"',
    ],
    "overlay/inbox.html": [
      "function sessionPickerInlineHtml(",
      "Choose where this Relay lands",
      "window.relay.sessionPicker",
      "window.relay.deliverToSession",
    ],
  },
  taskCompletionWake: {
    "src/task-completion-wake.js": [
      "export function recordOutboundTaskOrigin",
      "export function queueTaskCompletionWake",
      "export async function processTaskCompletionWakes",
    ],
    "src/mcp.js": [
      'import { recordOutboundTaskOrigin } from "./task-completion-wake.js"',
      "recordTaskOrigin = recordOutboundTaskOrigin",
    ],
    "src/task-daemon.js": [
      "processTaskCompletionWakes as defaultProcessTaskCompletionWakes",
      "queueTaskCompletionWake as defaultQueueTaskCompletionWake",
    ],
  },
};

export function assertRuntimeCapabilities(packageRoot) {
  const root = path.resolve(String(packageRoot || ""));
  if (!root || !fs.existsSync(root)) throw new Error(`Runtime package root is missing: ${root}`);
  const verified = [];
  for (const [capability, files] of Object.entries(REQUIRED_RUNTIME_CAPABILITIES)) {
    for (const [relative, markers] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) throw new Error(`Runtime capability ${capability} is missing ${relative}`);
      const source = fs.readFileSync(absolute, "utf8");
      for (const marker of markers) {
        if (!source.includes(marker)) {
          throw new Error(`Runtime capability ${capability} is missing ${relative} marker: ${marker}`);
        }
      }
    }
    verified.push(capability);
  }
  return { ok: true, capabilities: verified };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = assertRuntimeCapabilities(option("--package-root"));
    console.log(`Verified Relay runtime capabilities: ${result.capabilities.join(", ")}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
