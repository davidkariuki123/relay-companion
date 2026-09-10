"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWriteJsonSync } = require("../src/atomic-json.cjs");

// Keep the sender's bytes in the normal, retention-managed attachment store.
// Outbox retirement deletes the spool; an already open viewer must survive it.
// Keys are opaque ids, never paths supplied by a renderer.
function createOutgoingAttachmentCache({ attachmentsRoot, spoolRoot, log = () => {} }) {
  const directory = (key) => path.join(attachmentsRoot, `outgoing-${createHash("sha256").update(key).digest("hex")}`);
  const localKey = (id, index) => `outbox:${id}::file-${index}`;
  const canonicalKey = (id) => `attachment:${id}`;

  function containedFile(file, root) {
    try {
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(file);
      return realFile.startsWith(realRoot + path.sep) && fs.statSync(realFile).isFile() ? realFile : "";
    } catch { return ""; }
  }

  function retainFile(key, attachment, source) {
    if (read(key)) return;
    const from = containedFile(source, spoolRoot);
    if (!from) throw new Error("Outgoing attachment is outside the send spool or missing");
    const dir = directory(key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.realpathSync(dir).startsWith(fs.realpathSync(attachmentsRoot) + path.sep)) {
      throw new Error("Outgoing attachment cache is outside the attachment store");
    }
    // Retain an extension for Open in default app, without using a name as a path.
    const ext = /^\.[a-z0-9]{1,12}$/i.test(path.extname(attachment.name)) ? path.extname(attachment.name) : "";
    const target = path.join(dir, `content${ext}`);
    if (!fs.existsSync(target)) {
      try { fs.linkSync(from, target); }
      catch { fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL); }
    }
    const sha256 = attachment.sha256 || fileDigest(from);
    atomicWriteJsonSync(path.join(dir, "metadata.json"), {
      ...attachment, bytes: fs.statSync(from).size, sha256, file: path.basename(target),
    });
  }

  function fileDigest(file) {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      return hash.digest("hex");
    } finally { fs.closeSync(fd); }
  }

  function retain(entry, prepared = []) {
    for (const [index, file] of (entry.files || []).entries()) {
      try {
        const attachment = {
          id: `file-${index}`, name: String(file.name || "file"),
          bytes: Number(file.size) || 0, contentType: String(file.contentType || "application/octet-stream"),
        };
        retainFile(localKey(entry.id, index), attachment, file.spoolPath);
        const uploaded = prepared[index];
        if (uploaded?.id) {
          // Strip contentBase64: only metadata belongs in this index.
          retainFile(canonicalKey(uploaded.id), {
            ...attachment, id: uploaded.id, name: uploaded.name,
            bytes: uploaded.bytes, contentType: uploaded.contentType, sha256: uploaded.sha256,
          }, file.spoolPath);
        }
      } catch (error) { log("Could not retain outgoing attachment", error); }
    }
  }

  function read(key) {
    try {
      const dir = directory(key);
      const metadata = containedFile(path.join(dir, "metadata.json"), attachmentsRoot);
      if (!metadata) return null;
      const { file, ...attachment } = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (typeof file !== "string" || path.basename(file) !== file) return null;
      const target = containedFile(path.join(dir, file), dir);
      if (!target || !containedFile(target, attachmentsRoot)) return null;
      const now = new Date();
      fs.utimesSync(dir, now, now);
      return { ok: true, attachment, target, attachmentsRoot };
    } catch { return null; }
  }

  function resolveLocal(relayId, attachmentId, entries = []) {
    if (!relayId.startsWith("outbox:")) return null;
    if (!/^file-(0|[1-9]\d*)$/.test(attachmentId)) return { ok: false, error: "attachment not found" };
    const key = `${relayId}::${attachmentId}`;
    let result = read(key);
    if (!result) {
      const entry = entries.find((row) => String(row.id) === relayId.slice(7));
      if (entry) { retain(entry); result = read(key); }
    }
    return result || { ok: false, error: "Local attachment unavailable" };
  }

  function resolveCanonical(attachment) {
    if (!attachment?.id || !attachment.sha256) return null;
    const result = read(canonicalKey(attachment.id));
    return result?.attachment.sha256 === attachment.sha256 ? result : null;
  }

  return { retain, resolveLocal, resolveCanonical };
}

module.exports = { createOutgoingAttachmentCache };
