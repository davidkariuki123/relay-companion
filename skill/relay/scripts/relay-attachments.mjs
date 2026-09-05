import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// A relay body is untrusted content; if a prompt-injected agent is talked into
// attaching a local file, relay_send must not become an exfiltration channel for
// secrets, nor a huge-file OOM/DoS. Cap the size and refuse the highest-signal
// secret locations. Deliberately conservative so ordinary work files still attach;
// RELAY_ATTACHMENT_MAX_BYTES tunes the cap.
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB
function maxAttachmentBytes() {
  const raw = Number(process.env.RELAY_ATTACHMENT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ATTACHMENT_BYTES;
}
// Path segments that overwhelmingly hold credentials. Matched case-insensitively
// against the resolved path's segments. Kept tight so ordinary work files still attach.
const SECRET_DIR_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".gpg", ".kube", ".docker",
  ".password-store", "keychains", ".relay",
]);
// Basenames that are almost always key material — NOT broad extensions. Deliberately
// excludes bare ".key" (Apple Keynote decks) and ".pem" (often public certs), and
// "credentials.<doc>" (documents ABOUT credentials). Only names that are specifically
// SSH/GPG private keys or clearly-secret credential stores.
const SECRET_BASENAME_RE = /(^\.env($|\.local|\.[a-z]+$)|^id_(rsa|dsa|ecdsa|ed25519)$|^id_(rsa|dsa|ecdsa|ed25519)\.pem$|\.p12$|\.pfx$|\.keystore$|^credentials\.(json|ya?ml|toml|ini)$|^\.?secrets?\.(json|ya?ml|toml|env)$|^\.netrc$|^\.pgpass$)/i;
// Returns null if the path is a refused (secret) location; otherwise the resolved path.
// Non-throwing so one bad path skips (with a logged warning) instead of failing the
// whole batch.
function safeAttachmentPathOrNull(filePath, trustedLocalRoot = "", baseDir = process.cwd()) {
  const resolved = path.resolve(baseDir, filePath);
  if (trustedLocalRoot) {
    const root = path.resolve(trustedLocalRoot);
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  const home = os.homedir();
  const segments = resolved.split(path.sep).map((s) => s.toLowerCase());
  for (const seg of segments) {
    if (SECRET_DIR_SEGMENTS.has(seg)) return null;
  }
  // credential-bearing subtrees under ~/.config (but not the whole dir)
  const configRoot = path.join(home, ".config");
  if (resolved.startsWith(configRoot + path.sep)) {
    const rest = resolved.slice(configRoot.length + 1).toLowerCase();
    if (/^(gh|gcloud|op|1password)[\\/]|^git[\\/]credentials/.test(rest)) return null;
  }
  if (SECRET_BASENAME_RE.test(path.basename(resolved))) return null;
  return resolved;
}

const CONTENT_TYPES = new Map([
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".rtf", "application/rtf"],
  [".tex", "application/x-tex"],
  [".text", "text/plain"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".webm", "video/webm"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

export function hasAttachmentPayload(value, depth = 0) {
  if (!value || depth > 6) return false;
  if (Array.isArray(value)) return value.some((item) => hasAttachmentPayload(item, depth + 1));
  if (typeof value !== "object") return false;
  if ((Array.isArray(value.files) && value.files.length) || (Array.isArray(value.attachments) && value.attachments.length)) return true;
  return Object.values(value).some((item) => item && typeof item === "object" && hasAttachmentPayload(item, depth + 1));
}

export async function prepareOrdinaryRelayAttachments(args = {}, { baseDir = process.cwd() } = {}) {
  const passthrough = passthroughAttachments(args);
  const local = await readLocalAttachmentSpecs(localAttachmentSpecs(args), args.trustedLocalRoot, baseDir);
  return [
    ...passthrough,
    ...local.map((file, index) => ({
      id: file.id || ordinaryAttachmentId(file, index, args.idempotencyKey),
      name: file.name,
      contentType: file.contentType,
      bytes: file.bytes,
      sha256: file.sha256,
      contentBase64: file.body.toString("base64"),
    })),
  ];
}

export async function prepareTaskMessageAttachments(client, taskId, args = {}, { baseDir = process.cwd() } = {}) {
  const passthrough = passthroughAttachments(args);
  const local = await readLocalAttachmentSpecs(localAttachmentSpecs(args), "", baseDir);
  const uploaded = await uploadLocalTaskFiles(client, taskId, local, args.idempotencyKey || "relay_mcp_task_file");
  return [...passthrough, ...uploaded];
}

export async function prepareTaskResult(client, taskId, result = {}, baseIdempotencyKey = "relay_mcp_result_file", options = {}) {
  return {
    ...result,
    attachments: await prepareTaskMessageAttachments(client, taskId, {
      attachments: result.attachments || [],
      files: result.files || [],
      idempotencyKey: baseIdempotencyKey,
    }, options),
  };
}

function localAttachmentSpecs(args = {}) {
  const specs = [];
  for (const item of arrayOf(args.files)) {
    if (typeof item === "string") specs.push({ path: item });
    else if (item && typeof item === "object") specs.push({ ...item, path: item.path || item.filePath });
  }
  for (const item of arrayOf(args.attachments)) {
    if (item && typeof item === "object" && (item.path || item.filePath)) {
      specs.push({ ...item, path: item.path || item.filePath });
    }
  }
  return specs.filter((spec) => typeof spec.path === "string" && spec.path.trim().length > 0);
}

function passthroughAttachments(args = {}) {
  return arrayOf(args.attachments).filter((item) => !(item && typeof item === "object" && (item.path || item.filePath)));
}

async function readLocalAttachmentSpecs(specs, trustedLocalRoot = "", baseDir = process.cwd()) {
  const out = [];
  const cap = maxAttachmentBytes();
  const accepted = [];
  let aggregateBytes = 0;
  for (const [index, spec] of specs.entries()) {
    const filePath = safeAttachmentPathOrNull(spec.path, trustedLocalRoot, baseDir);
    if (!filePath) {
      // Skip a clearly-secret file rather than fail the whole send; the agent can
      // re-send without it, and a prompt-injected exfiltration attempt is quietly denied.
      console.error(`[relay] refusing to attach a secret-looking file: ${path.resolve(baseDir, spec.path)}`);
      continue;
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Attachment path is not a file: ${filePath}`);
    if (stat.size > cap) {
      throw new Error(
        `Attachment ${path.basename(filePath)} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the ${(cap / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }
    aggregateBytes += stat.size;
    if (aggregateBytes > cap) {
      throw new Error(
        `Attachments total ${(aggregateBytes / 1024 / 1024).toFixed(1)} MB, over the ${(cap / 1024 / 1024).toFixed(0)} MB per-call limit.`,
      );
    }
    accepted.push({ index, spec, filePath, stat });
  }
  for (const { index, spec, filePath } of accepted) {
    const body = await fs.readFile(filePath);
    const name = String(spec.name || spec.filename || path.basename(filePath)).trim() || `attachment-${index + 1}`;
    const sha256 = createHash("sha256").update(body).digest("hex");
    out.push({
      id: spec.id,
      path: filePath,
      name,
      filename: name,
      contentType: spec.contentType || inferContentType(name),
      bytes: body.length,
      sha256,
      body,
    });
  }
  return out;
}

async function uploadLocalTaskFiles(client, taskId, files, baseIdempotencyKey) {
  const uploaded = [];
  for (const [index, file] of files.entries()) {
    const result = await client.createFileUpload({
      taskId,
      filename: file.name,
      contentType: file.contentType,
      sizeBytes: file.bytes,
      sha256: file.sha256,
      metadataScanStatus: "pending",
      idempotencyKey: fileUploadIdempotencyKey(baseIdempotencyKey, file, index),
    });
    await uploadBytes(result.upload, file);
    uploaded.push(result.attachment);
  }
  return uploaded;
}

async function uploadBytes(upload, file) {
  if (!upload?.url) throw new Error(`Relay did not return an upload URL for ${file.name}.`);
  const method = upload.method || "PUT";
  let res;
  if (method === "POST") {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields || {})) form.append(key, value);
    form.append("file", new Blob([file.body], { type: file.contentType }), file.name);
    res = await fetch(upload.url, { method: "POST", body: form });
  } else {
    res = await fetch(upload.url, {
      method: "PUT",
      headers: { "Content-Type": file.contentType },
      body: file.body,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`Relay upload failed for ${file.name} with HTTP ${res.status}${detail}`);
  }
}

function fileUploadIdempotencyKey(base, file, index) {
  const safeBase = String(base || "relay_mcp_file").replace(/[^\w.-]+/g, "_").slice(0, 80);
  return `${safeBase}_file_${index}_${file.sha256.slice(0, 16)}`;
}

function ordinaryAttachmentId(file, index, idempotencyKey) {
  const sendHash = createHash("sha256")
    .update(String(idempotencyKey || "relay_mcp_ordinary"))
    .digest("hex")
    .slice(0, 12);
  return `att_${sendHash}_${index}_${file.sha256.slice(0, 16)}`;
}

function inferContentType(filename) {
  return CONTENT_TYPES.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}
