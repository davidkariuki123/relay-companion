// End-to-end geometry and interaction gate for Relay's chosen-provider footer.
//
// Boots the real Electron overlay in an isolated home, opens a real Chat room,
// verifies the newest Relay owns the resident chosen-provider row, then
// drives real Chromium pointer, scroll, focus, touch and media state through
// the older-Relay hover-intent controller.
// It is intentionally outside npm test because it requires a macOS GUI session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(dirname, "..");
const electron = process.env.RELAY_PROVIDER_FOOTER_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron is unavailable; install workspace dependencies first");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-provider-footer-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "provider_footer_fixture",
  deviceId: "provider_footer_fixture",
  deviceName: "Provider footer fixture",
  user: { id: "fixture", name: "David", email: "david@example.com" },
}));

function packet(title, body, at, options = {}) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Sven Wellmann",
    senderUserId: "sven-provider-footer",
    senderEmail: "sven@example.com",
    threadId: "provider-footer-thread",
    title,
    forHuman: body,
    forAgent: options.forAgent === undefined ? "Agent briefing for this Relay." : options.forAgent,
    codexThreadId: options.codexThreadId || null,
    claudeNativeSession: options.claudeNativeSession || null,
    materializedSurfaces: options.materializedSurfaces,
    createdAt: at,
    updatedAt: at,
  };
}

fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "David", email: "david@example.com", transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    provider_footer_oldest: packet(
      "Auto-update leaves an orphan daemon",
      "The old daemon kept polling after the package was replaced.",
      "2026-08-17T09:40:00.000Z",
    ),
    provider_footer_older: packet(
      "Read receipts: what should read mean?",
      "Saw the read-parity fix land on my machine.",
      "2026-08-17T10:00:00.000Z",
    ),
    provider_footer_latest: packet(
      "Fetch-mark misses self-sends",
      "Follow-up to this morning's read-receipts note.",
      "2026-08-17T10:32:00.000Z",
      {
        codexThreadId: "01a-provider-footer-existing",
        materializedSurfaces: { codex:true, claudeCode:false, claudeCowork:false },
      },
    ),
    provider_footer_quick_text: packet(
      "hey",
      "hey",
      "2026-08-17T10:40:00.000Z",
      { forAgent:"" },
    ),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));

