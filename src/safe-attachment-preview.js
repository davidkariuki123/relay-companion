import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BYTES = 10 * 1024 * 1024;

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function expectedDigest(value) {
  const source = String(value || "").trim();
  if (/^[a-f\d]{64}$/i.test(source)) return Buffer.from(source, "hex");
  try {
    const decoded = Buffer.from(source, "base64");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === source.replace(/=+$/, "")) return decoded;
  } catch {}
  return null;
}

async function readBounded(handle, maxBytes) {
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error("Attachment preview exceeds the size limit.");
  return bytes.subarray(0, offset);
}

async function snapshotDirectoryChain(root, filename, lstat) {
  const relative = path.relative(root, path.dirname(filename));
  const parts = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  const paths = [root];
  for (const part of parts) paths.push(path.join(paths.at(-1), part));
  const snapshots = [];
  for (const candidate of paths) {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Attachment directory hierarchy is not safe.");
    snapshots.push({ path: candidate, dev: info.dev, ino: info.ino, mode: info.mode });
  }
  return snapshots;
}

async function verifyDirectoryChain(snapshots, lstat) {
  for (const before of snapshots) {
    const after = await lstat(before.path);
    if (after.isSymbolicLink() || !after.isDirectory()
      || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode) {
      throw new Error("Attachment directory hierarchy changed before it could be read safely.");
    }
  }
}

/**
 * Resolve only an already-authorized canonical attachment.
 *
 * The file is validated and read through one descriptor. The pre-open inode is
 * compared with the opened inode, O_NOFOLLOW rejects a swapped final symlink,
 * and at most maxBytes + 1 bytes are ever read. Renderer input never supplies a
 * path to this function directly; callers must first resolve canonical state.
 */
export async function resolveSafeAttachmentPreview(attachment, {
  maxBytes = MAX_BYTES,
  allowedRoots = [],
  realpath = fsp.realpath,
  stat = fsp.stat,
  lstat = fsp.lstat,
  open = fsp.open,
} = {}) {
  if (!attachment?.path) {
    if (attachment?.url) throw new Error("Remote attachment preview is unavailable.");
    throw new Error("Attachment has no preview source.");
  }
  const canonicalDigest = expectedDigest(attachment.sha256);
  if (!canonicalDigest) throw new Error("Attachment cannot be read safely without its canonical SHA-256 digest.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Attachment preview size limit is invalid.");

  const resolved = await realpath(String(attachment.path));
  const roots = (await Promise.all((allowedRoots || []).map(async (root) => {
    try { return await realpath(String(root)); } catch { return ""; }
  }))).filter(Boolean);
  const authorizedRoot = roots
    .filter((root) => isInsideRoot(resolved, root))
    .sort((left, right) => right.length - left.length)[0];
  if (!authorizedRoot) throw new Error("Attachment path is outside the allowed store.");
  const directoryChain = await snapshotDirectoryChain(authorizedRoot, resolved, lstat);

  // Is this the same file on both sides of the open? The inode (on Windows, the
  // NTFS file index) is the identity that answers it, and it is stable on every
  // platform. `dev` is a corroborating check only where it is actually reported:
  // Windows fills it in from an OPEN HANDLE but returns 0 for a path-based stat, so
  // comparing the two straight across is guaranteed to differ and rejected every
  // attachment on Windows. Compare it only when both sides claim a volume; the path
  // has already been proven to realpath inside the authorized root either way.
  // No inode on either side means no proof of identity, so that fails closed rather
  // than letting two zeros compare equal.
  const sameFile = (a, b) =>
    Boolean(a.ino) && a.ino === b.ino && (!a.dev || !b.dev || a.dev === b.dev);

  // Keep this pre-open identity check: besides detecting swaps, it makes the
  // trust boundary testable without substituting an unbounded read primitive.
  const before = await stat(resolved);
  if (!before.isFile()) throw new Error("Attachment is not a regular file.");
  if (before.size > maxBytes) throw new Error("Attachment preview exceeds the size limit.");

  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW || 0;
    handle = await open(resolved, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const wrapped = new Error("Attachment changed or became an unsafe symlink before it could be opened.");
    wrapped.cause = error;
    throw wrapped;
  }

  try {
    const opened = await handle.stat();
    await verifyDirectoryChain(directoryChain, lstat);
    const reopenedPath = await realpath(resolved);
    if (!isInsideRoot(reopenedPath, authorizedRoot)) throw new Error("Attachment path changed outside the allowed store.");
    if (!opened.isFile()) throw new Error("Attachment is not a regular file.");
    if (!sameFile(opened, before)) throw new Error("Attachment changed before it could be read safely.");
    if (opened.size > maxBytes) throw new Error("Attachment preview exceeds the size limit.");

    const bytes = await readBounded(handle, maxBytes);
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("Attachment changed while it was being read.");
    if (after.size > maxBytes || after.size !== opened.size) throw new Error("Attachment changed size while it was being read safely.");
    if (Number.isFinite(Number(attachment.size ?? attachment.bytes))
      && Number(attachment.size ?? attachment.bytes) !== bytes.length) {
      throw new Error("Attachment size does not match its canonical metadata.");
    }
    const actualDigest = createHash("sha256").update(bytes).digest();
    if (!timingSafeEqual(actualDigest, canonicalDigest)) {
      throw new Error("Attachment digest does not match its canonical metadata.");
    }

    const mimeType = imageMime(bytes);
    if (!mimeType) throw new Error("Only recognized image attachments can be previewed.");
    return {
      name: String(attachment.name || "Image"),
      mimeType,
      size: bytes.length,
      dataBase64: bytes.toString("base64"),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

export const SAFE_ATTACHMENT_MAX_BYTES = MAX_BYTES;
