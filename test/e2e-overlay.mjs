// Live end-to-end eval for the Relay pill overlay.
//
// Boots the REAL Electron overlay in a sandbox (isolated RELAY_HOME + userData, so it
// coexists with a running production pill), then drives the exact user-reported failure
// scenarios through the main-process inspector (state machine) and the renderer's
// DevTools protocol (DOM/card state):
//
//   1. tray-identity — the macOS menu-bar icon uses Relay's permanent UUID and has bounds
//   2. boot-stack    — pre-existing offline relays notify newest-first, then fold
//   3. dedupe        — unchanged state pushes ZERO inbox re-renders (the "spazzing" fix)
//   4. fresh-relay   — a new packet always enters notification mode
//   5. sent-open     — clicking a Sent row stages it for the native materializer
//   6. re-alert      — a dismissed pill is revived and stays after a new relay
//   7. return-stack  — arrivals defer while away, then stack on return/unlock
//   8. show-relay    — tray reopen shows an expanded, on-stage card (the dead-click fix)
//   9. race          — dismiss ✕ then tray reopen inside the exit animation stays open
//  10. space-change  — forced Space refresh never hide()s a visible window (the blink fix)
//  11. tray-toggle   — the status-area icon hides and shows the pill
//  12. app-reopen    — a second app/CLI launch force-shows a dismissed single instance
//  13. cli-ready     — `relay pill` waits for a real visible readiness acknowledgement
//  14. expand-card   — a relay row click expands to Preview + Current/New chat; new-chat
//                      rides the open path (ack + spinner) and a second click collapses.
//                      Preview windows are per-relay: additive, independently minimized
//  15. conversations — one unified list (no Threads tab); a multi-message thread is one
//                      row that opens the exchange in ONE tap, newest message first
//  16. settings      — the Settings tab shows the sandbox account card (email,
//                      device, version); Account Settings opens the identity-safe
//                      first-party gateway, alongside Switch account / Sign out
//
// Run: node test/e2e-overlay.mjs   (needs a GUI session; not part of `npm test`)
// Exits non-zero on the first failed scenario, so it is safe to gate a release on.
//
// KEEP THIS GREEN. It is not in `npm test` (it needs a GUI + Electron), so nothing
// catches it rotting. It sat broken from 0.1.107 to 0.1.117: scenario 1 died on the
// notification-card redesign and took every later scenario with it, which is how a
// real launch-time regression — a backlog that never bannered and never folded —
// shipped unnoticed for ten releases. Run it before shipping pill changes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, "..");
// electron may be hoisted to the workspace root (dev) or vendored (npm install)
const electronBin = [
  process.env.RELAY_PARITY_ELECTRON,
  path.join(pkgRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "electron.exe"),
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!electronBin) {
  console.error("no Electron binary found; run npm install first");
  process.exit(1);
}
const overlayMain = process.env.RELAY_OVERLAY_MAIN || path.join(pkgRoot, "overlay", "main.cjs");

const MAIN_INSPECT_PORT = 9339;
const RENDERER_CDP_PORT = 9340;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overlay-e2e-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const statePath = path.join(relayHome, "state.json");
function writeState(packets) {
  const store = {
    version: 1,
    account: {},
    profile: { name: "", handle: "", email: "", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
    contacts: [],
    packets,
    meetingNotes: {},
    setup: {},
    emailThreads: {},
    chats: {},
  };
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, statePath);
}

function packet(id, title, createdAt) {
  return {
    direction: "inbound",
    state: "unread",
    relayNotificationKind: "plain_relay",
    senderName: "E2E Harness",
    title,
    forHuman: `${title} body`,
    forAgent: `${title} agent context`,
    createdAt,
    updatedAt: createdAt,
  };
}

const packets = {
  pkt_boot_1: packet("pkt_boot_1", "Oldest offline relay", "2026-07-10T00:00:00.000Z"),
  pkt_boot_2: packet("pkt_boot_2", "Middle offline relay", "2026-07-10T00:01:00.000Z"),
  pkt_boot_3: packet("pkt_boot_3", "Latest offline relay", "2026-07-10T00:02:00.000Z"),
};
writeState(packets);

// A paired sandbox account (RELAY_CONFIG points here) so the Settings tab has a
// real card to show. The token only ever reaches the dead 127.0.0.1:9 API.
const sandboxAccount = {
  id: "user_e2e",
  name: "E2E Harness",
  email: "e2e@example.com",
  accountKind: "human",
  isDeveloper: true,
};
fs.writeFileSync(
  path.join(sandbox, "config.json"),
  JSON.stringify(
    { deviceToken: "dev_e2e_token", deviceId: "dev_e2e", deviceName: "E2E Sandbox Mac", user: sandboxAccount },
    null,
    2,
  ),
);

// ---- CDP plumbing ----------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function connectWs(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
    }
  });
  return {
    ws,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function evalIn(conn, expression, { awaitPromise = false } = {}) {
  const res = await conn.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    includeCommandLineAPI: false,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`eval failed: ${(d.exception && d.exception.description) || d.text}`);
  }
  return res.result ? res.result.value : undefined;
}

