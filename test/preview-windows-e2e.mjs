// Focused live harness for MULTI-WINDOW relay previews.
//
// Boots the same sandboxed overlay as test/e2e-overlay.mjs but drives ONLY the
// preview paths, entirely through the main-process inspector. Touching no
// renderer UI means the real cursor on the shared screen cannot flake it, which
// makes this the cheap check to run while working on preview windows.
// e2e-overlay.mjs covers the same ground in situ, from the pill's own UI.
//
// Run: node test/preview-windows-e2e.mjs   (needs a GUI session; not in `npm test`)

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// Resolve from THIS file, never a hardcoded checkout: the repo is worked on from
// many worktrees at once and an absolute default silently points at someone else's.
const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// electron may be hoisted to the workspace root (dev) or vendored (npm install)
const electronBin = [
  path.join(pkgRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "electron.exe"),
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((p) => fs.existsSync(p));
if (!electronBin) {
  console.error("no Electron binary found; run npm install first");
  process.exit(1);
}

const MAIN_INSPECT_PORT = 9439;
const RENDERER_CDP_PORT = 9440;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preview-e2e-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

function packet(id, title, createdAt) {
  return {
    direction: "inbound",
    state: "unread",
    relayNotificationKind: "plain_relay",
    senderName: "E2E Harness",
    title,
    forHuman: `# ${title}\n\nBody for ${id}.`,
    createdAt,
    updatedAt: createdAt,
  };
}

const packets = {
  pkt_a: packet("pkt_a", "Alpha relay", "2026-07-10T00:00:00.000Z"),
  pkt_b: packet("pkt_b", "Beta relay", "2026-07-10T00:01:00.000Z"),
  pkt_c: packet("pkt_c", "Gamma relay", "2026-07-10T00:02:00.000Z"),
};
fs.writeFileSync(
  path.join(relayHome, "state.json"),
  JSON.stringify({
    version: 1,
    account: {},
    profile: { name: "", handle: "", email: "", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
    contacts: [],
    packets,
    meetingNotes: {},
    setup: {},
    emailThreads: {},
    chats: {},
  }, null, 2),
);
fs.writeFileSync(
  path.join(sandbox, "config.json"),
  JSON.stringify({
    deviceToken: "dev_e2e_token",
    deviceId: "dev_e2e",
    deviceName: "E2E Sandbox Mac",
    user: { id: "user_e2e", name: "E2E Harness", email: "e2e@example.com" },
  }, null, 2),
);

// A stand-in API that knows exactly one thing: the room two people share.
// Everything else answers 503, which is what this harness has always run
// against (a dead port), so the staged-packet scenarios below are unaffected.
const ROOM = {
  chatId: "chat_room_e2e",
  // The server can only offer the address when no account backs it — the name
  // the window wears has to come from the contact card instead.
  title: "sven@example.com",
  kind: "direct",
  participants: [{ id: "p1", name: "E2E Harness", self: true }, { id: "p2", name: "sven@example.com", self: false }],
  threadIds: [],
  messageCount: 0,
  unreadCount: 0,
  updatedAt: "1970-01-01T00:00:00.000Z",
  items: [],
  hasMoreMessages: false,
};
// The room a contact GROUP names: the same lookup, answered with the roster and
// the group that named it. `owned` is what decides whether the window may
// address the group at all — only its owner can start its conversation.
const GROUP_ROOM = {
  ...ROOM,
  chatId: "chat_group_e2e",
  title: "Launch crew",
  kind: "group",
  group: { groupId: "grp_e2e", name: "Launch crew", owned: true },
  participants: [
    { id: "p1", name: "E2E Harness", self: true },
    { id: "p2", name: "sven@example.com", self: false },
    { id: "p3", name: "shane@example.com", self: false },
  ],
};
const apiCalls = [];
const fakeApi = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const chatRoute =
      req.url === "/v1/chats/resolve" ||
      req.url === `/v1/chats/${ROOM.chatId}` ||
      req.url === `/v1/chats/${GROUP_ROOM.chatId}`;
    if (chatRoute) apiCalls.push({ method: req.method, url: req.url, body });
    const wantsGroup = /"groupId"/.test(body) || req.url === `/v1/chats/${GROUP_ROOM.chatId}`;
    res.statusCode = chatRoute ? 200 : 503;
    res.setHeader("content-type", "application/json");
    res.end(chatRoute ? JSON.stringify(wantsGroup ? GROUP_ROOM : ROOM) : "{}");
  });
});
const apiPort = await new Promise((resolve, reject) => {
  fakeApi.once("error", reject);
  fakeApi.listen(0, "127.0.0.1", () => resolve(fakeApi.address().port));
});

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function connectWs(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function evalIn(conn, expression, { awaitPromise = false } = {}) {
  const res = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`eval failed: ${(d.exception && d.exception.description) || d.text}`);
  }
  return res.result ? res.result.value : undefined;
}

