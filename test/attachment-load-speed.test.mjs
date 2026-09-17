import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { stageSentRelayItem } from "../src/notifications.js";

const require = createRequire(import.meta.url);

function withRelayHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const relayHome = path.join(dir, "relay-home");
  fs.mkdirSync(relayHome, { recursive: true });
  const previous = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  return {
    relayHome,
    restore() {
      if (previous === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A slow file server that records how many downloads overlap.
function slowServer(body, delayMs) {
  let inFlight = 0;
  let peak = 0;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      res.end(body);
    }, delayMs);
  });
  return {
    server,
    stats: () => ({ peak, hits }),
    async start() { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; },
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}

test("one relay's files download side by side, and concurrent asks for the relay share one run", async () => {
  const home = withRelayHome("relay-att-speed-");
  const body = Buffer.from("photo bytes");
  const files = slowServer(body, 120);
  const base = await files.start();
  try {
    const { materializeAttachmentFiles } = await import(`../src/materializer.js?att-speed-${Date.now()}`);
    const mints = [];
    const mintUrl = async (relayId, attachmentId) => { mints.push(attachmentId); return `${base}/${attachmentId}`; };
    const row = {
      id: "relay_four_photos",
      attachments: [1, 2, 3, 4].map((n) => ({
        id: `att_${n}`, name: `photo-${n}.png`, bytes: body.length,
        openUrl: `https://web.example/api/relays/relay_four_photos/attachments/att_${n}/download`,
      })),
    };
    const started = Date.now();
    // Four tiles asking at once — exactly what the pill does for a 2x2 grid.
    const results = await Promise.all([1, 2, 3, 4].map(() => materializeAttachmentFiles(row, { mintUrl, refreshUrls: async () => null })));
    const elapsed = Date.now() - started;
    for (const result of results) {
      assert.equal(result.attachments.length, 4);
      for (const attachment of result.attachments) assert.ok(attachment.localPath, `${attachment.id} must land`);
    }
    assert.equal(mints.length, 4, "each file is minted once, however many tiles asked");
    assert.equal(files.stats().hits, 4, "each file is downloaded once");
    assert.ok(files.stats().peak >= 2, `downloads must overlap (peak ${files.stats().peak})`);
    assert.ok(elapsed < 4 * 120, `four 120ms downloads must not run in series (took ${elapsed}ms)`);
  } finally {
    await files.stop();
    home.restore();
  }
});

test("an expired signed URL on a staged row falls back to a fresh mint", async () => {
  const home = withRelayHome("relay-att-stale-");
  const body = Buffer.from("fresh again");
  const server = http.createServer((req, res) => {
    if (req.url.includes("stale")) { res.writeHead(403); res.end("expired"); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { materializeAttachmentFiles } = await import(`../src/materializer.js?att-stale-${Date.now()}`);
    let refreshed = 0;
    const row = await materializeAttachmentFiles(
      { id: "relay_stale", attachments: [{ id: "att_1", name: "a.png", bytes: body.length }], attachmentUrls: { att_1: `${base}/stale` } },
      { mintUrl: async () => `${base}/minted`, refreshUrls: async () => { refreshed += 1; return null; } },
    );
    assert.ok(row.attachments[0].localPath, "the minted URL must land the file");
    assert.equal(refreshed, 0, "no packet refresh is needed when the mint succeeds");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    home.restore();
  }
});

test("staging a sent item prefers its signed downloadUrl over the durable web route", () => {
  const home = withRelayHome("relay-att-stage-");
  try {
    const statePath = path.join(home.relayHome, "state.json");
    const staged = stageSentRelayItem({
      item: {
        relayId: "relay_signed", createdAt: new Date().toISOString(), kind: "message", preview: "hi",
        recipient: { name: "Sven" },
        attachments: [
          { id: "att_a", name: "a.png", contentType: "image/png", bytes: 3, openUrl: "https://web.example/api/relays/relay_signed/attachments/att_a/download", downloadUrl: "https://api.example/storage/signed-a" },
          { id: "att_b", name: "b.png", contentType: "image/png", bytes: 3, openUrl: "https://web.example/api/relays/relay_signed/attachments/att_b/download" },
        ],
      },
      sender: { name: "David" },
    }, { statePath });
    const row = JSON.parse(fs.readFileSync(statePath, "utf8")).packets[staged.itemId];
    assert.equal(row.attachmentUrls.att_a, "https://api.example/storage/signed-a");
    assert.equal(row.attachmentUrls.att_b, "https://web.example/api/relays/relay_signed/attachments/att_b/download");
  } finally {
    home.restore();
  }
});

test("an agent send files its own attachment bytes where the pill's chat reads them", async () => {
  const home = withRelayHome("relay-att-retain-");
  try {
    const { retainSentAttachmentsLocally } = await import(`../src/sent-attachment-retention.js?retain-${Date.now()}`);
    const body = Buffer.from("the sender's own photo");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const prepared = [{ id: "att_client", name: "photo.png", contentType: "image/png", bytes: body.length, sha256, contentBase64: body.toString("base64") }];
    const sent = { relayId: "relay_x", attachments: [{ id: "att_server_1", name: "photo.png", contentType: "image/png", bytes: body.length, sha256 }] };
    assert.equal(retainSentAttachmentsLocally(prepared, sent), 1);

    const { createOutgoingAttachmentCache } = require("../overlay/outgoing-attachment-cache.cjs");
    const attachmentsRoot = path.join(home.relayHome, "attachments");
    const cache = createOutgoingAttachmentCache({ attachmentsRoot, spoolRoot: path.join(home.relayHome, "outbox-files") });
    const hit = cache.resolveCanonical({ id: "att_server_1", sha256 });
    assert.ok(hit && hit.ok, "the pill resolves the server id to the retained bytes");
    assert.equal(fs.readFileSync(hit.target).toString(), body.toString());
    assert.equal(cache.resolveCanonical({ id: "att_server_1", sha256: "0".repeat(64) }), null, "a digest mismatch is never served");

    // A mismatched digest between request and reply is somebody else's file.
    const other = { relayId: "relay_y", attachments: [{ id: "att_server_2", name: "photo.png", bytes: body.length, sha256: "f".repeat(64) }] };
    assert.equal(retainSentAttachmentsLocally(prepared, other), 0);
  } finally {
    home.restore();
  }
});
