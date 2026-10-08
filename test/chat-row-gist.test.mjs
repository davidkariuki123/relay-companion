// A chat row's second line says what the newest message IS. A picture sent
// without words said "You:" and nothing (David, 2026-10-08), and a typed
// message with no title borrowed the stand-in title "Relay".
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const slice = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test("an attachment-only message lists as what it carries", () => {
  const context = vm.createContext({ mentionPreviewText: (text) => text });
  vm.runInContext([
    slice("  function attachmentIsImage(attachment) {", "  function attachmentPlates("),
    slice("  function isLegacyAttachmentPlaceholder(", "  function relayTextLike("),
    slice("  function attachmentListGist(", "  // map enums -> humane copy"),
    "this.gist = messageListGist; this.files = attachmentListGist;",
  ].join("\n"), context);
  const png = { filename: "IMG_2041.png", contentType: "image/png" };
  const pdf = { filename: "brief.pdf", contentType: "application/pdf" };
  assert.equal(context.gist({ textLike: true, title: "Relay", body: "", attachments: [png] }), "Photo");
  assert.equal(context.gist({ textLike: true, title: "Relay", body: "", attachments: [png, png] }), "2 photos");
  assert.equal(context.gist({ textLike: true, body: "", attachments: [pdf] }), "brief.pdf");
  assert.equal(context.gist({ textLike: true, body: "", attachments: [png, pdf, pdf] }), "3 files");
  assert.equal(context.gist({ textLike: true, body: "Sent IMG_2041.png", attachments: [png] }), "Photo", "old phones' generated body");
  assert.equal(context.gist({ textLike: true, title: "x", body: "look at this", attachments: [png] }), "look at this", "a caption wins");
  assert.equal(context.gist({ textLike: false, title: "Design contract", body: "" }), "Design contract", "a Relay keeps its title");
  assert.equal(context.gist({ textLike: true, title: "Relay", body: "" }), "Message", "never the stand-in title");
  assert.equal(context.files([]), "");
});

test("every chat list surface uses it", () => {
  assert.match(html, /const gist = relayListGist\(messageListGist\(row, identity\.groupId\), 90\);/);
  assert.match(html, /\$\{esc\(relayListGist\(messageListGist\(t\.latest\), 90\)\)\}/);
  assert.match(html, /const shown = text \|\| attachmentListGist\(/);
});

test("a row without a × ends its action on the same right edge as one with a chevron", () => {
  assert.match(html, /\.setup-nudge \.rat-summary \{ width:100%; margin:0; \}/);
  assert.match(html, /\.setup-nudge:has\(> \.rat-minimise\) \.rat-summary \{ padding-right:34px; \}/);
});
