import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function section(start, end) {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i);
  assert.ok(i >= 0 && j > i);
  return html.slice(i, j);
}
function harness({ saved = {}, surfaces = "both", preference = null } = {}) {
  const store = new Map(Object.entries(saved));
  let account = "account-a";
  const code = section("  let agentSurfaces = null;", "  function chatOrder()");
  const ui = section("  function yourAgentHtml()", "  function blockedPeopleHtml()");
  const footer = section("  function relayHostActionsHtml(", "  // The row's click");
  const api = new Function("protoPref", "setProtoPref", "signupAccountKey", "payload", `
    const sessionPickerState = null;
    ${section("  function sessionPickerInlineHtml(", "  function wireSessionPickerRows(")}
    const hostKeyFor = app => app === "Codex" ? "codex" : "claude";
    ${section("  function esc(s)", "  function agentMentionSpans(")}
    const readerRow = () => null, relayById = () => null;
    const relaySubject = row => row.title || "Test";
    const relaySender = () => "Taylor";
    ${code}
    ${ui}
    ${footer}
    return { agentAppSelection, requestedAgentApps, setAgentAppEnabled, saveAgentApps,
      agentAppHosts, agentAppName, agentSurfacePreference, yourAgentHtml, relayHostActionsHtml,
      chatAppSelection, setChatAppEnabled, saveChatApps, enabledAgentApps, isLastAgentAppOn,
      setSurfaces: value => { agentSurfaces = value; } };
  `)((key, fallback) => store.has(key) ? store.get(key) : fallback,
    (key, value) => store.set(key, value), () => account, { ui: { openingPreference: preference } });
  const detected = {
    "Claude Code": { available: true }, Codex: { available: true },
    _claudeDesktop: { available: true }, _codexDesktop: { available: true },
    _claudeCli: { available: true }, _codexCli: { available: true },
  };
  api.setSurfaces(surfaces === "both" ? detected : surfaces);
  return { ...api, store, detected, switchAccount: value => { account = value; } };
}

test("independent switches round trip both, one, none and back on", () => {
  const h = harness();
  assert.deepEqual(h.agentAppSelection(), ["Claude Code", "Codex"]);
  assert.deepEqual(h.agentAppHosts(), ["codex", "claude"]);
  // Four switches, one per tile of the reader's sheet, all on to begin with;
  // no Other row — the copied sentence has nothing to switch (David, 2026-09-17).
  assert.equal((h.yourAgentHtml().match(/aria-checked="true"/g) || []).length, 4);
  assert.equal((h.yourAgentHtml().match(/class="sv-switch"/g) || []).length, 4);
  assert.doesNotMatch(h.yourAgentHtml(), /svOtherAgent|Copy prompts for another agent/);
  assert.doesNotMatch(h.yourAgentHtml(), /Other<\/span>|Terminal or another agent|sv-open-logo-blank/);
  h.setAgentAppEnabled("Codex", false);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code"]);
  h.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(h.agentAppSelection(), []);
  h.setAgentAppEnabled("Codex", true);
  assert.deepEqual(h.agentAppSelection(), ["Codex"]);
  h.setAgentAppEnabled("Claude Code", true);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code", "Codex"]);
  const restored = harness({ saved: Object.fromEntries(h.store) });
  assert.deepEqual(restored.agentAppSelection(), ["Claude Code", "Codex"]);
  h.saveAgentApps([]);
  assert.deepEqual(h.agentAppHosts(), []);
  // Saving apps never writes the retired Other preference.
  assert.ok(![...h.store.keys()].some((key) => key.startsWith("proto.otherAgent")));
});

test("legacy pair, single, none and onboarding preference migrate without silently switching apps", () => {
  for (const [saved, expected] of [["Claude Code|Codex", ["Claude Code", "Codex"]], ["Codex", ["Codex"]], ["__none__", []]]) {
    assert.deepEqual(harness({ saved: { "proto.agentApps.v2": saved } }).agentAppSelection(), expected);
  }
  const h = harness({ preference: { provider: "codex", surface: "desktop" } });
  assert.deepEqual(h.agentAppSelection(), ["Codex"]);
  h.setSurfaces({ "Claude Code": { available: true }, Codex: { available: false } });
  assert.deepEqual(h.agentAppSelection(), []);
  h.setAgentAppEnabled("Codex", true);
  assert.equal(h.store.size, 0);
  assert.deepEqual(harness({ preference: { surface: "other" } }).agentAppSelection(), []);
});

