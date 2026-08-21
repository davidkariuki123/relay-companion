// Live offline-send probe (companion to test/composer-focus-probe.mjs).
//
// David, 2026-08-20: "i tried to send a text to the granular group whilst not on
// wifi/weak wifi and the message was on sending for a while then came back into
// the composer. but that's not how whatsapp works."
//
// Whether a message survives a dead connection is not something inbox.html's
// source can be read for — the words either stay in the room and go out by
// themselves when the network returns, or they do not. So this boots the REAL
// Electron pill in a sandbox against a stub API that starts by destroying every
// send socket, types a message, and then lets the network come back.
//
// Run: node test/offline-send-probe.mjs   (needs a GUI session)
// Env: PROBE_SHOT=<png> writes a screenshot of the offline room.
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
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((p) => fs.existsSync(p)) || "";
if (!electronBin) { console.error("no electron found"); process.exit(1); }

const CDP_PORT = Number(process.env.PROBE_CDP_PORT) || 9414;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-offline-probe-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

// ---- stub API whose network can be cut ----
// Destroying the socket is what an unreachable API actually looks like to
// undici: TypeError "fetch failed". It reproduces the offline case in
// milliseconds instead of waiting out the client's 15s abort.
const net = { up: false };
const sends = [];
// What the server says it has done with the message, once it has it. The ladder
// the sender sees is read straight off this: pending (the API has it) ->
// delivered (routed to the recipient) -> read.
const sentProjection = { items: [] };
const api = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const isSend = req.method === "POST" && req.url.startsWith("/v1/relays");
    if (!net.up) {
      if (isSend) sends.push({ body, refused: true });
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (isSend) {
      sends.push({ body, refused: false });
      // A distinct id per accepted send, as the real API mints. A stub that
      // reuses one id makes the second message look like a copy of the first
      // to every reconciliation downstream.
      const id = `relay_probe_${sends.filter((s) => !s.refused).length}`;
      res.end(JSON.stringify({ relayId: id, id, threadId: "thr_probe" }));
      return;
    }
    if (req.url.startsWith("/v1/sent")) {
      res.end(JSON.stringify({ items: sentProjection.items }));
      return;
    }
    res.end(JSON.stringify({ items: [], relays: [], chats: [], contacts: [], groups: [] }));
  });
});
/** One Sent row for the message the probe sent, at a given rung of the ladder. */
function sentRow(state) {
  return {
    relayId: "relay_probe_1", state, kind: "message",
    createdAt: "2026-08-20T09:02:00.000Z", updatedAt: "2026-08-20T09:02:00.000Z",
    recipient: { name: "Shane Acton", email: "shane@example.com", onRelay: true },
    forHuman: "sent from a tunnel", forAgent: "", preview: "",
    threadId: "thr_probe", source: { host: "relay-preview" },
    hasAttachments: false, attachments: [], reactions: { aggregates: [], events: [] },
    ...(state === "read" ? { readAt: "2026-08-20T09:03:00.000Z" } : {}),
  };
}
const apiPort = await new Promise((r) => api.listen(0, "127.0.0.1", () => r(api.address().port)));
const apiUrl = `http://127.0.0.1:${apiPort}`;

function packet(id, title, createdAt) {
  return {
    direction: "inbound", state: "read", relayNotificationKind: "plain_relay",
    senderName: "Shane Acton", senderEmail: "shane@example.com",
    title, forHuman: title, createdAt, updatedAt: createdAt,
  };
}
const store = {
  version: 1, account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    pkt_probe_1: packet("pkt_probe_1", "you around", "2026-08-20T09:00:00.000Z"),
    pkt_probe_2: packet("pkt_probe_2", "thx", "2026-08-20T09:01:00.000Z"),
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
};
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify(store, null, 2));
fs.writeFileSync(path.join(sandbox, "config.json"), JSON.stringify({
  deviceToken: "dev_probe_token", deviceId: "dev_probe", deviceName: "Probe Mac",
  user: { id: "user_probe", name: "David", email: "david@example.com" },
  apiUrl,
}, null, 2));

