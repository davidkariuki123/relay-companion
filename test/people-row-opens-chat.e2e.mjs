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
// Jordan has none: his resolved empty chat must still open in the main pill.
// Deborah's canonical chat has a two-document Relay but no local inbox/Sent
// projection, reproducing the production race from her video.
// Blair has no address at all — there is nowhere to write, and the row has to
// say so rather than swallowing the click.
const contacts = [
  { id: "c_sven", name: "Sven Wellmann", email: "sven@example.com", emails: ["sven@example.com"], onRelay: true, updatedAt: at },
  { id: "c_jordan", name: "Jordan Nel", email: "jordan@example.com", emails: ["jordan@example.com"], onRelay: false, updatedAt: at },
  { id: "c_deborah", name: "Deborah Nyaundi", email: "deb@example.com", emails: ["deb@example.com"], onRelay: true, updatedAt: at },
  { id: "c_slow", name: "Slow Contact", email: "slow@example.com", emails: ["slow@example.com"], onRelay: true, updatedAt: at },
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
let jordanSent = false;
let deborahRead = false;
let deborahReadAttempts = 0;
const deborahChat = () => ({
  chatId:"chat_deborah",
  title:"Deborah Nyaundi",
  kind:"direct",
  participants:[
    { id:"fixture", name:"Fixture", email:"fixture@example.com", self:true },
    { id:"deborah", name:"Deborah Nyaundi", email:"deb@example.com", self:false },
  ],
  threadIds:["thread_deborah"],
  unreadCount:deborahRead ? 0 : 1,
  messageCount:2,
  updatedAt:"2026-08-19T08:02:00.000Z",
  items:[
    {
      relayId:"relay_deborah_in", threadId:"thread_deborah", state:deborahRead ? "read" : "delivered", direction:"inbound",
      title:"Details for the letter", forHuman:"Please send the company details.",
      forAgent:"Collect the legal name, dates, duties, and signer details.",
      sender:{ name:"Deborah Nyaundi", email:"deb@example.com" },
      createdAt:"2026-08-19T08:01:00.000Z", updatedAt:"2026-08-19T08:01:00.000Z",
      attachments:[], reactions:{ aggregates:[], events:[] },
    },
    {
      relayId:"relay_deborah_out", threadId:"thread_deborah", state:"delivered", direction:"outbound",
      title:"Letter details ready", forHuman:"I have the requested company details.",
      forAgent:"Use the verified details to prepare the final letter.",
      sender:{ name:"Fixture", email:"fixture@example.com" },
      createdAt:"2026-08-19T08:02:00.000Z", updatedAt:"2026-08-19T08:02:00.000Z",
      attachments:[], reactions:{ aggregates:[], events:[] }, readReceipts:[],
    },
  ],
});
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
    if (url.pathname === "/v1/relays" && request.method === "POST") {
      const sent = JSON.parse(body || "{}");
      if (sent?.recipient?.email === "jordan@example.com") {
        jordanSent = true;
        return json(response, 200, { relayId:"relay_jordan_first", threadId:"thread_jordan_first" });
      }
      return json(response, 200, { relayId:"relay_quiet_first", groupSendId:"gsend_quiet", threadId:`group-room:${GROUP_WITHOUT_ROOM}` });
    }
    if (url.pathname === "/v1/sent" && request.method === "GET") {
      return json(response, 200, { items:jordanSent ? [{
        relayId:"relay_jordan_first", threadId:"thread_jordan_first", kind:"message",
        title:"", forHuman:"first direct message", forAgent:"",
        recipient:{ email:"jordan@example.com", name:"Jordan Nel" },
        state:"delivered", createdAt:"2026-08-19T08:03:00.000Z", updatedAt:"2026-08-19T08:03:00.000Z",
      }] : [] });
    }
    if (url.pathname === "/v1/chats/resolve") {
      const requested = JSON.parse(body || "{}");
      if (requested.email === "deb@example.com") {
        return json(response, 200, deborahChat());
      }
      if (requested.email === "slow@example.com") {
        return setTimeout(() => json(response, 200, {
          chatId:"chat_slow", title:"Slow Contact", kind:"direct",
          participants:[
            { id:"fixture", name:"Fixture", email:"fixture@example.com", self:true },
            { id:"slow", name:"Slow Contact", email:"slow@example.com", self:false },
          ],
          items:[], threadIds:[], unreadCount:0, messageCount:0, updatedAt:at,
        }), 500);
      }
      return json(response, 200, {
        chatId:"chat_jordan", title:"Jordan Nel", kind:"direct",
        participants:[
          { id:"fixture", name:"Fixture", email:"fixture@example.com", self:true },
          { id:"jordan", name:"Jordan Nel", email:"jordan@example.com", self:false },
        ],
        items:[], threadIds:[], unreadCount:0, messageCount:0, updatedAt:at,
      });
    }
    if (url.pathname === "/v1/chats/chat_deborah/read" && request.method === "POST") {
      deborahReadAttempts += 1;
      if (deborahReadAttempts <= 2) return json(response, 503, { error:"temporary read failure" });
      deborahRead = true;
      return json(response, 200, { ok:true });
    }
    if (url.pathname === "/v1/chats/chat_deborah" && request.method === "GET") {
      return json(response, 200, deborahChat());
    }
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

  // A slow server answer from an earlier contact cannot steal navigation from
  // the person the user chose afterward.
  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_slow"]').click(); document.querySelector('.cv-item[data-contact="c_sven"]').click(); true`);
  await until(page, `activeView === "threads" && document.getElementById("thDetailName").textContent.includes("Sven")`, "Sven to win over the slow contact resolve");
  await sleep(700);
  const afterSlowResolve = await evaluate(page, `({ view:activeView, name:document.getElementById("thDetailName").textContent, slowAnchor:contactChatAnchors.has("chat_slow") })`);
  check("a stale contact resolve cannot navigate over a later room", () => {
    assert.equal(afterSlowResolve.view, "threads");
    assert.match(afterSlowResolve.name, /Sven/);
    assert.equal(afterSlowResolve.slowAnchor, false);
  });
  await evaluate(page, `document.getElementById("thBack").click(); true`);
  await until(page, `activeView === "contacts"`, "Back from the stale resolve check");

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

  // ---- People: an empty contact resolves into the SAME main-pill chat ----
  const resolvesBefore = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve").length;
  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_jordan"]').click(); true`);
  await until(page, `activeView === "threads" && threadsSource === "contacts" && document.getElementById("thDetailName").textContent === "Jordan Nel"`, "Jordan's empty room in the main pill");
  const resolves = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve");
  check("a person nobody has written to still opens: the room resolves server-side", () => {
    assert.equal(resolves.length, resolvesBefore + 1, "the row must ask for the room");
    assert.match(resolves[resolves.length - 1].body, /jordan@example\.com/);
  });
  const afterResolve = await evaluate(page, SNAPSHOT);
  const previewsAfterResolve = await evaluate(main, "global.__relayTest.state().previews.length");
  check("an empty direct chat opens in the main pill and never creates Preview", () => {
    assert.equal(afterResolve.view, "threads");
    assert.equal(afterResolve.source, "contacts");
    assert.deepEqual(afterResolve.litTab, ["contacts"]);
    assert.equal(previewsAfterResolve, 0);
  });
  await evaluate(page, `(() => { const input = document.getElementById("thQrInput"); input.value = "first direct message"; input.dispatchEvent(new Event("input", { bubbles:true })); document.getElementById("thQrSend").click(); return true; })()`);
  await until(page, `[...document.querySelectorAll(".th-msg-title")].some((node) => node.textContent.includes("first direct message"))`, "the first direct message to stay visible");
  for (let i = 0; i < 60 && !apiCalls.some((c) => c.pathname === "/v1/relays" && c.method === "POST" && c.body.includes("first direct message")); i += 1) await sleep(100);
  const firstDirectSend = apiCalls.find((c) => c.pathname === "/v1/relays" && c.method === "POST" && c.body.includes("first direct message"));
  check("the empty direct chat's first message addresses the person's email", () => {
    assert.ok(firstDirectSend, "the first direct message must reach the send endpoint");
    const sent = JSON.parse(firstDirectSend.body);
    assert.equal(sent.recipient.email, "jordan@example.com");
    assert.equal(sent.recipient.groupId, undefined);
    assert.equal(sent.recipient.chatId, undefined);
  });
  await evaluate(page, `window.relay.refreshSent().then(() => true)`);
  await until(page, `(payload.sent || []).some((row) => row.relayId === "relay_jordan_first")`, "the first direct message to enter Sent");
  const afterFirstHydration = await evaluate(page, `({
    view:activeView,
    threadDetailId,
    name:document.getElementById("thDetailName").textContent,
    composer:Boolean(document.getElementById("thQrInput")),
    loading:document.getElementById("thDetail").textContent.includes("Loading conversation"),
    messages:document.querySelectorAll("#thHistory .th-msg").length,
  })`);
  check("Sent hydration keeps the first-message direct chat open and composable", () => {
    assert.equal(afterFirstHydration.view, "threads");
    assert.equal(afterFirstHydration.threadDetailId, "direct-chat:chat_jordan");
    assert.equal(afterFirstHydration.name, "Jordan Nel");
    assert.equal(afterFirstHydration.composer, true);
    assert.equal(afterFirstHydration.loading, false);
    assert.ok(afterFirstHydration.messages >= 1);
  });
  await evaluate(page, `document.getElementById("thBack").click(); true`);
  await until(page, `activeView === "contacts"`, "Back from Jordan to return to People");

  // ---- Deborah's exact bug: canonical two-document Relays before Sent hydration ----
  await evaluate(page, `document.querySelector('.cv-item[data-contact="c_deborah"]').click(); true`);
  await until(page, `activeView === "threads" && Boolean(document.querySelector('[data-msg="relay_deborah_in"]')) && Boolean(document.querySelector('[data-msg="relay_deborah_out"]'))`, "Deborah's canonical Relays in the main chat");
  for (let i = 0; i < 100 && deborahReadAttempts < 2; i += 1) await sleep(100);
  await until(page, `canonicalChatDetails.get("chat_deborah")?.items?.find((item) => item.relayId === "relay_deborah_in")?.state === "delivered"`, "server unread truth after the bounded retry");
  await sleep(800);
  const boundedReadFailure = await evaluate(page, `(() => {
    const chat = canonicalChatDetails.get("chat_deborah");
    const anchor = contactChatAnchors.get("chat_deborah");
    return {
      canonicalState:(chat.items || []).find((item) => item.relayId === "relay_deborah_in")?.state,
      anchorUnread:anchor.unreadCount,
      failures:[...canonicalReadFailures.values()].map((state) => state.attempts),
    };
  })()`);
  check("persistent read failure is bounded and restores server unread truth", () => {
    assert.equal(deborahReadAttempts, 2, "only one immediate retry is allowed");
    assert.equal(boundedReadFailure.canonicalState, "delivered");
    assert.equal(boundedReadFailure.anchorUnread, 1);
    assert.deepEqual(boundedReadFailure.failures, [2]);
  });
  await evaluate(page, `(() => {
    for (const state of canonicalReadFailures.values()) state.retryAfter = 0;
    readVisibleChatRoom();
    return true;
  })()`);
  for (let i = 0; i < 100 && deborahReadAttempts < 3; i += 1) await sleep(100);
  await until(page, `canonicalChatDetails.get("chat_deborah")?.items?.find((item) => item.relayId === "relay_deborah_in")?.state === "read"`, "the retried canonical read to settle");
  const afterCanonicalRead = await evaluate(page, `(() => {
    const chat = canonicalChatDetails.get("chat_deborah");
    const anchor = contactChatAnchors.get("chat_deborah");
    return {
      canonicalState:(chat.items || []).find((item) => item.relayId === "relay_deborah_in")?.state,
      canonicalUnread:chat.unreadCount,
      anchorUnread:anchor.unreadCount,
      messageUnread:(anchor.msgs || []).find((item) => item.id === "relay_deborah_in")?.unread,
    };
  })()`);
  check("the visible direct chat can retry successfully after the cooldown", () => {
    assert.equal(deborahReadAttempts, 3);
    assert.equal(deborahRead, true);
    assert.equal(afterCanonicalRead.canonicalState, "read");
    assert.equal(afterCanonicalRead.canonicalUnread, 0);
    assert.equal(afterCanonicalRead.anchorUnread, 0);
    assert.equal(afterCanonicalRead.messageUnread, false);
  });
  const beforeDocumentOpen = await evaluate(page, `({ sentIds:(payload.sent || []).map((row) => row.relayId || row.id), previews:0, buttons:document.querySelectorAll('#thHistory .th-msg[role="button"]').length })`);
  check("canonical Relays paint as reader buttons before Sent hydration", () => {
    assert.equal(beforeDocumentOpen.sentIds.includes("relay_deborah_in"), false);
    assert.equal(beforeDocumentOpen.sentIds.includes("relay_deborah_out"), false);
    assert.equal(beforeDocumentOpen.buttons, 2);
  });
  await evaluate(page, `document.querySelector('[data-msg="relay_deborah_in"]').click(); true`);
  await until(page, `activeView === "reader" && readerId === "relay_deborah_in"`, "Deborah's inbound Relay reader");
  const inboundReader = await evaluate(page, `({
    names:[...document.querySelectorAll('.relay-contents-name')].map((node) => node.textContent),
    body:document.getElementById('readerBody').textContent,
  })`);
  check("clicking Deborah's Relay opens both main-reader documents", () => {
    assert.deepEqual(inboundReader.names, ["Message for you", "Message for your agent"]);
    assert.match(inboundReader.body, /Please send the company details/);
  });
  await evaluate(page, `document.getElementById("readerBack").click(); true`);
  await until(page, `activeView === "threads"`, "Back to Deborah's chat");
  await evaluate(page, `document.querySelector('[data-msg="relay_deborah_out"]').click(); true`);
  await until(page, `activeView === "reader" && readerId === "relay_deborah_out"`, "Deborah's outbound Relay reader without Sent cache");
  const outboundReader = await evaluate(page, `({
    names:[...document.querySelectorAll('.relay-contents-name')].map((node) => node.textContent),
    body:document.getElementById('readerBody').textContent,
  })`);
  const previewsAfterDocuments = await evaluate(main, "global.__relayTest.state().previews.length");
  check("the outbound canonical Relay also opens without the Sent cache", () => {
    assert.deepEqual(outboundReader.names, ["Message for you", "Message for your agent"]);
    assert.match(outboundReader.body, /requested company details/);
    assert.equal(previewsAfterDocuments, 0);
  });
  await evaluate(page, `document.getElementById("readerBack").click(); document.getElementById("thBack").click(); true`);
  await until(page, `activeView === "contacts"`, "Back from Deborah to People");

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
  // ---- Groups: a saved group is already an in-pill room before first send ----
  const groupResolvesBefore = apiCalls.filter((c) => c.pathname === "/v1/chats/resolve" && c.body.includes(GROUP_WITHOUT_ROOM)).length;
  await evaluate(page, `document.querySelector('.cvg-item[data-group="${GROUP_WITHOUT_ROOM}"]').click(); true`);
  await until(page, `activeView === "threads" && document.getElementById("thDetailName").textContent === "Quiet Room"`, "the empty group to open in the pill");
  await sleep(450); // capture the settled expanded frame, not the list-to-room morph
  await shoot(page, "7-empty-group-room");
  const quietRoom = await evaluate(page, SNAPSHOT);
  check("an empty group opens in the same expanded pill, never a detached window", () => {
    assert.equal(quietRoom.view, "threads");
    assert.equal(quietRoom.source, "contacts");
    assert.equal(apiCalls.filter((c) => c.pathname === "/v1/chats/resolve" && c.body.includes(GROUP_WITHOUT_ROOM)).length, groupResolvesBefore);
  });
  await evaluate(page, `(() => { const input = document.getElementById("thQrInput"); input.value = "first quiet message"; input.dispatchEvent(new Event("input", { bubbles:true })); document.getElementById("thQrSend").click(); return true; })()`);
  await until(page, `[...document.querySelectorAll(".th-msg-title")].some((node) => node.textContent.includes("first quiet message"))`, "the first group message to stay visible");
  await sleep(450); // the optimistic bubble must remain after the follow-scroll settles
  await shoot(page, "8-empty-group-first-send");
  for (let i = 0; i < 60 && !apiCalls.some((c) => c.pathname === "/v1/relays" && c.method === "POST" && c.body.includes("first quiet message")); i += 1) await sleep(100);
  const firstGroupSend = apiCalls.find((c) => c.pathname === "/v1/relays" && c.method === "POST" && c.body.includes("first quiet message"));
  check("the empty room's first message addresses the saved group", () => {
    assert.ok(firstGroupSend, "the first message must reach the send endpoint");
    assert.equal(JSON.parse(firstGroupSend.body).recipient.groupId, GROUP_WITHOUT_ROOM);
  });
  const accountSwitch = await evaluate(page, `(() => {
    const before = { anchors:contactChatAnchors.size, canonical:canonicalChatDetails.size };
    onPayload({ ...payload, account:{ paired:true, userId:"other-account", email:"other@example.com" } });
    return { before, after:{ anchors:contactChatAnchors.size, canonical:canonicalChatDetails.size }, opening:cvOpeningKey };
  })()`);
  check("switching accounts clears resolved direct chats and their documents", () => {
    assert.ok(accountSwitch.before.anchors >= 2);
    assert.ok(accountSwitch.before.canonical >= 2);
    assert.deepEqual(accountSwitch.after, { anchors:0, canonical:0 });
    assert.equal(accountSwitch.opening, null);
  });
} finally {
  try { page && page.close(); } catch {}
  try { main && main.close(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
}

console.log(`\npeople-row-opens-chat\n${results.join("\n")}\n`);
if (process.exitCode) console.log(`overlay log:\n${log}`);