test("new choices are account scoped and cannot alter another account's selection", () => {
  const h = harness();
  h.saveAgentApps(["Codex"]);
  h.switchAccount("account-b");
  assert.deepEqual(h.agentAppSelection(), ["Claude Code", "Codex"]);
  h.saveAgentApps([]);
  h.switchAccount("account-a");
  assert.deepEqual(h.agentAppSelection(), ["Codex"]);
  h.switchAccount("");
  const before = [...h.store];
  h.saveAgentApps([]);
  assert.deepEqual([...h.store], before);
});

test("unknown and absent apps stay disabled and do not claim a connection", () => {
  const h = harness({ surfaces: null });
  assert.deepEqual(h.agentAppSelection(), []);
  assert.equal((h.yourAgentHtml().match(/Checking availability…/g) || []).length, 2);
  assert.equal((h.yourAgentHtml().match(/ disabled/g) || []).length, 2);
  h.setSurfaces({ Codex: { available: false, reason: "Install Codex" } });
  assert.match(h.yourAgentHtml(), /Install Codex/);
  assert.doesNotMatch(h.yourAgentHtml(), /Connected|svOpeningSurface|<select/);
});

test("both enabled desktop providers render separate actions without automatically opening either", () => {
  const h = harness();
  const footer = h.relayHostActionsHtml({ id: "relay-test", title: "Test" });
  assert.equal((footer.match(/data-host-open=/g) || []).length, 2);
  // The strip (David, 2026-09-17): "Open in" once, then the names, the chat
  // apps first and the agents on this Mac after, in the order of the reader's sheet.
  assert.match(footer, /<div class="th-host-strip-lead">Open in<\/div>/);
  assert.deepEqual([...footer.matchAll(/class="th-host-name">([^<]+)</g)].map((m) => m[1]), ["Claude", "ChatGPT", "Claude Code", "Codex"]);
  assert.match(footer, /data-host="codex" data-host-open="relay-test"/);
  assert.match(footer, /data-host="claude" data-host-open="relay-test"/);
  assert.match(footer, /Copy this prompt for your agent/);
  h.setAgentAppEnabled("Claude Code", false);
  assert.doesNotMatch(h.relayHostActionsHtml({ id: "relay-test" }), />Claude Code</);
  h.saveAgentApps([]);
  const copy = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(copy, /Copy this prompt for your agent/);
  assert.doesNotMatch(copy, /data-host-open=/);
  // The chat apps stay: they read the Relay through the connector, not an app on this Mac.
  assert.deepEqual([...copy.matchAll(/class="th-host-name">([^<]+)</g)].map((m) => m[1]), ["Claude", "ChatGPT"]);
  assert.equal((copy.match(/data-app-open="relay-test"/g) || []).length, 2);
});

test("mixed terminal/desktop choices do not leak one provider's surface onto the other", () => {
  const h = harness({ preference: { provider: "claude", surface: "terminal" }, saved: { "proto.agentApps.v3:account-a": "Claude Code|Codex" } });
  assert.equal(h.agentSurfacePreference("Claude Code"), "terminal");
  assert.equal(h.agentSurfacePreference("Codex"), "desktop");
  const footer = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(footer, /data-host="codex" data-host-open=/);
  assert.doesNotMatch(footer, />Claude Code<|data-host="claude" data-host-open=/);
  assert.match(footer, /Copy this prompt for your agent/);
});

