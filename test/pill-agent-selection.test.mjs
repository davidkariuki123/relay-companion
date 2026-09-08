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
    const hostKeyFor = app => app === "Codex" ? "codex" : "claude";
    const esc = text => String(text);
    const readerRow = () => null, relayById = () => null;
    const relaySubject = row => row.title || "Test";
    const relaySender = () => "Taylor";
    ${code}
    ${ui}
    ${footer}
    return { agentAppSelection, requestedAgentApps, setAgentAppEnabled, saveAgentApps,
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
  h.setAgentAppEnabled("Codex", false);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code"]);
  h.setAgentAppEnabled("Claude Code", false);
  assert.deepEqual(h.agentAppSelection(), []);
  assert.match(h.yourAgentHtml(), /My own session[\s\S]*Chosen/);
  h.setAgentAppEnabled("Codex", true);
  assert.deepEqual(h.agentAppSelection(), ["Codex"]);
  h.setAgentAppEnabled("Claude Code", true);
  assert.deepEqual(h.agentAppSelection(), ["Claude Code", "Codex"]);
  const restored = harness({ saved: Object.fromEntries(h.store) });
  assert.deepEqual(restored.agentAppSelection(), ["Claude Code", "Codex"]);
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
  h.setAgentAppEnabled("Claude Code", false);
  assert.doesNotMatch(h.relayHostActionsHtml({ id: "relay-test" }), /Open in Claude Code/);
  h.saveAgentApps([]);
  const copy = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(copy, /Copy for your agent/);
  assert.doesNotMatch(copy, /data-host-open=/);
});

test("mixed terminal/desktop choices do not leak one provider's surface onto the other", () => {
  const h = harness({ preference: { provider: "claude", surface: "terminal" }, saved: { "proto.agentApps.v3:account-a": "Claude Code|Codex" } });
  assert.equal(h.agentSurfacePreference("Claude Code"), "terminal");
  assert.equal(h.agentSurfacePreference("Codex"), "desktop");
  const footer = h.relayHostActionsHtml({ id: "relay-test" });
  assert.match(footer, /Open in Codex/);
  assert.doesNotMatch(footer, /Open in Claude Code/);
  assert.match(footer, /Copy for your agent/);
});
