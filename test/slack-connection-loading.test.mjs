// Slack's connection lives in ONE row at the top of Inbox › Chats (David,
// 2026-10-07): Connect → "Click Allow in your browser" → "Slack is connected".
// There is no Slack tab or connection page any more. The laws the old tab
// protected still hold for the row: an unresolved or failed status check is
// not a disconnected account, a late older answer cannot replace a newer one,
// and a connected account never falls back to a Connect action on a blip.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return html.slice(from, to);
}

const connected = {
  state: "connected",
  team: { connected: true, name: "Test team" },
  personal: { state: "connected" },
};

function slackRow({ prefs = new Map() } = {}) {
  const pending = [];
  const connects = [];
  const paints = [];
  const handlers = new Map();
  const timers = [];
  const clock = { now: 1_000_000 };
  const calls = { cancel: 0, relays: 0, settings: 0, navigations: 0 };
  let markup = "";
  let mainListener = null;
  const slot = {
    dataset: {},
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; paints.push(value); handlers.clear(); },
    get firstElementChild() {
      if (!markup) return null;
      const state = (markup.match(/data-slack-nudge="(\w+)"/) || [])[1];
      return { dataset: { slackNudge: state }, classList: { contains: () => false, add() {} } };
    },
    querySelector: (selector) => {
      const id = selector.replace(/^#/, "");
      return markup.includes(`id="${id}"`)
        ? { addEventListener: (event, callback) => handlers.set(`${id}:${event}`, callback) }
        : null;
    },
  };
  const document = { getElementById: (id) => id === "slackNudge" ? slot : null };
  const window = { relay: {
    slackConnection: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    slackConnect: (input) => new Promise((resolve) => connects.push({ input, resolve })),
    slackConnectCancel: () => { calls.cancel += 1; },
    onSlackConnection: (callback) => { mainListener = callback; },
  } };
  const runtime = new Function("window", "document", "prefs", "timers", "clock", "calls", `
    const Date = { now: () => clock.now };
    const setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length; };
    const payload = { features: { slack: true }, account: { userId: "user_a", name: "Test" } };
    let activeView = "relays";
    let relaysLayout = "chats";
    let surfaceRenderDeferred = false;
    const REDUCED = true;
    const cardEl = { classList: { contains: () => false } };
    const rendererSurfaceActive = () => true;
    const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    const signupAccountKey = () => payload.account.userId;
    const protoPref = (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback;
    const setProtoPref = (key, value) => prefs.set(key, value);
    const commitNavigation = () => { calls.navigations += 1; };
    const renderSettings = () => { calls.settings += 1; };
    // The real renderRelays repaints the row through the intro, Chats only.
    const renderRelays = () => { calls.relays += 1; renderSlackNudge(relaysLayout === "chats"); };
    ${between("let slackConnectionInfo = null;", "const EXPANDED")}
    ${between("const SLACK_CONNECTION_POLL_MS", "function resetSignOutArm()")}
    ${between("function slackNudgeState()", "function renderSetupNudge()")}
    return {
      render: renderSlackNudge,
      refresh: refreshSlackConnection,
      state: slackNudgeState,
      setView: (view) => { activeView = view; },
      setLayout: (layout) => { relaysLayout = layout; },
      view: () => activeView,
      layout: () => relaysLayout,
      waiting: () => slackConnectionWaiting,
    };
  `)(window, document, prefs, timers, clock, calls);
  return {
    ...runtime, pending, connects, paints, timers, clock, calls, prefs,
    markup: () => markup,
    main: (info) => { assert.ok(mainListener, "the renderer listens for main's connection event"); mainListener(info); },
    click: (id) => {
      const handler = handlers.get(`${id}:click`);
      assert.ok(handler, `#${id} has a working click action`);
      handler({ stopPropagation() {} });
    },
  };
}

function assertNoConnect(markup) {
  assert.doesNotMatch(markup, /Bring your Slack chats here|>Connect</);
}

test("a delayed first connection check never paints the Connect row", async () => {
  const row = slackRow();
  row.render();
  const checking = row.refresh();
  for (let frame = 0; frame < 3; frame += 1) row.render();
  assert.equal(row.markup(), "", "unknown status is not a disconnected account");
  row.paints.forEach(assertNoConnect);

  row.pending[0].resolve({ ok: true, connection: connected });
  await checking;
  assert.equal(row.markup(), "", "an account that is already connected needs no row");
  row.paints.forEach(assertNoConnect);
});

