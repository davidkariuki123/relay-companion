// Live UI probe for the Tasks inbox-zero state. This is intentionally outside
// npm test because it boots Electron and needs a desktop session.
// Run: node test/task-inbox-zero.e2e.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
assert.ok(electronBin, "Electron is installed");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function retry(fn, label, { attempts = 60, delay = 150 } = {}) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fn(); }
    catch (caught) { error = caught; await new Promise((resolve) => setTimeout(resolve, delay)); }
  }
  throw new Error(`Timed out waiting for ${label}: ${error?.message || error}`);
}

async function connect(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let id = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id || !pending.has(message.id)) return;
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

async function evaluate(connection, expression) {
  const response = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-task-zero-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const completed = (title, minute) => ({
  direction: "inbound",
  state: "read",
  relayNotificationKind: "task",
  senderName: "David Kariuki",
  title,
  forHuman: title,
  forAgent: `Complete ${title}`,
  createdAt: `2026-08-26T12:${minute}:00.000Z`,
  updatedAt: `2026-08-26T12:${minute}:30.000Z`,
  taskStartedAt: `2026-08-26T12:${minute}:05.000Z`,
  taskCompletedAt: `2026-08-26T12:${minute}:30.000Z`,
});

fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "", handle: "", email: "", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    task_done_1: completed("Return the completion marker", "10"),
    task_done_2: completed("Count to seven and report the total", "11"),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));

const configPath = path.join(sandbox, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  deviceToken: "dev_task_zero",
  deviceId: "dev_task_zero",
  deviceName: "Task Zero Probe",
  user: { id: "user_task_zero", name: "Task Zero Probe", email: "task-zero@example.com", accountKind: "human", isDeveloper: true },
}, null, 2));

const inspectorPort = await freePort();
const rendererPort = await freePort();
const child = spawn(electronBin, [
  `--inspect=${inspectorPort}`,
  `--remote-debugging-port=${rendererPort}`,
  path.join(packageRoot, "overlay/main.cjs"),
], {
  env: {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_OVERLAY_USER_DATA: userData,
    RELAY_OVERLAY_TEST: "1",
    RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
    RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
    RELAY_CONFIG: configPath,
    RELAY_WEB_URL: "http://127.0.0.1:9",
    RELAY_API_URL: "http://127.0.0.1:9",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

let page;
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${rendererPort}/json/list`);
    const targets = await response.json();
    const match = targets.find((candidate) => String(candidate.url).includes("inbox.html"));
    if (!match) throw new Error("inbox target unavailable");
    return match;
  }, "Relay renderer");
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await retry(async () => {
    const ready = await evaluate(page, `document.readyState === "complete" && Boolean(document.querySelector('[data-view="tasks"]'))`);
    if (!ready) throw new Error("Tasks tab unavailable");
  }, "Tasks UI");
  await evaluate(page, `document.querySelector('[data-view="tasks"]').click()`);
  await retry(async () => {
    const visible = await evaluate(page, `!document.getElementById("tasksView").classList.contains("hidden") && Boolean(document.querySelector("[data-completed-toggle]"))`);
    if (!visible) throw new Error("Tasks zero state unavailable");
  }, "inbox-zero state");

  const state = () => evaluate(page, `(() => ({
    title: document.querySelector(".tz-title")?.textContent,
    subtitle: document.querySelector(".tz-sub")?.textContent,
    expanded: document.querySelector("[data-completed-toggle]")?.getAttribute("aria-expanded"),
    compact: document.querySelector("[data-task-zero]")?.classList.contains("compact"),
    revealOpen: document.getElementById("completedTasksList")?.classList.contains("open"),
    revealHeight: Math.round(document.getElementById("completedTasksList")?.getBoundingClientRect().height || 0),
    completedRows: document.querySelectorAll("#completedTasksList .tb-row").length,
  }))()`);

  assert.deepEqual(await state(), {
    title: "Nicely done.",
    subtitle: "Your task list is clear.",
    expanded: "false",
    compact: false,
    revealOpen: false,
    revealHeight: 0,
    completedRows: 2,
  });
  if (process.env.RELAY_TASK_ZERO_CAPTURE_DIR) {
    fs.mkdirSync(process.env.RELAY_TASK_ZERO_CAPTURE_DIR, { recursive: true });
    const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.RELAY_TASK_ZERO_CAPTURE_DIR, "collapsed.png"), Buffer.from(shot.data, "base64"));
  }

  await evaluate(page, `document.querySelector("[data-completed-toggle]").click()`);
  await retry(async () => {
    const height = await evaluate(page, `Math.round(document.getElementById("completedTasksList")?.getBoundingClientRect().height || 0)`);
    if (height <= 80) throw new Error(`completed rows are still ${height}px tall`);
  }, "completed rows to expand", { attempts: 20, delay: 100 });
  const expandedState = await state();
  assert.deepEqual({ ...expandedState, revealHeight: undefined }, {
    title: "Nicely done.",
    subtitle: "Your task list is clear.",
    expanded: "true",
    compact: true,
    revealOpen: true,
    revealHeight: undefined,
    completedRows: 2,
  });
  assert.ok(expandedState.revealHeight > 80, `completed rows are visibly expanded (${expandedState.revealHeight}px)`);
  if (process.env.RELAY_TASK_ZERO_CAPTURE_DIR) {
    const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.RELAY_TASK_ZERO_CAPTURE_DIR, "expanded.png"), Buffer.from(shot.data, "base64"));
  }

  await evaluate(page, `document.querySelector("[data-completed-toggle]").click()`);
  await retry(async () => {
    const height = await evaluate(page, `Math.round(document.getElementById("completedTasksList")?.getBoundingClientRect().height || 0)`);
    if (height !== 0) throw new Error(`completed rows are still ${height}px tall`);
  }, "completed rows to collapse", { attempts: 20, delay: 100 });
  const collapsedAgain = await state();
  assert.equal(collapsedAgain.expanded, "false");
  assert.equal(collapsedAgain.revealHeight, 0);
  console.log("PASS task inbox zero collapses, expands, and re-collapses completed Tasks in the real overlay");
} catch (error) {
  console.error(log.split("\n").slice(-30).join("\n"));
  throw error;
} finally {
  page?.close();
  child.kill("SIGTERM");
}
