// Strict DOM probe for Relay's second Work surface: the standalone AI preview.
// It boots the production preview renderer/preload against a deterministic
// native session response and reports all mismatches before exiting non-zero.

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-preview-parity-"));
const rendererPort = 19871 + Math.floor(Math.random() * 100);
const feed = {
  ok:true, relayId:"preview-parity", provider:"codex", liveState:"completed", revision:7,
  presentation:{ provider:"codex", sessionId:"preview-fixture", turns:[
    { key:"turn-1", status:"completed", active:false, settled:true, canCollapse:true, summary:"Worked for 3 sec", timing:{ state:"settled", durationMs:3000 }, final:{ id:"f1", text:"First turn final" }, units:[
      { id:"u1", type:"message", role:"user", side:"right", placement:"user", text:"Verify the runner.", attachments:[{ id:"img1", kind:"image", name:"pixel.png", mimeType:"image/png" }] },
      { id:"a1", type:"activity", placement:"collapsible", activity:{ kind:"read", activeVerb:"Reading", doneVerb:"Read", object:"inbox.html", status:"completed" } },
      { id:"f1", type:"message", role:"assistant", side:"left", phase:"final_answer", placement:"final", text:"First turn final" },
    ] },
    { key:"turn-2", status:"completed", active:false, settled:true, canCollapse:true, summary:"Worked for 4 sec", timing:{ state:"settled", durationMs:4000 }, final:{ id:"f2", text:"Reduced motion is verified." }, units:[
      { id:"u2", type:"message", role:"user", side:"right", placement:"user", text:"Also check reduced motion." },
      { id:"c1", type:"message", role:"assistant", side:"left", phase:"commentary", placement:"collapsible", text:"I found the chronology boundary and am checking the renderer." },
      { id:"u3", type:"message", role:"user", side:"right", placement:"user", text:"Keep the native timing." },
      { id:"a2", type:"activity", placement:"collapsible", activity:{ kind:"read", activeVerb:"Reading", doneVerb:"Read", object:"motion.css", status:"completed" } },
      { id:"f2", type:"message", role:"assistant", side:"left", phase:"final_answer", placement:"final", text:"Reduced motion is verified." },
    ] },
  ] },
};

