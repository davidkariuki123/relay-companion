import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const reader = html.slice(html.indexOf("function renderReader()"), html.indexOf("function todoWhyHtml("));
assert.ok(reader.length > 0, "renderReader is available");

// THE READER (Sven, 2026-09-08, the Minimal design): a letter is one page.
// "This Relay contains · Message for you · Message for your agent" was a
// folder with two faces; a person reads a letter, and its specifics fold
// under the words as Details. "I also love the details section instead of
// for you and for your agent. also details should start closed and open if
// clicked."

test("a letter has no contents strip; only a Task keeps its two faces", () => {
  assert.match(reader, /const twoFaces = request;/);
  assert.match(reader, /const onAgent = twoFaces && readerTab === "agent";/);
  assert.match(reader, /const documentList = twoFaces \? `/);
  // The Task folder is untouched: it still names both documents.
  assert.match(reader, /Message for you<\/span>/);
  assert.match(reader, /Message for your agent<\/span>/);
});

test("Details for your agent starts closed", () => {
  assert.match(reader, /const details = !twoFaces && agentText \? `/);
  assert.match(reader, /<span class="rd-details-name">Details for your agent<\/span>/);
  assert.match(reader, /· the specifics · your agent gets these too/);
  // Closed until this person opens it: the body renders only when the id is
  // in the set, and nothing puts an id there but a click.
  assert.match(reader, /const detailsOpen = readerDetailsOpen\.has\(String\(r\.id\)\);/);
  assert.match(reader, /\$\{detailsOpen \? `<div class="rd-details-body rd-agentcopy">\$\{readerParagraphs\(agentText\)\}<\/div>` : ""\}/);
  assert.match(html, /const readerDetailsOpen = new Set\(\);/);
  const writes = html.match(/readerDetailsOpen\.add\(/g) || [];
  assert.equal(writes.length, 1, "only the click opens Details");
});

test("a click toggles Details in place and the reader keeps its scroll", () => {
  assert.match(reader, /if \(readerDetailsOpen\.has\(id\)\) readerDetailsOpen\.delete\(id\); else readerDetailsOpen\.add\(id\);/);
  assert.match(reader, /const top = scrollEl \? scrollEl\.scrollTop : 0;\s*renderReader\(\);\s*if \(scrollEl\) scrollEl\.scrollTop = top;/);
  assert.match(reader, /aria-expanded="\$\{detailsOpen \? "true" : "false"\}"/);
});

test("Details sits under the words, before the verb and the reply", () => {
  const humanDoc = reader.slice(reader.indexOf("const humanDoc = `"), reader.indexOf("const doc = (onAgent ? agentDoc : humanDoc) + standaloneAttachments;"));
  assert.match(humanDoc, /<div class="rd-body">\$\{readerParagraphs\(r\.forHuman\)\}<\/div>\s*\$\{details\}/);
  assert.match(reader, /id="readerActions"[\s\S]*id="readerComposer"/, "the actions stay above the persistent composer");
  assert.match(reader, /#readerActions"\)\.innerHTML = `\$\{status\}\$\{bothNote\}\$\{claimControl\}\$\{documentHostActions\}`/);
});
