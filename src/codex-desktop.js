// Codex Desktop foregrounding driver. Ported faithfully from
// granular/tools/relay-companion/src/codex-desktop.js. Finds the running Codex
// main process, opens its Node inspector, and runs a
// Runtime.evaluate -> webContents.executeJavaScript -> electronBridge expression
// in the selected primary BrowserWindow to refresh the recents rail and
// navigate-to-route the freshly materialized Relay thread.
//
// Only adaptation: the original `import WsWebSocket from "ws"` is made optional.
// Node 22+ exposes a global WebSocket (which the original already preferred), so
// we use that; the `ws` package is loaded lazily only as a fallback and never at
// module-load time, so this module imports cleanly without the dependency.
//
// On top of the ported refresh/open path, this module carries the
// "Open in current chat" live tier (submitTurnToCodexDesktopThread /
// relaySubmitCodexRenderer): resume the user's current thread in the primary
// window and start a real turn in it through the same inspector bridge.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSPECTOR_HOST = "127.0.0.1";
const INSPECTOR_PORTS = Array.from({ length: 11 }, (_, index) => 9229 + index);
// The Codex desktop app was renamed to ChatGPT while retaining bundle id
// com.openai.codex. Support both the current and legacy application layouts.
const CODEX_MAIN_PATHS = [
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  "/Applications/Codex.app/Contents/MacOS/Codex",
];
// Launch order for a cold open (see notifyCodexDesktopThreads). Matches the
// overlay's own activation candidates so both agree on which app "codex" means.
const CODEX_DESKTOP_BUNDLE_IDS = ["com.openai.codex", "com.openai.chat"];
// Consecutive empty `ps` reads before a cold-start wait concludes the app really
// is gone. Matches the pill's own host-visibility debounce.
const CODEX_ABSENT_MISS_THRESHOLD = 3;

let wsFallbackPromise = null;
let codexProjectMutationChain = Promise.resolve();

export function enqueueCodexProjectMutation(run) {
  const result = codexProjectMutationChain.then(run, run);
  codexProjectMutationChain = result.catch(() => {});
  return result;
}

async function resolveWebSocketImpl() {
  if (typeof WebSocket === "function") return WebSocket;
  if (!wsFallbackPromise) {
    wsFallbackPromise = import("ws")
      .then((mod) => mod.default || mod.WebSocket || mod)
      .catch(() => null);
  }
  const ws = await wsFallbackPromise;
  if (!ws) throw new Error("No WebSocket implementation available (global WebSocket missing and 'ws' not installed)");
  return ws;
}

export async function notifyCodexDesktopThread({ threadId, pinnedThreadIds = null, timeoutMs, open = false } = {}) {
  return notifyCodexDesktopThreads({
    threadIds: threadId ? [threadId] : [],
    pinnedThreadIds,
    timeoutMs,
    openThreadId: open ? threadId : null,
  });
}

export async function notifyCodexDesktopThreads(options = {}) {
  const mutatesProject = Boolean(String(options.ensureWorkspaceRoot || "").trim());
  return mutatesProject
    ? enqueueCodexProjectMutation(() => notifyCodexDesktopThreadsUnserialized(options))
    : notifyCodexDesktopThreadsUnserialized(options);
}

async function notifyCodexDesktopThreadsUnserialized({
  threadIds = [],
  pinnedThreadIds = null,
  openThreadId = null,
  workspaceRootsByThreadId = null,
  ensureWorkspaceRoot = null,
  assignmentOnly = false,
  primeOpen = true,
  timeoutMs = Number(process.env.RELAY_CODEX_DESKTOP_TIMEOUT_MS || 8000),
  platform = process.platform,
} = {}) {
  if (process.env.RELAY_CODEX_DESKTOP_REFRESH === "0") return { attempted: false, reason: "disabled" };
  if (!["darwin", "win32"].includes(platform)) return { attempted: false, reason: "unsupported-platform" };

  const openId = String(openThreadId || "").trim() || null;
  const ids = uniqueStrings(openId ? [...threadIds, openId] : threadIds);
  const pinnedIds = Array.isArray(pinnedThreadIds) ? uniqueStrings(pinnedThreadIds) : null;
  if (!ids.length && !pinnedIds && !openId) return { attempted: false, reason: "nothing-to-refresh" };

  let pids = await findCodexMainPids(platform);
  let coldLaunched = false;
  if (!pids.length) {
    // COLD START: an open must not assume the app is already running. Returning
    // "codex-not-running" here leaves the caller's codex:// deep link as the only
    // opener, and that link is a RACE against the app's own boot — fired at a
    // launching ChatGPT it is sometimes dropped and the user lands on the Home
    // screen with the relay merely pinned (observed live: two cold opens landed
    // on the thread, a third landed on Home). Launch the app ourselves and wait
    // for it, so the deterministic bridge path below does the open instead.
    // Only a real OPEN may launch: a background pin/recents refresh must never
    // make an app appear on someone's screen.
    if (!openId) return { attempted: true, ok: false, reason: "codex-not-running", results: [] };
    const launched = await launchCodexDesktop(platform);
    pids = launched ? await waitForCodexMainPids(Number(process.env.RELAY_CODEX_LAUNCH_TIMEOUT_MS || 30000), platform) : [];
    if (!pids.length) return { attempted: true, ok: false, reason: "codex-launch-failed", results: [] };
    coldLaunched = true;
  }

  const expression = buildCodexDesktopRefreshExpression({
    threadIds: ids,
    pinnedThreadIds: pinnedIds,
    openThreadId: openId,
    workspaceRootsByThreadId,
    ensureWorkspaceRoot,
    assignmentOnly,
    primeOpen,
  });
  // READINESS, not liveness: a just-launched app answers the inspector (the main
  // process is up) long before it owns a BrowserWindow to drive, and an app the
  // user left running with every window CLOSED never owns one at all. Both cases
  // used to score as success — `ok` counted the inspector evaluation, not the
  // window — which suppressed the deep-link fallback and showed the user nothing.
  // So wait for a primary window to actually RUN the code, polling rather than
  // sleeping a fixed guess, and report honestly when it never does.
  const readyDeadline = Date.now() + (coldLaunched ? Number(process.env.RELAY_CODEX_COLD_READY_MS || 45000) : 0);
  let results = [];
  let misses = 0;
  for (;;) {
    results = await evaluateAcrossCodexPids(pids, expression, { timeoutMs, platform });
    if (results.some(primaryWindowRan)) break;
    if (Date.now() >= readyDeadline) break;
    await sleep(500);
    const next = await findCodexMainPids(platform);
    // A booting app's process list FLICKERS — an early build measured one empty
    // `ps` read seconds after a successful launch — so a single miss must not
    // abandon the wait, or the cold open gives up while the app is still coming
    // up. Same 3-miss debounce the pill uses for host visibility.
    if (next.length) {
      misses = 0;
      pids = next;
      continue;
    }
    misses += 1;
    if (misses >= CODEX_ABSENT_MISS_THRESHOLD) break; // really gone; nothing left to wait for
  }

  const reached = results.some(primaryWindowRan);
  const rendererResult = primaryRefreshRendererResult(results);
  return {
    attempted: true,
    ok: reached,
    // Keep this distinct from the generic result for refresh-only calls. The
    // caller may suppress the codex:// fallback only after the requested task
    // is active and the selected Codex window has actually taken focus.
    openConfirmed: Boolean(openId && reached),
    projectAssignmentOk: ensureWorkspaceRoot ? rendererResult?.projectAssignmentOk === true : true,
    ...(reached ? {} : { reason: coldLaunched ? "codex-not-ready" : "codex-window-unavailable" }),
    results,
  };
}

