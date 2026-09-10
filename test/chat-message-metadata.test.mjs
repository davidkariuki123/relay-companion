import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { createOutbox } = require("../src/outbox.cjs");
const { forLatest } = require("../overlay/read-receipts.cjs");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const section = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const timeSource = section("  function formatChatTime(", "  function formatChatDate(");
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const clockContext = vm.createContext({ esc });
vm.runInContext(timeSource, clockContext);

test("message timestamps use a zero-padded local clock, including midnight and DST", () => {
  const clockIn = (zone, iso) => execFileSync(process.execPath, ["-e",
    `${timeSource}; process.stdout.write(formatChatTime(process.argv[1]));`, iso,
  ], { env:{ ...process.env, TZ:zone }, encoding:"utf8" });
  assert.equal(clockIn("Africa/Johannesburg", "2026-09-10T22:50:53Z"), "00:50");
  assert.equal(clockIn("UTC", "2026-09-10T00:00:00Z"), "00:00");
  assert.equal(clockIn("America/New_York", "2026-07-10T12:05:00Z"), "08:05");
  assert.equal(clockIn("America/New_York", "2026-01-10T12:05:00Z"), "07:05");
  assert.equal(clockIn("Asia/Kathmandu", "2026-09-10T12:05:00Z"), "17:50");
  assert.equal(clockContext.formatChatTime(""), "");
  assert.equal(clockContext.chatTimestampHtml("invalid"), "");
});

test("text and photo timestamps retain the exact instant and an accessible full date", () => {
  for (const className of ["th-blk-time", "th-cargo-time"]) {
    const rendered = clockContext.chatTimestampHtml("2026-09-10T22:50:53Z", className);
    assert.match(rendered, /datetime="2026-09-10T22:50:53\.000Z"/);
    assert.match(rendered, /title="[^"]+"/);
    assert.match(rendered, />\d{2}:\d{2}<\/time>/);
  }
  assert.match(html, /attachmentOnly \? chatTimestampHtml\(m\.at, "th-cargo-time"\)/,
    "a photo-only message needs its own visible timestamp");
  assert.doesNotMatch(html, /class="th-blk-time">\$\{esc\(timeAgo\(m\.at\)\)\}/);
});

test("a real first send stays Sending through refreshes, then becomes Sent and Delivered", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  let finish;
  const queue = createOutbox({ file:path.join(root, "outbox.json"), send:() => new Promise((resolve) => { finish=resolve; }) });
  t.after(() => queue.stop());
  queue.enqueue({ idempotencyKey:"metadata-send", text:"hello", recipient:{ email:"test@example.com" } });
  const flushing = queue.flush();
  const context = vm.createContext({ payload:{ outbox:queue.list() }, optimisticChatReplies:new Map(), esc });
  vm.runInContext(section("  function syncOutboxProjection()", "  // The room composer is wired ONCE"), context);
  vm.runInContext(section("  function outboxStatusBits(", "  function receiptTimestamp("), context);
  for (let refresh=0; refresh<3; refresh++) {
    context.payload.outbox=queue.list();
    context.syncOutboxProjection();
    const message=context.optimisticChatReplies.get("metadata-send");
    assert.equal(message.outboxAttempts, 1);
    assert.equal(message.pending, true);
    assert.match(context.outboxStatusBits(message).join(""), />Sending…</);
    assert.equal(forLatest(message, [message]), null);
  }
  finish({ relayId:"relay_metadata" });
  await flushing;
  context.payload.outbox=queue.list();
  context.syncOutboxProjection();
  const sent=context.optimisticChatReplies.get("metadata-send");
  assert.equal(sent.pending, false);
  assert.equal(forLatest(sent, [sent]).label, "Sent");
  const delivered={ ...sent, delivered:true };
  assert.equal(forLatest(delivered, [delivered]).label, "Delivered");
  assert.doesNotMatch(html, /th-status-settle|th-settling/,
    "refreshing or advancing a receipt must not hide its new DOM node");
});
