// Perf harness for the Relay pill overlay (companion to test/e2e-overlay.mjs).
//
// Boots the REAL Electron overlay in a sandbox (isolated RELAY_HOME + userData)
// with PRODUCTION cadences (RELAY_OVERLAY_PERF=1 exposes the inspector seam
// WITHOUT flipping the RELAY_OVERLAY_TEST timing), then measures the overlay's
// background cost in the states that matter for the 2026-08-05 whole-Mac
// stutter investigation:
//
//   phase A — idle steady state: 150 read relays, empty attention queue,
//             visible pill, nobody touching it. Reports per-minute rates of
//             process spawns, window-server re-assertions, prefs/status writes,
//             payload builds, cursor/idle queries, plus main-process CPU%/RSS
//             sampled every 5s.
//   phase B — pending-attention churn: 5 unread relays arrive; on a quiet
//             machine their dwells can never be confirmed (no human input), so
//             they retry into a STICKY card that stays latched on stage with a
//             non-empty queue — exactly the live state observed on the frozen
//             Mac (prefs rewritten every safety tick, return pump hot).
//   phase C — tray-open -> painted latency, 10 runs: hide via tray toggle,
//             showFromTray, then poll the renderer DOM until the card is
//             on-stage and a paint has completed.
//
// Run: node test/perf-overlay.mjs            (needs a GUI session)
// Env: PERF_PHASE_A_MIN (default 5), PERF_PHASE_B_MIN (default 2),
//      PERF_PHASE_D_MIN (default 1), PERF_SKIP_A/B/C=1 to skip phases,
//      PERF_COLLAPSED_MAIN_CPU_MAX / PERF_COLLAPSED_RENDERER_CPU_MAX for gates.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, "..");
const electronExecutable = process.platform === "win32"
  ? "electron.exe"
  : process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : "electron";
const electronBin = [
  path.join(pkgRoot, "node_modules", "electron", "dist", electronExecutable),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", electronExecutable),
].find((p) => fs.existsSync(p));
if (!electronBin) {
  console.error("no Electron binary found; run npm install first");
  process.exit(1);
}
const overlayMain = process.env.RELAY_OVERLAY_MAIN || path.join(pkgRoot, "overlay", "main.cjs");

const MAIN_INSPECT_PORT = Number(process.env.PERF_MAIN_PORT) || 9349;
const RENDERER_CDP_PORT = Number(process.env.PERF_CDP_PORT) || 9350;
const PHASE_A_MIN = Number(process.env.PERF_PHASE_A_MIN) || 5;
const PHASE_B_MIN = Number(process.env.PERF_PHASE_B_MIN) || 2;
const PHASE_D_MIN = Number(process.env.PERF_PHASE_D_MIN) || 1;
const COLLAPSED_MAIN_CPU_MAX = Number(process.env.PERF_COLLAPSED_MAIN_CPU_MAX) || 10;
const COLLAPSED_RENDERER_CPU_MAX = Number(process.env.PERF_COLLAPSED_RENDERER_CPU_MAX) || 5;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-overlay-perf-"));
const relayHome = path.join(sandbox, "home");
const userData = path.join(sandbox, "userdata");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const statePath = path.join(relayHome, "state.json");

function packet(id, title, createdAt, state = "unread") {
  return {
    direction: "inbound",
    state,
    relayNotificationKind: "plain_relay",
    senderName: "Perf Harness",
    title,
    forHuman: `${title} body`,
    createdAt,
    updatedAt: createdAt,
  };
}

const packets = {};
// 150 seeded rows, all READ: a realistic long-lived inbox whose attention queue
// is empty — the state the pill should be able to idle in for free.
for (let i = 0; i < 150; i += 1) {
  const id = `pkt_seed_${String(i).padStart(3, "0")}`;
  const at = new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString();
  packets[id] = packet(id, `Seed relay #${i}`, at, "read");
}
packets.pkt_running_task = {
  ...packet("pkt_running_task", "Long-running perf Task", "2026-07-01T04:00:00.000Z", "read"),
  relayNotificationKind: "task",
  forAgent: "Keep this Task running while the pill lifecycle is measured.",
  taskStartedAt: "2026-07-01T04:00:05.000Z",
  taskRunOwner: { kind: "external_mcp" },
};

