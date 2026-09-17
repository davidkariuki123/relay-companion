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

test("the message menu exposes the approved eight reactions on its own message", () => {
  assert.match(html, /const RX_PRIMARY = \["👍", "❤️", "😂", "🙌", "‼️", "🙏", "👀", "🔥"];/);
  const source = between(html, "  function messageReactionPickerHtml(id)", "  function reactionConfirmationHtml");
  const render = Function("REACTIONS_ENABLED", "RX_PRIMARY", "esc", `${source}; return messageReactionPickerHtml;`)(true, ["👍", "❤️", "😂", "🙌", "‼️", "🙏", "👀", "🔥"], String);
  const menu = render("relay_target");
  assert.equal((menu.match(/data-rx-pick="relay_target"/g) || []).length, 8);
  assert.match(menu, /aria-label="React ‼️"/);
  assert.match(menu, /aria-label="React 👀"/);
  assert.match(menu, /aria-label="React 🔥"/);
  assert.doesNotMatch(menu, /rx-face|rx-unfurl/);
  assert.match(html, /canReact \? messageReactionPickerHtml\(m\.id\) : ""/);
});

test("reaction failures remain visible and successful mutations retain their explicit action", async () => {
  const source = between(html, "  async function commitReaction(", "  function dismissReactionPickers(");
  const notes = [], calls = [];
  const commit = Function("window", "setRowNote", "clearRowNote", "reactionMutationIds", `${source}; return commitReaction;`)({relay:{react:async (...args) => { calls.push(args); return {ok:false,error:"Offline"}; }}}, (...args) => notes.push(args), () => {}, new Set());
  await commit("message-one", "👍", "remove");
  assert.deepEqual(calls, [["message-one", "👍", "remove"]]);
  assert.deepEqual(notes, [["message-one", "Offline", "err"]]);
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

test("Task, reader and AI-runner surfaces never render a reaction trigger", () => {
  assert.match(html, /const REACTIONS_ENABLED = true;/, "conversation reactions are enabled");
  const reader = between(html, "function renderReader()", "// ---------- the Tasks board:");
  assert.doesNotMatch(reader, /messageReactionPickerHtml|data-rx-face|reactionConfirmationHtml|wireReactionControls/);

  const conversation = between(html, "const rowsHtml = timeline.map", "// Chat order: history above");
  assert.match(conversation, /const canReact = REACTIONS_ENABLED && !m\.request && !m\.ownedAgent && !m\.pending/);
  assert.match(conversation, /!m\.deletedAt && !attachmentOnly && !editingMessage && !groupPostingBlocked/);
  assert.doesNotMatch(conversation, /reactionConfirmationHtml\(m\.id\)/);
  assert.match(conversation, /<span class="kchip">Task<\/span>/, "Task roots can remain visible as bubbles");

  const requests = between(html, "function renderTasksBoard()", "function wireRequestDetail()");
  assert.doesNotMatch(requests, /messageReactionPickerHtml|data-rx-face|wireReactionControls/);
  assert.match(html, /const newControls = RelayChatRows\.newControlsScope\(thHistoryEl\);/, "new reaction controls are scoped to the conversation");
  assert.equal((html.match(/wireReactionControls\(newControls\)/g) || []).length, 1);
});

test("attached badges wrap, identify your reaction, and add no chronological chat rows", () => {
  assert.match(html, /\.rx-badges \{ position:relative; bottom:-20px;[^}]*flex-wrap:wrap/);
  assert.match(html, /\.rx-badge\.mine \{ border-color:var\(--edge-accent\)/);
  assert.match(html, /aria-pressed="\$\{reaction\.reactedByMe/);
  assert.doesNotMatch(html, /chronological\.push\(\{ kind:"reaction"/);
  assert.match(html, /data-mine="\$\{reaction\.reactedByMe \? "1" : "0"\}"/);
});

test("a badge carries who reacted for a screen reader and never relies on a native title", () => {
  const source = between(html, "  // ---------- who reacted ----------", "  // One card serves every badge.");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const api = Function("esc", `${source}; return { reactionNamesSummary, reactionBadgeHtml, reactionNamesHtml };`)(esc);
  const actor = (name, self = false) => ({ relayUserId: name.toLowerCase(), name, self });

  const one = api.reactionNamesSummary({ emoji: "🙏", count: 1, actors: [actor("Shane Acton")] });
  assert.equal(one.text, "Shane Acton");
  assert.equal(one.more, "");
  const two = api.reactionNamesSummary({ emoji: "👍", count: 2, actors: [actor("Shane Acton"), actor("David", true)] });
  assert.equal(two.text, "Shane Acton and You", "your own reaction reads as You");
  const three = api.reactionNamesSummary({ emoji: "👍", count: 3, actors: [actor("Shane Acton"), actor("Sven"), actor("David", true)] });
  assert.equal(three.text, "Shane Acton, Sven, and You", "three names need no See all");
  assert.equal(three.others, 0);
  const four = api.reactionNamesSummary({ emoji: "👍", count: 4, actors: [actor("A"), actor("B"), actor("C"), actor("D")] });
  assert.equal(four.text, "A, B, C");
  assert.equal(four.more, " and 1 other");
  const many = api.reactionNamesSummary({ emoji: "👍", count: 120, actors: Array.from({ length: 120 }, (_, i) => actor(`Person ${i}`)) });
  assert.equal(many.more, " and 117 others");
  const nameless = api.reactionNamesSummary({ emoji: "👍", count: 2, actors: [actor("Shane Acton"), actor("")] });
  assert.equal(nameless.text, "Shane Acton and Name unavailable", "the count is kept; no identity is guessed");

  const badge = api.reactionBadgeHtml("relay_1", { emoji: "👍", count: 6, reactedByMe: true, actors: [actor("Shane Acton"), actor("Sven"), actor("David", true), actor("A"), actor("B"), actor("C")] }, true);
  assert.doesNotMatch(badge, /\stitle=/, "Electron 38+ on macOS does not show HTML title tooltips (electron/electron#49843)");
  assert.match(badge, /aria-label="👍 · 6 · Shane Acton, Sven, You and 3 others · Remove your reaction"/);
  assert.match(badge, /data-rx-actors="\[\{&quot;name&quot;:&quot;Shane Acton&quot;,&quot;self&quot;:false\}/, "names travel on the badge itself");
  assert.match(badge, /data-rx-count="6"/);
  assert.match(badge, /aria-pressed="true"/);
  assert.doesNotMatch(badge, / disabled/);
  const readOnly = api.reactionBadgeHtml("relay_1", { emoji: "👍", count: 1, reactedByMe: false, actors: [actor("Shane Acton")] }, false);
  assert.match(readOnly, /aria-disabled="true"/, "a read-only badge still answers a hover, so it is not a disabled control");
  assert.doesNotMatch(readOnly, /Add your reaction/);

  const summary = api.reactionNamesHtml({ emoji: "👍", count: 6, actors: [actor("Shane Acton"), actor("Sven"), actor("David", true), actor("A"), actor("B"), actor("C")] });
  assert.match(summary, /<div class="rx-names-summary">Shane Acton, Sven, You<span class="rx-names-more"> and 3 others<\/span><\/div>/);
  assert.match(summary, /<button type="button" class="rx-names-all" data-rx-names-all>See all 6<\/button>/);
  const small = api.reactionNamesHtml({ emoji: "🙏", count: 1, actors: [actor("Shane Acton")] });
  assert.doesNotMatch(small, /rx-names-all/, "everyone already fits");
  assert.equal(api.reactionNamesHtml({ emoji: "🙏", count: 3, actors: [] }), "", "no names, no card");
  const full = api.reactionNamesHtml({ emoji: "👍", count: 6, actors: [actor("Shane Acton"), actor("Sven"), actor("David", true), actor("A"), actor("B"), actor("<script>")] }, { full: true });
  assert.match(full, /<div class="rx-names-head"><span class="emoji">👍<\/span><span>6 reactions<\/span><button type="button" class="rx-names-close" data-rx-names-close aria-label="Close">×<\/button><\/div>/);
  assert.equal((full.match(/class="rx-names-person/g) || []).length, 6);
  assert.match(full, /rx-names-person self" role="listitem">You</);
  assert.match(full, /&lt;script&gt;/, "names are escaped");
  assert.match(full, /<div class="rx-names-foot" data-rx-names-foot>6 people<\/div>/);
});

test("the names card is wired into the conversation and retires with the pickers", () => {
  const conversation = between(html, "const rowsHtml = timeline.map", "// Chat order: history above");
  assert.match(conversation, /reactionBadgeHtml\(m\.id, reaction, canReact\)/);
  assert.match(html, /wireReactionControls\(newControls\);\s*\n\s*reactionNames\.sync\(thHistoryEl\);/, "a repaint re-anchors an open card");
  assert.match(html, /if \(badge\.getAttribute\("aria-disabled"\) === "true"\) return;/, "a read-only badge never toggles");
  const openRoom = between(html, "function openThreadDetail(", "// ---------- Settings view ----------");
  assert.match(openRoom, /dismissReactionPickers\(\);\s*\n\s*reactionNames\.hide\(\);/);
  const view = between(html, "function applyView()", "document.getElementById(\"chatExpandBtn\")");
  assert.match(view, /if \(viewChanged\) reactionNames\.hide\(\);/);
  assert.match(html, /new ResizeObserver\(\(\) => reactionNames\.hide\(\)\)\.observe\(cardEl\);/, "every fold and morph hides it");
  const install = between(html, "  function installReactionNames(", "  const reactionNames = installReactionNames(");
  assert.match(install, /card\.setAttribute\("popover", "manual"\)/, "top layer, own dismissal rules");
  assert.match(install, /root\.addEventListener\("scroll", \(event\) => \{ if \(isOpen\(\) && !card\.contains\(event\.target\)\) hide\(\); \}, true\);/);
  assert.match(install, /view\?\.addEventListener\("blur", \(\) => hide\(\)\);/);
  assert.match(install, /if \(event\.pointerType === "touch"\) return;/);
  assert.match(html, /\.rx-names:not\(:popover-open\) \{ display:none; \}/, "an author display beats the UA's hidden popover rule, so hiding is explicit");
});
