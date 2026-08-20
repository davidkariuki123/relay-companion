// Visual/geometry gate for the Requests mini-list -> full reader morph.
//
// This boots the real Electron overlay in an isolated home, records every
// rendered animation frame plus every native BrowserWindow bounds write, and
// captures a small screenshot sequence. The native compositor canvas must stay
// fixed throughout the morph. It is intentionally outside npm test:
// run it on macOS with a GUI session.

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-request-transition-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "request_transition_fixture",
  deviceId: "request_transition_fixture",
  deviceName: "Request transition fixture",
  user: {
    id: "fixture",
    name: "Fixture",
    email: "fixture@example.com",
    accountKind: "human",
    isDeveloper: true,
  },
}));
const fixturePackets = {
  request_transition: {
    direction: "inbound",
    state: "unread",
    relayNotificationKind: "task",
    senderName: "Sven Wellmann",
    title: "Switch the app to the dev channel and confirm the outputs",
    forHuman: "Please switch the app to the dev channel and confirm that both outputs are correct.",
    forAgent: "Use the existing workspace. Record the installed version and the output from the channel verification command.",
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
  },
};
// Match a long-lived production store, where first-open read persistence used
// to parse and rewrite roughly two megabytes on the main thread. These rows are
// already read and invisible on the Requests board; the padding stands in for
// bounded provider/session metadata that the renderer never projects.
for (let index = 0; index < 292; index += 1) {
  const id = `history_${String(index).padStart(3, "0")}`;
  fixturePackets[id] = {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: `History ${index}`,
    title: `Historical Relay ${index}`,
    forHuman: `Historical Relay ${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    diagnosticPadding: "x".repeat(5_000),
  };
}
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "Fixture", transport: { type: "relay_api" } },
  contacts: [],
  packets: fixturePackets,
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {}
}, null, 2));

const mainPort = Number(process.env.RELAY_TRANSITION_MAIN_PORT || 9471);
const rendererPort = Number(process.env.RELAY_TRANSITION_RENDERER_PORT || 9472);
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
  const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

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
  await evaluate(main, `global.__relayTest.showFromTray();
    global.__requestTransitionBounds = [];
    (() => {
      const win = global.__relayTest.getWin();
      const original = win.setBounds.bind(win);
      win.setBounds = (bounds, animate) => {
        global.__requestTransitionBounds.push({ at: Date.now(), bounds: { ...bounds }, animate: Boolean(animate) });
        return original(bounds, animate);
      };
    })(); true`);
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(page, `Boolean(document.querySelector('[data-view="requests"]'))`);
    if (ready) break;
    await sleep(100);
  }
  await evaluate(page, `document.querySelector('[data-view="requests"]').click(); true`);
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(page, `Boolean(document.querySelector('#requestsList .tb-row'))`);
    if (ready) break;
    await sleep(100);
  }
  // Probe the row transition itself, not the app's unrelated entrance fade.
  await sleep(600);
  // The unread fixture deliberately raises a banner during boot. Re-enter the
  // Requests board after that arrival so the gate exercises the real failure:
  // a visible row opened while the card still carries its transient `peeking`
  // state. The reader must retire that state and grow to its full geometry.
  await evaluate(page, `document.querySelector('[data-view="requests"]').click(); true`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(page, `Boolean(document.querySelector('#requestsList .tb-row'))`)) break;
    await sleep(50);
  }
  const before = await evaluate(page, `({
    view: activeView,
    card: cardEl.getBoundingClientRect().toJSON(),
    scroll: scrollEl.getBoundingClientRect().toJSON(),
    row: document.querySelector('#requestsList .tb-row')?.getBoundingClientRect().toJSON(),
  })`);
  // Ignore boot/tray positioning. From this point onward every native bounds
  // write belongs to the one transition under test.
  await evaluate(main, `global.__requestTransitionBounds = []; true`);
  await evaluate(page, `
    globalThis.__requestTransitionFrames = [];
    globalThis.__requestTransitionLongTasks = [];
    globalThis.__requestTransitionStart = performance.now();
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const at = entry.startTime - globalThis.__requestTransitionStart;
        if (at < 0) continue;
        globalThis.__requestTransitionLongTasks.push({
          at: +at.toFixed(2),
          duration: +entry.duration.toFixed(2),
        });
      }
    }).observe({ type: "longtask", buffered: true });
    (() => {
      const sample = (now) => {
        const visible = [...document.querySelectorAll('.view:not(.hidden)')].map((node) => node.id);
        const card = cardEl.getBoundingClientRect();
        const scroll = scrollEl.getBoundingClientRect();
        globalThis.__requestTransitionFrames.push({
          at: +(now - globalThis.__requestTransitionStart).toFixed(2),
          activeView,
          visible,
          card: { x:+card.x.toFixed(2), y:+card.y.toFixed(2), w:+card.width.toFixed(2), h:+card.height.toFixed(2) },
          scroll: { x:+scroll.x.toFixed(2), y:+scroll.y.toFixed(2), w:+scroll.width.toFixed(2), h:+scroll.height.toFixed(2) },
          readerReady: readerBodyEl.childElementCount > 0,
          requestVisible: !requestsViewEl.classList.contains('hidden'),
          readerVisible: !readerViewEl.classList.contains('hidden'),
        });
        if (now - globalThis.__requestTransitionStart < 1400) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })();
    document.querySelector('#requestsList .tb-row').click(); true`);
  const captures = [];
  const screenshotDelays = process.env.RELAY_TRANSITION_NO_SCREENSHOTS === "1"
    ? [] : [0, 24, 48, 80, 128, 200, 320, 520];
  for (const delay of screenshotDelays) {
    await sleep(delay - (captures.at(-1)?.delay || 0));
    const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = path.join(sandbox, `transition-${String(delay).padStart(3, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    captures.push({ delay, file });
  }
  await sleep(Math.max(0, 1500 - (captures.at(-1)?.delay || 0)));
  const frames = await evaluate(page, `globalThis.__requestTransitionFrames`);
  const longTasks = await evaluate(page, `globalThis.__requestTransitionLongTasks`);
  const bounds = await evaluate(main, `global.__requestTransitionBounds`);
  const persisted = JSON.parse(fs.readFileSync(path.join(relayHome, "state.json"), "utf8"));
  const trace = { sandbox, before, frames, longTasks, bounds, captures };
  fs.writeFileSync(path.join(sandbox, "trace.json"), JSON.stringify(trace, null, 2));
  // Screen recording and accessibility inspection can heavily throttle rAF on
  // macOS, so require enough distinct samples to prove the geometry curve
  // without assuming a particular display refresh rate.
  assert.ok(frames.length >= 10, `expected a real frame sequence, got ${frames.length}`);
  assert.ok(frames.every((frame) => frame.activeView === "reader" && frame.readerReady && frame.readerVisible && !frame.requestVisible),
    "no frame may expose an empty reader or the live Requests view after the click");
  assert.equal(longTasks.length, 0, "the renderer performed a long task during the transition");
  assert.ok(fs.statSync(path.join(relayHome, "state.json")).size > 1_000_000, "fixture exercises a production-sized store");
  assert.equal(persisted.packets.request_transition.state, "read", "off-main acknowledgement became durable");
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(frames[i].card.w >= frames[i - 1].card.w, "card width moved backwards");
    assert.ok(frames[i].card.h >= frames[i - 1].card.h, "card height moved backwards");
  }
  if (process.env.RELAY_TRANSITION_NO_SCREENSHOTS === "1") {
    const frameGaps = frames.slice(1).map((frame, index) => frame.at - frames[index].at);
    assert.ok(Math.max(...frameGaps) < 34,
      `no-screenshot transition missed two presentation frames: ${Math.max(...frameGaps).toFixed(1)}ms`);
  }
  assert.deepEqual(frames.at(-1).card, { x:4, y:24, w:720, h:760 });
  assert.equal(bounds.length, 0, `reader transition resized the fixed native canvas ${bounds.length} times`);
  console.log(JSON.stringify({ sandbox, frameCount: frames.length, before, frames, longTasks, bounds, captures }, null, 2));
  const holdMs = Number(process.env.RELAY_TRANSITION_HOLD_MS || 0);
  if (holdMs > 0) await sleep(holdMs);
} catch (error) {
  console.error(error.stack || error);
  console.error(log);
  process.exitCode = 1;
} finally {
  page?.close();
  main?.close();
  child.kill("SIGTERM");
}
