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
  enqueueCodexProjectMutation,
  isCodexMainCommand,
  primarySubmitRendererResult,
  primaryWindowRan,
  startCodexInspector,
  submitTurnToCodexDesktopThread,
  windowsCodexMainPids,
} from "../src/codex-desktop.js";

// relayRefreshCodexRenderer runs in the Codex page context and reaches for the
// renderer globals `window` and `location`. Install fakes on globalThis so bare
// references resolve, capture what it posts, then restore. `href`/`search` decide
// whether the code treats this as the hotkey window vs the main window.
async function withRendererGlobals(
  {
    href = "app://-/index.html",
    search = "",
    origin = "app://-",
    activeThreadId = null,
    localProjects = {},
    threadProjectAssignments = {},
    projectlessThreadIds = [],
    failedHostRequests = [],
    ignoredHostRequests = [],
    concurrentAssignmentPatch = null,
    projectLockAvailable = true,
  },
  fn,
) {
  const sent = [];
  const posted = [];
  const listeners = new Set();
  const state = {
    "local-projects": { ...localProjects },
    "thread-project-assignments": { ...threadProjectAssignments },
    "projectless-thread-ids": [...projectlessThreadIds],
  };
  let injectedConcurrentAssignment = false;
  const prevWindow = globalThis.window;
  const prevLocation = globalThis.location;
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (name, options, callback) => {
          assert.equal(name, "relay-codex-project-state");
          assert.deepEqual(options, { ifAvailable: true });
          return callback(projectLockAvailable ? { name } : null);
        },
      },
    },
  });
  globalThis.window = {
    document: {
      querySelectorAll: () => activeThreadId
        ? [{ getAttribute: (name) => name === "data-app-action-sidebar-thread-id" ? activeThreadId : name === "data-app-action-sidebar-thread-active" ? "true" : null }]
        : [],
    },
    electronBridge: {
      sendMessageFromView: async (message) => {
        sent.push(message);
        if (message.type === "electron-update-workspace-root-options") {
          state["local-projects"]["relay-project"] = {
            id: "relay-project",
            name: "Relay",
            rootPaths: [...message.roots],
          };
        }
        if (message.type === "fetch") {
          const name = String(message.url || "").split("/").at(-1);
          const params = JSON.parse(message.body || "{}");
          if (ignoredHostRequests.includes(name)) return new Promise(() => {});
          const failed = failedHostRequests.includes(name);
          let body = null;
          if (name === "get-global-state") body = { value: state[params.key] ?? null };
          if (name === "set-global-state") {
            if (!failed && params.key === "thread-project-assignments" && concurrentAssignmentPatch && !injectedConcurrentAssignment) {
              injectedConcurrentAssignment = true;
              Object.assign(state[params.key], concurrentAssignmentPatch);
              for (const listener of listeners) {
                listener({ data: { type: "thread-project-assignments-updated", assignments: concurrentAssignmentPatch } });
              }
            }
            if (!failed) state[params.key] = params.value;
            body = { success: true };
          }
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({
                data: {
                  type: "fetch-response",
                  responseType: failed ? "error" : "success",
                  requestId: message.requestId,
                  status: failed ? 500 : 200,
                  headers: { "content-type": "application/json" },
                  error: failed ? `${name}-failed` : undefined,
                  bodyJsonString: JSON.stringify(body),
                },
              });
            }
          });
        }
      },
    },
    addEventListener: (type, listener) => {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "message") listeners.delete(listener);
    },
    postMessage: (msg, targetOrigin) => {
      posted.push({ msg, targetOrigin });
    },
  };
  globalThis.location = { href, search, origin, pathname: "/index.html" };
  try {
    return await fn({ sent, posted, state });
  } finally {
    globalThis.window = prevWindow;
    globalThis.location = prevLocation;
    if (prevNavigator) Object.defineProperty(globalThis, "navigator", prevNavigator);
    else delete globalThis.navigator;
  }
}

const navPaths = (posted) => posted.filter((p) => p.msg.type === "navigate-to-route").map((p) => p.msg.path);

