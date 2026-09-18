import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/**
 * Relative times in the pill: a row's corner wears the bare clock ("2m"), a
 * receipt says it in words ("2m ago"), and both stay true while a quiet room
 * or an open letter sits on screen (David, 2026-09-17: "Seen by Shane · 2m"
 * eight minutes after the fact, because nothing had repainted).
 */

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function section(start, end) {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `section ${start.slice(0, 40)}`);
  return html.slice(i, j);
}

test("a receipt says how long ago in words, a corner keeps the bare clock", () => {
  const { timeAgo, timeAgoWords } = new Function(`
    ${section("  function timeAgo(iso) {", "  function formatChatTime(iso) {")}
    return { timeAgo, timeAgoWords };
  `)();
  const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  assert.equal(timeAgo(at(5)), "now");
  assert.equal(timeAgoWords(at(5)), "just now");
  assert.equal(timeAgo(at(125)), "2m");
  assert.equal(timeAgoWords(at(125)), "2m ago");
  assert.equal(timeAgoWords(at(3 * 3600 + 10)), "3h ago");
  assert.equal(timeAgoWords(at(2 * 86400 + 10)), "2d ago");
  assert.equal(timeAgoWords("not a date"), "");
  assert.match(html, /RelayReadReceipts\.forLatest\(m, msgs, timeAgoWords\)/);
});

test("the open room and the open letter repaint once a minute so their clocks stay true", () => {
  const tick = section("  const RELATIVE_TIME_TICK_MS = 60_000;", "  window.addEventListener(\"focus\", () => { refreshActiveCanonicalChat(); });");
  assert.match(tick, /setInterval\(\(\) => \{/);
  assert.match(tick, /if \(!rendererSurfaceActive\(\)\) return;/, "a hidden or folded pill does no work");
  assert.match(tick, /activeView === "threads" && threadEditTargets\.size === 0 && messageDeleteConfirmIds\.size === 0\) renderThreadDetail\(\)/, "never under an open edit or delete question");
  assert.match(tick, /activeView === "reader"\) renderReader\(\)/);
  assert.match(tick, /RELATIVE_TIME_TICK_MS\);/);
});
