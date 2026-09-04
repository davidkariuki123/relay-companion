// Strict Electron DOM probe for the installed-Codex parity ledger.
//
// This is intentionally outside `npm test`. It boots the real Relay overlay in
// an isolated home, injects only a synthetic native feed through the renderer's
// own public state path, and reports every mismatch before exiting non-zero.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const redteamPackageRoot = path.join(dirname, "..");
const redteamRepoRoot = path.join(redteamPackageRoot, "../..");
const sourceRepoRoot = path.resolve(process.env.RELAY_PARITY_SOURCE_ROOT || redteamRepoRoot);
const packageRoot = path.join(sourceRepoRoot, "packages/companion");
const electron = process.env.RELAY_PARITY_ELECTRON || [
  path.join(packageRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(packageRoot, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  path.join(redteamRepoRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
].find(fs.existsSync);
if (!electron) throw new Error("Electron unavailable. Run npm install in the workspace or set RELAY_PARITY_ELECTRON.");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-parity-e2e-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "parity_fixture", deviceId: "parity_fixture", deviceName: "Parity fixture",
  user: { id: "fixture", name: "Fixture", email: "fixture@example.com" },
}));
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {}, profile: { name: "Fixture", transport: { type: "relay_api" } }, contacts: [],
  packets: {
    parity_request: {
      id: "parity_request", direction: "inbound", state: "read", relayNotificationKind: "task",
      senderName: "Sven Wellmann", title: "Verify native runner parity",
      forHuman: "Please verify the runner.", forAgent: "Exercise every native turn state.",
      createdAt: "2026-08-14T08:00:00.000Z", updatedAt: "2026-08-14T08:00:00.000Z",
      codexThreadId: "fixture-thread", taskStartedAt: "2026-08-14T08:00:01.000Z"
    }
  }, meetingNotes: {}, setup: {}, emailThreads: {}, chats: {}
}, null, 2));

