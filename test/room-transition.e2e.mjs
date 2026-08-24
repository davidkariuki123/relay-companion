// Visual/compositor gate for compact Relays list <-> conversation navigation.
//
// Boots the real Electron overlay in an isolated home, opens rooms from varied
// list scroll positions ten times, and samples every animation frame in both
// directions. The same-size path must be one Chromium View Transition snapshot
// pair: never the legacy DOM clone whose sticky/scrolling descendants tore into
// different horizontal positions in production.
//
// Run on macOS with a GUI session:
//   node test/room-transition.e2e.mjs


import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, "..");
const electron = process.env.RELAY_TRANSITION_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron is unavailable; install workspace dependencies first");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-room-transition-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "room_transition_fixture",
  deviceId: "room_transition_fixture",
  deviceName: "Room transition fixture",
  user: {
    id: "fixture",
    name: "Fixture",
    email: "fixture@example.com",
    accountKind: "human",
    isDeveloper: true,
  },
}));

const packets = {};
for (let index = 0; index < 14; index += 1) {
  const id = `room_${String(index).padStart(2, "0")}`;
  const createdAt = new Date(Date.UTC(2026, 7, 24, 8, index)).toISOString();
  packets[id] = {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: `Transition Person ${String(index + 1).padStart(2, "0")}`,
    senderEmail: `transition-${index + 1}@example.com`,
    title: `Room transition message ${index + 1}`,
    forHuman: `Frame-coherent room message ${index + 1}`,
    createdAt,
    updatedAt: createdAt,
  };
}
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "Fixture", transport: { type: "relay_api" } },
  contacts: [],
  packets,
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));

