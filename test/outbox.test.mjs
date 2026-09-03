// The send outbox: a typed message is committed to the device, not attempted
// once against the network.
//
// The regression these pin: sending into the Granular group on weak wifi showed
// "Sending…" for fifteen seconds, dropped the bubble, and put the words back in
// the composer — so the message did NOT send itself when the connection came
// back (David, 2026-08-20). Every test here is about the queue keeping that
// promise without ever posting the same message twice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutbox, classifySendError, backoffMs, SERVER_DEFERRAL_LIMIT } from "../src/outbox.cjs";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-outbox-test-"));
  return path.join(dir, "outbox.json");
}

/** A fake clock plus a fake transport, so a test owns both time and the network. */
function harness({ file = tempFile(), send } = {}) {
  const state = { now: 1_000_000, sends: [] };
  const outbox = createOutbox({
    file,
    now: () => state.now,
    // Timers are never armed in tests; flush() is called explicitly so the
    // assertions describe the queue's decisions, not setTimeout's.
    scheduleTimer: () => null,
    cancelTimer: () => {},
    send: async (entry) => {
      state.sends.push(entry);
      return send ? send(entry, state) : { relayId: `relay_${state.sends.length}` };
    },
  });
  state.advance = (ms) => { state.now += ms; };
  return { outbox, state, file };
}

const OFFLINE = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.sendrelays.com"), { code: "ENOTFOUND" }) });
const TIMEOUT = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const REJECTED = (status = 400) => Object.assign(new Error("invalid_request"), { status });

function message(over = {}) {
  return {
    idempotencyKey: "pill-reply-1",
    text: "hey room",
    recipient: { groupId: "grp_granular" },
    chat: { threadId: "thread_1", isGroup: true, groupName: "Granular" },
    ...over,
  };
}

test("every way a connection fails is transient; a server's not-now is deferred; a rejected payload is neither", () => {
  // The three shapes undici actually produces, measured against no-DNS, a
  // black-holed route, and a refused port.
  assert.equal(classifySendError(OFFLINE()), "transient");
  assert.equal(classifySendError(TIMEOUT()), "transient");
  assert.equal(classifySendError(new TypeError("fetch failed")), "transient");
  // The server ANSWERED. That is the server's clock, not the network's.
  assert.equal(classifySendError(Object.assign(new Error("gateway"), { status: 502 })), "deferred");
  assert.equal(classifySendError(Object.assign(new Error("slow down"), { status: 429 })), "deferred");

  assert.equal(classifySendError(REJECTED(400)), "permanent");
  assert.equal(classifySendError(REJECTED(401)), "permanent");
  assert.equal(classifySendError(REJECTED(413)), "permanent");
  // An unrecognised failure is permanent on purpose: a payload the server keeps
  // declining must not retry forever behind the rest of the room.
  assert.equal(classifySendError(new Error("something else entirely")), "permanent");
});

test("backoff climbs and then holds, so an overnight outage is not a battery bug", () => {
  assert.equal(backoffMs(1), 1_000);
  assert.equal(backoffMs(3), 8_000);
  assert.ok(backoffMs(20) === backoffMs(50), "the tail is a cap, not a curve");
  assert.ok(backoffMs(50) <= 300_000);
});

test("a message survives the press of Send, on disk, before anything is attempted", () => {
  const { outbox, file } = harness();
  const entry = outbox.enqueue(message());
  assert.equal(entry.state, "queued");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.entries.length, 1, "the queue is durable at enqueue time, not at flush time");
  assert.equal(onDisk.entries[0].text, "hey room");
});

test("an offline send stays queued and sends itself when the network returns", async () => {
  let online = false;
  const { outbox, state } = harness({
    send: () => { if (!online) throw OFFLINE(); return { relayId: "relay_9", groupSendId: "gsend_9", threadId: "thread_1" }; },
  });
  outbox.enqueue(message());

  await outbox.flush();
  let [entry] = outbox.list();
  assert.equal(entry.state, "queued", "the words stay committed — they are NOT handed back to the composer");
  assert.equal(entry.attempts, 1);
  assert.ok(entry.nextAttemptAt > state.now, "a failed attempt schedules the next one");

  // Still offline and not yet due: flushing changes nothing.
  await outbox.flush();
  assert.equal(outbox.list()[0].attempts, 1, "the queue respects its own backoff");

  online = true;
  state.advance(5_000);
  await outbox.flush();
  [entry] = outbox.list();
  assert.equal(entry.state, "sent");
  assert.equal(entry.relayId, "relay_9");
  assert.equal(entry.groupSendId, "gsend_9");
});