test("the copied sentence is always offered: beside the app rows, and alone when no app is on", () => {
  const h = harness();
  let footer = h.relayHostActionsHtml({ id:"relay-test", title:"Privacy notice" });
  assert.equal((footer.match(/data-host-open=/g) || []).length, 2);
  assert.match(footer, /Or tell your agent this:/);
  const displayed = footer.match(/class="th-pull-q">([^<]+)</)[1];
  const copied = footer.match(/data-pull-copy="([^"]+)"/)[1];
  assert.equal(displayed, copied);
  assert.equal(copied, "Pull Taylor’s relay “Privacy notice” from Relay and tell me what’s happening.");
  h.saveAgentApps([]);
  footer = h.relayHostActionsHtml({ id:"relay-test", direction:"out" });
  // With no agent app on, Claude and ChatGPT are still offered, so the
  // sentence is still the "or" (David, 2026-09-17: the four, everywhere).
  assert.match(footer, /Or tell your agent this:/);
  assert.doesNotMatch(footer, /data-host-open=/);
  assert.match(footer, /Pull my sent relay/);
  // Nothing switches the sentence off: no apps, another account, a legacy "off" — still offered.
  assert.match(h.relayHostActionsHtml({ id:"relay-test" }), /Copy this prompt for your agent/);
  h.switchAccount("account-b");
  assert.match(h.relayHostActionsHtml({ id:"relay-test" }), /Copy this prompt for your agent/);
  const legacyOff = harness({ saved: { "proto.otherAgent.v1:account-a": "off", "proto.agentApps.v3:account-a": "__none__" } });
  assert.match(legacyOff.relayHostActionsHtml({ id:"relay-test" }), /Copy this prompt for your agent/);
  assert.doesNotMatch(h.yourAgentHtml(), /My own session|Use this one|Chosen/);
});

test("legacy Other and terminal choices migrate to no app / that app, and keep the sentence", () => {
  const other = harness({ preference: { surface: "other" } });
  assert.deepEqual(other.agentAppSelection(), []);
  assert.match(other.relayHostActionsHtml({ id: "relay-test" }), /Or tell your agent this:/);
  const terminal = harness({ preference: { surface: "terminal", provider: "codex" } });
  assert.deepEqual(terminal.agentAppSelection(), ["Codex"]);
  assert.doesNotMatch(terminal.relayHostActionsHtml({ id: "relay-test" }), /data-host-open=/, "a terminal choice opens no desktop app");
  assert.match(terminal.relayHostActionsHtml({ id: "relay-test" }), /Copy this prompt for your agent/);
  const none = harness({ saved: { "proto.agentApps.v3:account-a": "__none__" } });
  assert.deepEqual(none.agentAppSelection(), []);
  none.setAgentAppEnabled("Claude Code", true);
  assert.deepEqual(none.agentAppSelection(), ["Claude Code"]);
});