function writeState() {
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
writeState();
const configPath = path.join(sandbox, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  deviceToken: "dev_overlay_perf",
  deviceId: "dev_overlay_perf",
  deviceName: "Overlay Perf Harness",
  user: { id:"user_overlay_perf", name:"Overlay Perf Harness", email:"perf@example.com", accountKind:"human", isDeveloper:true },
}, null, 2));

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

const overlayEnv = {
  ...process.env,
  RELAY_HOME: relayHome,
  RELAY_OVERLAY_USER_DATA: userData,
  RELAY_OVERLAY_PERF: "1", // seam only; production cadences stay live
  RELAY_ENV: "dev",
  RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
  RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1", // deterministic presence on a quiet machine
  RELAY_OVERLAY_NOTIFICATION_MS: "5000",
  RELAY_CONFIG: configPath,
  RELAY_WEB_URL: "http://127.0.0.1:9",
  RELAY_API_URL: "http://127.0.0.1:9",
};

const child = spawn(
  electronBin,
  [`--inspect=${MAIN_INSPECT_PORT}`, `--remote-debugging-port=${RENDERER_CDP_PORT}`, overlayMain],
  { env: overlayEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let childLog = "";
child.stdout.on("data", (d) => (childLog += d));
child.stderr.on("data", (d) => (childLog += d));
const childExit = new Promise((resolve) => child.on("exit", resolve));

let mainConn = null;
let pageConn = null;
const summary = { phases: {} };

function perMinute(before, after, minutes) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = {};
  for (const key of keys) {
    if (key === "uptimeMs") continue;
    out[key] = Number((((after[key] || 0) - (before[key] || 0)) / minutes).toFixed(2));
  }
  return out;
}

async function measurePhase(name, minutes) {
  const before = await evalIn(mainConn, "global.__relayTest.perf()");
  const mainBefore = await evalIn(mainConn, "({ cpu:process.cpuUsage(), rss:process.memoryUsage().rss })");
  const rendererBefore = await pageConn.send("Performance.getMetrics");
  const rendererTaskBefore = rendererBefore.metrics.find((metric) => metric.name === "TaskDuration")?.value || 0;
  const startedAt = Date.now();
  await sleep(minutes * 60000);
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const after = await evalIn(mainConn, "global.__relayTest.perf()");
  const mainAfter = await evalIn(mainConn, "({ cpu:process.cpuUsage(), rss:process.memoryUsage().rss })");
  const rendererAfter = await pageConn.send("Performance.getMetrics");
  const rendererTaskAfter = rendererAfter.metrics.find((metric) => metric.name === "TaskDuration")?.value || 0;
  const elapsedUs = elapsedMs * 1000;
  const mainCpuPct = Number((100 * (
    (mainAfter.cpu.user - mainBefore.cpu.user) + (mainAfter.cpu.system - mainBefore.cpu.system)
  ) / elapsedUs).toFixed(2));
  const rendererCpuPct = Number((100 * (rendererTaskAfter - rendererTaskBefore) / (elapsedMs / 1000)).toFixed(2));
  const rates = perMinute(before, after, elapsedMs / 60000);
  const rssMb = Number((mainAfter.rss / 1024 / 1024).toFixed(1));
  const result = { minutes:Number((elapsedMs / 60000).toFixed(3)), ratesPerMinute:rates, mainCpuPct, rendererCpuPct, rssMb };
  summary.phases[name] = result;
  console.log(`\n== ${name} (${minutes} min) ==`);
  console.log(`   per-minute: ${JSON.stringify(rates)}`);
  console.log(`   CPU: main=${mainCpuPct}% renderer-task=${rendererCpuPct}% rss=${rssMb}MB`);
  return result;
}

try {
  const mainInfo = await retry(() => fetchJson(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`), {
    label: "main inspector",
  });
  mainConn = await connectWs(mainInfo[0].webSocketDebuggerUrl);
  await mainConn.send("Runtime.enable");
  await retry(
    async () => {
      const ready = await evalIn(mainConn, "Boolean(global.__relayTest && global.__relayTest.perf)");
      if (!ready) throw new Error("hooks not ready");
    },
    { label: "app ready" },
  );
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
  await pageConn.send("Performance.enable");

  // Let boot churn settle (first sent/contacts loads, first paint) before measuring.
  await sleep(15000);
  const bootState = await evalIn(mainConn, "global.__relayTest.state()");
  console.log(
    `boot: visible=${bootState.visible} pending=${bootState.pendingAttention.length} rows=150 (all read)`,
  );

  // ---- phase A: idle steady state ----
  if (process.env.PERF_SKIP_A !== "1") {
    await measurePhase("A-idle-150-read-rows", PHASE_A_MIN);
  }

  // ---- phase D: a live Task folded into the compact pill ----
  // This is the 0.1.402 regression state: Tasks remains the selected DOM view,
  // while the card is visually collapsed. No continuous animation, rAF watcher,
  // run polling, or payload-driven surface rebuild may survive the fold.
  await evalIn(pageConn, "window.__relayMotionTest.setView('tasks')");
  await retry(async () => {
    const present = await evalIn(pageConn, "Boolean(document.querySelector('.tb-working-orb'))");
    if (!present) throw new Error("running Task indicator is absent");
  }, { label:"running Task indicator" });
  const expandedMotion = await evalIn(pageConn, "window.__relayMotionTest.state()");
  if (!expandedMotion.active || expandedMotion.motion !== "running") throw new Error(`expanded motion is not running: ${JSON.stringify(expandedMotion)}`);
  await evalIn(pageConn, "window.__relayMotionTest.setCollapsed(true)");
  await sleep(1200); // card spring settles before the idle measurement
  const foldedBefore = await evalIn(pageConn, "window.__relayMotionTest.state()");
  await evalIn(pageConn, "window.__relayMotionTest.render(25)");
  await sleep(500);
  const foldedAfterRender = await evalIn(pageConn, "window.__relayMotionTest.state()");
  if (foldedAfterRender.surfacePaintCount !== foldedBefore.surfacePaintCount) {
    throw new Error(`collapsed payload renders repainted the surface: ${foldedBefore.surfacePaintCount} -> ${foldedAfterRender.surfacePaintCount}`);
  }
  if (foldedAfterRender.frameWatch.active || foldedAfterRender.frameWatch.ticks !== foldedBefore.frameWatch.ticks) {
    throw new Error(`collapsed frame watcher remained live: ${JSON.stringify({ foldedBefore, foldedAfterRender })}`);
  }
  if (foldedAfterRender.loopAnimations.some((state) => state === "running")) {
    throw new Error(`collapsed loop animation remained live: ${JSON.stringify(foldedAfterRender.loopAnimations)}`);
  }
  const foldedPerf = await measurePhase("D-running-task-collapsed", PHASE_D_MIN);
  if (foldedPerf.mainCpuPct > COLLAPSED_MAIN_CPU_MAX) {
    throw new Error(`collapsed main CPU ${foldedPerf.mainCpuPct}% exceeded ${COLLAPSED_MAIN_CPU_MAX}%`);
  }
  if (foldedPerf.rendererCpuPct > COLLAPSED_RENDERER_CPU_MAX) {
    throw new Error(`collapsed renderer CPU ${foldedPerf.rendererCpuPct}% exceeded ${COLLAPSED_RENDERER_CPU_MAX}%`);
  }
  await evalIn(pageConn, "window.__relayMotionTest.setCollapsed(false)");
  await retry(async () => {
    const state = await evalIn(pageConn, "window.__relayMotionTest.state()");
    if (!state.active || state.motion !== "running" || !state.frameWatch.active) throw new Error(JSON.stringify(state));
  }, { label:"expanded motion resume" });

  // ---- phase B: pending-attention churn while the user is AWAY ----
  // Deterministic on a machine in active use: presenting cards would hand
  // confirmation to the REAL cursor (a stray hover counts as interaction and
  // drains the queue mid-measurement). Away defers presentation entirely while
  // the queue stays non-empty — the exact state whose disk churn was observed
  // live on the frozen Mac (overlay-prefs.json rewritten every safety tick).
  if (process.env.PERF_SKIP_B !== "1") {
    await evalIn(mainConn, "global.__relayTest.setAway(true); 'away'");
    for (let i = 0; i < 5; i += 1) {
      const id = `pkt_hot_${i}`;
      packets[id] = packet(id, `Hot unread relay #${i}`, new Date(Date.UTC(2026, 6, 2, 0, i)).toISOString());
    }
    writeState();
    await retry(
      async () => {
        const st = await evalIn(mainConn, "global.__relayTest.state()");
        if (st.pendingAttention.length < 5) throw new Error(`pending=${st.pendingAttention.length}`);
      },
      { label: "attention queue primed" },
    );
    await sleep(10000); // let arrival churn settle before measuring the plateau
    const bState = await evalIn(mainConn, "global.__relayTest.state()");
    console.log(
      `phase B steady state: pending=${bState.pendingAttention.length} away=true currentShow=${JSON.stringify(bState.currentShow)}`,
    );
    await measurePhase("B-pending-queue-away", PHASE_B_MIN);
    // Return and drain the queue via confirmed dwells (same seam as the e2e), so
    // phase C measures latency against a settled pill.
    await evalIn(mainConn, "global.__relayTest.setAway(false); 'returned'");
    await retry(
      async () => {
        const st = await evalIn(mainConn, "global.__relayTest.state()");
        if (st.currentShow) await evalIn(mainConn, "global.__relayTest.confirmCurrentShow()");
        if (st.pendingAttention.length > 0) throw new Error(`pending=${st.pendingAttention.length}`);
      },
      { tries: 60, delayMs: 400, label: "drain attention queue before phase C" },
    );
  }

  // ---- phase C: tray-open -> painted latency ----
  if (process.env.PERF_SKIP_C !== "1") {
    const runs = [];
    for (let i = 0; i < 10; i += 1) {
      await evalIn(mainConn, "global.__relayTest.toggleFromTray(); 'hidden'");
      await retry(
        async () => {
          if ((await evalIn(mainConn, "global.__relayTest.state().visible")) !== false) throw new Error("still visible");
        },
        { tries: 40, delayMs: 100, label: "hidden before latency run" },
      );
      await sleep(700); // past the 300ms tray-toggle debounce, plus settle
      const t0 = Date.now();
      await evalIn(mainConn, "global.__relayTest.showFromTray(); 'shown'");
      await retry(
        async () => {
          const painted = await evalIn(
            pageConn,
            `(() => { const c = document.getElementById('card').classList; return !c.contains('offstage') && !c.contains('bye') && !c.contains('collapsed'); })()`,
          );
          if (!painted) throw new Error("not painted");
        },
        { tries: 200, delayMs: 20, label: "card painted" },
      );
      await evalIn(pageConn, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", {
        awaitPromise: true,
      });
      runs.push(Date.now() - t0);
      await sleep(700);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)];
    summary.phases["C-tray-open-latency"] = { runsMs: runs, medianMs: median };
    console.log(`\n== C tray-open -> painted ==`);
    console.log(`   runs(ms): ${runs.join(", ")}  median=${median}ms`);
  }

  console.log(`\nPERF_SUMMARY_JSON ${JSON.stringify(summary)}`);
} catch (err) {
  console.error("PERF HARNESS ERROR:", err && err.message);
  console.error("--- overlay log tail ---");
  console.error(childLog.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  if (mainConn) mainConn.close();
  if (pageConn) pageConn.close();
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