async function evaluateAcrossCodexPids(pids, expression, { timeoutMs, platform = process.platform }) {
  const results = [];
  for (const pid of pids) {
    let target;
    try {
      target = await findOrStartInspectorForPid(pid, { timeoutMs, platform });
      if (!target) {
        results.push({ pid, ok: false, reason: "inspector-unavailable" });
        continue;
      }
    } catch (error) {
      results.push({ pid, ok: false, reason: "inspector-unavailable", error: errorMessage(error) });
      continue;
    }
    try {
      const value = await evaluateInspectorExpression(target.webSocketDebuggerUrl, expression, { timeoutMs });
      results.push({ pid, ok: true, value });
    } catch (error) {
      // Once Runtime.evaluate has been dispatched, a timeout or socket loss is
      // ambiguous: the renderer may still complete turn/start. Callers must
      // poll the durable client identity and must never replay the expression.
      results.push({ pid, ok: false, deliveryAmbiguous: true, error: errorMessage(error) });
    }
  }
  return results;
}

// Did a primary window actually EXECUTE the renderer code? `ok` on the per-pid
// envelope only says the inspector evaluation itself succeeded, which is equally
// true when BrowserWindow.getAllWindows() came back empty — so it cannot stand in
// for readiness. Exported for the unit tests.
export function primaryWindowRan(entry) {
  if (!entry || !entry.ok || !Array.isArray(entry.value)) return false;
  return entry.value.some(
    (win) =>
      win &&
      win.kind === "primary" &&
      !win.skipped &&
      win.result?.ok === true &&
      (!win.focusRequested || win.focused === true),
  );
}

export function primaryRefreshRendererResult(results) {
  for (const entry of Array.isArray(results) ? results : []) {
    if (!entry?.ok || !Array.isArray(entry.value)) continue;
    const selected = entry.value.find((win) => win?.kind === "primary" && !win.skipped && win.result && typeof win.result === "object");
    if (selected) return selected.result;
  }
  return null;
}