test("every attempt carries the SAME idempotency key, so a lost response cannot duplicate the message", async () => {
  let attempts = 0;
  const { outbox, state } = harness({
    send: () => {
      attempts += 1;
      // The dangerous case: the server committed the relay and the response was
      // lost on the way back. The retry must be the same key, not a new send.
      if (attempts < 3) throw TIMEOUT();
      return { relayId: "relay_1" };
    },
  });
  outbox.enqueue(message());
  for (let i = 0; i < 3; i += 1) { await outbox.flush(); state.advance(60_000); }
  assert.equal(attempts, 3);
  assert.equal(new Set(state.sends.map((s) => s.idempotencyKey)).size, 1, "one key across all three attempts");
  assert.equal(outbox.list()[0].state, "sent");
});

test("a rejected payload fails once and is never retried", async () => {
  const { outbox, state } = harness({ send: () => { throw REJECTED(400); } });
  outbox.enqueue(message());
  await outbox.flush();
  state.advance(600_000);
  await outbox.flush();
  const [entry] = outbox.list();
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempts, 1, "a permanent verdict is not re-litigated every five minutes");
  assert.equal(entry.text, "hey room", "the words are still held, so Retry has something to send");
  assert.equal(state.sends.length, 1);
});

test("order is preserved inside a room and never across rooms", async () => {
  const failing = new Set(["pill-reply-1"]);
  const { outbox, state } = harness({
    send: (entry) => { if (failing.has(entry.idempotencyKey)) throw OFFLINE(); return { relayId: `relay_${entry.idempotencyKey}` }; },
  });
  outbox.enqueue(message({ idempotencyKey: "pill-reply-1", text: "first" }));
  outbox.enqueue(message({ idempotencyKey: "pill-reply-2", text: "second" }));
  outbox.enqueue(message({
    idempotencyKey: "pill-reply-3", text: "other room",
    recipient: { email: "shane@example.com" }, chat: { threadId: "thread_2" },
  }));

  await outbox.flush();
  const byKey = Object.fromEntries(outbox.list().map((e) => [e.id, e]));
  assert.equal(byKey["pill-reply-1"].state, "queued");
  assert.equal(byKey["pill-reply-2"].attempts, 0, "the second message in a room waits behind the first");
  assert.equal(byKey["pill-reply-3"].state, "sent", "a stalled room does not hold up a different conversation");

  failing.clear();
  state.advance(10_000);
  await outbox.flush();
  const after = outbox.list();
  assert.equal(after.length, 3);
  assert.deepEqual(
    state.sends.filter((s) => s.chat.threadId === "thread_1").map((s) => s.text),
    ["first", "first", "second"],
    "the room's messages reach the wire in the order they were typed",
  );
});

test("a permanently failed message does not wedge the rest of its room", async () => {
  const { outbox } = harness({
    send: (entry) => { if (entry.text === "bad") throw REJECTED(413); return { relayId: "relay_ok" }; },
  });
  outbox.enqueue(message({ idempotencyKey: "pill-reply-1", text: "bad" }));
  outbox.enqueue(message({ idempotencyKey: "pill-reply-2", text: "good" }));
  await outbox.flush();
  const byKey = Object.fromEntries(outbox.list().map((e) => [e.id, e]));
  assert.equal(byKey["pill-reply-1"].state, "failed");
  assert.equal(byKey["pill-reply-2"].state, "sent", "one rejected message must not close the conversation");
});

test("the queue outlives the app: a restart resumes and sends", async () => {
  const file = tempFile();
  const first = harness({ file, send: () => { throw OFFLINE(); } });
  first.outbox.enqueue(message());
  await first.outbox.flush();
  assert.equal(first.outbox.list()[0].state, "queued");

  // A brand-new process reading the same file — the pill was quit and reopened.
  const second = harness({ file, send: () => ({ relayId: "relay_after_restart" }) });
  assert.equal(second.outbox.list().length, 1, "the queue is read back from disk");
  second.outbox.start();
  await second.outbox.flush();
  assert.equal(second.outbox.list()[0].relayId, "relay_after_restart");
  assert.equal(second.outbox.list()[0].state, "sent");
});

