// Real renderer with mocked IPC. Run with RELAY_PLAYWRIGHT_MODULE pointing at
// Playwright; RELAY_CHROME_EXECUTABLE may point at a local Chrome binary.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RELAY_CHROME_EXECUTABLE ? { executablePath:process.env.RELAY_CHROME_EXECUTABLE } : {}),
});

try {
  const page = await browser.newPage({ viewport:{ width:850, height:850 }, reducedMotion:"reduce" });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const relay = {
      id:"relay-long-paste",
      threadId:"relay-long-paste",
      kind:"message",
      relayNotificationKind:"plain_relay",
      senderName:"Dylan",
      senderEmail:"dylan@example.com",
      forHuman:"Can you send the setup details?",
      forAgent:"",
      title:"",
      unread:false,
      attachments:[],
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    };
    const relayDocument = {
      ...relay,
      id:"relay-document",
      threadId:"relay-document",
      title:"Xpra attach issue",
      forHuman:"Could you check this setup issue?",
      forAgent:"The full troubleshooting context belongs here.",
      createdAt:new Date(Date.now() - 60_000).toISOString(),
      updatedAt:new Date(Date.now() - 60_000).toISOString(),
    };
    const payload = {
      account:{ paired:true, userId:"self", name:"David", email:"david@example.com", hasSentRelay:true },
      ui:{ canDismiss:true, onboardingRequired:false, completedOnboardingVersion:1 },
      features:{}, relays:[relay, relayDocument], sent:[], requests:[], chats:[], slackChats:[], outbox:[],
    };
    window.fixtureCopied = "";
    Object.defineProperty(navigator, "clipboard", { configurable:true, value:{ writeText:async (value) => { window.fixtureCopied = value; } } });
    const api = {
      isTestOverlay:true,
      refresh:async () => structuredClone(payload),
      refreshSent:async () => ({ items:[] }),
      contacts:async () => [{ id:"dylan", name:"Dylan", email:"dylan@example.com" }],
      groups:async () => ({ ok:true, result:[] }),
      accountInfo:async () => payload.account,
      agentSurfaces:async () => ({}),
    };
    window.relay = new Proxy(api, { get:(target, key) => {
      if (key in target) return target[key];
      if (String(key).startsWith("on")) return () => () => {};
      return async () => ({ ok:true });
    } });
  });

  await page.goto(new URL("../overlay/inbox.html", import.meta.url).href);
  await page.locator("#relaysList .relay-arrival").first().click();
  const composer = page.locator("#thQrInput");
  await composer.waitFor();
  const longPaste = [
    "First, connect to the remote Sierra Chart instance and verify the display.",
    "Second, check that SSH authentication succeeds without an interactive password.",
    "Third, confirm that the Xpra session is live on display one hundred.",
    "Fourth, attach from the Mac with the installed Xpra application.",
    "Fifth, if the window stays empty, inspect the remote Sierra process before restarting anything.",
  ].join(" ");
  await composer.evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles:true, cancelable:true, clipboardData:data }));
  }, longPaste);

  const prompt = page.locator(".long-paste-prompt");
  await prompt.waitFor();
  await page.waitForTimeout(50);
  assert.match(await prompt.innerText(), /Ask Claude or Codex to send it to Dylan as a Relay, which will be easier for them to go through\./);
  const geometry = await prompt.evaluate((element) => {
    const promptBox = element.getBoundingClientRect();
    const composerBox = element.closest(".qr").getBoundingClientRect();
    const cardBox = document.getElementById("card").getBoundingClientRect();
    const leftDelta = promptBox.left - composerBox.left;
    const rightDelta = promptBox.right - composerBox.right;
    return {
      leftDelta, rightDelta,
      aligned:Math.abs(leftDelta) <= 4 && Math.abs(rightDelta) <= 4,
      anchored:promptBox.bottom <= composerBox.top,
      contained:promptBox.left >= cardBox.left && promptBox.right <= cardBox.right && promptBox.top >= cardBox.top,
    };
  });
  assert.equal(geometry.aligned, true, JSON.stringify(geometry));
  assert.equal(geometry.anchored, true, JSON.stringify(geometry));
  assert.equal(geometry.contained, true, JSON.stringify(geometry));
  if (process.env.RELAY_LONG_PASTE_SCREENSHOT) await page.locator("#card").screenshot({ path:process.env.RELAY_LONG_PASTE_SCREENSHOT });

  await page.getByRole("button", { name:"Copy for my agent", exact:true }).click();
  assert.equal(await page.evaluate(() => window.fixtureCopied), `Send this to Dylan as a Relay:\n\n${longPaste}`);
  await page.getByRole("button", { name:"Keep as text", exact:true }).click();
  assert.equal(await prompt.count(), 0);

  await composer.evaluate((field) => {
    field.textContent = "Typed words can be arbitrarily long. ".repeat(100);
    field.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:"typed" }));
  });
  assert.equal(await prompt.count(), 0, "typing never triggers the suggestion");

  await page.evaluate(() => openReader("relay-document", "relays"));
  const readerComposer = page.locator("#qrInput");
  await readerComposer.waitFor();
  await readerComposer.evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles:true, cancelable:true, clipboardData:data }));
  }, longPaste);
  const readerPrompt = page.locator("#readerComposer .long-paste-prompt");
  await readerPrompt.waitFor();
  await page.waitForTimeout(50);
  assert.match(await readerPrompt.innerText(), /Ask Claude or Codex to send it to Dylan as a Relay, which will be easier for them to go through\./);
  if (process.env.RELAY_LONG_PASTE_SCREENSHOT) await page.locator("#card").screenshot({ path:process.env.RELAY_LONG_PASTE_SCREENSHOT.replace(/\.png$/, "-reader.png") });
  await readerPrompt.getByRole("button", { name:"Dismiss suggestion", exact:true }).click();
  assert.equal(await readerPrompt.count(), 0);
  assert.deepEqual(errors, []);
  console.log("Long-paste popup passed in room and reader composers: paste-only trigger, exact Dylan copy, anchored geometry, copy action, dismissal and typed-text exclusion.");
} finally {
  await browser.close();
}