// Bring up ChatGPT/Codex Desktop. Bundle ids in the same order the activation
// path uses, so a machine carrying only the legacy app still launches.
async function launchCodexDesktop(platform = process.platform) {
  if (platform === "win32") {
    try {
      await execFileAsync(path.win32.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), ["codex://"], {
        timeout: 8000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  for (const bundle of CODEX_DESKTOP_BUNDLE_IDS) {
    try {
      await execFileAsync("/usr/bin/open", ["-b", bundle], { timeout: 8000 });
      return true;
    } catch {
      // Try the next bundle id.
    }
  }
  return false;
}

// Poll for the launched process instead of sleeping a guess: LaunchServices
// returns as soon as it has handed the launch off, well before the app exists.
async function waitForCodexMainPids(timeoutMs, platform = process.platform) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  for (;;) {
    const pids = await findCodexMainPids(platform);
    if (pids.length) return pids;
    if (Date.now() >= deadline) return [];
    await sleep(250);
  }
}

// "Open in current chat" live tier: start a real turn in an existing thread in
// the running ChatGPT desktop app via the inspector bridge. Returns
//   { attempted, submitted, reason?, results }
// submitted=true only when the selected primary renderer acknowledged the
// request or the exact durable client identity appeared in the rollout. An
// inspector failure after dispatch is marked deliveryAmbiguous so callers fail
// closed instead of falling back to a second writer.
export async function submitTurnToCodexDesktopThread({
  threadId,
  text,
  model,
  effort,
  cwd,
  approvalPolicy,
  approvalsReviewer,
  sandboxPolicy,
  clientUserMessageId: suppliedClientUserMessageId,
  requestId: suppliedRequestId,
  // Ownership of a just-resumed thread settles asynchronously. Retry transport
  // failures, but once the renderer accepts the turn/start envelope only poll
  // for its exact rollout identity. Re-firing an accepted envelope can append
  // duplicate visible user turns even when the client identity is unchanged.
  rolloutPath = "",
  confirmAttempts = Number(process.env.RELAY_CODEX_TURN_ATTEMPTS || 4),
  confirmIntervalMs = Number(process.env.RELAY_CODEX_TURN_INTERVAL_MS || 5000),
  // Must outlast the renderer's worst-case step budget (history hydrate 4s +
  // resume 6s + start-turn 8s), or the inspector eval would give up while the
  // renderer is still working and mis-report a live submit as failed.
  timeoutMs = Number(process.env.RELAY_CODEX_SUBMIT_TIMEOUT_MS || 20000),
  // Keep the platform gate injectable so lifecycle tests exercise the macOS
  // bridge deterministically on GitHub's Linux runners.
  platform = process.platform,
  // Test seam for the lifecycle state machine. Production callers never pass
  // this; keeping the process/inspector clock injectable lets regression tests
  // prove a PID swap and a dead inspector without killing the user's app.
  runtime = null,
  // Acknowledgement edge for UI receipts. Callers still await rollout
  // verification before treating the turn as durably delivered.
  onSubmitted = null,
} = {}) {
  if (process.env.RELAY_CODEX_DESKTOP_REFRESH === "0") return { attempted: false, submitted: false, reason: "disabled" };
  if (!["darwin", "win32"].includes(platform)) return { attempted: false, submitted: false, reason: "unsupported-platform" };
  const cleanThreadId = String(threadId || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanThreadId || !cleanText) return { attempted: false, submitted: false, reason: "missing-thread-or-text" };

  const io = runtime || {};
  const findPids = io.findCodexMainPids || (() => findCodexMainPids(platform));
  const evaluate = io.evaluateAcrossCodexPids || evaluateAcrossCodexPids;
  const pause = io.sleep || sleep;
  const launch = io.launchCodexDesktop || (() => launchCodexDesktop(platform));
  const waitPids = io.waitForCodexMainPids || ((timeout) => waitForCodexMainPids(timeout, platform));
  // One logical picker selection owns one durable identity for its entire
  // lifetime. session-delivery persists these before submitting so a second
  // process can reconcile the rollout without manufacturing a new turn.
  const clientUserMessageId = String(suppliedClientUserMessageId || "").trim() || randomUUID();
  const requestId = String(suppliedRequestId || "").trim() || randomUUID();
  const expression = buildCodexDesktopSubmitExpression({
    threadId: cleanThreadId,
    text: cleanText,
    model,
    effort,
    cwd,
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy,
    clientUserMessageId,
    requestId,
  });

  const maxAttempts = Math.max(1, Number.isFinite(confirmAttempts) ? confirmAttempts : 1);
  const pollMs = Math.max(10, Math.min(700, Math.floor(Math.max(10, confirmIntervalMs) / 4)));
  const allResults = [];
  let renderer = null;
  let delivered = false;
  let deliveryAmbiguous = false;
  let ran = rolloutPath ? codexRolloutHasClientMessage(rolloutPath, clientUserMessageId) : null;
  let attempts = 0;
  let coldLaunchTried = false;
  let submittedNotified = false;

  for (let confirmationRound = 1; confirmationRound <= maxAttempts && ran !== true; confirmationRound += 1) {
    if (!delivered && !deliveryAmbiguous) {
      attempts += 1;
      // Resolve the process again before every transport retry. A ChatGPT
      // update/restart can leave the prior inspector socket stale while a new
      // primary renderer is already alive.
      let pids = await findPids();
      if (!pids.length && !coldLaunchTried) {
        coldLaunchTried = true;
        if (await launch()) pids = await waitPids(Number(process.env.RELAY_CODEX_LAUNCH_TIMEOUT_MS || 30000));
      }

      if (pids.length) {
        // A destructive expression must never be broadcast across overlapping
        // old/new app processes: each process can own a primary window and both
        // would submit the same visible turn. The newest main PID is the only
        // candidate for this logical picker selection.
        const newestPid = Math.max(...pids.map(Number).filter(Number.isFinite));
        const selectedPids = Number.isFinite(newestPid) ? [newestPid] : [];
        const results = selectedPids.length
          ? await evaluate(selectedPids, expression, { timeoutMs, platform })
          : [];
        allResults.push(...results.map((entry) => ({ ...entry, attempt: attempts })));
        if (results.some((entry) => entry?.deliveryAmbiguous === true)) deliveryAmbiguous = true;
        const current = primarySubmitRendererResult(results);
        if (current) renderer = current;
        if (current?.deliveryAmbiguous === true) deliveryAmbiguous = true;
        if (current && current.ok === true) {
          delivered = true;
          if (!submittedNotified) {
            submittedNotified = true;
            try { await onSubmitted?.({ threadId: cleanThreadId, clientUserMessageId, renderer: current }); } catch {}
          }
        }
        if (current?.reason === "turn-in-progress" && !delivered) {
          const deadline = Date.now() + Math.max(10, confirmIntervalMs);
          while (rolloutPath && Date.now() < deadline) {
            if (codexRolloutHasClientMessage(rolloutPath, clientUserMessageId)) {
              ran = true;
              break;
            }
            await pause(pollMs);
          }
          if (ran !== true) break;
        }
      }
    }

    if (!rolloutPath) {
      ran = null;
      if (delivered) break;
    } else {
      const deadline = Date.now() + Math.max(10, confirmIntervalMs);
      while (Date.now() < deadline) {
        if (codexRolloutHasClientMessage(rolloutPath, clientUserMessageId)) {
          ran = true;
          break;
        }
        await pause(pollMs);
      }
      if (ran !== true) ran = false;
    }
  }

  if (!allResults.length && !coldLaunchTried) {
    return { attempted: true, submitted: false, ran, reason: "codex-not-running", results: [], clientUserMessageId };
  }
  return {
    attempted: true,
    submitted: delivered || ran === true,
    deliveryAmbiguous,
    ran,
    turnAttempts: attempts,
    reason: renderer ? renderer.reason || null : "no-primary-window-result",
    rendererResult: renderer,
    results: allResults,
    clientUserMessageId,
  };
}

/**
 * The app-server writes the composer identity verbatim on the canonical
 * event_msg/user_message row. Matching that identity is the only honest start
 * acknowledgment: line-count growth can be a token count, tool update, or a
 * different native turn in the same thread.
 */
export function codexRolloutHasClientMessage(rolloutPath, clientUserMessageId) {
  const wanted = String(clientUserMessageId || "").trim();
  if (!wanted) return false;
  let body;
  try {
    body = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return false;
  }
  for (const line of body.split("\n")) {
    if (!line || !line.includes(wanted)) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "event_msg") continue;
      // Older app-server rollouts wrote the composer identity directly on a
      // user_message event. Current Codex Desktop writes the same identity on
      // the completed UserMessage item instead. Treat both as the one native
      // acknowledgement. Missing the current shape made Relay retry a turn
      // that had already landed, append the same Relay reference repeatedly,
      // and finally start a competing App Server against Desktop's live owner.
      if (row?.payload?.type === "user_message" && row.payload.client_id === wanted) return true;
      if (
        row?.payload?.type === "item_completed" &&
        row.payload.item?.type === "UserMessage" &&
        row.payload.item?.client_id === wanted
      ) return true;
    } catch {
      // A writer may be halfway through the final line; the next poll retries.
    }
  }
  return false;
}

// Dig the renderer's relaySubmitCodexRenderer return value out of the
// per-pid/per-window envelope. Exported for the fallback-ordering tests.
export function primarySubmitRendererResult(results) {
  for (const entry of Array.isArray(results) ? results : []) {
    if (!entry || !entry.ok || !Array.isArray(entry.value)) continue;
    for (const win of entry.value) {
      if (win && win.kind === "primary" && !win.skipped && win.result && typeof win.result === "object") {
        return win.result;
      }
    }
  }
  return null;
}

