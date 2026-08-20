import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  relayRefreshCodexRenderer,
  relaySubmitCodexRenderer,
  buildCodexDesktopRefreshExpression,
  buildCodexDesktopRetryExpression,
  buildCodexDesktopSubmitExpression,
  classifyCodexDesktopWindowUrl,
  codexRolloutHasClientMessage,
  codexTurnStartMessage,
  isCodexMainCommand,
  primarySubmitRendererResult,
  primaryWindowRan,
  submitTurnToCodexDesktopThread,
} from "../src/codex-desktop.js";

// relayRefreshCodexRenderer runs in the Codex page context and reaches for the
// renderer globals `window` and `location`. Install fakes on globalThis so bare
// references resolve, capture what it posts, then restore. `href`/`search` decide
// whether the code treats this as the hotkey window vs the main window.
async function withRendererGlobals({ href = "app://-/index.html", search = "", origin = "app://-", activeThreadId = null }, fn) {
  const sent = [];
  const posted = [];
  const prevWindow = globalThis.window;
  const prevLocation = globalThis.location;
  globalThis.window = {
    document: {
      querySelectorAll: () => activeThreadId
        ? [{ getAttribute: (name) => name === "data-app-action-sidebar-thread-id" ? activeThreadId : name === "data-app-action-sidebar-thread-active" ? "true" : null }]
        : [],
    },
    electronBridge: {
      sendMessageFromView: async (message) => {
        sent.push(message);
      },
    },
    postMessage: (msg, targetOrigin) => {
      posted.push({ msg, targetOrigin });
    },
  };
  globalThis.location = { href, search, origin, pathname: "/index.html" };
  try {
    return await fn({ sent, posted });
  } finally {
    globalThis.window = prevWindow;
    globalThis.location = prevLocation;
  }
}

const navPaths = (posted) => posted.filter((p) => p.msg.type === "navigate-to-route").map((p) => p.msg.path);

function fakeBrowserWindow({
  id,
  url,
  visible = true,
  focused = false,
  focusSucceeds = true,
  minimized = false,
  executeJavaScript,
}) {
  const calls = { execute: [], restore: 0, show: 0, focus: 0 };
  let focusedState = focused;
  return {
    id,
    calls,
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focusedState,
    isMinimized: () => minimized,
    restore: () => {
      calls.restore += 1;
    },
    show: () => {
      calls.show += 1;
    },
    focus: () => {
      calls.focus += 1;
      if (focusSucceeds) focusedState = true;
    },
    webContents: {
      getURL: () => url,
      executeJavaScript: async (code, userGesture) => {
        calls.execute.push({ code, userGesture });
        return executeJavaScript ? executeJavaScript(code, userGesture) : { ok: true };
      },
    },
  };
}

async function runDesktopExpression(options, browserWindows) {
  const electron = { BrowserWindow: { getAllWindows: () => browserWindows } };
  const fakeProcess = {
    mainModule: { require: (name) => (name === "electron" ? electron : null) },
    cwd: () => "/tmp",
  };
  const expression = buildCodexDesktopRefreshExpression(options);
  return Function("process", `return ${expression}`)(fakeProcess);
}

function runRendererExpression(code, { posted, activeThreadId = null }) {
  const rendererWindow = {
    document: {
      querySelectorAll: () => activeThreadId
        ? [{ getAttribute: (name) => name === "data-app-action-sidebar-thread-id" ? activeThreadId : name === "data-app-action-sidebar-thread-active" ? "true" : null }]
        : [],
    },
    electronBridge: { sendMessageFromView: async () => {} },
    postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }),
  };
  const rendererLocation = { href: "app://-/index.html", search: "", origin: "app://-", pathname: "/index.html" };
  return Function("window", "location", `return ${code}`)(rendererWindow, rendererLocation);
}

test("main-window open primes via the hotkey route, then switches to /local", async () => {
  await withRendererGlobals({ activeThreadId: "thread_abc" }, async ({ posted }) => {
    const result = await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "thread_abc", primeMs: 0 });
    assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/thread_abc", "/local/thread_abc"]);
    assert.ok(result.sent.some((s) => s.type === "navigate-to-route" && s.path === "/local/thread_abc" && s.ok));
  });
});

test("second pass (primeOpen=false) navigates straight to /local, no hotkey bounce", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "thread_abc", primeOpen: false, primeMs: 0, confirmMs: 0 });
    assert.deepEqual(navPaths(posted), ["/local/thread_abc"]);
  });
});