test("Relay project mutations are serialized across concurrent opens", async () => {
  const order = [];
  let releaseFirst;
  const first = enqueueCodexProjectMutation(async () => {
    order.push("first-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
  });
  const second = enqueueCodexProjectMutation(async () => {
    order.push("second-start");
    order.push("second-end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

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

test("main-window open navigates directly to the primary /local route", async () => {
  // Current ChatGPT prefixes the DOM identity with the host (`local:`); the
  // app-server and route APIs still take the bare conversation id.
  await withRendererGlobals({ activeThreadId: "local:thread_abc" }, async ({ posted }) => {
    const result = await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "thread_abc", primeMs: 0 });
    assert.deepEqual(navPaths(posted), ["/local/thread_abc"]);
    assert.ok(result.sent.some((s) => s.type === "navigate-to-route" && s.path === "/local/thread_abc" && s.ok));
  });
});

test("legacy primeOpen=false still navigates straight to /local", async () => {
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

test("even a leaked hotkey renderer is directed to the primary /local route", async () => {
  await withRendererGlobals({ href: "app://-/index.html?initialRoute=%2Fhotkey-window", search: "?initialRoute=%2Fhotkey-window" }, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "thread_abc", primeMs: 0, confirmMs: 0 });
    assert.deepEqual(navPaths(posted), ["/local/thread_abc"]);
  });
});

test("thread ids with unsafe characters are encoded into the primary route", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "a/b c", primeMs: 0, confirmMs: 0 });
    assert.deepEqual(navPaths(posted), ["/local/a%2Fb%20c"]);
  });
});

test("does not navigate when no thread is being opened", async () => {
  await withRendererGlobals({}, async ({ posted }) => {
    await relayRefreshCodexRenderer({ threadIds: ["t1"], openThreadId: null, primeMs: 0 });
    assert.equal(navPaths(posted).length, 0);
  });
});

test("a foreground Relay open uses Codex's non-navigating native project registration before resume", async () => {
  await withRendererGlobals({ activeThreadId: "relay-thread" }, async ({ sent, state }) => {
    const workspaceRoots = [
      "/Users/tester/Relay",
      "/Users/tester/.relay-companion/codex-inbox/relay-thread",
      "/Users/tester/.relay-companion/attachments/relay-thread",
    ];
    const result = await relayRefreshCodexRenderer({
      threadIds: ["relay-thread"],
      openThreadId: "relay-thread",
      ensureWorkspaceRoot: "/Users/tester/Relay",
      workspaceRootsByThreadId: { "relay-thread": workspaceRoots },
      primeMs: 0,
    });

    const registerIndex = sent.findIndex((message) => message.type === "electron-update-workspace-root-options");
    const resumeIndex = sent.findIndex((message) => message.type === "maybe-resume-conversation");
    assert.ok(registerIndex >= 0, "the Relay root is registered through Codex's native project manager");
    assert.deepEqual(sent[registerIndex].roots, ["/Users/tester/Relay"]);
    assert.equal(
      sent.some((message) => message.type === "electron-add-new-workspace-root-option"),
      false,
      "first open never invokes the native path that temporarily navigates Home",
    );
    assert.ok(resumeIndex > registerIndex, "the project exists before the task is resumed");
    assert.equal(
      sent.some((message) => {
        if (message.type !== "fetch" || !String(message.url).endsWith("/set-global-state")) return false;
        return JSON.parse(message.body).key === "local-projects";
      }),
      false,
      "Relay never replaces Codex's whole project map",
    );
    assert.equal(Object.values(state["local-projects"])[0].name, "Relay");
    assert.deepEqual(Object.values(state["local-projects"])[0].rootPaths, ["/Users/tester/Relay"]);
    assert.deepEqual(sent[resumeIndex].workspaceRoots, workspaceRoots);
    const relayProject = Object.values(state["local-projects"])[0];
    assert.deepEqual(state["thread-project-assignments"]["relay-thread"], {
      projectKind: "local",
      projectId: relayProject.id,
    });
    assert.ok(result.sent.some((item) => item.type === "relay-project-assignment" && item.ok));
  });
});

test("background repair never creates or selects a missing Relay project", async () => {
  await withRendererGlobals({}, async ({ sent }) => {
    const result = await relayRefreshCodexRenderer({
      threadIds: ["historical-relay"],
      ensureWorkspaceRoot: "/Users/tester/Relay",
      workspaceRootsByThreadId: { "historical-relay": ["/Users/tester/Relay"] },
      assignmentOnly: true,
    });
    assert.equal(result.ok, false);
    assert.equal(sent.some((message) => message.type === "electron-update-workspace-root-options"), false);
  });
});