const rendererPort = Number(process.env.RELAY_ROOM_TRANSITION_RENDERER_PORT || 9492);
const child = spawn(electron, [
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
    RELAY_WEB_URL: "http://127.0.0.1:9",
    RELAY_API_URL: "http://127.0.0.1:9",
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
  const result = await connection.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(page, expression, label) {
  for (let index = 0; index < 80; index += 1) {
    if (await evaluate(page, expression)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assertFrameSequence(frames, direction, cycle) {
  assert.ok(frames.length >= 8, `${direction} cycle ${cycle} sampled only ${frames.length} frame(s)`);
  assert.ok(frames.every((frame) => frame.cloneCount === 0 && !frame.legacyMorph),
    `${direction} cycle ${cycle} exposed the legacy DOM clone transition`);
  assert.ok(frames.some((frame) => frame.oldAnimation && frame.newAnimation),
    `${direction} cycle ${cycle} never exposed the old/new pixel snapshot pair`);
  assert.ok(frames.every((frame) => frame.visibleViews.length === 1),
    `${direction} cycle ${cycle} exposed more than one live view`);
  const activeFrames = frames.filter((frame) => frame.transitioning);
  assert.ok(activeFrames.length >= 4, `${direction} cycle ${cycle} had too few active transition frames`);
  assert.ok(activeFrames.every((frame) => frame.snapshotName === "relay-room"),
    `${direction} cycle ${cycle} lost its single viewport snapshot name`);
  assert.ok(activeFrames.every((frame) => frame.newBackground !== "rgba(0, 0, 0, 0)"),
    `${direction} cycle ${cycle} exposed the outgoing text through a transparent destination`);
}

let page;
try {
  let target = null;
  for (let index = 0; index < 80 && !target; index += 1) {
    const pages = await jsonEventually(`http://127.0.0.1:${rendererPort}/json/list`);
    target = pages.find((entry) => entry.type === "page" && /inbox\.html/.test(entry.url));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Relay renderer target was not found");
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await waitFor(page, `document.querySelectorAll('#relaysList .relay-arrival').length >= 10`, "Relay rows");
  await sleep(700);

  const allCycles = [];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const rowIndex = cycle % 7;
    const forwardFrames = await evaluate(page, `(async () => {
      const rows = [...document.querySelectorAll('#relaysList .relay-arrival')];
      const row = rows[${rowIndex}];
      row.scrollIntoView({ block:'center' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const frames = [];
      const started = performance.now();
      const sample = (now) => {
        const animations = document.getAnimations({ subtree:true });
        frames.push({
          at:+(now - started).toFixed(2),
          transitioning:document.documentElement.classList.contains('room-view-transition'),
          snapshotName:scrollEl.style.viewTransitionName,
          cloneCount:document.querySelectorAll('.reader-morph-snapshot').length,
          legacyMorph:scrollEl.classList.contains('reader-morph'),
          visibleViews:[...document.querySelectorAll('.view:not(.hidden)')].map((node) => node.id),
          oldAnimation:animations.some((animation) => animation.effect?.pseudoElement === '::view-transition-old(relay-room)'),
          newAnimation:animations.some((animation) => animation.effect?.pseudoElement === '::view-transition-new(relay-room)'),
          newBackground:getComputedStyle(document.documentElement, '::view-transition-new(relay-room)').backgroundColor,
        });
        if (now - started < 520) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      row.click();
      await new Promise((resolve) => setTimeout(resolve, 560));
      return frames;
    })()`);
    assertFrameSequence(forwardFrames, "forward", cycle + 1);
    assert.equal(await evaluate(page, `activeView`), "threads", `cycle ${cycle + 1} did not enter a room`);
    assert.equal(await evaluate(page, `document.documentElement.classList.contains('room-view-transition')`), false,
      `forward cycle ${cycle + 1} did not clean up`);

    if (cycle === 0 && process.env.RELAY_TRANSITION_NO_SCREENSHOTS !== "1") {
      const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(path.join(sandbox, "room-open.png"), Buffer.from(shot.data, "base64"));
    }

    const backFrames = await evaluate(page, `(async () => {
      const frames = [];
      const started = performance.now();
      const sample = (now) => {
        const animations = document.getAnimations({ subtree:true });
        frames.push({
          at:+(now - started).toFixed(2),
          transitioning:document.documentElement.classList.contains('room-view-transition'),
          snapshotName:scrollEl.style.viewTransitionName,
          cloneCount:document.querySelectorAll('.reader-morph-snapshot').length,
          legacyMorph:scrollEl.classList.contains('reader-morph'),
          visibleViews:[...document.querySelectorAll('.view:not(.hidden)')].map((node) => node.id),
          oldAnimation:animations.some((animation) => animation.effect?.pseudoElement === '::view-transition-old(relay-room)'),
          newAnimation:animations.some((animation) => animation.effect?.pseudoElement === '::view-transition-new(relay-room)'),
          newBackground:getComputedStyle(document.documentElement, '::view-transition-new(relay-room)').backgroundColor,
        });
        if (now - started < 520) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      thBackEl.click();
      await new Promise((resolve) => setTimeout(resolve, 560));
      return frames;
    })()`);
    assertFrameSequence(backFrames, "back", cycle + 1);
    assert.equal(await evaluate(page, `activeView`), "relays", `cycle ${cycle + 1} did not return to Relays`);
    assert.equal(await evaluate(page, `document.documentElement.classList.contains('room-view-transition')`), false,
      `back cycle ${cycle + 1} did not clean up`);
    allCycles.push({ cycle:cycle + 1, forwardFrames, backFrames });
  }

  fs.writeFileSync(path.join(sandbox, "trace.json"), JSON.stringify({ sandbox, cycles:allCycles }, null, 2));
  const minFrames = Math.min(...allCycles.flatMap((cycle) => [cycle.forwardFrames.length, cycle.backFrames.length]));
  console.log(JSON.stringify({ sandbox, cycles:allCycles.length, transitions:allCycles.length * 2, minFrames }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(log);
  process.exitCode = 1;
} finally {
  page?.close();
  child.kill("SIGTERM");
}