test("an accepted navigation postMessage is not a confirmed route change", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    // This fake accepts postMessage exactly as a browser does, but deliberately
    // has no router listener. The requested route therefore never becomes the
    // active route. Merely returning from postMessage must not be reported as a
    // successful open, because that suppresses the codex:// fallback.
    const activeRoute = "/local/original";
    const result = await relayRefreshCodexRenderer({
      threadIds: [],
      openThreadId: "thread_abc",
      primeOpen: false,
      primeMs: 0,
      confirmMs: 0,
    });

    assert.deepEqual(navPaths(posted), ["/local/thread_abc"], "the navigation request was posted");
    assert.equal(activeRoute, "/local/original", "the renderer route did not change");
    const navigation = result.sent.find((item) => item.type === "navigate-to-route");
    assert.equal(navigation?.ok, false, "an unconfirmed post must not claim that navigation succeeded");
  });
});

test("inside the hotkey window, opens the hotkey thread route only", async () => {
  await withRendererGlobals({ href: "app://-/index.html?initialRoute=%2Fhotkey-window", search: "?initialRoute=%2Fhotkey-window" }, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "thread_abc", primeMs: 0, confirmMs: 0 });
    assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/thread_abc"]);
  });
});

test("thread ids with unsafe characters are encoded into both routes", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "a/b c", primeMs: 0, confirmMs: 0 });
    assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/a%2Fb%20c", "/local/a%2Fb%20c"]);
  });
});

test("does not navigate when no thread is being opened", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: ["t1"], openThreadId: null, primeMs: 0 });
    assert.equal(navPaths(posted).length, 0);
  });
});

test("a hung bridge send does not block the navigation", async () => {
  const prevWindow = globalThis.window;
  const prevLocation = globalThis.location;
  const posted = [];
  globalThis.window = {
    electronBridge: { sendMessageFromView: () => new Promise(() => {}) }, // never resolves
    postMessage: (msg) => posted.push(msg),
  };
  globalThis.location = { href: "app://-/index.html", search: "", origin: "app://-", pathname: "/index.html" };
  try {
    // send timeout is 2000ms; give the test room. Navigation must still happen.
    await relayRefreshCodexRenderer({ threadIds: ["t1"], openThreadId: "t1", primeMs: 0, confirmMs: 0 });
    const paths = posted.filter((m) => m.type === "navigate-to-route").map((m) => m.path);
    assert.deepEqual(paths, ["/hotkey-window/thread/t1", "/local/t1"]);
  } finally {
    globalThis.window = prevWindow;
    globalThis.location = prevLocation;
  }
});

test("returns missing-electron-bridge when the bridge is unavailable", async () => {
  await withRendererGlobals({}, async () => {
    globalThis.window = {}; // no electronBridge
    const result = await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "t1", primeMs: 0 });
    assert.deepEqual(result, { ok: false, reason: "missing-electron-bridge" });
  });
});

test("desktop expression routes and focuses only the primary ChatGPT window", async () => {
  const posted = [];
  const avatar = fakeBrowserWindow({
    id: 10,
    url: "app://-/index.html?initialRoute=%2Favatar-overlay",
    focused: true,
  });
  const hotkey = fakeBrowserWindow({
    id: 11,
    url: "app://-/index.html?initialRoute=%2Fhotkey-window",
    visible: false,
  });
  const primary = fakeBrowserWindow({
    id: 12,
    url: "app://-/index.html",
    minimized: true,
    executeJavaScript: (code) => runRendererExpression(code, { posted, activeThreadId: "thread_abc" }),
  });

  const result = await runDesktopExpression({ threadIds: [], openThreadId: "thread_abc" }, [avatar, hotkey, primary]);

  assert.equal(avatar.calls.execute.length, 0);
  assert.equal(hotkey.calls.execute.length, 0);
  assert.equal(primary.calls.execute.length, 1);
  assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/thread_abc", "/local/thread_abc"]);
  assert.deepEqual(
    { restore: primary.calls.restore, show: primary.calls.show, focus: primary.calls.focus },
    { restore: 1, show: 1, focus: 1 },
  );
  assert.deepEqual(
    { avatarShow: avatar.calls.show, avatarFocus: avatar.calls.focus, hotkeyShow: hotkey.calls.show, hotkeyFocus: hotkey.calls.focus },
    { avatarShow: 0, avatarFocus: 0, hotkeyShow: 0, hotkeyFocus: 0 },
  );
  assert.equal(result.find((entry) => entry.id === 10)?.reason, "auxiliary-window");
  assert.equal(result.find((entry) => entry.id === 11)?.reason, "auxiliary-window");
  assert.equal(result.find((entry) => entry.id === 12)?.focused, true);
});