test("a contended renderer lock fails fast without a late project mutation", async () => {
  await withRendererGlobals(
    {
      activeThreadId: "relay-thread",
      projectLockAvailable: false,
    },
    async ({ sent, state }) => {
      const started = Date.now();
      const result = await relayRefreshCodexRenderer({
        threadIds: ["relay-thread"],
        openThreadId: "relay-thread",
        ensureWorkspaceRoot: "/Users/tester/Relay",
        workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
        primeOpen: false,
        confirmMs: 0,
      });
      assert.ok(Date.now() - started < 1000, "lock contention stays below the inspector timeout");
      assert.equal(result.openConfirmed, true, "the already-visible task remains open");
      assert.equal(result.projectAssignmentOk, false);
      assert.deepEqual(state["local-projects"], {});
      assert.equal(sent.some((message) => message.type === "electron-update-workspace-root-options"), false);
      assert.ok(result.sent.some((item) => item.error === "project-state-lock-busy"));
    },
  );
});

test("an existing Relay project is reused without registering a duplicate", async () => {
  await withRendererGlobals(
    {
      localProjects: {
        existing: { id: "existing", name: "Relay", rootPaths: ["/Users/tester/Relay"] },
      },
    },
    async ({ sent, state }) => {
      await relayRefreshCodexRenderer({
        threadIds: ["existing-relay-thread"],
        ensureWorkspaceRoot: "/Users/tester/Relay/",
        workspaceRootsByThreadId: { "existing-relay-thread": ["/Users/tester/Relay"] },
        primeMs: 0,
      });
      assert.equal(
        sent.some((message) => {
          if (message.type !== "fetch" || !String(message.url).endsWith("/set-global-state")) return false;
          return JSON.parse(message.body).key === "local-projects";
        }),
        false,
      );
      assert.equal(state["thread-project-assignments"]["existing-relay-thread"].projectId, "existing");
    },
  );
});

test("a failed Relay assignment fails the refresh so startup repair retries", async () => {
  await withRendererGlobals(
    {
      localProjects: {
        existing: { id: "existing", name: "Relay", rootPaths: ["/Users/tester/Relay"] },
      },
      failedHostRequests: ["set-global-state"],
    },
    async ({ sent }) => {
      const result = await relayRefreshCodexRenderer({
        threadIds: ["relay-thread"],
        ensureWorkspaceRoot: "/Users/tester/Relay",
        workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
        assignmentOnly: true,
        primeMs: 0,
      });
      assert.equal(result.ok, false);
      assert.equal(result.projectAssignmentOk, false);
      assert.ok(result.sent.some((item) => item.type === "relay-project-assignment" && !item.ok));
      assert.equal(sent.some((message) => message.type === "maybe-resume-conversation"), false);
    },
  );
});

test("a visible open stays confirmed when only the Relay assignment needs retry", async () => {
  await withRendererGlobals(
    {
      activeThreadId: "relay-thread",
      localProjects: {
        existing: { id: "existing", name: "Relay", rootPaths: ["/Users/tester/Relay"] },
      },
      failedHostRequests: ["set-global-state"],
    },
    async () => {
      const result = await relayRefreshCodexRenderer({
        threadIds: ["relay-thread"],
        openThreadId: "relay-thread",
        ensureWorkspaceRoot: "/Users/tester/Relay",
        workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
        primeOpen: false,
        confirmMs: 0,
      });
      assert.equal(result.openConfirmed, true);
      assert.equal(result.projectAssignmentOk, false);
      assert.equal(result.ok, true, "a project retry must not manufacture a second visible open");
    },
  );
});

