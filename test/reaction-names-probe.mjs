// Live probe for "who reacted" (companion to test/composer-focus-probe.mjs).
//
// David, 2026-09-17: a reaction badge in a Relay text message never says who
// reacted. The badge did carry the names in a native title=, but Electron 38+
// on macOS shows an HTML title tooltip once and then almost never again
// (electron/electron#49843), so inside the pill it reads as "nothing happens".
//
// Whether a card appears under a resting pointer cannot be read off
// inbox.html's source. So this boots the REAL Electron pill in a sandbox
// against a stub API that answers the reactions batch with actors, opens a
// room, rests the pointer on each badge over CDP, and reports what appeared.
//
// Run: node test/reaction-names-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png> to write a screenshot with the card open;
//      PROBE_ELECTRON_BIN to point at an Electron binary.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.env.RELAY_PKG_ROOT || path.join(__dirname, "..");
const electronExecutable = process.platform === "win32"
  ? "electron.exe"
  : process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : "electron";
const electronBin = [
  process.env.PROBE_ELECTRON_BIN,
  path.join(pkgRoot, "node_modules", "electron", "dist", electronExecutable),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", electronExecutable),
].find((p) => p && fs.existsSync(p)) || "";
if (!electronBin) { console.error("no electron at", electronBin); process.exit(1); }

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9418;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reaction-names-probe-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

// ---- stub API: the reactions batch carries every actor with its count ----
const actor = (id, name, self = false) => ({ relayUserId: id, name, self });
const reactions = {
  pkt_probe_1: {
    aggregates: [{ emoji: "🙏", count: 1, reactedByMe: false, actors: [actor("u_shane", "Shane Acton")] }],
    events: [],
  },
  pkt_probe_2: {
    aggregates: [{
      emoji: "👍", count: 6, reactedByMe: true,
      actors: [actor("u_shane", "Shane Acton"), actor("u_sven", "Sven"), actor("user_probe", "David", true),
        actor("u_amara", "Amara Bennett"), actor("u_alex", "Alex Chen"), actor("u_chloe", "Chloe Davies")],
    }],
    events: [],
  },
};
const seen = [];
const api = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/relays/reactions") {
      res.end(JSON.stringify({ reactions }));
      return;
    }
    // Shane is a contact, so the room is a chat rather than a request.
    if (req.method === "GET" && req.url.startsWith("/v1/contacts")) {
      res.end(JSON.stringify({ contacts: [{ id: "c_shane", name: "Shane Acton", email: "shane@example.com", relayUserId: "u_shane", onRelay: true, source: "manual" }] }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/v1/relays")) {
      res.end(JSON.stringify({ relayId: "relay_probe_sent_1", id: "relay_probe_sent_1", threadId: "thr_probe" }));
      return;
    }
    res.end(JSON.stringify({ items: [], relays: [], chats: [], contacts: [], groups: [] }));
  });
});
const apiPort = await new Promise((r) => api.listen(0, "127.0.0.1", () => r(api.address().port)));
const apiUrl = `http://127.0.0.1:${apiPort}`;

// ---- two inbound texts from one person: enough to make a room ----
function packet(title, createdAt) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Shane Acton",
    senderEmail: "shane@example.com",
    title,
    forHuman: title,
    createdAt,
    updatedAt: createdAt,
  };
}
const store = {
  version: 1,
  account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    pkt_probe_1: packet("Oh weird. I asked claude to send the task.", "2026-09-17T17:00:00.000Z"),
    pkt_probe_2: packet("I'll send it through later", "2026-09-17T17:01:00.000Z"),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
};
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
// Onboarding is complete for this account (both chapters), or the pill paints
// "Your first relay" over every view. Keyed the way main keys it: user:<id>.
fs.writeFileSync(path.join(relayHome, "overlay-prefs.json"), JSON.stringify({
  onboardingVersions: { "user:user_probe": 2 },
  networkOnboardingCompleted: { [`${apiUrl}|user:user_probe`]: true },
  networkOnboardingPresented: { [`${apiUrl}|user:user_probe`]: true },
  presentedRelayIds: ["pkt_probe_1", "pkt_probe_2"],
}, null, 2));
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "dev_probe_token", deviceId: "dev_probe", deviceName: "Probe Mac",
  user: { id: "user_probe", name: "David", email: "david@example.com" },
  apiUrl,
}, null, 2));

