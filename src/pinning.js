// Codex pinned-thread-ids writer. Ported faithfully from
// granular/tools/relay-companion/src/pinning.js (paths -> host-paths.js,
// writeJsonAtomic -> host-json.js). The open path pins the just-materialized
// Relay thread so Codex Desktop surfaces it; readPinnedThreadIds feeds the
// desktop refresh expression.

import fs from "node:fs";
import path from "node:path";
import { codexGlobalStatePath } from "./host-paths.js";
import { writeJsonAtomic } from "./host-json.js";

export function readPinnedThreadIds() {
  const filePath = codexGlobalStatePath();
  if (!fs.existsSync(filePath)) return [];
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(state["pinned-thread-ids"]) ? state["pinned-thread-ids"] : [];
}

export function writePinnedThreadIds(threadIds) {
  if (!Array.isArray(threadIds)) throw new TypeError("threadIds must be an array");
  const filePath = codexGlobalStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  state["pinned-thread-ids"] = Array.from(new Set(threadIds.filter(Boolean)));
  writeJsonAtomic(filePath, state);
  return state["pinned-thread-ids"];
}

export function applyPinnedThreadPlan({ pinThreadIds = [], unpinThreadIds = [] }) {
  const pinned = Array.from(new Set(pinThreadIds.filter(Boolean)));
  const unpinned = new Set(unpinThreadIds.filter(Boolean));
  const planned = new Set([...pinned, ...unpinned]);
  const preserved = readPinnedThreadIds().filter((threadId) => !planned.has(threadId));
  return writePinnedThreadIds([...pinned, ...preserved]);
}

export function setThreadPinned(threadId, pinned) {
  if (!threadId) throw new Error("threadId is required");
  return applyPinnedThreadPlan({
    pinThreadIds: pinned ? [threadId] : [],
    unpinThreadIds: pinned ? [] : [threadId],
  });
}