test("assignment-only repair removes Relay from Recents without rewriting Codex's projectless index", async () => {
  await withRendererGlobals(
    {
      localProjects: {
        existing: { id: "existing", name: "Relay", rootPaths: ["/Users/tester/Relay"] },
      },
      projectlessThreadIds: ["historical-relay", "unrelated-task"],
    },
    async ({ sent, state }) => {
      const result = await relayRefreshCodexRenderer({
        threadIds: ["historical-relay"],
        ensureWorkspaceRoot: "/Users/tester/Relay",
        workspaceRootsByThreadId: { "historical-relay": ["/Users/tester/Relay"] },
        assignmentOnly: true,
      });
      assert.equal(result.ok, true);
      assert.equal(state["thread-project-assignments"]["historical-relay"].projectId, "existing");
      assert.deepEqual(
        state["projectless-thread-ids"],
        ["historical-relay", "unrelated-task"],
        "Codex's native projectless bookkeeping is never replaced wholesale",
      );
      assert.equal(
        sent.some((message) => {
          if (message.type !== "fetch" || !String(message.url).endsWith("/set-global-state")) return false;
          return JSON.parse(message.body).key === "projectless-thread-ids";
        }),
        false,
      );
      for (const forbidden of [
        "hydrate-pinned-threads",
        "refresh-recent-conversations-for-host",
        "discard-conversation-from-cache",
        "ensure-conversation-history-loaded",
        "maybe-resume-conversation",
        "broadcast-conversation-snapshot-for-host",
      ]) {
        assert.equal(sent.some((message) => message.type === forbidden), false, `${forbidden} must stay off the migration path`);
      }
    },
  );
});

test("Relay assignment preserves a concurrent Codex project move", async () => {
  const concurrent = { projectKind: "local", projectId: "other-project" };
  await withRendererGlobals(
    {
      localProjects: {
        existing: { id: "existing", name: "Relay", rootPaths: ["/Users/tester/Relay"] },
      },
      concurrentAssignmentPatch: { "other-thread": concurrent },
    },
    async ({ state }) => {
      const result = await relayRefreshCodexRenderer({
        threadIds: ["relay-thread"],
        ensureWorkspaceRoot: "/Users/tester/Relay",
        workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
        assignmentOnly: true,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(state["thread-project-assignments"]["other-thread"], concurrent);
      assert.equal(state["thread-project-assignments"]["relay-thread"].projectId, "existing");
    },
  );
});

test("an unresponsive Codex state bridge fails assignment within its visual budget", async () => {
  await withRendererGlobals({ ignoredHostRequests: ["get-global-state"] }, async () => {
    const started = Date.now();
    const result = await relayRefreshCodexRenderer({
      threadIds: ["relay-thread"],
      ensureWorkspaceRoot: "/Users/tester/Relay",
      workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
      assignmentOnly: true,
    });
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 1500, "the assignment path must stay below the outer inspector deadline");
  });
});

test("desktop refresh expression preserves per-thread workspace roots", () => {
  const expression = buildCodexDesktopRefreshExpression({
    threadIds: ["relay-thread"],
    ensureWorkspaceRoot: "/Users/tester/Relay",
    workspaceRootsByThreadId: { "relay-thread": ["/Users/tester/Relay"] },
  });
  assert.match(expression, /set-global-state/);
  assert.match(expression, /electron-update-workspace-root-options/);
  assert.match(expression, /navigator\?\.locks/);
  assert.ok(expression.includes("/Users/tester/Relay"));
  assert.match(expression, /workspaceRootsByThreadId/);
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
    await relayRefreshCodexRenderer({ threadIds: [], openThreadId: "t1", primeMs: 0, confirmMs: 0 });
    const paths = posted.filter((m) => m.type === "navigate-to-route").map((m) => m.path);
    assert.deepEqual(paths, ["/local/t1"]);
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
  assert.deepEqual(navPaths(posted), ["/local/thread_abc"]);
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
  const windowsMain = String.raw`"C:\Program Files\WindowsApps\OpenAI.Codex_26.831.2377.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"`;
  assert.equal(isCodexMainCommand(windowsMain), true);
  assert.equal(isCodexMainCommand(`${windowsMain} --type=renderer`), false);
  assert.equal(isCodexMainCommand(String.raw`"C:\Program Files\WindowsApps\Other.ChatGPT_1\app\ChatGPT.exe"`), false);
  assert.equal(isCodexMainCommand("/Applications/Claude.app/Contents/MacOS/Claude"), false);
});

test("Windows process inventory keeps only Codex's main Electron process", () => {
  const app = String.raw`"C:\Program Files\WindowsApps\OpenAI.Codex_26.831.2377.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"`;
  assert.deepEqual(windowsCodexMainPids(JSON.stringify([
    { ProcessId: 101, CommandLine: app },
    { ProcessId: 102, CommandLine: `${app} --type=gpu-process` },
    { ProcessId: 103, CommandLine: String.raw`"C:\Program Files\WindowsApps\Other.ChatGPT_1\app\ChatGPT.exe"` },
  ])), [101]);
  assert.deepEqual(windowsCodexMainPids(JSON.stringify({ ProcessId: 104, CommandLine: app })), [104]);
  assert.deepEqual(windowsCodexMainPids("not json"), []);
});

test("Windows opens Electron's inspector through Node's debug trigger", () => {
  const calls = [];
  assert.equal(startCodexInspector(301, {
    platform: "win32",
    debugProcess: (pid) => calls.push(["debug", pid]),
    kill: () => calls.push(["kill"]),
  }), true);
  assert.deepEqual(calls, [["debug", 301]]);
});

test("Windows can submit through the same Desktop renderer bridge", async () => {
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_windows",
    text: "visible Windows turn",
    platform: "win32",
    confirmAttempts: 1,
    runtime: {
      findCodexMainPids: async () => [501],
      evaluateAcrossCodexPids: async () => [{
        pid: 501,
        ok: true,
        value: [{ id: 1, kind: "primary", result: { ok: true } }],
      }],
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.equal(result.submitted, true);
  assert.equal(result.reason, null);
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
      // The existing task stays in the primary window for the whole submit.
      // A hotkey prime creates ChatGPT's compact auxiliary window beside it.
      assert.deepEqual(navPaths(posted), [
        "/local/thread_abc",
        "/local/thread_abc",
      ]);
      assert.equal(navPaths(posted).some((route) => route.includes("hotkey-window")), false);
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
      assert.deepEqual(navPaths(posted), ["/local/t1"]);
    },
  );
});

