import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("the card keeps a compositor-backed rounded clip during surface transitions", () => {
  assert.match(html, /\.card\s*\{[\s\S]*?overflow:visible;/);
  assert.match(html, /\.card-surface\s*\{[\s\S]*?border-radius:inherit;[\s\S]*?clip-path:inset\(0 round 16px\);/);
  assert.match(html, /\.card\.collapsed \.card-surface\s*\{\s*clip-path:inset\(0 round 22px\);\s*\}/);
  assert.match(html, /<div class="card" id="card">\s*<div class="card-surface">/);
});