const overlayMain = path.join(pkgRoot, "overlay", "main.cjs");
const child = spawn(electronBin, [`--remote-debugging-port=${CDP_PORT}`, overlayMain], {
  env: {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_OVERLAY_USER_DATA: userData,
    RELAY_OVERLAY_PERF: "1",
    RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
    RELAY_CONFIG: path.join(sandbox, "config.json"),
    RELAY_API_URL: apiUrl,
    RELAY_WEB_URL: apiUrl,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, { tries = 60, delayMs = 250, label = "condition" } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(delayMs); }
  }
  throw new Error(`timed out waiting for ${label}: ${last && last.message}`);
}
async function connectWs(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let seq = 0; const pending = new Map();
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  });
  return { send(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }, close() { ws.close(); } };
}
let page = null;
async function ev(expr, awaitPromise = false) {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, includeCommandLineAPI: false, userGesture: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
// The pointer really moves: Chromium's hover state and pointer events come
// from Input.dispatchMouseEvent, never from a synthetic DOM event.
async function centerOf(selector) {
  const rect = await ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!rect) throw new Error(`no element for ${selector}`);
  return rect;
}
async function moveTo(x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
}
async function clickAt(x, y) {
  await moveTo(x, y);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
}
const cardState = () => ev(`(() => {
  const card = document.getElementById("rxNames");
  if (!card) return { present: false };
  const open = card.matches(":popover-open");
  const r = card.getBoundingClientRect();
  const pill = document.getElementById("card").getBoundingClientRect();
  return {
    present: true, open,
    text: open ? (card.textContent || "").replace(/\\s+/g, " ").trim() : "",
    role: card.getAttribute("role"), full: card.classList.contains("full"),
    people: card.querySelectorAll(".rx-names-person").length,
    seeAll: Boolean(card.querySelector("[data-rx-names-all]")),
    side: card.dataset.side || "",
    insidePill: open ? (r.left >= pill.left && r.right <= pill.right && r.top >= pill.top && r.bottom <= pill.bottom) : null,
    focus: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : "",
  };
})()`);

