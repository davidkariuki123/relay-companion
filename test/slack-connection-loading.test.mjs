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

function slackSurface() {
  const pending = [];
  const paints = [];
  const handlers = new Map();
  const hidden = new Set();
  let markup = "";
  const list = {
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; paints.push(value); handlers.clear(); },
    querySelectorAll: () => [],
  };
  const empty = { classList: {
    add: (name) => hidden.add(name),
    toggle: (name, force) => force ? hidden.add(name) : hidden.delete(name),
  } };
  const document = {
    getElementById: (id) => markup.includes(`id="${id}"`)
      ? { addEventListener: (event, callback) => handlers.set(`${id}:${event}`, callback) }
      : null,
  };
  const window = { relay: {
    slackConnection: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  } };
  const runtime = new Function("window", "document", "slackListEl", "slackEmptyEl", `
    const payload = { features: { slack: true }, account: { name: "Test" } };
    let activeView = "slack";
    let surfaceRenderDeferred = false;
    const scrollEl = null;
    const slackListScrollTop = 0;
    const rendererSurfaceActive = () => true;
    const requestAnimationFrame = (callback) => callback();
    const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    const cvInitials = () => "T";
    const chatSections = () => ({ rooms: [{ name: "Test conversation" }] });
    const relayIdentityRowHtml = (room) => '<button class="relay-arrival">' + room.name + '</button>';
    ${between("let slackConnectionInfo = null;", "let slackDisconnectConfirm = false;")}
    ${between("const SLACK_CONNECTION_POLL_MS", "async function connectSlackFromSurface()")}
    ${between("function renderSlack()", "// ---- the split's rail")}
    const connectSlackFromSurface = () => {};
    const renderSettings = () => {};
    return {
      render: renderSlack,
      refresh: refreshSlackConnection,
      setView: (view) => { activeView = view; },
    };
  `)(window, document, list, empty);
  return {
    ...runtime, pending, paints,
    markup: () => markup,
    emptyHidden: () => hidden.has("gone"),
    clickRetry: () => {
      const retry = handlers.get("slackTabRetry:click");
      assert.ok(retry, "status errors have a working retry action");
      retry();
    },
  };
}

function assertNoConnect(markup) {
  assert.doesNotMatch(markup, /slackTabConnect|Connect your Slack to Relay\./);
}

test("a delayed first connection check never paints the disconnected page", async () => {
  const surface = slackSurface();
  surface.render();
  const checking = surface.refresh();
  for (let frame = 0; frame < 3; frame += 1) surface.render();
  assert.match(surface.markup(), /data-slack-connect-state="loading"/);
  assert.equal(surface.emptyHidden(), true, "unknown status is not an empty conversation list");
  surface.paints.forEach(assertNoConnect);

  surface.pending[0].resolve({ ok: true, connection: connected });
  await checking;
  assert.match(surface.markup(), /Test conversation/);
  surface.paints.forEach(assertNoConnect);
});

test("only a successful disconnected or paused response shows the connect action", async () => {
  for (const state of ["disconnected", "paused"]) {
    const surface = slackSurface();
    surface.render();
    assertNoConnect(surface.markup());
    const checking = surface.refresh();
    surface.pending[0].resolve({ ok: true, connection: { state } });
    await checking;
    assert.match(surface.markup(), /data-slack-connect-state="disconnected"/);
    assert.match(surface.markup(), state === "paused" ? /Reconnect Slack/ : /Connect Slack/);
  }
});

test("failed initial checks stay unresolved and recover through retry", async () => {
  for (const failure of ["response", "exception", "missing connection"]) {
    const surface = slackSurface();
    surface.render();
    const checking = surface.refresh();
    if (failure === "exception") surface.pending[0].reject(new Error("Network unavailable"));
    else surface.pending[0].resolve(failure === "response"
      ? { ok: false, error: "Network <unavailable>" }
      : { ok: true });
    await checking;
    assert.match(surface.markup(), /data-slack-connect-state="error"/);
    assertNoConnect(surface.markup());
    if (failure === "response") assert.match(surface.markup(), /Network &lt;unavailable>/);

    surface.clickRetry();
    assert.match(surface.markup(), /data-slack-connect-state="loading"/);
    surface.pending[1].resolve({ ok: true, connection: connected });
    await Promise.resolve();
    assert.match(surface.markup(), /Test conversation/);
    surface.paints.forEach(assertNoConnect);
  }
});

test("tab re-entry and refresh failures preserve a known connected conversation list", async () => {
  const surface = slackSurface();
  const initial = surface.refresh();
  surface.pending[0].resolve({ ok: true, connection: connected });
  await initial;
  const connectedMarkup = surface.markup();
  surface.setView("relays");
  surface.setView("slack");
  surface.render();
  const refreshing = surface.refresh();
  assert.equal(surface.markup(), connectedMarkup);
  surface.pending[1].resolve({ ok: false, error: "Temporary outage" });
  await refreshing;
  assert.equal(surface.markup(), connectedMarkup);
  surface.paints.forEach(assertNoConnect);

  const disconnected = surface.refresh();
  surface.pending[2].resolve({ ok: true, connection: { state: "disconnected" } });
  await disconnected;
  assert.match(surface.markup(), /slackTabConnect/, "a confirmed disconnect still updates the tab");
});

test("a late older disconnected response cannot replace a newer connected result", async () => {
  const surface = slackSurface();
  surface.render();
  const older = surface.refresh();
  const newer = surface.refresh();
  surface.pending[1].resolve({ ok: true, connection: connected });
  await newer;
  surface.pending[0].resolve({ ok: true, connection: { state: "disconnected" } });
  await older;
  assert.match(surface.markup(), /Test conversation/);
  surface.paints.forEach(assertNoConnect);
});
