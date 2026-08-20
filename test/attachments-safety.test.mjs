import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareOrdinaryRelayAttachments } from "../src/attachments.js";

function withTempFile(name, bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-att-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return Promise.resolve(fn(file, dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("legitimate work files attach (Keynote .key, .pem cert, credentials doc)", async () => {
  for (const name of ["quarterly-review.key", "server-cert.pem", "credentials.pdf", "notes.md"]) {
    await withTempFile(name, "hello", async (file) => {
      const out = await prepareOrdinaryRelayAttachments({ files: [file], idempotencyKey: "k" });
      assert.equal(out.length, 1, `${name} should attach`);
      assert.equal(out[0].name, name);
    });
  }
});

test("secret-looking files are skipped, not attached", async () => {
  for (const name of ["id_rsa", ".env", "credentials.json", ".netrc"]) {
    await withTempFile(name, "secret", async (file) => {
      const out = await prepareOrdinaryRelayAttachments({ files: [file], idempotencyKey: "k" });
      assert.equal(out.length, 0, `${name} should be refused`);
    });
  }
});

test("a secret file among legit ones skips only the secret (batch not failed)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-att-"));
  try {
    const good = path.join(dir, "deck.key");
    const bad = path.join(dir, "id_ed25519");
    fs.writeFileSync(good, "deck");
    fs.writeFileSync(bad, "key");
    const out = await prepareOrdinaryRelayAttachments({ files: [good, bad], idempotencyKey: "k" });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "deck.key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversize attachment is rejected by the cap", async () => {
  const prev = process.env.RELAY_ATTACHMENT_MAX_BYTES;
  process.env.RELAY_ATTACHMENT_MAX_BYTES = "8";
  try {
    await withTempFile("big.txt", "0123456789", async (file) => {
      await assert.rejects(
        () => prepareOrdinaryRelayAttachments({ files: [file], idempotencyKey: "k" }),
        /over the .* limit/i,
      );
    });
  } finally {
    if (prev === undefined) delete process.env.RELAY_ATTACHMENT_MAX_BYTES;
    else process.env.RELAY_ATTACHMENT_MAX_BYTES = prev;
  }
});
