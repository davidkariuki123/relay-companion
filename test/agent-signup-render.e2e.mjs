// Rendered-state contract for the agent-installed first run. This is kept out
// of the default unit suite because it boots Electron and needs a GUI session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = process.env.RELAY_SIGNUP_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron is unavailable; install workspace dependencies first");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-signup-render-"));
const shots = process.env.RELAY_SIGNUP_SHOTS_DIR || path.join(sandbox, "screenshots");
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(shots, { recursive:true });
fs.mkdirSync(relayHome, { recursive:true });
fs.mkdirSync(userData, { recursive:true });
const welcomePacket = {
  direction:"inbound",
  state:"read",
  relayNotificationKind:"plain_relay",
  senderName:"Relay Agent",
  senderUserId:"relay-agent-fixture",
  senderEmail:"hello@sendrelays.com",
  threadId:"welcome_fixture",
  title:"Welcome to Relay",
  forHuman:'Relay is connected. Messages sent to you appear here, and your AI can read and reply.\n\nTry it: ask your AI, "send a relay to someone I work with saying hi."',
  forAgent:"",
  createdAt:"2026-08-20T18:00:00.000Z",
  updatedAt:"2026-08-20T18:00:00.000Z",
};
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken:"signup_render_fixture",
  deviceId:"signup_render_fixture",
  deviceName:"Alex’s computer",
  user:{ id:"fixture", name:"Alex Rivera", email:"alex@example.com" },
}));
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version:1,
  account:{},
  profile:{ name:"Alex Rivera", email:"alex@example.com", transport:{ type:"relay_api" } },
  contacts:[], packets:{ welcome_fixture:welcomePacket }, meetingNotes:{}, setup:{}, emailThreads:{}, chats:{},
}));