const child = spawn(electron, [
  `--remote-debugging-port=${rendererPort}`,
  path.join(dirname, "fixtures/codex-parity/preview-harness.cjs"),
], {
  env: {
    ...process.env,
    RELAY_PARITY_PACKAGE_ROOT: packageRoot,
    RELAY_PARITY_USER_DATA: path.join(sandbox, "userdata"),
    RELAY_PARITY_PREVIEW_FEED: JSON.stringify(feed),
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
function check(id, title, layer, ok, evidence) {
  results.push({ id, title, layer, status: ok ? "PASS" : "FAIL", evidence });
}
let page;
let fatalError;
try {
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    const pages = await jsonEventually(`http://127.0.0.1:${rendererPort}/json/list`);
    target = pages.find((entry) => entry.type === "page" && /preview\.html/.test(entry.url));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Relay preview target was not found");
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(page, `document.querySelectorAll('#sessionList > *').length > 0`)) break;
    await sleep(100);
  }

  const state = await evaluate(page, `(() => {
    const list = document.querySelector('#sessionList');
    const nodes = [...list.querySelectorAll('.session-turn > [data-session-segment]')].map((node) => ({ cls: node.className, text: node.textContent.trim() }));
    const activity = list.querySelector('.session-activity');
    const toggle = activity?.querySelector('.session-activity-toggle');
    const body = activity?.querySelector('.session-activity-body');
    const finals = [...list.querySelectorAll('.session-final')];
    const final = finals.at(-1);
    const user = list.querySelector('.user-msg');
    const actions = list.querySelector('.session-user-actions');
    const userRect = user?.getBoundingClientRect();
    const actionRect = actions?.getBoundingClientRect();
    const userStyle = user ? getComputedStyle(user) : null;
    const userWrapStyle = user?.parentElement ? getComputedStyle(user.parentElement) : null;
    const toggleRect = toggle?.getBoundingClientRect();
    const summary = toggle?.querySelector('[data-work-summary]');
    const summaryRect = summary?.getBoundingClientRect();
    const toggleStyle = toggle ? getComputedStyle(toggle) : null;
    const scroller = document.querySelector('#sessionScroll');
    return {
      nodes,
      text: list.textContent,
      visibleText: list.innerText,
      final: final?.textContent.trim() || '',
      toggle: toggle?.textContent.trim() || '',
      toggleGeometry: toggleRect && summaryRect && toggleStyle ? {
        toggle:{ x:toggleRect.x, y:toggleRect.y, width:toggleRect.width, height:toggleRect.height },
        summary:{ x:summaryRect.x, y:summaryRect.y, width:summaryRect.width, height:summaryRect.height },
        color:toggleStyle.color, fontSize:toggleStyle.fontSize, lineHeight:toggleStyle.lineHeight,
      } : null,
      bodyDisplay: body ? getComputedStyle(body).display : null,
      inert: body?.hasAttribute('inert') || false,
      ariaHidden: body?.getAttribute('aria-hidden') ?? null,
      activityCount: list.querySelectorAll('.session-activity').length,
      userLineHeight: user ? getComputedStyle(user).lineHeight : null,
      actionsBelowBubble: Boolean(userRect && actionRect && actionRect.top >= userRect.bottom + 3),
      userGeometry: userRect && actionRect && userStyle ? {
        bubble:{ x:userRect.x, y:userRect.y, width:userRect.width, height:userRect.height },
        actions:{ x:actionRect.x, y:actionRect.y, width:actionRect.width, height:actionRect.height },
        maxWidth:userStyle.maxWidth, wrapMaxWidth:userWrapStyle?.maxWidth || "", padding:userStyle.padding, borderRadius:userStyle.borderRadius,
      } : null,
      finalLineHeight: final ? getComputedStyle(final).lineHeight : null,
      scrollerTabIndex: scroller?.getAttribute('tabindex') ?? null,
      scrollPaddingBottom: scroller ? getComputedStyle(scroller).scrollPaddingBottom : null,
      imageNaturalWidth: list.querySelector('.session-user-image')?.naturalWidth || 0,
      entranceDuration: user ? getComputedStyle(user.closest('.session-fade') || user).animationDuration : null,
      structuralDuration: list.querySelector('.session-turn') ? getComputedStyle(list.querySelector('.session-turn')).animationDuration : null,
    };
  })()`);
  const firstUser = state.nodes.findIndex((node) => node.text.includes("Verify the runner."));
  const firstFinal = state.nodes.findIndex((node) => node.text.includes("First turn final"));
  const steer = state.nodes.findIndex((node) => node.text.includes("Also check reduced motion."));
  const sameTurnActivity = state.nodes.findIndex((node) => node.text.includes("I found the chronology boundary"));
  const sameTurnSteer = state.nodes.findIndex((node) => node.text.includes("Keep the native timing."));
  const secondFinal = state.nodes.findIndex((node) => node.text.includes("Reduced motion is verified."));
  const commentaryDisclosureFound = await evaluate(page, `(() => {
    const activity = [...document.querySelectorAll('.session-activity')]
      .find((node) => node.textContent.includes('I found the chronology boundary and am checking the renderer.'));
    activity?.querySelector('.session-activity-toggle')?.click();
    return Boolean(activity);
  })()`);
  await sleep(350);
  const expandedCommentary = await evaluate(page, `(() => {
    const activity = [...document.querySelectorAll('.session-activity')]
      .find((node) => node.textContent.includes('I found the chronology boundary and am checking the renderer.'));
    const body = activity?.querySelector('.session-activity-body');
    return { visible:body?.innerText || '', expanded:activity?.querySelector('.session-activity-toggle')?.getAttribute('aria-expanded') };
  })()`);
  check("P02", "two-turn chronology", "renderer", firstUser >= 0 && firstUser < firstFinal && firstFinal < steer && steer < secondFinal, JSON.stringify(state.nodes));
  check("P02b", "same-turn right/left/right/final physical order", "renderer", steer < sameTurnActivity && sameTurnActivity < sameTurnSteer && sameTurnSteer < secondFinal, JSON.stringify(state.nodes));
  check("P03", "commentary is preserved and disclosed as narration", "adapter", commentaryDisclosureFound && expandedCommentary?.expanded === "true" && expandedCommentary?.visible.includes("I found the chronology boundary and am checking the renderer.") && state.final !== "I found the chronology boundary and am checking the renderer.", JSON.stringify(expandedCommentary));
  check("P04", "phase-addressed final", "adapter", state.final === "Reduced motion is verified.", state.final);
  check("P05", "truthful non-empty activity summary", "renderer", state.toggle === "Worked for 3 sec", state.toggle);
  check("P05b", "activity summary occupies visible pixels in its disclosure", "renderer", state.toggleGeometry?.summary?.width > 0 && state.toggleGeometry?.summary?.height > 0, JSON.stringify(state.toggleGeometry));
  check("P06", "collapsed disclosure remains measurable", "renderer", state.bodyDisplay !== "none", state.bodyDisplay);
  check("P06b", "collapsed disclosure is inert", "renderer", state.inert && state.ariaHidden === "true", JSON.stringify(state));
  check("P07", "focusable Work scroller", "scroll", state.scrollerTabIndex === "0", String(state.scrollerTabIndex));
  check("P07b", "measured footer coverage", "scroll", !["", "0px", "auto"].includes(state.scrollPaddingBottom), String(state.scrollPaddingBottom));
  check("P10", "one disclosure per native turn", "renderer", state.activityCount >= 2, String(state.activityCount));
  check("P12", "exact installed 14/21 geometry", "renderer", state.userLineHeight === "21px" && state.finalLineHeight === "21px", `${state.userLineHeight}/${state.finalLineHeight}`);
  check("P13b", "copy and edit sit outside the message bubble", "renderer", state.actionsBelowBubble, JSON.stringify(state));
  check("P13c", "user bubble keeps the audited native 77% / 8x12 geometry", "renderer", state.userGeometry?.wrapMaxWidth === "77%" && state.userGeometry?.maxWidth === "100%" && state.userGeometry?.padding === "8px 12px" && state.userGeometry?.borderRadius === "16px", JSON.stringify(state.userGeometry));
  check("P14", "authorized image preview paints", "renderer", state.imageNaturalWidth === 1, String(state.imageNaturalWidth));
  check("P15", "new semantic node has native entrance motion", "renderer", parseFloat(state.entranceDuration) > 0, String(state.entranceDuration));
  check("P15b", "structural turn container does not compound entrance motion", "renderer", !state.structuralDuration || state.structuralDuration === "0s", String(state.structuralDuration));

  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await evaluate(page, `(() => {
    const row = document.querySelector('.session-user-wrap.session-fade');
    const body = document.querySelector('.session-activity-body');
    return row && body ? {
      nodeDuration:getComputedStyle(row).animationDuration,
      nodeDelay:getComputedStyle(row).animationDelay,
      nodeTransform:getComputedStyle(row).transform,
      disclosureDuration:getComputedStyle(body).transitionDuration,
      disclosureTiming:getComputedStyle(body).transitionTimingFunction,
    } : null;
  })()`);
  check("P11", "split reduced motion matches native nodes and disclosure", "renderer", reduced?.nodeDuration === "0s" && reduced?.nodeDelay === "0s" && ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(reduced?.nodeTransform) && reduced?.disclosureDuration.split(",").every((value) => value.trim() === "0.3s") && reduced?.disclosureTiming.includes("0.19"), JSON.stringify(reduced));

  console.log(JSON.stringify({ sandbox, surface: "relay-ai-preview", results }, null, 2));
} catch (error) {
  fatalError = error;
  console.error(JSON.stringify({ sandbox, fatal: String(error?.stack || error), childLog }, null, 2));
} finally {
  try { page?.close(); } catch {}
  child.kill("SIGTERM");
}

if (fatalError) throw fatalError;
if (results.some((result) => result.status === "FAIL")) {
  throw new Error("Codex parity preview gate failed; inspect the complete matrix above.");
}
