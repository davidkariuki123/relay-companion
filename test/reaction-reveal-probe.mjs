// Live probe: a reaction you add to the newest message scrolls into view.
//
// David, 2026-10-09: he hearted Sven's last message and the badge landed
// under the reply dock; he had to scroll to see it. The badge hangs below its
// bubble, so only the real layout can say whether it ends up visible. This
// boots the REAL Electron pill against a stub API, opens a room long enough
// to scroll, reacts to the newest message through its menu, and samples the
// scroll position while the reaction settles.
//
// Run: node test/reaction-reveal-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png> for a screenshot after the reaction;
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

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9419;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reaction-reveal-probe-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

// ---- stub API: no reactions until you add one ----
const reactions = {};
const api = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/relays/reactions") {
      res.end(JSON.stringify({ reactions }));
      return;
    }
    const one = req.method === "POST" && req.url.match(/^\/v1\/relays\/([^/]+)\/reactions$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const { emoji } = JSON.parse(body || "{}");
      reactions[id] = { aggregates: [{ emoji, count: 1, reactedByMe: true, actors: [{ relayUserId: "user_probe", name: "David", self: true }] }], events: [] };
      res.end(JSON.stringify({ reactions: reactions[id], fanoutRelayIds: [id] }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v1/contacts")) {
      res.end(JSON.stringify({ contacts: [{ id: "c_sven", name: "Sven Wellmann", email: "sven@example.com", relayUserId: "u_sven", onRelay: true, source: "manual" }] }));
      return;
    }
    res.end(JSON.stringify({ items: [], relays: [], chats: [], contacts: [], groups: [] }));
  });
});
const apiPort = await new Promise((r) => api.listen(0, "127.0.0.1", () => r(api.address().port)));
const apiUrl = `http://127.0.0.1:${apiPort}`;

// ---- a room long enough to scroll; the newest message is short ----
function packet(title, createdAt) {
  return {
    direction: "inbound", state: "read", relayNotificationKind: "plain_relay",
    senderName: "Sven Wellmann", senderEmail: "sven@example.com",
    title, forHuman: title, createdAt, updatedAt: createdAt,
  };
}
const packets = {};
const LAST = "pkt_probe_14";
for (let i = 1; i <= 14; i++) {
  const at = new Date(Date.UTC(2026, 9, 9, 9, i)).toISOString();
  packets[`pkt_probe_${i}`] = packet(i === 14 ? "sent you a whatsapp" : `message number ${i} about the call later today`, at);
}
const store = {
  version: 1, account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [], packets, meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
};
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
fs.writeFileSync(path.join(relayHome, "overlay-prefs.json"), JSON.stringify({
  onboardingVersions: { "user:user_probe": 2 },
  networkOnboardingCompleted: { [`${apiUrl}|user:user_probe`]: true },
  networkOnboardingPresented: { [`${apiUrl}|user:user_probe`]: true },
  presentedRelayIds: Object.keys(packets),
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
// Where the newest message's badge sits against the reply dock, and the room's scroll.
const geometry = () => ev(`(() => {
  const hist = document.getElementById("thHistory");
  const bubble = hist.querySelector('[data-msg="${LAST}"]');
  const badges = bubble && bubble.querySelector(".rx-badges");
  const dock = hist.querySelector(".th-composer-dock");
  const s = [document.getElementById("thDetail"), document.querySelector("#scroll")].find(n => n && n.scrollHeight > n.clientHeight + 1);
  return {
    badge: badges ? Math.round(badges.getBoundingClientRect().bottom) : null,
    dockTop: dock ? Math.round(dock.getBoundingClientRect().top) : null,
    scrollTop: s ? Math.round(s.scrollTop) : null,
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
  await retry(async () => {
    const ok = await ev(`(() => {
      const row = document.querySelector("#chatList [data-thread], #relaysList .relay-row[data-thread]");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error("no conversation row yet");
  }, { label: "conversation row" });
  await retry(async () => {
    if (!(await ev(`Boolean(document.querySelector('[data-msg="${LAST}"]'))`))) throw new Error("room not painted");
  }, { tries: 80, label: "room" });
  await sleep(1500); // entry follow settles on the newest message
  result.before = await geometry();

  // React the way a person does: the message's menu, then the heart.
  await ev(`document.querySelector('[data-message-more="${LAST}"]').click()`);
  await sleep(150);
  const heart = await centerOf(`[data-rx-pick="${LAST}"][data-emoji="❤️"]`);
  await clickAt(heart.x, heart.y);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) { samples.push(await geometry()); await sleep(30); }
  result.after = samples[samples.length - 1];
  result.scrollPath = [...new Set(samples.map((s) => s.scrollTop))];
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  const shotPath = process.env.PROBE_SHOT || path.join(sandbox, "reveal.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  result.screenshot = shotPath;
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const a = result.after || {};
  const laws = result.error ? [] : [
    ["the room was scrolled to the newest message", result.before?.scrollTop > 0],
    ["the reaction badge painted", a.badge !== null],
    ["the badge ends clear of the reply dock", a.badge !== null && a.dockTop !== null && a.badge <= a.dockTop],
    ["the room glided there rather than jumping", (result.scrollPath || []).length > 2],
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