const mainPort = Number(process.env.RELAY_PROVIDER_FOOTER_MAIN_PORT || 9481);
const rendererPort = Number(process.env.RELAY_PROVIDER_FOOTER_RENDERER_PORT || 9482);
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
    RELAY_AUTO_UPDATE: "0",
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
  for (let i = 0; i < 80; i += 1) {
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
  await waitFor(page, "Boolean(document.querySelector('#relaysList .relay-arrival'))");
  await evaluate(page, `document.querySelector('[data-view="settings"]').click(); true`);
  await waitFor(page, "Boolean(document.querySelector('#protoPrefs'))");
  const settingsDefault = await evaluate(page, `(() => {
    agentSurfaces = { _claudeDesktop:{ available:true }, _codexDesktop:{ available:true } };
    localStorage.removeItem("proto.agentApps.v2");
    localStorage.setItem("proto.agentApp", "Codex");
    renderSettings();
    return [...document.querySelectorAll('#protoPrefs .sv-open-row')].map((row) => ({
      name:row.querySelector('.sv-open-name')?.textContent,
      logo:row.querySelector('.sv-open-logo')?.getAttribute('src'),
      checked:row.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
      disabled:row.querySelector('[role="switch"]')?.disabled,
    }));
  })()`);
  assert.deepEqual(settingsDefault, [
    { name:"Claude Code", logo:"claudeCodeMark.svg", checked:"true", disabled:false },
    { name:"Codex", logo:"codexMark.svg", checked:"true", disabled:false },
  ]);
  await evaluate(page, `document.querySelector('#protoPrefs').scrollIntoView({ block:"center" }); true`);
  const settingsShot = await capture(page, "open-relays-with-settings.png");
  // The v2 rollout deliberately ignores the stale one-value preference. With
  // both surfaces available, both switches start on; either can be turned off,
  // but the final enabled app cannot be removed.
  const appSwitchContract = await evaluate(page, `(() => {
    agentSurfaces = null;
    localStorage.removeItem("proto.agentApps.v2");
    localStorage.setItem("proto.agentApp", "Codex");
    const initial = agentAppSelection();
    setAgentAppEnabled("Codex", false);
    const claudeOnly = agentAppSelection();
    setAgentAppEnabled("Claude Code", false);
    const stillClaude = agentAppSelection();
    setAgentAppEnabled("Codex", true);
    const bothAgain = agentAppSelection();
    return { initial, claudeOnly, stillClaude, bothAgain };
  })()`);
  assert.deepEqual(appSwitchContract, {
    initial:["Claude Code", "Codex"],
    claudeOnly:["Claude Code"],
    stillClaude:["Claude Code"],
    bothAgain:["Claude Code", "Codex"],
  });
  await evaluate(page, `document.querySelector('[data-view="relays"]').click(); true`);
  await waitFor(page, "Boolean(document.querySelector('#relaysList .relay-arrival'))");
  // ONE ROW, THE APP YOU CHOSE (Sven, 2026-08-17): the footer names the app
  // Settings picked; detection defaults it to the app this Mac has. Pin the
  // choice to Codex here so the materialized-task subline is exercised; on a
  // Mac without Codex the picker falls back to Claude Code and the assertions
  // below follow the host that actually rendered.
  await evaluate(page, `
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("proto.agentApps.v2", "Codex");
    document.querySelector('#relaysList .relay-arrival').click();
    true`);
  try {
    await waitFor(page, "document.querySelectorAll('#thHistory .th-msg').length === 4");
  } catch (error) {
    const roomState = await evaluate(page, `(() => ({
      detailId:globalThis.threadDetailId,
      rowIds:[...document.querySelectorAll('#thHistory .th-msg')].map((row) => row.dataset.msg),
      historyText:document.querySelector('#thHistory')?.textContent?.slice(0, 500) || "",
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(roomState)}`);
  }
  await waitFor(page, "[...document.querySelectorAll('.th-host-logo')].every((img) => img.complete && img.naturalWidth > 0)");

  // Regression: opening a room paints the inbound half first, then refreshSent
  // can append a newer outbound message. The entry-follow latch must carry the
  // viewport to that hydrated bottom instead of preserving the old bottom as a
  // now-stale reading position (David's Sven-room screenshots, 2026-08-17).
  const beforeHydration = await evaluate(page, `(() => {
    const scroller = roomScrollElement();
    globalThis.__roomEntryHydrationToken = beginThreadEntryFollow(threadDetailId);
    return { top:scroller.scrollTop, height:scroller.scrollHeight, client:scroller.clientHeight };
  })()`);
  const delayedSentBody = Array.from({ length:18 }, (_, index) => `hydrated newest line ${index + 1}`).join(" — ");
  await evaluate(main, `global.__relayTest.setSentCache(${JSON.stringify([{
    relayId:"provider_footer_delayed_sent",
    threadId:"provider-footer-thread",
    kind:"message",
    forHuman:delayedSentBody,
    forAgent:"",
    recipient:{ name:"Sven Wellmann", email:"sven@example.com" },
    createdAt:"2026-08-17T10:50:00.000Z",
  }])})`);
  await waitFor(page, "document.querySelectorAll('#thHistory .th-msg').length === 5");
  await sleep(120);
  const afterHydration = await evaluate(page, `(() => {
    const scroller = roomScrollElement();
    return {
      top:scroller.scrollTop,
      height:scroller.scrollHeight,
      client:scroller.clientHeight,
      distance:scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      newest:document.querySelector('#thHistory [data-msg="provider_footer_delayed_sent"]')?.textContent || "",
    };
  })()`);
  assert.ok(afterHydration.height > beforeHydration.height, "the delayed sent payload must extend the transcript");
  assert.ok(afterHydration.distance <= 1,
    `entry follow must land at the hydrated bottom: ${JSON.stringify({ beforeHydration, afterHydration })}`);
  assert.match(afterHydration.newest, /hydrated newest line 18/);
  await evaluate(page, "threadDetailEntryFollow = null; true");

  const before = await evaluate(page, `(() => {
    const rows = [...document.querySelectorAll('#thHistory .th-msg')].filter((row) => row.querySelector('.th-host-actions'));
    return rows.map((row) => {
      const actions = row.querySelector('.th-host-actions');
      const style = getComputedStyle(actions);
      const innerStyle = getComputedStyle(actions.querySelector('.th-host-actions-inner'));
      return {
        id: row.dataset.msg,
        persistent: actions.classList.contains('persistent'),
        buttonHosts: [...actions.querySelectorAll('[data-host-open]')].map((button) => button.dataset.host),
        height: actions.getBoundingClientRect().height,
        opacity: style.opacity,
        innerBottomRadii: [innerStyle.borderBottomLeftRadius, innerStyle.borderBottomRightRadius],
        logoSources: [...actions.querySelectorAll('.th-host-logo')].map((img) => img.getAttribute('src')),
        labelColors: [...actions.querySelectorAll('.th-host-label')].map((label) => getComputedStyle(label).color),
        contexts: [...actions.querySelectorAll('.th-host-context')].map((label) => label.textContent.trim()),
      };
    });
  })()`);
  assert.equal(before.length, 3);
  const resident = before.find((row) => row.persistent);
  const older = before.filter((row) => !row.persistent);
  assert.ok(resident && older.length === 2, "exactly the newest Relay must be resident");
  assert.equal(resident.buttonHosts.length, 1, "one row: the app you chose");
  assert.ok(older.every((row) => JSON.stringify(row.buttonHosts) === JSON.stringify(resident.buttonHosts)),
    "every Relay row names the same chosen app");
  const host = resident.buttonHosts[0];
  assert.ok(host === "codex" || host === "claude");
  assert.ok(resident.height > 45 && resident.opacity === "1", "the newest provider row is permanently visible");
  assert.ok(older.every((row) => row.height <= 1 && row.opacity === "0"), "older provider rows start collapsed");
  assert.deepEqual(resident.logoSources, [host === "codex" ? "codexMark.svg" : "claudeCodeMark.svg"]);
  // The subline is per relay, from real state: the resident fixture was
  // materialized into a Codex task and never into a Claude session.
  assert.deepEqual(resident.contexts, [host === "codex" ? "Continue in its existing task" : "Start a new session with this Relay"]);
  assert.ok(older.every((row) => JSON.stringify(row.contexts) === JSON.stringify([
    host === "codex" ? "Start a new task with this Relay" : "Start a new session with this Relay",
  ])));
  assert.deepEqual(resident.innerBottomRadii, ["14px", "14px"], "the permanent footer clips to the bubble's rounded bottom corners");
  assert.ok(older.every((row) => JSON.stringify(row.innerBottomRadii) === JSON.stringify(["14px", "14px"])),
    "intent-opened footers use the same rounded clipping boundary");
  assert.equal(await evaluate(page, "document.getElementById('thQrOpen') === null"), true,
    "human chat composer has no duplicate Open in agent action");
  assert.equal(await evaluate(page, "document.querySelector('[data-msg=provider_footer_quick_text] .th-host-actions') === null"), true,
    "normal text messages never render provider actions");
  const residentShot = await capture(page, "provider-footer-resident.png");

  const pointFor = async (id, zone = "body", dx = 0) => evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="${id}"]');
    const rect = row.getBoundingClientRect();
    return {
      x:rect.left + rect.width / 2 + ${dx},
      y:${JSON.stringify(zone)} === 'seam' ? rect.bottom - 12 : rect.top + Math.min(24, rect.height / 2),
    };
  })()`);
  const actionState = async (id) => evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="${id}"]');
    const actions = row.querySelector('.th-host-actions');
    return {
      className:row.className,
      expanded:row.getAttribute('aria-expanded'),
      hidden:actions.getAttribute('aria-hidden'),
      inert:actions.inert,
      height:actions.getBoundingClientRect().height,
      opacity:getComputedStyle(actions).opacity,
    };
  })()`);

  // A stationary cursor must not acquire intent merely because wheel scrolling
  // carries another Relay beneath it.
  await evaluate(page, `document.querySelector('[data-msg="provider_footer_oldest"]').scrollIntoView({ block:'center' }); true`);
  await sleep(100);
  const stationaryPoint = await pointFor("provider_footer_oldest", "body");
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:stationaryPoint.x, y:stationaryPoint.y });
  await page.send("Input.dispatchMouseEvent", { type:"mouseWheel", x:stationaryPoint.x, y:stationaryPoint.y, deltaX:0, deltaY:110 });
  await sleep(700);
  assert.equal(await evaluate(page, "document.querySelectorAll('.th-msg.host-intent-open').length"), 0,
    "wheel scrolling under a stationary cursor never opens an older footer");

  // A fast pass through the seam exits before dwell and must stay inert.
  const flyoverPoint = await pointFor("provider_footer_older", "seam");
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:flyoverPoint.x - 70, y:flyoverPoint.y });
  await sleep(5);
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:flyoverPoint.x, y:flyoverPoint.y });
  await sleep(35);
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:20, y:20 });
  await sleep(330);
  assert.equal((await actionState("provider_footer_older")).expanded, "false", "fast flyover is rejected");

  // After scroll quiet, a real post-scroll move and stable seam dwell opens.
  const seamPoint = await pointFor("provider_footer_oldest", "seam", -8);
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:seamPoint.x, y:seamPoint.y });
  await sleep(300);
  const intentOpen = await actionState("provider_footer_oldest");
  assert.match(intentOpen.className, /host-intent-open/);
  assert.equal(intentOpen.expanded, "true");
  assert.equal(intentOpen.hidden, "false");
  assert.equal(intentOpen.inert, false);
  await sleep(280);
  const intentSettled = await actionState("provider_footer_oldest");
  assert.ok(intentSettled.height > 45 && intentSettled.opacity === "1", "deliberate seam dwell opens the complete provider footer");
  const hoverShot = await capture(page, "provider-footer-intent-open.png");

  // Crossing a small boundary does not snap shut; returning inside grace keeps
  // the row open. A full exit closes after 240ms.
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:20, y:20 });
  await sleep(120);
  assert.equal((await actionState("provider_footer_oldest")).expanded, "true", "exit grace prevents flicker");
  const returnPoint = await pointFor("provider_footer_oldest", "seam");
  const beforeReturnDiagnostic = await evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="provider_footer_oldest"]');
    return { rect:row.getBoundingClientRect().toJSON(), viewport:[innerWidth, innerHeight], point:${JSON.stringify(returnPoint)} };
  })()`);
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:returnPoint.x, y:returnPoint.y });
  await sleep(180);
  const reentered = await actionState("provider_footer_oldest");
  const reentryDiagnostic = await evaluate(page, `(() => ({
    target:document.elementFromPoint(${returnPoint.x}, ${returnPoint.y})?.closest?.('[data-msg]')?.dataset?.msg || '',
    machine:relayHostHoverIntent.machine.getState(),
  }))()`);
  assert.equal(reentered.expanded, "true", `re-entry cancels the pending collapse: ${JSON.stringify({ beforeReturnDiagnostic, reentryDiagnostic })}`);

  // Deliberately dwelling on another older Relay atomically transfers the one
  // pointer-open slot instead of leaving an accordion trail behind.
  const secondSeam = await pointFor("provider_footer_older", "seam");
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:secondSeam.x, y:secondSeam.y });
  await sleep(310);
  assert.equal(await evaluate(page, "document.querySelectorAll('.th-msg.host-intent-open').length"), 1);
  assert.equal((await actionState("provider_footer_oldest")).expanded, "false");
  assert.equal((await actionState("provider_footer_older")).expanded, "true");
  await page.send("Input.dispatchMouseEvent", { type:"mouseMoved", x:20, y:20 });
  await sleep(260);
  assert.equal((await actionState("provider_footer_older")).expanded, "false");
  await sleep(200);
  const collapsedAgain = await actionState("provider_footer_older");
  assert.ok(collapsedAgain.height <= 1 && collapsedAgain.opacity === "0",
    `older provider rows collapse cleanly after grace: ${JSON.stringify(collapsedAgain)}`);

  // Keyboard focus pins immediately, exposes correct accessibility state, and
  // Escape closes without sending the user into the message reader.
  await evaluate(page, `document.querySelector('[data-msg="provider_footer_older"]').focus({ preventScroll:true }); true`);
  await sleep(30);
  const keyboardOpen = await actionState("provider_footer_older");
  assert.match(keyboardOpen.className, /host-focus-open/);
  assert.equal(keyboardOpen.expanded, "true");
  await page.send("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape" });
  await page.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape" });
  await sleep(30);
  assert.equal((await actionState("provider_footer_older")).expanded, "false");

  // Reduced motion preserves the states while removing both geometry motion
  // and the provider-logo breathing animation.
  await page.send("Emulation.setEmulatedMedia", { media:"", features:[{ name:"prefers-reduced-motion", value:"reduce" }] });
  await sleep(30);
  const reduced = await evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="provider_footer_older"]');
    row.classList.add('host-intent-open', 'opening');
    const actions = getComputedStyle(row.querySelector('.th-host-actions'));
    const logo = getComputedStyle(row.querySelector('.th-host-logo'));
    const result = { transitionDuration:actions.transitionDuration, animationName:logo.animationName };
    row.classList.remove('host-intent-open', 'opening');
    return result;
  })()`);
  assert.match(reduced.transitionDuration, /(^|, )0s/);
  assert.equal(reduced.animationName, "none");

  // Coarse pointers get a compact, explicit disclosure instead of message-click
  // hover magic. The resident latest footer remains resident and has no toggle.
  await page.send("Emulation.setEmulatedMedia", { media:"", features:[
    { name:"prefers-reduced-motion", value:"reduce" },
    { name:"hover", value:"none" },
    { name:"pointer", value:"coarse" },
  ] });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled:true, maxTouchPoints:1 });
  await sleep(80);
  const coarse = await evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="provider_footer_older"]');
    const button = row.querySelector('[data-host-disclosure]');
    return {
      media:matchMedia('(hover: none), (pointer: coarse)').matches,
      display:getComputedStyle(button).display,
      residentDisclosure:document.querySelector('[data-msg="provider_footer_latest"] [data-host-disclosure]') !== null,
    };
  })()`);
  assert.equal(coarse.media, true);
  assert.equal(coarse.display, "flex");
  assert.equal(coarse.residentDisclosure, false);
  await evaluate(page, `document.querySelector('[data-msg="provider_footer_older"] [data-host-disclosure]').click(); true`);
  await sleep(20);
  assert.equal((await actionState("provider_footer_older")).expanded, "true", "touch disclosure opens without hijacking the message");

  // The compact Relay chip keeps its existing provider rows. A bound row
  // continues directly; an unbound row borrows the existing expanded room
  // frame and unfolds Sven's destination rows directly beneath the pressed
  // provider. There is no separate picker page or provider toggle.
  await page.send("Emulation.setTouchEmulationEnabled", { enabled:false });
  await page.send("Emulation.setEmulatedMedia", { media:"", features:[] });
  const compactPickerStart = await evaluate(page, `(() => {
    agentSurfaces = { _claudeDesktop:{ available:true }, _codexDesktop:{ available:true } };
    localStorage.setItem("proto.agentApps.v2", "Claude Code|Codex");
    sessionPickerState = null;
    chatExpanded = false;
    syncExpandButton();
    renderChatRail();
    applyView();
    renderThreadDetail();
    return {
      cardWidth:Math.round(cardEl.getBoundingClientRect().width),
      hosts:[...document.querySelectorAll('[data-msg="provider_footer_latest"] [data-host-open]')]
        .map((button) => button.dataset.host),
    };
  })()`);
  assert.ok(compactPickerStart.cardWidth >= 330 && compactPickerStart.cardWidth <= 344,
    `the existing room remains on the compact product surface: ${compactPickerStart.cardWidth}px`);
  assert.deepEqual(compactPickerStart.hosts, ["codex", "claude"], "the unchanged chip keeps both configured provider rows");

  await evaluate(page, `document.querySelector('[data-msg="provider_footer_latest"] [data-host="codex"]').click(); true`);
  await sleep(180);
  const boundDirect = await evaluate(page, `({ expanded:chatExpanded, picker:sessionPickerState })`);
  assert.equal(boundDirect.expanded, false, "a bound Relay does not open the destination picker");
  assert.equal(boundDirect.picker, null, "a bound Relay continues directly in its existing task");

  await evaluate(page, `document.querySelector('[data-msg="provider_footer_oldest"] [data-host="codex"]').click(); true`);
  await waitFor(page, `chatExpanded && sessionPickerState?.id === "provider_footer_oldest" && !sessionPickerState.loading`);
  await sleep(700);
  const codexPicker = await evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="provider_footer_oldest"]');
    const pressed = row.querySelector('[data-host="codex"]');
    const list = pressed.nextElementSibling;
    return {
      cardWidth:Math.round(cardEl.getBoundingClientRect().width),
      cardHeight:Math.round(cardEl.getBoundingClientRect().height),
      activeView,
      expanded:chatExpanded,
      pressed:pressed.classList.contains('pressed'),
      ariaExpanded:pressed.getAttribute('aria-expanded'),
      context:pressed.querySelector('.th-host-context')?.textContent.trim(),
      inline:list?.classList.contains('sp-list') || false,
      firstDestination:list?.querySelector('.sp-name')?.textContent.trim(),
      otherProviderVisible:Boolean(row.querySelector('[data-host="claude"]')),
      standalonePicker:Boolean(document.getElementById('sessionPickerView')),
      topProviderToggle:Boolean(document.querySelector('.sp-provider-toggle')),
      duplicateComposerProviders:document.querySelectorAll('#thQr [data-host-open]').length,
    };
  })()`);
  assert.equal(codexPicker.cardWidth, 720, "the provider click expands into the existing 720px room frame");
  assert.equal(codexPicker.cardHeight, 760, "the provider click uses the existing expanded room height");
  assert.equal(codexPicker.activeView, "threads");
  assert.equal(codexPicker.expanded, true);
  assert.equal(codexPicker.pressed, true);
  assert.equal(codexPicker.ariaExpanded, "true");
  assert.equal(codexPicker.context, "Choose where this Relay lands");
  assert.equal(codexPicker.inline, true, "the destinations unfold directly beneath the pressed provider row");
  assert.equal(codexPicker.firstDestination, "New Codex task");
  assert.equal(codexPicker.otherProviderVisible, true, "the other configured provider remains available in place");
  assert.equal(codexPicker.standalonePicker, false);
  assert.equal(codexPicker.topProviderToggle, false);
  assert.equal(codexPicker.duplicateComposerProviders, 0, "the human reply composer contains no duplicate provider actions");
  const codexPickerShot = await capture(page, "provider-footer-codex-session-picker.png");

  await evaluate(page, `document.querySelector('[data-msg="provider_footer_oldest"] [data-host="claude"]').click(); true`);
  await waitFor(page, `sessionPickerState?.provider === "claude" && !sessionPickerState.loading`);
  const claudePicker = await evaluate(page, `(() => {
    const row = document.querySelector('[data-msg="provider_footer_oldest"]');
    const codex = row.querySelector('[data-host="codex"]');
    const claude = row.querySelector('[data-host="claude"]');
    return {
      selected:claude.classList.contains('pressed'),
      codexSelected:codex.classList.contains('pressed'),
      inlineAfterClaude:claude.nextElementSibling?.classList.contains('sp-list') || false,
      firstDestination:claude.nextElementSibling?.querySelector('.sp-name')?.textContent.trim(),
    };
  })()`);
  assert.equal(claudePicker.selected, true, "clicking the other provider moves the inline destination list there");
  assert.equal(claudePicker.codexSelected, false);
  assert.equal(claudePicker.inlineAfterClaude, true);
  assert.equal(claudePicker.firstDestination, "New Claude Code session");
  const claudePickerShot = await capture(page, "provider-footer-claude-session-picker.png");

  // Sven's full-document design: the human letter face owns the same complete
  // preference-backed provider rows, immediately above the reply composer.
  // The composer rail itself remains reply-only. Pressing a row unfolds that
  // provider's destinations in place without leaving the reader.
  await evaluate(page, `openReader("provider_footer_oldest", "threads"); true`);
  await waitFor(page, `activeView === "reader" && readerTab === "you"`);
  await waitFor(page, `document.querySelectorAll('#readerBody .rd-host-actions [data-host-open]').length === 2`);
  await waitFor(page, `!readerMorphInFlight && !document.querySelector('.reader-morph-snapshot')`);
  const readerActions = await evaluate(page, `(() => {
    const actions = document.querySelector('#readerBody .rd-host-actions');
    const replyRail = document.querySelector('#readerBody .ta-dock .ta-rail');
    return {
      hosts:[...actions.querySelectorAll('[data-host-open]')].map((button) => button.dataset.host),
      labels:[...actions.querySelectorAll('.th-host-label')].map((label) => label.textContent.trim()),
      actionsBeforeComposer:Boolean(actions.compareDocumentPosition(document.querySelector('#readerBody .ta-dock')) & Node.DOCUMENT_POSITION_FOLLOWING),
      replyRailActions:[...replyRail.querySelectorAll('button')].map((button) => button.textContent.trim()).filter(Boolean),
      replyPlaceholder:document.querySelector('#readerBody #qrInput')?.getAttribute('placeholder'),
    };
  })()`);
  assert.deepEqual(readerActions.hosts, ["codex", "claude"]);
  assert.deepEqual(readerActions.labels, ["Open in Codex", "Open in Claude Code"]);
  assert.equal(readerActions.actionsBeforeComposer, true, "provider rows sit between the letter and reply composer");
  assert.deepEqual(readerActions.replyRailActions, ["Send"], "the reply rail does not duplicate provider buttons");
  assert.equal(readerActions.replyPlaceholder, "Reply…");
  const readerActionsShot = await capture(page, "reader-provider-actions.png");

  // A live payload/chat refresh can rebuild the reader after the first reveal
  // frame but before the second. The disclosure must arm the replacement node;
  // retaining the original element leaves the actual UI at a two-pixel,
  // opacity-zero seam even though accessibility can see every session row.
  const rerenderedReveal = await evaluate(page, `(async () => {
    sessionPickerState = {
      id:"provider_footer_oldest",
      provider:"codex",
      title:"Relay",
      loading:false,
      error:"",
      data:{ current:null, recent:[] },
      motion:"opening",
    };
    renderReader();
    armSessionPickerReveal();
    await new Promise((resolve) => requestAnimationFrame(() => {
      renderReader();
      resolve();
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const list = document.querySelector('#readerBody [data-sp-reveal="provider_footer_oldest"]');
    const result = {
      open:list?.classList.contains('open') || false,
      height:list?.getBoundingClientRect().height || 0,
      opacity:list ? getComputedStyle(list).opacity : "0",
      motion:sessionPickerState?.motion || "",
    };
    sessionPickerState = null;
    renderReader();
    return result;
  })()`);
  assert.equal(rerenderedReveal.open, true, "a reader rebuild between reveal frames still opens the current disclosure");
  assert.equal(rerenderedReveal.motion, "open");
  assert.ok(rerenderedReveal.height > 1, `the replacement disclosure leaves zero height: ${JSON.stringify(rerenderedReveal)}`);

  const readerMotion = await evaluate(page, `(async () => {
    const selector = '#readerBody .rd-host-actions [data-host="codex"]';
    document.querySelector(selector).click();
    const immediateList = document.querySelector(selector)?.nextElementSibling;
    const immediate = {
      pressed:document.querySelector(selector)?.classList.contains('pressed') || false,
      loading:Boolean(sessionPickerState?.loading),
      inline:immediateList?.classList.contains('sp-list') || false,
    };
    const samples = [];
    const scrollSamples = [];
    const arrivalDeadline = performance.now() + 5000;
    while (performance.now() < arrivalDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const list = document.querySelector(selector)?.nextElementSibling;
      if (!list?.classList.contains('sp-list')) continue;
      const motionDeadline = performance.now() + 1800;
      let settledFrames = 0;
      do {
        samples.push(Math.round(list.getBoundingClientRect().height * 10) / 10);
        scrollSamples.push(Math.round(scrollEl.scrollTop * 10) / 10);
        if (!sessionPickerState?.loading && !sessionPickerState?.resizeAnimation && list.classList.contains('open')) settledFrames += 1;
        else settledFrames = 0;
        if (settledFrames >= 3) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } while (performance.now() < motionDeadline);
      break;
    }
    const list = document.querySelector(selector)?.nextElementSibling;
    const row = list?.previousElementSibling;
    const viewport = scrollEl.getBoundingClientRect();
    return {
      immediate,
      samples,
      scrollSamples,
      finalFit:Boolean(list && row && row.getBoundingClientRect().top >= viewport.top - 1 && list.getBoundingClientRect().bottom <= viewport.bottom + 1),
    };
  })()`);
  await waitFor(page, `activeView === "reader" && sessionPickerState?.provider === "codex" && !sessionPickerState.loading`);
  assert.deepEqual(readerMotion.immediate, { pressed:true, loading:true, inline:true },
    "the click task itself paints the pressed row and loading disclosure");
  const motionHeights = [...new Set(readerMotion.samples)];
  const finalMotionHeight = Math.max(...motionHeights);
  assert.ok(motionHeights.length >= 5, `the picker must paint multiple layout heights, saw ${motionHeights.join(", ")}`);
  assert.ok(finalMotionHeight > 100, `the destination list reaches its full height: ${finalMotionHeight}`);
  assert.ok(motionHeights.some((height) => height > 1 && height < finalMotionHeight * .8),
    `the disclosure has real intermediate frames instead of a discrete jump: ${motionHeights.join(", ")}`);
  assert.equal(readerMotion.finalFit, true, "the selected row and its completed destination list remain inside the reader viewport");
  const viewportFollow = await evaluate(page, `(async () => {
    const prior = sessionPickerState;
    const harness = document.createElement('div');
    harness.style.cssText = 'position:fixed;left:-2000px;top:0;width:320px;height:190px;overflow:auto';
    harness.innerHTML = '<div style="height:130px"></div><button style="display:block;width:100%;height:40px"></button><div class="sp-list open" data-sp-reveal="viewport_follow_fixture" data-sp-provider="codex" style="height:0"><div class="sp-list-inner" style="height:100px"></div></div>';
    document.body.appendChild(harness);
    sessionPickerState = { id:'viewport_follow_fixture', provider:'codex', motion:'open' };
    const reveal = harness.querySelector('[data-sp-reveal]');
    const animation = reveal.animate([{ height:'0px' }, { height:'100px' }], { duration:320, easing:'linear', fill:'forwards' });
    followSessionPickerIntoView(sessionPickerState, 380);
    const samples = [];
    const heights = [];
    const bottoms = [];
    for (let index = 0; index < 26; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push(Math.round(harness.scrollTop * 10) / 10);
      heights.push(Math.round(reveal.getBoundingClientRect().height * 10) / 10);
      bottoms.push(Math.round(reveal.getBoundingClientRect().bottom * 10) / 10);
    }
    await animation.finished;
    const viewport = harness.getBoundingClientRect();
    const row = reveal.previousElementSibling.getBoundingClientRect();
    const list = reveal.getBoundingClientRect();
    const fit = row.top >= viewport.top - 1 && list.bottom <= viewport.bottom + 1;
    const finalScrollTop = harness.scrollTop;
    cancelAnimationFrame(sessionPickerViewportRaf);
    sessionPickerViewportRaf = 0;
    sessionPickerState = prior;
    harness.remove();
    return { samples:[...new Set(samples)], heights:[...new Set(heights)], bottoms:[...new Set(bottoms)], fit, reduced:REDUCED,
      final:{ rowTop:row.top, listBottom:list.bottom, viewportTop:viewport.top, viewportBottom:viewport.bottom, scrollTop:finalScrollTop } };
  })()`);
  assert.ok(viewportFollow.samples.length >= 5,
    `the viewport must follow a growing disclosure over multiple frames: ${JSON.stringify(viewportFollow)}`);
  assert.equal(viewportFollow.fit, true, `the synchronized follower lands with the complete menu inside its viewport: ${JSON.stringify(viewportFollow)}`);
  const readerPicker = await evaluate(page, `(() => {
    const actions = document.querySelector('#readerBody .rd-host-actions');
    const codex = actions.querySelector('[data-host="codex"]');
    const list = codex.nextElementSibling;
    return {
      activeView,
      selected:codex.classList.contains('pressed'),
      context:codex.querySelector('.th-host-context')?.textContent.trim(),
      inline:list?.classList.contains('sp-list') || false,
      firstDestination:list?.querySelector('.sp-name')?.textContent.trim(),
      claudeStillVisible:Boolean(actions.querySelector('[data-host="claude"]')),
      replyStillVisible:Boolean(document.querySelector('#readerBody #qrInput')),
    };
  })()`);
  assert.equal(readerPicker.activeView, "reader", "the full document reader remains the active surface");
  assert.equal(readerPicker.selected, true);
  assert.equal(readerPicker.context, "Choose where this Relay lands");
  assert.equal(readerPicker.inline, true);
  assert.equal(readerPicker.firstDestination, "New Codex task");
  assert.equal(readerPicker.claudeStillVisible, true);
  assert.equal(readerPicker.replyStillVisible, true);
  const readerPickerShot = await capture(page, "reader-provider-session-picker.png");

  // Sent and received Relays share the exact picker. The legacy sent branch
  // called openSent directly and silently forged a new session, which is why
  // Sven saw the picker only on some Relays.
  await evaluate(page, `(() => {
    closeSessionPicker();
    openReader("provider_footer_delayed_sent", "sent");
    return true;
  })()`);
  await waitFor(page, `activeView === "reader" && Boolean(document.querySelector('#readerBody [data-host="codex"][data-source="sent"]'))`);
  const sentImmediate = await evaluate(page, `(() => {
    const button = document.querySelector('#readerBody [data-host="codex"][data-source="sent"]');
    button.click();
    return {
      source:sessionPickerState?.source || "",
      loading:Boolean(sessionPickerState?.loading),
      pressed:document.querySelector('#readerBody [data-host="codex"]')?.classList.contains('pressed') || false,
      inline:document.querySelector('#readerBody [data-sp-provider="codex"]')?.classList.contains('sp-list') || false,
    };
  })()`);
  assert.deepEqual(sentImmediate, { source:"sent", loading:true, pressed:true, inline:true },
    "a sent Relay paints the same picker immediately instead of creating a new session");
  await waitFor(page, `sessionPickerState?.source === "sent" && !sessionPickerState.loading`);
  await sleep(450);
  const sentPicker = await evaluate(page, `(() => ({
    source:sessionPickerState?.source || "",
    firstDestination:document.querySelector('#readerBody [data-sp-provider="codex"] .sp-name')?.textContent.trim(),
    open:document.querySelector('#readerBody [data-sp-provider="codex"]')?.classList.contains('open') || false,
  }))()`);
  assert.deepEqual(sentPicker, { source:"sent", firstDestination:"New Codex task", open:true });
  const sentPickerShot = await capture(page, "sent-reader-provider-session-picker.png");

  console.log(JSON.stringify({ sandbox, before, intentOpen, intentSettled, collapsedAgain, keyboardOpen, reduced, coarse, compactPickerStart, boundDirect, codexPicker, claudePicker, readerActions, rerenderedReveal, readerMotion:{ heights:motionHeights, scrolls:[...new Set(readerMotion.scrollSamples)], finalFit:readerMotion.finalFit }, viewportFollow, readerPicker, sentImmediate, sentPicker, captures:[settingsShot, residentShot, hoverShot, codexPickerShot, claudePickerShot, readerActionsShot, readerPickerShot, sentPickerShot] }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(log);
  process.exitCode = 1;
} finally {
  page?.close();
  main?.close();
  child.kill("SIGTERM");
}
