// Live gate for "a row in People is a door to talking".
//
// Static assertions can prove the handler is wired; they cannot prove that a
// click on the row reaches it, that a click on Edit does NOT, or that the tab
// strip keeps People lit once the room is open. This boots the real Electron
// overlay against an isolated home and a tiny local API, then clicks the real
// rows over CDP and reads the real state back.
//
// Outside npm test by design: run it on macOS with a GUI session.
//   node test/people-row-opens-chat.e2e.mjs

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, "..");
const electron = process.env.RELAY_PEOPLE_ROW_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron is unavailable; install workspace dependencies first");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-people-row-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const at = "2026-08-19T08:00:00.000Z";
const GROUP_WITH_ROOM = "grp_granular";
const GROUP_WITHOUT_ROOM = "grp_quiet";

// Sven has correspondence, so his room lives in the pill's own transcript.
// Jordan has none: his row must fall through to the resolved chat window.
// Blair has no address at all — there is nowhere to write, and the row has to
// say so rather than swallowing the click.
const contacts = [
  { id: "c_sven", name: "Sven Wellmann", email: "sven@example.com", emails: ["sven@example.com"], onRelay: true, updatedAt: at },
  { id: "c_jordan", name: "Jordan Nel", email: "jordan@example.com", emails: ["jordan@example.com"], onRelay: false, updatedAt: at },
  { id: "c_blair", name: "Blair Peer", email: "", emails: [], onRelay: false, updatedAt: at },
];
const groups = [
  {
    id: GROUP_WITH_ROOM, name: "Granular", memberCount: 2, owned: true,
    owner: { userId: "fixture", name: "Fixture", email: "fixture@example.com" },
    members: [
      { contactId: "c_sven", name: "Sven Wellmann", email: "sven@example.com" },
      { contactId: "c_jordan", name: "Jordan Nel", email: "jordan@example.com" },
    ],
    createdAt: at, updatedAt: at,
  },
  {
    id: GROUP_WITHOUT_ROOM, name: "Quiet Room", memberCount: 1, owned: true,
    owner: { userId: "fixture", name: "Fixture", email: "fixture@example.com" },
    members: [{ contactId: "c_blair", name: "Blair Peer", email: "" }],
    createdAt: at, updatedAt: at,
  },
];

const apiCalls = [];
const json = (response, status, body) => {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": String(data.length) });
  response.end(data);
};
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    apiCalls.push({ method: request.method, pathname: url.pathname, body });
    if (url.pathname === "/v1/contact-groups") return json(response, 200, { groups });
    if (url.pathname === "/v1/chats/resolve") return json(response, 200, { chatId: "chat_resolved", title: "Jordan Nel", items: [] });
    if (url.pathname.startsWith("/v1/chats/")) return json(response, 200, { chatId: "chat_resolved", title: "", items: [] });
    return json(response, 200, { contacts: [], relays: [], sent: [], items: [] });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

fs.writeFileSync(path.join(sandbox, "contacts.json"), JSON.stringify(contacts));
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "people_row_fixture",
  deviceId: "people_row_fixture",
  deviceName: "People row fixture",
  user: { id: "fixture", name: "Fixture", email: "fixture@example.com" },
}));
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "Fixture", transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    relay_from_sven: {
      direction: "inbound", state: "read", relayNotificationKind: "plain_relay",
      senderName: "Sven Wellmann", senderEmail: "sven@example.com",
      threadId: "thread_sven",
      title: "", forHuman: "The room with Sven already exists.",
      createdAt: at, updatedAt: at,
    },
    relay_from_granular: {
      direction: "inbound", state: "read", relayNotificationKind: "plain_relay",
      senderName: "Sven Wellmann", senderEmail: "sven@example.com",
      recipientGroupId: GROUP_WITH_ROOM, recipientGroupName: "Granular",
      groupSendId: "send_granular", threadId: "thread_granular",
      title: "", forHuman: "The Granular room already exists.",
      createdAt: at, updatedAt: at,
    },
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));

