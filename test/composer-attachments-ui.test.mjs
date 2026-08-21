import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const inbox = read("../overlay/inbox.html");
const main = read("../overlay/main.cjs");
const previewHtml = read("../overlay/preview.html");
const previewRenderer = read("../overlay/preview-renderer.js");
const previewPreload = read("../overlay/preview-preload-source.cjs");

test("the pill enables attachments and accepts every clipboard File representation", () => {
  assert.match(inbox, /const COMPOSER_ATTACHMENTS_ENABLED = true;/);
  assert.match(inbox, /function clipboardFiles\(event\)/);
  assert.match(inbox, /clipboard\?\.files/);
  assert.match(inbox, /clipboard\?\.items/);
  assert.match(inbox, /getAsFile\(\)/);
  assert.match(inbox, /field\.addEventListener\("paste"/);
  assert.match(inbox, /const files = clipboardFiles\(e\)/);
  assert.match(inbox, /stageFileList\(field, files\)/);
});

test("the pill stages picker and dropped files, and serializes them through one bounded helper", () => {
  assert.match(inbox, /aria-label", "Attach files"/);
  assert.match(inbox, /picker\.multiple = true/);
  assert.match(inbox, /field\.addEventListener\("drop"/);
  assert.match(inbox, /composerFilePayloads\(staged\)/);
  const roomSend = between(inbox, "const doThReply = async () =>", "threadComposerSend = doThReply");
  assert.match(roomSend, /\(\{ files, attachments \} = await composerFilePayloads\(staged\)\)/);
  assert.doesNotMatch(roomSend, /for \(let i = 0; i < bytes\.length; i \+= 1\)/);
  assert.match(roomSend, /attachments,/);
});

test("the pop-out person and group composer has attachment parity", () => {
  for (const id of ["replyAttachButton", "replyFilePicker", "replyFiles"]) {
    assert.match(previewHtml, new RegExp(`id="${id}"`));
  }
  assert.match(previewRenderer, /replyInputEl\.addEventListener\("paste"/);
  assert.match(previewRenderer, /replyInputEl\.addEventListener\("drop"/);
  assert.match(previewRenderer, /replyFilePickerEl\.addEventListener\("change"/);
  assert.match(previewRenderer, /bridge\.sendReply\(targetId, body, entry\.idempotencyKey, entry\.files\)/);
  assert.match(previewRenderer, /attachments: out\.attachments \|\| \[\]/);
});

test("the pop-out bridge carries only normalized file primitives and main prepares them safely", () => {
  assert.match(previewPreload, /const \{ contextBridge, ipcRenderer, webUtils \} = require\("electron"\)/);
  assert.match(previewPreload, /pathForFile:/);
  assert.match(previewPreload, /files: normalizedReplyFiles\(files\)/);
  const send = between(main, "async function sendPreviewReply", "function agentWorkEnabledForRow");
  assert.match(send, /const files = Array\.isArray\(input && input\.files\)/);
  assert.match(send, /prepareOrdinaryRelayAttachments\(\{ files: localFiles, idempotencyKey \}\)/);
  assert.match(send, /attachments,/);
  assert.match(send, /forHuman: body \|\| " "/);
});

test("attachment identity is scoped to the message idempotency key", () => {
  const transport = between(main, "async function postQueuedRelay", "function enqueueReplyFromPill");
  assert.match(transport, /prepareOrdinaryRelayAttachments\(\{\s*idempotencyKey: entry\.idempotencyKey,/);
  assert.match(transport, /trustedLocalRoot:/);
});
