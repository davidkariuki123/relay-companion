import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import { resolveSafeAttachmentPreview } from "../src/safe-attachment-preview.js";

const require = createRequire(import.meta.url);
const { createOutbox } = require("../src/outbox.cjs");
const { createOutgoingAttachmentCache } = require("../overlay/outgoing-attachment-cache.cjs");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const inbox = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const viewer = fs.readFileSync(new URL("../overlay/viewer-renderer.js", import.meta.url), "utf8");
const sourceBetween = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const chatAttachmentSource = new Function(`${sourceBetween(inbox, "  function chatAttachmentSource(", "  const CARGO_CHECK_SVG")} return chatAttachmentSource;`)();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");

function fixture(t, send = async () => ({ relayId: "relay_sent" })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-outgoing-viewer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { attachmentsRoot: path.join(root, "attachments"), spoolRoot: path.join(root, "outbox-files") };
  const queue = createOutbox({ file: path.join(root, "outbox.json"), send });
  t.after(() => queue.stop());
  const entry = queue.enqueue({
    idempotencyKey: "pill-reply-test", text: "", recipient: { email: "example@example.com" },
    files: [
      { name: "photo.png", contentType: "image/png", contentBase64: PNG.toString("base64") },
      { name: "second.png", contentType: "image/png", contentBase64: PNG.toString("base64") },
    ],
  });
  const cache = createOutgoingAttachmentCache(options);
  return { root, options, queue, entry, cache };
}

test("a first-click photo resolves from the local queue while send is still pending", async (t) => {
  let finishSend;
  const pending = new Promise((resolve) => { finishSend = resolve; });
  const { queue, entry, cache } = fixture(t, () => pending);
  cache.retain(entry);
  const flushing = queue.flush();
  assert.equal(queue.list()[0].attempts, 1);
  const source = chatAttachmentSource({ outboxId: entry.id, relayId: "" }, [{ name: "photo.png" }]);
  const result = cache.resolveLocal(source.relayId, source.attachments[0].id, queue.list());
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(result.target), PNG);
  assert.equal(queue.list()[0].state, "queued", "preview does not need a send response or receipt");
  finishSend({ relayId: "relay_sent" });
  await flushing;
});

test("Sent uses the same local ids, and the whole collage survives retirement and restart", async (t) => {
  const { queue, entry, cache, options } = fixture(t);
  cache.retain(entry);
  await queue.flush();
  const source = chatAttachmentSource({ outboxId: entry.id, relayId: "relay_sent" }, [{}, {}]);
  assert.equal(source.relayId, `outbox:${entry.id}`);
  queue.retire(entry.id);
  assert.equal(fs.existsSync(entry.files[0].spoolPath), false);
  const restarted = createOutgoingAttachmentCache(options);
  for (const file of source.attachments) {
    const result = restarted.resolveLocal(source.relayId, file.id);
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(result.target), PNG);
  }
});

test("an older queued send without a cache can open and safely preview after restarting offline", async (t) => {
  const { queue, entry, cache } = fixture(t);
  const result = cache.resolveLocal(`outbox:${entry.id}`, "file-1", queue.list());
  assert.equal(result.ok, true);
  assert.equal(result.attachment.name, "second.png");
  assert.deepEqual(fs.readFileSync(result.target), PNG);
  const preview = await resolveSafeAttachmentPreview({ ...result.attachment, path: result.target }, { allowedRoots: [result.attachmentsRoot] });
  assert.equal(preview.mimeType, "image/png");
  assert.equal(preview.dataBase64, PNG.toString("base64"));
});

test("server attachment ids reuse the sender's bytes after reconciliation, with digest matching", (t) => {
  const { queue, entry, cache } = fixture(t);
  const attachment = { id: "att_server", name: "photo.png", contentType: "image/png", bytes: PNG.length,
    sha256: createHash("sha256").update(PNG).digest("hex"), contentBase64: PNG.toString("base64") };
  cache.retain(entry, [attachment]);
  queue.retire(entry.id);
  const result = cache.resolveCanonical(attachment);
  assert.deepEqual(fs.readFileSync(result.target), PNG);
  assert.equal(result.attachment.contentBase64, undefined);
  assert.equal(cache.resolveCanonical({ ...attachment, sha256: "different" }), null);
  assert.equal(cache.resolveCanonical({ ...attachment, sha256: undefined }), null);
  const canonical = chatAttachmentSource({ id: "relay_sent" }, [attachment]);
  assert.equal(canonical.relayId, "relay_sent");
  assert.equal(canonical.attachments[0].id, "att_server");
});

