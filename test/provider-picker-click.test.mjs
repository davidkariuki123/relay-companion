import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function section(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
}
const wire = section("  function wireHostOpen(scope)", "  // Before 0.1.290");
const rows = section("  function wireSessionPickerRows(scope)", "  async function retrySessionPicker");
const deliver = section("  async function deliverSessionSelection(", "  async function loadSessionPicker");
function button(attributes = {}) {
  return {
    disabled: false,
    getAttribute: (key) => attributes[key],
    addEventListener(event, callback) { this[event] = callback; },
    querySelector: () => ({ textContent: "" }),
  };
}
const event = () => ({ stopPropagation() {} });

for (const provider of ["codex", "claude"]) {
  for (const source of ["relay", "sent"]) {
    for (const materialized of [false, true]) {
      test(`${provider} ${source} materialized=${materialized}: first click chooses, never launches`, () => {
        const calls = [];
        const row = button({ "data-host-open": "relay-fixture", "data-host": provider, "data-source": source, "data-continues": materialized ? "1" : "0" });
        const context = vm.createContext({
          sessionPickerState: null,
          readerRow: () => ({ id: "relay-fixture", materializedCodex: materialized, materializedClaude: materialized }),
          relayById: () => null,
          relaySubject: () => "Fixture",
          loadSessionPicker: (...args) => calls.push(["picker", ...args]),
          openRelayFromUI: () => assert.fail("Provider click launched a native session"),
          wireSessionPickerRows: () => calls.push(["bind"]),
        });
        vm.runInContext(wire, context);
        context.wireHostOpen({ querySelectorAll: selector => selector === "[data-host-open]" ? [row] : [] });
        row.click(event());
        assert.deepEqual(calls, [["bind"], ["picker", "relay-fixture", provider, "Fixture", null, source]]);
        context.sessionPickerState = { delivering: true };
        row.click(event());
        assert.equal(calls.length, 2, "Cannot switch provider while delivery is pending");
      });
    }
  }
}

test("the footer renders destination choice even when the Relay already has a task", () => {
  const context = vm.createContext({
    esc: String, REDUCED: true,
    sessionPickerState: { id: "fixture", provider: "codex", motion: "open" },
    agentAppHosts: () => ["codex", "claude"], agentOpensInApp: () => true,
    otherAgentEnabled: () => false,
    sessionPickerBodyHtml: () => '<button data-sp-new>New task</button><button data-session-id="chosen">Existing task</button>',
  });
  vm.runInContext(section("  function sessionPickerInlineHtml(", "  function wireSessionPickerRows(")
    + section("  function relayHostActionsHtml(", "  // \"Pull David"), context);
  const markup = context.relayHostActionsHtml({ id: "fixture", materializedCodex: true });
  assert.match(markup, /data-sp-reveal="fixture" data-sp-provider="codex"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /data-session-id="chosen"/);
  assert.doesNotMatch(markup, /data-continues/);
});

for (const mode of ["existing", "new"]) test(`${mode} selection delivers once, including after footer rebinding`, async () => {
  let complete;
  const requests = [];
  const newRow = button();
  const existingRow = button({ "data-session-id": "chosen-task", "data-session-state": "idle", "data-session-surface": "desktop" });
  const scope = {
    querySelector: selector => selector === "[data-sp-new]" ? newRow : null,
    querySelectorAll: selector => selector === "[data-session-id]" ? [existingRow] : selector === ".sp-row" ? [newRow, existingRow] : [],
  };
  const context = vm.createContext({
    sessionPickerState: { id: "fixture", provider: "codex", source: "sent", surface: "desktop" },
    sessionPickerReveal: () => scope, renderSessionPickerSurface() {}, clearInterval() {},
    window: { relay: { deliverToSession: (id, selection) => {
      requests.push({ id, ...selection });
      return new Promise(resolve => { complete = resolve; });
    } } },
  });
  vm.runInContext(rows + deliver + wire, context);
  // This is the common renderer binder, not a direct call to the destination binder.
  context.wireHostOpen(scope);
  (mode === "new" ? newRow : existingRow).click(event());
  existingRow.click(event());
  newRow.click(event());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "codex");
  assert.equal(requests[0].source, "sent");
  assert.equal(requests[0].id, "fixture");
  if (mode === "new") assert.equal(requests[0].mode, "new");
  else assert.equal(requests[0].nativeId, "chosen-task");
  complete({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.sessionPickerState, null);
});