async function retry(fn, { tries = 40, delayMs = 250, label = "condition" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`timed out waiting for ${label}: ${lastErr && lastErr.message}`);
}

const overlayEnv = {
  ...process.env,
  RELAY_HOME: relayHome,
  RELAY_OVERLAY_USER_DATA: userData,
  RELAY_OVERLAY_TEST: "1",
  RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
  RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
  RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
  RELAY_OVERLAY_NOTIFICATION_MS: "5000",
  RELAY_CONFIG: path.join(sandbox, "config.json"),
  RELAY_WEB_URL: "http://127.0.0.1:9",
  RELAY_API_URL: `http://127.0.0.1:${apiPort}`,
};

const child = spawn(
  electronBin,
  [`--inspect=${MAIN_INSPECT_PORT}`, `--remote-debugging-port=${RENDERER_CDP_PORT}`, path.join(pkgRoot, "overlay", "main.cjs")],
  { env: overlayEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let childLog = "";
child.stdout.on("data", (d) => (childLog += d));
child.stderr.on("data", (d) => (childLog += d));

let failures = 0;
let mainConn = null;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const previewPages = async () =>
  (await fetchJson(`http://127.0.0.1:${RENDERER_CDP_PORT}/json/list`))
    .filter((t) => t.type === "page" && String(t.url).includes("preview.html"));

try {
  const mainInfo = await retry(() => fetchJson(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`), { label: "main inspector" });
  mainConn = await connectWs(mainInfo[0].webSocketDebuggerUrl);
  await mainConn.send("Runtime.enable");
  await retry(async () => {
    if (!(await evalIn(mainConn, "Boolean(global.__relayTest)"))) throw new Error("hooks not ready");
  }, { label: "app ready" });
  await retry(async () => {
    const n = await evalIn(mainConn, "Object.keys(global.__relayTest.state().packets || {}).length");
    if (!n) throw new Error("packets not loaded");
  }, { label: "packets staged" }).catch(() => {});

  // ---- 1. one relay opens one window ----------------------------------------
  const openedA = await evalIn(mainConn, "global.__relayTest.openPreview('pkt_a')");
  const oneOpen = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 1) throw new Error(`previews=${s.previews.length}`);
    return s;
  }, { label: "first preview" });
  check("one relay opens one preview window", openedA === true && oneOpen.previews[0].relayId === "pkt_a",
    `opened=${openedA} previews=${JSON.stringify(oneOpen.previews)}`);

  // ---- 2. re-previewing the SAME relay raises it, never duplicates -----------
  await evalIn(mainConn, "global.__relayTest.openPreview('pkt_a'); global.__relayTest.openPreview('pkt_a'); 'again'");
  await new Promise((r) => setTimeout(r, 900));
  const afterReopen = await evalIn(mainConn, "global.__relayTest.state()");
  const reopenPages = await previewPages();
  check("re-previewing the same relay reuses its window", afterReopen.previews.length === 1 && reopenPages.length === 1,
    `previews=${afterReopen.previews.length} pages=${reopenPages.length}`);

  // ---- 3. a DIFFERENT relay ADDS a window (the actual ask) -------------------
  await evalIn(mainConn, "global.__relayTest.openPreview('pkt_b'); 'b'");
  await evalIn(mainConn, "global.__relayTest.openPreview('pkt_c'); 'c'");
  // Wait for all three to be ON SCREEN, not merely constructed: a window is created
  // hidden and shown at ready-to-show, and macOS ignores minimize() on a hidden
  // window — so a snapshot taken too early would test nothing.
  const three = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 3) throw new Error(`previews=${s.previews.length}`);
    if (!s.previews.every((p) => p.visible)) throw new Error("previews not all shown yet");
    return s;
  }, { label: "three previews on screen" });
  const threePages = await previewPages();
  const slots = three.previews.map((p) => p.slot);
  check("previewing other relays is additive, each on its own cascade slot",
    threePages.length === 3 && new Set(slots).size === 3 && three.previews.every((p) => !p.minimized),
    `pages=${threePages.length} previews=${JSON.stringify(three.previews)}`);

  // ---- 4. windows do not sit on top of each other ---------------------------
  const bounds = await evalIn(mainConn,
    "global.__relayTest.getPreviewWins().map((w) => { const b = w.getBounds(); return b.x + ',' + b.y; })");
  check("each preview window opens at a distinct position",
    new Set(bounds).size === 3, `positions=${JSON.stringify(bounds)}`);

  // ---- 5. minimize acts on ONE window; the others are untouched -------------
  await evalIn(mainConn, "global.__relayTest.getPreviewWinFor('pkt_b').minimize(); 'min b'");
  const minimized = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    const b = s.previews.find((p) => p.relayId === "pkt_b");
    if (!b || !b.minimized) throw new Error("pkt_b not minimized");
    return s;
  }, { label: "independent minimize" });
  const othersUp = minimized.previews.filter((p) => p.relayId !== "pkt_b").every((p) => !p.minimized);
  check("minimizing one preview leaves the others open",
    othersUp && minimized.previews.length === 3 && minimized.visible === true,
    `previews=${JSON.stringify(minimized.previews)} pill=${minimized.visible}`);

  // ---- 6. a minimized window survives opening ANOTHER relay ------------------
  // This is the old singleton's worst symptom: previewing something else yanked
  // the parked window back and repurposed it.
  await evalIn(mainConn, "global.__relayTest.openPreview('pkt_a'); 'raise a'");
  await new Promise((r) => setTimeout(r, 700));
  const stillParked = await evalIn(mainConn, "global.__relayTest.state()");
  const b = stillParked.previews.find((p) => p.relayId === "pkt_b");
  check("a minimized preview stays parked when another relay is previewed",
    Boolean(b && b.minimized) && stillParked.previews.length === 3,
    `previews=${JSON.stringify(stillParked.previews)}`);

  // ---- 7. restore brings that one back --------------------------------------
  await evalIn(mainConn, "global.__relayTest.getPreviewWinFor('pkt_b').restore(); 'restore b'");
  const restored = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    const row = s.previews.find((p) => p.relayId === "pkt_b");
    if (!row || row.minimized) throw new Error("pkt_b still minimized");
    return s;
  }, { label: "restore" });
  check("restoring a parked preview brings it back", restored.previews.length === 3,
    `previews=${JSON.stringify(restored.previews)}`);

  // ---- 8. closing one leaves the rest; its slot is reusable ------------------
  await evalIn(mainConn, "global.__relayTest.getPreviewWinFor('pkt_a').close(); 'close a'");
  const afterClose = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 2) throw new Error(`previews=${s.previews.length}`);
    return s;
  }, { label: "close one" });
  check("closing one preview leaves the others open",
    !afterClose.previews.some((p) => p.relayId === "pkt_a") && afterClose.visible === true,
    `previews=${JSON.stringify(afterClose.previews)} pill=${afterClose.visible}`);

  await evalIn(mainConn, "global.__relayTest.openPreview('pkt_a'); 'reopen a'");
  const reopened = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 3) throw new Error(`previews=${s.previews.length}`);
    return s;
  }, { label: "reopen after close" });
  check("a closed preview's cascade slot is handed to the next window",
    new Set(reopened.previews.map((p) => p.slot)).size === 3,
    `previews=${JSON.stringify(reopened.previews)}`);

  // ---- 9. closing them all leaves the pill alone -----------------------------
  await evalIn(mainConn, "global.__relayTest.getPreviewWins().forEach((w) => w.close()); 'close all'");
  const allClosed = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 0) throw new Error(`previews=${s.previews.length}`);
    return s;
  }, { label: "close all" });
  check("closing every preview leaves the pill visible", allClosed.visible === true, `pill=${allClosed.visible}`);

  // ---- 10. a CONTACT opens the room, not a message --------------------------
  // The Contacts tab knows a person and nothing else. Main resolves the room
  // from their address and opens a window on the conversation itself.
  const opened = await evalIn(
    mainConn,
    "global.__relayTest.openChatWith({ email: 'sven@example.com', name: 'Sven Wellmann' })",
    { awaitPromise: true },
  );
  const roomOpen = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 1) throw new Error(`previews=${s.previews.length}`);
    if (!s.previews[0].visible) throw new Error("room not shown yet");
    return s;
  }, { label: "contact's room" });
  check("a contact's address opens a window on their room",
    opened && opened.ok === true && roomOpen.previews[0].chatId === "chat_room_e2e" && roomOpen.previews[0].relayId === "",
    `opened=${JSON.stringify(opened)} previews=${JSON.stringify(roomOpen.previews)}`);
  check("the window carries the person it writes to",
    roomOpen.previews[0].recipient === "sven@example.com", `previews=${JSON.stringify(roomOpen.previews)}`);
  check("the address is asked for in a body, never in a URL",
    apiCalls.length === 1 && apiCalls[0].method === "POST" && apiCalls[0].url === "/v1/chats/resolve"
      && apiCalls[0].body === '{"email":"sven@example.com"}',
    JSON.stringify(apiCalls));

  // The window that opened is the conversation, painted and named by the card.
  const roomPages = await previewPages();
  const roomConn = await connectWs(roomPages[0].webSocketDebuggerUrl);
  const painted = await retry(async () => {
    const view = await evalIn(roomConn, `(() => ({
      atChat: document.getElementById("faces").classList.contains("at-chat"),
      name: document.getElementById("chatName").textContent,
      back: document.getElementById("chatBack").classList.contains("gone"),
      state: document.getElementById("chatState").textContent,
      composer: document.getElementById("replyInput").disabled,
    }))()`);
    if (!view.atChat) throw new Error("not on the conversation face yet");
    return view;
  }, { label: "room painted" });
  roomConn.close();
  check("it opens IN the conversation, named by the card, with no way back to a message",
    painted.atChat === true && painted.name === "Sven Wellmann" && painted.back === true,
    JSON.stringify(painted));
  check("an empty room can still be written to",
    painted.composer === false && painted.state === "No messages yet. Write the first one below.",
    JSON.stringify(painted));
  // The room was handed over with the window: opening it cost ONE API call, not
  // one to find the room and a second for the window to read it.
  check("opening a room reads it once", apiCalls.length === 1, JSON.stringify(apiCalls));

  // Clicking the same contact again raises that window instead of stacking one.
  await evalIn(mainConn, "global.__relayTest.openChatWith({ email: 'sven@example.com', name: 'Sven Wellmann' })", { awaitPromise: true });
  await new Promise((r) => setTimeout(r, 700));
  const afterSecond = await evalIn(mainConn, "global.__relayTest.state()");
  const roomPagesAgain = await previewPages();
  check("clicking the same contact twice raises one window, never two",
    afterSecond.previews.length === 1 && roomPagesAgain.length === 1,
    `previews=${afterSecond.previews.length} pages=${roomPagesAgain.length}`);

  // ---- 11. a GROUP row opens the room its roster names ----------------------
  // A group is a NAME for one participant set, so its row opens a room like any
  // other — beside the person's, not instead of it.
  const groupOpened = await evalIn(
    mainConn,
    "global.__relayTest.openChatWith({ groupId: 'grp_e2e', name: 'Launch crew' })",
    { awaitPromise: true },
  );
  const bothOpen = await retry(async () => {
    const s = await evalIn(mainConn, "global.__relayTest.state()");
    if (s.previews.length !== 2) throw new Error(`previews=${s.previews.length}`);
    if (!s.previews.every((p) => p.visible)) throw new Error("not all shown yet");
    return s;
  }, { label: "the group's room" });
  const groupRow = bothOpen.previews.find((p) => p.chatId === "chat_group_e2e");
  check("a group opens its own room, beside the person's",
    groupOpened && groupOpened.ok === true && Boolean(groupRow) && groupRow.relayId === "",
    `opened=${JSON.stringify(groupOpened)} previews=${JSON.stringify(bothOpen.previews)}`);
  // A roster is addressed as a roster: the window carries the group id, so the
  // first message into an empty room fans out instead of going to one person.
  check("the window addresses the roster, not a person",
    groupRow && groupRow.recipient === "grp_e2e", `previews=${JSON.stringify(bothOpen.previews)}`);
  const groupAsk = apiCalls[apiCalls.length - 1];
  check("the group is asked for by id, in the same one call",
    groupAsk.method === "POST" && groupAsk.url === "/v1/chats/resolve" && groupAsk.body === '{"groupId":"grp_e2e"}',
    JSON.stringify(groupAsk));

  const groupPage = (await previewPages()).find((p) => p.url.includes("preview.html") && p.id !== roomPages[0].id);
  const groupConn = await connectWs(groupPage.webSocketDebuggerUrl);
  const groupPainted = await retry(async () => {
    const view = await evalIn(groupConn, `(() => ({
      name: document.getElementById("chatName").textContent,
      people: document.getElementById("chatPeople").textContent,
      atChat: document.getElementById("faces").classList.contains("at-chat"),
    }))()`);
    if (!view.atChat) throw new Error("not on the conversation face yet");
    return view;
  }, { label: "group room painted" });
  groupConn.close();
  // A room with more than two people in it says who is in it; a one-to-one does
  // not, because its heading already names the only other person.
  check("a group room names the room and who is in it",
    groupPainted.name === "Launch crew" && groupPainted.people.startsWith("You, "),
    JSON.stringify(groupPainted));

  const errors = childLog.split("\n").filter((l) => /preview-render-gone|preview-preload-error|preview-renderer/.test(l));
  check("no preview renderer crashed or errored", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  failures += 1;
  console.error("HARNESS ERROR:", err && err.message);
  console.error("--- overlay log tail ---\n" + childLog.split("\n").slice(-25).join("\n"));
} finally {
  if (mainConn) mainConn.close();
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { child.kill("SIGKILL"); } catch {}
  fs.rmSync(sandbox, { recursive: true, force: true });
  await new Promise((resolve) => fakeApi.close(resolve));
}

console.log(failures === 0 ? "\nALL PREVIEW CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
