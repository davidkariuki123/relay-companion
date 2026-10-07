import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start}..${end} exists`);
  return html.slice(from, to);
}

test("navigation paints the destination before revealing or resizing it", () => {
  const renderAll = between("function renderAll()", "markAllReadEl.addEventListener");
  const apply = renderAll.lastIndexOf("applyView();");
  assert.ok(renderAll.indexOf('activeView === "threads") renderThreads()') < apply);
  assert.ok(renderAll.indexOf('activeView === "reader") renderReader()') < apply);


  const applyView = between("function applyView()", 'document.getElementById("chatExpandBtn")');
  assert.ok(applyView.indexOf('readerViewEl.classList.toggle("hidden"') < applyView.indexOf("syncCardSize("));
  assert.doesNotMatch(applyView, /renderThreads\(\)|renderTasksBoard\(\)|renderSettings\(\)/);
});

test("a navigation commits once and restores scroll before the browser paints", () => {
  const commit = between("function commitNavigation(", "function syncTabs()");
  assert.match(commit, /focused\.blur\(\)/);
  assert.ok(commit.indexOf("syncTabs();") < commit.indexOf("renderAll();"));
  assert.ok(commit.indexOf("renderAll();") < commit.indexOf("scrollEl.scrollTop"));

  const openRoom = between("function openRoom(", "function renderChat()");
  assert.equal((openRoom.match(/openThreadDetail\(/g) || []).length, 1);
  assert.doesNotMatch(openRoom, /applyView\(\)|renderAll\(\)|requestAnimationFrame/);

  const openThread = between("function openThreadDetail(", "// ---------- Settings view");
  assert.equal((openThread.match(/commitNavigation\(/g) || []).length, 1);
  assert.doesNotMatch(openThread, /applyView\(\)|renderAll\(\)|requestAnimationFrame/);
});

test("Reader Back restores the final room state without an intermediate wrong frame", () => {
  const close = between("function closeReader()", "// Paragraph-level rendering");
  assert.match(close, /openThreadDetail\(back\.threadId, back\.party \|\| "", back\.source \|\| "chat"\)/);
  assert.doesNotMatch(close, /appExpanded\s*=/);
  assert.match(close, /commitNavigation\(\{ outerScrollTop: back\.outerScrollTop \}\)/);
});

test("expand and banner-to-full transitions populate content before the frame moves", () => {
  const expand = between("function setAppExpanded(", 'document.getElementById("wideToggle").addEventListener("click"');
  // The whole destination is built inside the transition's update, before
  // the frame starts moving: mode, button, then one committed navigation.
  assert.ok(expand.indexOf("startCardViewTransition(") < expand.indexOf("appExpanded = next;"));
  assert.ok(expand.indexOf("appExpanded = next;") < expand.indexOf("commitNavigation();"));

  const openFull = between("function openFull()", "// ---------- the ✕");
  assert.match(openFull, /renderAll\(\)/);
  assert.doesNotMatch(openFull, /deferRenderAll|requestAnimationFrame/);

  const trayOpen = between("function trayOpen()", "// The banner must show");
  assert.match(trayOpen, /renderAll\(\)/);
  assert.doesNotMatch(trayOpen, /deferRenderAll/);
});

test("tab navigation uses the atomic commit", () => {
  const tabs = between("for (const tab of tabEls)", "function renderAll()");
  assert.match(tabs, /activeView = view;\s*commitNavigation\(\);/);
  assert.doesNotMatch(tabs, /activeView = view;\s*syncTabs\(\);\s*applyView\(\);\s*renderAll\(\)/);
});
