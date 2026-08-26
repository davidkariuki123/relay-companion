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
