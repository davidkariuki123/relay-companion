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

test("no letter has a contents strip: a Task folds its agent document too", () => {
  // David, 2026-09-13: a Task reads exactly like a Relay — one page, Details
  // folded — so the "This Relay contains" folder is gone for every kind.
  assert.match(reader, /const twoFaces = false;/);
  assert.match(reader, /const onAgent = twoFaces && readerTab === "agent";/);
  assert.match(reader, /const documentList = "";/);
  assert.doesNotMatch(reader, /This Relay contains|Message for your agent<\/span>|relay-contents-row/);
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
  // A Task's ladder module sits where the claim slot used to, above the host rows.
  assert.match(reader, /#readerActions"\)\.innerHTML = `\$\{status\}\$\{bothNote\}[\s\S]*?<div class="reader-status-slot">\$\{taskModule\}<\/div>[\s\S]*?\$\{documentHostActions\}`/);
});
