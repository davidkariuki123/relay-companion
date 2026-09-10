// Exercise the complete inbox renderer in an isolated Chromium profile with
// an in-memory bridge. No installed Companion files, account, or sends are used.
// Run: node packages/companion/test/reader-composer-focus.e2e.mjs
// Set RELAY_READER_HTML to check an unmodified published renderer as a baseline.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const html = process.env.RELAY_READER_HTML || fileURLToPath(new URL("../overlay/inbox.html", import.meta.url));
const chrome = process.env.RELAY_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reader-focus-"));
const child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], { stdio:"ignore" });
let socket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  let last;
  for (let i = 0; i < 100; i++) {
    try { return await fn(); } catch (error) { last = error; await pause(100); }
  }
  throw last;
}
try {
  const port = await until(() => fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  };
  function cdp(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source:`
    window.testErrors = [];
    window.addEventListener('error', (event) => testErrors.push(event.message));
    window.testRow = { id:'focus_one', threadId:'focus_one', relayNotificationKind:'plain_relay',
      senderName:'Test Sender', senderEmail:'sender@example.com', title:'Composer focus regression',
      forHuman:'A synthetic letter to exercise background refreshes.', forAgent:'Synthetic details.',
      unread:false, createdAt:'2026-09-10T08:00:00Z' };
    window.testPayload = { account:{paired:true, userId:'focus_test', name:'Test', email:'test@example.com'},
      ui:{soundsMuted:true}, features:{}, relays:[testRow], sent:[], chats:[], contacts:[] };
    window.testCalls = [];
    window.relay = new Proxy({
      platform:'darwin', isTestOverlay:true,
      onInbox:(callback) => window.pushTestPayload = callback,
      refresh:async () => testPayload,
      sendReply:(request) => { testCalls.push(request); return new Promise((resolve) => window.finishTestSend = resolve); },
    }, { get:(target, key) => key in target ? target[key] : String(key).startsWith('on')
      ? () => {} : async () => ({ok:true, items:[], contacts:[], groups:[], schedules:[]}) });
  ` });
  await cdp("Page.navigate", { url:pathToFileURL(html).href });
  await until(async () => {
    assert.deepEqual(await evaluate("window.testErrors || []"), []);
    assert.equal(await evaluate("typeof window.__relayMotionTest"), "object");
  });
  await evaluate(`cardEl.classList.remove('offstage', 'bye'); setCollapsed(false); openReader(testRow.id, 'relays');`);
  await until(async () => assert.equal(await evaluate("Boolean(document.getElementById('qrInput'))"), true));
  await pause(600);
  await evaluate(`window.originalInput = document.getElementById('qrInput'); originalInput.focus();`);
  await cdp("Input.insertText", { text:"first draft to keep typing" });
  if (process.env.RELAY_FOCUS_SHOT) {
    const screenshot = await cdp("Page.captureScreenshot", { format:"png" });
    fs.writeFileSync(process.env.RELAY_FOCUS_SHOT, Buffer.from(screenshot.data, "base64"));
  }
  await evaluate(`originalInput.setSelectionRange(6, 11, 'backward');`);
  const before = await evaluate(`({value:originalInput.value, start:originalInput.selectionStart,
    end:originalInput.selectionEnd, direction:originalInput.selectionDirection})`);
  for (let i = 1; i <= 4; i++) {
    await evaluate(`testRow.forHuman = 'Background update ${i}'; pushTestPayload(testPayload);`);
    assert.equal(await evaluate("document.activeElement === originalInput"), true, "background refresh must retain the focused node");
    assert.equal(await evaluate("document.getElementById('qrInput') === originalInput"), true, "the composer must stay connected");
    assert.deepEqual(await evaluate(`({value:originalInput.value, start:originalInput.selectionStart,
      end:originalInput.selectionEnd, direction:originalInput.selectionDirection})`), before, "draft and selection survive refresh");
    assert.equal(await evaluate(`document.querySelector('.rd-body').textContent`), `Background update ${i}`, "the letter still updates while typing");
    await pause(100);
  }
  await cdp("Input.insertText", { text:"message" });
  assert.equal(await evaluate("originalInput.value"), "first message to keep typing", "typing continues without another click");
  await evaluate(`document.querySelector('[data-rd-details]').click();`);
  assert.equal(await evaluate("document.getElementById('qrInput') === originalInput"), true, "Details leaves the composer intact");
  await evaluate(`document.getElementById('readerBack').focus(); testRow.forHuman='Another update'; pushTestPayload(testPayload);`);
  assert.equal(await evaluate("document.activeElement === originalInput"), false, "refresh must not steal focus back from another control");
  await evaluate(`originalInput.focus();`);
  await cdp("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13 });
  await evaluate(`testRow.senderName='Renamed Sender'; pushTestPayload(testPayload);`);
  assert.equal(await evaluate("document.getElementById('qrSend').disabled"), true, "refresh retains the pending send lock");
  await cdp("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13 });
  assert.equal(await evaluate("testCalls.length"), 1, "refresh must not allow a duplicate send");
  await evaluate(`finishTestSend({ok:true});`);
  await until(async () => assert.equal(await evaluate("originalInput.value"), ""));
  assert.equal(await evaluate("document.activeElement === originalInput"), true, "sending retains focus");
  await cdp("Input.insertText", { text:"second message" });
  await cdp("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13 });
  assert.equal(await evaluate("testCalls.length"), 2, "each Enter sends exactly once after repeated refreshes");
  assert.equal(await evaluate("testCalls[1].chat.party"), "Renamed Sender", "retained handlers use the current recipient context");
  await evaluate(`finishTestSend({ok:false, error:'Synthetic save failure'});`);
  assert.equal(await evaluate("originalInput.value"), "second message", "a failed send keeps the draft");
  await evaluate(`testPayload.relays.push({...testRow, id:'focus_two', threadId:'focus_two', senderName:'Another Sender'});
    pushTestPayload(testPayload); openReader('focus_two', 'relays');`);
  assert.equal(await evaluate("document.getElementById('qrInput') === originalInput"), false, "another Relay gets its own composer");
  assert.equal(await evaluate("document.getElementById('qrInput').value"), "", "drafts never cross recipients");
  await evaluate(`openReader('focus_one', 'relays');`);
  assert.equal(await evaluate("document.getElementById('qrInput').value"), "second message", "returning restores the correct draft");
  assert.deepEqual(await evaluate("testErrors"), [], "renderer has no uncaught errors");
  console.log("PASS: reader refresh, selection, continued typing, Details, send deduplication, failure and navigation");
} finally {
  socket?.close();
  child.kill();
  await new Promise((resolve) => child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve());
  fs.rmSync(profile, { recursive:true, force:true });
}