const result = { label: process.env.PROBE_LABEL || "run" };
try {
  const target = await retry(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find((t) => t.type === "page" && String(t.url).includes("inbox.html"));
    if (!p) throw new Error("no inbox page");
    return p;
  }, { label: "renderer page" });
  page = await connectWs(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await retry(async () => { if (!(await ev('Boolean(document.getElementById("thHistory"))'))) throw new Error("no skeleton"); }, { label: "skeleton" });

  // Open Relays, then the one conversation row.
  await retry(async () => {
    const ok = await ev(`(() => {
      const tab = [...document.querySelectorAll("button,[role=tab],.tab")].find(b => /^Relays$/i.test((b.textContent||"").trim()));
      if (tab) tab.click();
      const row = document.querySelector("#chatList [data-thread], #relaysList .relay-row[data-thread]");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error("no conversation row yet");
  }, { label: "conversation row" });
  // Badges appear once the reactions batch has answered and the room repainted.
  await retry(async () => {
    if (!(await ev('document.querySelectorAll("[data-rx-toggle]").length >= 2'))) throw new Error("no badges yet");
  }, { tries: 80, label: "reaction badges" });
  result.badgeTitles = await ev('[...document.querySelectorAll("[data-rx-toggle]")].map(b => b.getAttribute("title"))');
  result.badgeLabels = await ev('[...document.querySelectorAll("[data-rx-toggle]")].map(b => b.getAttribute("aria-label"))');
  result.idle = await cardState();

  // One person: rest the pointer on the badge and wait past the dwell.
  const one = await centerOf('[data-rx-toggle="pkt_probe_1"]');
  await moveTo(one.x, one.y);
  await sleep(500);
  result.one = await cardState();

  // Six people: three names and "See all".
  const six = await centerOf('[data-rx-toggle="pkt_probe_2"]');
  await moveTo(six.x, six.y);
  await sleep(500);
  result.six = await cardState();
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  const shotPath = process.env.PROBE_SHOT || path.join(sandbox, "names.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  result.screenshot = shotPath;

  // Cross the gap onto the card and into "See all": the whole list, pinned.
  const all = await centerOf("#rxNames [data-rx-names-all]");
  await moveTo(six.x, six.y + 8);
  await moveTo(all.x, all.y);
  await sleep(250);
  result.bridged = await cardState();
  await clickAt(all.x, all.y);
  await sleep(250);
  result.full = await cardState();
  const fullShot = await page.send("Page.captureScreenshot", { format: "png" });
  const fullPath = shotPath.replace(/\.png$/, "-all.png");
  fs.writeFileSync(fullPath, Buffer.from(fullShot.data, "base64"));
  result.screenshotAll = fullPath;

  // The pinned list survives the pointer leaving, and a room repaint under it.
  await moveTo(six.x, six.y + 160);
  await sleep(400);
  result.pinnedAfterLeave = await cardState();
  store.packets.pkt_probe_3 = packet("did that land", "2026-09-17T17:05:00.000Z");
  fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
  await retry(async () => {
    if (!(await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("did that land"))'))) throw new Error("arrival not painted");
  }, { tries: 40, delayMs: 500, label: "arrival" });
  await sleep(300);
  result.pinnedAfterRepaint = await cardState();

  // Escape closes it and hands the keyboard back to the badge.
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(150);
  result.afterEscape = await cardState();

  // A pointer that rests, then really leaves.
  const oneAgain = await centerOf('[data-rx-toggle="pkt_probe_1"]');
  await moveTo(oneAgain.x, oneAgain.y);
  await sleep(500);
  result.hoverAgain = await cardState();
  await moveTo(oneAgain.x, oneAgain.y + 120);
  await sleep(400);
  result.afterLeave = await cardState();

  // Keyboard focus shows the names at once, no dwell. (Escape handed the
  // keyboard to this badge already; a focus that does not move fires nothing.)
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(300);
  await ev('document.querySelector(\'[data-rx-toggle="pkt_probe_2"]\').focus()');
  await sleep(60);
  result.focused = await cardState();
  await ev('document.activeElement && document.activeElement.blur()');
  await sleep(400);
  result.afterBlur = await cardState();
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const laws = result.error ? [] : [
    ["no badge relies on a native title tooltip", Array.isArray(result.badgeTitles) && result.badgeTitles.every((t) => t === null)],
    ["a badge tells a screen reader who reacted", (result.badgeLabels || []).some((l) => /Shane Acton, Sven, You and 3 others/.test(l || ""))],
    ["nothing shows until a pointer rests on a badge", result.idle?.open === false],
    ["one person: the name, no See all", result.one?.open === true && result.one.text === "Shane Acton" && result.one.seeAll === false && result.one.role === "tooltip"],
    ["six people: three names, the rest counted, See all", result.six?.open === true && /^Shane Acton, Sven, You and 3 others\s*See all 6$/.test(result.six.text || "") && result.six.role === "dialog"],
    ["the card stays inside the pill", result.six?.insidePill === true],
    ["the pointer can cross the gap onto the card", result.bridged?.open === true],
    ["See all lists every person and pins the card", result.full?.full === true && result.full.people === 6 && /6 reactions/.test(result.full.text || "") && /^rx-names-close/.test(result.full.focus || "")],
    ["a pinned list survives the pointer leaving", result.pinnedAfterLeave?.open === true && result.pinnedAfterLeave.people === 6],
    ["a pinned list survives a room repaint", result.pinnedAfterRepaint?.open === true && result.pinnedAfterRepaint.people === 6],
    ["Escape closes it and refocuses the badge", result.afterEscape?.open === false && /rx-badge/.test(result.afterEscape?.focus || "")],
    ["hovering again shows it again", result.hoverAgain?.open === true],
    ["a pointer that leaves lets it go", result.afterLeave?.open === false],
    ["keyboard focus shows the names at once", result.focused?.open === true && result.focused.seeAll === true],
    ["blur lets it go", result.afterBlur?.open === false],
  ];
  result.broken = laws.filter(([, ok]) => !ok).map(([name]) => name);
  console.log(JSON.stringify(result, null, 2));
  for (const [name, ok] of laws) console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
  try { page && page.close(); } catch {}
  child.kill("SIGKILL");
  api.close();
  await sleep(300);
  process.exit(result.error || result.broken.length ? 1 : 0);
}