let log = "";
function boot(port) {
  const proc = spawn(electronBin, [`--remote-debugging-port=${port}`, path.join(pkgRoot, "overlay", "main.cjs")], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_OVERLAY_USER_DATA: userData,
      RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
      RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
      RELAY_CONFIG: path.join(sandbox, "config.json"),
      RELAY_API_URL: apiUrl,
      RELAY_WEB_URL: apiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  return proc;
}
let child = boot(CDP_PORT);

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
const outboxFile = path.join(relayHome, "outbox.json");
function outboxEntries() {
  try { return JSON.parse(fs.readFileSync(outboxFile, "utf8")).entries || []; } catch { return []; }
}
// Read the state line under a message, opening whatever room now holds it.
// Once the server projects a send back, its canonical row can land in a
// different conversation than the one the probe happens to have open — which
// says nothing about the message and everything about the probe's navigation.
const underBubble = (text) => `(() => {
  const find = () => [...document.querySelectorAll(".th-msg")].find(n => (n.textContent||"").includes(${JSON.stringify(text)}));
  let msg = find();
  if (!msg) {
    for (const row of [...document.querySelectorAll("#relaysList .relay-row[data-thread]")]) {
      row.click();
      msg = find();
      if (msg) break;
    }
  }
  if (!msg) return null;
  const under = msg.nextElementSibling;
  return under && under.classList.contains("th-under") ? under.textContent.trim() : "";
})()`;

async function attach(port) {
  const target = await retry(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === "page" && String(t.url).includes("inbox.html"));
    if (!p) throw new Error("no inbox page");
    return p;
  }, { label: "renderer page" });
  page = await connectWs(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await retry(async () => { if (!(await ev('Boolean(document.getElementById("thHistory"))'))) throw new Error("no skeleton"); }, { label: "skeleton" });
}
async function openRoom() {
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
}
async function typeAndSend(text) {
  await ev(`(() => {
    const box = document.getElementById("thQrInput");
    box.focus();
    box.value = ${JSON.stringify(text)};
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
}

const result = { label: process.env.PROBE_LABEL || "offline-send" };
try {
  await attach(CDP_PORT);
  await openRoom();

  // ---- send with the network down ----
  await typeAndSend("sent from a tunnel");

  // The old build took the client's full 15s abort before it gave up and put
  // the words back. Wait past that to prove nothing takes them back at all.
  await sleep(3000);
  result.composerAfterOfflineSend = await ev('(() => { const b=document.getElementById("thQrInput"); return b ? b.value : null; })()');
  result.bubbleVisibleOffline = await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("sent from a tunnel"))');
  result.stateWordOffline = await ev(underBubble("sent from a tunnel"));
  const queued = outboxEntries();
  result.outboxHoldsIt = queued.length === 1 && queued[0].text === "sent from a tunnel";
  result.outboxStateOffline = queued[0]?.state;
  result.outboxAttemptsOffline = queued[0]?.attempts;
  result.queuedKey = queued[0]?.idempotencyKey;
  result.refusedAttempts = sends.filter((s) => s.refused).length;

  // The pill folds itself when nothing is engaging it, and a folded pill
  // photographs as a logo. Unfold it so the picture is of the room.
  await ev('setCollapsed(false)').catch(() => {});
  await sleep(900);
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(process.env.PROBE_SHOT || path.join(sandbox, "offline-room.png"), Buffer.from(shot.data, "base64"));
  result.screenshot = process.env.PROBE_SHOT || path.join(sandbox, "offline-room.png");

  // Nothing else is typed, nothing is pressed: the wifi simply comes back.
  net.up = true;
  await ev('window.dispatchEvent(new Event("online"))');
  const wentOut = await retry(async () => {
    const accepted = sends.filter((s) => !s.refused);
    if (!accepted.length) throw new Error("not sent yet");
    return accepted;
  }, { tries: 40, delayMs: 500, label: "the message to send itself" }).catch(() => []);

  result.sentWithoutTouchingIt = wentOut.length >= 1;
  result.acceptedSends = wentOut.length;
  const keys = sends.map((s) => { try { return JSON.parse(s.body).idempotencyKey; } catch { return null; } });
  result.oneKeyAcrossEveryAttempt = new Set(keys.filter(Boolean)).size === 1;
  result.keyMatchesQueue = keys.filter(Boolean).every((k) => k === result.queuedKey);
  await sleep(2500);
  result.outboxAfterSend = outboxEntries().map((e) => e.state);
  result.composerStillEmpty = await ev('(() => { const b=document.getElementById("thQrInput"); return b ? b.value : null; })()') === "";
  result.bubbleStillVisible = await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("sent from a tunnel"))');

  // ---- the ladder, as the server climbs it ----
  // Each rung is forced rather than waited for: the Sent poll backs off when
  // the machine is idle, so a probe that only waits reads whichever rung the
  // server happened to be on when a poll landed, not the one it set.
  const waitForWord = async (word) => retry(async () => {
    await ev("window.relay.refreshSent()", true).catch(() => {});
    const under = await ev(underBubble("sent from a tunnel"));
    if (!new RegExp(word).test(under || "")) throw new Error(`under-bubble reads "${under}"`);
    return under;
  }, { tries: 20, delayMs: 500, label: `the receipt to read ${word}` }).catch(() => "");
  sentProjection.items = [sentRow("pending")];
  result.wordWhenServerHasIt = await waitForWord("Sent");
  sentProjection.items = [sentRow("delivered")];
  result.wordWhenRecipientHasIt = await waitForWord("Delivered");
  sentProjection.items = [sentRow("read")];
  result.wordWhenRead = await waitForWord("Seen");

  // ---- two ordinary texts are one visual run ----
  await typeAndSend("rapid one");
  await retry(async () => {
    if (!(await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("rapid one"))'))) throw new Error("first rapid bubble missing");
  }, { label:"the first rapid bubble" });
  await typeAndSend("rapid two");
  await retry(async () => {
    if (!(await ev('[...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("rapid two"))'))) throw new Error("second rapid bubble missing");
  }, { label:"the second rapid bubble" });
  result.rapidMessagesVisible = true;
  result.rapidTextSeams = await ev('document.querySelectorAll(".th-run.th-seam").length');
  result.rapidYouHeaders = await ev('[...document.querySelectorAll(".th-run.mine .th-party")].filter(n => (n.textContent||"").trim() === "You").length');
  const rapidShot = await page.send("Page.captureScreenshot", { format:"png" });
  result.rapidScreenshot = path.join(sandbox, "rapid-messages.png");
  fs.writeFileSync(result.rapidScreenshot, Buffer.from(rapidShot.data, "base64"));

  // ---- the harder half: quit with a message still queued ----
  // "It sends when you are back online" has to survive closing the laptop, not
  // just losing the signal. Queue one with the network down, kill the app
  // outright, and bring it back up with the network working.
  net.up = false;
  await typeAndSend("queued before quitting");
  await retry(async () => {
    if (!outboxEntries().some((e) => e.text === "queued before quitting")) throw new Error("not queued yet");
  }, { tries: 20, delayMs: 250, label: "the second message to reach the queue" });
  page?.close();
  child.kill("SIGKILL");
  await sleep(1500);
  result.survivedTheQuit = outboxEntries().some((e) => e.text === "queued before quitting" && e.state === "queued");

  net.up = true;
  const before = sends.filter((s) => !s.refused).length;
  child = boot(CDP_PORT + 1);
  await attach(CDP_PORT + 1);
  const afterRestart = await retry(async () => {
    const accepted = sends.filter((s) => !s.refused);
    if (accepted.length <= before) throw new Error("nothing sent since the restart");
    return accepted;
  }, { tries: 40, delayMs: 500, label: "the queued message to send itself after a restart" }).catch(() => []);
  result.sentAfterRestart = afterRestart.length > before;
  // Ask whether the queued message is among what went out, not whether it
  // happened to be the last thing on the wire.
  result.restartSentText = afterRestart.some((s) => {
    try { return JSON.parse(s.body).forHuman === "queued before quitting"; } catch { return false; }
  }) ? "queued before quitting" : null;
  // Which room the list opens first is not the point; that the message is still
  // in its conversation is. Look through every room for it.
  result.restartBubbleVisible = await retry(async () => {
    const found = await ev(`(() => {
      const rows = [...document.querySelectorAll("#relaysList .relay-row[data-thread]")];
      for (const row of rows) {
        row.click();
        if ([...document.querySelectorAll(".th-msg")].some(n => (n.textContent||"").includes("queued before quitting"))) return true;
      }
      return false;
    })()`);
    if (!found) throw new Error("not in any room yet");
    return true;
  }, { tries: 20, delayMs: 500, label: "the restarted message in its room" }).catch(() => false);
} catch (e) {
  result.error = e.message;
  result.log = log.slice(-2000);
} finally {
  const laws = result.error ? [] : [
    ["an offline send is NOT returned to the composer", result.composerAfterOfflineSend === ""],
    ["the message stays in the room while offline", result.bubbleVisibleOffline === true],
    ["it says it is retrying, not that it sent", /Trying again/.test(result.stateWordOffline || "")],
    ["the device holds the message on disk", result.outboxHoldsIt === true],
    ["it is queued, not failed", result.outboxStateOffline === "queued"],
    ["the network really was down for it", result.refusedAttempts >= 1],
    ["it sends itself when the network returns", result.sentWithoutTouchingIt === true],
    ["it reaches the server exactly once", result.acceptedSends === 1],
    ["every attempt carried one idempotency key", result.oneKeyAcrossEveryAttempt === true && result.keyMatchesQueue === true],
    ["the bubble survives the whole journey", result.bubbleStillVisible === true],
    ["the server having it reads Sent", /Sent/.test(result.wordWhenServerHasIt || "")],
    ["the recipient having it reads Delivered", /Delivered/.test(result.wordWhenRecipientHasIt || "")],
    ["their reading it still outranks both", /Seen/.test(result.wordWhenRead || "")],
    ["two rapid texts both remain visible", result.rapidMessagesVisible === true],
    ["nearby texts have no reply-chain divider", result.rapidTextSeams === 0],
    ["nearby own texts share one new You header", result.rapidYouHeaders === 2],
    ["a queued message survives quitting the app", result.survivedTheQuit === true],
    ["it sends itself on the next launch, untouched", result.sentAfterRestart === true && result.restartSentText === "queued before quitting"],
    ["and it is still in the room after the restart", result.restartBubbleVisible === true],
  ];
  console.log(JSON.stringify(result, null, 2));
  for (const [law, held] of laws) console.log(`${held ? "PASS" : "FAIL"}  ${law}`);
  const failed = laws.filter(([, held]) => !held).length;
  page?.close();
  child.kill("SIGKILL");
  api.close();
  process.exit(result.error || failed ? 1 : 0);
}