test("a timed-out turn/start is ambiguous because the uncancelled bridge request may still land", async () => {
  await withSubmitGlobals(
    {
      respond: (message) => {
        if (message.type === "maybe-resume-conversation") return { activeTurnId: null };
        if (message.type === "mcp-request") return new Promise(() => {});
        return undefined;
      },
    },
    async ({ sent }) => {
      const result = await relaySubmitCodexRenderer({
        threadId: "t1",
        text: "hello once",
        settleMs: 0,
        startTurnTimeoutMs: 5,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "start-turn-unconfirmed");
      assert.equal(result.deliveryAmbiguous, true);
      assert.equal(sent.filter((message) => message.type === "mcp-request").length, 1);
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

test("submit renderer never creates another hotkey window even if an auxiliary URL leaks through", async () => {
  await withSubmitGlobals(
    {
      respond: (m) => (m.type === "maybe-resume-conversation" ? { activeTurnId: null } : undefined),
      href: "app://-/index.html?initialRoute=%2Fhotkey-window",
      search: "?initialRoute=%2Fhotkey-window",
    },
    async ({ posted }) => {
      const result = await relaySubmitCodexRenderer({ threadId: "t1", text: "hello", settleMs: 0 });
      assert.equal(result.ok, true);
      assert.deepEqual(navPaths(posted), ["/local/t1", "/local/t1"]);
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
  assert.deepEqual(navPaths(posted), ["/local/thread_abc", "/local/thread_abc"]);

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

test("rollout confirmation accepts the current completed UserMessage identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-current-user-row-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    rollout,
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          client_id: "client-current-456",
          content: [{ type: "text", text: "A Relay has arrived" }],
        },
      },
    })}\n`,
  );
  assert.equal(codexRolloutHasClientMessage(rollout, "client-current-456"), true);
  assert.equal(codexRolloutHasClientMessage(rollout, "somebody-else"), false);
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
        if (pids[0] === 101) return [{ pid: 101, ok: false, reason: "inspector-unavailable" }];
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

test("a destructive picker submit targets only the newest overlapping Codex main process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-overlap-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  const evaluated = [];
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_overlap",
    text: "single-process turn",
    rolloutPath: rollout,
    confirmAttempts: 1,
    confirmIntervalMs: 10,
    timeoutMs: 20,
    platform: "darwin",
    runtime: {
      findCodexMainPids: async () => [501, 503, 502],
      evaluateAcrossCodexPids: async (pids, expression) => {
        evaluated.push(pids);
        const match = expression.match(/clientUserMessageId\\?":\\?"([0-9a-f-]{36})/);
        fs.appendFileSync(
          rollout,
          `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: match[1], message: "single-process turn" } })}\n`,
        );
        return [{ pid: pids[0], ok: true, value: [{ id: 1, kind: "primary", result: { ok: true } }] }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(1, ms))),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.deepEqual(evaluated, [[503]], "turn/start is never broadcast across old and new app processes");
  assert.equal(result.submitted, true);
  assert.equal(result.ran, true);
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
  assert.equal(calls, 1, "an accepted renderer envelope is never submitted a second time");
  assert.equal(result.submitted, true, "the bridge did acknowledge the envelope");
  assert.equal(result.ran, false, "no matching user_message means the turn did not start");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an inner turn/start timeout is polled but never re-evaluated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-inner-timeout-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  let calls = 0;
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_inner_timeout",
    text: "one uncertain turn",
    rolloutPath: rollout,
    confirmAttempts: 2,
    confirmIntervalMs: 10,
    timeoutMs: 20,
    platform: "darwin",
    runtime: {
      findCodexMainPids: async () => [406],
      evaluateAcrossCodexPids: async () => {
        calls += 1;
        return [{
          pid: 406,
          ok: true,
          value: [{ id: 1, kind: "primary", result: { ok: false, reason: "start-turn-unconfirmed", deliveryAmbiguous: true } }],
        }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(1, ms))),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.submitted, false);
  assert.equal(result.ran, false);
  assert.equal(result.deliveryAmbiguous, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an accepted picker turn is only polled while its rollout acknowledgement is delayed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-delayed-ack-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  let calls = 0;
  let identity = "";
  let scheduled = false;
  const lifecycle = [];
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_delayed_ack",
    text: "one visible picker turn",
    rolloutPath: rollout,
    clientUserMessageId: "client-picker-once",
    requestId: "request-picker-once",
    confirmAttempts: 3,
    confirmIntervalMs: 20,
    timeoutMs: 20,
    platform: "darwin",
    onSubmitted: () => { lifecycle.push("submitted"); },
    runtime: {
      findCodexMainPids: async () => [404],
      evaluateAcrossCodexPids: async (_pids, expression) => {
        calls += 1;
        assert.match(expression, /client-picker-once/);
        assert.match(expression, /request-picker-once/);
        identity = "client-picker-once";
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => {
            lifecycle.push("rollout");
            fs.appendFileSync(
              rollout,
              `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: identity, message: "one visible picker turn" } })}\n`,
            );
          }, 25);
        }
        return [{ pid: 404, ok: true, value: [{ id: 1, kind: "primary", result: { ok: true } }] }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.equal(calls, 1, "confirmation rounds poll the accepted identity without replaying turn/start");
  assert.equal(result.clientUserMessageId, identity);
  assert.equal(result.submitted, true);
  assert.equal(result.ran, true);
  assert.equal(result.turnAttempts, 1);
  assert.deepEqual(lifecycle, ["submitted", "rollout"], "the UI receipt can advance before durable rollout polling finishes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an inspector timeout after dispatch is reconciled without replaying the picker turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-ambiguous-dispatch-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  let calls = 0;
  const result = await submitTurnToCodexDesktopThread({
    threadId: "thread_ambiguous_dispatch",
    text: "timeout-safe picker turn",
    rolloutPath: rollout,
    clientUserMessageId: "client-ambiguous-once",
    confirmAttempts: 3,
    confirmIntervalMs: 20,
    timeoutMs: 20,
    platform: "darwin",
    runtime: {
      findCodexMainPids: async () => [405],
      evaluateAcrossCodexPids: async () => {
        calls += 1;
        setTimeout(() => {
          fs.appendFileSync(
            rollout,
            `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", client_id: "client-ambiguous-once", message: "timeout-safe picker turn" } })}\n`,
          );
        }, 25);
        return [{ pid: 405, ok: false, deliveryAmbiguous: true, error: "inspector response timed out" }];
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      launchCodexDesktop: async () => false,
      waitForCodexMainPids: async () => [],
    },
  });
  assert.equal(calls, 1, "an ambiguous dispatched expression is never evaluated again");
  assert.equal(result.deliveryAmbiguous, true);
  assert.equal(result.submitted, true, "the matching rollout identity resolves the ambiguous transport");
  assert.equal(result.ran, true);
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
