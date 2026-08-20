import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { RelayClient } from "../src/client.js";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("the companion carries reaction reads and explicit add/remove mutations end to end", () => {
  const client = new RelayClient({ url: "https://example.test", token: "t" });
  assert.equal(typeof client.reactions, "function");
  assert.equal(typeof client.react, "function");
  assert.match(preload, /react: \(id, emoji, action\) => ipcRenderer\.invoke\("relay:react"/);
  assert.match(main, /ipcMain\.handle\("relay:react"/);
  assert.match(main, /client\.react\(id, \{ emoji, action, idempotencyKey: crypto\.randomUUID\(\) \}\)/);
  assert.match(main, /client\.reactions\(clean\)/);
  assert.match(main, /reactionCache\.set/);
});

test("a failed reaction projection backs off without recursively rebuilding the overlay", () => {
  const refresh = between(main, "async function refreshReactions", "// ---- tasks (live)");
  const payload = between(main, "function buildPayload()", "// Pushes are serialized");

  assert.match(refresh, /if \(!force && now < reactionRetryAt\) return false/);
  assert.match(refresh, /reactionFetchFailures \+= 1/);
  assert.match(refresh, /REACTION_FETCH_RETRY_BASE_MS \* \(2 \*\*/);
  assert.match(refresh, /reactionRetryAt = reactionFetchedAt \+ retryDelay/);
  assert.match(refresh, /catch \(error\)[\s\S]*?return false/);
  assert.match(payload, /Date\.now\(\) >= reactionRetryAt/);
  assert.match(payload, /then\(\(refreshed\) => \{\s*if \(refreshed\) pushInbox\(false\)/);
  assert.doesNotMatch(payload, /refreshReactions\(reactionIds\)\.then\(\(\) => pushInbox\(false\)\)/);
});

test("successful reaction polls repaint only when reaction state actually changed", () => {
  const refresh = between(main, "async function refreshReactions", "// ---- tasks (live)");
  const push = between(main, "async function pushInboxNow", "function pushInboxQuiet");
  assert.match(refresh, /let changed = false/);
  assert.match(refresh, /reactionStateFingerprint\(reactionCache\.get\(id\)\)/);
  assert.match(refresh, /return changed/);
  assert.match(push, /reactionStateFingerprint\(r\.reactions\)/);
});

test("the picker unfurls five emoji plus the expansion set on a specific conversation bubble", () => {
  assert.ok(html.includes('const RX_PRIMARY = ["👍", "❤️", "😂", "🎉", "👀"]'));
  for (const token of ["rx-msg-picker", "rx-face", "rx-unfurl", "rx-more", "scaleX(.04)", "var(--spring)"]) {
    assert.ok(html.includes(token), token);
  }
  assert.match(html, /function messageReactionPickerHtml\(id\)/);
  assert.match(html, /title="React to this message" aria-label="React to this message"/);
  assert.match(html, /you reacted <span class="emoji">\$\{esc\(note\.emoji\)\}<\/span> — sent to the conversation/);
  assert.match(html, /data-rx-undo=/);
  assert.match(html, /commitReaction\(id, emoji, "remove"\)/);
});

test("the picker lifecycle dismisses on outside pointer, Escape, scroll, and replacement", () => {
  const source = between(html, "function dismissReactionPickers(", "function wireReactionControls(scope)");
  const listeners = new Map();
  const makeClasses = (...initial) => {
    const values = new Set(initial);
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  const makePicker = () => {
    const bar = { classList: makeClasses() };
    return {
      classList: makeClasses(),
      bar,
      querySelector: (selector) => selector === "[data-rx-bar]" ? bar : null,
    };
  };
  const one = makePicker();
  const two = makePicker();
  const root = {
    defaultView: {
      addEventListener(type, listener) {
        listeners.set(`window:${type}`, listener);
      },
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-rx-colo].open");
      return [one, two].filter((picker) => picker.classList.contains("open"));
    },
    addEventListener(type, listener, capture) {
      assert.equal(capture, true, `${type} is captured across nested room scrollers`);
      listeners.set(type, listener);
    },
  };
  const controls = Function(
    "document",
    `"use strict"; ${source}; return { dismissReactionPickers, openReactionPicker };`,
  )(root);

  controls.openReactionPicker(one);
  one.bar.classList.add("grid");
  controls.openReactionPicker(two);
  assert.equal(one.classList.contains("open"), false, "a second picker replaces the first");
  assert.equal(one.bar.classList.contains("grid"), false, "replacement also resets the expansion set");
  assert.equal(two.classList.contains("open"), true);

  listeners.get("pointerdown")({ target: { closest: () => two } });
  assert.equal(two.classList.contains("open"), true, "pointer/tap inside the picker keeps it open");
  two.bar.classList.add("grid");
  listeners.get("pointerdown")({ target: { closest: () => null } });
  assert.equal(two.classList.contains("open"), false, "pointer/tap anywhere outside closes it");
  assert.equal(two.bar.classList.contains("grid"), false);

  controls.openReactionPicker(two);
  listeners.get("keydown")({ key: "Enter" });
  assert.equal(two.classList.contains("open"), true, "unrelated keys do not close it");
  listeners.get("keydown")({ key: "Escape" });
  assert.equal(two.classList.contains("open"), false, "Escape closes it");

  controls.openReactionPicker(two);
  listeners.get("scroll")({});
  assert.equal(two.classList.contains("open"), false, "any captured scroll closes it");

  controls.openReactionPicker(two);
  listeners.get("window:blur")({});
  assert.equal(two.classList.contains("open"), false, "clicking into another desktop app closes it");
});

test("room and view transitions explicitly retire an open picker", () => {
  const openRoom = between(html, "function openThreadDetail(", "// ---------- Settings view ----------");
  const view = between(html, "function applyView()", "document.getElementById(\"chatExpandBtn\")");
  const tabs = between(html, "for (const tab of tabEls)", "function renderAll()");
  assert.match(openRoom, /dismissReactionPickers\(\);[\s\S]*?threadsSource = source/,
    "switching rooms closes the old room's picker even without a pointer event");
  assert.match(view, /if \(viewChanged\) dismissReactionPickers\(\)/,
    "programmatic view changes dismiss the picker");
  assert.match(tabs, /tab\.addEventListener\("click", \(\) => \{\s*\n\s*dismissReactionPickers\(\)/,
    "even a tab hop that keeps the room mounted dismisses the picker");
});

test("Request, reader and AI-runner surfaces never render a reaction trigger", () => {
  assert.match(html, /const REACTIONS_ENABLED = false;/, "reactions stay implemented but ship behind the reversible off switch");
  const reader = between(html, "function renderReader()", "// ---------- the requests board:");
  assert.doesNotMatch(reader, /messageReactionPickerHtml|data-rx-face|reactionConfirmationHtml|wireReactionControls/);

  const conversation = between(html, "const rowsHtml = timeline.map", "// Chat order: history above");
  assert.match(conversation, /\$\{!REACTIONS_ENABLED \|\| m\.request \? "" : messageReactionPickerHtml\(m\.id\)\}/);
  assert.match(conversation, /\$\{!REACTIONS_ENABLED \|\| m\.request \? "" : reactionConfirmationHtml\(m\.id\)\}/);
  assert.match(html, /for \(const event of \(!REACTIONS_ENABLED \|\| message\.request\) \? \[\] :/, "disabled and Request reactions do not enter the timeline");
  assert.match(conversation, /const aggregates = \(!REACTIONS_ENABLED \|\| m\.request\) \? \[\] :/, "disabled and Request bubbles do not show reaction badges");
  assert.match(conversation, /<span class="kchip">Request<\/span>/, "Request roots can remain visible as bubbles");

  const requests = between(html, "function renderRequestsBoard()", "function wireRequestDetail()");
  assert.doesNotMatch(requests, /messageReactionPickerHtml|data-rx-face|wireReactionControls/);
  assert.equal((html.match(/wireReactionControls\(thHistoryEl\)/g) || []).length, 1);
});

test("B2 keeps both truths: aggregate badges cling while add events enter the chronological stream", () => {
  assert.match(html, /\.rx-badges \{ position:absolute; bottom:-12px/);
  assert.match(html, /class="rx-badge\$\{reaction\.reactedByMe/);
  assert.match(html, /chronological\.sort\(\(a, b\) => new Date\(a\.at \|\| 0\) - new Date\(b\.at \|\| 0\)\)/);
  assert.match(html, /if \(event\.action === "add"\) chronological\.push/);
  assert.match(html, /\$\{esc\(label\)\}<\/span> reacted <span class="emoji">\$\{esc\(event\.emoji\)\}/);
  assert.match(html, /data-mine="\$\{reaction\.reactedByMe \? "1" : "0"\}"/);
});
