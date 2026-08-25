import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveSafeAttachmentPreview } from "../src/safe-attachment-preview.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");

test("authorized canonical image is read through a bounded descriptor", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "image.png");
  await fs.writeFile(file, PNG);
  const result = await resolveSafeAttachmentPreview({ path: file, name: "image.png", size: PNG.length, sha256: PNG_SHA256 }, { allowedRoots: [root] });
  assert.deepEqual(result, {
    name: "image.png",
    mimeType: "image/png",
    size: PNG.length,
    dataBase64: PNG.toString("base64"),
  });
});

test("authorized canonical HTML is returned only after the same bounded digest verification", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-html-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = Buffer.from("<!doctype html><html><body><h1>Relay plan</h1></body></html>");
  const file = path.join(root, "plan.html");
  await fs.writeFile(file, body);
  const result = await resolveSafeAttachmentPreview({
    path: file,
    name: "plan.html",
    contentType: "text/html",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  }, { allowedRoots: [root] });
  assert.deepEqual(result, {
    name: "plan.html",
    mimeType: "text/html",
    size: body.length,
    html: body.toString(),
  });
});

test("preview fails closed for traversal, symlink escape, remote URLs, oversized files, and false extensions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-preview-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "relay-preview-out-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const secret = path.join(outside, "secret.png");
  await fs.writeFile(secret, PNG);
  const link = path.join(root, "escape.png");
  // Windows only lets an unprivileged process create symlinks with Developer Mode
  // on. Where it cannot be staged, say so and skip that one case rather than let a
  // failure to CREATE the attack look like the attack being refused. Every other
  // fail-closed path below still runs on this host.
  let staged = true;
  try {
    await fs.symlink(secret, link);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    staged = false;
    t.diagnostic("symlink escape not staged: this host forbids creating symlinks");
  }
  if (staged) {
    await assert.rejects(() => resolveSafeAttachmentPreview({ path: link, sha256: PNG_SHA256 }, { allowedRoots: [root] }), /outside/);
  }
  await assert.rejects(() => resolveSafeAttachmentPreview({ url: "https://127.0.0.1/image.png" }, { allowedRoots: [root] }), /Remote/);

  const big = path.join(root, "big.png");
  await fs.writeFile(big, Buffer.concat([PNG, Buffer.alloc(64)]));
  await assert.rejects(() => resolveSafeAttachmentPreview({ path: big, sha256: PNG_SHA256 }, { allowedRoots: [root], maxBytes: 16 }), /size/);

  const text = path.join(root, "fake.png");
  await fs.writeFile(text, "not an image");
  await assert.rejects(() => resolveSafeAttachmentPreview({ path: text, sha256: createHash("sha256").update("not an image").digest("hex") }, { allowedRoots: [root] }), /recognized image or HTML/);
});

test("preview rejects an inode swap before opening and never invokes an injected unbounded reader", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-preview-swap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "image.png");
  const replacement = path.join(root, "replacement.png");
  await fs.writeFile(file, PNG);
  await fs.writeFile(replacement, PNG);
  let replaced = false;
  await assert.rejects(() => resolveSafeAttachmentPreview({ path: file, sha256: PNG_SHA256 }, {
    allowedRoots: [root],
    stat: async (target) => {
      const before = await fs.stat(target);
      if (!replaced) {
        replaced = true;
        await fs.rename(replacement, target);
      }
      return before;
    },
    readFile: async () => { throw new Error("unbounded reader must never be used"); },
  }), /changed/);
});
