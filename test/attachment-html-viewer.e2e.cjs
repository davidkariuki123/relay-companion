"use strict";

// Standalone renderer test, NOT a Companion installation. No account, daemon,
// network API or ~/.relay state. Exercises the real window factory/security,
// preload, renderer, HTML reader and optional exact exported design file.
// Run: <electron binary> test/attachment-html-viewer.e2e.cjs [design.html] [screenshot.png]
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const http = require("node:http");
const { htmlViewerContent } = require("../overlay/attachment-html-preview.cjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-html-viewer-e2e-"));
app.setPath("userData", path.join(temp, "userdata"));
const overlay = path.resolve(__dirname, "../overlay");
const main = fs.readFileSync(path.join(overlay, "main.cjs"), "utf8");
const factory = main.slice(main.indexOf("function createAttachmentViewerWindow(key)"), main.indexOf("function sendAttachmentViewerPayload"));
const viewers = new Map();
let entry;
let result;
const actions = [];
const requests = [];
const server = http.createServer((req, res) => { requests.push(req.url); res.end("unexpected"); });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); }
  throw new Error("Timed out waiting for viewer");
}
async function inspect(selector, expression) {
  // Chromium correctly refuses executeJavaScript in a no-scripts sandbox.
  // Test-only DevTools inspection uses a separate isolated world, never a
  // permission added to the attachment or to the production renderer.
  const debug = entry.win.webContents.debugger;
  if (!debug.isAttached()) debug.attach("1.3");
  const { targetInfos } = await debug.sendCommand("Target.getTargets");
  for (const target of targetInfos.filter((t) => t.type === "iframe")) {
    const { sessionId } = await debug.sendCommand("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      const tree = (await debug.sendCommand("Page.getFrameTree", {}, sessionId)).frameTree;
      const walk = (node) => [node.frame, ...(node.childFrames || []).flatMap(walk)];
      for (const node of walk(tree)) {
        if (node.url !== "about:srcdoc" && !node.url.startsWith("data:text/html")) continue;
        const { executionContextId } = await debug.sendCommand("Page.createIsolatedWorld", { frameId: node.id, worldName: "relay-test-inspection" }, sessionId);
        const match = await debug.sendCommand("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(selector)})`, contextId: executionContextId, returnByValue: true }, sessionId);
        if (!match.result.value) continue;
        const evaluated = await debug.sendCommand("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true }, sessionId);
        if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
        return evaluated.result.value;
      }
    } finally { await debug.sendCommand("Target.detachFromTarget", { sessionId }); }
  }
  throw new Error(`No sandbox frame matched ${selector}`);
}
const trusted = (event) => event.sender === entry.win.webContents && event.senderFrame === event.sender.mainFrame;
ipcMain.on("relay:viewer:ready", () => {});
ipcMain.handle("relay:viewer:item", (event) => {
  assert.ok(trusted(event));
  if (result.fileUrl) entry.allowedFiles.add(result.fileUrl);
  return result;
});
for (const channel of ["download", "reveal", "openDefault"]) {
  ipcMain.handle(`relay:viewer:${channel}`, (event, ...args) => { assert.ok(trusted(event)); actions.push({ channel, args }); return { ok: true }; });
}

async function display(body, name = "design.html") {
  const target = path.join(temp, name);
  fs.writeFileSync(target, body);
  result = await htmlViewerContent({ name, contentType: "text/html", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") }, target, temp);
  assert.equal(result.kind, "html", result.previewReason);
  entry.win.webContents.send("relay:viewer:content", { theme: "dark", kind: "file", items: [{ relayId: "relay_fixture", attachmentId: randomUUID(), name, sender: "You" }], index: 0 });
  await until(async () => (await entry.win.webContents.executeJavaScript("!document.getElementById('vHtml').hidden && document.getElementById('vHtml').getAttribute('srcdoc')?.length > 0")));
  await delay(300);
  return entry.win.webContents.mainFrame.frames.find((frame) => frame.url === "about:srcdoc");
}

(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remote = `http://127.0.0.1:${server.address().port}`;
  const create = new Function("BrowserWindow", "createCompanionWindow", "nextCascadeSlot", "attachmentViewerPosition", "VIEWER_WIN", "VIEWER_BACKGROUND", "path", "__dirname", "randomUUID", "attachmentViewers", "pathToFileURL", "resetWindowZoom", "sendAttachmentViewerPayload", `${factory}; return createAttachmentViewerWindow;`)(
    BrowserWindow, (Type, options) => new Type(options), () => 0, () => ({}),
    { width: 1100, height: 850, minWidth: 480, minHeight: 360 }, "#221E1B", path, overlay, randomUUID, viewers, pathToFileURL, () => {}, () => {},
  );
  entry = create("file:test");
  await until(() => !entry.win.webContents.isLoading());
  await delay(200);
  const nested = `<style>h1{color:rgb(143,176,192)}</style><h1 id="nested">Nested design</h1><script>document.body.dataset.ran='yes';fetch('${remote}/nested-script')</script><img src="${remote}/nested-image">`;
  const escapeAttr = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const attack = `<!-- misleading <head> --><!doctype html><html><body><h1 id="visible">Rendered HTML</h1><script>document.body.dataset.ran='yes';parent.relayViewer.download([]);fetch('${remote}/script')</script><img src="${remote}/image"><link rel="stylesheet" href="${remote}/style"><iframe src="${remote}/frame"></iframe><iframe srcdoc="${escapeAttr(nested)}"></iframe><a id="network" href="${remote}/link">Network</a><a id="file" href="file:///etc/passwd">Local file</a><form action="${remote}/form"><button>Submit</button></form></body></html>`;
  let frame = await display(attack);
  assert.ok(frame);
  const security = await inspect("#visible", "({text:document.getElementById('visible').textContent,ran:document.body.dataset.ran,bridge:typeof window.relayViewer, parentBlocked:(()=>{try{return typeof parent.relayViewer==='undefined'}catch{return true}})()})");
  assert.equal(security.text, "Rendered HTML");
  assert.equal(security.ran, undefined);
  assert.equal(security.bridge, "undefined");
  assert.equal(security.parentBlocked, true);
  const child = frame.frames.find((f) => f.url === "about:srcdoc");
  assert.ok(child, "nested srcdoc must render");
  assert.deepEqual(await inspect("#nested", "({color:getComputedStyle(document.getElementById('nested')).color,ran:document.body.dataset.ran ?? null})"), { color: "rgb(143, 176, 192)", ran: null });
  await inspect("#network", "document.getElementById('network').click();document.querySelector('form').requestSubmit()");
  await delay(150);
  assert.deepEqual(requests, [], "network navigation is refused before any request");
  frame = await display(attack);
  await inspect("#file", "document.getElementById('file').click()");
  await delay(150);
  assert.equal(frame.url, "about:srcdoc");
  assert.deepEqual(requests, [], "zero network requests escaped");
  assert.deepEqual(actions, [], "attachment scripts never reached a native action");
  // The viewer's own explicit actions continue to target the attachment.
  await entry.win.webContents.executeJavaScript("document.getElementById('vDownload').click();document.getElementById('vReveal').click();document.getElementById('vMore').click();Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Open in default app').click()");
  await until(() => actions.length === 3);
  assert.deepEqual(actions.map((a) => a.channel), ["download", "reveal", "openDefault"]);
  assert.equal(actions[0].args[0][0].relayId, "relay_fixture");
  const dataHtml = `<h1 id="dataFrame">Embedded data HTML</h1><script>document.body.dataset.ran='yes';fetch('${remote}/data-script')</script><img src="${remote}/data-image">`;
  frame = await display(`<!doctype html><iframe src="data:text/html;base64,${Buffer.from(dataHtml).toString("base64")}"></iframe>`);
  assert.deepEqual(await inspect("#dataFrame", "({text:document.getElementById('dataFrame').textContent,ran:document.body.dataset.ran ?? null})"), { text: "Embedded data HTML", ran: null });
  assert.deepEqual(requests, []);
  console.log("PASS real viewer: HTML, nested styles, scripts blocked, bridge isolation, network/forms/navigation blocked, explicit actions intact");

  // Retarget the same real viewer across its pre-existing content types.
  const sendResult = (content, kind = "file") => {
    result = content;
    entry.win.webContents.send("relay:viewer:content", { theme: "dark", kind, items: [{ relayId: "relay_fixture", attachmentId: randomUUID(), name: content.name }], index: 0 });
  };
  sendResult({ ok: true, kind: "text", name: "log.txt", size: 6, total: 1, lines: [{ n: 1, text: "hello", trouble: false }] });
  await until(() => entry.win.webContents.executeJavaScript("!document.getElementById('vText').hidden && document.getElementById('vText').textContent.includes('hello')"));
  assert.equal(await entry.win.webContents.executeJavaScript("document.getElementById('vHtml').hasAttribute('srcdoc')"), false);
  sendResult({ ok: true, kind: "none", name: "large.html", size: 11 * 1024 * 1024, previewReason: "HTML preview is limited to 10 MB" });
  await until(() => entry.win.webContents.executeJavaScript("!document.getElementById('vNone').hidden && document.getElementById('vNoneWhat').textContent.includes('limited to 10 MB')"));
  const png = path.join(temp, "pixel.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"));
  sendResult({ ok: true, kind: "image", name: "pixel.png", size: fs.statSync(png).size, fileUrl: pathToFileURL(png).href }, "image");
  await until(() => entry.win.webContents.executeJavaScript("!document.getElementById('vStage').hidden && document.getElementById('vImage').naturalWidth === 1"));
  const pdf = path.join(temp, "sample.pdf");
  const stream = "BT /F1 24 Tf 50 150 Td (PDF still renders) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdfBody = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdfBody)); pdfBody += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdfBody);
  pdfBody += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(pdf, pdfBody);
  sendResult({ ok: true, kind: "pdf", name: "sample.pdf", size: Buffer.byteLength(pdfBody), fileUrl: pathToFileURL(pdf).href });
  await until(() => entry.win.webContents.executeJavaScript("!document.getElementById('vPdf').hidden"));
  await until(() => entry.win.webContents.mainFrame.frames.some((f) => f.url.startsWith(pathToFileURL(pdf).href)));
  await delay(500);
  const pdfFrame = entry.win.webContents.mainFrame.frames.find((f) => f.url.startsWith(pathToFileURL(pdf).href));
  assert.equal(await pdfFrame.executeJavaScript("document.contentType"), "application/pdf");
  console.log("PASS regressions: text, honest oversized fallback, image pixels, local Chromium PDF");

  const source = process.argv[2];
  if (source) {
    const body = fs.readFileSync(path.resolve(source), "utf8");
    frame = await display(body, "actual-design.html");
    await delay(400);
    assert.equal(frame.frames.length, 2, "both actual design snapshots rendered");
    const texts = [await inspect("#settingsView:not(.hidden)", "document.body.innerText"), await inspect("#thHistory[data-shell-key]", "document.body.innerText")];
    assert.ok(texts.some((text) => text.includes("Your invite link") && text.includes("Claude Code") && text.includes("Other")));
    assert.ok(texts.some((text) => text.includes("Or tell your agent this:") && text.includes("Copy this prompt for your agent")));
    if (!body.includes("[Truncated]")) {
      const toggle = await inspect("#settingsView:not(.hidden)", "({width:document.getElementById('svOtherAgent').getBoundingClientRect().width,background:getComputedStyle(document.getElementById('svOtherAgent')).backgroundColor})");
      assert.equal(toggle.width, 34);
      assert.equal(toggle.background, "rgb(143, 176, 192)");
    }
    // Equivalent to a person scrolling the two independent pill panes.
    await inspect("#settingsView:not(.hidden)", "document.getElementById('scroll').scrollTop=80");
    await inspect("#thHistory[data-shell-key]", "document.getElementById('scroll').scrollTop=193");
    await delay(100);
    if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), (await entry.win.webContents.capturePage()).toPNG());
    console.log(`PASS exact design: ${Buffer.byteLength(body)} bytes, both settings and Relay snapshots present`);
  }
  assert.deepEqual(requests, []);
  entry.win.destroy();
  server.close();
  app.quit();
})().catch((error) => { console.error(error); server.close(); app.exit(1); });
app.on("will-quit", () => fs.rmSync(temp, { recursive: true, force: true }));
setTimeout(() => { console.error("HTML viewer test timeout"); app.exit(1); }, 25000).unref();
