import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { storeDir } from "./host-paths.js";
import { companionStatePath, updateStagedRelayAttachments } from "./notifications.js";
import atomicJson from "./atomic-json.cjs";
import { withJsonLockStrict } from "./state-lock.cjs";

export function inboxAccountScope(client) {
  return createHash("sha256").update(JSON.stringify([
    client.url, client.identity?.userId || client.token,
  ])).digest("hex");
}

export function readInboxJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function mutateQueue(file, scope, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const locked = withJsonLockStrict(file, () => {
    const saved = readInboxJson(file);
    const state = saved?.scope === scope ? saved : { scope, jobs: {} };
    if (mutate(state, saved) === false) return;
    atomicJson.atomicWriteJsonSync(file, state, { mode: 0o600 });
  });
  if (!locked.ok) throw new Error(`Attachment queue lock unavailable (${locked.reason})`);
}

export function inboxWorkPath() { return path.join(storeDir(), "inbox-attachment-work.json"); }

// Store only ids. Packets and signed URLs already live in the staged state.
export function queueInboxAttachments({ item, packet }, { scope, file = inboxWorkPath() }) {
  if (!packet?.attachments?.length) return;
  mutateQueue(file, scope, (state) => {
    if (state.jobs[item.relayId]) return false;
    state.jobs[item.relayId] = { attempts: 0, nextAttemptAt: 0 };
  });
}

// Runs in the daemon, never the receiver worker. A failed download remains due
// after restart. Network I/O happens outside the short cross-process queue lock.
export async function processInboxAttachments({
  scope, isCurrent = () => true, log = () => {}, file = inboxWorkPath(),
  statePath = companionStatePath(), now = Date.now,
  materialize = async (row) => {
    const { materializeAttachmentFiles } = await import("./materializer.js");
    return materializeAttachmentFiles(row, { log });
  },
} = {}) {
  const pending = readInboxJson(file);
  if (!pending || pending.scope !== scope || !isCurrent()) return;
  const jobs = Object.entries(pending.jobs || {}).filter(([, job]) => job.nextAttemptAt <= now()).slice(0, 20);
  for (const [id] of jobs) {
    if (!isCurrent()) return;
    let complete = false;
    try {
      const row = readInboxJson(statePath)?.packets?.[id];
      if (!row) complete = true; // deleted/reset while queued
      else {
        const result = await materialize({ ...row, id });
        if (!isCurrent()) return;
        const attachments = result.attachments || [];
        if (attachments.some((attachment) => attachment.localPath)) {
          updateStagedRelayAttachments(id, attachments, { statePath });
        }
        complete = attachments.length === (row.attachments || []).length
          && attachments.every((attachment) => attachment.localPath);
      }
    } catch (error) { log(`attachment prefetch failed for ${id}: ${error.message}`); }
    if (!isCurrent()) return;
    mutateQueue(file, scope, (state, saved) => {
      if (saved?.scope !== scope || !state.jobs[id] || !isCurrent()) return false;
      if (complete) delete state.jobs[id];
      else {
        const attempts = state.jobs[id].attempts + 1;
        state.jobs[id] = { attempts, nextAttemptAt: now() + Math.min(900_000, 5_000 * 2 ** Math.min(attempts, 8)) };
      }
    });
  }
}