// Sven, Granular, 2026-09-17: "I'm seeing the Open in Claude and Codex even
// though I've turned them off in settings." The chat-app tiles had no switch.
// The same evening the tiles became one line of chips (David: "the section
// … is taking up so much of the screen"): "Open in" once, then a rectangular
// chip per app — mark and name, the verb on its aria-label — and no notch.
test("the reader's sheet paints exactly the chips whose switches are on, in its order", () => {
  const h = harness();
  const labels = (html) => [...html.matchAll(/th-host-label">([^<]+)</g)].map((m) => m[1]);
  const verbs = (html) => [...html.matchAll(/aria-label="(Open in [^"]+)"/g)].map((m) => m[1]);
  const reader = () => h.relayHostActionsHtml({ id: "relay-test", title: "Test" }, { persistent: true, sheet: true });
  // The bubble's strip follows the same switches, the same way round.
  const names = (html) => [...html.matchAll(/th-host-name">([^<]+)</g)].map((m) => m[1]);
  const bubble = () => h.relayHostActionsHtml({ id: "relay-test", title: "Test" }, { persistent: true });
  assert.deepEqual(h.chatAppSelection(), ["Claude", "ChatGPT"]);
  assert.deepEqual(h.enabledAgentApps(), ["Claude", "ChatGPT", "Claude Code", "Codex"]);
  assert.deepEqual(labels(reader()), ["Claude", "ChatGPT", "Claude Code", "Codex"]);
  assert.deepEqual(verbs(reader()), ["Open in Claude", "Open in ChatGPT", "Open in Claude Code", "Open in Codex"]);
  assert.match(reader(), /<span class="th-host-lead" aria-hidden="true">Open in<\/span>/);
  assert.doesNotMatch(reader(), /th-host-context|New chat|Choose a chat/, "the chips carry no two-word context");
  assert.match(reader(), /Or tell your agent this:/);
  assert.deepEqual(names(bubble()), ["Claude", "ChatGPT", "Claude Code", "Codex"]);
  assert.doesNotMatch(bubble(), /th-host-sheet/);
  // Settings lists the same four, the same way round, each its own switch.
  const rows = [...h.yourAgentHtml().matchAll(/data-(chat|agent)-app="([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual(rows, ["Claude", "ChatGPT", "Claude Code", "Codex"]);
  assert.match(h.yourAgentHtml(), /src="claudeMark\.svg"[\s\S]*src="chatgptMark\.svg"[\s\S]*src="claudeCodeMark\.svg"[\s\S]*src="codexMark\.svg"/);
  // Every desktop switch off: the two chat chips remain, nothing else.
  h.saveAgentApps([]);
  assert.deepEqual(labels(reader()), ["Claude", "ChatGPT"]);
  assert.match(reader(), /Or tell your agent this:/);
  // Chat switches off one at a time, the desktop ones back on.
  h.saveAgentApps(["Claude Code", "Codex"]);
  h.setChatAppEnabled("Claude", false);
  assert.deepEqual(h.chatAppSelection(), ["ChatGPT"]);
  assert.deepEqual(labels(reader()), ["ChatGPT", "Claude Code", "Codex"]);
  h.setChatAppEnabled("ChatGPT", false);
  assert.deepEqual(h.chatAppSelection(), []);
  assert.deepEqual(labels(reader()), ["Claude Code", "Codex"]);
  assert.deepEqual(names(bubble()), ["Claude Code", "Codex"]);
  assert.equal((h.yourAgentHtml().match(/data-chat-app="[^"]+" aria-checked="false"/g) || []).length, 2);
  // The chat choice is its own key: it never touches the desktop selection or its legacy mirror.
  assert.equal(h.store.get("proto.chatApps.v1:account-a"), "__none__");
  assert.equal(h.store.get("proto.agentApps.v3:account-a"), "Claude Code|Codex");
  // Back on, and a fresh harness reads the saved choice.
  h.setChatAppEnabled("Claude", true);
  assert.deepEqual(harness({ saved: Object.fromEntries(h.store) }).chatAppSelection(), ["Claude"]);
  // Another account keeps its own four.
  h.switchAccount("account-b");
  assert.deepEqual(h.chatAppSelection(), ["Claude", "ChatGPT"]);
  // A desktop app that is on but opens in a terminal has no chip: the sheet
  // can then be empty while switches are on, and the sentence stands alone.
  const terminal = harness({ preference: { surface: "terminal" }, saved: { "proto.chatApps.v1:account-a": "__none__" } });
  for (const sheet of [true, false]) {
    const alone = terminal.relayHostActionsHtml({ id: "relay-test" }, { persistent: true, sheet });
    assert.doesNotMatch(alone, /th-host-sheet|th-host-lead|th-host-strip|data-host-open=|data-app-open=/);
    assert.match(alone, /Tell your agent this:/);
    assert.doesNotMatch(alone, /Or tell/);
  }
});

test("the chips are rectangles with no notch, and the fold is one motion", () => {
  // The chip: an 8px rectangle, mark and name on one line; the lit chip is the
  // selection, so nothing points at it.
  const sheet = section("  /* The reader's sheet: one line of chips", "  /* One box holds the tiles and, under a hairline, the pull block. */");
  assert.match(sheet, /\.th-host-tile \{[^}]*display:inline-flex; align-items:center;[^}]*border-radius:8px;/);
  assert.match(sheet, /\.th-host-sheet \{ display:flex; flex-wrap:wrap; justify-content:center;/);
  assert.match(sheet, /\.th-host-lead \{/);
  assert.doesNotMatch(sheet, /pressed::after|hostNotchIn|repeat\(4|th-host-context/);
  assert.doesNotMatch(html, /hostNotchIn/);
  // Pressing the lit chip again folds the picker as one continuous motion
  // (David, 2026-09-17: "smoothly collapse … not a discrete collapse"): the
  // chip's light lets go with the rows, the height eases in as well as out,
  // and the rows fade at the pace the height leaves.
  const close = section("  function closeSessionPicker(", "  function sessionPickerReveal(");
  assert.match(close, /document\.querySelectorAll\(`\[data-host-open="\$\{CSS\.escape\(String\(closingState\.id\)\)\}"\]\[data-host="\$\{closingState\.provider\}"\]\.pressed`\)/);
  assert.match(close, /control\.classList\.remove\("pressed"\);\s*control\.setAttribute\("aria-expanded", "false"\);/);
  assert.doesNotMatch(close, /previousElementSibling/, "the reader's chip is not the picker's sibling; the room's row is found the same way");
  assert.match(close, /reveal\.classList\.add\("reflowing", "closing"\);/);
  assert.match(close, /\{ duration:360, easing:"cubic-bezier\(\.4,0,\.2,1\)", fill:"both" \}/);
  assert.match(html, /\.sp-list\.closing \{ transition:opacity \.30s var\(--settle\), transform \.36s var\(--settle\); \}/);
});

test("the last switch on will not turn off, and its row says so", () => {
  const h = harness();
  h.setChatAppEnabled("Claude", false);
  h.setChatAppEnabled("ChatGPT", false);
  h.setAgentAppEnabled("Codex", false);
  assert.deepEqual(h.enabledAgentApps(), ["Claude Code"]);
  assert.ok(h.isLastAgentAppOn("Claude Code"));
  // The fourth stays on: neither path turns it off.
  h.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(h.enabledAgentApps(), ["Claude Code"]);
  assert.equal(h.store.get("proto.agentApps.v3:account-a"), "Claude Code");
  const html = h.yourAgentHtml();
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
  assert.equal((html.match(/aria-disabled="true"/g) || []).length, 1);
  assert.match(html, /data-agent-app="Claude Code" aria-checked="true" aria-disabled="true"/);
  assert.match(html, /Connected · keep at least one on/);
  assert.doesNotMatch(html, /opens relays in a new chat · keep/, "the whisper replaces the behaviour half, so the line never wraps at the pill's width");
  assert.equal((html.match(/keep at least one on/g) || []).length, 1, "only the last one on carries the whisper");
  // Any second switch on frees it.
  h.setChatAppEnabled("ChatGPT", true);
  assert.ok(!h.isLastAgentAppOn("Claude Code"));
  assert.doesNotMatch(h.yourAgentHtml(), /aria-disabled|keep at least one on/);
  h.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(h.enabledAgentApps(), ["ChatGPT"]);
  // Now ChatGPT is the last: it will not turn off either, and wears the whisper.
  h.setChatAppEnabled("ChatGPT", false);
  assert.deepEqual(h.enabledAgentApps(), ["ChatGPT"]);
  assert.match(h.yourAgentHtml(), /chatgpt\.com · keep at least one on/);
  assert.match(h.yourAgentHtml(), /data-chat-app="ChatGPT" aria-checked="true" aria-disabled="true"/);
  // "On" means on AND detected: an undetected desktop app does not count as the one left.
  const undetected = harness({ surfaces: { "Claude Code": { available: true }, Codex: { available: false, reason: "Install Codex" }, _claudeDesktop: { available: true }, _claudeCli: { available: true } },
    saved: { "proto.chatApps.v1:account-a": "__none__" } });
  assert.deepEqual(undetected.enabledAgentApps(), ["Claude Code"]);
  undetected.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(undetected.enabledAgentApps(), ["Claude Code"]);
});

test("prompt titles cannot inject markup into the visible text or clipboard attribute", () => {
  const h = harness();
  const footer = h.relayHostActionsHtml({id:'relay-test',title:'A "quoted" <img src=x> & note'});
  assert.doesNotMatch(footer, /<img src=x>/);
  assert.match(footer, /A &quot;quoted&quot; &lt;img src=x&gt; &amp; note/);
  assert.equal(footer.match(/class="th-pull-q">([^<]+)</)[1], footer.match(/data-pull-copy="([^"]+)"/)[1]);
});

test("copy binds the exact prompt, reports success, and restores the approved button label", async () => {
  const handlers = new Map();
  const button = {isConnected:true,textContent:'Copy this prompt for your agent',getAttribute:()=> 'Pull Sven’s relay “Test” from Relay and tell me what’s happening.',addEventListener:(event,fn)=>handlers.set(event,fn)};
  const scope = {querySelectorAll:selector=>selector === '[data-pull-copy]' ? [button] : []};
  const timers = [];
  let copied = null;
  const bind = new Function('navigator','setTimeout',`const wireSessionPickerRows = () => {}; ${section('  function wireHostOpen(scope)', '  function defaultReplyAnchorMap(')}; return wireHostOpen;`)({clipboard:{writeText:async text=>{copied=text;}}},fn=>timers.push(fn));
  bind(scope);
  await handlers.get('click')({stopPropagation(){}});
  assert.equal(copied, button.getAttribute());
  assert.equal(button.textContent,'Copied');
  timers[0]();
  assert.equal(button.textContent,'Copy this prompt for your agent');
});
