import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notifyCodexDesktopThreads } from "./codex-desktop.js";
import { codexHome, storeDir } from "./host-paths.js";

const SESSION_META_READ_LIMIT = 256 * 1024;
const RELAY_CODEX_ORIGINATOR = "granular_relay_companion";

export function relayCodexProjectThreadIds(state, { relayRoot = path.join(os.homedir(), "Relay") } = {}) {
  const wanted = path.resolve(relayRoot);
  const ids = [];
  for (const row of Object.values(state?.packets || {})) {
    const threadId = String(row?.codexThreadId || "").trim();
    const cwd = String(row?.openCwd || "").trim();
    if (!threadId || !cwd) continue;
    if (path.resolve(cwd) !== wanted) continue;
    ids.push(threadId);
  }
  return Array.from(new Set(ids));
}

async function firstJsonLine(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.allocUnsafe(SESSION_META_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) return null;
    const line = buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8").trim();
    if (!line) return null;
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function codexSessionFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files;
}

export async function relayCodexSessionThreadIds({
  sessionsRoot = path.join(codexHome(), "sessions"),
  relayRoot = path.join(os.homedir(), "Relay"),
} = {}) {
  const wanted = path.resolve(relayRoot);
  const files = await codexSessionFiles(sessionsRoot);
  const ids = [];
  const concurrency = Math.min(16, Math.max(1, files.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < files.length) {
        const filePath = files[next++];
        const row = await firstJsonLine(filePath);
        if (row?.type !== "session_meta") continue;
        const meta = row.payload || {};
        if (String(meta.originator || "") !== RELAY_CODEX_ORIGINATOR) continue;
        const cwd = String(meta.cwd || "").trim();
        if (!cwd || path.resolve(cwd) !== wanted) continue;
        const threadId = String(meta.id || meta.session_id || "").trim();
        if (threadId) ids.push(threadId);
      }
    }),
  );
  return Array.from(new Set(ids));
}

export async function repairRelayCodexProjectAssignments({
  statePath = path.join(storeDir(), "state.json"),
  sessionsRoot = path.join(codexHome(), "sessions"),
  relayRoot = path.join(os.homedir(), "Relay"),
  notify = notifyCodexDesktopThreads,
  log = () => {},
} = {}) {
  let state = null;
  let stateUnavailable = false;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    stateUnavailable = true;
    if (error?.code !== "ENOENT") log(`Codex Relay project repair skipped: ${error?.message || error}`);
  }
  const packetIds = relayCodexProjectThreadIds(state, { relayRoot });
  const sessionIds = await relayCodexSessionThreadIds({ sessionsRoot, relayRoot });
  const threadIds = Array.from(new Set([...packetIds, ...sessionIds]));
  if (!threadIds.length) {
    return { attempted: false, reason: stateUnavailable ? "state-unavailable" : "no-relay-threads", threadIds: [] };
  }

  const workspaceRootsByThreadId = Object.fromEntries(threadIds.map((threadId) => [threadId, [relayRoot]]));
  const result = await notify({
    threadIds,
    workspaceRootsByThreadId,
    ensureWorkspaceRoot: relayRoot,
    openThreadId: null,
    assignmentOnly: true,
  });
  if (result?.ok) log(`Codex Relay project repaired for ${threadIds.length} existing task${threadIds.length === 1 ? "" : "s"}`);
  return { ...result, threadIds };
}

export function startRelayCodexProjectRepairLoop({
  repair = repairRelayCodexProjectAssignments,
  retryMs = 60_000,
  setTimeoutImpl = setTimeout,
  log = () => {},
} = {}) {
  let stopped = false;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    try {
      const result = await repair({ log });
      if (result?.ok || ["no-relay-threads", "not-darwin", "unsupported-platform"].includes(result?.reason)) return;
    } catch (error) {
      log(`Codex Relay project repair failed: ${error?.message || error}`);
    }
    if (stopped) return;
    timer = setTimeoutImpl(() => void run(), retryMs);
    timer?.unref?.();
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
