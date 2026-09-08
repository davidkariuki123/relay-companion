"use strict";

// Attachment markup is never inserted into the privileged viewer document.
// This policy is the FIRST parsed markup in an opaque-origin sandboxed frame;
// a sender's own meta policy can tighten it, but cannot relax it. srcdoc frames
// inherit both this CSP and the outer frame's sandbox, including no scripts.
const HTML_PREVIEW_POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src about: data:; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'";

function isHtmlPreviewable({ name = "", filename = "", contentType = "" } = {}) {
  return String(contentType).split(";", 1)[0].trim().toLowerCase() === "text/html"
    || /\.html?$/i.test(String(filename || name));
}

function htmlPreviewDocument(source) {
  // Do not search for <head>: one inside a comment/template could put the
  // protection after attacker-controlled resources or outside the real head.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}"><meta name="viewport" content="width=device-width,initial-scale=1">${String(source || "")}`;
}

async function htmlViewerContent(attachment, target, attachmentsRoot) {
  const { resolveSafeAttachmentPreview, SAFE_HTML_PREVIEW_MAX_BYTES } = await import("../src/safe-attachment-preview.js");
  const name = String(attachment.filename || attachment.name || "file");
  const size = Number(attachment.bytes ?? attachment.size) || 0;
  const base = { ok: true, name, contentType: String(attachment.contentType || ""), size };
  if (size > SAFE_HTML_PREVIEW_MAX_BYTES) {
    return { ...base, kind: "none", previewReason: "HTML preview is limited to 10 MB" };
  }
  try {
    const preview = await resolveSafeAttachmentPreview({
      ...attachment, name, path: target, size,
    }, { allowedRoots: [attachmentsRoot] });
    if (preview.mimeType !== "text/html") throw new Error("The file does not contain recognized HTML.");
    return { ...base, kind: "html", html: htmlPreviewDocument(preview.html) };
  } catch (error) {
    return { ...base, kind: "none", previewReason: error.message || "HTML preview could not be verified safely" };
  }
}

module.exports = { HTML_PREVIEW_POLICY, isHtmlPreviewable, htmlPreviewDocument, htmlViewerContent };
