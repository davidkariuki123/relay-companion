import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../overlay/chat-search.cjs");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

test("a query matches where words start, every word, any order", () => {
  assert.deepEqual(S.terms("  Shane   ACTON shane "), ["shane", "acton"]);
  assert.ok(S.matchText("Shane Acton", S.terms("acton sha")));
  assert.equal(S.matchText("Marsh Shane", S.terms("arsh")), null, "never the middle of a word");
  assert.equal(S.matchText("Shane Acton", S.terms("shane nel")), null, "every word must be found");
});

test("case, accents and curly quotes never stop a match, and hits map back to the original", () => {
  const text = "René O’Brien";
  const ranges = S.matchText(text, S.terms("rene o'b"));
  assert.deepEqual(ranges.map((r) => text.slice(r.start, r.end)), ["René", "O’B"]);
  assert.equal(S.highlight(text, ranges, esc), '<mark class="hit">René</mark> <mark class="hit">O’B</mark>rien');
});

test("a chat is found by its name or by the people in it, name first", () => {
  const terms = S.terms("shane");
  assert.equal(S.matchRoom("Shane Acton", [], terms).score, 0);
  const group = S.matchRoom("Granular", ["Shane Acton", "Andrew"], terms);
  assert.equal(group.score, 2);
  assert.deepEqual(group.members, [{ person: "Shane Acton", ranges: [{ start: 0, end: 5 }] }]);
  const both = S.matchRoom("Granular", ["Shane Acton"], S.terms("shane gran"));
  assert.deepEqual(both.nameRanges, [{ start: 0, end: 4 }]);
  assert.equal(S.matchRoom("Granular", ["Andrew"], terms), null);
});

test("a long message is cut around its hit on word boundaries", () => {
  const text = "We went through every option at length on the call yesterday and in the end agreed the pricing sheet needs the new tiers before Thursday.";
  const cut = S.snippet(text, S.matchText(text, S.terms("pricing")), 60);
  assert.ok(cut.text.startsWith("…") && cut.text.length <= 62, cut.text);
  const [hit] = cut.ranges;
  assert.equal(cut.text.slice(hit.start, hit.end), "pricing");
  assert.ok(!/^…\S*\s/.test(cut.text) || cut.text.includes(" "), "starts on a word");
  const short = S.snippet("The pricing sheet", S.matchText("The pricing sheet", ["pricing"]));
  assert.equal(short.text, "The pricing sheet");
});

test("highlighting escapes the words around a hit", () => {
  const text = "<b>Tom & Jerry</b>";
  assert.equal(S.highlight(text, S.matchText(text, ["jerry"]), esc), '&lt;b&gt;Tom &amp; <mark class="hit">Jerry</mark>&lt;/b&gt;');
});