test("local ids cannot resolve arbitrary paths, missing files, or symlinks outside the spool", (t) => {
  const { root, entry, cache } = fixture(t);
  const outside = path.join(root, "private.txt");
  fs.writeFileSync(outside, "private");
  fs.rmSync(entry.files[0].spoolPath);
  fs.symlinkSync(outside, entry.files[0].spoolPath);
  assert.equal(cache.resolveLocal(`outbox:${entry.id}`, "file-0", [entry]).ok, false);
  assert.equal(cache.resolveLocal(`outbox:${entry.id}`, "../../private.txt", [entry]).ok, false);
  assert.equal(cache.resolveLocal("outbox:unknown", "file-0", [entry]).ok, false);
  assert.equal(cache.resolveLocal(`outbox:${entry.id}`, "file-500", [entry]).ok, false);
  assert.equal(cache.resolveLocal("relay_sent", "att_server", [entry]), null);
});

test("a cached file cannot be redirected outside the attachment store", (t) => {
  const { root, entry, cache } = fixture(t);
  cache.retain(entry);
  const result = cache.resolveLocal(`outbox:${entry.id}`, "file-0");
  const outside = path.join(root, "private.txt");
  fs.writeFileSync(outside, "private");
  fs.rmSync(result.target);
  fs.symlinkSync(outside, result.target);
  assert.equal(cache.resolveLocal(`outbox:${entry.id}`, "file-0").ok, false);
});

test("the detached window opens on the first click without resolving or downloading bytes", async () => {
  const viewers = new Map();
  const opened = [];
  let resolutions = 0;
  const context = vm.createContext({
    attachmentViewers: viewers,
    resolveRelayAttachment: () => { resolutions += 1; return new Promise(() => {}); },
    createAttachmentViewerWindow: (key) => {
      const entry = { ready: true, win: { isDestroyed: () => false } };
      viewers.set(key, entry);
      return entry;
    },
    sendAttachmentViewerPayload: () => {},
    showAttachmentViewer: (entry) => opened.push(entry.payload),
  });
  vm.runInContext(sourceBetween(main, "function safeAttachmentId(", "function attachmentViewerPosition("), context);
  vm.runInContext(sourceBetween(main, "async function openRelayAttachmentViewer(", "/** The bytes behind one item"), context);
  const items = [{ relayId: "outbox:send", attachmentId: "file-0", name: "photo.png", image: true },
    { relayId: "relay_sent", attachmentId: "att_1", name: "another.png", image: true }];
  for (const item of items) {
    const result = await context.openRelayAttachmentViewer(item.relayId, item.attachmentId, { chatKey: "room", items });
    assert.equal(result.ok, true);
  }
  assert.equal(resolutions, 0, "the viewer's item request, not opening the window, owns byte resolution");
  assert.equal(opened.length, 2);
  assert.equal(viewers.size, 1, "local and canonical photos share the chat's window");
  assert.equal(opened[1].index, 1);
});

test("the actual resolver returns local bytes before attempting server staging", async (t) => {
  const { queue, entry, cache } = fixture(t);
  const context = vm.createContext({
    outgoingAttachmentCache: cache, outbox: queue,
    readStore: () => { throw new Error("must not read or fetch a server packet for an outgoing local photo"); },
  });
  vm.runInContext(sourceBetween(main, "async function resolveRelayAttachment(", "async function openRelayAttachment("), context);
  const result = await context.resolveRelayAttachment(`outbox:${entry.id}`, "file-0");
  assert.deepEqual(fs.readFileSync(result.target), PNG);
});

test("the image viewer shows loading immediately and ignores a stale failed load", async () => {
  let loaded;
  let failed;
  let visible;
  let failures = 0;
  const first = { name: "first.png" };
  const second = { name: "second.png" };
  let item = first;
  const firstLoad = new Promise((_resolve, reject) => { failed = reject; });
  const secondLoad = new Promise((resolve) => { loaded = resolve; });
  const el = { message: {}, stage: {}, strip: {}, prev: {}, next: {}, image: { removeAttribute() { this.src = ""; } } };
  const context = vm.createContext({
    el, view: { index: 0, items: [second] }, current: () => item,
    showOnly: (...nodes) => { visible = nodes; }, paintHeader: () => {}, paintStrip: () => {},
    contentFor: (target) => target === first ? firstLoad : secondLoad,
    fail: () => { failures += 1; },
  });
  vm.runInContext(sourceBetween(viewer, "  function paintImage()", "  function goTo("), context);
  context.paintImage();
  assert.equal(el.message.textContent, "Opening…");
  assert.ok(visible.includes(el.message));
  item = second;
  context.paintImage();
  loaded({ ok: true, fileUrl: "file:///retained/second.png" });
  await secondLoad;
  assert.equal(el.image.src, "file:///retained/second.png");
  assert.deepEqual(visible, [el.stage], "one photo has no empty filmstrip");
  failed(new Error("old download failed"));
  await firstLoad.catch(() => {});
  await Promise.resolve();
  assert.equal(failures, 0, "an old failure cannot cover the image selected more recently");
});