async function retry(fn, { tries = 40, delayMs = 250, label = "condition" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`timed out waiting for ${label}: ${lastErr && lastErr.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- boot the sandboxed overlay -------------------------------------------

const overlayEnv = {
  ...process.env,
  RELAY_HOME: relayHome,
  RELAY_OVERLAY_USER_DATA: userData,
  RELAY_OVERLAY_TEST: "1",
  RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
  RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
  // The user's real mouse shares this screen; a pointer resting on the card
  // holds notifications open by design and would wedge the dwell scenarios.
  RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
  RELAY_OVERLAY_NOTIFICATION_MS: "5000",
  RELAY_CONFIG: path.join(sandbox, "config.json"),
  RELAY_WEB_URL: "http://127.0.0.1:9",
  RELAY_API_URL: "http://127.0.0.1:9",
};

const child = spawn(
  electronBin,
  [`--inspect=${MAIN_INSPECT_PORT}`, `--remote-debugging-port=${RENDERER_CDP_PORT}`, overlayMain],
  {
    env: overlayEnv,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let childLog = "";
child.stdout.on("data", (d) => (childLog += d));
child.stderr.on("data", (d) => (childLog += d));
const childExit = new Promise((resolve) => child.on("exit", resolve));

let failures = 0;
let mainConn = null;
let pageConn = null;
let previewConn = null;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Wait for a banner to fold back into the pill.
//
// A banner folds on a dwell timer, EXCEPT when the queue has marked it sticky —
// after SHOW_RETRY_LIMIT failed dwells a card latches on stage until a real
// interaction confirms it, and then it never folds on its own. Whether a given
// relay is sticky depends on how many earlier presentations in this run happened
// to miss their dwell, which is exactly the kind of history that makes a test
// flake. So: give the timer a full chance, and if the card is latched, confirm it
// through the same seam a human interaction would use and require the fold then.
// Either way the invariant under test is the same — a seen banner ends as a pill.
async function foldBanner(label) {
  const folded = async () =>
    evalIn(pageConn, "document.getElementById('card').classList.contains('collapsed')");
  try {
    await retry(async () => {
      if (!(await folded())) throw new Error("not collapsed");
    }, { tries: 28, delayMs: 250, label: `${label} auto-collapse` });
    return "timer";
  } catch (timerErr) {
    const show = await evalIn(mainConn, "global.__relayTest.state().currentShow");
    if (!show || show.sticky !== true) throw timerErr; // not latched: a real failure
    await evalIn(mainConn, "global.__relayTest.confirmCurrentShow(); 'confirm sticky'");
    await retry(async () => {
      if (!(await folded())) throw new Error("not collapsed after confirm");
    }, { tries: 20, delayMs: 250, label: `${label} fold after confirming a sticky card` });
    return "sticky-confirmed";
  }
}

try {
  // main-process inspector target
  const mainInfo = await retry(
    () => fetchJson(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`),
    { label: "main inspector" },
  );
  mainConn = await connectWs(mainInfo[0].webSocketDebuggerUrl);
  await mainConn.send("Runtime.enable");

  // wait for the test hooks (app ready)
  await retry(
    async () => {
      const ready = await evalIn(mainConn, "Boolean(global.__relayTest)");
      if (!ready) throw new Error("hooks not ready");
    },
    { label: "app ready" },
  );

  // renderer CDP target (the inbox page)
  const pages = await retry(
    async () => {
      const list = await fetchJson(`http://127.0.0.1:${RENDERER_CDP_PORT}/json/list`);
      const page = list.find((t) => t.type === "page" && String(t.url).includes("inbox.html"));
      if (!page) throw new Error("inbox page not found");
      return page;
    },
    { label: "renderer page" },
  );
  pageConn = await connectWs(pages.webSocketDebuggerUrl);
  await pageConn.send("Runtime.enable");

  // ---- 1. permanent macOS tray identity ----
  const trayState = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state().tray");
    if (!state || !state.available || !state.bounds) throw new Error(`tray=${JSON.stringify(state)}`);
    return state;
  }, { label: "persistent tray identity" });
  const expectedTrayId = process.platform === "darwin"
    ? "2aa0aef7-8c43-4644-b96d-2c5ba95a0232"
    : null;
  check(
    "tray-identity: the live menu-bar item has Relay's permanent identity and real bounds",
    trayState.persistentId === expectedTrayId && trayState.bounds.width > 0 && trayState.bounds.height > 0,
    `id=${trayState.persistentId} bounds=${JSON.stringify(trayState.bounds)}`,
  );

  // ---- 2. boot with a daemon-first/offline backlog ----
  const bootUi = await retry(
    async () => {
      const ui = await evalIn(
        pageConn,
        `(() => {
          const scroll = document.querySelector('.scroll');
          return {
            notifying: document.getElementById('card').classList.contains('notifying'),
            count: document.getElementById('count').textContent,
            // A notification is a BANNER, not the app: the tab rail collapses and the card
            // is sized to the unread rows it shows. Full expanded height here means dead
            // white space under a short stack, which reads as a broken window.
            tabsHeight: document.querySelector('.tabs').getBoundingClientRect().height,
            cardHeight: document.getElementById('card').getBoundingClientRect().height,
            // ...and sized to fit them exactly: nothing left to scroll, nothing clipped.
            clipped: scroll.scrollHeight - scroll.clientHeight,
            titles: [...document.querySelectorAll('#relaysList .th-title')].map((el) => el.textContent),
            unread: [...document.querySelectorAll('#relaysList .th-count')].map((el) => el.textContent),
          };
        })()`,
      );
      if (!ui.notifying || ui.titles.length !== 1) throw new Error(`notifying=${ui.notifying} rows=${ui.titles.length}`);
      // The card springs to the banner height; wait for it to settle before measuring.
      if (ui.clipped !== 0) throw new Error(`card=${ui.cardHeight} clipped=${ui.clipped}`);
      return ui;
    },
    { label: "boot notification stack" },
  );
  const bootState = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "boot-stack: offline relays notify newest-first and latch visibility",
    bootState.visible === true &&
      bootState.attentionLatched === true &&
      bootUi.count === "3" &&
      bootUi.tabsHeight === 0 &&
      bootUi.cardHeight < 524 &&
      bootUi.clipped === 0 &&
      bootUi.titles[0] === "Latest offline relay" &&
      bootUi.unread[0] === "3",
    `visible=${bootState.visible} latched=${bootState.attentionLatched} count=${bootUi.count} tabsHeight=${bootUi.tabsHeight} cardHeight=${bootUi.cardHeight} clipped=${bootUi.clipped} preview=${bootUi.titles[0]} unread=${bootUi.unread[0]}`,
  );
  await evalIn(mainConn, "global.__relayTest.movePillAwayFromCursor(); 'window-away'");
  await evalIn(pageConn, "window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 800 })); 'pointer-away'");
  await foldBanner("boot stack");
  const foldedBoot = await evalIn(
    pageConn,
    `(() => ({ collapsed: document.getElementById('card').classList.contains('collapsed'), count: document.getElementById('count').textContent }))()`,
  );
  const foldedBootState = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "boot-stack: notification folds into a persistent unread pill",
    foldedBoot.count === "3 unread" && foldedBootState.visible === true && foldedBootState.attentionLatched === true,
    `collapsed=${foldedBoot.collapsed} count=${foldedBoot.count} visible=${foldedBootState.visible}`,
  );
  // Confirmed-seen protocol: a fold alone no longer marks anything presented —
  // only evidence of a present human does. Drive the seam like an interacting
  // user: confirm each on-stage card until the pending queue drains.
  await retry(
    async () => {
      const confirmed = await evalIn(mainConn, "global.__relayTest.confirmCurrentShow()");
      const st = await evalIn(mainConn, "global.__relayTest.state()");
      if (st.pendingAttention.length > 0 && confirmed === false) throw new Error(`pending=${st.pendingAttention.length}, nothing on stage yet`);
      if (st.pendingAttention.length > 0) throw new Error(`pending=${st.pendingAttention.length}`);
      return true;
    },
    { tries: 30, delayMs: 400, label: "drain attention queue via confirmed dwells" },
  );
  const persistedBootPrefs = JSON.parse(fs.readFileSync(path.join(relayHome, "overlay-prefs.json"), "utf8"));
  check(
    "boot-stack: confirmed-seen presentation persists across process restarts",
    persistedBootPrefs.attentionLatched === true &&
      ["pkt_boot_1", "pkt_boot_2", "pkt_boot_3"].every((id) => persistedBootPrefs.presentedRelayIds.includes(id)) &&
      Object.keys(persistedBootPrefs.pendingAttention || {}).length === 0,
    `latched=${persistedBootPrefs.attentionLatched} presented=${persistedBootPrefs.presentedRelayIds.length} pending=${Object.keys(persistedBootPrefs.pendingAttention || {}).length}`,
  );

  // ---- 2. dedupe: unchanged state => zero inbox pushes ----
  // Let the first sent/contacts background loads settle first — those legitimately
  // re-push once as they progressively fill (they resolve fast against the dead API).
  await sleep(3000);
  await evalIn(pageConn, "window.__inboxPushes = 0; window.relay.onInbox(() => window.__inboxPushes++); 'armed'");
  // touch state.json with IDENTICAL content (mtime changes, bytes identical)
  const raw = fs.readFileSync(statePath, "utf8");
  fs.writeFileSync(statePath, raw);
  await sleep(8000); // spans several 2.5s safety polls + the touched watchFile tick
  const pushes = await evalIn(pageConn, "window.__inboxPushes");
  check("dedupe: unchanged state pushes zero re-renders in 8s", pushes === 0, `${pushes} push(es)`);

  // ---- 3. fresh relay lands ----
  packets.pkt_live_4 = packet("pkt_live_4", "Live arrival relay", "2026-07-10T00:05:00.000Z");
  writeState(packets);
  const freshUi = await retry(
    async () => {
      const ui = await evalIn(
        pageConn,
        `(() => ({
          notifying: document.getElementById('card').classList.contains('notifying'),
          count: document.getElementById('count').textContent,
          titles: [...document.querySelectorAll('#relaysList .th-title')].map((el) => el.textContent),
          unread: [...document.querySelectorAll('#relaysList .th-count')].map((el) => el.textContent),
        }))()`,
      );
      if (!ui.notifying || ui.titles.length !== 1) throw new Error(`notifying=${ui.notifying} rows=${ui.titles.length}`);
      return ui;
    },
    { tries: 24, label: "fresh relay row" },
  );
  check(
    "fresh relay: arrival updates the room preview and unread total",
    freshUi.count === "4" && freshUi.titles[0] === "Live arrival relay" && freshUi.unread[0] === "4",
    `count=${freshUi.count} preview=${freshUi.titles[0]} unread=${freshUi.unread[0]}`,
  );
  await evalIn(mainConn, "global.__relayTest.movePillAwayFromCursor(); 'window-away'");
  await evalIn(pageConn, "window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 800 })); 'pointer-away'");
  await foldBanner("fresh stack");

  // ---- 4. an outbound text updates the shared room and opens in one tap ----
  const sentFixture = {
    relayId: "relay_sent_e2e",
    state: "delivered",
    createdAt: "2026-07-10T00:06:00.000Z",
    updatedAt: "2026-07-10T00:06:00.000Z",
    kind: "message",
    title: "Sent fixture relay",
    displayTitle: "From E2E Harness: Sent fixture relay",
    recipient: { name: "Sven", email: "sven@example.com", onRelay: true },
    preview: "Outbound fixture body",
    forHuman: "Outbound fixture body",
    delivery: { channel: "device", state: "delivered" },
    hasAttachments: false,
    attachments: [],
  };
  await evalIn(
    mainConn,
    `global.__relayTest.setSentCache(${JSON.stringify([sentFixture])})`,
    { awaitPromise: true },
  );
  const sentUi = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => {
      const row = [...document.querySelectorAll('#relaysList .relay-arrival')].find((node) => node.getAttribute('data-party') === 'Sven');
      return { exists:Boolean(row), preview:row?.querySelector('.th-title')?.textContent || '' };
    })()`);
    if (!ui.exists) throw new Error("Sven room missing from Relays");
    if (ui.preview !== "You: Outbound fixture body") throw new Error(`preview=${ui.preview}`);
    return ui;
  }, { label: "outbound text updates the room preview" });
  await evalIn(pageConn, `[...document.querySelectorAll('#relaysList .relay-arrival')].find((node) => node.getAttribute('data-party') === 'Sven').click(); 'open Sven room'`);
  const openedSentRoom = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => ({
      visible:!document.getElementById('threadsView').classList.contains('hidden'),
      title:document.getElementById('thDetailName')?.textContent || '',
      history:document.getElementById('thHistory')?.innerText || '',
    }))()`);
    if (!ui.visible || ui.title !== "Sven" || !ui.history.includes("Outbound fixture body")) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "outbound room opens in one tap" });
  check(
    "sent-open: outbound text is the latest room preview and opens in the shared conversation",
    sentUi.preview === "You: Outbound fixture body" && openedSentRoom.history.includes("You") && openedSentRoom.history.includes("Outbound fixture body"),
    `preview=${sentUi.preview} room=${openedSentRoom.title}`,
  );

  // ---- 5. a new relay revives a dismissed pill and leaves it latched ----
  // Settle whatever is on stage FIRST, through the same seam the renderer uses
  // after an interacted dwell. The exit is a 300ms animation and an arrival
  // landing inside it calls cancelBye() by design ("a banner arriving mid-exit
  // must not be torn down by the old exit"), so clicking ✕ with a batch still in
  // flight aborts the dismissal — real behaviour, but a coin-flip to test against.
  await evalIn(mainConn, "global.__relayTest.confirmCurrentShow(); 'settled'");
  await sleep(400);
  await evalIn(pageConn, "document.getElementById('closeX').click(); 'clicked'");
  await retry(
    async () => {
      const vis = await evalIn(mainConn, "global.__relayTest.state().visible");
      if (vis !== false) throw new Error(`visible=${vis}`);
    },
    { tries: 20, label: "window hidden after dismiss" },
  );
  check("dismiss: ✕ hides the window", true);

  packets.pkt_live_5 = packet("pkt_live_5", "Relay after dismissal", "2026-07-10T00:07:00.000Z");
  writeState(packets);
  const revived = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    const ui = await evalIn(
      pageConn,
      `(() => ({ notifying: document.getElementById('card').classList.contains('notifying'), count: document.getElementById('count').textContent }))()`,
    );
    if (!state.visible || state.dismissed || !ui.notifying) {
      throw new Error(`visible=${state.visible} dismissed=${state.dismissed} notifying=${ui.notifying}`);
    }
    return { state, ui };
  }, { tries: 24, label: "dismissed pill revival" });
  check(
    "re-alert: a fresh relay clears dismissal and shows all unread relays",
    revived.state.attentionLatched === true && revived.ui.count === "5",
    `latched=${revived.state.attentionLatched} count=${revived.ui.count}`,
  );
  await evalIn(pageConn, "window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 800 })); 'pointer-away'");
  // The revived card may be sticky by now (its earlier dwells were never
  // confirmed), and sticky cards deliberately never auto-collapse. Touch it
  // like a user: a pointerdown on the card confirms it and folds it.
  const revivedFolded = await retry(async () => {
    await evalIn(
      pageConn,
      "document.getElementById('card').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 'touched'",
    );
    const collapsed = await evalIn(pageConn, "document.getElementById('card').classList.contains('collapsed')");
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (!collapsed || !state.visible) throw new Error(`collapsed=${collapsed} visible=${state.visible}`);
    return state;
  }, { tries: 30, delayMs: 250, label: "revived pill collapse after touch" });
  check(
    "re-alert: revived notification collapses but the pill stays until another explicit dismiss",
    revivedFolded.attentionLatched === true &&
      revivedFolded.dismissed === false &&
      (await evalIn(pageConn, "document.getElementById('count').textContent")) === "5 unread",
    `latched=${revivedFolded.attentionLatched} dismissed=${revivedFolded.dismissed}`,
  );
  // Drain any dwell-unconfirmed leftovers before dismissing again. On a quiet
  // eval machine no REAL input reaches the idle sampler, so earlier folds
  // (e.g. pkt_live_4's) abort back into the attention queue — and a pending
  // entry legitimately revives the pill BY DESIGN, racing the explicit ✕ below
  // (the arrival can cancel the renderer's bye timer so relay:dismiss never
  // fires). Confirm like a present human first — the same seam boot-stack uses.
  await retry(async () => {
    const st = await evalIn(mainConn, "global.__relayTest.state()");
    if (st.currentShow) await evalIn(mainConn, "global.__relayTest.confirmCurrentShow()");
    if (st.pendingAttention.length > 0) throw new Error(`pending=${st.pendingAttention.length}`);
  }, { tries: 30, delayMs: 400, label: "drain leftover attention before second dismissal" });
  await evalIn(pageConn, "document.getElementById('closeX').click(); 'clicked'");
  await retry(async () => {
    if ((await evalIn(mainConn, "global.__relayTest.state().visible")) !== false) throw new Error("still visible");
  }, { tries: 20, label: "second explicit dismissal" });

  // ---- 6. two arrivals while away defer until return, then stack newest-first ----
  await evalIn(mainConn, "global.__relayTest.setAway(true); 'away'");
  packets.pkt_away_6 = packet("pkt_away_6", "First relay while away", "2026-07-10T00:08:00.000Z");
  packets.pkt_away_7 = packet("pkt_away_7", "Latest relay while away", "2026-07-10T00:09:00.000Z");
  writeState(packets);
  await sleep(2200); // spans fs.watch and the 800ms watchFile fallback
  const awayState = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "return-stack: arrivals stay unpresented while the user is away",
    awayState.visible === false &&
      awayState.dismissed === true &&
      awayState.deferredAttention === true &&
      !awayState.presentedRelayIds.includes("pkt_away_6") &&
      !awayState.presentedRelayIds.includes("pkt_away_7"),
    `visible=${awayState.visible} dismissed=${awayState.dismissed} deferred=${awayState.deferredAttention}`,
  );
  await evalIn(mainConn, "global.__relayTest.setAway(false); 'returned'");
  const returnUi = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    const ui = await evalIn(
      pageConn,
      `(() => ({
        notifying: document.getElementById('card').classList.contains('notifying'),
        count: document.getElementById('count').textContent,
        titles: [...document.querySelectorAll('#relaysList .th-title')].map((el) => el.textContent),
        unread: [...document.querySelectorAll('#relaysList .th-count')].map((el) => el.textContent),
      }))()`,
    );
    if (
      !state.visible ||
      !ui.notifying ||
      state.dismissed ||
      !state.attentionLatched ||
      ui.count !== "7" ||
      ui.titles[0] !== "Latest relay while away" ||
      ui.unread[0] !== "7"
    ) {
      throw new Error(
        `visible=${state.visible} notifying=${ui.notifying} dismissed=${state.dismissed} latched=${state.attentionLatched} count=${ui.count}`,
      );
    }
    return { state, ui };
  }, { tries: 30, label: "return notification stack" });
  check(
    "return-stack: return revives the pill with the latest room preview and full unread total",
    returnUi.state.dismissed === false &&
      returnUi.state.attentionLatched === true &&
      returnUi.ui.count === "7" &&
      returnUi.ui.titles[0] === "Latest relay while away" &&
      returnUi.ui.unread[0] === "7",
    `dismissed=${returnUi.state.dismissed} latched=${returnUi.state.attentionLatched} count=${returnUi.ui.count} preview=${returnUi.ui.titles[0]} unread=${returnUi.ui.unread[0]}`,
  );

  // Simulate a lock/suspend edge while the stack is actually onscreen. It must be
  // requeued as unseen, then replayed once the user returns.
  await evalIn(mainConn, "global.__relayTest.setAway(true); 'locked-during-notification'");
  const lockedDuringNotification = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "return-stack: locking during an active notification requeues the unseen stack",
    lockedDuringNotification.deferredAttention === true &&
      lockedDuringNotification.activeAttentionIds.length === 0 &&
      !lockedDuringNotification.presentedRelayIds.includes("pkt_away_7"),
    `deferred=${lockedDuringNotification.deferredAttention} active=${lockedDuringNotification.activeAttentionIds.length}`,
  );
  await evalIn(mainConn, "global.__relayTest.setAway(false); 'unlocked'");
  await sleep(500);
  const unlockedState = await evalIn(mainConn, "global.__relayTest.state()");
  // A failed dwell deliberately cools off for 90 seconds before replaying; an
  // immediate re-peek is notification spam. The durable queue is the proof
  // that unlock will replay it after that calm-down window.
  check(
    "return-stack: unlock retains unseen relays for calm fail-closed replay",
    unlockedState.pendingAttention.includes("pkt_away_6") &&
      unlockedState.pendingAttention.includes("pkt_away_7") &&
      !unlockedState.presentedRelayIds.includes("pkt_away_7"),
    `pending=${unlockedState.pendingAttention.join(",")} presented=${unlockedState.presentedRelayIds.includes("pkt_away_7")}`,
  );

  // An explicit tray dismissal is authoritative even if a lock follows immediately.
  await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'tray-hidden'");
  const trayHidden = await evalIn(mainConn, "global.__relayTest.state()");
  await evalIn(mainConn, "global.__relayTest.setAway(true); 'locked-after-tray-hide'");
  await evalIn(mainConn, "global.__relayTest.setAway(false); 'unlocked-after-tray-hide'");
  await sleep(1600);
  const trayHiddenAfterReturn = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "return-stack: explicit tray dismissal is not undone by a later lock/unlock",
    trayHidden.visible === false &&
      trayHidden.dismissed === true &&
      trayHidden.activeAttentionIds.length === 0 &&
      trayHiddenAfterReturn.visible === false &&
      trayHiddenAfterReturn.dismissed === true,
    `before visible=${trayHidden.visible} active=${trayHidden.activeAttentionIds.length}; after visible=${trayHiddenAfterReturn.visible} dismissed=${trayHiddenAfterReturn.dismissed}`,
  );

  // ---- 7. tray reopen (Show Relay) ----
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'shown'");
  await retry(
    async () => {
      const vis = await evalIn(mainConn, "global.__relayTest.state().visible");
      if (vis !== true) throw new Error(`visible=${vis}`);
      const cardOk = await evalIn(
        pageConn,
        "(() => { const c = document.getElementById('card').classList; return !c.contains('offstage') && !c.contains('bye') && !c.contains('collapsed'); })()",
      );
      if (!cardOk) throw new Error("card not on stage/expanded");
    },
    { tries: 20, label: "tray reopen" },
  );
  check("show-relay: tray reopen shows an expanded, on-stage card", true);

  // ---- dragged anchor: fold and reopen around the user's chosen position ----
  // Drive the lockup's real pointer path (not win.setPosition directly), then
  // require both native sizes to preserve the dragged card's screen-space
  // top-right corner. This is the regression for the two-step collapse jump.
  const dragStart = await evalIn(mainConn, "global.__relayTest.getWin().getBounds()");
  const dragDx = dragStart.x > 200 ? -80 : 80;
  const dragDy = dragStart.y > 200 ? -60 : 60;
  await evalIn(pageConn, `(() => {
    const lockup = document.getElementById('lockup');
    const r = lockup.getBoundingClientRect();
    const clientX = Math.round(r.left + Math.min(40, r.width / 2));
    const clientY = Math.round(r.top + Math.min(20, r.height / 2));
    lockup.dispatchEvent(new MouseEvent('mousedown', {
      bubbles:true, button:0, clientX, clientY,
      screenX:${dragStart.x} + clientX, screenY:${dragStart.y} + clientY,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles:true, button:0, clientX:clientX + ${dragDx}, clientY:clientY + ${dragDy},
      screenX:${dragStart.x} + clientX + ${dragDx}, screenY:${dragStart.y} + clientY + ${dragDy},
    }));
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles:true, button:0, clientX:clientX + ${dragDx}, clientY:clientY + ${dragDy},
      screenX:${dragStart.x} + clientX + ${dragDx}, screenY:${dragStart.y} + clientY + ${dragDy},
    }));
    return true;
  })()`);
  const draggedExpanded = await retry(async () => {
    const bounds = await evalIn(mainConn, "global.__relayTest.getWin().getBounds()");
    if (bounds.x !== dragStart.x + dragDx || bounds.y !== dragStart.y + dragDy) {
      throw new Error(`bounds=${JSON.stringify(bounds)}`);
    }
    return bounds;
  }, { label: "dragged pill position" });

  const tapLockup = `(() => {
    const lockup = document.getElementById('lockup');
    const r = lockup.getBoundingClientRect();
    const clientX = Math.round(r.left + Math.min(40, r.width / 2));
    const clientY = Math.round(r.top + Math.min(20, r.height / 2));
    lockup.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0, clientX, clientY }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button:0, clientX, clientY }));
    return true;
  })()`;
  await evalIn(pageConn, tapLockup);
  const draggedCollapsed = await retry(async () => {
    const collapsed = await evalIn(pageConn, "document.getElementById('card').classList.contains('collapsed')");
    const bounds = await evalIn(mainConn, "global.__relayTest.getWin().getBounds()");
    if (!collapsed || bounds.width !== 244 || bounds.height !== 44) {
      throw new Error(`collapsed=${collapsed} bounds=${JSON.stringify(bounds)}`);
    }
    return bounds;
  }, { label: "dragged pill collapse settlement" });
  await evalIn(pageConn, tapLockup);
  const draggedReopened = await retry(async () => {
    const collapsed = await evalIn(pageConn, "document.getElementById('card').classList.contains('collapsed')");
    const bounds = await evalIn(mainConn, "global.__relayTest.getWin().getBounds()");
    if (collapsed || bounds.width !== 344 || bounds.height !== 524) {
      throw new Error(`collapsed=${collapsed} bounds=${JSON.stringify(bounds)}`);
    }
    return bounds;
  }, { label: "dragged pill reopen settlement" });
  const expandedRight = draggedExpanded.x + draggedExpanded.width;
  const collapsedRight = draggedCollapsed.x + draggedCollapsed.width;
  const reopenedRight = draggedReopened.x + draggedReopened.width;
  check(
    "dragged-anchor: collapse and reopen stay on the user's chosen screen position",
    draggedCollapsed.y === draggedExpanded.y && draggedReopened.y === draggedExpanded.y &&
      collapsedRight === expandedRight && reopenedRight === expandedRight &&
      draggedReopened.x === draggedExpanded.x,
    `expanded=${JSON.stringify(draggedExpanded)} collapsed=${JSON.stringify(draggedCollapsed)} reopened=${JSON.stringify(draggedReopened)}`,
  );

  // ---- 8. the race: dismiss then reopen inside the exit animation ----
  await evalIn(pageConn, "document.getElementById('closeX').click(); 'clicked'");
  await sleep(120); // mid-bye (exit animation is 300ms)
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'shown'");
  await sleep(2000); // long enough for the stale dismiss to have fired if unguarded
  const raceState = await evalIn(mainConn, "global.__relayTest.state()");
  const raceCard = await evalIn(
    pageConn,
    "(() => { const c = document.getElementById('card').classList; return !c.contains('offstage') && !c.contains('bye'); })()",
  );
  check(
    "race: reopen during exit animation stays open",
    raceState.visible === true && raceState.dismissed === false && raceCard === true,
    `visible=${raceState.visible} dismissed=${raceState.dismissed} cardOnStage=${raceCard}`,
  );

  // ---- 9. space change must never hide a visible window ----
  await evalIn(
    mainConn,
    `(() => {
      const win = global.__relayTest.getWin();
      global.__hideCalls = 0;
      if (!win.__hideWrapped) {
        const orig = win.hide.bind(win);
        win.hide = (...a) => { global.__hideCalls++; return orig(...a); };
        win.__hideWrapped = true;
      }
      global.__relayTest.refreshOverlayForActiveSpace({ force: true });
      global.__relayTest.refreshOverlayForActiveSpace({ force: true });
      return 'forced';
    })()`,
  );
  await sleep(1500);
  const hideCalls = await evalIn(mainConn, "global.__hideCalls");
  const stillVisible = await evalIn(mainConn, "global.__relayTest.state().visible");
  check("space-change: zero hide() calls on forced refresh", hideCalls === 0 && stillVisible === true, `hide()×${hideCalls}, visible=${stillVisible}`);

  // ---- 10. tray toggle: click hides when open, click shows when hidden ----
  // Ensure it starts on screen.
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'shown'");
  await retry(async () => {
    if ((await evalIn(mainConn, "global.__relayTest.pillIsOnScreen()")) !== true) throw new Error("not on screen");
  }, { tries: 20, label: "pill on screen before toggle" });
  // First toggle -> hides.
  await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'toggled'");
  await retry(async () => {
    if ((await evalIn(mainConn, "global.__relayTest.pillIsOnScreen()")) !== false) throw new Error("still on screen");
  }, { tries: 20, label: "toggle hides" });
  const hiddenState = await evalIn(mainConn, "global.__relayTest.state()");
  // Second toggle (past the 300ms debounce) -> shows again.
  await sleep(350);
  await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'toggled'");
  await retry(async () => {
    if ((await evalIn(mainConn, "global.__relayTest.pillIsOnScreen()")) !== true) throw new Error("not back on screen");
  }, { tries: 20, label: "toggle shows" });
  check(
    "tray toggle: click hides an open pill, then shows it again",
    hiddenState.visible === false && hiddenState.dismissed === true,
    `afterHide visible=${hiddenState.visible} dismissed=${hiddenState.dismissed}`,
  );

  // ---- 11. background contenders stay silent; explicit app launches restore ----
  await sleep(350);
  await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'hidden-for-app-reopen'");
  await retry(async () => {
    if ((await evalIn(mainConn, "global.__relayTest.pillIsOnScreen()")) !== false) throw new Error("still visible");
  }, { tries: 20, label: "dismissed before app reopen" });
  const bareSecond = spawn(electronBin, [overlayMain], {
    env: overlayEnv,
    stdio: "ignore",
  });
  bareSecond.on("error", () => {});
  await sleep(600);
  const afterBareSecond = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "app-reopen: a bare launchd-style second instance stays silent",
    afterBareSecond.visible === false && afterBareSecond.dismissed === true,
    `visible=${afterBareSecond.visible} dismissed=${afterBareSecond.dismissed}`,
  );
  const reopenNonce = `e2e-app-${Date.now()}`;
  const second = spawn(electronBin, [overlayMain, "--relay-reopen", reopenNonce], {
    env: overlayEnv,
    stdio: "ignore",
  });
  second.on("error", () => {});
  const reopenedByApp = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    const status = JSON.parse(fs.readFileSync(path.join(relayHome, "pill-status.json"), "utf8"));
    if (!state.visible || state.dismissed || status.reopenNonce !== reopenNonce || !status.visible) {
      throw new Error(`visible=${state.visible} dismissed=${state.dismissed} nonce=${status.reopenNonce}`);
    }
    return { state, status };
  }, { tries: 30, label: "second-instance app reopen" });
  check(
    "app-reopen: Spotlight/CLI launch clears dismissal and confirms the existing pill visible",
    reopenedByApp.status.ready === true && reopenedByApp.state.visible === true,
  );

  // ---- 12. the public CLI verifies visibility instead of printing blind success ----
  await sleep(350);
  await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'hidden-for-cli-reopen'");
  const cli = spawn(process.execPath, [path.join(pkgRoot, "bin", "relay.js"), "pill"], {
    env: overlayEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cliOut = "";
  cli.stdout.on("data", (data) => (cliOut += data));
  cli.stderr.on("data", (data) => (cliOut += data));
  const cliCode = await new Promise((resolve) => cli.on("exit", resolve));
  const cliState = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "cli-ready: relay pill returns success only after the dismissed pill is visible",
    cliCode === 0 && cliState.visible === true && cliState.dismissed === false && /Relay pill is visible\./.test(cliOut),
    `code=${cliCode} visible=${cliState.visible} dismissed=${cliState.dismissed} output=${cliOut.trim()}`,
  );

  // ---- 13. WhatsApp-shaped identity list: one tap opens the room, and a
  // two-document Relay inside that room opens its two faces without an
  // intermediate action menu.
  await evalIn(pageConn, `document.querySelector('[data-view="relays"]').click(); 'relays tab'`);
  const identityJourney = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => {
      const row = document.querySelector('#relaysList .relay-arrival');
      return { exists:Boolean(row), party:row?.getAttribute('data-party') || '', preview:row?.querySelector('.th-title')?.textContent || '' };
    })()`);
    if (!ui.exists) throw new Error("no identity rows");
    return ui;
  }, { label: "WhatsApp identity row" });
  await evalIn(pageConn, `document.querySelector('#relaysList .relay-arrival').click(); 'open identity room'`);
  const roomJourney = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => ({
      open:!document.getElementById('thDetail').classList.contains('gone'),
      name:document.getElementById('thDetailName')?.textContent || '',
      relayCount:document.querySelectorAll('#thHistory .th-msg[role="button"]').length,
    }))()`);
    if (!ui.open || !ui.relayCount) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "identity room opens in one tap" });
  await evalIn(pageConn, `document.querySelector('#thHistory .th-msg[role="button"]').click(); 'open Relay document'`);
  const relayFaces = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => ({
      reader:!document.getElementById('readerView').classList.contains('hidden'),
      forYou:Boolean(document.querySelector('[data-rtab="you"]')),
      forAgent:Boolean(document.querySelector('[data-rtab="agent"]')),
    }))()`);
    if (!ui.reader) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "two-document Relay reader" });
  check(
    "relays: identity preview opens one shared room, whose Relay exposes For-you and For-agent faces",
    identityJourney.exists && roomJourney.open && relayFaces.forYou && relayFaces.forAgent,
    `party=${identityJourney.party} preview=${identityJourney.preview} room=${roomJourney.name}`,
  );
  await evalIn(pageConn, `document.getElementById('readerBack').click(); 'back to room'`);
  await evalIn(pageConn, `document.getElementById('thBack').click(); 'back to relays'`);

  // ---- 14. Internal reply-chain ids remain invisible: new messages from the
  // same person update one identity row and live in one chronological room.
  packets.pkt_thread_a = { ...packet("pkt_thread_a", "Thread starter", "2026-07-11T00:00:00.000Z"), threadId: "pkt_thread_a" };
  // The middle message carries the DEFAULT anchor every sender sets — a reply
  // to the line directly above — and must render no quote at all. Only
  // pkt_thread_b reaches past it, which is the deliberate case the chip is for.
  packets.pkt_thread_mid = { ...packet("pkt_thread_mid", "Unrelated aside", "2026-07-11T00:02:30.000Z"), threadId: "pkt_thread_a", inReplyToRelayId: "pkt_thread_a" };
  packets.pkt_thread_b = { ...packet("pkt_thread_b", "Thread reply", "2026-07-11T00:05:00.000Z"), threadId: "pkt_thread_a", inReplyToRelayId: "pkt_thread_a" };
  writeState(packets);
  await retry(async () => {
    const st = await evalIn(mainConn, "global.__relayTest.state()");
    if (st.currentShow) await evalIn(mainConn, "global.__relayTest.confirmCurrentShow()");
    if (st.pendingAttention.length > 0) throw new Error(`pending=${st.pendingAttention.length}`);
  }, { tries: 30, delayMs: 400, label: "drain reply-chain arrivals" });
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'expand current relays'");
  await retry(async () => {
    const ui = await evalIn(pageConn, `(() => {
      const rows=[...document.querySelectorAll('#relaysList .relay-arrival')];
      const target=rows.find((row) => row.getAttribute('data-party') === 'E2E Harness');
      return { count:rows.filter((row) => row.getAttribute('data-party') === 'E2E Harness').length, target:Boolean(target), preview:target?.querySelector('.th-title')?.textContent || '' };
    })()`);
    if (!ui.target || ui.preview !== "Thread reply") throw new Error(JSON.stringify(ui));
    if (ui.count !== 1) throw new Error(`identity rows=${ui.count}`);
  }, { label: "one identity row across reply chains" });
  await evalIn(pageConn, `[...document.querySelectorAll('#relaysList .relay-arrival')].find((row) => row.getAttribute('data-party') === 'E2E Harness').click(); 'open merged room'`);
  const mergedRoom = await retry(async () => {
    const ids = await evalIn(pageConn, `[...document.querySelectorAll('#thHistory .th-msg')].map((row) => row.getAttribute('data-msg'))`);
    if (!ids.includes("pkt_thread_a") || !ids.includes("pkt_thread_b")) throw new Error(ids.join(","));
    return ids;
  }, { label: "merged room contains both related messages" });
  check(
    "relays: opaque reply chains merge into one person row and one chronological room",
    mergedRoom.indexOf("pkt_thread_a") < mergedRoom.indexOf("pkt_thread_b"),
    mergedRoom.join(" > "),
  );

  // A per-message reply is WhatsApp-shaped: the chosen Relay attaches to the
  // resident composer, the draft survives selection/cancellation, and a
  // delivered reply points back to the exact visible source.
  await evalIn(pageConn, `(() => {
    const input = document.getElementById('thQrInput');
    input.value = 'Specific reply draft';
    input.dispatchEvent(new Event('input', { bubbles:true }));
    document.querySelector('[data-reply-to="pkt_thread_a"]').click();
  })()`);
  const targetedReply = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => ({
      replying:document.querySelector('.th-qr')?.classList.contains('replying') || false,
      who:document.querySelector('.th-reply-target-who')?.textContent || '',
      copy:document.querySelector('.th-reply-target-copy')?.textContent || '',
      draft:document.getElementById('thQrInput')?.value || '',
    }))()`);
    if (!ui.replying || !ui.copy.includes('Thread starter')) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "specific reply target attaches to composer" });
  await evalIn(pageConn, `document.querySelector('[data-reply-cancel]').click(); 'cancel target only'`);
  const cancelledReply = await evalIn(pageConn, `(() => ({
    target:Boolean(document.querySelector('.th-reply-target')),
    draft:document.getElementById('thQrInput')?.value || '',
  }))()`);
  const deliveredReference = await evalIn(pageConn, `(() => {
    const ref = document.querySelector('[data-msg="pkt_thread_b"] [data-reply-ref="pkt_thread_a"]');
    const clock = document.querySelector('[data-msg="pkt_thread_b"] .th-blk-time');
    if (ref) ref.click();
    return {
      exists:Boolean(ref),
      copy:ref?.querySelector('.th-reply-ref-copy')?.textContent || '',
      clockSeparated:Boolean(ref && clock && ref.getBoundingClientRect().right + 4 <= clock.getBoundingClientRect().left),
      highlighted:document.querySelector('[data-msg="pkt_thread_a"]')?.classList.contains('reply-source-flash') || false,
      // the default anchor one line up quotes nothing
      defaultAnchorQuoted:Boolean(document.querySelector('[data-msg="pkt_thread_mid"] .th-reply-ref')),
    };
  })()`);
  check(
    "relays: a specific reply attaches its source to the composer and delivered replies jump back to it",
    targetedReply.who === "Replying to E2E Harness"
      && targetedReply.draft === "Specific reply draft"
      && !cancelledReply.target
      && cancelledReply.draft === "Specific reply draft"
      && deliveredReference.exists
      && deliveredReference.copy.includes("Thread starter")
      && deliveredReference.clockSeparated
      && deliveredReference.highlighted
      && !deliveredReference.defaultAnchorQuoted,
    JSON.stringify({ targetedReply, cancelledReply, deliveredReference }),
  );
  await evalIn(pageConn, `document.getElementById('thBack').click(); 'back to relays'`);

  // Historical pre-identity-index scenarios are retained below as executable
  // documentation, but the current journeys above replace their removed
  // Sent-tab/action-menu/thread-row UI.
  if (false) {

  // ---- 13. relay expand-card: row click reveals the two open actions ----
  await evalIn(pageConn, `document.querySelector('[data-view="relays"]').click(); 'relays tab'`);
  const targetId = await retry(async () => {
    const id = await evalIn(pageConn, "(document.querySelector('#relaysList .row') || {}).getAttribute && document.querySelector('#relaysList .row').getAttribute('data-id')");
    if (!id) throw new Error("no relay rows");
    return id;
  }, { label: "relay rows for expand-card" });
  const rowSel = `document.querySelector('#relaysList .row[data-id="${targetId}"]')`;
  await evalIn(pageConn, `${rowSel}.click(); 'row expand'`);
  const expandedUi = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => {
        const row = ${rowSel};
        const preview = row && row.querySelector('[data-preview]');
        const current = row && row.querySelector('[data-open-current]');
        const freshBtn = row && row.querySelector('[data-open-fresh]');
        return {
          expanded: Boolean(row && row.classList.contains('expanded')),
          card: Boolean(row && row.querySelector('.row-open-card')),
          unread: Boolean(row && row.classList.contains('unread')),
          previewLabel: preview ? preview.textContent.trim() : null,
          currentLabel: current ? current.textContent.trim() : null,
          freshLabel: freshBtn ? freshBtn.textContent.trim() : null,
        };
      })()`,
    );
    if (!ui.expanded || !ui.card) throw new Error(`expanded=${ui.expanded} card=${ui.card}`);
    return ui;
  }, { label: "expand card appears" });
  check(
    // Labels name the DESTINATION and nothing else — the pill already opens into
    // the right app. Deliberately short since 0.1.110 (#104); the longer
    // "Open in Current Chat" wording this used to assert was the accident.
    "expand-card: row click reveals Preview + both chat opens without acking",
    expandedUi.previewLabel === "Preview" &&
      String(expandedUi.currentLabel).toLowerCase() === "current chat" &&
      String(expandedUi.freshLabel).toLowerCase() === "new chat" &&
      expandedUi.unread === true,
    `preview=${expandedUi.previewLabel} current=${expandedUi.currentLabel} fresh=${expandedUi.freshLabel} unread=${expandedUi.unread}`,
  );

  // Preview reads title + forHuman (never briefingMarkdown), renders the
  // detail safely, and owns its lifecycle independently from the Relay pill.
  const previewMarkdown = [
    "## Detailed context",
    "",
    "- First **important** point",
    "- Run `npm test`",
    "",
    "[Safe link](https://example.com)",
    "[Bad link](javascript:alert(1))",
    "![tracker](https://tracker.example/pixel.png)",
    "<script>globalThis.__previewPwned = true</script>",
    "",
    "Final paragraph must remain visible.",
  ].join("\n");
  const previewStore = JSON.parse(fs.readFileSync(statePath, "utf8"));
  previewStore.packets[targetId].forHuman = previewMarkdown;
  previewStore.packets[targetId].briefingMarkdown = "PRIVATE BRIEFING MUST NOT APPEAR";
  writeState(previewStore.packets);
  await evalIn(pageConn, `${rowSel}.querySelector('[data-preview]').click(); 'open preview'`);
  const previewTarget = await retry(async () => {
    const list = await fetchJson(`http://127.0.0.1:${RENDERER_CDP_PORT}/json/list`);
    const target = list.find((item) => item.type === "page" && String(item.url).includes("preview.html"));
    if (!target) throw new Error("preview page not found");
    return target;
  }, { label: "preview page" });
  previewConn = await connectWs(previewTarget.webSocketDebuggerUrl);
  await previewConn.send("Runtime.enable");
  const previewUi = await retry(async () => {
    const ui = await evalIn(
      previewConn,
      `(() => {
        const title = document.getElementById('messageTitle');
        const body = document.getElementById('messageBody');
        const detail = document.getElementById('detailScroll');
        const composer = document.querySelector('.reply-composer');
        const reply = document.getElementById('replyButton');
        return {
          title: title.textContent,
          titleBeforeBody: Boolean(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING),
          heading: body.querySelector('h2') && body.querySelector('h2').textContent,
          listItems: [...body.querySelectorAll('li')].map((el) => el.textContent),
          strong: body.querySelector('strong') && body.querySelector('strong').textContent,
          code: body.querySelector('code') && body.querySelector('code').textContent,
          final: body.textContent.includes('Final paragraph must remain visible.'),
          leakedBriefing: body.textContent.includes('PRIVATE BRIEFING'),
          activeUnsafe: body.querySelectorAll('script,img,iframe,object,embed,svg,math').length,
          pwned: globalThis.__previewPwned === true,
          links: [...body.querySelectorAll('a')].map((a) => a.href),
          detailOverflow: getComputedStyle(detail).overflowY,
          composerPinned: Math.abs(composer.getBoundingClientRect().bottom - innerHeight) < 2,
          replyDisabled: reply.disabled && reply.getAttribute('aria-disabled') === 'true',
        };
      })()`,
    );
    if (!ui.heading) throw new Error("Markdown has not rendered yet");
    return ui;
  }, { label: "preview Markdown render" });
  const previewRead = await retry(async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.packets[targetId].state !== "read") throw new Error(`state=${state.packets[targetId].state}`);
    return state.packets[targetId];
  }, { label: "preview marks rendered relay read" });
  const previewMainState = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "preview: high-level title leads safe Markdown above an inert pinned composer",
    previewUi.title === previewStore.packets[targetId].title &&
      previewUi.titleBeforeBody &&
      previewUi.heading === "Detailed context" &&
      previewUi.listItems.length === 2 &&
      previewUi.strong === "important" &&
      previewUi.code === "npm test" &&
      previewUi.final &&
      !previewUi.leakedBriefing &&
      previewUi.activeUnsafe === 0 &&
      previewUi.pwned === false &&
      previewUi.links.length === 1 &&
      previewUi.links[0] === "https://example.com/" &&
      previewUi.detailOverflow === "auto" &&
      previewUi.composerPinned &&
      previewUi.replyDisabled &&
      previewRead.state === "read" &&
      previewMainState.visible === true,
    JSON.stringify(previewUi),
  );

  // Previews are documents: re-opening the SAME relay raises its window, while a
  // DIFFERENT relay adds one. Minimize and close act only on the window that got
  // them, and neither ever disturbs the pill.
  const previewCountSel = "global.__relayTest.state().previews.length";
  await evalIn(mainConn, `global.__relayTest.openPreview(${JSON.stringify(targetId)}); global.__relayTest.openPreview(${JSON.stringify(targetId)}); 'reopened'`);
  const reopenedTargets = (await fetchJson(`http://127.0.0.1:${RENDERER_CDP_PORT}/json/list`))
    .filter((item) => item.type === "page" && String(item.url).includes("preview.html"));

  // Any other relay in the list will do, so long as it is one main can actually
  // project — some kinds have no preview payload and openPreview declines them.
  const otherIds = await evalIn(
    pageConn,
    `[...document.querySelectorAll('#relaysList .row')].map((row) => row.getAttribute('data-id')).filter((id) => id && id !== ${JSON.stringify(targetId)})`,
  );
  const secondId = await evalIn(
    mainConn,
    `(${JSON.stringify(otherIds || [])}).find((id) => global.__relayTest.openPreview(id)) || null`,
  );
  if (!secondId) throw new Error("e2e needs a second previewable relay to prove previews are additive");
  const bothOpen = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.previews.length !== 2) throw new Error(`previews=${state.previews.length}`);
    return state;
  }, { label: "second preview window" });
  const additiveTargets = (await fetchJson(`http://127.0.0.1:${RENDERER_CDP_PORT}/json/list`))
    .filter((item) => item.type === "page" && String(item.url).includes("preview.html"));
  // Two windows must not land on the same cascade offset, or the second hides the first.
  const distinctSlots = new Set(bothOpen.previews.map((entry) => entry.slot)).size === 2;

  // Minimizing the first must leave the second untouched — the old shared window
  // made "minimize" mean "park the only preview", which is what this guards.
  await evalIn(mainConn, `global.__relayTest.getPreviewWinFor(${JSON.stringify(targetId)}).minimize(); 'minimized'`);
  const minimized = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    const first = state.previews.find((entry) => entry.relayId === targetId);
    const second = state.previews.find((entry) => entry.relayId === secondId);
    if (!first || !first.minimized) throw new Error("first preview not minimized");
    if (!second || second.minimized) throw new Error("second preview minimized with it");
    return state;
  }, { label: "independent preview minimize" });

  // Closing one leaves the other — including a minimized one — exactly as it was.
  await evalIn(mainConn, `global.__relayTest.getPreviewWinFor(${JSON.stringify(secondId)}).close(); 'closed second'`);
  const oneLeft = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.previews.length !== 1) throw new Error(`previews=${state.previews.length}`);
    if (state.previews[0].relayId !== targetId) throw new Error("wrong preview survived");
    if (!state.previews[0].minimized) throw new Error("survivor lost its minimized state");
    return state;
  }, { label: "close one preview" });
  await evalIn(mainConn, `global.__relayTest.getPreviewWinFor(${JSON.stringify(targetId)}).close(); 'closed first'`);
  const closed = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.previews.length !== 0) throw new Error("previews still open");
    return state;
  }, { label: "preview close" });
  check(
    "preview: same relay reuses its window, a different relay adds one, and each minimizes/closes alone",
    reopenedTargets.length === 1 &&
      additiveTargets.length === 2 &&
      distinctSlots &&
      minimized.visible === true &&
      oneLeft.visible === true &&
      closed.visible === true,
    `reopened=${reopenedTargets.length} additive=${additiveTargets.length} slots=${JSON.stringify(bothOpen.previews)} pill=${minimized.visible}/${oneLeft.visible}/${closed.visible}`,
  );
  previewConn.close();
  previewConn = null;

  // Preview folded the action card, so expand once before exercising the
  // existing second-click collapse contract below.
  await evalIn(pageConn, `${rowSel}.click(); 'row expand after preview'`);

  // second click folds the card back away
  await evalIn(pageConn, `${rowSel}.click(); 'row collapse'`);
  await retry(async () => {
    const still = await evalIn(pageConn, `Boolean(${rowSel} && ${rowSel}.querySelector('.row-open-card'))`);
    if (still) throw new Error("still expanded");
  }, { label: "expand card collapses on second click" });
  check("expand-card: a second row click collapses the card", true);

  // expand again; "Open in new chat" rides the shared open path (test seam
  // RELAY_OVERLAY_TEST_NO_HOST_OPEN acks + completes it without a host)
  await evalIn(pageConn, `${rowSel}.click(); 'row expand again'`);
  await retry(async () => {
    const ready = await evalIn(pageConn, `Boolean(${rowSel} && ${rowSel}.querySelector('[data-open-fresh]'))`);
    if (!ready) throw new Error("fresh button not there yet");
  }, { label: "expand card reappears" });
  await evalIn(pageConn, `${rowSel}.querySelector('[data-open-fresh]').click(); 'open fresh'`);
  const freshOpened = await retry(async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const row = state.packets[targetId];
    if (!row || row.state !== "read") throw new Error(`state=${row && row.state}`);
    return row;
  }, { label: "fresh open acks the relay" });
  await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => {
        const row = ${rowSel};
        return { opening: Boolean(row && row.classList.contains('opening')), card: Boolean(row && row.querySelector('.row-open-card')) };
      })()`,
    );
    if (ui.opening || ui.card) throw new Error(`opening=${ui.opening} card=${ui.card}`);
  }, { label: "fresh open completes and folds the card" });
  check("expand-card: Open in new chat opens via the shared path and marks the relay read", freshOpened.state === "read");

  // ---- 14. unified conversations: everything is a thread inside the Relays tab.
  // A multi-message thread renders as ONE conversation row with a count; a
  // single-message thread renders as the classic relay row; there is no
  // separate Threads tab. Clicking the conversation drills into the exchange.
  packets.pkt_thread_a = { ...packet("pkt_thread_a", "Thread starter", "2026-07-11T00:00:00.000Z"), threadId: "pkt_thread_a" };
  packets.pkt_thread_b = { ...packet("pkt_thread_b", "Thread reply", "2026-07-11T00:05:00.000Z"), threadId: "pkt_thread_a", inReplyToRelayId: "pkt_thread_a" };
  writeState(packets);
  await sleep(1200); // let the state watcher push the new rows
  // The arrivals enter notification mode (peeking = flat unread rows). Confirm
  // them via the seam — like a user acknowledging the cards — so the view
  // settles back into the conversation list.
  await retry(
    async () => {
      await evalIn(mainConn, "global.__relayTest.confirmCurrentShow()");
      const st = await evalIn(mainConn, "global.__relayTest.state()");
      if (st.pendingAttention.length > 0) throw new Error(`pending=${st.pendingAttention.length}`);
    },
    { tries: 30, delayMs: 400, label: "drain thread arrivals" },
  );
  await retry(async () => {
    const peeking = await evalIn(pageConn, "document.getElementById('card').classList.contains('peek') || document.getElementById('card').classList.contains('notifying')");
    if (peeking) throw new Error("still peeking");
  }, { tries: 30, delayMs: 250, label: "notification folds" });
  // The folded pill defers list rebuilds; open the card like a user would
  // before asserting what the list renders.
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'expand'");
  await retry(async () => {
    const collapsed = await evalIn(pageConn, "document.getElementById('card').classList.contains('collapsed')");
    if (collapsed) throw new Error("still collapsed");
  }, { tries: 30, delayMs: 250, label: "card expands" });
  await evalIn(pageConn, `document.querySelector('.tab[data-view="relays"]').click(); 'relays tab'`);
  const threadsUi = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => {
        const target = document.querySelector('#relaysList .th-item[data-thread="pkt_thread_a"]');
        return {
          noThreadsTab: !document.querySelector('.tab[data-view="threads"]'),
          hasTarget: Boolean(target),
          targetCount: target ? target.querySelector('.th-count').textContent : "",
          singleStillClassic: Boolean(document.querySelector('#relaysList .row[data-id]')),
        };
      })()`,
    );
    if (!ui.hasTarget || ui.targetCount !== "2") throw new Error(`hasTarget=${ui.hasTarget} count=${ui.targetCount}`);
    return ui;
  }, { label: "unified list groups the shared thread" });
  check(
    "conversations: no Threads tab; a 2-message thread is one row with a count while singles stay classic rows",
    threadsUi.noThreadsTab && threadsUi.hasTarget && threadsUi.targetCount === "2" && threadsUi.singleStillClassic,
  );
  // A conversation opens like a conversation: ONE tap straight into the chat
  // view. The expand-a-menu step this used to assert was deliberately removed
  // as "one tap too many" — the open actions wait at the foot of the pane
  // instead, beside the newest message.
  await evalIn(pageConn, `document.querySelector('#relaysList .th-item[data-thread="pkt_thread_a"]').click(); 'open conversation'`);
  const oneTap = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => {
        const detail = document.getElementById('thDetail');
        return {
          detailOpen: !detail.classList.contains('gone'),
          // No intermediate menu was left behind on the row.
          rowMenu: Boolean(document.querySelector('#relaysList .th-item[data-thread="pkt_thread_a"] .open-actions')),
          // Thread-level actions live inside the detail, at its foot.
          actionsInDetail: Boolean(detail.querySelector('[data-thread-preview], [data-open-current], [data-open-fresh]')),
        };
      })()`,
    );
    if (!ui.detailOpen || !ui.actionsInDetail) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "conversation opens in one tap" });
  check(
    "conversations: one tap opens the exchange, with the open actions inside it rather than a menu step",
    oneTap.detailOpen && oneTap.actionsInDetail && !oneTap.rowMenu,
    JSON.stringify(oneTap),
  );
  const threadDetail = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => ({
        visible: !document.getElementById('thDetail').classList.contains('gone'),
        msgs: [...document.querySelectorAll('#thHistory .th-msg')].map((el) => el.getAttribute('data-msg')),
      }))()`,
    );
    if (!ui.visible || ui.msgs.length !== 2) throw new Error(`visible=${ui.visible} msgs=${ui.msgs.length}`);
    return ui;
  }, { label: "thread detail renders newest-first" });
  await evalIn(pageConn, `document.getElementById('thBack').click(); 'back'`);
  const backState = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => ({
        relaysVisible: !document.getElementById('relaysView').classList.contains('hidden'),
        relaysTabActive: document.querySelector('.tab[data-view="relays"]').classList.contains('active'),
      }))()`,
    );
    if (!ui.relaysVisible) throw new Error("relays view not restored");
    return ui;
  }, { label: "back returns to the unified list" });
  check(
    // Newest first since 0.1.111 (#105): this is an inbox, not a chat — there is
    // no composer at the foot to anchor to, and what you came for is the thing
    // that just arrived, so entering lands at the top on the newest message.
    "conversations: detail lists the exchange newest-first and back returns to the Relays list",
    threadDetail.msgs.join("|") === "pkt_thread_b|pkt_thread_a" && backState.relaysVisible && backState.relaysTabActive,
    `msgs=${threadDetail.msgs.join("|")} relaysVisible=${backState.relaysVisible} tabActive=${backState.relaysTabActive}`,
  );
  }

  // ---- 15. Settings tab: the account card shows who this pill is signed in as ----
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
  const settingsOpenedAt = Date.now();
  await evalIn(pageConn, `document.querySelector('.tab[data-view="settings"]').click(); 'settings tab'`);
  const settingsUi = await retry(async () => {
    const ui = await evalIn(
      pageConn,
      `(() => {
        const view = document.getElementById('settingsView');
        const text = (sel) => { const el = view.querySelector(sel); return el ? el.textContent.trim() : null; };
        return {
          visible: !view.classList.contains('hidden'),
          tabActive: document.querySelector('.tab[data-view="settings"]').classList.contains('active'),
          name: text('.sv-name'),
          email: text('.sv-email'),
          device: text('.sv-device'),
          version: text('.sv-version'),
          switchLabel: view.querySelector('#svSwitch') ? view.querySelector('#svSwitch').textContent.trim() : null,
          signOutLabel: view.querySelector('#svSignOut') ? view.querySelector('#svSignOut').textContent.trim() : null,
          pairRowHidden: !view.querySelector('.sv-pair'),
          providers: [...view.querySelectorAll('[data-provider-row]')].map((row) => ({
            id: row.getAttribute('data-provider-row'),
            text: row.textContent.replace(/\\s+/g, ' ').trim(),
            buttons: [...row.querySelectorAll('button')].map((button) => button.textContent.trim()),
          })),
        };
      })()`,
    );
    if (!ui.visible || ui.email !== "e2e@example.com") throw new Error(`visible=${ui.visible} email=${ui.email}`);
    return ui;
  }, { label: "settings account card" });
  const settingsAccountMs = Date.now() - settingsOpenedAt;
  check(
    "settings: the account paints promptly without waiting for provider inventory",
    settingsUi.tabActive &&
      settingsUi.name === "E2E Harness" &&
      settingsUi.email === "e2e@example.com" &&
      settingsUi.device === "This device · E2E Sandbox Mac" &&
      settingsUi.version === `Relay ${pkgVersion}` &&
      settingsUi.switchLabel === "Switch Account…" &&
      settingsUi.signOutLabel === "Sign Out" &&
      settingsUi.pairRowHidden === true &&
      settingsUi.providers.length === 2 &&
      settingsUi.providers.every((provider) =>
        provider.text.includes("subscription required") &&
        provider.buttons.some((label) => ["Connected", "Sign in to Claude Code", "Sign in to Codex", "Use Claude subscription", "Use ChatGPT subscription"].includes(label)) &&
        provider.buttons.includes("Disable") &&
        !provider.buttons.includes("Connect local profile") &&
        !provider.buttons.includes("Reconnect") &&
        !provider.buttons.includes("Refresh status")
      ) &&
      settingsAccountMs <= 1500,
    `paint=${settingsAccountMs}ms ${JSON.stringify(settingsUi)}`,
  );

  const authState = await evalIn(pageConn, `window.relay.providerAuthStatus()`, { awaitPromise:true });
  check(
    "settings: provider status is readable without mutating this Mac's local authorization",
    authState && typeof authState === "object" && settingsUi.providers.length === 2,
    JSON.stringify(authState),
  );

  const providerUi = await retry(async () => {
    const ui = await evalIn(pageConn, `(() => [...document.querySelectorAll('[data-provider-row]')].map((row) => ({
      id: row.getAttribute('data-provider-row'),
      text: row.textContent.replace(/\\s+/g, ' ').trim(),
      primary: row.querySelector('[data-provider-connect]')?.textContent.trim() || '',
      primaryDisabled: Boolean(row.querySelector('[data-provider-connect]')?.disabled),
      toggle: row.querySelector('[data-provider-enable]')?.textContent.trim() || '',
    })))()`);
    if (ui.length !== 2 || ui.some((row) => row.text.includes("Checking connection"))) throw new Error(JSON.stringify(ui));
    return ui;
  }, { label: "provider subscription rows reconcile" });
  const claudeUi = providerUi.find((row) => row.id === "claude");
  const codexUi = providerUi.find((row) => row.id === "codex");
  const expectedPrimary = (id, state) => state === "subscription"
    ? "Connected"
    : state === "api_billing"
      ? (id === "claude" ? "Use Claude subscription" : "Use ChatGPT subscription")
      : (id === "claude" ? "Sign in to Claude Code" : "Sign in to Codex");
  check(
    "settings: each provider shows its real subscription action and connected providers have no fake reconnect",
    claudeUi.primary === expectedPrimary("claude", authState.providers.claude.authState) &&
      claudeUi.primaryDisabled === (authState.providers.claude.authState === "subscription") &&
      codexUi.primary === expectedPrimary("codex", authState.providers.codex.authState) &&
      codexUi.primaryDisabled === (authState.providers.codex.authState === "subscription") &&
      providerUi.every((row) => !/local profile|reconnect/i.test(`${row.text} ${row.primary}`)),
    JSON.stringify(providerUi),
  );

  await evalIn(pageConn, `document.querySelector('[data-provider-enable="claude"]').click(); 'disable Claude'`);
  const disabledClaude = await retry(async () => {
    const row = await evalIn(pageConn, `(() => { const row = document.querySelector('[data-provider-row="claude"]'); return {
      text: row.textContent.replace(/\\s+/g, ' ').trim(),
      primaryDisabled: row.querySelector('[data-provider-connect]').disabled,
      toggle: row.querySelector('[data-provider-enable]').textContent.trim(),
    }; })()`);
    if (row.toggle !== "Enable") throw new Error(JSON.stringify(row));
    return row;
  }, { label: "disable Claude for Tasks" });
  check(
    "settings: Disable is Relay-only and makes the recovery path explicit",
    disabledClaude.text.includes("Disabled for Tasks") && disabledClaude.primaryDisabled,
    JSON.stringify(disabledClaude),
  );
  await evalIn(pageConn, `document.querySelector('[data-provider-enable="claude"]').click(); 'enable Claude'`);
  const enabledClaude = await retry(async () => {
    const row = await evalIn(pageConn, `(() => { const row = document.querySelector('[data-provider-row="claude"]'); return {
      primary: row.querySelector('[data-provider-connect]').textContent.trim(),
      primaryDisabled: row.querySelector('[data-provider-connect]').disabled,
      toggle: row.querySelector('[data-provider-enable]').textContent.trim(),
    }; })()`);
    if (row.toggle !== "Disable") throw new Error(JSON.stringify(row));
    return row;
  }, { label: "re-enable Claude for Tasks" });
  check(
    "settings: Enable restores the subscription sign-in action",
    enabledClaude.primary === expectedPrimary("claude", authState.providers.claude.authState) &&
      enabledClaude.primaryDisabled === (authState.providers.claude.authState === "subscription"),
    JSON.stringify(enabledClaude),
  );

  if (authState.providers.claude.authState !== "subscription") {
    const requestGate = await evalIn(pageConn, `window.relay.relayWorkStart('pkt_boot_1', { host:'claude', note:'gate only' })`, { awaitPromise:true });
    check(
      "requests: an unusable provider fails before work starts and names the exact Settings action",
      requestGate?.ok === false &&
        /Claude subscription/.test(requestGate.error || "") &&
        /Agent connections/.test(requestGate.error || "") &&
        /Sign in to Claude Code/.test(requestGate.error || ""),
      JSON.stringify(requestGate),
    );
  }

  const settingsOpenLogStart = childLog.length;
  await evalIn(pageConn, `document.getElementById('svAccount').click(); 'account settings'`);
  const accountSettingsUrl = await retry(async () => {
    const tail = childLog.slice(settingsOpenLogStart);
    const match = tail.match(/suppressed external open:\s+(\S+)/);
    if (!match) throw new Error("account settings did not request an external open");
    return match[1];
  }, { label: "account settings opens first-party gateway" });
  check(
    "settings: Account Settings carries the paired account to Relay's first-party gateway",
    accountSettingsUrl ===
      "http://127.0.0.1:9/account/settings?account=user_e2e&email=e2e%40example.com",
    accountSettingsUrl,
  );

  // ---- 17. notification preferences, driven through the real UI ----
  // These are PREFERENCES, not snoozes: unlike the ✕, an arriving relay must not
  // revoke them. The unit tests pin the wiring; this pins the actual behaviour of a
  // real pill, which is the only place the state machine and the DOM meet.
  const readQuiet = () => evalIn(pageConn, `(() => {
    const view = document.getElementById('settingsView');
    const sw = (key) => view.querySelector('[data-quiet="' + key + '"]');
    const on = (key) => { const el = sw(key); return el ? el.getAttribute('aria-checked') === 'true' : null; };
    return { shown: on('pillHidden'), sounds: on('soundsMuted'),
             hideDisabled: sw('pillHidden') ? sw('pillHidden').disabled : null };
  })()`);

  const quietInitial = await readQuiet();
  check(
    "notifications: Settings offers both positive switches on by default while a tray exists",
    quietInitial.shown === true && quietInitial.sounds === true && quietInitial.hideDisabled === false,
    JSON.stringify(quietInitial),
  );

  await evalIn(pageConn, `document.querySelector('[data-quiet="soundsMuted"]').click(); 'mute'`);
  const muted = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.soundsMuted !== true) throw new Error(`soundsMuted=${state.soundsMuted}`);
    return state;
  }, { label: "mute sounds" });
  check("notifications: turning sounds off reaches the main process and persists", muted.soundsMuted === true, "soundsMuted=true");

  await evalIn(pageConn, `document.querySelector('[data-quiet="pillHidden"]').click(); 'hide'`);
  const quietHidden = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.pillHidden !== true) throw new Error(`pillHidden=${state.pillHidden}`);
    return state;
  }, { label: "hide pill" });
  check(
    "notifications: turning automatic display off keeps the pill up for THIS session instead of vanishing mid-click",
    quietHidden.pillHidden === true && quietHidden.explicitlyOpened === true && quietHidden.visible === true,
    `pillHidden=${quietHidden.pillHidden} explicitlyOpened=${quietHidden.explicitlyOpened} visible=${quietHidden.visible}`,
  );

  // The ✕ revokes the session override, and from there the preference holds.
  await evalIn(pageConn, `window.relay.dismiss(); 'dismiss'`);
  await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.visible !== false) throw new Error("still visible");
    return state;
  }, { label: "hidden pill goes away on ✕" });

  // THE point of the feature: a new relay must NOT bring it back. This is precisely
  // where a merely-dismissed pill reappears — see scenario 6 (re-alert), which
  // asserts the opposite for the same event.
  packets.pkt_quiet_8 = packet("pkt_quiet_8", "Relay that must stay quiet", "2026-07-10T00:30:00.000Z");
  writeState(packets);
  await sleep(6000);
  const afterArrival = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "notifications: a new relay never revokes the hidden preference (a dismissal would have been)",
    afterArrival.visible === false && afterArrival.pillHidden === true,
    `visible=${afterArrival.visible} pillHidden=${afterArrival.pillHidden} pending=${afterArrival.pendingAttention.length}`,
  );

  // The escape hatch: the path Relay.lnk, Relay.app and `relay pill` all take.
  await evalIn(mainConn, "global.__relayTest.showFromTray(); 'shown'");
  const reopened = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.visible !== true) throw new Error("tray reopen did not show the hidden pill");
    return state;
  }, { label: "explicit open beats the hidden preference" });
  check(
    "notifications: an explicit open still reaches a hidden pill, so Settings is never unreachable",
    reopened.visible === true && reopened.explicitlyOpened === true,
    `visible=${reopened.visible} explicitlyOpened=${reopened.explicitlyOpened}`,
  );

  // A host poll must NOT undo that. This is the trap that rules out trayForcedVisible
  // as the override: pollHosts clears it outright whenever a host is running.
  await evalIn(mainConn, "global.__relayTest.pollHosts(); 'polled'");
  await sleep(2000);
  const afterPoll = await evalIn(mainConn, "global.__relayTest.state()");
  check(
    "notifications: a host poll does not re-hide a pill the user just opened",
    afterPoll.visible === true,
    `visible=${afterPoll.visible} trayForcedVisible=${afterPoll.trayForcedVisible} explicitlyOpened=${afterPoll.explicitlyOpened}`,
  );

  // Turning it off must actually bring the pill back rather than stall behind the
  // `dismissed` flag that hiding always sets.
  await evalIn(pageConn, `document.querySelector('.tab[data-view="settings"]').click(); 'settings'`);
  await retry(async () => {
    const ui = await readQuiet();
    if (ui.shown !== false) throw new Error(`switch shows automatic=${ui.shown}`);
    return ui;
  }, { label: "the switch reads back on" });
  await evalIn(pageConn, `document.querySelector('[data-quiet="pillHidden"]').click(); 'unhide'`);
  const unhidden = await retry(async () => {
    const state = await evalIn(mainConn, "global.__relayTest.state()");
    if (state.pillHidden !== false) throw new Error(`pillHidden=${state.pillHidden}`);
    return state;
  }, { label: "un-hide" });
  check(
    "notifications: turning automatic display on clears the dismissal too, so the pill actually returns",
    unhidden.pillHidden === false && unhidden.dismissed === false && unhidden.visible === true,
    `pillHidden=${unhidden.pillHidden} dismissed=${unhidden.dismissed} visible=${unhidden.visible}`,
  );

  console.log(failures === 0 ? "\nALL SCENARIOS PASS" : `\n${failures} SCENARIO(S) FAILED`);
} catch (err) {
  failures += 1;
  console.error("HARNESS ERROR:", err && err.message);
  console.error("--- overlay log tail ---");
  console.error(childLog.split("\n").slice(-25).join("\n"));
} finally {
  if (mainConn) mainConn.close();
  if (pageConn) pageConn.close();
  if (previewConn) previewConn.close();
  child.kill("SIGTERM");
  await Promise.race([childExit, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([childExit, sleep(1000)]);
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}
}
process.exit(failures === 0 ? 0 : 1);
