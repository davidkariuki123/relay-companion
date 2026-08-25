// Live focus probe for the room composer (companion to test/e2e-overlay.mjs).
//
// David, 2026-08-18: "when i send a message in the relay chat, i often want to
// send more. but the pipe/selection doesnt stay focused on the chat composer so
// i need to click the chat composer again if i want to type another message."
//
// Focus is not something inbox.html's source can be read for — the field either
// still has the caret after a send or it does not. So this boots the REAL
// Electron pill in a sandbox against a stub API, opens a room, sends with
// Enter, and reports where the keyboard went. It also lands a new inbound
// message while the composer holds focus, because the old build deferred every
// repaint until the composer blurred.
//
// Run: node test/composer-focus-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png> to write a screenshot of the room it ends on.
//
// Measured 2026-08-18 against origin/main d43ba66 and the fix:
//   old  focusedAfterSend ""          composerSurvived false  keptTyping false
//   new  focusedAfterSend "thQrInput" composerSurvived true   keptTyping true
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

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9412;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-focus-probe-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const sampleDir = path.join(sandbox, "attachment-samples");
fs.mkdirSync(sampleDir, { recursive: true });
fs.writeFileSync(path.join(sampleDir, "probe-image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
fs.writeFileSync(path.join(sampleDir, "probe-video.mp4"), "Relay video attachment probe\n");
fs.writeFileSync(path.join(sampleDir, "probe-notes.txt"), "Relay generic file attachment probe\n");

// ---- stub API: accept the send, return a relay id ----
const seen = [];
const api = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url.startsWith("/v1/relays")) {
      res.end(JSON.stringify({ relayId: "relay_probe_sent_1", id: "relay_probe_sent_1", threadId: "thr_probe" }));
      return;
    }
    res.end(JSON.stringify({ items: [], relays: [], chats: [], contacts: [], groups: [] }));
  });
});
const apiPort = await new Promise((r) => api.listen(0, "127.0.0.1", () => r(api.address().port)));
const apiUrl = `http://127.0.0.1:${apiPort}`;

