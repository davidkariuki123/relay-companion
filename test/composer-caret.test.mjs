import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const start = html.indexOf("  function composerNodeValue(");
const end = html.indexOf("  function composerSetCaretOffset(", start);
assert.ok(start >= 0 && end > start);
const helpers = Function("Node", "window", `${html.slice(start, end)}; return { composerValue, composerCaretOffset };`);
const text = (data) => ({ nodeType:3, data, childNodes:[] });
const element = (tagName, childNodes = [], token) => ({
  nodeType:1, tagName, childNodes,
  hasAttribute:name => name === "data-mention-token" && token !== undefined,
  getAttribute:() => token,
  contains(node) { return this === node || this.childNodes.some(child => child === node || child.contains?.(node)); },
});
const chip = (token, label) => element("SPAN", [text(label)], token);

function atCaret(field, anchorNode, anchorOffset) {
  const { composerValue, composerCaretOffset } = helpers(
    { TEXT_NODE:3, ELEMENT_NODE:1 },
    { getSelection:() => ({ rangeCount:1, anchorNode, anchorOffset }) },
  );
  const value = composerValue(field);
  const caret = composerCaretOffset(field);
  return { value, caret, before:value.slice(0, caret) };
}

test("second person picker sees @ after prose and a named mention chip", () => {
  const tail = text(" @Sha");
  const field = element("DIV", [text("All the prep has been done. "), chip("Sven_Wellmann", "@Sven Wellmann"), tail]);
  const result = atCaret(field, tail, tail.data.length);
  assert.equal(result.caret, result.value.length);
  assert.equal(result.before.match(/(^|\s)@([^\s@]*)$/)?.[2], "Sha");
});

test("third mention counts intervening text and uses token lengths, not displayed names", () => {
  const tail = text(" @ and later text");
  const field = element("DIV", [text("Ask "), chip("sven", "@Sven Wellmann"), text(" and "), chip("shane", "@Shane Acton"), tail]);
  assert.equal(atCaret(field, tail, 2).before, "Ask @sven and @shane @");
});

test("caret counts split text, nested formatting and line breaks", () => {
  const tail = text("@Sha");
  const field = element("DIV", [text("Pasted "), element("B", [text("context")]), element("BR"), tail]);
  assert.equal(atCaret(field, tail, 4).before, "Pasted context\n@Sha");
});

test("element-boundary and first-text caret positions stay accurate", () => {
  const first = text("Ask ");
  const field = element("DIV", [first, chip("sven", "@Sven Wellmann"), text(" @")]);
  assert.equal(atCaret(field, first, 2).before, "As");
  assert.equal(atCaret(field, field, 2).before, "Ask @sven");
});
