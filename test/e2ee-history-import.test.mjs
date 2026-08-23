import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  e2eeHistoryImportCheckpointPath,
  importLegacyHistory,
  loadLegacyHistoryForImport,
  summarizeLegacyHistory,
} from "../src/e2ee-history-import.js";

test("history export pagination is bounded and rejects cursor loops", async () => {
  const pages = [
    { items: [{ sourceId: "one" }], nextCursor: "next" },
    { items: [{ sourceId: "two" }] },
  ];
  const client = { e2eeExportLegacyHistory: async () => pages.shift() };
  assert.deepEqual((await loadLegacyHistoryForImport(client)).map((item) => item.sourceId), ["one", "two"]);

  const looping = { e2eeExportLegacyHistory: async () => ({ items: [], nextCursor: "same" }) };
  await assert.rejects(loadLegacyHistoryForImport(looping), /repeated a history import cursor/i);
});

test("history importer is quiet, resumable, and keeps raw legacy ids out of its checkpoint", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-history-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpointOptions = { env: { RELAY_CONFIG_DIR: root }, homeDir: root };
  const sent = [];
  const client = {
    async sendRelay(payload) {
      sent.push(payload);
      return { relayId: `erelay_destination_${sent.length}` };
    },
  };
  const attachment = Buffer.from("private attachment", "utf8");
  const items = [
    {
      sourceId: "relay_legacy_secret_1",
      recipient: { relayUserId: "usr_david", name: "David" },
      kind: "task",
      title: "Earlier request",
      forHuman: "Please review the earlier document.",
      forAgent: "Review it carefully.",
      targetSurfaces: ["codex"],
      attachments: [{
        sourceAttachmentId: "att_old_1",
        name: "notes.txt",
        contentType: "text/plain",
        bytes: attachment.length,
        downloadUrl: "https://download.invalid/notes.txt",
      }],
      edited: true,
      deleted: false,
      taskState: "completed",
    },
    {
      sourceId: "relay_legacy_secret_2",
      recipient: { groupId: "grp_founders", name: "Founders" },
      kind: "message",
      forHuman: "Old group update.",
      forAgent: "",
      targetSurfaces: [],
      attachments: [],
      edited: false,
      deleted: true,
    },
  ];
  const fetchImpl = async () => new Response(attachment, { status: 200 });
  const first = await importLegacyHistory(client, items, {
    accountId: "usr_shane",
    maxItems: 1,
    checkpointOptions,
    fetchImpl,
  });
  assert.deepEqual({ imported: first.imported, remaining: first.remaining }, { imported: 1, remaining: 1 });
  assert.equal(sent[0].historyImport, true);
  assert.equal(sent[0].historyImportEdited, true);
  assert.equal(sent[0].historyImportTaskState, "completed");
  assert.equal(sent[0].attachments[0].contentBase64, attachment.toString("base64"));

  const second = await importLegacyHistory(client, items, {
    accountId: "usr_shane",
    checkpointOptions,
    fetchImpl,
  });
  assert.deepEqual(
    { imported: second.imported, alreadyImported: second.alreadyImported, remaining: second.remaining },
    { imported: 1, alreadyImported: 1, remaining: 0 },
  );
  assert.equal(sent[1].recipient.groupId, "grp_founders");
  assert.equal(sent[1].historyImportDeleted, true);

  const checkpoint = fs.readFileSync(e2eeHistoryImportCheckpointPath(checkpointOptions), "utf8");
  assert.equal(checkpoint.includes("relay_legacy_secret_1"), false);
  assert.equal(checkpoint.includes("relay_legacy_secret_2"), false);
});

test("history plan summarizes product state without message content", () => {
  assert.deepEqual(summarizeLegacyHistory([
    { recipient: { relayUserId: "usr_1" }, kind: "message", attachments: [{}, {}], edited: true },
    { recipient: { groupId: "grp_1" }, kind: "task", attachments: [], deleted: true },
  ]), {
    messages: 2,
    direct: 1,
    groups: 1,
    requests: 1,
    attachments: 2,
    edited: 1,
    deleted: 1,
  });
});
