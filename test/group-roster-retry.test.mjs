// A group room whose roster fetch fails must not re-render itself in a loop.
//
// Field report (Shane, Windows, 2026-09-11): clicking a photo in a group chat
// did nothing. The room render started loadGroups(); its completion re-rendered
// the room; the render started loadGroups() again. With the API unreachable that
// rewrote the whole history every round trip, and the pressed <img> was detached
// before the mouse button came up — Chromium then dispatches no click at all.
// (A protocol click, down and up within a millisecond, still worked, which is
// why no automated test had noticed.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// The roster loader and its retry gate, evaluated straight out of inbox.html
// with a controllable clock and bridge, so the timing rule is tested rather
// than described.
function rosterHarness({ groups }) {
  const declarations = between(html, "  let groupsList = [];", "  let cvgExpandedId = null;");
  const loader = between(html, "  // Resolves true when the roster arrived.", "  // ---- room-level group info");
  const calls = { groups: 0, renderGroups: 0, sync: 0 };
  const clock = { now: 1_000_000 };
  const env = new Function(
    "Date", "window", "cvgCall", "syncSlackChannelRows", "renderGroups",
    `"use strict"; ${declarations}\n${loader}\n` +
    "return { loadGroups, groupsLoadDue, state: () => ({ groupsLoaded, groupsLoading, groupsRetryAt, groupsList }), " +
    "setLoading: (value) => { groupsLoading = value; } };",
  )(
    { now: () => clock.now },
    { relay: { groups: async () => { calls.groups += 1; return groups(); } } },
    async (fn) => {
      let res = null;
      try { res = await fn(); } catch (e) { res = { ok: false, error: String(e && e.message) }; }
      return res && res.ok === true ? res.result : null;
    },
    () => { calls.sync += 1; },
    () => { calls.renderGroups += 1; },
  );
  return { ...env, calls, clock };
}

test("a failed roster fetch arms a retry delay instead of being due again at once", async () => {
  const h = rosterHarness({ groups: () => ({ ok: false, error: "fetch failed" }) });
  assert.equal(h.groupsLoadDue(), true, "a fresh room is due one fetch");
  assert.equal(await h.loadGroups(), false, "a failure resolves false so callers skip the repaint");
  assert.equal(h.state().groupsLoaded, false);
  assert.equal(h.groupsLoadDue(), false, "not due again right after a failure");
  assert.equal(h.calls.renderGroups, 0, "nothing arrived, nothing to paint");
  h.clock.now += 14_999;
  assert.equal(h.groupsLoadDue(), false, "still waiting inside the retry window");
  h.clock.now += 1;
  assert.equal(h.groupsLoadDue(), true, "due again once the window has passed");
});

test("a roster that arrives marks groups loaded, clears the delay, and is never refetched by a render", async () => {
  let attempts = 0;
  const h = rosterHarness({ groups: () => { attempts += 1; return attempts === 1 ? { ok: false, error: "fetch failed" } : { ok: true, result: [{ id: "g1", name: "granular" }] }; } });
  assert.equal(await h.loadGroups(), false);
  h.clock.now += 15_000;
  assert.equal(await h.loadGroups(), true, "the next attempt succeeds");
  assert.deepEqual(h.state().groupsList, [{ id: "g1", name: "granular" }]);
  assert.equal(h.state().groupsLoaded, true);
  assert.equal(h.state().groupsRetryAt, 0);
  assert.equal(h.calls.renderGroups, 1);
  assert.equal(h.groupsLoadDue(), false, "loaded rosters are not fetched again by a render");
});

test("an in-flight fetch is never duplicated", () => {
  const h = rosterHarness({ groups: () => ({ ok: true, result: [] }) });
  h.setLoading(Promise.resolve());
  assert.equal(h.groupsLoadDue(), false);
});

test("neither the chat list nor the room repaints itself after a failed roster fetch", () => {
  const room = between(html, "  function renderThreadDetail() {", "    const groupPostingState = groupRoomPostingState(chatRoom);");
  const chat = between(html, "  function renderChat() {", '    for (const el of chatListEl.querySelectorAll("[data-chat-open]")) {');
  for (const [label, source] of [["room", room], ["chat list", chat]]) {
    assert.match(source, /groupsLoadDue\(\)/, `${label}: the fetch is gated on the retry delay`);
    assert.doesNotMatch(source, /loadGroups\(\)\)\.finally\(/, `${label}: completion must not repaint unconditionally`);
    assert.match(source, /\.then\(\(loaded\) => loaded === true, \(\) => false\)/, `${label}: only a roster that arrived repaints`);
  }
  assert.match(room, /if \(loaded && activeView === "threads" && threadDetailId\) renderThreadDetail\(\);/);
  assert.match(chat, /if \(!loaded\) return;/);
  // The lazily loaded contact book follows the same rule: an empty book after
  // a failed fetch waits before the chat list asks for it again.
  assert.match(chat, /Date\.now\(\) >= \(renderChat\._retryAt \|\| 0\)/);
  assert.match(chat, /if \(!contactsList\.length\) \{ renderChat\._retryAt = Date\.now\(\) \+ GROUPS_RETRY_MS; return; \}/);
});