const mainPort = Number(process.env.RELAY_PEOPLE_ROW_MAIN_PORT || 9481);
const rendererPort = Number(process.env.RELAY_PEOPLE_ROW_RENDERER_PORT || 9482);
const child = spawn(electron, [
  `--inspect=${mainPort}`,
  `--remote-debugging-port=${rendererPort}`,
  path.join(packageRoot, "overlay/main.cjs"),
], {
  env: {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_CONFIG: path.join(sandbox, "config.json"),
    RELAY_OVERLAY_USER_DATA: userData,
    RELAY_OVERLAY_TEST: "1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
    RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
    RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
    RELAY_OVERLAY_TEST_CONTACTS_FIXTURES: path.join(sandbox, "contacts.json"),
    RELAY_API_URL: apiUrl,
    RELAY_WEB_URL: apiUrl,
    RELAY_AUTO_UPDATE: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonEventually(url) {
  let last;
  for (let i = 0; i < 80; i += 1) {
    try { return await (await fetch(url)).json(); } catch (error) { last = error; await sleep(100); }
  }
  throw last;
}
async function connect(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id || !waiting.has(message.id)) return;
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        waiting.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function until(connection, expression, label) {
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(connection, expression)) return true;
    await sleep(100);
  }
  let where = "";
  try {
    where = JSON.stringify(await evaluate(connection, `({
      view: typeof activeView === "string" ? activeView : null,
      contacts: typeof contactsList !== "undefined" ? contactsList.length : null,
      groups: typeof groupsList !== "undefined" ? groupsList.length : null,
      pane: typeof contactsPane !== "undefined" ? contactsPane : null,
      cvListHtml: document.getElementById("cvList") ? document.getElementById("cvList").innerHTML.slice(0, 400) : null,
      cvgListHtml: document.getElementById("cvgList") ? document.getElementById("cvgList").innerHTML.slice(0, 400) : null,
      relays: typeof payload !== "undefined" ? (payload.relays || []).length : null,
    })`));
  } catch (error) { where = `diagnostic failed: ${error.message}`; }
  throw new Error(`timed out waiting for ${label}: ${expression}\n  state: ${where}`);
}
// What the pill is showing, in the terms the assertions are written in.
// The tab strip is static markup: it is in the DOM before the renderer script
// has wired a single listener, so a one-shot click can land on nothing. Click
// until the app agrees it happened.
async function clickUntil(connection, selector, condition, label) {
  for (let i = 0; i < 100; i += 1) {
    // The condition reads renderer state that does not exist until the script
    // has run; a miss there is "not yet", not a failure.
    let met = false;
    try { met = await evaluate(connection, condition); } catch { met = false; }
    if (met) return true;
    await evaluate(connection, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
    await sleep(100);
  }
  throw new Error(`timed out clicking ${selector} for ${label}`);
}
const SNAPSHOT = `({
  view: activeView,
  source: threadsSource,
  litTab: [...document.querySelectorAll(".tab")].filter((t) => t.classList.contains("active")).map((t) => t.getAttribute("data-view")),
  cardOpen: !cvFormEl.classList.contains("hidden"),
  roomName: document.getElementById("thDetailName").textContent,
  peopleError: (document.getElementById("cvPeopleError") || {}).textContent || "",
  groupError: (document.getElementById("cvgError") || {}).textContent || "",
  groupDetailOpen: !document.getElementById("cvgDetail").classList.contains("gone"),
  expandedGroup: typeof cvgExpandedId === "undefined" ? null : cvgExpandedId,
})`;

const shots = process.env.RELAY_PEOPLE_ROW_SHOTS || "";
async function shoot(connection, name) {
  if (!shots) return;
  const result = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(result.data, "base64"));
}

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(`  PASS  ${name}`); }
  catch (error) { results.push(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`); process.exitCode = 1; }
};

let main;
let page;
try {
  const mainTargets = await jsonEventually(`http://127.0.0.1:${mainPort}/json/list`);
  main = await connect(mainTargets[0].webSocketDebuggerUrl);
  let target = null;
  for (let i = 0; i < 80 && !target; i += 1) {
    const pages = await jsonEventually(`http://127.0.0.1:${rendererPort}/json/list`);
    target = pages.find((entry) => entry.type === "page" && /inbox\.html/.test(entry.url));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Relay renderer target was not found");
  page = await connect(target.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await evaluate(main, "global.__relayTest.showFromTray(); true");
  await until(page, `typeof activeView === "string" && Boolean(document.querySelector('[data-view="contacts"]'))`, "the renderer to come up");

  // ---- People: the row is the door to talking ----
  await clickUntil(page, '[data-view="contacts"]', `activeView === "contacts"`, "People");
  await until(page, `Boolean(document.querySelector('.cv-item[data-contact="c_sven"]'))`, "the people list");

  // The Edit control is a hover affordance; force it visible for the record.
  await evaluate(page, `(() => {
    const style = document.createElement("style");
    style.id = "probe-hover";
    style.textContent = '.cv-item[data-contact="c_sven"] .cv-edit, .cvg-item[data-group="${GROUP_WITH_ROOM}"] .cvg-edit { opacity:1; color:var(--ink-2); }';
    document.head.appendChild(style);
    return true;
  })()`);
  await sleep(400);
  await shoot(page, "1-people-list");
  const beforeRow = await evaluate(page, SNAPSHOT);
  check("People opens with the card shut", () => {
    assert.equal(beforeRow.view, "contacts");
    assert.deepEqual(beforeRow.litTab, ["contacts"]);
    assert.equal(beforeRow.cardOpen, false);
  });

  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_sven"]').click(); true`);
  await until(page, `activeView === "threads"`, "the room to open");
  await sleep(500);
  await shoot(page, "2-person-room");
  const inRoom = await evaluate(page, SNAPSHOT);
  check("a person's row opens the conversation, not the edit card", () => {
    assert.equal(inRoom.view, "threads");
    assert.equal(inRoom.cardOpen, false, "the edit card must stay shut");
    assert.match(inRoom.roomName, /Sven/);
  });
  check("the room keeps People lit — it is the same room, reached another way", () => {
    assert.equal(inRoom.source, "contacts");
    assert.deepEqual(inRoom.litTab, ["contacts"], "Relays must not steal the highlight");
  });

  await evaluate(page, `document.getElementById("thBack").click(); true`);
  await until(page, `activeView === "contacts"`, "Back to return to People");
  const afterBack = await evaluate(page, SNAPSHOT);
  check("Back returns to People, not to Relays", () => {
    assert.equal(afterBack.view, "contacts");
    assert.deepEqual(afterBack.litTab, ["contacts"]);
  });

  // ---- People: Edit, and only Edit, opens the card ----
  await until(page, `Boolean(document.querySelector('[data-contact-edit="c_sven"]'))`, "the Edit control");
  await evaluate(page, `document.querySelector('[data-contact-edit="c_sven"]').click(); true`);
  await sleep(300);
  await shoot(page, "3-edit-card");
  const afterEdit = await evaluate(page, SNAPSHOT);
  check("Edit opens the card and stays on People", () => {
    assert.equal(afterEdit.cardOpen, true, "the card must open");
    assert.equal(afterEdit.view, "contacts", "Edit must not open a room behind the form");
  });
  await evaluate(page, `document.getElementById("cvCancel").click(); true`);
  await until(page, `cvFormEl.classList.contains("hidden")`, "the card to close");

  // ---- People: Edit answers the keyboard too ----
  // The row is a <button> and answers Enter natively; now that the two do
  // different things, the card must be reachable without a mouse.
  // Focus is read in the same turn as the dispatch: a background payload push
  // re-renders the list and would take the node (and the focus) with it.
  const keyEdit = await evaluate(page, `(() => {
    const el = document.querySelector('[data-contact-edit="c_sven"]');
    el.focus();
    const focused = document.activeElement === el;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { focused };
  })()`);
  await sleep(300);
  const afterKeyEdit = await evaluate(page, SNAPSHOT);
  check("Edit is focusable and answers Enter", () => {
    assert.equal(keyEdit.focused, true, "the control must take focus");
    assert.equal(afterKeyEdit.cardOpen, true);
    assert.equal(afterKeyEdit.view, "contacts");
  });
  await evaluate(page, `document.getElementById("cvCancel").click(); true`);
  await until(page, `cvFormEl.classList.contains("hidden")`, "the card to close again");

  // ---- People: a contact with nowhere to write says so ----
  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_blair"]').click(); true`);
  await sleep(300);
  await shoot(page, "4-no-address");
  const noAddress = await evaluate(page, SNAPSHOT);
  check("a contact with no address explains the dead click", () => {
    assert.equal(noAddress.view, "contacts");
    assert.match(noAddress.peopleError, /no address to write to/);
  });

  // ---- People: a contact with no correspondence resolves a room server-side ----
  const resolvesBefore = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve").length;
  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_jordan"]').click(); true`);
  for (let i = 0; i < 60 && apiCalls.filter((c) => c.pathname === "/v1/chats/resolve").length === resolvesBefore; i += 1) await sleep(100);
  const resolves = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve");
  check("a person nobody has written to still opens: the room resolves server-side", () => {
    assert.equal(resolves.length, resolvesBefore + 1, "the row must ask for the room");
    assert.match(resolves[resolves.length - 1].body, /jordan@example\.com/);
  });
  const afterResolve = await evaluate(page, SNAPSHOT);
  check("and the pill itself does not navigate on that path", () => {
    assert.equal(afterResolve.view, "contacts");
  });

  // ---- Groups: the row is the room its roster names ----
  await clickUntil(page, "#cvSegGroups", `contactsPane === "groups"`, "the Groups pane");
  await until(page, `Boolean(document.querySelector('.cvg-item[data-group="${GROUP_WITH_ROOM}"]'))`, "the groups list");

  await sleep(400);
  await shoot(page, "5-groups-list");
  await evaluate(page, `document.querySelector('[data-group-edit="${GROUP_WITH_ROOM}"]').click(); true`);
  await sleep(300);
  await shoot(page, "5b-group-roster");
  const afterGroupEdit = await evaluate(page, SNAPSHOT);
  check("a group's Edit expands its roster and stays on People", () => {
    assert.equal(afterGroupEdit.expandedGroup, GROUP_WITH_ROOM);
    assert.equal(afterGroupEdit.groupDetailOpen, true);
    assert.equal(afterGroupEdit.view, "contacts", "Edit must not open the room behind the roster");
  });
  await evaluate(page, `document.querySelector('[data-group-edit="${GROUP_WITH_ROOM}"]').click(); true`);
  await until(page, `cvgExpandedId === null`, "the roster to collapse");

  await evaluate(page, `document.querySelector('.cvg-item[data-group="${GROUP_WITH_ROOM}"]').click(); true`);
  await until(page, `activeView === "threads"`, "the group room to open");
  await sleep(500);
  await shoot(page, "6-group-room");
  const inGroupRoom = await evaluate(page, SNAPSHOT);
  check("a group's row opens its conversation, with People still lit", () => {
    assert.equal(inGroupRoom.view, "threads");
    assert.equal(inGroupRoom.source, "contacts");
    assert.deepEqual(inGroupRoom.litTab, ["contacts"]);
    assert.match(inGroupRoom.roomName, /Granular/);
  });

  await evaluate(page, `document.getElementById("thBack").click(); true`);
  await until(page, `activeView === "contacts"`, "Back to return to Groups");

  const backToGroups = await evaluate(page, `({ view: activeView, groupsPane: !document.getElementById("cvGroups").classList.contains("gone") })`);
  check("Back from a group room returns to the Groups pane it was clicked in", () => {
    assert.equal(backToGroups.view, "contacts");
    assert.equal(backToGroups.groupsPane, true);
  });
  // ---- Groups: a group nothing has been said in resolves server-side too ----
  const groupResolvesBefore = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve" && c.body.includes(GROUP_WITHOUT_ROOM)).length;
  await evaluate(page, `document.querySelector('.cvg-item[data-group="${GROUP_WITHOUT_ROOM}"]').click(); true`);
  for (let i = 0; i < 60 && apiCalls.filter((c) => c.pathname === "/v1/chats/resolve" && c.body.includes(GROUP_WITHOUT_ROOM)).length === groupResolvesBefore; i += 1) await sleep(100);
  const groupResolves = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve" && c.body.includes(GROUP_WITHOUT_ROOM));
  check("an empty group still opens: its room resolves server-side by id", () => {
    assert.equal(groupResolves.length, groupResolvesBefore + 1, "the row must ask for the room");
  });
} finally {
  try { page && page.close(); } catch {}
  try { main && main.close(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
}

console.log(`\npeople-row-opens-chat\n${results.join("\n")}\n`);
if (process.exitCode) console.log(`overlay log:\n${log}`);