test("an entry retires only once the server's own Sent projection shows it", async () => {
  const { outbox } = harness({ send: () => ({ relayId: "relay_A", groupSendId: "gsend_1" }) });
  outbox.enqueue(message());
  await outbox.flush();
  assert.equal(outbox.list().length, 1, "a sent entry is held until the canonical row lands");

  outbox.retireConfirmed({ relayIds: ["relay_unrelated"], groupSendIds: [] });
  assert.equal(outbox.list().length, 1, "someone else's relay id retires nothing");

  // The group fan-out's response names ONE sibling; the shared groupSendId is
  // what the Sent list collapses on, so that is what retirement must accept.
  outbox.retireConfirmed({ relayIds: [], groupSendIds: ["gsend_1"] });
  assert.equal(outbox.list().length, 0);
});

test("attachment bytes are copied into the queue and released when it retires", async () => {
  const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-outbox-src-")), "photo.png");
  fs.writeFileSync(source, Buffer.from("not really a png"));
  const { outbox } = harness({ send: () => ({ relayId: "relay_A" }) });
  const entry = outbox.enqueue(message({ files: [{ name: "photo.png", size: 16, path: source }] }));

  assert.equal(entry.files.length, 1);
  assert.ok(fs.existsSync(entry.files[0].spoolPath), "the queue holds its own copy of the bytes");
  // The original can vanish — a pasted temp file, a moved download — and the
  // queued send must still be deliverable.
  fs.rmSync(source);
  await outbox.flush();
  assert.ok(fs.existsSync(entry.files[0].spoolPath));

  outbox.retireConfirmed({ relayIds: ["relay_A"] });
  assert.equal(fs.existsSync(entry.files[0].spoolPath), false, "retirement takes the spooled bytes with it");
});

test("attachment spooling is all-or-nothing: a missing file cannot become an empty send", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-outbox-src-"));
  const valid = path.join(dir, "notes.txt");
  fs.writeFileSync(valid, "keep me");
  const { outbox } = harness();

  assert.throws(
    () => outbox.enqueue(message({
      text: "",
      files: [
        { name: "notes.txt", path: valid },
        { name: "missing.mov", path: path.join(dir, "missing.mov") },
      ],
    })),
    /could not attach missing\.mov/i,
  );
  assert.equal(outbox.list().length, 0, "no partial or attachment-free message is committed");
});

test("Retry puts a failed message back in line", async () => {
  let reject = true;
  const { outbox } = harness({ send: () => { if (reject) throw REJECTED(400); return { relayId: "relay_A" }; } });
  outbox.enqueue(message());
  await outbox.flush();
  assert.equal(outbox.list()[0].state, "failed");

  reject = false;
  outbox.retry("pill-reply-1");
  assert.equal(outbox.list()[0].state, "queued");
  await outbox.flush();
  assert.equal(outbox.list()[0].state, "sent");
});

test("pressing Send twice with one key commits one message", () => {
  const { outbox } = harness();
  outbox.enqueue(message());
  outbox.enqueue(message());
  assert.equal(outbox.list().length, 1);
});

test("an accepted message the Sent listing never names is let go, not held forever", async () => {
  const { outbox, state } = harness({ send: () => ({ relayId: "relay_A" }) });
  outbox.enqueue(message());
  await outbox.flush();
  assert.equal(outbox.list()[0].state, "sent");

  // The server ACCEPTED it — that is what earned the state. Holding it on the
  // chance a listing catches up is how the queue file grows without bound.
  outbox.retireConfirmed({ relayIds: ["someone_elses_relay"] });
  assert.equal(outbox.list().length, 1, "not before it has had every chance");

  state.advance(2 * 60 * 60 * 1000);
  outbox.retireConfirmed({ relayIds: ["someone_elses_relay"] });
  assert.equal(outbox.list().length, 0);
});