test("only a successful disconnected or paused response shows the connect action", async () => {
  for (const state of ["disconnected", "paused"]) {
    const row = slackRow();
    row.render();
    assertNoConnect(row.markup());
    const checking = row.refresh();
    row.pending[0].resolve({ ok: true, connection: { state } });
    await checking;
    assert.match(row.markup(), new RegExp(`data-slack-nudge="${state === "paused" ? "paused" : "connect"}"`));
    if (state === "paused") {
      assert.match(row.markup(), /Reconnect your Slack/);
      assert.match(row.markup(), /class="rat-see">Reconnect</);
      assert.doesNotMatch(row.markup(), /slackNudgeHide/, "a paused connection cannot be waved away");
    } else {
      assert.match(row.markup(), /Bring your Slack chats here/);
      assert.match(row.markup(), /class="rat-see">Connect</);
      assert.match(row.markup(), /id="slackNudgeHide" aria-label="Not now"/);
    }
  }
});

test("failed initial checks stay unresolved and recover on the next check", async () => {
  for (const failure of ["response", "exception", "missing connection"]) {
    const row = slackRow();
    row.render();
    const checking = row.refresh();
    if (failure === "exception") row.pending[0].reject(new Error("Network unavailable"));
    else row.pending[0].resolve(failure === "response"
      ? { ok: false, error: "Network <unavailable>" }
      : { ok: true });
    await checking;
    assert.equal(row.state(), "", "a failed first check paints nothing rather than guessing");
    assert.equal(row.markup(), "");

    const retry = row.refresh();
    row.pending[1].resolve({ ok: true, connection: { state: "disconnected" } });
    await retry;
    assert.match(row.markup(), /data-slack-nudge="connect"/, "the next successful check resolves the row");
  }
});

test("refresh failures never take a connected account back to Connect", async () => {
  const row = slackRow();
  const initial = row.refresh();
  row.pending[0].resolve({ ok: true, connection: connected });
  await initial;
  assert.equal(row.markup(), "");
  row.setView("settings");
  row.setView("relays");
  row.render();
  const refreshing = row.refresh();
  row.pending[1].resolve({ ok: false, error: "Temporary outage" });
  await refreshing;
  assert.equal(row.markup(), "");
  row.paints.forEach(assertNoConnect);

  const disconnected = row.refresh();
  row.pending[2].resolve({ ok: true, connection: { state: "disconnected" } });
  await disconnected;
  assert.match(row.markup(), /Bring your Slack chats here/, "a confirmed disconnect still updates the row");
});

test("a late older disconnected response cannot replace a newer connected result", async () => {
  const row = slackRow();
  row.render();
  const older = row.refresh();
  const newer = row.refresh();
  row.pending[1].resolve({ ok: true, connection: connected });
  await newer;
  row.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await older;
  assert.equal(row.markup(), "");
  row.paints.forEach(assertNoConnect);
});

test("the row walks Connect → Click Allow → Slack is connected, then bows out", async () => {
  const row = slackRow();
  const initial = row.refresh();
  row.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await initial;
  row.click("slackNudgeGo");
  assert.match(row.markup(), /data-slack-nudge="opening"/);
  assert.match(row.markup(), /Click Allow in your browser/);
  assert.match(row.markup(), /id="slackNudgeGo" disabled/, "a second click cannot open a second browser tab");
  assert.deepEqual(row.connects[0].input, { mode: "combined" });
  row.connects[0].resolve({ ok: true, waiting: true });
  await Promise.resolve(); await Promise.resolve();
  assert.match(row.markup(), /data-slack-nudge="waiting"/);
  assert.match(row.markup(), /Click Allow in your browser/);
  assert.match(row.markup(), /class="rat-see">Open again</);
  assert.match(row.markup(), /id="slackNudgeHide" aria-label="Cancel"/);

  // "Open again" re-opens Slack's page instead of being swallowed by the pending flag.
  row.click("slackNudgeGo");
  assert.equal(row.connects.length, 2);
  row.connects[1].resolve({ ok: true, waiting: true });
  await Promise.resolve(); await Promise.resolve();

  // Main watched the connection and says yes before the renderer's own check.
  row.setLayout("received");
  row.main({ connection: connected, connected: true });
  assert.equal(row.layout(), "chats", "the person is taken to Chats to see their Slack arrive");
  assert.equal(row.prefs.get("relayRelaysLayout:user_a"), "chats");
  assert.match(row.markup(), /data-slack-nudge="connected"/);
  assert.match(row.markup(), /Slack is connected/);
  assert.match(row.markup(), /slack-nudge-check/);
  assertNoConnect(row.markup());
  assert.equal(row.waiting(), false);

  const bowOut = row.timers.find((timer) => timer.ms > 7000);
  assert.ok(bowOut, "the connected row schedules its own exit");
  row.clock.now += 7100;
  bowOut.callback();
  assert.equal(row.markup(), "", "the connected row leaves on its own");
});

