// Actual renderer, fake preload and transport. No Companion process or account.
// RELAY_TEST_OVERLAY can point at an unmodified published package for diagnosis.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const overlay = path.resolve(process.env.RELAY_TEST_OVERLAY || fileURLToPath(new URL("../overlay", import.meta.url)));
const server = http.createServer((request, response) => {
  const target = path.resolve(overlay, decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "inbox.html");
  if (!target.startsWith(overlay + path.sep) || !fs.existsSync(target)) { response.writeHead(404).end(); return; }
  response.setHeader("content-type", target.endsWith(".html") ? "text/html" : /\.(js|cjs)$/.test(target) ? "text/javascript" : "application/octet-stream");
  fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless:true });
try {
  const page = await browser.newPage({ viewport:{ width:Number(process.env.RELAY_TEST_WIDTH || 480), height:700 }, timezoneId:"Africa/Johannesburg", reducedMotion:process.env.RELAY_TEST_MOTION || "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const empty = { account:{ paired:true, userId:"self", email:"self@example.com" }, ui:{ soundsMuted:true }, features:{}, relays:[], sent:[], contacts:[], outbox:[] };
    window.previewCalls = [];
    window.viewerCalls = [];
    window.relay = new Proxy({
      isTestOverlay:true, refresh:async () => empty, contacts:async () => [], rendererReady:() => window.ready = true,
      previewAttachment:async (...args) => {
        window.previewCalls.push(args);
        const canvas = document.createElement("canvas");
        canvas.width = 80; canvas.height = 160;
        canvas.getContext("2d").fillRect(0, 0, 80, 160);
        return { ok:true, mimeType:"image/png", dataBase64:canvas.toDataURL().split(",")[1] };
      },
      openAttachmentViewer:async (...args) => { window.viewerCalls.push(args); return { ok:true }; },
    }, { get:(target, key) => key in target ? target[key] : String(key).startsWith("on") ? () => {} : async () => ({ ok:true }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/inbox.html`);
  await page.waitForFunction(() => window.ready);
  const fixture = {
    account:{ paired:true, userId:"self", email:"self@example.com" }, ui:{ soundsMuted:true }, features:{}, contacts:[], relays:[],
    sent:Array.from({ length:20 }, (_, i) => ({ relayId:`old-${i}`, threadId:"room", createdAt:`2026-09-15T08:${String(i).padStart(2,"0")}:00Z`,
      kind:"message", title:"", forHuman:`Existing message ${i}`, forAgent:"", recipient:{ name:"Test", email:"test@example.com" }, state:"delivered" })),
    outbox:[{ id:"photo-send", createdAt:"2026-09-15T09:00:00Z", state:"queued", attempts:1, text:"",
      files:[{ name:"portrait.png", size:100, contentType:"image/png" }],
      chat:{ threadId:"room", party:"Test", partyKey:"email:test@example.com" }, recipient:{ email:"test@example.com" } }],
  };
  await page.evaluate(input => { onPayload(input); openThreadDetail("room", "Test", "relays"); }, fixture);
  await page.locator(".ca-photo.ready.portrait img").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !threadEntryFollowToken() && !roomViewTransition && !readerMorphSnapshot
    && W.v === W.t && H.v === H.t
    && document.getAnimations().every(animation => animation.playState !== "running" || animation.effect.getTiming().iterations === Infinity));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    window.oldText = document.querySelector('[data-msg="old-0"] .th-text-content');
    window.photo = document.querySelector(".ca-photo");
    window.photoImage = photo.querySelector("img");
    window.photoHeight = photo.getBoundingClientRect().height;
  });
  const checkFrame = async (label) => {
    const state = await page.evaluate(() => ({
      textConnected:oldText.isConnected, imageConnected:photoImage.isConnected,
      sameImage:document.querySelector(".ca-photo img") === photoImage,
      ready:document.querySelector(".ca-photo")?.classList.contains("ready"),
      height:document.querySelector(".ca-photo")?.getBoundingClientRect().height,
      expectedHeight:photoHeight, previews:previewCalls.length,
    }));
    assert.equal(state.textConnected, true, `${label}: existing text was torn down`);
    assert.equal(state.imageConnected, true, `${label}: loaded photo was torn down`);
    assert.equal(state.sameImage, true, `${label}: photo bytes were replaced`);
    assert.equal(state.ready, true, `${label}: photo flashed a loading placeholder`);
    assert.equal(state.height, state.expectedHeight, `${label}: photo changed shape`);
    assert.equal(state.previews, 1, `${label}: loaded photo fetched again`);
  };
  for (let attempt = 2; attempt <= 4; attempt++) {
    fixture.outbox[0].attempts = attempt;
    await page.evaluate(input => onPayload(input), fixture);
    await checkFrame(`queue update ${attempt}`);
  }
  fixture.outbox.push({ id:"text-send", createdAt:"2026-09-15T09:00:01Z", state:"queued", attempts:0, text:"Text after the image", files:[],
    chat:{ threadId:"room", party:"Test", partyKey:"email:test@example.com" }, recipient:{ email:"test@example.com" } });
  await page.evaluate(input => onPayload(input), fixture);
  await checkFrame("next text send");
  await page.evaluate(() => { window.sentText = document.querySelector('[data-msg="outbox:text-send"] .th-text-content'); });
  fixture.outbox[0].state = "sent";
  fixture.outbox[0].relayId = "photo-relay";
  await page.evaluate(input => onPayload(input), fixture);
  await checkFrame("send acknowledgement");
  fixture.sent.push({ relayId:"photo-relay", threadId:"room", createdAt:"2026-09-15T09:00:05Z", kind:"message", title:"portrait.png",
    forHuman:" ", forAgent:"", recipient:{ name:"Test", email:"test@example.com" }, source:{ host:"relay-preview", clientMessageId:"photo-send" },
    attachments:[{ id:"uploaded-photo", name:"portrait.png", contentType:"image/png", bytes:100 }] });
  fixture.outbox.shift();
  await page.evaluate(input => onPayload(input), fixture);
  await checkFrame("canonical history");
  fixture.sent.push({ relayId:"text-relay", threadId:"another-chain", createdAt:"2026-09-15T09:00:06Z", kind:"message", title:"",
    forHuman:"Text after the image", forAgent:"", recipient:{ name:"Test", email:"test@example.com" }, state:"delivered",
    source:{ host:"relay-preview", clientMessageId:"text-send" } });
  fixture.outbox = [];
  await page.evaluate(input => { liveCanonicalArrivalIds.add("text-relay"); onPayload(input); }, fixture);
  await checkFrame("text canonical echo");
  assert.equal(await page.evaluate(() => sentText.isConnected), true, "sending text survives its canonical echo");
  assert.equal(await page.locator('[data-msg="text-relay"]').evaluate(node => getComputedStyle(node).animationName), "none", "a receipt must not animate an existing bubble in again");
  assert.equal(await page.locator('.th-under .th-seen').last().textContent(), "Delivered");
  // Reading older messages and selecting text must survive routine updates.
  await page.evaluate(() => {
    roomScrollElement().scrollTop = 120;
    window.readingTop = roomScrollElement().scrollTop;
    const range = document.createRange(); range.selectNodeContents(oldText.querySelector(".th-msg-title"));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  for (let refresh = 0; refresh < 3; refresh++) await page.evaluate(input => onPayload(input), fixture);
  assert.deepEqual(await page.evaluate(() => [roomScrollElement().scrollTop, getSelection().toString()]), [await page.evaluate(() => readingTop), "Existing message 0"]);
  await page.evaluate(() => getSelection().removeAllRanges());
  // Retained message controls must not accumulate click handlers on refresh.
  await page.locator('[data-msg="text-relay"] [data-message-more]').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('[data-msg="text-relay"] [data-message-more]').click();
  assert.equal(await page.locator('#message-options-text-relay').evaluate(node => node.matches(":popover-open")), true);
  await page.keyboard.press("Escape");
  await page.locator(".ca-photo").click();
  assert.deepEqual(await page.evaluate(() => viewerCalls.map(args => args.slice(0, 2))), [["photo-relay", "uploaded-photo"]]);

  // Exercise the real composer across delayed IPC. The message is followed
  // when typed, once; a later queue receipt cannot restart that scroll.
  await page.evaluate(() => {
    window.followCalls = 0;
    const follow = scrollRoomToNewest;
    scrollRoomToNewest = (...args) => { window.followCalls++; return follow(...args); };
    window.relay.sendReply = request => { window.sendRequest = request; return new Promise(resolve => window.acceptSend = resolve); };
  });
  await page.locator('#thQrInput').fill("A real composer send");
  await page.locator('#thQrInput').press("Enter");
  await page.waitForFunction(() => Boolean(window.sendRequest) && window.followCalls > 0);
  const initialFollowCalls = await page.evaluate(() => followCalls);
  assert.equal(await page.locator('#thQrInput').evaluate(node => document.activeElement === node), true);
  fixture.outbox = [{ id:await page.evaluate(() => sendRequest.idempotencyKey), createdAt:new Date().toISOString(), state:"queued", text:"A real composer send", files:[],
    chat:{ threadId:"third-chain", party:"Test", partyKey:"email:test@example.com" }, recipient:{ email:"test@example.com" } }];
  fixture.outboxRevision = 1;
  await page.evaluate(input => { onPayload(input); acceptSend({ ok:true, outboxRevision:1, entry:input.outbox[0] }); }, fixture);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => followCalls), initialFollowCalls, "IPC acceptance must not follow the same send twice");
  assert.equal(await page.locator('#thQrInput').evaluate(node => document.activeElement === node), true);
  await checkFrame("composer send with delayed receipt");
  const firstSendKey = fixture.outbox[0].id;
  await page.evaluate(() => { window.sendRequest = null; });
  await page.locator('#thQrInput').fill("A real composer send");
  await page.locator('#thQrInput').press("Enter");
  await page.waitForFunction(() => Boolean(window.sendRequest));
  assert.notEqual(await page.evaluate(() => sendRequest.idempotencyKey), firstSendKey, "a deliberate identical second text gets its own send");
  assert.equal(await page.locator('.th-msg-title').filter({ hasText:"A real composer send" }).count(), 2);
  assert.deepEqual(errors, []);
  console.log("PASS: stable text/photo nodes and dimensions, receipts, selection, reading position, one-time handlers, canonical viewer address, composer focus and one send scroll.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