// Runs INSIDE the selected primary Codex renderer: it is serialized to a string
// via toString() and evaluated in the window's page context, so it must be
// self-contained — no imports, only renderer globals (window, location).
// Exported at module scope so the thread-routing decision can be unit-tested.
export async function relayRefreshCodexRenderer(payload) {
  const hostId = "local";
  const bridge = window.electronBridge;
  if (!bridge?.sendMessageFromView) return { ok: false, reason: "missing-electron-bridge" };

  const sent = [];
  // Bound every bridge send. Some host messages (notably maybe-resume-conversation)
  // can hang indefinitely; the original serial awaits then block the navigation
  // that follows, leaving the thread unopened. Cap each send so the open proceeds.
  async function send(message, timeoutMs = 2000) {
    try {
      await Promise.race([
        bridge.sendMessageFromView(message),
        new Promise((_, reject) => setTimeout(() => reject(new Error("send-timeout")), timeoutMs)),
      ]);
      sent.push({ type: message.type, ok: true });
    } catch (error) {
      sent.push({ type: message.type, ok: false, error: String(error?.message || error) });
    }
  }

  // Use the same vscode://codex request bridge as Codex Desktop's own state
  // store. `sendMessageFromView` is one-way, while the matching fetch response
  // arrives as a window message, so correlate it explicitly by request id.
  // This keeps project membership writes inside Codex's main process: no
  // brittle direct edits of .codex-global-state.json and no lost broadcasts.
  async function hostRequest(name, params, timeoutMs = 700) {
    const requestId = globalThis.crypto?.randomUUID?.() || `relay-${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`${name}-timeout`)));
      }, timeoutMs);
      function finish(callback) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener?.("message", onMessage);
        callback();
      }
      function onMessage(event) {
        const message = event?.data;
        if (message?.type !== "fetch-response" || message.requestId !== requestId) return;
        if (message.responseType !== "success" || !(message.status >= 200 && message.status < 300)) {
          finish(() => reject(new Error(String(message.error || message.bodyJsonString || `${name}-failed`))));
          return;
        }
        finish(() => {
          try {
            resolve(JSON.parse(message.bodyJsonString || "null"));
          } catch (error) {
            reject(error);
          }
        });
      }
      window.addEventListener?.("message", onMessage);
      try {
        Promise.resolve(
          bridge.sendMessageFromView({
            type: "fetch",
            requestId,
            method: "POST",
            url: `vscode://codex/${name}`,
            body: JSON.stringify(params),
          }),
        ).catch((error) => finish(() => reject(error)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  const canonicalRoot = (value) => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const findProjectForRoot = (projects, root) => {
    const wanted = canonicalRoot(root);
    if (!wanted || !projects || typeof projects !== "object") return null;
    return (
      Object.values(projects).find((project) =>
        Array.isArray(project?.rootPaths) && project.rootPaths.some((candidate) => canonicalRoot(candidate) === wanted),
      ) || null
    );
  };

  if (Array.isArray(payload.pinnedThreadIds)) {
    await send({ type: "set-pinned-thread-ids-for-host", hostId, threadIds: payload.pinnedThreadIds });
  }
  const projectRoot = String(payload.ensureWorkspaceRoot || "").trim();
  let projectAssignmentOk = !projectRoot;
  let relayProject = null;
  let projectLookupOk = false;
  if (projectRoot) {
    const mutateProjectState = async () => {
    try {
      relayProject = findProjectForRoot((await hostRequest("get-global-state", { key: "local-projects" }))?.value, projectRoot);
      projectLookupOk = true;
    } catch (error) {
      sent.push({ type: "relay-project-lookup", ok: false, error: String(error?.message || error) });
    }
    // Create through Codex's native project manager on a foreground open. The
    // update-roots command owns the project-map transaction and selects the
    // resulting project, but (unlike add-new-workspace-root-option) does not
    // navigate the renderer to Home. Background repair never creates/selects a
    // project or disturbs the active window.
    if (projectLookupOk && !relayProject) {
      if (payload.openThreadId) {
        try {
          await send({ type: "electron-update-workspace-root-options", roots: [projectRoot] });
          for (let attempt = 0; attempt < 5 && !relayProject; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            const saved = (await hostRequest("get-global-state", { key: "local-projects" }))?.value;
            relayProject = findProjectForRoot(saved, projectRoot);
          }
        } catch (error) {
          sent.push({ type: "relay-project-registration", ok: false, error: String(error?.message || error) });
        }
      }
    }

    if (relayProject?.id) {
      const concurrentAssignments = {};
      const onAssignmentUpdate = (event) => {
        const message = event?.data;
        if (message?.type !== "thread-project-assignments-updated" || !message.assignments || typeof message.assignments !== "object") return;
        Object.assign(concurrentAssignments, message.assignments);
      };
      window.addEventListener?.("message", onAssignmentUpdate);
      try {
        const assignment = { projectKind: "local", projectId: relayProject.id };
        const relayThreadIds = payload.threadIds.filter((threadId) => {
          const roots = Array.isArray(payload.workspaceRootsByThreadId?.[threadId])
            ? payload.workspaceRootsByThreadId[threadId]
            : [];
          return roots.some((root) => canonicalRoot(root) === canonicalRoot(projectRoot));
        });
        let verified = false;
        const applyConcurrent = (assignments) => {
          for (const [threadId, concurrent] of Object.entries(concurrentAssignments)) {
            if (concurrent == null) delete assignments[threadId];
            else assignments[threadId] = concurrent;
          }
        };
        const sameAssignment = (left, right) =>
          left?.projectKind === right?.projectKind &&
          left?.projectId === right?.projectId &&
          (left?.hostId || null) === (right?.hostId || null);
        for (let attempt = 0; attempt < 2 && !verified; attempt += 1) {
          const current = (await hostRequest("get-global-state", { key: "thread-project-assignments" }))?.value;
          const assignments = current && typeof current === "object" ? { ...current } : {};
          applyConcurrent(assignments);
          for (const threadId of relayThreadIds) assignments[threadId] = assignment;
          await hostRequest("set-global-state", { key: "thread-project-assignments", value: assignments });
          const saved = (await hostRequest("get-global-state", { key: "thread-project-assignments" }))?.value;
          const required = { ...assignments };
          applyConcurrent(required);
          for (const threadId of relayThreadIds) required[threadId] = assignment;
          verified = Object.entries(required).every(([threadId, expected]) =>
            expected == null ? saved?.[threadId] == null : sameAssignment(saved?.[threadId], expected),
          );
        }
        if (!verified) throw new Error("assignment-not-persisted");

        // Do not rewrite Codex's projectless-thread-ids array. Codex derives
        // Recents from the assignment map and excludes every assigned thread;
        // its native projectless bookkeeping may change concurrently, and a
        // generic whole-array write here could erase an unrelated new task.
        projectAssignmentOk = true;
        sent.push({ type: "relay-project-assignment", ok: true, projectId: relayProject.id });
      } catch (error) {
        sent.push({ type: "relay-project-assignment", ok: false, error: String(error?.message || error) });
      } finally {
        window.removeEventListener?.("message", onAssignmentUpdate);
      }
    } else {
      sent.push({ type: "relay-project-assignment", ok: false, error: "project-not-found" });
    }
    };
    const locks = globalThis.navigator?.locks;
    if (locks?.request) {
      let acquired = false;
      // An inspector evaluation cannot cancel executeJavaScript after its
      // websocket timeout. Never leave an expression queued on a browser lock:
      // if another Relay mutation owns it, fail fast and let the bounded quiet
      // assignment retry heal the task without a late surprise navigation.
      for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
        acquired = await locks.request(
          "relay-codex-project-state",
          { ifAvailable: true },
          async (lock) => {
            if (!lock) return false;
            await mutateProjectState();
            return true;
          },
        );
        if (!acquired && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
      if (!acquired) sent.push({ type: "relay-project-assignment", ok: false, error: "project-state-lock-busy" });
    } else {
      await mutateProjectState();
    }
  }
  if (payload.assignmentOnly) {
    return {
      ok: projectAssignmentOk,
      projectAssignmentOk,
      openConfirmed: false,
      href: location.href,
      openThreadId: null,
      sent,
    };
  }
  if (payload.threadIds.length) {
    await send({ type: "hydrate-pinned-threads", hostId, threadIds: payload.threadIds });
  }
  await send({ type: "refresh-recent-conversations-for-host", hostId });
  for (const threadId of payload.threadIds) {
    const workspaceRoots = Array.isArray(payload.workspaceRootsByThreadId?.[threadId])
      ? payload.workspaceRootsByThreadId[threadId].map((root) => String(root || "").trim()).filter(Boolean)
      : [];
    // Codex Desktop (>=0.142) serves thread views from its in-memory core and
    // never cold-loads externally created threads — the view spins forever
    // until an app restart. Adopt the thread the way the app itself opens one:
    // drop any stale cache entry, ask the tail-hydration path to load history
    // (feature-gated; harmless when off — dependentConversationIds is REQUIRED
    // or the handler throws), then maybe-resume-conversation, which activates
    // the thread summary and resumes the conversation from the rollout on disk.
    await send({ type: "discard-conversation-from-cache", conversationId: threadId });
    await send({ type: "ensure-conversation-history-loaded", conversationId: threadId, dependentConversationIds: [] });
    await send({
      type: "maybe-resume-conversation",
      hostId,
      conversationId: threadId,
      model: null,
      serviceTier: null,
      reasoningEffort: null,
      workspaceRoots,
      collaborationMode: null,
    });
    await send({ type: "broadcast-conversation-snapshot-for-host", hostId, conversationId: threadId });
  }
  let openConfirmed = false;
  if (payload.openThreadId) {
    const encoded = encodeURIComponent(String(payload.openThreadId));
    const navTo = (path) => {
      try {
        window.postMessage({ type: "navigate-to-route", path }, location.origin);
        const attempt = { type: "navigate-to-route", attempted: true, ok: false, path };
        sent.push(attempt);
        return attempt;
      } catch (error) {
        const attempt = { type: "navigate-to-route", attempted: true, ok: false, path, error: String(error?.message || error) };
        sent.push(attempt);
        return attempt;
      }
    };
    const targetThreadId = String(payload.openThreadId);
    const targetIsActive = () => {
      const nodes = window.document?.querySelectorAll?.("[data-app-action-sidebar-thread-id]") || [];
      for (const node of nodes) {
        const activeId = node.getAttribute?.("data-app-action-sidebar-thread-id");
        if (
          (activeId === targetThreadId || activeId === `${hostId}:${targetThreadId}`) &&
          node.getAttribute?.("data-app-action-sidebar-thread-active") === "true"
        ) {
          return true;
        }
      }
      return false;
    };
    const confirmActiveThread = async () => {
      const timeoutMs = Number.isFinite(payload.confirmMs) ? payload.confirmMs : 2500;
      const deadline = Date.now() + Math.max(0, timeoutMs);
      do {
        if (targetIsActive()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (true);
    };
    // Give Codex's acknowledged-but-asynchronous history/resume work time to
    // hydrate the task, then route the selected primary renderer straight to
    // the main task surface. Navigating through /hotkey-window used to provide
    // this settling beat, but current Codex materializes that route as a second
    // compact BrowserWindow. A delayed /local route produces the same cold-load
    // result without creating another window.
    const hydrateMs = Number.isFinite(payload.hydrateMs)
      ? payload.hydrateMs
      : Number.isFinite(payload.primeMs) ? payload.primeMs : 1200;
    if (!targetIsActive() && hydrateMs > 0) await new Promise((resolve) => setTimeout(resolve, hydrateMs));
    const finalNavigation = navTo(`/local/${encoded}`);
    openConfirmed = await confirmActiveThread();
    if (finalNavigation) {
      finalNavigation.confirmed = openConfirmed;
      finalNavigation.ok = openConfirmed;
    }
  }

  return {
    // Opening and assignment have separate recovery paths. If navigation
    // succeeded, report that visual fact even when the project write needs a
    // quiet retry; otherwise the caller fires a second codex:// open and the
    // user sees a duplicate/flicker despite already being in the task.
    ok: payload.openThreadId ? openConfirmed : sent.some((item) => item.ok),
    projectAssignmentOk,
    openConfirmed,
    href: location.href,
    openThreadId: payload.openThreadId || null,
    sent,
  };
}

// Runs INSIDE the selected primary Codex renderer (same serialization contract
// as relayRefreshCodexRenderer: self-contained, renderer globals only). Starts
// a REAL turn in an existing thread — the "Open in current chat" live tier:
//   1. ensure-conversation-history-loaded (best-effort tail hydration),
//   2. maybe-resume-conversation — activates + resumes the thread in this
//      window and returns { activeTurnId }: non-null means a turn is RUNNING,
//      in which case we bail out rather than colliding with the user's work
//      (the caller queues behind idle or falls back to the automation tier),
//   3. start-turn-for-host with app-server TurnStartParams
//      ({ input: [{ type: "text", text, text_elements: [] }] }; thread settings
//      are inherited from the conversation) — verified against the desktop
//      bundle: this is the plain submit handler with NO thread-follower-owner
//      assertion. thread-follower-submit-user-input is NOT a submit — it
//      answers an item/tool/requestUserInput prompt.
//   4. navigate the main window directly to the thread. Never prime through
//      `/hotkey-window`: current ChatGPT builds materialize that route as a
//      second compact BrowserWindow, leaving both it and the main task open.
// The turn/start envelope the app sends for its own composer. SECURITY: the
// sandbox and approval policy MUST ride the turn params. A thread created with
// sandbox "workspace-write" does not keep it across a resume — the app falls
// back to ~/.codex/config.toml, which on a developer's machine is routinely
// approval_policy = "never" / sandbox_mode = "danger-full-access". A relay
// carries text written by SOMEONE ELSE, so an unsandboxed, unapproved run on
// that text is exactly the thing we must never ship.
export function codexTurnStartMessage({ threadId, text, payload = {} }) {
  const uuid = () =>
    (globalThis.crypto && globalThis.crypto.randomUUID && globalThis.crypto.randomUUID()) ||
    `relay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const params = {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    // Bypass, for the same reason as the Claude lane: the human read the request
    // and pressed Start — that IS the consent gate. on-request made the agent
    // stop at a prompt raised inside the Codex app, invisible to the reader
    // watching the run in the pill, and the run simply hung (David, live).
    approvalPolicy: payload.approvalPolicy || "never",
    // The app-server's OWN shape, read from its logs: {"type":"workspaceWrite",
    // "networkAccess":false,...}. Sending {mode:"workspace-write"} is rejected
    // outright — `Invalid request: missing field \`type\`` (-32600) — and the
    // bridge is fire-and-forget, so the rejection is INVISIBLE to us: the turn
    // simply never happens and the page says "working" forever. This one wrong
    // key is why every Codex request hung (David, live).
    // Matches what the user's OWN sessions get from ~/.codex/config.toml, which
    // is the stated bar: a Relay-started run should behave exactly like one they
    // started themselves in the app.
    sandboxPolicy: payload.sandboxPolicy || { type: "dangerFullAccess" },
    clientUserMessageId: payload.clientUserMessageId || uuid(),
  };
  if (payload.approvalsReviewer) params.approvalsReviewer = payload.approvalsReviewer;
  if (payload.cwd) params.cwd = payload.cwd;
  // The model is not optional in practice: the account's default-model bucket
  // can be exhausted while another model's is untouched, and an omitted model
  // fails the whole turn with usageLimitExceeded.
  if (payload.model) params.model = payload.model;
  if (payload.effort) params.effort = payload.effort;
  return {
    type: "mcp-request",
    hostId: "local",
    priority: "interactive",
    source: "relay",
    timeoutMs: 600000,
    request: { id: payload.requestId || uuid(), method: "turn/start", params },
  };
}

// Ownership of a just-resumed thread takes ~7s to settle, and a turn/start
// fired before then silently no-ops. The bridge is fire-and-forget so there is
// no error to read — the caller re-fires this until the rollout actually grows.
export async function relayFireCodexTurnRenderer(payload) {
  const bridge = window.electronBridge;
  if (!bridge?.sendMessageFromView) return { ok: false, reason: "missing-electron-bridge" };
  const threadId = String(payload.threadId || "").trim();
  const text = String(payload.text || "");
  if (!threadId || !text.trim()) return { ok: false, reason: "missing-thread-or-text" };
  try {
    await bridge.sendMessageFromView(codexTurnStartMessage({ threadId, text, payload }));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

export async function relaySubmitCodexRenderer(payload) {
  const hostId = "local";
  const bridge = window.electronBridge;
  if (!bridge?.sendMessageFromView) return { ok: false, reason: "missing-electron-bridge" };

  const steps = [];
  // Unlike the refresh path (fire-and-forget with per-send timeouts), a submit
  // must know whether each step LANDED: a hung or thrown send fails the tier so
  // the caller can fall back to the automation tier instead of losing the open.
  async function send(message, timeoutMs = 4000) {
    const value = await Promise.race([
      bridge.sendMessageFromView(message),
      new Promise((_, reject) => setTimeout(() => {
        const error = new Error("send-timeout");
        error.code = "RELAY_BRIDGE_TIMEOUT";
        reject(error);
      }, timeoutMs)),
    ]);
    steps.push({ type: message.type, ok: true });
    return value;
  }
  const fail = (type, error) => steps.push({ type, ok: false, error: String(error?.message || error) });

  const threadId = String(payload.threadId || "").trim();
  const text = String(payload.text || "");
  if (!threadId || !text.trim()) return { ok: false, reason: "missing-thread-or-text", steps };

  // The app serves a STALE in-memory view of a thread another writer touched
  // (the forge writes the rollout from outside), so drop its cache before
  // asking it to resume — otherwise it resumes the version it already had.
  try {
    await send({ type: "discard-conversation-from-cache", conversationId: threadId });
  } catch (error) {
    fail("discard-conversation-from-cache", error); // best-effort
  }
  try {
    await send({ type: "ensure-conversation-history-loaded", conversationId: threadId, dependentConversationIds: [] });
  } catch (error) {
    fail("ensure-conversation-history-loaded", error); // feature-gated in-app; a miss is not fatal
  }

  let resume;
  try {
    resume = await send(
      {
        type: "maybe-resume-conversation",
        hostId,
        conversationId: threadId,
        model: null,
        serviceTier: null,
        reasoningEffort: null,
        workspaceRoots: [],
        collaborationMode: null,
      },
      6000,
    );
  } catch (error) {
    fail("maybe-resume-conversation", error);
    return { ok: false, reason: "resume-failed", steps };
  }
  const activeTurnId = resume && typeof resume === "object" ? (resume.activeTurnId ?? null) : null;
  if (activeTurnId) return { ok: false, reason: "turn-in-progress", activeTurnId, steps };

  // Observed live: bridge sends ACK immediately (fire-and-forget) while the
  // resume completes asynchronously against the app's own app-server. An
  // immediate start-turn races that resume ("Conversation is not being
  // streamed") and silently no-ops. Put the resumed task on the primary
  // `/local` route, then give ownership the same bounded settling beat without
  // ever creating ChatGPT's auxiliary hotkey window.
  const encodedEarly = encodeURIComponent(threadId);
  try {
    window.postMessage({ type: "navigate-to-route", path: `/local/${encodedEarly}` }, location.origin);
    steps.push({ type: "navigate-to-route", ok: true, path: `/local/${encodedEarly}` });
  } catch (error) {
    fail("navigate-to-route", error);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const settleMs = Number.isFinite(payload.settleMs) ? payload.settleMs : 1200;
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

  // start-turn-for-host is DEAD in this build (ChatGPT 151.0.7922.76 / codex
  // 0.145.0): it acks, and then nothing happens — no rollout growth, no DOM
  // change, not a line in the app's own logs, even with this window confirmed
  // as stream owner. Tasks "started" on Codex for weeks and never ran.
  //
  // What the app itself does when a human presses send is a generic RPC
  // envelope to its OWN embedded app-server (a stdio child with no socket, so
  // this bridge is the only way in). turn/start is the real method, and it is
  // asynchronous: it returns inProgress and completes later.
  try {
    const startTurnTimeoutMs = Number.isFinite(payload.startTurnTimeoutMs) ? payload.startTurnTimeoutMs : 8000;
    await send(codexTurnStartMessage({ threadId, text, payload }), startTurnTimeoutMs);
  } catch (error) {
    fail("mcp-request:turn/start", error);
    const deliveryAmbiguous = error?.code === "RELAY_BRIDGE_TIMEOUT";
    return {
      ok: false,
      reason: deliveryAmbiguous ? "start-turn-unconfirmed" : "start-turn-failed",
      deliveryAmbiguous,
      steps,
    };
  }

  const encoded = encodeURIComponent(threadId);
  const navPath = `/local/${encoded}`;
  try {
    // Already navigated before the turn; re-assert so the run is on screen.
    window.postMessage({ type: "navigate-to-route", path: navPath }, location.origin);
    steps.push({ type: "navigate-to-route", ok: true, path: navPath });
  } catch (error) {
    fail("navigate-to-route", error); // the turn landed; visibility is best-effort
  }
  return { ok: true, threadId, steps };
}

// ChatGPT runs several renderer surfaces in separate BrowserWindows. Their
// URLs all point at index.html, but auxiliary surfaces declare their router
// entry point through an encoded `initialRoute` query parameter, for example:
//
//   app://-/index.html?initialRoute=%2Favatar-overlay
//   app://-/index.html?initialRoute=%2Fhotkey-window
//   app://-/index.html?initialRoute=%2Fglobal-dictation
//   app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat
//
// Sending Relay's navigation expression to either window mirrors the opened
// thread in the compact overlay. Keep this function self-contained because its
// source is embedded into the Electron main-process inspector expression below.
export function classifyCodexDesktopWindowUrl(url) {
  const raw = String(url || "").trim();
  const candidates = [];
  const decode = (value) => {
    let decoded = String(value || "");
    // URLSearchParams decodes once. A bounded second pass also handles app
    // builds which hand an already-encoded route to the window manager.
    for (let index = 0; index < 3; index += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return decoded;
  };

  try {
    const parsed = new URL(raw);
    candidates.push(parsed.pathname, parsed.hash, parsed.searchParams.get("initialRoute"));
  } catch {
    candidates.push(raw);
  }

  for (const candidate of candidates) {
    const route = decode(candidate).trim().replace(/^#/, "");
    // Keep this list aligned with ChatGPT's non-primary window appearances. In
    // addition to the two user-visible overlays, current builds create separate
    // renderer windows for dictation, quick chat/prewarming, and internal debug
    // tooling. Running Relay's route expression in any of them either mirrors the
    // conversation into a compact surface or corrupts that surface's own route.
    if (
      /^\/(?:avatar-overlay|hotkey-window|global-dictation|debug)(?:[/?#-]|$)/i.test(route) ||
      /^\/chatgpt\/quick-chat(?:-prewarm)?(?:[/?#-]|$)/i.test(route)
    ) {
      return "auxiliary";
    }
  }
  return "primary";
}

export function buildCodexDesktopRefreshExpression({
  threadIds = [],
  pinnedThreadIds = null,
  openThreadId = null,
  workspaceRootsByThreadId = null,
  ensureWorkspaceRoot = null,
  assignmentOnly = false,
  primeOpen = true,
} = {}) {
  const rendererCode = `(${relayRefreshCodexRenderer.toString()})(${JSON.stringify({
    threadIds: uniqueStrings(threadIds),
    pinnedThreadIds,
    openThreadId: String(openThreadId || "").trim() || null,
    workspaceRootsByThreadId:
      workspaceRootsByThreadId && typeof workspaceRootsByThreadId === "object" ? workspaceRootsByThreadId : {},
    ensureWorkspaceRoot: String(ensureWorkspaceRoot || "").trim() || null,
    assignmentOnly: assignmentOnly === true,
    primeOpen: primeOpen !== false,
    primeMs: Number(process.env.RELAY_CODEX_OPEN_PRIME_MS) || 1200,
    confirmMs: Number(process.env.RELAY_CODEX_OPEN_CONFIRM_MS) || 2500,
  })})`;
  // Only bring a window forward when we're actually opening a thread.
  const wantsFocus = Boolean(String(openThreadId || "").trim());
  return buildPrimaryWindowExpression({ rendererCode, wantsFocus });
}

// The live-injection expression: run relaySubmitCodexRenderer in the selected
// primary window, then focus it so the user watches the instruction land.
export function buildCodexDesktopSubmitExpression({ threadId, text, model, effort, cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, clientUserMessageId, requestId, wantsFocus = true } = {}) {
  const payload = {
    threadId: String(threadId || "").trim(),
    text: String(text || ""),
    settleMs: Number(process.env.RELAY_CODEX_SUBMIT_SETTLE_MS) || 1200,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(cwd ? { cwd } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    ...(requestId ? { requestId } : {}),
  };
  // These functions are shipped by STRINGIFYING them into the renderer, so a
  // module-scope helper is not in scope there — it has to travel with them.
  const rendererCode = `(() => { const codexTurnStartMessage = ${codexTurnStartMessage.toString()};
    return (${relaySubmitCodexRenderer.toString()})(${JSON.stringify(payload)}); })()`;
  return buildPrimaryWindowExpression({ rendererCode, wantsFocus: wantsFocus !== false });
}

/**
 * A retry fire, with no resume or navigation: the thread is already open and
 * the only question is whether ownership has settled yet. Cheap enough to
 * repeat every few seconds until the rollout grows.
 */
export function buildCodexDesktopRetryExpression(options = {}) {
  return buildCodexDesktopSubmitExpression({ ...options, wantsFocus: false });
}

// Shared main-process shell: pick exactly one primary ChatGPT window (focused,
// else visible, else first live), run `rendererCode` in it, optionally raise
// it. Serialized into the Electron main process via the inspector.
function buildPrimaryWindowExpression({ rendererCode, wantsFocus }) {
  return `(async () => {
    const req = process.mainModule?.require || process.getBuiltinModule("module").createRequire(process.cwd() + "/");
    const { BrowserWindow } = req("electron");
    const code = ${JSON.stringify(rendererCode)};
    const wantsFocus = ${JSON.stringify(wantsFocus)};
    const classifyWindowUrl = ${classifyCodexDesktopWindowUrl.toString()};
    const windows = [];
    const primaryCandidates = [];
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        const url = win.webContents.getURL();
        const kind = classifyWindowUrl(url);
        if (kind === "auxiliary") {
          windows.push({ id: win.id, url, kind, skipped: true, reason: "auxiliary-window" });
          continue;
        }
        primaryCandidates.push({ win, url });
      } catch (error) {
        windows.push({ id: win.id, ok: false, error: String(error?.message || error) });
      }
    }

    // ChatGPT can retain more than one primary-capable window. Route exactly one:
    // prefer the focused window, then a visible window, then the first live one.
    // This prevents a Relay open from being mirrored into any secondary surface.
    const primary = primaryCandidates.find(({ win }) => {
      try { return win.isFocused(); } catch { return false; }
    }) || primaryCandidates.find(({ win }) => {
      try { return win.isVisible(); } catch { return false; }
    }) || primaryCandidates[0] || null;

    for (const candidate of primaryCandidates) {
      if (candidate === primary) continue;
      windows.push({
        id: candidate.win.id,
        url: candidate.url,
        kind: "primary",
        skipped: true,
        reason: "not-selected-primary-window",
      });
    }

    if (primary) {
      const { win, url } = primary;
      try {
        const result = await win.webContents.executeJavaScript(code, true);
        // Bring the selected primary window forward after navigating it to the
        // thread, the way ChatGPT's own restoreShowAndFocusWindow does.
        if (wantsFocus) {
          try {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            await new Promise((resolve) => setTimeout(resolve, 80));
          } catch {}
        }
        windows.push({ id: win.id, visible: win.isVisible(), url, kind: "primary", focusRequested: wantsFocus, focused: win.isFocused(), result });
      } catch (error) {
        windows.push({ id: win.id, url, kind: "primary", ok: false, error: String(error?.message || error) });
      }
    }
    return windows;
  })()`;
}

async function findCodexMainPids(platform = process.platform) {
  try {
    if (platform === "win32") {
      const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ], { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true });
      return windowsCodexMainPids(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], { timeout: 1500, maxBuffer: 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter(Boolean)
      .filter((match) => isCodexMainCommand(match[2]))
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

export function windowsCodexMainPids(source) {
  let value;
  try { value = JSON.parse(String(source || "")); } catch { return []; }
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => entry && isCodexMainCommand(entry.CommandLine))
    .map((entry) => Number(entry.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function isCodexMainCommand(command) {
  const value = String(command || "");
  if (CODEX_MAIN_PATHS.some((mainPath) => value === mainPath || value.startsWith(`${mainPath} `))) return true;
  if (/(?:^|\s)--type(?:=|\s)/i.test(value)) return false;
  // The Windows Store package has a versioned directory. Restrict the match to
  // Codex's package so an unrelated ChatGPT install or a renderer is not driven.
  return /^"?[A-Z]:\\[^"\r\n]*\\WindowsApps\\OpenAI\.Codex_[^\\"\r\n]+\\app\\(?:ChatGPT|Codex)\.exe"?(?:\s|$)/i.test(value);
}

export function startCodexInspector(pid, {
  platform = process.platform,
  debugProcess = process._debugProcess,
  kill = process.kill,
} = {}) {
  try {
    // SIGUSR1 is not available on Windows. Node's Windows debug trigger opens
    // the same loopback inspector on the running Electron main process.
    if (platform === "win32") {
      if (typeof debugProcess !== "function") return false;
      debugProcess(pid);
    } else {
      kill(pid, "SIGUSR1");
    }
    return true;
  } catch {
    return false;
  }
}

async function findOrStartInspectorForPid(pid, { timeoutMs, platform = process.platform }) {
  let target = await findInspectorTargetForPid(pid);
  if (target) return target;

  if (!startCodexInspector(pid, { platform })) return null;

  const deadline = Date.now() + Math.max(500, timeoutMs);
  do {
    await sleep(100);
    target = await findInspectorTargetForPid(pid);
    if (target) return target;
  } while (Date.now() < deadline);
  return null;
}

async function findInspectorTargetForPid(pid) {
  for (const port of INSPECTOR_PORTS) {
    const targets = await listInspectorTargets(port);
    for (const target of targets) {
      if (!target.webSocketDebuggerUrl) continue;
      try {
        const value = await evaluateInspectorExpression(target.webSocketDebuggerUrl, "process.pid", { timeoutMs: 800 });
        if (value === pid) return target;
      } catch {
        // Try the next inspector target.
      }
    }
  }
  return null;
}

function listInspectorTargets(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: INSPECTOR_HOST, port, path: "/json/list", timeout: 300 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.on("error", () => resolve([]));
  });
}

async function evaluateInspectorExpression(webSocketDebuggerUrl, expression, { timeoutMs = 4000 } = {}) {
  const WebSocketImpl = await resolveWebSocketImpl();
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("Timed out talking to Codex inspector"));
    }, timeoutMs);
    const pending = new Map();
    let nextId = 1;

    ws.onopen = () => {
      const id = nextId++;
      pending.set(id, (message) => {
        if (message.exceptionDetails) {
          reject(new Error(message.exceptionDetails.text || message.result?.result?.description || "Inspector evaluation failed"));
          return;
        }
        resolve(message.result?.result?.value);
      });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    };
    ws.onerror = () => reject(new Error("Failed to connect to Codex inspector"));
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      handler(message);
    };
  });
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