test("calling focus is not success when the selected window remains unfocused", async () => {
  const primary = fakeBrowserWindow({
    id: 13,
    url: "app://-/index.html",
    focused: false,
    // Record focus() but leave isFocused() false, reproducing macOS refusing or
    // immediately losing the focus request.
    focusSucceeds: false,
  });

  const value = await runDesktopExpression(
    { threadIds: [], openThreadId: "thread_abc", primeOpen: false },
    [primary],
  );
  const selected = value.find((entry) => entry.id === 13);

  assert.deepEqual(
    {
      focusCalls: primary.calls.focus,
      actuallyFocused: primary.isFocused(),
      reportedFocused: selected?.focused,
    },
    { focusCalls: 1, actuallyFocused: false, reportedFocused: false },
    "the bridge must report observed focus state, not that focus() returned",
  );
  assert.equal(
    primaryWindowRan({ pid: 13, ok: true, value }),
    false,
    "an open that did not focus the selected window must leave fallback enabled",
  );
});

test("refresh-only expression skips auxiliary windows without focusing the primary", async () => {
  const primary = fakeBrowserWindow({ id: 20, url: "app://-/index.html" });
  const avatar = fakeBrowserWindow({ id: 21, url: "app://-/index.html?initialRoute=%252Favatar-overlay" });

  await runDesktopExpression({ threadIds: ["t1"] }, [avatar, primary]);

  assert.equal(primary.calls.execute.length, 1);
  assert.deepEqual({ show: primary.calls.show, focus: primary.calls.focus }, { show: 0, focus: 0 });
  assert.equal(avatar.calls.execute.length, 0);
});

test("when several primary-capable windows exist, only the focused one is routed", async () => {
  const backgroundPrimary = fakeBrowserWindow({ id: 30, url: "app://-/index.html", visible: true });
  const focusedPrimary = fakeBrowserWindow({ id: 31, url: "app://-/index.html?initialRoute=%2Flocal%2Ft1", focused: true });

  const result = await runDesktopExpression({ threadIds: ["t1"], openThreadId: "t1", primeOpen: false }, [backgroundPrimary, focusedPrimary]);

  assert.equal(backgroundPrimary.calls.execute.length, 0);
  assert.equal(focusedPrimary.calls.execute.length, 1);
  assert.equal(result.find((entry) => entry.id === 30)?.reason, "not-selected-primary-window");
  assert.equal(result.find((entry) => entry.id === 31)?.focused, true);
});

test("window URL classification decodes auxiliary initial routes without rejecting main routes", () => {
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Favatar-overlay"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%252Fhotkey-window%252Fthread%252Ft1"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/hotkey-window"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/avatar-overlay-composition-surface.html"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Fglobal-dictation"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Fdebug"), "auxiliary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html"), "primary");
  assert.equal(classifyCodexDesktopWindowUrl("app://-/index.html?initialRoute=%2Flocal%2Ft1"), "primary");
});

test("Codex process detection supports the current ChatGPT app and legacy Codex app", () => {
  assert.equal(isCodexMainCommand("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"), true);
  assert.equal(isCodexMainCommand("/Applications/Codex.app/Contents/MacOS/Codex"), true);
  assert.equal(isCodexMainCommand("/Applications/Claude.app/Contents/MacOS/Claude"), false);
});

// ---- Open-in-current-chat submit renderer -----------------------------------

// Like withRendererGlobals, but the fake bridge can ANSWER messages — the
// submit path reads maybe-resume-conversation's { activeTurnId } return value.
async function withSubmitGlobals({ respond = () => undefined, href = "app://-/index.html", search = "" }, fn) {
  const sent = [];
  const posted = [];
  const prevWindow = globalThis.window;
  const prevLocation = globalThis.location;
  globalThis.window = {
    electronBridge: {
      sendMessageFromView: async (message) => {
        sent.push(message);
        return respond(message);
      },
    },
    postMessage: (msg, targetOrigin) => {
      posted.push({ msg, targetOrigin });
    },
  };
  globalThis.location = { href, search, origin: "app://-", pathname: "/index.html" };
  try {
    return await fn({ sent, posted });
  } finally {
    globalThis.window = prevWindow;
    globalThis.location = prevLocation;
  }
}

