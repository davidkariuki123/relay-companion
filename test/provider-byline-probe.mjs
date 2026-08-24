// Live provenance-byline probe (companion to test/composer-focus-probe.mjs).
//
// David, 2026-08-19, looking at a room full of agent-written Relays: "I don't
// seem to see this new UI."
//
// The byline could not be read off inbox.html's source with any confidence,
// because the feature was dead for two independent reasons at once and the
// source-text tests were green throughout. So this boots the REAL Electron
// pill in a sandbox and reports which rows actually carry a footer.
//
// The three staged Relays are the three cases that matter:
//   codex-titled   titled + forAgent, surface "codex"        <- has host actions
//   claude-text    plain text, surface "claude_code"         <- the only case that used to work
//   unlabelled     no surface at all                         <- must stay silent
//
// Run: node test/provider-byline-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png> to write a screenshot of the room it ends on.
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
// blocked), so allow an existing tree's copy — same escape as the group-info probe.
const electronBin = [
  process.env.RELAY_ELECTRON_BIN,
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((p) => p && fs.existsSync(p)) || "";
if (!electronBin) { console.error("no electron found"); process.exit(1); }

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9413;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-byline-probe-"));
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

function packet({ title, forHuman, forAgent = "", surface, at }) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Shane Acton",
    senderEmail: "shane@example.com",
    title,
    forHuman,
    forAgent,
    // Exactly the shape the API returns as sourceMeta.
    source: { host: "relay-mcp", ...(surface ? { surface } : {}) },
    createdAt: at,
    updatedAt: at,
  };
}
const store = {
  version: 1,
  account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    pkt_codex_titled: packet({
      title: "Safer Tasks model",
      forHuman: "Three separate signals, and read means the human triggered access.",
      forAgent: "Full reasoning for the recipient's agent lives here.",
      surface: "codex",
      at: "2026-08-19T09:00:00.000Z",
    }),
    pkt_claude_text: packet({
      title: "",
      forHuman: "the human readable surface here is horrible",
      surface: "claude_code",
      at: "2026-08-19T09:01:00.000Z",
    }),
    pkt_unlabelled: packet({
      title: "",
      forHuman: "sent before provenance was ever captured",
      at: "2026-08-19T09:02:00.000Z",
    }),
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
    RELAY_AUTO_UPDATE: "0",
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
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    },
    close() { try { ws.close(); } catch {} },
  };
}
let page = null;
async function ev(expr, awaitPromise = false) {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, includeCommandLineAPI: false, userGesture: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

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
      const tab = [...document.querySelectorAll("button,[role=tab],.tab")].find(b => /^Relays$/i.test((b.textContent||"").trim()));
      if (tab) tab.click();
      const row = document.querySelector("#relaysList .relay-row[data-thread]");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error("no conversation row yet");
  }, { label: "conversation row" });
  await retry(async () => { if (!(await ev('document.querySelectorAll("#thHistory .th-msg").length >= 3'))) throw new Error("room not painted"); }, { label: "room" });

  // Show the oldest row (the titled, host-action one) and let the marks load
  // before asking whether they painted — decode() settles that without a sleep.
  await ev('document.querySelector("#thHistory .th-msg").scrollIntoView({ block: "center" }); true');
  await ev(`Promise.all([...document.querySelectorAll(".th-provider-byline img")]
    .map((img) => img.decode().then(() => true).catch(() => false)))`, true);

  // What the human actually sees, read off the live DOM.
  result.rows = await ev(`(() => [...document.querySelectorAll("#thHistory .th-msg")].map((row) => ({
    title: (row.querySelector(".th-msg-title")?.textContent || "").trim().slice(0, 44),
    hasHostActions: row.classList.contains("has-host-actions"),
    textLike: row.classList.contains("text"),
    byline: (row.querySelector(".th-provider-byline")?.textContent || "").trim(),
    mark: row.querySelector(".th-provider-byline img")?.getAttribute("src") || "",
    markPainted: (() => {
      const img = row.querySelector(".th-provider-byline img");
      return img ? img.complete && img.naturalWidth > 0 : null;
    })(),
  })))()`);

  if (process.env.PROBE_SHOT) {
    // The room repaints on its own cadence and restores its own scroll, so
    // rather than fight it, give the viewport enough height to show every row.
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 520, height: 1180, deviceScaleFactor: 2, mobile: false,
    });
    // Let the history lay out at full height instead of scrolling, so every
    // row is in one frame. Capture-only: nothing here is asserted on.
    await ev(`(() => {
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) {
          el.style.overflow = "visible";
          el.style.maxHeight = "none";
          el.style.height = "auto";
        }
      }
      return true;
    })()`);
    await ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', true);
    const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, "base64"));
    result.screenshot = process.env.PROBE_SHOT;
  }
} catch (err) {
  result.error = String(err && err.message);
  result.log = log.slice(-1500);
} finally {
  try { page && page.close(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  try { api.close(); } catch {}
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.error ? 1 : 0);
