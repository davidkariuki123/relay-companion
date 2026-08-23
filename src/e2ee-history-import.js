import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import atomicJson from "./atomic-json.cjs";
import e2eeIdentity from "./e2ee-identity.cjs";

const { atomicWriteJsonSync } = atomicJson;
const { identityPath, readPairedIdentity } = e2eeIdentity;

const CHECKPOINT_VERSION = 1;
const MAX_EXPORT_PAGES = 10_000;

export function e2eeHistoryImportCheckpointPath(options = {}) {
  return path.join(path.dirname(identityPath(options)), "e2ee-history-import-checkpoint.json");
}

function newCheckpoint(accountId) {
  return {
    version: CHECKPOINT_VERSION,
    accountId,
    salt: randomBytes(32).toString("base64url"),
    entries: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function readCheckpoint(accountId, options = {}) {
  const filePath = e2eeHistoryImportCheckpointPath(options);
  if (!fs.existsSync(filePath)) return { filePath, checkpoint: newCheckpoint(accountId) };
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("The local E2EE history import checkpoint is unreadable. Move it aside and begin a new dry run.");
  }
  if (
    checkpoint?.version !== CHECKPOINT_VERSION ||
    checkpoint.accountId !== accountId ||
    typeof checkpoint.salt !== "string" ||
    !checkpoint.entries ||
    typeof checkpoint.entries !== "object"
  ) {
    throw new Error("The local E2EE history import checkpoint belongs to another account or format.");
  }
  return { filePath, checkpoint };
}

function writeCheckpoint(filePath, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  atomicWriteJsonSync(filePath, checkpoint, { mode: 0o600 });
}

function sourceKey(checkpoint, sourceId) {
  return createHash("sha256")
    .update("relay-e2ee-history-import-checkpoint-v1")
    .update(checkpoint.salt)
    .update(String(sourceId))
    .digest("base64url");
}

export async function loadLegacyHistoryForImport(client, { pageSize = 50 } = {}) {
  const items = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
    const response = await client.e2eeExportLegacyHistory({
      ...(cursor ? { cursor } : {}),
      limit: pageSize,
    });
    if (!Array.isArray(response?.items)) throw new Error("Relay returned an invalid history import page.");
    items.push(...response.items);
    if (!response.nextCursor) return items;
    if (seenCursors.has(response.nextCursor)) throw new Error("Relay repeated a history import cursor.");
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("History import exceeded the bounded page limit.");
}

export function summarizeLegacyHistory(items) {
  return (items || []).reduce((summary, item) => {
    summary.messages += 1;
    if (item.recipient?.groupId) summary.groups += 1;
    else summary.direct += 1;
    if (item.kind === "task") summary.requests += 1;
    summary.attachments += Array.isArray(item.attachments) ? item.attachments.length : 0;
    if (item.edited) summary.edited += 1;
    if (item.deleted) summary.deleted += 1;
    return summary;
  }, { messages: 0, direct: 0, groups: 0, requests: 0, attachments: 0, edited: 0, deleted: 0 });
}

async function downloadAttachment(attachment, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(attachment.downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Attachment download failed with HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== Number(attachment.bytes)) {
    throw new Error(`Attachment ${attachment.name} did not match its legacy size.`);
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (attachment.sha256 && sha256 !== String(attachment.sha256).toLowerCase()) {
    throw new Error(`Attachment ${attachment.name} did not match its legacy SHA-256 hash.`);
  }
  return {
    name: attachment.name,
    contentType: attachment.contentType || "application/octet-stream",
    bytes: body.length,
    sha256,
    contentBase64: body.toString("base64"),
  };
}

function newIdempotencyKey() {
  return `history-import:${randomBytes(24).toString("base64url")}`;
}

export async function importLegacyHistory(client, items, {
  accountId,
  maxItems = Number.POSITIVE_INFINITY,
  checkpointOptions = {},
  fetchImpl = fetch,
  onProgress = () => {},
} = {}) {
  if (!accountId) throw new Error("History import requires the authenticated Relay account id.");
  const { filePath, checkpoint } = readCheckpoint(accountId, checkpointOptions);
  const result = { imported: 0, alreadyImported: 0, remaining: 0, checkpointPath: filePath };
  let attempted = 0;
  for (const [index, item] of (items || []).entries()) {
    const key = sourceKey(checkpoint, item.sourceId);
    const existing = checkpoint.entries[key];
    if (existing?.status === "completed") {
      result.alreadyImported += 1;
      continue;
    }
    if (attempted >= maxItems) {
      result.remaining += 1;
      continue;
    }
    attempted += 1;
    const entry = existing || {
      status: "pending",
      idempotencyKey: newIdempotencyKey(),
      createdAt: new Date().toISOString(),
    };
    checkpoint.entries[key] = entry;
    // Persist the random destination idempotency key before network I/O. If the
    // process dies after delivery, the next run recovers the exact E2EE outbox.
    writeCheckpoint(filePath, checkpoint);
    const attachments = [];
    for (const attachment of item.attachments || []) {
      attachments.push(await downloadAttachment(attachment, { fetchImpl }));
    }
    const sent = await client.sendRelay({
      recipient: item.recipient,
      kind: item.kind || "message",
      ...(item.title ? { title: item.title } : {}),
      forHuman: item.forHuman,
      forAgent: item.forAgent || "",
      ...(item.type ? { type: item.type } : {}),
      targetSurfaces: item.targetSurfaces || [],
      ...(item.source ? { source: item.source } : {}),
      attachments,
      idempotencyKey: entry.idempotencyKey,
      historyImport: true,
      historyImportEdited: item.edited === true,
      historyImportDeleted: item.deleted === true,
      ...(item.kind === "task" ? { historyImportTaskState: item.taskState || "requested" } : {}),
    });
    entry.status = "completed";
    entry.destinationId = sent.relayId;
    entry.completedAt = new Date().toISOString();
    writeCheckpoint(filePath, checkpoint);
    result.imported += 1;
    onProgress({ index: index + 1, total: items.length, destinationId: sent.relayId });
  }
  return result;
}

export async function prepareE2eeHistoryImport(client, options = {}) {
  const [me, status] = await Promise.all([client.me(), client.e2eeStatus()]);
  const identity = readPairedIdentity(options.checkpointOptions);
  if (!identity || identity.userId !== me.user?.id) {
    throw new Error("This machine does not hold the signed-in account's E2EE identity. Re-pair it before importing history.");
  }
  if (status.mode !== "required") {
    throw new Error("History import runs only against an E2EE-required Relay environment.");
  }
  const items = await loadLegacyHistoryForImport(client, options);
  return { me, status, items, summary: summarizeLegacyHistory(items) };
}