test("submit renderer resumes the thread, starts a turn with TurnStartParams input, then navigates /local", async () => {
  await withSubmitGlobals(
    { respond: (m) => (m.type === "maybe-resume-conversation" ? { activeTurnId: null, threadSource: "user" } : { ok: true }) },
    async ({ sent, posted }) => {
      const result = await relaySubmitCodexRenderer({ threadId: "thread_abc", text: "open relay r1", settleMs: 0 });
      assert.equal(result.ok, true);
      // The proven order: drop the app's stale cache, hydrate, resume, put the
      // thread ON SCREEN, and only then fire — a turn aimed at a window that is
      // not showing the thread is silently dropped.
      assert.deepEqual(
        sent.map((m) => m.type),
        ["discard-conversation-from-cache", "ensure-conversation-history-loaded", "maybe-resume-conversation", "mcp-request"],
      );
      // start-turn-for-host acks and does nothing in this build — it is the
      // reason Codex requests "started" and never ran. The app's own composer
      // sends turn/start through the generic mcp-request envelope instead.
      const start = sent.find((m) => m.type === "mcp-request");
      assert.equal(start.hostId, "local");
      assert.equal(start.request.method, "turn/start");
      assert.equal(start.request.params.threadId, "thread_abc");
      assert.deepEqual(start.request.params.input, [{ type: "text", text: "open relay r1", text_elements: [] }]);
      // SECURITY: a relay carries someone else's words. The sandbox and
      // approval policy must ride the TURN, because a resumed thread otherwise
      // inherits ~/.codex/config.toml — routinely danger-full-access.
      assert.equal(start.request.params.approvalPolicy, "never");
      // The app-server's own shape. {mode:"workspace-write"} is rejected -32600
  // "missing field `type`", and because the bridge is fire-and-forget that
  // rejection is invisible — the turn never runs and the page hangs.
  assert.deepEqual(start.request.params.sandboxPolicy, { type: "dangerFullAccess" });
      // The thread is primed into the hotkey route, dropped onto /local so the
      // window is showing it BEFORE the turn fires, then re-asserted after.
      assert.deepEqual(navPaths(posted), [
        "/hotkey-window/thread/thread_abc",
        "/local/thread_abc",
        "/local/thread_abc",
      ]);
    },
  );
});

test("submit renderer bails out when maybe-resume reports an active turn (never collides with a running turn)", async () => {
  await withSubmitGlobals(
    { respond: (m) => (m.type === "maybe-resume-conversation" ? { activeTurnId: "turn-42" } : undefined) },
    async ({ sent, posted }) => {
      const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
      assert.deepEqual(
        { ok: result.ok, reason: result.reason, activeTurnId: result.activeTurnId },
        { ok: false, reason: "turn-in-progress", activeTurnId: "turn-42" },
      );
      assert.ok(!sent.some((m) => m.type === "mcp-request"), "no submit into a busy thread");
      assert.equal(navPaths(posted).length, 0);
    },
  );
});

test("submit renderer fails cleanly when the turn is rejected (the thread is on screen either way)", async () => {
  await withSubmitGlobals(
    {
      respond: (m) => {
        if (m.type === "mcp-request") throw new Error("assertThreadFollowerOwner");
        if (m.type === "maybe-resume-conversation") return { activeTurnId: null };
        return undefined;
      },
    },
    async ({ posted }) => {
      const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
      assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "start-turn-failed" });
      // Navigation now precedes the turn (the window must be showing the thread
      // for the turn to land), so a rejected turn still leaves it on screen —
      // which is the honest place for the reader to see nothing happened.
      assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/t1", "/local/t1"]);
    },
  );
});

test("submit renderer fails cleanly when the resume rejects", async () => {
  await withSubmitGlobals(
    {
      respond: (m) => {
        if (m.type === "maybe-resume-conversation") throw new Error("no-client-found");
        return undefined;
      },
    },
    async () => {
      const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
      assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "resume-failed" });
    },
  );
});

test("a fire-and-forget bridge (undefined returns) still submits: busy detection falls back to the rollout side", async () => {
  await withSubmitGlobals({ respond: () => undefined }, async ({ sent }) => {
    const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
    assert.equal(result.ok, true);
    assert.ok(sent.some((m) => m.type === "mcp-request" && m.request.method === "turn/start"));
  });
});