const mainPort = 19671 + Math.floor(Math.random() * 100);
const rendererPort = mainPort + 100;
const child = spawn(electron, [
  `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`,
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
let childLog = "";
child.stdout.on("data", (chunk) => { childLog += chunk; });
child.stderr.on("data", (chunk) => { childLog += chunk; });

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
async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

const results = [];
let gateFailed = false;
let fatalError = null;
function check(id, title, ok, evidence) {
  results.push({ id, title, status: ok ? "PASS" : "FAIL", evidence });
}

let page;
try {
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    const pages = await jsonEventually(`http://127.0.0.1:${rendererPort}/json/list`);
    target = pages.find((entry) => entry.type === "page" && /inbox\.html/.test(entry.url));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Relay renderer target was not found");
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");

  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(page, `Boolean(document.querySelector('[data-view="requests"]'))`)) break;
    await sleep(100);
  }
  // The isolated native state migrator intentionally owns its schema. Use the
  // test-only closure seam so this probe exercises the real Task reader
  // without coupling the parity gate to a particular persisted schema.
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(page, `typeof window.__relayParityOpenRequest === "function"`)) break;
    await sleep(100);
  }
  const requestOpened = await evaluate(page, `window.__relayParityOpenRequest?.({
      id:"parity_request", direction:"inbound", state:"read", relayNotificationKind:"task",
      senderName:"Sven Wellmann", title:"Verify native runner parity",
      forHuman:"Please verify the runner.", forAgent:"Exercise every native turn state.",
      createdAt:"2026-08-14T08:00:00.000Z", updatedAt:"2026-08-14T08:00:00.000Z"
    })`);
  if (!requestOpened) {
    const fixtureDiagnostics = await evaluate(page, `({ testOverlay:window.relay?.isTestOverlay, hook:typeof window.__relayParityOpenRequest, href:location.href })`);
    throw new Error(`The isolated Task fixture seam was unavailable: ${JSON.stringify(fixtureDiagnostics)}`);
  }
  await sleep(200);

  const idle = await evaluate(page, `(() => {
    const visible = (node) => {
      const rect = node?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight);
    };
    const human = document.querySelector('.ta-note');
    const humanDock = human?.closest('.rd-foot');
    const humanVisible = visible(humanDock);
    const humanRecipient = humanDock?.textContent || "";
    const humanStart = Boolean(humanDock?.querySelector('[data-approve="parity_request"]'));
    if (human) { human.value = "idle start draft"; human.dispatchEvent(new Event('input', { bubbles:true })); }
    document.querySelector('[data-rtab="agent"]')?.click();
    const agent = document.querySelector('.ta-note');
    const agentDock = agent?.closest('.rd-foot');
    const agentVisible = visible(agentDock);
    const agentRecipient = agentDock?.textContent || "";
    if (agent) { agent.value = "idle provider draft"; agent.dispatchEvent(new Event('input', { bubbles:true })); }
    const result = {
      human:Boolean(human), humanVisible, humanRecipient, humanStart,
      agent:Boolean(agent), agentVisible, agentRecipient,
      start:Boolean(agentDock?.querySelector('[data-approve="parity_request"]')),
      noWork:!document.querySelector('[data-rtab="work"]'),
    };
    document.querySelector('[data-rtab="you"]')?.click();
    result.humanRestored = document.querySelector('.ta-note')?.value || "";
    document.querySelector('[data-rtab="agent"]')?.click();
    result.agentRestored = document.querySelector('.ta-note')?.value || "";
    return result;
  })()`);
  check("J01", "idle For-you has the visible Task Start composer",
    idle.human && idle.humanVisible && idle.humanStart && /Claude Code|Codex|Cowork/.test(idle.humanRecipient), JSON.stringify(idle));
  check("J02", "idle For-agent has a visible Start composer and no Work tab",
    idle.agent && idle.agentVisible && idle.start && idle.noWork && /Claude Code|Codex|Cowork/.test(idle.agentRecipient), JSON.stringify(idle));
  check("J03", "the unstarted Task draft survives across both source faces",
    idle.humanRestored === "idle provider draft" && idle.agentRestored === "idle provider draft", JSON.stringify(idle));

  await evaluate(page, `(() => {
    providerAuthInfo = { ok:true, providers:{
      claude:{ id:"claude", label:"Claude Code", authLoaded:true, installed:true, enabled:true, connected:false, busy:false },
      codex:{ id:"codex", label:"Codex", authLoaded:true, installed:true, enabled:true, connected:false, busy:false },
    } };
    showWorkProviderPrompt("parity_request", "claude");
    return true;
  })()`);
  await sleep(100);
  const disconnected = await evaluate(page, `(() => {
    const actions = document.querySelector('.work-connect-actions');
    const buttons = [...document.querySelectorAll('[data-work-provider]')];
    return {
      workSelected:Boolean(document.querySelector('[data-rtab="work"].on')),
      buttonLabels:buttons.map((button) => button.textContent.replace(/\\s+/g, " ").trim()),
      logos:buttons.map((button) => button.querySelector('img')?.getAttribute('src') || ""),
      columns:actions ? getComputedStyle(actions).gridTemplateColumns : "",
      rawError:/No provider-native Work session/.test(document.querySelector('.work-surface')?.innerText || ""),
      feedAttached:Boolean(document.querySelector('[data-run-stream="parity_request"]')),
      composerDisabled:Boolean(document.querySelector('.work-connect-dock .ta-note[disabled]')),
    };
  })()`);
  check("J03b", "unconnected Work shows both native provider choices without fabricating a run",
    disconnected.workSelected
      && disconnected.buttonLabels.some((label) => /Connect Codex/.test(label))
      && disconnected.buttonLabels.some((label) => /Connect Claude Code/.test(label))
      && disconnected.logos.some((src) => /codexMark\.svg$/.test(src))
      && disconnected.logos.some((src) => /claudeCodeMark\.svg$/.test(src))
      && disconnected.columns.split(" ").length === 2
      && disconnected.composerDisabled
      && !disconnected.rawError
      && !disconnected.feedAttached,
    JSON.stringify(disconnected));
  const connectedChoice = await evaluate(page, `(async () => {
    providerAuthInfo.providers.codex.connected = true;
    renderReader();
    document.querySelector('[data-work-provider="codex"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      promptGone:!document.querySelector('.work-connect'),
      agentSelected:Boolean(document.querySelector('[data-rtab="agent"].on')),
      agentLabel:document.querySelector('[data-rtab="agent"]')?.textContent.trim() || "",
      acceptVisible:Boolean(document.querySelector('[data-approve="parity_request"]')),
    };
  })()`);
  check("J03c", "choosing a ready provider returns to the normal Task composer",
    connectedChoice.promptGone && connectedChoice.agentSelected && /Codex/.test(connectedChoice.agentLabel) && connectedChoice.acceptVisible,
    JSON.stringify(connectedChoice));
  const legacyCompleted = await evaluate(page, `(() => {
    const row = (payload.relays || []).find((item) => item.id === "parity_request");
    workProviderPrompts.delete("parity_request");
    providerAuthInfo = null;
    clearRowNote("parity_request");
    row.taskCompletedAt = "2026-08-14T08:05:00.000Z";
    taskLocal.delete("parity_request");
    readerWorkVisible = true;
    readerTab = "work";
    renderReader();
    const result = {
      text:document.querySelector('.work-surface')?.innerText || "",
      feedAttached:Boolean(document.querySelector('[data-run-stream="parity_request"]')),
      neutralDock:Boolean(document.querySelector('.work-footer button[disabled]')),
    };
    delete row.taskCompletedAt;
    readerWorkVisible = false;
    readerTab = "agent";
    renderReader();
    return result;
  })()`);
  check("J03d", "completed legacy Tasks show a neutral unavailable-history state",
    /Task is complete/.test(legacyCompleted.text)
      && /Live Work history is unavailable/.test(legacyCompleted.text)
      && !/No provider-native Work session/.test(legacyCompleted.text)
      && !legacyCompleted.feedAttached
      && legacyCompleted.neutralDock,
    JSON.stringify(legacyCompleted));

  const liveFeed = {
    ok:true, relayId:"parity_request", provider:"codex", liveState:"active", revision:1,
    presentation:{ provider:"codex", sessionId:"fixture", turns:[{
      key:"turn-1", status:"inProgress", active:true, settled:false, cancelled:false, canCollapse:false,
      timing:{ state:"active", durationMs:5000 }, summary:"Working for 5 sec", final:null, units:[
        { id:"u1", type:"message", role:"user", side:"right", placement:"user", text:"Verify the runner.", attachments:[{ id:"img1", kind:"image", name:"pixel.png", mimeType:"image/png", url:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLahAAAAABJRU5ErkJggg==" }] },
        { id:"a1", type:"activity", placement:"collapsible", activity:{ kind:"read", activeVerb:"Reading", doneVerb:"Read", object:"inbox.html", status:"completed" } },
        { id:"c1", type:"message", role:"assistant", side:"left", phase:"commentary", placement:"collapsible", text:"Inspecting the native runner lifecycle" },
        { id:"u2", type:"message", role:"user", side:"right", placement:"user", text:"Also check reduced motion." },
      ],
    }] },
  };
  await evaluate(page, `(() => {
    const id = "parity_request";
    const feed = ${JSON.stringify(liveFeed)};
    stopRunFeed(id); runFeedPending.add(id); runFeedSeen.set(id, feed); taskLocal.set(id, "running"); readerWorkVisible = true; readerTab = "work";
    renderReader(); paintRunStream(id, feed); return true;
  })()`);
  await sleep(100);

  const runningComposer = await evaluate(page, `(() => {
    const dock = document.querySelector('.work-footer .ta-dock');
    const rect = dock?.getBoundingClientRect();
    return {
      visible:Boolean(rect && rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0),
      placeholder:dock?.querySelector('.ta-note')?.getAttribute('placeholder') || "",
      action:dock?.querySelector('[data-steer]')?.textContent.trim() || "",
      openDisabled:Boolean(dock?.querySelector('[data-open-in][disabled], [data-open-run][disabled], button[aria-disabled="true"]')),
    };
  })()`);
  check("J04", "running Work has a visible provider Queue composer",
    runningComposer.visible && /Queue a follow-up/.test(runningComposer.placeholder) && runningComposer.action === "Queue" && runningComposer.openDisabled,
    JSON.stringify(runningComposer));

  const optimisticReconciliation = await evaluate(page, `(() => {
    const id = "parity_request";
    const native = ${JSON.stringify(liveFeed)};
    runFeedSeen.set(id, native);
    appendOptimisticUserTurn(id, "Visible active Steer", false);
    const steered = preserveOptimisticUsers({ ...native, revision:2 }, runFeedSeen.get(id));
    const steerUnits = steered.presentation.turns.flatMap((turn) => turn.units || []);

    runFeedSeen.set(id, native);
    appendOptimisticUserTurn(id, "Visible queued follow-up", true);
    const queued = preserveOptimisticUsers({ ...native, revision:3 }, runFeedSeen.get(id));
    const queuedTurns = queued.presentation.turns || [];
    return {
      steerVisible:steerUnits.some((unit) => unit.text === "Visible active Steer" && unit.optimisticMode === "steer"),
      queuedVisible:queuedTurns.some((turn) => (turn.units || []).some((unit) => unit.text === "Visible queued follow-up" && unit.optimisticMode === "newTurn")),
      queuedTurnCount:queuedTurns.length,
    };
  })()`);
  check("J04b", "an active Steer remains visible through a provider snapshot",
    optimisticReconciliation.steerVisible, JSON.stringify(optimisticReconciliation));
  check("J04c", "a queued follow-up remains a separate visible turn through a provider snapshot",
    optimisticReconciliation.queuedVisible && optimisticReconciliation.queuedTurnCount === 2,
    JSON.stringify(optimisticReconciliation));

  const stopped = await evaluate(page, `(() => {
    const row = (payload.relays || []).find((item) => item.id === "parity_request");
    row.codexThreadId = "fixture-thread"; row.ranOnCodex = true;
    taskLocal.set("parity_request", "stopped"); readerTab = "work"; readerWorkVisible = true; renderReader();
    const dock = document.querySelector('.work-footer .ta-dock');
    const statusText = document.querySelector('.work-footer')?.textContent || "";
    const withSession = {
      statusText,
      placeholder:dock?.querySelector('.ta-note')?.getAttribute('placeholder') || "",
      action:dock?.querySelector('[data-steer]')?.textContent.trim() || "",
    };
    delete row.codexThreadId; row.ranOnCodex = false;
    readerTab = "agent"; renderReader();
    const retryDock = document.querySelector('.rd-foot .ta-dock');
    const withoutSession = {
      action:retryDock?.querySelector('[data-approve]')?.textContent.trim() || "",
      visible:Boolean(retryDock?.getBoundingClientRect().height),
    };
    row.codexThreadId = "fixture-thread"; row.ranOnCodex = true;
    taskLocal.set("parity_request", "running"); readerTab = "work"; renderReader(); paintRunStream("parity_request", ${JSON.stringify(liveFeed)});
    return { withSession, withoutSession };
  })()`);
  check("J05", "stopped native Work explains failure and offers a visible follow-up",
    /Didn't finish/.test(stopped.withSession.statusText) && /Ask .*follow-up/.test(stopped.withSession.placeholder) && stopped.withSession.action === "Send",
    JSON.stringify(stopped));
  check("J06", "stopped Task without a resumable session offers Start again",
    stopped.withoutSession.visible && stopped.withoutSession.action === "Start again", JSON.stringify(stopped));

  const live = await evaluate(page, `(() => {
    const stream = document.querySelector('[data-run-stream="parity_request"]');
    const nodes = [...stream.querySelectorAll('.work-agent > [data-work-key]')].map((node) => ({ cls: node.className, text: node.textContent.trim() }));
    const user = stream.querySelector('.rd-user');
    const actions = stream.querySelector('.rd-user-actions');
    const userRect = user?.getBoundingClientRect();
    const actionRect = actions?.getBoundingClientRect();
    const userStyle = user ? getComputedStyle(user) : null;
    const userWrapStyle = user?.parentElement ? getComputedStyle(user.parentElement) : null;
    const scroller = document.querySelector('[data-work-scroll="parity_request"]');
    return {
      nodes,
      text: stream.textContent,
      userTabIndex: user?.getAttribute('tabindex') ?? null,
      actionsBelowBubble: Boolean(userRect && actionRect && actionRect.top >= userRect.bottom + 3),
      lineHeight: user ? getComputedStyle(user).lineHeight : null,
      userGeometry: userRect && actionRect && userStyle ? {
        bubble:{ x:userRect.x, y:userRect.y, width:userRect.width, height:userRect.height },
        actions:{ x:actionRect.x, y:actionRect.y, width:actionRect.width, height:actionRect.height },
        maxWidth:userStyle.maxWidth, wrapMaxWidth:userWrapStyle?.maxWidth || "", padding:userStyle.padding, borderRadius:userStyle.borderRadius,
      } : null,
      scrollerTabIndex: scroller?.getAttribute('tabindex') ?? null,
      scrollPaddingBottom: scroller ? getComputedStyle(scroller).scrollPaddingBottom : null,
      imageNaturalWidth: stream.querySelector('.rd-user-image')?.naturalWidth || 0,
      entranceDuration: user ? getComputedStyle(user.closest('.rd-fade') || user).animationDuration : null,
      structuralDuration: stream.querySelector('.work-turn') ? getComputedStyle(stream.querySelector('.work-turn')).animationDuration : null,
    };
  })()`);
  const initialIndex = live.nodes.findIndex((node) => node.text.includes("Verify the runner."));
  const firstActivity = live.nodes.findIndex((node) => /Read|Reading/.test(node.text));
  const steerIndex = live.nodes.findIndex((node) => node.text.includes("Also check reduced motion."));
  check("P02", "chronology", initialIndex < firstActivity && firstActivity < steerIndex,
    JSON.stringify(live.nodes));
  check("P02b", "same-turn right/left/right physical order",
    live.nodes[initialIndex]?.cls.includes("rd-user") && live.nodes[steerIndex]?.cls.includes("rd-user") && initialIndex < firstActivity && firstActivity < steerIndex,
    JSON.stringify(live.nodes));
  check("P03", "generated commentary survives", live.text.includes("Inspecting the native runner lifecycle"), live.text);
  check("P03b", "raw command hidden by default", !live.text.includes("git status --short"), live.text);
  check("P07", "focusable scroller", live.scrollerTabIndex === "0", `tabindex=${live.scrollerTabIndex}`);
  check("P07b", "measured footer coverage", !["", "0px", "auto"].includes(live.scrollPaddingBottom), live.scrollPaddingBottom);
  check("P12", "14/21 user geometry", live.lineHeight === "21px", live.lineHeight);
  check("P13", "focusable user bubble", live.userTabIndex === "0", `tabindex=${live.userTabIndex}`);
  check("P13b", "copy and edit sit outside the message bubble", live.actionsBelowBubble, JSON.stringify(live));
  check("P13c", "user bubble keeps the audited native 77% / 8x12 geometry", live.userGeometry?.wrapMaxWidth === "77%" && live.userGeometry?.maxWidth === "100%" && live.userGeometry?.padding === "8px 12px" && live.userGeometry?.borderRadius === "16px", JSON.stringify(live.userGeometry));
  check("P14", "authorized image preview paints", live.imageNaturalWidth === 1, String(live.imageNaturalWidth));
  check("P15", "new semantic node has native entrance motion", parseFloat(live.entranceDuration) > 0, String(live.entranceDuration));
  check("P15b", "structural turn container does not compound entrance motion", !live.structuralDuration || live.structuralDuration === "0s", String(live.structuralDuration));

  const doneFeed = {
    ok:true, relayId:"parity_request", provider:"codex", liveState:"completed", revision:2,
    presentation:{ provider:"codex", sessionId:"fixture", turns:[{
      key:"turn-1", status:"completed", active:false, settled:true, cancelled:false, canCollapse:true,
      timing:{ state:"settled", durationMs:7000 }, summary:"Worked for 7 sec", final:{ id:"f1", text:"Canonical final answer" }, units:[
        { id:"u1", type:"message", role:"user", side:"right", placement:"user", text:"Verify the runner." },
        { id:"a1", type:"activity", placement:"collapsible", activity:{ kind:"read", activeVerb:"Reading", doneVerb:"Read", object:"brief.md", status:"completed" } },
        { id:"u2", type:"message", role:"user", side:"right", placement:"user", text:"Also check reduced motion." },
        { id:"c2", type:"message", role:"assistant", side:"left", phase:"commentary", placement:"collapsible", text:"Late lifecycle commentary" },
        { id:"f1", type:"message", role:"assistant", side:"left", phase:"final_answer", placement:"final", text:"Canonical final answer" },
      ],
    }] },
  };
  await evaluate(page, `paintRunStream("parity_request", ${JSON.stringify(doneFeed)}); true`);
  await sleep(80);
  const done = await evaluate(page, `(() => {
    const stream = document.querySelector('[data-run-stream="parity_request"]');
    const toggle = stream.querySelector('.rd-activity-toggle');
    const body = stream.querySelector('.rd-activity-body');
    const summary = toggle?.querySelector('[data-work-summary]');
    const toggleRect = toggle?.getBoundingClientRect();
    const summaryRect = summary?.getBoundingClientRect();
    const toggleStyle = toggle ? getComputedStyle(toggle) : null;
    return {
      order:[...stream.querySelectorAll('.work-agent > [data-work-key]')].map((node) => ({ cls:node.className, text:node.textContent.trim() })),
      final: stream.querySelector('.rd-final')?.textContent.trim() || "",
      toggle: toggle?.textContent.trim() || "",
      toggleGeometry: toggleRect && summaryRect && toggleStyle ? {
        toggle:{ x:toggleRect.x, y:toggleRect.y, width:toggleRect.width, height:toggleRect.height },
        summary:{ x:summaryRect.x, y:summaryRect.y, width:summaryRect.width, height:summaryRect.height },
        color:toggleStyle.color, fontSize:toggleStyle.fontSize, lineHeight:toggleStyle.lineHeight,
      } : null,
      bodyDisplay: body ? getComputedStyle(body).display : null,
      inert: body?.hasAttribute('inert') || false,
      ariaHidden: body?.getAttribute('aria-hidden') ?? null,
      activityCount: stream.querySelectorAll('.rd-activity').length,
    };
  })()`);
  check("P04", "phase-addressed final", done.final === "Canonical final answer", done.final);
  const doneFirstUser = done.order.findIndex((node) => node.text.includes("Verify the runner."));
  const doneActivity = done.order.findIndex((node) => node.cls.includes("rd-activity"));
  const doneSteer = done.order.findIndex((node) => node.text.includes("Also check reduced motion."));
  const doneFinal = done.order.findIndex((node) => node.cls.includes("rd-final"));
  check("P04b", "completed right/left/right/final physical order", doneFirstUser < doneActivity && doneActivity < doneSteer && doneSteer < doneFinal, JSON.stringify(done.order));
  check("P05", "truthful non-empty activity summary", done.toggle === "Worked for 7 sec", done.toggle);
  check("P05b", "activity summary occupies visible pixels in its disclosure", done.toggleGeometry?.summary?.width > 0 && done.toggleGeometry?.summary?.height > 0 && done.toggleGeometry?.fontSize === "14px" && done.toggleGeometry?.lineHeight === "21px", JSON.stringify(done.toggleGeometry));
  check("P06", "collapsed disclosure remains measurable", done.bodyDisplay !== "none", done.bodyDisplay);
  check("P06b", "collapsed disclosure is inert", done.inert && done.ariaHidden === "true", JSON.stringify(done));
  check("P10", "native turn disclosure cardinality", done.activityCount >= 2, String(done.activityCount));

  const jsFeed = {
    ok:true, relayId:"parity_request", provider:"codex", liveState:"active", revision:3,
    presentation:{ provider:"codex", sessionId:"fixture", turns:[{
      key:"turn-js", status:"inProgress", active:true, settled:false, cancelled:false, canCollapse:false,
      timing:{ state:"active", durationMs:3000 }, summary:"Working for 3 sec", final:null, units:[
        { id:"js-user", type:"message", role:"user", side:"right", placement:"user", text:"Inspect JavaScript activity." },
        { id:"js-group", type:"activityGroup", placement:"collapsible", summary:"Ran commands", active:true, activeSummary:"Running Rank activity identifiers", groupKey:"codex:javascript", items:[
          { id:"js-1", type:"activity", placement:"collapsible", activity:{ kind:"command", activeVerb:"Running", doneVerb:"Ran", object:"Count UI lines", status:"completed", tool:"js", groupKey:"codex:javascript" } },
          { id:"js-2", type:"activity", placement:"collapsible", activity:{ kind:"command", activeVerb:"Running", doneVerb:"Ran", object:"Verify disclosure selectors", status:"completed", tool:"js", groupKey:"codex:javascript" } },
          { id:"js-3", type:"activity", placement:"collapsible", activity:{ kind:"command", activeVerb:"Running", doneVerb:"Ran", object:"Rank activity identifiers", status:"inProgress", tool:"js", groupKey:"codex:javascript" } },
        ] },
      ],
    }] },
  };
  await evaluate(page, `paintRunStream("parity_request", ${JSON.stringify(jsFeed)}); true`);
  await sleep(700);
  const jsActivity = await evaluate(page, `(() => {
    const stream = document.querySelector('[data-run-stream="parity_request"]');
    const group = stream?.querySelector('[data-semantic-disclosure]');
    const toggle = group?.querySelector('[data-work-disclosure-toggle]');
    return {
      text:stream?.textContent || "",
      groups:stream?.querySelectorAll('.rd-exploration')?.length || 0,
      detailButtons:stream?.querySelectorAll('[data-work-detail-id][role="button"]')?.length || 0,
      activeSweep:Boolean(group?.querySelector('[data-native-cadenced-shimmer].active')),
      collapsed:toggle?.getAttribute('aria-expanded') === 'false' && group?.querySelector('[data-work-disclosure-body]')?.inert === true,
    };
  })()`);
  check("P03c", "adjacent js calls render as one semantic command group with generated names",
    jsActivity.groups === 1 && jsActivity.detailButtons === 3 && jsActivity.activeSweep && jsActivity.collapsed
      && /Running Rank activity identifiers/.test(jsActivity.text)
      && /Count UI lines/.test(jsActivity.text) && /Verify disclosure selectors/.test(jsActivity.text)
      && /Rank activity identifiers/.test(jsActivity.text) && !/Called js|Calling js/.test(jsActivity.text),
    JSON.stringify(jsActivity));

  await evaluate(page, `(() => {
    const stream = document.querySelector('[data-run-stream="parity_request"]');
    const disclosure = stream?.querySelector('[data-work-disclosure-toggle]');
    if (disclosure?.getAttribute('aria-expanded') !== 'true') disclosure?.click();
    return true;
  })()`);
  await sleep(360);
  await evaluate(page, `document.querySelector('[data-run-stream="parity_request"] [data-work-detail-id]')?.click(); true`);
  await sleep(80);
  const detailDisclosure = await evaluate(page, `(() => {
    const row = document.querySelector('[data-run-stream="parity_request"] [data-work-detail-id]');
    const detail = row?._workDetailHost || null;
    const rowRect = row?.getBoundingClientRect();
    const detailRect = detail?.getBoundingClientRect();
    return {
      expanded:row?.getAttribute('aria-expanded'),
      controls:row?.getAttribute('aria-controls'),
      detailId:detail?.id || '',
      detailText:detail?.textContent || '',
      sibling:detail?.previousElementSibling === row,
      visible:Boolean(detailRect && detailRect.width > 0 && detailRect.height > 0),
      below:Boolean(rowRect && detailRect && detailRect.top >= rowRect.bottom - 1),
    };
  })()`);
  check("P03d", "activity rows disclose bounded detail below the header instead of inside its flex row",
    detailDisclosure.expanded === "true" && detailDisclosure.controls === detailDisclosure.detailId
      && detailDisclosure.sibling && detailDisclosure.visible && detailDisclosure.below
      && detailDisclosure.detailText.trim().length > 0,
    JSON.stringify(detailDisclosure));

  const sourceComposers = await evaluate(page, `(() => {
    readerTab = "you"; readerWorkVisible = true; renderReader();
    const visible = (node) => { const rect=node?.getBoundingClientRect(); return Boolean(rect && rect.width>0 && rect.height>0 && rect.bottom>0 && rect.top<innerHeight); };
    const human = document.querySelector('#qrInput');
    const humanFooter = human?.closest('.rd-foot');
    const humanVisible = visible(humanFooter);
    const humanRecipient = humanFooter?.textContent || "";
    if (human) { human.value = "unsent human reply"; human.dispatchEvent(new Event('input', { bubbles:true })); }
    document.querySelector('[data-rtab="agent"]')?.click();
    const agent = document.querySelector('.ta-note');
    const agentFooter = agent?.closest('.rd-foot');
    const agentVisible = visible(agentFooter);
    const agentRecipient = agentFooter?.textContent || "";
    if (agent) { agent.value = "unsent provider follow-up"; agent.dispatchEvent(new Event('input', { bubbles:true })); }
    document.querySelector('[data-rtab="you"]')?.click();
    const humanRestored = document.querySelector('#qrInput')?.value || "";
    document.querySelector('[data-rtab="agent"]')?.click();
    const agentRestored = document.querySelector('.ta-note')?.value || "";
    document.querySelector('[data-rtab="work"]')?.click();
    const work = document.querySelector('.work-footer .ta-note');
    return {
      human:Boolean(human && humanFooter && humanVisible),
      humanRecipient,
      agent:Boolean(agent && agentFooter && agentVisible),
      agentRecipient,
      work:Boolean(work && visible(work.closest('.work-footer'))),
      humanRestored,
      agentRestored,
    };
  })()`);
  check("P16", "For-you keeps the human reply composer after Work exists",
    sourceComposers.human && /Sven Wellmann/.test(sourceComposers.humanRecipient), JSON.stringify(sourceComposers));
  check("P16b", "For-agent keeps the provider follow-up composer after Work exists",
    sourceComposers.agent && /Claude Code|Codex|Cowork/.test(sourceComposers.agentRecipient), JSON.stringify(sourceComposers));
  check("P16c", "Work keeps its provider follow-up composer",
    sourceComposers.work, JSON.stringify(sourceComposers));
  check("P16d", "human and provider drafts survive source-tab round trips independently",
    sourceComposers.humanRestored === "unsent human reply" && sourceComposers.agentRestored === "unsent provider follow-up",
    JSON.stringify(sourceComposers));

  const requestReplyProjection = await evaluate(page, `(() => {
    const reply = {
      relayId:"sent-request-reply", threadId:"parity_request", inReplyToRelayId:"parity_request",
      kind:"message", title:"Visible human reply", forHuman:"Visible human reply",
      createdAt:"2026-08-14T08:05:00.000Z",
      recipient:{ name:"Sven Wellmann", email:"sven@example.com", onRelay:true },
    };
    const completion = {
      ...reply,
      relayId:"provider-completion",
      type:"completion",
      title:"machine completion",
      forAgent:"Provider-owned completion detail stays on the Task.",
    };
    const inboundCompletion = {
      id:"inbound-provider-completion", threadId:"parity_request", inReplyToRelayId:"parity_request",
      relayNotificationKind:"plain_relay", type:"completion", title:"incoming completion",
      forHuman:"Incoming human result", forAgent:"Incoming agent handoff",
      senderName:"Sven Wellmann", senderEmail:"sven@example.com",
      createdAt:"2026-08-14T08:06:00.000Z",
    };
    payload.relays = [...(payload.relays || []), inboundCompletion];
    payload.sent = [...(payload.sent || []), reply, completion];
    const rows = threadMessages();
    const projected = rows.find((row) => row.id === reply.relayId);
    return {
      visible:Boolean(projected),
      text:projected?.body || "",
      party:projected?.party || "",
      completion:rows.find((row) => row.id === completion.relayId) || null,
      inboundCompletion:rows.find((row) => row.id === inboundCompletion.id) || null,
      joinsRoom:projected ? sameDirectParty(projected, "email:sven@example.com", "sven wellmann") : false,
    };
  })()`);
  check("P16e", "a For-you reply on a Task thread appears in the person's conversation",
    requestReplyProjection.visible && requestReplyProjection.text === "Visible human reply" && requestReplyProjection.joinsRoom,
    JSON.stringify(requestReplyProjection));
  check("P16f", "completion closes the loop in chat as a two-document Relay",
    requestReplyProjection.completion?.body === "Visible human reply" &&
      requestReplyProjection.completion?.textLike === false &&
      requestReplyProjection.completion?.agent === "Provider-owned completion detail stays on the Task." &&
      requestReplyProjection.inboundCompletion?.body === "Incoming human result" &&
      requestReplyProjection.inboundCompletion?.textLike === false &&
      requestReplyProjection.inboundCompletion?.agent === "Incoming agent handoff",
    JSON.stringify(requestReplyProjection));

  await evaluate(page, `paintRunStream("parity_request", ${JSON.stringify(doneFeed)}); true`);
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate(page, `(() => { const b=document.querySelector('.rd-activity-body'); b?.classList.remove('hidden'); return true; })()`);
  const reduced = await evaluate(page, `(() => {
    const row=document.querySelector('.rd-activity.rd-fade');
    const body=document.querySelector('.work-conversation .rd-activity-body');
    return row && body ? {
      nodeDuration:getComputedStyle(row).animationDuration,
      nodeDelay:getComputedStyle(row).animationDelay,
      nodeTransform:getComputedStyle(row).transform,
      disclosureDuration:getComputedStyle(body).transitionDuration,
      disclosureTiming:getComputedStyle(body).transitionTimingFunction,
    } : null;
  })()`);
  check("P11", "split reduced motion matches native nodes and disclosure", reduced?.nodeDuration === "0s" && reduced?.nodeDelay === "0s" && ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(reduced?.nodeTransform) && reduced?.disclosureDuration.split(",").every((value) => value.trim() === "0.3s") && reduced?.disclosureTiming.includes("0.19"), JSON.stringify(reduced));

  console.log(JSON.stringify({ sandbox, results }, null, 2));
  gateFailed = results.some((result) => result.status === "FAIL");
} catch (error) {
  console.error(JSON.stringify({ sandbox, fatal: String(error?.stack || error), childLog }, null, 2));
  fatalError = error;
} finally {
  try { page?.close(); } catch {}
  child.kill("SIGTERM");
}

if (fatalError) throw fatalError;
if (gateFailed) throw new Error("Codex parity Electron gate failed; inspect the complete matrix above.");