test("Not now snoozes the row: gone for six hours, back the next time Relay opens", async () => {
  const prefs = new Map();
  const row = slackRow({ prefs });
  const initial = row.refresh();
  row.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await initial;
  row.click("slackNudgeHide");
  assert.equal(row.markup(), "");
  assert.equal(prefs.get("slackNudgeSnoozedUntil:user_a"), String(row.clock.now + 6 * 60 * 60 * 1000));
  assert.equal(row.calls.cancel, 1);

  // Relay restarted an hour later: still snoozed, for this account only.
  const soon = slackRow({ prefs });
  soon.clock.now = row.clock.now + 60 * 60 * 1000;
  const check = soon.refresh();
  soon.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await check;
  assert.equal(soon.markup(), "", "the snooze is remembered per account");

  // Seven hours later the row is back on the next open.
  const later = slackRow({ prefs });
  later.clock.now = row.clock.now + 7 * 60 * 60 * 1000;
  const back = later.refresh();
  later.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await back;
  assert.match(later.markup(), /Bring your Slack chats here/);
  assert.equal(prefs.get("slackNudgeSnoozedUntil:user_a"), "0");
});

test("a snooze that runs out while the pill is open waits for the next open", () => {
  const snooze = between("function slackNudgeSnoozed()", "function renderSlackNudge(");
  assert.match(snooze, /return slackNudgeSnoozedUntil > 0;/, "a stored snooze hides the row until something ends it");
  assert.match(html, /window\.relay\.onShown\(\(\) => \{[\s\S]*?slackNudgeSnoozed\(\) && wakeSlackNudge\(\)/, "showing the pill ends a snooze that ran out");
});

test("onboarding offers Slack once, between the first link and Grow your network", () => {
  const screen = between("  const SLACK_ONBOARDING_CONNECTED_MS", "  // OPEN RELAY (2026-09-13)");
  assert.match(screen, /payload\.features\?\.slack === true && Boolean\(window\.relay\.slackConnect\)\s*&& !\(slackConnectionLoaded && slackConnectionReady\(slackConnectionInfo\)\)/);
  assert.match(screen, /return slackOnboardingOffered\(\) \? "slack" : "network";/);
  // Not now there is the same Not now as the row's: one snooze.
  assert.match(screen, /suSlackLater"\)\?\.addEventListener\("click", \(\) => \{\s*snoozeSlackNudge\(\);/);
  assert.match(screen, /Bring your Slack here\./);
  assert.match(screen, /Your Slack is here\./);
  // Connecting during onboarding never yanks the person into the inbox.
  assert.match(html, /if \(info\.connected && activeView !== "threads" && !cardEl\.classList\.contains\("signup"\)\) \{/);
});

test("the row lives in Inbox › Chats only, and an open Inbox checks Slack once", () => {
  assert.match(html, /<div id="setupNudge"><\/div><div id="slackNudge"><\/div>/);
  assert.match(html, /renderSlackNudge\(visible && relaysLayout === "chats"\);/);
  assert.match(html, /if \(activeView === "relays" && payload\.features\?\.slack === true && viewChanged && !slackConnectionLoaded\) \{\s*refreshSlackConnection\(\{ preserveWaiting:true \}\);/);
  // A room repaints too: its "Not sent to Slack" note follows the connection.
  assert.match(html, /if \(activeView !== "settings" && activeView !== "relays" && activeView !== "threads"\) return false;/);
  assert.doesNotMatch(html, /id="slackTabConnect"|Connect your Slack to Relay\./);
});
