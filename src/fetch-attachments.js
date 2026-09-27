import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { storeDir } from "./host-paths.js";

const MAX_BYTES = 200 * 1024 * 1024;

function failure(code) { return Object.assign(new Error(code), { code }); }

function safeName(name, index) {
  const leaf = String(name || "attachment").split(/[\\/]/).pop();
  return `${String(index + 1).padStart(3, "0")}-${leaf.replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "").slice(0, 150) || "attachment"}`;
}

/** Local MCP only: paths belong to this Companion's machine, never a cloud sandbox. */
export async function fetchAttachments(client, fileIds, { root = path.join(storeDir(), "attachments"), fetchImpl = fetch } = {}) {
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 100 || fileIds.some(id => typeof id !== "string" || !id.trim())) {
    throw failure("Provide between 1 and 100 attachment fileIds from a Relay read.");
  }
  const ids = [...new Set(fileIds)];
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // Shares the existing attachment cache's 30-day retention sweep.
  const directory = await fs.mkdtemp(path.join(root, "download-"));
  const results = new Array(ids.length);
  let next = 0;
  let reserved = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      const fileId = ids[index];
      let temporary;
      try {
        // Always reauthorize, including when an earlier call saved this file.
        let metadata = await client.fileDownload(fileId);
        const file = metadata.file;
        if (!file || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw failure("invalid_file_metadata");
        if (reserved + file.sizeBytes > MAX_BYTES) throw failure("download_limit_exceeded");
        reserved += file.sizeBytes;
        const localPath = path.join(directory, safeName(file.filename, index));
        temporary = `${localPath}.partial`;
        let completed = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!metadata.downloadUrl) throw failure("download_unavailable");
          const url = new URL(metadata.downloadUrl);
          if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
            throw failure("invalid_download_url");
          }
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
          if (!response.ok) {
            await response.body?.cancel();
            if (attempt === 0 && (response.status === 403 || response.status >= 500)) {
              metadata = await client.fileDownload(fileId);
              if (metadata.file?.sizeBytes !== file.sizeBytes || metadata.file?.sha256 !== file.sha256) throw failure("attachment_changed");
              continue;
            }
            throw failure(`download_http_${response.status}`);
          }
          if (!response.body) throw failure("empty_download_response");
          const hash = createHash("sha256");
          let bytes = 0;
          const handle = await fs.open(temporary, "wx", 0o600);
          try {
            for await (const chunk of response.body) {
              bytes += chunk.length;
              if (bytes > file.sizeBytes) throw failure("size_mismatch");
              hash.update(chunk);
              await handle.writeFile(chunk);
            }
          } finally { await handle.close(); }
          const sha256 = hash.digest("hex");
          if (bytes !== file.sizeBytes) throw failure("size_mismatch");
          if (file.sha256 && sha256 !== file.sha256.toLowerCase()) throw failure("checksum_mismatch");
          await fs.rename(temporary, localPath);
          results[index] = { fileId, name: file.filename, status: "downloaded", localPath, bytes, sha256,
            verification: file.sha256 ? "size_and_sha256" : "size_only_no_source_checksum" };
          completed = true;
          break;
        }
        if (!completed) throw failure("download_failed");
      } catch (error) {
        if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
        // Never echo fetch exceptions containing a bearer URL or upstream internals.
        const code = typeof error.code === "string" && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code
          : error.name === "TimeoutError" ? "download_timeout"
            : error.status === 403 ? "access_denied" : error.status === 404 ? "attachment_unavailable" : "download_failed";
        results[index] = { fileId, status: "failed", code,
          message: "The file was not saved. Check access or retry this file; other successful downloads remain available." };
      }
    }
  }));
  const downloaded = results.filter(file => file.status === "downloaded").length;
  return { directory, filesystem: "companion_host", downloaded, failed: results.length - downloaded, files: results,
    note: "These paths are on the computer running Relay Companion. A hosted agent needs a supported file-import bridge to read them. Downloading does not mean the file contents have been read." };
}