test("submit renderer inside the hotkey window navigates the hotkey thread route", async () => {
  await withSubmitGlobals(
    {
      respond: (m) => (m.type === "maybe-resume-conversation" ? { activeTurnId: null } : undefined),
      href: "app://-/index.html?initialRoute=%2Fhotkey-window",
      search: "?initialRoute=%2Fhotkey-window",
    },
    async ({ posted }) => {
      const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
      assert.equal(result.ok, true);
      // Already on the hotkey route: primed, never dropped to /local, then
      // re-asserted after the turn.
      assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/t1", "/hotkey-window/thread/t1"]);
    },
  );
});

test("submit renderer reports missing-electron-bridge and missing input", async () => {
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    assert.deepEqual(await relaySubmitCodexRenderer({ threadId: "t1", text: "x" }), {
      ok: false,
      reason: "missing-electron-bridge",
    });
  } finally {
    globalThis.window = prevWindow;
  }
  await withSubmitGlobals({}, async () => {
    const result = await relaySubmitCodexRenderer({ threadId: "", text: "x" });
    assert.equal(result.reason, "missing-thread-or-text");
  });
});

test("submit expression runs only in the selected primary window and focuses it", async () => {
  const posted = [];
  const hotkey = fakeBrowserWindow({ id: 40, url: "app://-/index.html?initialRoute=%2Fhotkey-window" });
  const primary = fakeBrowserWindow({
    id: 41,
    url: "app://-/index.html",
    executeJavaScript: (code) => {
      const rendererWindow = {
        electronBridge: {
          sendMessageFromView: async (message) =>
            message.type === "maybe-resume-conversation" ? { activeTurnId: null } : undefined,
        },
        postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }),
      };
      const rendererLocation = { href: "app://-/index.html", search: "", origin: "app://-", pathname: "/index.html" };
      return Function("window", "location", `return ${code}`)(rendererWindow, rendererLocation);
    },
  });
  const electron = { BrowserWindow: { getAllWindows: () => [hotkey, primary] } };
  const fakeProcess = {
    mainModule: { require: (name) => (name === "electron" ? electron : null) },
    cwd: () => "/tmp",
  };
  const expression = buildCodexDesktopSubmitExpression({ threadId: "thread_abc", text: "open relay r1" });
  const windows = await Function("process", `return ${expression}`)(fakeProcess);

  assert.equal(hotkey.calls.execute.length, 0);
  assert.equal(primary.calls.execute.length, 1);
  assert.equal(windows.find((w) => w.id === 41)?.focused, true, "submit always raises the primary window");
  assert.equal(windows.find((w) => w.id === 41)?.result?.ok, true);
  assert.deepEqual(navPaths(posted), ["/hotkey-window/thread/thread_abc", "/local/thread_abc", "/local/thread_abc"]);

  // The overlay digs the renderer verdict out of the per-pid envelope.
  const renderer = primarySubmitRendererResult([{ pid: 1, ok: true, value: windows }]);
  assert.equal(renderer.ok, true);
  assert.equal(primarySubmitRendererResult([{ pid: 1, ok: false, error: "x" }]), null);
});

test("turn retries keep one app-server identity and preserve the permission contract", () => {
  const payload = {
    threadId: "thread_abc",
    text: "do the thing",
    clientUserMessageId: "client-stable-123",
    requestId: "request-stable-123",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
  };
  const first = codexTurnStartMessage({ threadId: payload.threadId, text: payload.text, payload });
  const second = codexTurnStartMessage({ threadId: payload.threadId, text: payload.text, payload });
  assert.equal(first.request.id, "request-stable-123");
  assert.equal(second.request.id, first.request.id);
  assert.equal(first.request.params.clientUserMessageId, "client-stable-123");
  assert.equal(second.request.params.clientUserMessageId, first.request.params.clientUserMessageId);
  assert.equal(first.request.params.approvalPolicy, "on-request");
  assert.equal(first.request.params.approvalsReviewer, "guardian");
  assert.deepEqual(first.request.params.sandboxPolicy, { type: "workspaceWrite", networkAccess: false });

  const retry = buildCodexDesktopRetryExpression(payload);
  assert.match(retry, /client-stable-123/);
  assert.match(retry, /request-stable-123/);
  assert.match(retry, /workspaceWrite/);
  assert.match(retry, /guardian/);
});

