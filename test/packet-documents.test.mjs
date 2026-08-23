import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPacketDocumentReader } = require("../overlay/packet-documents.cjs");

test("owned-agent document replacements invalidate the content-path cache", () => {
  let content = { forHuman:"I'm on it", forAgent:"" };
  let reads = 0;
  const read = createPacketDocumentReader(() => {
    reads += 1;
    return JSON.stringify(content);
  });
  const packet = {
    contentPath:"/packets/relay_agent.json",
    updatedAt:"2026-08-23T17:20:50.000Z",
    forHuman:"I'm on it",
    forAgent:"",
  };

  assert.deepEqual(read(packet), content);
  assert.deepEqual(read(packet), content);
  assert.equal(reads, 1, "one generation is read once");

  content = { forHuman:"Codex checked the repository.", forAgent:"" };
  packet.updatedAt = "2026-08-23T17:21:05.000Z";
  packet.forHuman = content.forHuman;
  assert.deepEqual(read(packet), content);
  assert.equal(reads, 2, "progress on the same path is re-read");

  content = { forHuman:"The fix is ready.", forAgent:"Tests passed." };
  packet.updatedAt = "2026-08-23T17:23:46.000Z";
  packet.forHuman = content.forHuman;
  packet.forAgent = content.forAgent;
  assert.deepEqual(read(packet), content);
  assert.equal(reads, 3, "completion on the same path is re-read");
});

test("legacy staged rows still recover complete documents from packet files", () => {
  const read = createPacketDocumentReader(() => JSON.stringify({
    forHuman:"Complete human document",
    forAgent:"Complete agent document",
  }));
  assert.deepEqual(read({
    contentPath:"/packets/legacy.json",
    updatedAt:"2026-08-01T10:00:00.000Z",
    forHuman:"Short preview",
    forAgent:"",
  }), {
    forHuman:"Complete human document",
    forAgent:"Complete agent document",
  });
});
