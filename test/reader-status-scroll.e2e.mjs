// The actual renderer, synthetic letters and an inert bridge. No account or
// installed Companion is touched. Run with node; CI supplies Chromium.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const overlay = fileURLToPath(new URL("../overlay", import.meta.url));
const server = http.createServer((request, response) => {
  const target = path.resolve(overlay, decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "inbox.html");
  if (!target.startsWith(overlay + path.sep) || !fs.existsSync(target)) { response.writeHead(404).end(); return; }
  response.setHeader("content-type", target.endsWith(".html") ? "text/html" : /\.(js|cjs)$/.test(target) ? "text/javascript" : "application/octet-stream");
  fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless:true });
try {
  const page = await browser.newPage({ viewport:{ width:720, height:760 }, reducedMotion:"no-preference" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const row = { id:"motion-task", threadId:"motion-task", relayNotificationKind:"task", kind:"task",
      senderName:"Test Sender", senderEmail:"sender@example.com", title:"Read the release notes",
      forHuman:Array.from({ length:7 }, (_, i) => `Paragraph ${i + 1}. This synthetic letter exercises the real reader. Scroll through the notes while the task's status yields room to read.`).join("\n\n"),
      forAgent:"Synthetic details for this preview.", createdAt:new Date(Date.now() - 3600000).toISOString(),
      taskStartedAt:new Date(Date.now() - 600000).toISOString() };
    window.testRow = row;
    window.testPayload = { account:{ paired:true, userId:"motion-test", name:"Test Reader", email:"self@example.com" },
      ui:{ soundsMuted:true }, features:{}, relays:[row], sent:[], contacts:[], chats:[] };
    window.relay = new Proxy({ isTestOverlay:true, refresh:async () => testPayload,
      onInbox:callback => window.pushTestPayload = callback,
      rendererReady:() => window.ready = true,
    }, { get:(target, key) => key in target ? target[key] : String(key).startsWith("on")
      ? () => {} : async () => ({ ok:true, items:[], contacts:[], groups:[], schedules:[] }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/inbox.html`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => { cardEl.classList.remove("offstage", "bye"); setCollapsed(false); openReader(testRow.id, "relays"); });
  await page.waitForFunction(() => activeView === "reader" && W.v === W.t && H.v === H.t && !cardViewTransition);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running" || animation.effect.getTiming().iterations === Infinity));
  const state = () => page.evaluate(() => {
    const panel = document.querySelector(".tk-status");
    return { opacity:Number(panel.style.opacity || 1), inert:panel.inert,
      slotHeight:document.querySelector(".reader-status-slot").getBoundingClientRect().height,
      scroll:scrollEl.scrollTop, extent:scrollEl.scrollHeight,
      composerY:document.getElementById("qrInput").getBoundingClientRect().y,
      letterY:document.querySelector(".rd-body").getBoundingClientRect().y };
  });
  const scroll = top => page.evaluate(top => { scrollEl.scrollTop = top; }, top);
  const hidden = () => page.waitForFunction(() => document.querySelector(".tk-status").style.opacity === "0");
  const shown = () => page.waitForFunction(() => document.querySelector(".tk-status").style.opacity === "1"
    && document.querySelector(".reader-status-slot").getBoundingClientRect().height > 1);
  const baseline = await state();
  await scroll(5);
  await page.waitForTimeout(100);
  assert.equal((await state()).opacity, 1, "tiny scroll noise does not hide the panel");
  await scroll(150);
  await hidden();
  const down = await state();
  assert.equal(down.inert, true, "hidden verbs leave the focus order");
  assert.equal(down.extent, baseline.extent, "withdrawal preserves the scroll range");
  assert.equal(down.composerY, baseline.composerY, "reply stays anchored");
  assert.equal(down.letterY, baseline.letterY - 150, "the letter only moves with scrolling");
  await page.evaluate(() => { window.originalInput = document.getElementById("qrInput"); originalInput.focus(); originalInput.value = "Draft to keep"; });
  for (let i = 0; i < 3; i += 1) await page.evaluate(() => pushTestPayload(testPayload));
  const refreshed = await state();
  assert.equal(refreshed.opacity, 0, "a poll cannot flash the panel back");
  assert.equal(refreshed.scroll, 150);
  assert.equal(refreshed.extent, baseline.extent);
  assert.equal(await page.evaluate(() => document.activeElement === originalInput && originalInput.value === "Draft to keep"), true);
  await scroll(90); await shown();
  assert.equal((await state()).composerY, baseline.composerY);

  // Real wheel input, including a reversal while the spring is moving.
  await page.mouse.move(340, 300);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() => Number(document.querySelector(".tk-status").style.opacity) < .9);
  await page.mouse.wheel(0, -40); await shown();
  assert.ok((await state()).scroll > 0, "upscroll reveals before returning to the top");

  // Changes in status are worth showing even while the reader is moving down.
  await scroll(250); await hidden();
  await page.evaluate(() => { testRow.taskCompletedAt = new Date().toISOString(); pushTestPayload(testPayload); });
  await shown();
  assert.equal(await page.locator(".tk-status").evaluate(el => el.classList.contains("done")), true);

  await page.evaluate(() => { delete testRow.taskCompletedAt; pushTestPayload(testPayload); }); await shown();
  await page.locator(".tk-status .tk-btn").first().focus();
  await scroll(310); await page.waitForTimeout(120);
  assert.equal((await state()).opacity, 1, "a focused action cannot slide out from under the keyboard");
  await page.locator("#qrInput").focus();
  await scroll(380); await hidden();
  await page.emulateMedia({ reducedMotion:"reduce" });
  await scroll(320);
  await shown();
  assert.equal((await state()).slotHeight, baseline.slotHeight, "reduced motion uses the same final layout");

  // A replacement with different height must keep the total extent stable.
  await scroll(450); await hidden();
  await page.evaluate(() => {
    document.querySelector(".tk-status .tk-helper").textContent = "A longer status explanation. ".repeat(12);
  });
  await page.waitForTimeout(100);
  const resized = await state();
  await scroll(400); await shown();
  assert.equal((await state()).extent, resized.extent, "resizing a hidden panel updates its compensation");

  await page.evaluate(() => { activeView = "relays"; commitNavigation({ outerScrollTop:0 }); });
  assert.equal(await page.evaluate(() => scrollEl.style.overflowAnchor), "", "navigation restores the list's native scroll anchoring");
  await page.evaluate(() => openReader(testRow.id, "relays")); await shown();
  await page.waitForFunction(() => !cardViewTransition && W.v === W.t && H.v === H.t);
  await page.evaluate(() => { scrollEl.scrollTop = scrollEl.scrollHeight; }); await hidden();
  const bottom = await state();
  await page.waitForTimeout(100);
  assert.equal((await state()).scroll, bottom.scroll, "collapsing at the bottom cannot clamp or oscillate");
  await scroll(bottom.scroll - 35); await shown();

  // Leaving an unfinished spring freezes it until the surface is visible.
  await page.emulateMedia({ reducedMotion:"no-preference" });
  await scroll(bottom.scroll); await page.waitForFunction(() => Number(document.querySelector(".tk-status").style.opacity) < .95);
  await page.evaluate(() => readerStatusMotion.setActive(false));
  const paused = await state();
  await page.waitForTimeout(120);
  assert.equal((await state()).opacity, paused.opacity, "hidden surfaces stop the spring");
  await page.evaluate(() => readerStatusMotion.setActive(true)); await hidden();

  // A short letter with provider rows disabled genuinely fits the reader.
  await page.evaluate(() => {
    testRow.forHuman = "A short task."; testRow.forAgent = "";
    setProtoPref(agentAppsPreferenceKey(), "__none__");
    setProtoPref(chatAppsPreferenceKey(), "__none__");
    pushTestPayload(testPayload); scrollEl.scrollTop = 0;
  });
  await page.waitForFunction(() => readerBodyEl.classList.contains("rd-fit"));
  assert.equal((await state()).opacity, 1, "fitting letters keep their actions visible");
  await page.evaluate(() => {
    testPayload.relays.push({ ...testRow, id:"ordinary-relay", threadId:"ordinary-relay", kind:"message", relayNotificationKind:"plain_relay" });
    pushTestPayload(testPayload); openReader("ordinary-relay", "relays");
  });
  await page.waitForFunction(() => readerId === "ordinary-relay" && !cardViewTransition);
  assert.equal(await page.locator(".reader-status-slot").count(), 0, "ordinary relays retain their original layout");
  assert.deepEqual(errors, []);
  console.log("PASS: reader status scroll, live wheel reversal, refresh/draft, state update, focus, reduced motion, resize, navigation and fitting letter");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