test("a message still waiting is never let go, however long the outage runs", async () => {
  const { outbox, state } = harness({ send: () => { throw OFFLINE(); } });
  outbox.enqueue(message());
  await outbox.flush();
  state.advance(72 * 60 * 60 * 1000);
  outbox.retireConfirmed({ relayIds: [] });
  assert.equal(outbox.list().length, 1, "three days offline is not a reason to drop someone's message");
  assert.equal(outbox.list()[0].state, "queued");
});

// The regression these two pin: a channel send was answered 502 because one
// member's email fallback could not be sent. The pill treated the 502 as a
// network outage, every Sent poll "resumed" it, and it was retried 908 times in
// seven hours — while the two messages typed after it into the same room sat
// at zero attempts behind it, saying "Sending…" (David, 2026-09-03).
const DEFERRED = () => Object.assign(new Error("Relay could not email this recipient because the email provider rejected the message."), { status: 502 });

test("a server's not-now runs on the server's clock: a poll proving the network is up does not wake it", async () => {
  const { outbox, state } = harness({ send: () => { throw DEFERRED(); } });
  outbox.enqueue(message());
  await outbox.flush();
  let [entry] = outbox.list();
  assert.equal(entry.state, "queued");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.waitingOn, "server");
  const due = entry.nextAttemptAt;
  assert.ok(due > state.now, "the deferral earned a backoff");

  // The Sent poll succeeds a moment later and calls resume(), as it does every
  // few seconds. That says nothing about THIS payload.
  assert.equal(outbox.resume(), 0, "nothing on the server's clock is woken");
  await outbox.flush();
  assert.equal(outbox.list()[0].attempts, 1, "no extra attempt was spent");
  assert.equal(outbox.list()[0].nextAttemptAt, due, "the backoff stands");

  // A message waiting on the NETWORK is still woken by the same evidence.
  const offline = harness({ send: () => { throw OFFLINE(); } });
  offline.outbox.enqueue(message());
  await offline.outbox.flush();
  assert.equal(offline.outbox.list()[0].waitingOn, "network");
  assert.equal(offline.outbox.resume(), 1);
});

test("a server that keeps saying not-now is believed for the ladder, then the message fails with its words", async () => {
  const { outbox, state } = harness({ send: () => { throw DEFERRED(); } });
  outbox.enqueue(message());
  for (let i = 0; i < SERVER_DEFERRAL_LIMIT + 5; i += 1) {
    await outbox.flush();
    state.advance(backoffMs(i + 1) + 1);
  }
  const [entry] = outbox.list();
  assert.equal(entry.state, "failed", "after the ladder the human is told instead of watching Trying again… all day");
  assert.equal(entry.attempts, SERVER_DEFERRAL_LIMIT, "exactly the ladder, and not one attempt more");
  assert.match(entry.lastError, /email provider rejected/, "the server's own reason is kept for the human");
  assert.equal(entry.text, "hey room", "the words are held, so Retry has something to send");
  assert.equal(entry.waitingOn, "");

  // Retry puts it back in line and spends a fresh attempt at once.
  const before = state.sends.length;
  assert.equal(outbox.retry(entry.id), true);
  await outbox.flush();
  assert.equal(state.sends.length, before + 1, "Retry sends again with the same idempotency key");
  assert.equal(state.sends[before].idempotencyKey, entry.idempotencyKey);
  assert.equal(outbox.list()[0].state, "queued", "one more not-now is a deferral again, not an instant failure");
});

test("a message deferred by the server still holds its room in order, and a network wait behind it is not woken past it", async () => {
  let calls = 0;
  const { outbox, state } = harness({ send: () => { calls += 1; throw DEFERRED(); } });
  outbox.enqueue(message({ idempotencyKey: "k1", text: "first" }));
  outbox.enqueue(message({ idempotencyKey: "k2", text: "second" }));
  await outbox.flush();
  assert.equal(calls, 1, "the second waits behind the first in its room");
  assert.equal(outbox.list()[1].attempts, 0);
  outbox.resume();
  await outbox.flush();
  assert.equal(calls, 1, "resume() did not push the room past the deferred head");
  state.advance(backoffMs(1) + 1);
  await outbox.flush();
  assert.equal(calls, 2, "the head is retried on its own clock");
});
