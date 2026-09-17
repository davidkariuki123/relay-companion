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
// A tile in the reader (inside .rd-host-actions) or in a room bubble (not).
function button(attributes = {}, { reader = true } = {}) {
  return {
    disabled: false,
    getAttribute: (key) => attributes[key],
    addEventListener(event, callback) { this[event] = callback; },
    querySelector: () => ({ textContent: "" }),
    closest: (selector) => reader && selector === ".rd-host-actions" ? {} : null,
    classList: { add() {}, remove() {} },
  };
}
const event = () => ({ stopPropagation() {} });

for (const provider of ["codex", "claude"]) {
  for (const source of ["relay", "sent"]) {
    for (const materialized of [false, true]) {
      test(`${provider} ${source} materialized=${materialized}: in the reader the first click chooses, never launches`, () => {
        const calls = [];
        const row = button({ "data-host-open": "relay-fixture", "data-host": provider, "data-source": source, "data-continues": materialized ? "1" : "0" });
        const context = vm.createContext({
          sessionPickerState: null,
          readerRow: () => ({ id: "relay-fixture", materializedCodex: materialized, materializedClaude: materialized }),
          relayById: () => null,
          relaySubject: () => "Fixture",
          loadSessionPicker: (...args) => calls.push(["picker", ...args]),
          openRelayFromUI: () => assert.fail("Provider click launched a native session"),
          openNewSessionFromBubble: () => assert.fail("A reader tile opened a new chat without the picker"),
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
    // David, 2026-09-17: choosing Codex or Claude Code in the chat (not the
    // expanded view) must not bring up the menu; it opens a new chat there.
    test(`${provider} ${source}: in a room bubble the first click opens a new chat, no picker`, () => {
      const calls = [];
      const tile = button({ "data-host-open": "relay-fixture", "data-host": provider, "data-source": source }, { reader: false });
      const context = vm.createContext({
        sessionPickerState: null,
        readerRow: () => null, relayById: () => null, relaySubject: () => "Fixture",
        loadSessionPicker: () => assert.fail("A bubble tile opened the picker"),
        openNewSessionFromBubble: (...args) => calls.push(["new", ...args]),
        wireSessionPickerRows: () => calls.push(["bind"]),
      });
      vm.runInContext(wire, context);
      context.wireHostOpen({ querySelectorAll: selector => selector === "[data-host-open]" ? [tile] : [] });
      tile.click(event());
      assert.deepEqual(calls, [["bind"], ["new", tile, "relay-fixture", provider, source]]);
      context.sessionPickerState = { delivering: true };
      tile.click(event());
      assert.equal(calls.length, 2, "A delivery in flight is not raced by a second open");
    });
  }
}

test("a bubble's new chat is the picker's New chat: mode new, the app's surface, the mark breathing until it lands", async () => {
  const requests = [], notes = [], classes = [];
  let complete;
  const tile = { classList: { add: (c) => classes.push("+" + c), remove: (c) => classes.push("-" + c) } };
  const context = vm.createContext({
    openingIds: new Map(), performance: { now: () => 1000 },
    clearRowNote: () => notes.push(["clear"]), setRowNote: (id, text, cls) => notes.push([cls, text]),
    stopOpening: (id) => notes.push(["stop", id]),
    agentSurfacePreference: (app) => app === "Codex" ? "terminal" : "desktop",
    setTimeout: (fn) => 0, clearTimeout() {},
    window: { relay: { deliverToSession: (id, selection) => { requests.push({ id, ...selection }); return new Promise((resolve) => { complete = resolve; }); } } },
  });
  vm.runInContext(html.slice(html.indexOf("  async function openNewSessionFromBubble("), html.indexOf("  // The row's click, wherever")), context);
  const done = context.openNewSessionFromBubble(tile, "relay-fixture", "codex", "sent");
  assert.deepEqual(requests, [{ id: "relay-fixture", provider: "codex", mode: "new", source: "sent", surface: "terminal" }]);
  assert.deepEqual(classes, ["+opening"]);
  complete({ ok: false, error: "Codex is not signed in." });
  await done;
  assert.deepEqual(notes, [["clear"], ["stop", "relay-fixture"], ["err", "Codex is not signed in."]]);
  // A second press while the first is still opening does nothing.
  context.openingIds.set("relay-fixture", 1000);
  await context.openNewSessionFromBubble(tile, "relay-fixture", "codex", "sent");
  assert.equal(requests.length, 1);
});

test("the footer renders destination choice even when the Relay already has a task", () => {
  const context = vm.createContext({
    esc: String, REDUCED: true,
    sessionPickerState: { id: "fixture", provider: "codex", motion: "open" },
    agentAppHosts: () => ["codex", "claude"], agentOpensInApp: () => true, chatAppEnabled: () => true,
    pullSentenceHtml: () => "", // the sentence is always offered; this test is about the picker rows
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

const loader = section("  async function loadSessionPicker(", "  async function refreshSessionPickerPresence(");
const reader = section("  function openReader(", "  function closeReader(");

for (const provider of ["codex", "claude"]) {
  for (const expanded of [false, true]) {
    for (const source of ["relay", "sent"]) {
      test(`${provider} ${source} from ${expanded ? "expanded" : "compact"} chat opens reader before revealing choices`, async () => {
        const calls = [];
        let commit;
        const context = vm.createContext({
          activeView: "threads", chatExpanded: expanded, readerId: null,
          readerSource: "relays", readerReturn: null, readerTab: "agent",
          threadDetailId: "chat-fixture", threadDetailPartyHint: "Fixture",
          threadsSource: "relays", expandedMsgIds: new Set(["fixture"]),
          scrollEl: { scrollTop: 12 }, peeking: false,
          sessionPickerState: null, expandedRelayId: null, expandedSentId: null,
          READER: { w: 720, h: 760 },
          captureRoomScroll: () => ({ top: 234, anchorId: "fixture" }),
          readerRow: () => ({ id: "fixture" }),
          handoffFor: () => ({ state: "running" }),
          agentSurfacePreference: () => "desktop",
          startCardViewTransition: (update, size) => {
            calls.push(["transition", size.w]);
            return new Promise(resolve => { commit = () => { update(); resolve(); }; });
          },
          commitNavigation: () => calls.push(["render", context.activeView, context.sessionPickerState?.provider]),
          armSessionPickerReveal: () => calls.push(["reveal", context.activeView]),
          paintSessionPickerResult: () => calls.push(["result"]),
          closeSessionPicker: () => { context.sessionPickerState = null; calls.push(["close"]); },
          setInterval: () => 1,
          window: { relay: { sessionPicker: async (...args) => {
            calls.push(["fetch", ...args]);
            return { ok: true, provider, recent: [] };
          } } },
        });
        vm.runInContext(loader + reader, context);
        const pending = context.loadSessionPicker("fixture", provider, "Fixture", null, source);
        assert.equal(context.activeView, "threads", "source remains visible until transition commits");
        assert.equal(context.readerReturn.expanded, expanded);
        assert.equal(context.readerReturn.roomScroll.top, 234);
        assert.equal(context.readerReturn.threadId, "chat-fixture");
        assert.deepEqual(calls, [["transition", 720]]);
        commit();
        await pending;
        assert.equal(context.activeView, "reader");
        assert.equal(context.readerId, "fixture");
        assert.equal(context.readerTab, "you", "provider click shows the letter even with an active handoff");
        assert.equal(context.readerSource, source === "sent" ? "sent" : "threads");
        assert.equal(context.chatExpanded, expanded, "chat geometry is preserved for Back");
        assert.deepEqual(calls.slice(1), [
          ["render", "reader", provider], ["reveal", "reader"],
          ["fetch", "fixture", provider, source, "desktop"], ["result"],
        ]);
        await context.loadSessionPicker("fixture", provider, "Fixture", null, source);
        assert.equal(calls.at(-1)[0], "close", "same provider still toggles in the reader");
      });
    }
  }
}

test("leaving during reader expansion does not reveal or fetch a stale picker", async () => {
  let finish;
  const context = vm.createContext({
    activeView: "threads", readerId: null, expandedRelayId: null,
    sessionPickerState: null, agentSurfacePreference: () => "desktop",
    openReader: () => new Promise(resolve => { finish = resolve; }),
    armSessionPickerReveal: () => assert.fail("Revealed a cancelled picker"),
    window: { relay: { sessionPicker: () => assert.fail("Fetched a cancelled picker") } },
  });
  vm.runInContext(loader, context);
  const pending = context.loadSessionPicker("fixture", "codex");
  context.sessionPickerState = null;
  context.activeView = "relays";
  finish();
  await pending;
});
