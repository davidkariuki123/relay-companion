import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "overlay", "inbox.html"), "utf8");

test("every perpetual renderer animation obeys the shared surface lifecycle", () => {
  const infiniteDeclarations = html.split(/\r?\n/).filter((line) => /animation:[^;]*\binfinite\b/.test(line));
  assert.ok(infiniteDeclarations.length >= 8, "the audit should cover every current looping animation");
  for (const declaration of infiniteDeclarations) {
    assert.match(declaration, /animation-play-state:var\(--relay-loop-state\)/, declaration.trim());
  }
  assert.match(html, /\.card \{[\s\S]*--relay-loop-state:paused;/);
  assert.match(html, /\.card\[data-continuous-motion="running"\] \{ --relay-loop-state:running; \}/);
});

test("the Task working cue animates compositor properties without repainting its shadow", () => {
  const keyframes = html.match(/@keyframes taskWorkingBreathe \{([^}]+\}[^}]+\}) \}/)?.[1] || "";
  assert.match(keyframes, /opacity/);
  assert.match(keyframes, /transform/);
  assert.doesNotMatch(keyframes, /box-shadow/);
});

test("collapsed and hidden surfaces stop frame watching, run polling, and view rebuilds", () => {
  assert.match(html, /function rendererSurfaceActive\(\)[\s\S]*document\.visibilityState === "visible"[\s\S]*!collapsed[\s\S]*offstage[\s\S]*bye/);
  assert.match(html, /function syncRunMirrors\(\) \{\s*if \(!rendererSurfaceActive\(\)\)/);
  assert.match(html, /const paintSurface = rendererSurfaceActive\(\)/);
  assert.match(html, /if \(!rendererSurfaceActive\(\)\) \{ watchRaf = null; return; \}/);
  assert.match(html, /function flushDeferredSurfaceRender\(\)/);
});

test("hidden surfaces defer canonical hydration, reads, and Slack connection paints", () => {
  const reconcile = html.slice(
    html.indexOf("function reconcileCanonicalChatResult("),
    html.indexOf("function syncSlackVisibilityButton(", html.indexOf("function reconcileCanonicalChatResult(")),
  );
  const poll = html.slice(html.indexOf("async function refreshActiveCanonicalChat("), html.indexOf("let signupStage"));
  const slack = html.slice(html.indexOf("function paintSlackConnectionSurface("), html.indexOf("function resetSignOutArm("));
  const payload = html.slice(html.indexOf("function onPayload("), html.indexOf("window.relay.onInbox"));

  assert.match(reconcile, /if \(!rendererSurfaceActive\(\)\) \{\s*surfaceRenderDeferred = true;\s*return;/);
  assert.match(poll, /activeCanonicalChatRefresh \|\| !rendererSurfaceActive\(\)/);
  assert.match(slack, /function paintSlackConnectionSurface\(\)[\s\S]*!rendererSurfaceActive\(\)[\s\S]*surfaceRenderDeferred = true/);
  assert.match(slack, /async function refreshSlackConnection[\s\S]*!rendererSurfaceActive\(\)[\s\S]*slackConnectionRefreshDeferred = true/);
  assert.match(payload, /const paintSurface = rendererSurfaceActive\(\)/);
  assert.match(payload, /if \(paintSurface && activeView === "threads" && threadDetailId\)/);
  assert.match(payload, /if \(paintSurface\) readVisibleChatRoom\(\);\s*else surfaceRenderDeferred = true;/);
});

test("a tab hop invalidates a retiring room transition before its update can navigate", () => {
  const motion = html.slice(
    html.indexOf("function cleanRoomViewTransition("),
    html.indexOf("let peeking = false"),
  );
  const tabs = html.slice(
    html.indexOf("for (const tab of tabEls)"),
    html.indexOf("function renderAll()"),
  );

  assert.match(motion, /function supersedeRoomViewTransition\(\)[\s\S]*\+\+roomViewTransitionToken[\s\S]*skipTransition\(\)[\s\S]*cleanRoomViewTransition\(token\)/);
  assert.match(motion, /document\.startViewTransition\(\(\) => \{\s*if \(token !== roomViewTransitionToken\) return;/);
  assert.match(tabs, /if \(roomViewTransition\) \{\s*supersedeRoomViewTransition\(\);\s*\}/);
});

test("the real Electron harness exercises a running Task while collapsed", () => {
  const harness = fs.readFileSync(path.join(here, "perf-overlay.mjs"), "utf8");
  assert.match(harness, /D-running-task-collapsed/);
  assert.match(harness, /window\.__relayMotionTest\.setCollapsed\(true\)/);
  assert.match(harness, /surfacePaintCount/);
  assert.match(harness, /frameWatch\.ticks/);
  assert.match(harness, /loopAnimations\.some/);
  assert.match(harness, /mainCpuPct > COLLAPSED_MAIN_CPU_MAX/);
  assert.match(harness, /rendererCpuPct > COLLAPSED_RENDERER_CPU_MAX/);
});
