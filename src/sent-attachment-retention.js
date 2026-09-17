import path from "node:path";
import { createRequire } from "node:module";
import { storeDir } from "./host-paths.js";

const require = createRequire(import.meta.url);

/**
 * Keep the bytes of a just-sent relay's attachments in the companion's
 * attachment store, keyed by the server's attachment ids, so the pill can show
 * the sender's own photos without fetching them back from S3. `prepared` is the
 * request the client sent (with contentBase64); `sent` is the server's reply.
 * Never throws: a failure here only costs a later download.
 */
export function retainSentAttachmentsLocally(prepared, sent, { log = () => {} } = {}) {
  const request = Array.isArray(prepared) ? prepared : [];
  const response = Array.isArray(sent?.attachments) ? sent.attachments : [];
  if (!request.length || !response.length) return 0;
  let retained = 0;
  try {
    const { createOutgoingAttachmentCache } = require("../overlay/outgoing-attachment-cache.cjs");
    const attachmentsRoot = path.join(storeDir(), "attachments");
    const cache = createOutgoingAttachmentCache({ attachmentsRoot, spoolRoot: attachmentsRoot, log });
    for (const [index, uploaded] of response.entries()) {
      const local = request[index];
      const encoded = String(local?.contentBase64 || "");
      if (!uploaded?.id || !encoded) continue;
      // Same position, same content: the server echoes the request order and
      // sha256, so a mismatch means we are looking at somebody else's file.
      if (local.sha256 && uploaded.sha256 && local.sha256 !== uploaded.sha256) continue;
      const body = Buffer.from(encoded, "base64");
      if (Number(uploaded.bytes) && body.length !== Number(uploaded.bytes)) continue;
      if (cache.retainCanonicalBytes({ ...uploaded, sha256: uploaded.sha256 || local.sha256 }, body)) retained += 1;
    }
  } catch (error) {
    log(`sent attachment retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return retained;
}
