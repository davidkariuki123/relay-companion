// Visual/compositor gate for compact conversation <-> expanded reader resizing.
//
// Runs the repository overlay in an isolated test home with synthetic letters.
// Verifies one whole-card snapshot, monotonic geometry, fixed footer layout,
// preserved scroll, and supersession. No real account or installed files change.
// Run: RELAY_OVERLAY_TEST_ONSCREEN=1 RELAY_OVERLAY_TEST_RECORDING=1 node test/card-resize-transition.e2e.mjs
// Optional RELAY_CARD_TRANSITION_RECORD saves a native macOS screen recording.


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
fs.writeFileSync(path.join(relayHome, "overlay-prefs.json"), JSON.stringify({soundsMuted:true,onboardingVersions:{"user:fixture":2}}));
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
    forHuman: `This is a long letter with agent controls pinned over it. ${"The whole surface should move continuously with no layering changes. ".repeat(index % 2 ? 1 : 24)}`,
    forAgent: "Review this fixture with your agent.",
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

const rendererPort = Number(process.env.RELAY_CARD_TRANSITION_RENDERER_PORT || 9496);
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

let page;
let recording;
try {
  let target;
  for(let i=0;i<80&&!target;i++){
    const pages = await jsonEventually(`http://127.0.0.1:${rendererPort}/json/list`);
    target = pages.find(entry => entry.type === "page" && /inbox\.html/.test(entry.url));
    if(!target) await sleep(100);
  }
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await waitFor(page, `typeof payload !== "undefined" && payload.relays?.length >= 10`, "Relay rows");
  await page.send("Page.bringToFront");
  await sleep(700);
  if(process.env.RELAY_CARD_TRANSITION_RECORD) {
    recording = spawn("/usr/sbin/screencapture", ["-v", "-V", "22", "-m", process.env.RELAY_CARD_TRANSITION_RECORD]);
  }
  const cycles = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const row = await evaluate(page, `payload.relays.find(r => r.title === "Room transition message ${cycle+1}")`);
    assert.ok(row, "fixture Relay exists");
    await evaluate(page, `openThreadDetail(${JSON.stringify(row.threadId || row.id)}, ${JSON.stringify(row.senderName)}, "relays", {expanded:false})`);
    await sleep(800);
    const before = await evaluate(page, `({top:scrollEl.scrollTop,w:W.v,h:H.v})`);
    for (const direction of ["open", "close", "expand", "compact"]) {
      const frames = await evaluate(page, `(async () => {
        const frames=[]; const started=performance.now();
        function sample(now) {
          const animations=document.getAnimations({subtree:true});
          const group=getComputedStyle(document.documentElement,'::view-transition-group(relay-card)');
          frames.push({at:now-started, active:!!cardViewTransition, view:activeView,
            w:W.v,h:H.v,top:scrollEl.scrollTop,fit:readerBodyEl.classList.contains('rd-fit'),
            clone:!!readerMorphSnapshot,spring:!!raf,
            name:cardEl.style.viewTransitionName,
            groupWidth:parseFloat(group.width),groupHeight:parseFloat(group.height),
            snapshot:animations.some(a=>a.effect?.pseudoElement==='::view-transition-group(relay-card)')});
          if(now-started<850)requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
        ${direction === 'open' ? `openReader(${JSON.stringify(row.id)}, "relays")` : direction === 'close' ? 'closeReader()' : 'document.getElementById("thExpand").click()' };
        await new Promise(resolve=>setTimeout(resolve,900));
        return frames;
      })()`);
      fs.writeFileSync(path.join(sandbox, `frames-${cycle}-${direction}.json`), JSON.stringify(frames,null,2));
      if(direction === "open") {
        assert.ok(await evaluate(page, `readerBodyEl.textContent.includes("This is a long letter")`), "the actual letter is rendered");
        assert.ok(await evaluate(page, `readerBodyEl.textContent.includes("Open in Codex") && readerBodyEl.textContent.includes("Open in Claude Code")`), "both agent controls are rendered");
      }
      assert.ok(frames.some(f=>f.snapshot), `${direction} captured no card pixels`);
      assert.ok(frames.every(f=>!f.clone && !f.spring), `${direction} ran legacy resize/clone`);
      assert.equal(frames.at(-1).active,false);
      assert.equal(frames.at(-1).view,direction==='open'?'reader':'threads');
      const visible=frames.filter(f=>f.snapshot);
      assert.ok(visible.length>=4);
      assert.equal(new Set(visible.map(f=>f.fit)).size,1,'footer relaid out during animation');
      assert.equal(new Set(visible.map(f=>f.top)).size,1,'scroll changed during animation');
      for(let i=1;i<visible.length;i++) {
        const a=visible[i-1].groupWidth,b=visible[i].groupWidth;
        assert.ok((direction==='open'||direction==='expand')?b>=a-.1:b<=a+.1,'card width reversed');
      }
      cycles.push({cycle,direction,frames:visible.length});
    }
    const after=await evaluate(page, `({top:scrollEl.scrollTop,w:W.v,h:H.v})`);
    assert.deepEqual(after,before,'compact room geometry/scroll not restored');
  }
  // A tab navigation during the native preparation must win over the pending reader.
  await evaluate(page, `openReader('room_00','relays'); activeView='contacts'; commitNavigation()`);
  await sleep(650);
  assert.equal(await evaluate(page, 'activeView'), 'contacts');
  assert.equal(await evaluate(page, '!!cardViewTransition'),false);
  console.log(JSON.stringify({sandbox,cycles},null,2));
} catch(error) {
  console.error(error.stack||error);console.error(log);process.exitCode=1;
} finally {
  if(recording && recording.exitCode === null) await new Promise(resolve=>recording.once('exit',resolve));
  page?.close();child.kill('SIGTERM');
}
