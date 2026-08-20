// Live probe for the agent document's kicker (companion to
// test/open-note-probe.mjs and test/composer-focus-probe.mjs).
//
// David, 2026-08-20, on "FOR YOUR AGENT · RIDES WITH THIS RELAY":
// "i dont like that rides with this relay copy".
//
// The replacement is METADATA, not a claim — the same grammar as the human
// kicker above it. What the line SAYS is readable off inbox.html; that it
// still lands under the tab, in the mono caps rule, with a real count off the
// seeded forAgent, is not. So this boots the REAL pill, opens the reader,
// clicks the agent tab, and reads the painted line.
//
// Run: node test/agent-kicker-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png>
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.env.RELAY_PKG_ROOT || path.join(__dirname, "..");
const electronBin = [
  process.env.RELAY_ELECTRON_BIN,
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((p) => p && fs.existsSync(p)) || "";
if (!electronBin) { console.error("no electron binary; set RELAY_ELECTRON_BIN"); process.exit(1); }

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9436;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-kicker-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const api = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [], relays: [], chats: [], contacts: [], groups: [] }));
  });
});
const apiPort = await new Promise((r) => api.listen(0, "127.0.0.1", () => r(api.address().port)));
const apiUrl = `http://127.0.0.1:${apiPort}`;

// A known agent document, so the painted count is checkable by hand.
const AGENT_DOC = [
  "Verification, if Sven asks: pill → Settings shows the exact running version on the bottom line.",
  "",
  "- pull ~/.relay/logs and look for a consumer that never woke",
  "- **then** pin the regression",
].join("\n");
const EXPECTED_WORDS = AGENT_DOC.trim().split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

function packet(title, createdAt, forAgent) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Shane Acton",
    senderEmail: "shane@example.com",
    title,
    forHuman: "Sven — your \"still not working\" report found a real blind spot: every bit of hand-off feedback we added lived on relay ROWS.",
    forAgent,
    body: "A relay with a body, so the bubble is a real relay.",
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
    pkt_kick_1: packet("Safer Requests model", "2026-08-20T09:00:00.000Z", AGENT_DOC),
    // A relay whose agent document is a single word, to prove the singular.
    pkt_kick_2: packet("Channel pump never runs", "2026-08-20T09:01:00.000Z", "Ship"),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
};
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "dev_probe_token", deviceId: "dev_probe", deviceName: "Probe Mac",
  user: { id: "user_probe", name: "David", email: "david@example.com" },
  apiUrl,
}, null, 2));

const child = spawn(electronBin, [`--remote-debugging-port=${CDP_PORT}`, path.join(pkgRoot, "overlay", "main.cjs")], {
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
  return { send(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }, close() { try { ws.close(); } catch {} } };
}
let page = null;
async function ev(expr) {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, includeCommandLineAPI: false, userGesture: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const result = { label: process.env.PROBE_LABEL || "run", pkgRoot, expectedWords: EXPECTED_WORDS };
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

  // Relays -> the conversation row -> the room.
  await retry(async () => {
    const ok = await ev(`(() => {
      const tab = [...document.querySelectorAll("button,[role=tab],.tab")].find(b => /^Relays$/i.test((b.textContent||"").trim()));
      if (tab) tab.click();
      const row = document.querySelector("#relaysList .relay-row[data-thread]");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error("no conversation row yet");
  }, { label: "conversation row" });

  // Open the reader on the seeded relay (the renderer's own entry point).
  await retry(async () => {
    const ok = await ev(`(() => {
      if (typeof openReader !== "function") return false;
      openReader("pkt_kick_1", "probe");
      return true;
    })()`);
    if (!ok) throw new Error("openReader not reachable");
    const tabs = await ev('document.querySelectorAll("[data-rtab]").length');
    if (!tabs) throw new Error("reader painted no fold tabs");
  }, { label: "reader with fold tabs" });

  result.tabLabels = await ev('[...document.querySelectorAll("[data-rtab]")].map(b => b.textContent.trim())');
  result.humanKicker = await ev('(document.querySelector(".rd-kicker")||{}).textContent');

  // Click the agent tab exactly as a hand would.
  await ev(`document.querySelector('[data-rtab="agent"]').click()`);
  await sleep(400);
  result.agentKicker = String(await ev('(document.querySelector(".rd-kicker")||{}).textContent') || "").trim();
  result.kickerStyle = await ev(`(() => {
    const el = document.querySelector(".rd-kicker");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fontFamily: cs.fontFamily.split(",")[0], fontSize: cs.fontSize, transform: cs.textTransform, align: cs.textAlign };
  })()`);

  const shot = process.env.PROBE_SHOT || path.join(sandbox, "agent-doc.png");
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(shot, Buffer.from(png.data, "base64"));
  result.screenshot = shot;

  // The singular, on the one-word agent document.
  await ev(`(() => { closeReader && closeReader(); })()`).catch(() => {});
  await ev(`openReader("pkt_kick_2", "probe")`);
  await sleep(300);
  await ev(`document.querySelector('[data-rtab="agent"]').click()`);
  await sleep(300);
  result.singularKicker = String(await ev('(document.querySelector(".rd-kicker")||{}).textContent') || "").trim();
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const laws = result.error ? [] : [
    ["the old transport claim is gone", !/RIDES WITH/i.test(result.agentKicker || "")],
    ["the line names the document's addressee", /^FOR YOUR AGENT/.test(result.agentKicker || "")],
    ["it carries the real word count", (result.agentKicker || "").includes(`· ${EXPECTED_WORDS} WORDS`)],
    ["one word is not \"1 WORDS\"", result.singularKicker === "FOR YOUR AGENT · 1 WORD"],
    ["it still obeys the kicker rule (mono, uppercase, centred)", Boolean(result.kickerStyle && /mono|SF Mono|Menlo|ui-monospace/i.test(result.kickerStyle.fontFamily) && result.kickerStyle.transform === "uppercase" && result.kickerStyle.align === "center")],
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
