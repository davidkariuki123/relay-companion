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
    return { agentAppSelection, requestedAgentApps, setAgentAppEnabled, saveAgentApps, otherAgentEnabled, setOtherAgentEnabled,
      agentAppHosts, agentAppName, agentSurfacePreference, yourAgentHtml, relayHostActionsHtml,
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
  assert.equal(h.otherAgentEnabled(), true);
  assert.equal((h.yourAgentHtml().match(/aria-checked="true"/g) || []).length, 3);
  h.setOtherAgentEnabled(false);
  h.setAgentAppEnabled("Codex", false);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code"]);
  h.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(h.agentAppSelection(), []);
  assert.equal(h.otherAgentEnabled(), false, "turning off desktop apps does not silently enable Other");
  assert.match(h.yourAgentHtml(), /svOtherAgent" aria-checked="false"/);
  h.setAgentAppEnabled("Codex", true);
  assert.deepEqual(h.agentAppSelection(), ["Codex"]);
  h.setAgentAppEnabled("Claude Code", true);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code", "Codex"]);
  const restored = harness({ saved: Object.fromEntries(h.store) });
  assert.deepEqual(restored.agentAppSelection(), ["Claude Code", "Codex"]);
  assert.equal(restored.otherAgentEnabled(), false, "explicit Other opt-out survives a reload");
  h.saveAgentApps([]);
  assert.deepEqual(h.agentAppHosts(), []);
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
  assert.match(footer, /Open in Codex/);
  assert.match(footer, /Open in Claude Code/);
  assert.match(footer, /Copy this prompt for your agent/);
  h.setAgentAppEnabled("Claude Code", false);
  assert.doesNotMatch(h.relayHostActionsHtml({ id: "relay-test" }), /Open in Claude Code/);
  h.saveAgentApps([]);
  h.setOtherAgentEnabled(true);
  const copy = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(copy, /Copy this prompt for your agent/);
  assert.doesNotMatch(copy, /data-host-open=/);
});

test("mixed terminal/desktop choices do not leak one provider's surface onto the other", () => {
  const h = harness({ preference: { provider: "claude", surface: "terminal" }, saved: { "proto.agentApps.v3:account-a": "Claude Code|Codex" } });
  assert.equal(h.agentSurfacePreference("Claude Code"), "terminal");
  assert.equal(h.agentSurfacePreference("Codex"), "desktop");
  const footer = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(footer, /Open in Codex/);
  assert.doesNotMatch(footer, /Open in Claude Code/);
  assert.match(footer, /Copy this prompt for your agent/);
});

test("Other stays independent, account scoped, and controls the full matching prompt", () => {
  const h = harness();
  h.setOtherAgentEnabled(true);
  let footer = h.relayHostActionsHtml({ id:"relay-test", title:"Privacy notice" });
  assert.equal((footer.match(/data-host-open=/g) || []).length, 2);
  assert.match(footer, /Or tell your agent this:/);
  const displayed = footer.match(/class="th-pull-q">([^<]+)</)[1];
  const copied = footer.match(/data-pull-copy="([^"]+)"/)[1];
  assert.equal(displayed, copied);
  assert.equal(copied, "Pull Taylor’s relay “Privacy notice” from Relay and tell me what’s happening.");
  h.saveAgentApps([]);
  assert.equal(h.otherAgentEnabled(), true);
  footer = h.relayHostActionsHtml({ id:"relay-test", direction:"out" });
  assert.match(footer, /Tell your agent this:/);
  assert.doesNotMatch(footer, /Or tell|data-host-open=/);
  assert.match(footer, /Pull my sent relay/);
  h.setOtherAgentEnabled(false);
  assert.equal(h.relayHostActionsHtml({ id:"relay-test" }), "");
  h.switchAccount("account-b");
  assert.equal(h.otherAgentEnabled(), true, "another account starts with Other enabled");
  h.switchAccount("account-a");
  assert.equal(h.otherAgentEnabled(), false);
  assert.doesNotMatch(h.yourAgentHtml(), /My own session|Use this one|Chosen/);
});

test("legacy Other and terminal choices migrate and explicit off is preserved", () => {
  for (const preference of [{surface:"other"}, {surface:"terminal",provider:"codex"}]) {
    const h = harness({preference});
    assert.equal(h.otherAgentEnabled(), true);
    h.setOtherAgentEnabled(false);
    assert.equal(h.otherAgentEnabled(), false);
  }
  const h = harness({saved:{"proto.agentApps.v3:account-a":"__none__"}});
  assert.equal(h.otherAgentEnabled(), true);
  h.setAgentAppEnabled("Claude Code", true);
  assert.equal(h.otherAgentEnabled(), true);
});

test("prompt titles cannot inject markup into the visible text or clipboard attribute", () => {
  const h = harness();
  h.setOtherAgentEnabled(true);
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