const basePort = 9600 + (process.pid % 200);
const child = spawn(electron, [
  `--inspect=${basePort}`,
  `--remote-debugging-port=${basePort + 1}`,
  path.join(packageRoot, "overlay/main.cjs"),
], {
  env:{
    ...process.env,
    RELAY_HOME:relayHome,
    RELAY_CONFIG:path.join(sandbox, "config.json"),
    RELAY_OVERLAY_USER_DATA:userData,
    RELAY_OVERLAY_TEST:"1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE:"1",
    RELAY_OVERLAY_TEST_IGNORE_POINTER:"1",
    RELAY_OVERLAY_TEST_NO_HOST_OPEN:"1",
    RELAY_AUTO_UPDATE:"0",
    RELAY_WEB_URL:"http://127.0.0.1:9",
    RELAY_API_URL:"http://127.0.0.1:9",
  },
  stdio:["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonEventually(url) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await (await fetch(url)).json(); } catch (error) { last = error; await sleep(100); }
  }
  throw last;
}
async function connect(url) {
  const socket = new WebSocket(url, { perMessageDeflate:false });
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
        socket.send(JSON.stringify({ id:requestId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(page, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(page, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function capture(page, name) {
  // Signup stages can change the native card height. Capture only after the
  // settle transition so a shorter recovery page is not clipped to the prior
  // stage's moving bounds.
  await sleep(360);
  const rect = await evaluate(page, `(() => { const r=card.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  const shot = await page.send("Page.captureScreenshot", { format:"png", fromSurface:true, clip:{ ...rect, scale:2 } });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

async function clickAt(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type:"mousePressed", x, y, button:"left", clickCount:1 });
  await page.send("Input.dispatchMouseEvent", { type:"mouseReleased", x, y, button:"left", clickCount:1 });
}

let main;
let page;
try {
  const mainTargets = await jsonEventually(`http://127.0.0.1:${basePort}/json/list`);
  main = await connect(mainTargets[0].webSocketDebuggerUrl);
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
    const pages = await jsonEventually(`http://127.0.0.1:${basePort + 1}/json/list`);
    target = pages.find((entry) => entry.type === "page" && /inbox\.html/.test(entry.url));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Relay renderer target was not found");
  page = await connect(target.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await evaluate(main, "global.__relayTest.showFromTray(); true");
  await waitFor(page, "typeof window.__relaySignupPreview === 'function'");

  const states = [
    ["resume", "Continue your setup."],
    ["restart-required", "Restart this setup."],
    ["method", "Connect Relay."],
    ["email", "What’s your email?"],
    ["code", "Enter your code."],
    ["google", "Finish with Google."],
    ["approval", "Connect this computer?"],
    ["finishing", "Finishing setup…"],
    ["expired", "Start setup again."],
    ["chat-setup", "Use Relay in your chats."],
  ];
  const rendered = [];
  for (const [stage, expected] of states) {
    const preview = {
      email:"alex@example.com",
      account:{ displayName:"Alex Rivera", email:"alex@example.com" },
      ...(stage === "restart-required" ? { error:"Relay found an unfinished one-time approval. Restart setup to replace it safely." } : {}),
    };
    await evaluate(page, `window.__relaySignupPreview(${JSON.stringify(stage)}, ${JSON.stringify(preview)}); true`);
    await waitFor(page, `document.getElementById("signupBody").innerText.includes(${JSON.stringify(expected)})`);
    rendered.push(await capture(page, `pill-${stage}`));
    if (stage === "chat-setup") {
      const layout = await evaluate(page, `(() => {
        const cardRect = document.getElementById("card").getBoundingClientRect();
        const bodyRect = document.getElementById("signupBody").getBoundingClientRect();
        const skipRect = document.getElementById("suChatSkip").getBoundingClientRect();
        return {
          bodyInside:bodyRect.top >= cardRect.top && bodyRect.bottom <= cardRect.bottom,
          skipInside:skipRect.top >= cardRect.top && skipRect.bottom <= cardRect.bottom,
          skipVisible:getComputedStyle(document.getElementById("suChatSkip")).display !== "none",
        };
      })()`);
      assert.deepEqual(layout, { bodyInside:true, skipInside:true, skipVisible:true });
    }
    if (stage === "method") {
      const expandedLockup = await evaluate(page, `(() => {
        const rect = document.getElementById("lockup").getBoundingClientRect();
        return { x:rect.left + 32, y:rect.top + (rect.height / 2) };
      })()`);
      await clickAt(page, expandedLockup.x, expandedLockup.y);
      await waitFor(page, `document.getElementById("card").classList.contains("collapsed") && document.getElementById("card").getBoundingClientRect().height < 46`);
      const compact = await evaluate(page, `(() => {
        const cardRect = document.getElementById("card").getBoundingClientRect();
        const lockupRect = document.getElementById("lockup").getBoundingClientRect();
        const x = lockupRect.left + 32;
        const y = lockupRect.top + (lockupRect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          width:cardRect.width,
          height:cardRect.height,
          signupDisplay:getComputedStyle(document.getElementById("signupView")).display,
          hitInsideLockup:Boolean(hit && hit.closest && hit.closest("#lockup")),
        };
      })()`);
      assert.equal(compact.signupDisplay, "none", `collapsed signup content must be absent: ${JSON.stringify(compact)}`);
      assert.equal(compact.hitInsideLockup, true, `collapsed pill header must own its hit area: ${JSON.stringify(compact)}`);
      rendered.push(await capture(page, "pill-method-collapsed"));
      await clickAt(page, compact.x, compact.y);
      await waitFor(page, `!document.getElementById("card").classList.contains("collapsed") && document.getElementById("card").getBoundingClientRect().height > 520`);
      assert.match(await evaluate(page, `document.getElementById("signupBody").innerText`), /Connect Relay\./);
      rendered.push(await capture(page, "pill-method-reexpanded"));
    }
  }

  await evaluate(page, `window.__relaySignupPreview("method", {
    error:"Relay couldn’t connect. Check your internet and try again.",
    initializationFailed:true
  }); true`);
  await waitFor(page, `document.getElementById("signupBody").innerText.includes("Try again")`);
  rendered.push(await capture(page, "pill-method-retry"));

  const welcomeText = await evaluate(page, `(async () => { onPayload(await window.relay.refresh()); return document.getElementById("relaysList").innerText; })()`);
  assert.match(welcomeText, /Relay Agent/);
  assert.match(welcomeText, /Relay is connected/);
  const openedWelcome = await evaluate(page, `(async () => { document.querySelector("#relaysList .relay-arrival").click(); await new Promise((resolve) => setTimeout(resolve, 250)); renderThreads(); return { view:activeView, text:document.getElementById("thHistory").innerText }; })()`);
  assert.equal(openedWelcome.view, "threads");
  assert.match(openedWelcome.text, /Relay is connected/);
  rendered.push(await capture(page, "pill-inbox-welcome"));

  await evaluate(page, `(() => {
    slackConnectionInfo = { state:"disconnected", team:null, personal:null };
    slackConnectionLoaded = true;
    slackConnectionError = "";
    slackConnectionWaiting = false;
    payload.account = { paired:true, name:"Alex Rivera", email:"alex@example.com" };
    payload.ui = { ...payload.ui, setupTutorialPending:false };
    payload.features = { ...payload.features, requests:true };
    activeView = "slack";
    commitNavigation({ outerScrollTop:0 });
    return true;
  })()`);
  await waitFor(page, `document.getElementById("slackList").innerText.includes("Connect your Slack to Relay.")`);
  // This harness deliberately points API traffic at a closed local port. Keep
  // that transport failure from obscuring the clean disconnected design state
  // we are measuring; invalidating the in-flight sequence mirrors a newer
  // successful status result winning the race.
  await evaluate(page, `(() => { slackConnectionRefreshSeq += 1; slackConnectionError = ""; renderSlack(); return true; })()`);
  const slackConnectLayout = await evaluate(page, `(() => {
    const cardRect = document.getElementById("card").getBoundingClientRect();
    const viewRect = document.querySelector(".slack-connect").getBoundingClientRect();
    const actionRect = document.getElementById("slackTabConnect").getBoundingClientRect();
    const footRect = document.querySelector(".slack-connect-foot").getBoundingClientRect();
    return {
      tabOrder:[...document.querySelectorAll(".tab:not(.gone)")].map((tab) => tab.getAttribute("data-view")),
      viewInside:viewRect.left >= cardRect.left && viewRect.right <= cardRect.right && viewRect.top >= cardRect.top,
      actionInside:actionRect.left >= cardRect.left && actionRect.right <= cardRect.right && actionRect.bottom <= cardRect.bottom,
      footInside:footRect.left >= cardRect.left && footRect.right <= cardRect.right && footRect.bottom <= cardRect.bottom,
      escapeCopy:/Not now|Skip for now|Continue without Slack|Finish setup/.test(document.getElementById("slackList").innerText),
    };
  })()`);
  rendered.push(await capture(page, "pill-slack-disconnected"));
  assert.deepEqual(slackConnectLayout.tabOrder, ["relays", "tasks", "slack", "contacts", "settings"]);
  assert.equal(slackConnectLayout.viewInside, true, JSON.stringify(slackConnectLayout));
  assert.equal(slackConnectLayout.actionInside, true, JSON.stringify(slackConnectLayout));
  assert.equal(slackConnectLayout.footInside, true, JSON.stringify(slackConnectLayout));
  assert.equal(slackConnectLayout.escapeCopy, false, JSON.stringify(slackConnectLayout));

  assert.equal(rendered.length, 15);
  console.log(JSON.stringify({ ok:true, screenshots:rendered }, null, 2));
} catch (error) {
  throw new Error(`${error.message}\n${log.slice(-4000)}`);
} finally {
  page?.close();
  main?.close();
  child.kill("SIGTERM");
}
