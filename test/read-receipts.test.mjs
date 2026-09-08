import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const receipts = require("../overlay/read-receipts.cjs");
const at = (minute) => `2026-08-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const format = (value) => `t${new Date(value).getUTCMinutes()}`;
const member = (name, minute) => ({ name, seen: minute !== undefined, ...(minute === undefined ? {} : { readAt:at(minute) }) });

test("only the newest outbound message owns the conversation receipt", () => {
  const old = { direction:"out", at:at(0), readReceipts:[member("Shane", 1)] };
  const pending = { direction:"out", at:at(2), pending:true, readReceipts:[] };
  assert.equal(receipts.forLatest(old, [old, pending], format), null);
  assert.equal(receipts.forLatest(pending, [old, pending], format), null);

  const sent = { ...pending, pending:false, readReceipts:[member("Shane", 3)] };
  assert.equal(receipts.forLatest(sent, [old, sent], format).label, "Seen t3");
});

test("partial group receipts name one, two, then collapse the rest", () => {
  const one = { direction:"out", isGroup:true, at:at(0), readReceipts:[member("Shane", 1), member("David")] };
  assert.equal(receipts.forLatest(one, [one], format).label, "Seen by Shane · t1");

  const two = { direction:"out", isGroup:true, at:at(0), readReceipts:[member("Shane", 1), member("David", 2), member("Sven")] };
  assert.equal(receipts.forLatest(two, [two], format).label, "Seen by Shane and David");

  const many = { direction:"out", isGroup:true, at:at(0), readReceipts:[
    member("Shane", 1), member("David", 2), member("Sven", 3), member("Alex", 4),
    member("Jo", 5), member("Lee", 6), member("Morgan", 7), member("Unread"),
  ] };
  assert.equal(receipts.forLatest(many, [many], format).label, "Seen by Shane, David and 5 more");
});

test("an all-read group uses the last first-read timestamp as completion time", () => {
  const message = { direction:"out", isGroup:true, at:at(0), readReceipts:[
    member("David", 2), member("Shane", 9), member("Sven", 4),
  ] };
  const receipt = receipts.forLatest(message, [message], format);
  assert.equal(receipt.label, "Seen by everyone · t9");
  assert.deepEqual(receipt.readers.map((reader) => reader.name), ["David", "Sven", "Shane"]);
  assert.deepEqual(receipt.unread, []);
  assert.equal(receipt.expandable, true);
});

test("the ladder before anyone has read it: Sent, then Delivered", () => {
  // "Sent" alone cannot tell a message sitting in the API from one already on
  // the recipient's device — which is the whole difference a sender is asking
  // about when they look. The server has carried both facts all along
  // (relays.state: pending -> delivered -> read); this is where they surface.
  const sent = { direction:"out", at:at(0), delivered:false, readReceipts:[member("Shane")] };
  assert.equal(receipts.forLatest(sent, [sent], format).label, "Sent");

  const delivered = { ...sent, delivered:true };
  assert.equal(receipts.forLatest(delivered, [delivered], format).label, "Delivered");

  // Read still outranks both, and a delivery rung never offers the group panel.
  assert.equal(receipts.forLatest(delivered, [delivered], format).expandable, false);
  const read = { ...delivered, readReceipts:[member("Shane", 4)] };
  assert.equal(receipts.forLatest(read, [read], format).label, "Seen t4");
});

test("the rung past Seen: their agent opened it", () => {
  // The server's ladder has a fourth rung — acknowledged — set when the
  // recipient's pill hands the relay to an app. A sender reads it as the
  // thing they actually wanted to know (Sven, 2026-09-08). A person who only
  // read it stays at Seen; a group keeps its roster labels.
  const seen = { direction:"out", at:at(0), delivered:true, readReceipts:[member("Shane", 4)] };
  assert.equal(receipts.forLatest(seen, [seen], format).label, "Seen t4");
  const opened = { ...seen, agentOpened:true };
  assert.equal(receipts.forLatest(opened, [opened], format).label, "Their agent opened it");
  const group = { ...opened, isGroup:true, readReceipts:[member("Shane", 4), member("David")] };
  assert.equal(receipts.forLatest(group, [group], format).label, "Seen by Shane · t4");
});

test("every outbound row carries the rung from the sent item's state", () => {
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  assert.match(html, /function sentIsAcknowledged\(r\) \{\s*return String\(\(r && r\.state\) \|\| ""\)\.toLowerCase\(\) === "acknowledged";/);
  assert.match(html, /agentOpened: sentTwin \? sentIsAcknowledged\(sentTwin\) : false,/, "a self-authored inbound twin");
  assert.match(html, /agentOpened: !s\.groupSendId && sentIsAcknowledged\(s\),/, "a sent row");
  assert.match(html, /agentOpened:mine && String\(item\?\.state \|\| ""\)\.toLowerCase\(\) === "acknowledged",/, "a resolved direct-chat row");
});

test("a message still on this device shows no receipt at all", () => {
  // The queue's own words own that bubble ("Sending…", "Trying again…").
  // A receipt here would claim the server has something it does not.
  const queued = { direction:"out", at:at(0), pending:true, delivered:false, readReceipts:[] };
  assert.equal(receipts.forLatest(queued, [queued], format), null);
});
