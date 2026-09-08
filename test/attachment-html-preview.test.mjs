import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isHtmlPreviewable, htmlPreviewDocument, htmlViewerContent } = require("../overlay/attachment-html-preview.cjs");
const main = await fs.readFile(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("HTML routing recognizes MIME parameters, filename and extension case", () => {
  for (const metadata of [{ contentType: "TEXT/HTML; charset=utf-8" }, { name: "board.HTML" }, { filename: "board.htm" }]) {
    assert.equal(isHtmlPreviewable(metadata), true);
  }
  for (const name of ["board.html.exe", "board.pdf", "board.txt"]) assert.equal(isHtmlPreviewable({ name }), false);
  const route = main.slice(main.indexOf("async function attachmentViewerContent"), main.indexOf("async function revealRelayAttachment"));
  assert.ok(route.indexOf("isHtmlPreviewable") < route.indexOf("isTextPreviewable"));
  assert.match(route, /htmlViewerContent\(.*resolved\.target, resolved\.attachmentsRoot\)/);
});

test("the restrictive policy precedes even deceptive heads and markup remains inside srcdoc", () => {
  for (const html of ["<!-- <head> --><html><head></head><body>test</body></html>", "<template><head></head></template><img src='https://example.test'>", "<html><head><meta http-equiv='Content-Security-Policy' content=\"script-src *\"></head></html>"]) {
    const document = htmlPreviewDocument(html);
    assert.ok(document.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'));
    assert.ok(document.endsWith(html));
    assert.match(document, /script-src 'none'/);
    assert.match(document, /frame-src about: data:/);
    assert.match(document, /connect-src 'none'/);
  }
});

async function fixture(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-html-viewer-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "design.html");
  await fs.writeFile(target, body);
  const attachment = { name: "design.html", contentType: "text/html", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
  return { root, target, attachment };
}

test("a 2.3 MB design renders as HTML after bounded canonical verification, not source or none", async (t) => {
  const body = '<!doctype html><html><body><iframe srcdoc="&lt;h1&gt;Nested design&lt;/h1&gt;"></iframe><!--' + "x".repeat(2417800) + '--></body></html>';
  const { root, target, attachment } = await fixture(t, body);
  const result = await htmlViewerContent(attachment, target, root);
  assert.equal(result.kind, "html");
  assert.ok(result.html.endsWith(body));
  assert.equal(result.size, Buffer.byteLength(body));
  assert.equal(result.fileUrl, undefined, "HTML is never loaded from a privileged file origin");
});

test("oversized HTML explains its limit and retains download fallback", async () => {
  const result = await htmlViewerContent({ name: "large.html", bytes: 10 * 1024 * 1024 + 1 }, "/not/read", "/not/read");
  assert.equal(result.ok, true);
  assert.equal(result.kind, "none");
  assert.equal(result.previewReason, "HTML preview is limited to 10 MB");
});

test("missing or mismatched digest, wrong size, and escaped roots cannot render HTML", async (t) => {
  const { root, target, attachment } = await fixture(t, "<!doctype html><h1>Verified only</h1>");
  for (const metadata of [{ ...attachment, sha256: "" }, { ...attachment, sha256: "a".repeat(64) }, { ...attachment, bytes: attachment.bytes + 1 }]) {
    const result = await htmlViewerContent(metadata, target, root);
    assert.equal(result.kind, "none");
    assert.equal(result.html, undefined);
    assert.ok(result.previewReason);
  }
  assert.equal((await htmlViewerContent(attachment, target, path.join(root, "other"))).kind, "none");
});

test("non-HTML bytes with an HTML name are rejected, not run", async (t) => {
  const { root, target, attachment } = await fixture(t, "this is not HTML");
  assert.equal((await htmlViewerContent(attachment, target, root)).kind, "none");
});

test("only the top frame of a live viewer can use the privileged IPC bridge", () => {
  const start = main.indexOf("function viewerEntryForEvent(event)");
  const source = main.slice(start, main.indexOf("\n}", start) + 2);
  const frame = {};
  const sender = { mainFrame: frame };
  const entry = { win: { webContents: sender } };
  const lookup = new Function("liveAttachmentViewers", `${source}; return viewerEntryForEvent;`)(() => [entry]);
  assert.equal(lookup({ sender, senderFrame: frame }), entry);
  assert.equal(lookup({ sender, senderFrame: {} }), null);
  assert.equal(lookup({ sender }), null);
  assert.equal(lookup({ sender: { mainFrame: frame }, senderFrame: frame }), null);
});

test("data HTML navigation is confined to the named sandbox subtree", async () => {
  const marker = 'viewerWin.webContents.on("will-frame-navigate", (event) => {';
  const start = main.indexOf(marker) + marker.length;
  const body = main.slice(start, main.indexOf("\n  });", start));
  const top = { routingId: 1, processId: 1, parent: null };
  const html = { name: "vHtml", parent: top };
  const pdf = { name: "vPdf", parent: top };
  const guard = new Function("viewerWin", "entry", "viewerUrl", `return event => {${body}};`)({ webContents: { mainFrame: top } }, { allowedFiles: new Set(["file:///authorized.pdf"]) }, "file:///viewer.html");
  const blocked = (frame, url) => { let canceled = false; guard({ frame, url, preventDefault() { canceled = true; } }); return canceled; };
  assert.equal(blocked(html, "data:text/html;base64,PGgxPk9LPC9oMT4="), false);
  assert.equal(blocked({ parent: html }, "data:text/html,%3Ch1%3EOK%3C/h1%3E"), false);
  for (const frame of [top, pdf, { parent: pdf }, null]) assert.equal(blocked(frame, "data:text/html,unsafe"), true);
  for (const url of ["https://example.test/", "file:///secret", "javascript:alert(1)", "data:image/svg+xml,test"]) assert.equal(blocked(html, url), true);
  assert.equal(blocked(pdf, "file:///authorized.pdf#toolbar=0"), false);
  const viewer = await fs.readFile(new URL("../overlay/viewer.html", import.meta.url), "utf8");
  assert.match(viewer, /id="vHtml" name="vHtml" sandbox=""/);
});
