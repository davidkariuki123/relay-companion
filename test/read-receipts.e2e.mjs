// Exercise the complete inbox renderer in an isolated Chromium profile with
// an in-memory bridge. No installed Companion files, account, or sends are used.
// Run: node packages/companion/test/read-receipts.e2e.mjs
// Set RELAY_RECEIPT_HTML to check an unmodified published renderer as a baseline.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const html = process.env.RELAY_RECEIPT_HTML || fileURLToPath(new URL("../overlay/inbox.html", import.meta.url));
const chrome = process.env.RELAY_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-receipt-toggle-"));
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

  await cdp("Emulation.setDeviceMetricsOverride", {width:344, height:700, deviceScaleFactor:1, mobile:false});
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source:`
    window.testErrors = [];
    window.addEventListener('error', (event) => testErrors.push(event.message));
    window.testPayload = { account:{paired:true, userId:'receipt_test', name:'Test', email:'test@example.com'},
      ui:{soundsMuted:true}, features:{}, relays:[], sent:[], chats:[], contacts:[] };
    for (let i = 0; i < 16; i++) {
      for (const [who, name] of [['one', 'First Reader'], ['two', 'Second Reader']]) {
        testPayload.sent.push({relayId:'relay_' + i + '_' + who, threadId:'thread_receipt',
          groupSendId:'send_' + i, recipientGroupName:'Receipt test', recipientGroupId:'grp_receipt',
          createdAt:new Date(Date.now() - (20 - i) * 60000).toISOString(), kind:'message', title:'',
          forHuman:'Test message ' + i, forAgent:'', state:who === 'one' ? 'read' : 'delivered',
          readAt:who === 'one' ? new Date(Date.now() - (19 - i) * 60000).toISOString() : null,
          recipient:{name, email:who + '@example.com'}});
      }
    }
    window.relay = new Proxy({
      platform:'darwin', isTestOverlay:true,
      onInbox:(callback) => window.pushTestPayload = callback,
      refresh:async () => testPayload,
      groups:async () => ({ok:true, result:[]}),
    }, { get:(target, key) => key in target ? target[key] : String(key).startsWith('on')
      ? () => {} : async () => ({ok:true, items:[], contacts:[], groups:[], schedules:[]}) });
  ` });
  await cdp("Page.navigate", { url:pathToFileURL(html).href });
  await until(async () => {
    assert.deepEqual(await evaluate("window.testErrors || []"), []);
    assert.equal(await evaluate("typeof window.__relayMotionTest"), "object");
  });
  await evaluate(`cardEl.classList.remove('offstage', 'bye'); setCollapsed(false);`);
  async function inspect() {
    return evaluate(`(() => {
      const b=document.querySelector('[data-receipt-toggle]'), p=document.querySelector('.th-receipt-panel'), s=roomScrollElement();
      const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
      return {expanded:b?.getAttribute('aria-expanded'), button:b&&rect(b), panel:p&&rect(p), text:p?.textContent,
        scroller:rect(s), scrollTop:s.scrollTop, scrollHeight:s.scrollHeight, clientHeight:s.clientHeight,
        header:rect(document.querySelector('.th-detail-head')), focused:document.activeElement===b,
        dock:rect(document.querySelector('.th-composer-dock')), errors:testErrors};
    })()`);
  }
  async function clickReceipt() {
    const {button}=await inspect();
    const x=(button.left+button.right)/2, y=(button.top+button.bottom)/2;
    assert.equal(await evaluate(`document.elementFromPoint(${x},${y})?.matches('[data-receipt-toggle]')`), true, 'the receipt itself is clickable');
    await cdp('Input.dispatchMouseEvent', {type:'mouseMoved',x,y});
    await cdp('Input.dispatchMouseEvent', {type:'mousePressed',x,y,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',x,y,button:'left',clickCount:1});
    await pause(150);
  }

  function assertVisible(state) {
    assert.equal(state.expanded, 'true');
    assert.ok(state.panel, 'click immediately renders the roster');
    assert.ok(state.panel.bottom <= Math.min(state.scroller.bottom, state.dock.top),
      'the roster must be above the sticky reply dock: ' + JSON.stringify(state));
    assert.ok(state.button.top >= Math.max(state.scroller.top, state.header.bottom), 'the toggle stays visible');
    assert.match(state.text, /First Reader/);
    assert.match(state.text, /Second ReaderNot seen/);
    assert.deepEqual(state.errors, []);
  }
  for (const expanded of [false, true]) {
    await cdp('Emulation.setDeviceMetricsOverride', {width:expanded ? 1000 : 344, height:800, deviceScaleFactor:1, mobile:false});
    await evaluate(`openThreadDetail('thread_receipt', 'Receipt test', 'relays', {expanded:${expanded}});`);
    await until(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-receipt-toggle]'))"), true));
    await pause(800);
    await evaluate(`window.originalComposer=document.getElementById('thQrInput');
      originalComposer.value='Keep this draft'; originalComposer.dispatchEvent(new Event('input'));`);
    const before=await inspect();
    assert.equal(before.expanded,'false');
    assert.ok(before.scrollHeight > before.clientHeight, 'the fixture overflows the conversation');
    await clickReceipt();
    assertVisible(await inspect());
    assert.equal(await evaluate("document.getElementById('thQrInput')===originalComposer && originalComposer.value==='Keep this draft'"),true,
      'revealing receipts preserves the composer and draft');
    if (!expanded && process.env.RELAY_RECEIPT_SHOT) {
      const screenshot=await cdp('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(process.env.RELAY_RECEIPT_SHOT,Buffer.from(screenshot.data,'base64'));
    }
    await evaluate('pushTestPayload(testPayload)');
    await pause(150);
    assertVisible(await inspect());
    await clickReceipt();
    assert.equal((await inspect()).panel,null, 'the second click closes the roster');
    assert.equal((await inspect()).expanded,'false');
    assert.equal((await inspect()).focused,true, 'the replacement toggle retains keyboard focus');
    // Native keyboard activation must keep working after the rows are rebuilt.
    for (const key of ['Enter', ' ']) {
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',text:key==='Enter'?'\r':' ',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:key==='Enter'?13:32});
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:key==='Enter'?13:32});
      await pause(150);
      if (key==='Enter') assertVisible(await inspect());
      else assert.equal((await inspect()).panel,null, 'Space closes the same receipt');
      assert.equal((await inspect()).focused,true);
    }
  }
  // A receipt can precede newer inbound messages. Reveal that receipt rather
  // than jumping to the newest message and losing the thing just selected.
  await cdp('Emulation.setDeviceMetricsOverride', {width:344,height:700,deviceScaleFactor:1,mobile:false});
  await evaluate(`for(let i=0;i<10;i++) testPayload.relays.push({id:'inbound_'+i,threadId:'thread_receipt',
    recipientGroupName:'Receipt test',recipientGroupId:'grp_receipt',senderName:'First Reader',senderEmail:'one@example.com',
    relayNotificationKind:'plain_relay',forHuman:'Later incoming message '+i,title:'',forAgent:'',unread:false,
    createdAt:new Date(Date.now()+i*60000).toISOString()});
    pushTestPayload(testPayload); openThreadDetail('thread_receipt','Receipt test','relays');`);
  await pause(800);
  await evaluate(`const s=roomScrollElement(),b=document.querySelector('[data-receipt-toggle]');
    s.scrollTop+=b.getBoundingClientRect().bottom-document.querySelector('.th-composer-dock').getBoundingClientRect().top+4;`);
  await pause(100);
  await clickReceipt();
  const middle=await inspect();
  assertVisible(middle);
  assert.ok(middle.scrollTop+middle.clientHeight < middle.scrollHeight-100, 'newer inbound messages stay below the chosen receipt');
  await clickReceipt();
  // A roster taller than the viewport starts at its toggle and first reader;
  // do not scroll straight past the first people merely to expose its bottom.
  await evaluate(`const latest=testPayload.sent.find(item=>item.relayId==='relay_15_one');
    for(let i=0;i<30;i++) testPayload.sent.push({...latest,relayId:'large_'+i,state:'delivered',readAt:null,
      recipient:{name:'Reader '+i,email:'reader'+i+'@example.com'}});
    pushTestPayload(testPayload);`);
  await pause(150);
  await clickReceipt();
  const large=await inspect();
  assert.equal(large.expanded,'true');
  assert.ok(large.panel.height>large.dock.top-large.scroller.top,'the roster exceeds the viewport');
  assert.ok(large.button.top>=Math.max(large.scroller.top,large.header.bottom),'the large roster starts with its toggle');
  assert.ok(large.panel.top<large.dock.top,'the first reader is immediately visible');
  assert.deepEqual(large.errors,[]);
  console.log('PASS: receipt visibility, toggle, keyboard, draft, refresh, compact/expanded rooms, later messages and large rosters');
} finally {
  socket?.close();
  child.kill();
  await new Promise((resolve) => child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve());
  fs.rmSync(profile, { recursive:true, force:true });
}