test("rollout confirmation requires the exact app-server client message, not unrelated growth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-rollout-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    rollout,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: "somebody-else", message: "noise" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "unrelated-turn" } }),
    ].join("\n") + "\n",
  );
  assert.equal(codexRolloutHasClientMessage(rollout, "client-stable-123"), false);
  fs.appendFileSync(
    rollout,
    `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: "client-stable-123", message: "ours" } })}\n`,
  );
  assert.equal(codexRolloutHasClientMessage(rollout, "client-stable-123"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("submit recovers from a stale inspector on a replaced PID without duplicating the logical turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-restart-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  const pidReads = [];
  const evaluatedPids = [];
  const identities = [];
  let findCount = 0;
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_restart",
    text: "restart-safe message",
    rolloutPath: rollout,
    confirmAttempts: 3,
    confirmIntervalMs: 12,
    timeoutMs: 20,
    platform: "darwin",
    runtime: {
      findCodexMainPids: async () => {
        const pids = findCount++ === 0 ? [101] : [202];
        pidReads.push(pids);
        return pids;
      },
      evaluateAcrossCodexPids: async (pids, expression) => {
        evaluatedPids.push(pids);
        const match = expression.match(/clientUserMessageId\\?":\\?"([0-9a-f-]{36})/);
        assert.ok(match, "stable client identity is embedded in the renderer payload");
        identities.push(match[1]);
        if (pids[0] === 101) return [{ pid: 101, ok: false, error: "stale inspector socket" }];
        fs.appendFileSync(
          rollout,
          `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: match[1], message: "restart-safe message" } })}\n`,
        );
        return [{ pid: 202, ok: true, value: [{ id: 1, kind: "primary", result: { ok: true } }] }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(1, ms))),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.deepEqual(pidReads, [[101], [202]], "the retry resolves the replacement process instead of reusing PID 101");
  assert.deepEqual(evaluatedPids, [[101], [202]]);
  assert.equal(new Set(identities).size, 1, "all renderer attempts use the same idempotency identity");
  assert.equal(result.clientUserMessageId, identities[0]);
  assert.equal(result.submitted, true);
  assert.equal(result.ran, true);
  assert.equal(result.turnAttempts, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unrelated rollout activity never turns a failed Codex submission into success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-noise-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  let calls = 0;
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_noise",
    text: "our message",
    rolloutPath: rollout,
    confirmAttempts: 2,
    confirmIntervalMs: 10,
    timeoutMs: 20,
    platform: "darwin",
    runtime: {
      findCodexMainPids: async () => [303],
      evaluateAcrossCodexPids: async () => {
        calls += 1;
        fs.appendFileSync(
          rollout,
          `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: `unrelated-${calls}` } })}\n`,
        );
        return [{ pid: 303, ok: true, value: [{ id: 1, kind: "primary", result: { ok: true } }] }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(1, ms))),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.submitted, true, "the bridge did acknowledge the envelope");
  assert.equal(result.ran, false, "no matching user_message means the turn did not start");
  fs.rmSync(dir, { recursive: true, force: true });
});

// COLD START readiness. `ok` on the per-pid envelope only reports that the
// inspector evaluation succeeded, which is equally true of a just-launched app
// whose window list is still empty and of an app the user left running with every
// window closed. Both used to score as a successful open, which suppressed the
// codex:// fallback and showed the user nothing.
test("a driven primary window counts as reached", () => {
  const entry = { pid: 1, ok: true, value: [{ id: 1, kind: "primary", result: { ok: true, sent: [] } }] };
  assert.equal(primaryWindowRan(entry), true);
});

test("an app with NO window yet (cold boot) is not reached, however happy the inspector was", () => {
  assert.equal(primaryWindowRan({ pid: 1, ok: true, value: [] }), false);
});

test("only auxiliary/skipped windows is not reached — a mirrored overlay is not the open", () => {
  const entry = {
    pid: 1,
    ok: true,
    value: [
      { id: 2, kind: "auxiliary", skipped: true, reason: "auxiliary-window" },
      { id: 3, kind: "primary", skipped: true, reason: "not-selected-primary-window" },
    ],
  };
  assert.equal(primaryWindowRan(entry), false);
});

test("a primary window that threw is not reached", () => {
  const entry = { pid: 1, ok: true, value: [{ id: 1, kind: "primary", ok: false, error: "boom" }] };
  assert.equal(primaryWindowRan(entry), false);
});

test("an inspector failure is not reached", () => {
  assert.equal(primaryWindowRan({ pid: 1, ok: false, reason: "inspector-unavailable" }), false);
  assert.equal(primaryWindowRan(null), false);
});
