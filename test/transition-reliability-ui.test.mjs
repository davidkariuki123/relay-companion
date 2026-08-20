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
  assert.ok(renderAll.indexOf('activeView === "requestDetail") renderRequestDetail()') < apply);

  const applyView = between("function applyView()", 'document.getElementById("chatExpandBtn")');
  assert.ok(applyView.indexOf('readerViewEl.classList.toggle("hidden"') < applyView.indexOf("syncCardSize("));
  assert.doesNotMatch(applyView, /renderThreads\(\)|renderRequestsBoard\(\)|renderSettings\(\)/);
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
  assert.match(close, /openThreadDetail\(back\.threadId, back\.party \|\| "", back\.source \|\| "chat", \{ expanded: wasExpanded \}\)/);
  assert.doesNotMatch(close, /openThreadDetail\([^;]+;[\s\S]*?chatExpanded = wasExpanded/);
  assert.match(close, /commitNavigation\(\{ outerScrollTop: back\.outerScrollTop \}\)/);
});

test("expand and banner-to-full transitions populate content before the frame moves", () => {
  const expand = between('document.getElementById("thExpand")', "thBackEl.addEventListener");
  assert.ok(expand.indexOf("renderChatRail();") < expand.indexOf("applyView();"));

  const openFull = between("function openFull()", "// ---------- the ✕");
  assert.match(openFull, /renderAll\(\)/);
  assert.doesNotMatch(openFull, /deferRenderAll|requestAnimationFrame/);

  const trayOpen = between("function trayOpen()", "// The banner must show");
  assert.match(trayOpen, /renderAll\(\)/);
  assert.doesNotMatch(trayOpen, /deferRenderAll/);
});

test("tab and request navigation use the same atomic commit", () => {
  const tabs = between("for (const tab of tabEls)", "function renderAll()");
  assert.match(tabs, /activeView = view;\s*commitNavigation\(\);/);
  assert.doesNotMatch(tabs, /activeView = view;\s*syncTabs\(\);\s*applyView\(\);\s*renderAll\(\)/);

  const requestDetail = between("function showRequestDetail(", "async function refreshRequestDetail");
  assert.match(requestDetail, /activeView = "requestDetail";\s*commitNavigation\(\{ outerScrollTop: 0 \}\)/);
  assert.match(requestDetail, /activeView = "sent";\s*commitNavigation\(\{ outerScrollTop: 0 \}\)/);
});
