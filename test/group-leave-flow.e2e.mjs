// GUI end-to-end proof for the shared group details and self-leave flow.
// Intentionally outside npm test: it boots the real Electron overlay and needs
// a macOS GUI session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, "..");
const electron = process.env.RELAY_GROUP_LEAVE_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron is unavailable; install workspace dependencies first");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-group-leave-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const now = "2026-08-17T15:00:00.000Z";
const groupId = "grp_group_leave_fixture";
let left = false;
const requests = [];
const group = {
  id: groupId,
  name: "Bugs and Features",
  memberCount: 3,
  owned: false,
  owner: { userId: "user_shane", name: "Shane Acton", email: "shane@example.com" },
  members: [
    { contactId: "contact_david", name: "David Kariuki", email: "david@example.com" },
    { contactId: "contact_sven", name: "Sven Wellmann", email: "sven@example.com" },
  ],
  createdAt: now,
  updatedAt: now,
};

const json = (response, status, body) => {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": String(data.length) });
  response.end(data);
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  requests.push(`${request.method} ${url.pathname}`);
  if (request.method === "GET" && url.pathname === "/v1/contact-groups") {
    return json(response, 200, { groups: left ? [] : [group] });
  }
  if (request.method === "DELETE" && url.pathname === `/v1/contact-groups/${groupId}/membership`) {
    left = true;
    return json(response, 200, { ok: true, groupId, leftAt: new Date().toISOString() });
  }
  return json(response, 404, { error: "not_found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "group_leave_fixture",
  deviceId: "group_leave_fixture",
  deviceName: "Group leave fixture",
  user: { id: "user_david", name: "David Kariuki", email: "david@example.com" },
}));
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "David Kariuki", email: "david@example.com", transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    relay_group_leave_fixture: {
      direction: "inbound",
      state: "read",
      relayNotificationKind: "plain_relay",
      senderName: "Shane Acton",
      senderUserId: "user_shane",
      senderEmail: "shane@example.com",
      recipientGroupId: groupId,
      recipientGroupName: group.name,
      groupSendId: "send_group_leave_fixture",
      threadId: "thread_group_leave_fixture",
      title: "Leave-group proof",
      forHuman: "This message must remain readable after David leaves the group.",
      forAgent: "",
      createdAt: now,
      updatedAt: now,
    },
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));

const mainPort = Number(process.env.RELAY_GROUP_LEAVE_MAIN_PORT || 9581);
const rendererPort = Number(process.env.RELAY_GROUP_LEAVE_RENDERER_PORT || 9582);
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
    RELAY_AUTO_UPDATE: "0",
    RELAY_WEB_URL: apiUrl,
    RELAY_API_URL: apiUrl,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonEventually(url) {
  let last;
  for (let i = 0; i < 100; i += 1) {
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
async function waitFor(page, expression) {
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(page, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function capture(page, name) {
  const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(sandbox, name);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

let main;
let page;
try {
  const mainTargets = await jsonEventually(`http://127.0.0.1:${mainPort}/json/list`);
  main = await connect(mainTargets[0].webSocketDebuggerUrl);
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
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
  await waitFor(page, "Boolean(document.querySelector('[data-view=\"contacts\"]'))");
  const groupResult = await evaluate(page, "window.relay.groups()");
  assert.equal(groupResult?.ok, true, `group bridge failed: ${JSON.stringify({ groupResult, requests })}`);
  assert.equal(groupResult?.result?.length, 1, `group fixture was not returned: ${JSON.stringify({ groupResult, requests })}`);
  await evaluate(page, `document.documentElement.dataset.theme = "dark"; document.querySelector('[data-view="contacts"]').click(); true`);
  await waitFor(page, "!document.querySelector('#cvSegGroups').disabled");
  await evaluate(page, "document.querySelector('#cvSegGroups').click(); true");
  await waitFor(page, "Boolean(document.querySelector('[data-group]'))");
  await evaluate(page, "document.querySelector('[data-group]').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#contactsView [data-gd-leave]'))");

  const peopleGeometry = await evaluate(page, `(() => {
    const stack = document.querySelector('#contactsView .gd-identity .cvg-stack').getBoundingClientRect();
    const title = document.querySelector('#contactsView .gd-title').getBoundingClientRect();
    const detail = document.querySelector('#contactsView .group-detail').getBoundingClientRect();
    return { gap:title.left - stack.right, detailWidth:detail.width, members:document.querySelectorAll('#contactsView .gd-member').length };
  })()`);
  assert.ok(peopleGeometry.gap >= 12, `avatar stack must not overlap text: ${JSON.stringify(peopleGeometry)}`);
  assert.equal(peopleGeometry.members, 3);
  const peopleShot = await capture(page, "people-group-detail.png");

  await evaluate(page, "document.querySelector('[data-view=\"relays\"]').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#relaysList .relay-arrival'))");
  await evaluate(page, "document.querySelector('#relaysList .relay-arrival').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#thExpand'))");
  await evaluate(page, "document.querySelector('#thExpand').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#thGroupInfo:not(.hidden)'))");
  await evaluate(page, "document.querySelector('#thGroupInfo').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#groupInfoDetail .group-detail.in-sheet [data-gd-leave]'))");
  const sheetGeometry = await evaluate(page, `(() => {
    const sheet = document.querySelector('.group-info-sheet').getBoundingClientRect();
    const detail = document.querySelector('#groupInfoDetail .group-detail').getBoundingClientRect();
    return { sheetWidth:sheet.width, detailWidth:detail.width, members:document.querySelectorAll('#groupInfoDetail .gd-member').length };
  })()`);
  assert.ok(sheetGeometry.sheetWidth >= 460, `See info must use the larger sheet: ${JSON.stringify(sheetGeometry)}`);
  assert.equal(sheetGeometry.members, 3);
  const infoShot = await capture(page, "see-info-group-detail.png");

  await evaluate(page, "document.querySelector('#groupInfoDetail [data-gd-leave]').click(); true");
  await waitFor(page, "Boolean(document.querySelector('#groupInfoDetail [data-gd-leave-confirm]'))");
  const confirmShot = await capture(page, "leave-confirmation.png");
  await evaluate(page, "document.querySelector('#groupInfoDetail [data-gd-leave-confirm]').click(); true");
  await waitFor(page, "document.querySelector('#groupInfoBackdrop').classList.contains('hidden') && Boolean(document.querySelector('#thHistory .th-room-status'))");
  assert.equal(left, true, "the API must receive the self-leave mutation");
  const afterLeave = await evaluate(page, `({
    history:document.querySelector('#thHistory')?.textContent || "",
    composer:Boolean(document.querySelector('#thQrSend')),
    status:document.querySelector('#thHistory .th-room-status')?.textContent || "",
  })`);
  assert.match(afterLeave.history, /This message must remain readable/);
  assert.match(afterLeave.status, /You left this group/);
  assert.equal(afterLeave.composer, false);
  const leftShot = await capture(page, "left-group-history.png");

  console.log(JSON.stringify({ ok:true, sandbox, peopleShot, infoShot, confirmShot, leftShot, peopleGeometry, sheetGeometry }));
} catch (error) {
  throw new Error(`${error.stack || error}\nRequests: ${JSON.stringify(requests)}\nElectron log:\n${log}`);
} finally {
  try { page?.close(); } catch {}
  try { main?.close(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((resolve) => server.close(resolve));
}