// ---- two inbound relays from one person: enough to make a room ----
function packet(id, title, createdAt) {
  return {
    direction: "inbound",
    state: "read",
    relayNotificationKind: "plain_relay",
    senderName: "Shane Acton",
    senderEmail: "shane@example.com",
    title,
    forHuman: `${title}`,
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
    pkt_probe_1: packet("pkt_probe_1", "or are human relays basically speaking another language", "2026-08-18T09:00:00.000Z"),
    pkt_probe_2: packet("pkt_probe_2", "thx", "2026-08-18T09:01:00.000Z"),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
};
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
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
  return { send(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }, close() { try { ws.close(); } catch {} } };
}
let page = null;
async function ev(expr, awaitPromise = false) {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, includeCommandLineAPI: false, userGesture: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const result = { label: process.env.PROBE_LABEL || "run" };
try {
  probe: {
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
      const row = document.querySelector("#relaysList .relay-row[data-thread]");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ok) throw new Error("no conversation row yet");
  }, { label: "conversation row" });
  await retry(async () => { if (!(await ev('Boolean(document.getElementById("thQrInput"))'))) throw new Error("no composer"); }, { label: "composer" });
  result.focusedOnEntry = await ev('document.activeElement && document.activeElement.id');

  // Manual Computer Use mode leaves the real Electron room open so a person or
  // desktop-driving test can copy files in Finder, paste them into the composer,
  // inspect the chips, and press Send. The same stub API then proves that the
  // visible interaction crossed every renderer/preload/main/transport boundary.
  if (process.env.PROBE_MANUAL_ATTACHMENTS === "1") {
    result.manualAttachments = true;
    result.sampleDir = sampleDir;
    console.log(JSON.stringify({ ready: true, sampleDir, electronApp: path.dirname(path.dirname(path.dirname(electronBin))) }));
    await retry(async () => {
      if (!seen.some((request) => request.method === "POST" && request.url === "/v1/relays")) throw new Error("no attachment send yet");
      return true;
    }, { tries: 1200, delayMs: 500, label: "Computer Use attachment send" });
    const sends = seen.filter((request) => request.method === "POST" && request.url === "/v1/relays");
    result.apiSends = sends.length;
    result.sentBody = JSON.parse(sends.at(-1).body);
    result.sentAttachments = (result.sentBody.attachments || []).map((file) => ({
      name: file.name,
      contentType: file.contentType,
      bytes: file.bytes,
      hasContent: typeof file.contentBase64 === "string" && file.contentBase64.length > 0,
    }));
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.PROBE_SHOT || path.join(sandbox, "attachments-sent.png"), Buffer.from(shot.data, "base64"));
    result.screenshot = process.env.PROBE_SHOT || path.join(sandbox, "attachments-sent.png");
    break probe;
  }

  // Type like a person who has only opened the room: no composer click first.
  result.firstMessageTypedWithoutClicking = await ev(`(() => {
    const box = document.activeElement;
    if (!box || box.id !== "thQrInput") return false;
    box.value = "first message";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  // Keep the remainder of the probe diagnostic when the entry-focus law alone
  // regresses; that law still fails below, while later send/refresh laws run.
  if (!result.firstMessageTypedWithoutClicking) {
    await ev(`(() => {
      const box = document.getElementById("thQrInput");
      box.focus();
      box.value = "first message";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }
  result.focusedBeforeSend = await ev('document.activeElement && document.activeElement.id');
  result.composerNodeIdBefore = await ev('(() => { const b=document.getElementById("thQrInput"); b.dataset.probeMark="1"; return b.dataset.probeMark; })()');

  // Press Enter, the way the user sends.
  await ev(`(() => {
    const box = document.getElementById("thQrInput");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(2500);

  result.focusedAfterSend = await ev('document.activeElement && document.activeElement.id');
  result.composerSurvived = await ev('(() => { const b=document.getElementById("thQrInput"); return b ? b.dataset.probeMark === "1" : null; })()');
  result.composerValueAfterSend = await ev('(() => { const b=document.getElementById("thQrInput"); return b ? b.value : null; })()');
  result.bubbleRendered = await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("first message"))');
  const sends = seen.filter((r) => r.method === "POST" && r.url === "/v1/relays");
  result.apiSends = sends.length;
  result.sendKeys = sends.map((r) => { try { const b = JSON.parse(r.body); return { title: b.title, key: b.idempotencyKey }; } catch { return { raw: r.body.slice(0, 80) }; } });

  // While the caret is still in the composer, a new message arrives. The old
  // build deferred every repaint until the composer blurred, so the room went
  // deaf exactly while you were mid-conversation.
  const arrivalAt = "2026-08-18T09:05:00.000Z";
  store.packets.pkt_probe_3 = packet("pkt_probe_3", "did that land", arrivalAt);
  fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("did that land"))')) break;
  }
  result.arrivalPaintedWhileFocused = await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("did that land"))');
  result.stillFocusedAfterArrival = await ev('document.activeElement && document.activeElement.id');

  // A picture of the room, for the layout diff.
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(process.env.PROBE_SHOT || path.join(sandbox, "room.png"), Buffer.from(shot.data, "base64"));
  result.screenshot = process.env.PROBE_SHOT || path.join(sandbox, "room.png");

  // Can the user just keep typing?
  await ev(`(() => {
    const b = document.activeElement;
    if (!b || b.id !== "thQrInput") return false;
    b.value = "second message";
    b.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  result.secondMessageTypedWithoutClicking = await ev('(() => { const b=document.getElementById("thQrInput"); return b ? b.value : null; })()') === "second message";
  }
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const laws = result.error ? [] : result.manualAttachments ? [
    ["one Computer Use send reaches the API", result.apiSends === 1],
    ["image, video, and generic file all arrive", result.sentAttachments?.length === 3],
    ["every attachment carries bytes", result.sentAttachments?.every((file) => file.hasContent)],
    ["the image keeps image/png", result.sentAttachments?.some((file) => file.name === "probe-image.png" && file.contentType === "image/png")],
    ["the video keeps video/mp4", result.sentAttachments?.some((file) => file.name === "probe-video.mp4" && file.contentType === "video/mp4")],
    ["the generic file keeps text/plain", result.sentAttachments?.some((file) => file.name === "probe-notes.txt" && file.contentType === "text/plain")],
  ] : [
    ["entering a chat puts the caret in the composer", result.focusedOnEntry === "thQrInput"],
    ["the first message can be typed without clicking", result.firstMessageTypedWithoutClicking === true],
    ["the caret stays in the composer after a send", result.focusedAfterSend === "thQrInput"],
    ["the composer node is never replaced", result.composerSurvived === true],
    ["the sent message empties the field", result.composerValueAfterSend === ""],
    ["the send is visible immediately", result.bubbleRendered === true],
    ["one Enter sends exactly once", result.apiSends === 1],
    ["an arrival paints while the composer holds focus", result.arrivalPaintedWhileFocused === true],
    ["the arrival does not steal the keyboard", result.stillFocusedAfterArrival === "thQrInput"],
    ["the next message can be typed without clicking", result.secondMessageTypedWithoutClicking === true],
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
