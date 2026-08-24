// Live probe for the row note under an "Open in {app}" click (companion to
// test/composer-focus-probe.mjs).
//
// David, 2026-08-19, on the pill's Claude Code row: "it shoudlnt say this exact.
// just say opening in claude code. and then once its done (can we detect
// this?if not just do after a few seconds), reove that green text"
//
// The wording is readable off inbox.html. Whether the line ever LEAVES is not:
// it depends on main.cjs's openDone reaching the renderer and on nothing having
// written over the note since. So this boots the REAL Electron pill in a
// sandbox, opens the room, clicks Open in Claude Code, and samples the note
// slot until it empties.
//
// Run: node test/open-note-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT_NOTE=<png> while the note is up, PROBE_SHOT=<png> after.
//
// Measured 2026-08-19 against origin/main ebc9c8f and the fix:
//   old  "Opening this exact Relay in Claude Code…"  never cleared (still up at 20s)
//   new  "Opening in Claude Code…"                   cleared 915ms after the open landed
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.env.RELAY_PKG_ROOT || path.join(__dirname, "..");
// A fresh worktree installs electron without its binary (install scripts are
// blocked), so RELAY_ELECTRON_BIN can borrow one from an existing tree.
const electronBin = [
  process.env.RELAY_ELECTRON_BIN,
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((p) => p && fs.existsSync(p)) || "";
if (!electronBin) { console.error("no electron binary; set RELAY_ELECTRON_BIN"); process.exit(1); }

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9433;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-open-note-"));
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

function packet(title, createdAt) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Shane Acton",
    senderEmail: "shane@example.com",
    title,
    forHuman: title,
    forAgent: "The agent document. A relay with a forAgent is not text-like, so the bubble carries the agent rows.",
    body: "A relay with a body, so the bubble is a real relay and carries the agent rows.",
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
    pkt_note_1: packet("Safer Tasks model", "2026-08-19T09:00:00.000Z"),
    pkt_note_2: packet("Where Relay can go", "2026-08-19T09:01:00.000Z"),
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

const result = { label: process.env.PROBE_LABEL || "run", pkgRoot };
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
  const pageErrors = [];
  await retry(async () => { if (!(await ev('Boolean(document.getElementById("thHistory"))'))) throw new Error("no skeleton"); }, { label: "skeleton" });

  // Relays -> the one conversation row -> the room.
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

  // The newest relay paints its agent rows open (persistent), like the screenshot.
  try {
    await retry(async () => {
      const n = await ev('document.querySelectorAll("[data-host-open]").length');
      if (!n) throw new Error("no host rows");
    }, { tries: 20, label: "host rows" });
  } catch (e) {
    result.diag = await ev(`(() => ({
      msgs: document.querySelectorAll(".th-msg").length,
      rows: document.querySelectorAll("#relaysList .relay-row").length,
      disclosures: document.querySelectorAll("[data-host-disclosure]").length,
      visibleIds: [...document.querySelectorAll("[id]")].map(n => n.id).filter(Boolean).slice(0, 40),
      bodyText: (document.body.innerText || "").slice(0, 600),
    }))()`);
    throw e;
  }
  result.hostRowLabels = await ev('[...document.querySelectorAll("[data-host-open]")].map(b => (b.querySelector(".th-host-label")||{}).textContent)');

  // Click "Open in Claude Code" on the newest relay, then watch its note slot.
  result.clickedId = await ev(`(() => {
    const b = [...document.querySelectorAll('[data-host-open][data-host="claude"]')].pop();
    if (!b) return "";
    const id = b.getAttribute("data-host-open");
    b.click();
    return id;
  })()`);
  if (!result.clickedId) throw new Error("no Claude Code row to click");
  const noteExpr = `(() => { const el = document.querySelector('[data-err="' + CSS.escape(${JSON.stringify(result.clickedId)}) + '"]'); return el ? { text: el.textContent, ok: el.classList.contains("ok") } : null; })()`;

  const started = Date.now();
  let firstSeenAt = 0;
  result.noteText = "";
  result.noteWasGreen = null;
  result.clearedAfterMs = null;
  for (let i = 0; i < 200; i += 1) {          // up to ~20s
    const note = await ev(noteExpr);
    const text = String(note?.text || "");
    if (text && !result.noteText) {
      result.noteText = text; result.noteWasGreen = !!note.ok; firstSeenAt = Date.now();
      if (process.env.PROBE_SHOT_NOTE) {
        const live = await page.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(process.env.PROBE_SHOT_NOTE, Buffer.from(live.data, "base64"));
      }
    }
    if (result.noteText && !text) { result.clearedAfterMs = Date.now() - firstSeenAt; break; }
    await sleep(100);
  }
  result.watchedForMs = Date.now() - started;
  result.stillShowing = result.clearedAfterMs === null ? await ev(noteExpr) : null;
  const shot = process.env.PROBE_SHOT || path.join(sandbox, "room.png");
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(shot, Buffer.from(png.data, "base64"));
  result.screenshot = shot;
  result.consoleErrors = pageErrors;
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const laws = result.error ? [] : [
    ["the note names the app and nothing else", result.noteText === "Opening in Claude Code…"],
    ["it never says \"this exact Relay\"", !/this exact/i.test(result.noteText)],
    ["it is the green (ok) note", result.noteWasGreen === true],
    ["it is readable, not a flash", (result.clearedAfterMs ?? 0) >= 700],
    ["it retires once the open lands", result.clearedAfterMs !== null && result.clearedAfterMs < 6000],
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
