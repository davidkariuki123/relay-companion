// The relay channel primitive: exactly-once event queue + presence heartbeats.
// The MCP wire (notifications/claude/channel) is exercised in a live session;
// these tests pin the filesystem contract the pill and the server share.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  channelInstanceAlive,
  liveChannelInstanceForCwd,
  channelPresenceDir,
  channelQueueDir,
  enqueueChannelEvent,
} from "../src/channel-server.js";

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-channel-"));
}

test("enqueueChannelEvent writes a consume-once event file into the queue", () => {
  const h = home();
  const file = enqueueChannelEvent(h, { content: "Open relay relay_x", meta: { relayId: "relay_x" } });
  assert.ok(file.startsWith(channelQueueDir(h)));
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(payload.content, "Open relay relay_x");
  assert.equal(payload.meta.relayId, "relay_x");
  assert.ok(payload.createdAt);
  assert.throws(() => enqueueChannelEvent(h, { content: "   " }), /requires content/);
});

test("channelInstanceAlive is false with no presence, true with a fresh heartbeat, false when stale", () => {
  const h = home();
  assert.equal(channelInstanceAlive(h), false);
  fs.mkdirSync(channelPresenceDir(h), { recursive: true });
  const p = path.join(channelPresenceDir(h), "1234.json");
  fs.writeFileSync(p, JSON.stringify({ pid: 1234, heartbeatAt: Date.now() }));
  assert.equal(channelInstanceAlive(h), true);
  fs.writeFileSync(p, JSON.stringify({ pid: 1234, heartbeatAt: Date.now() - 10 * 60 * 1000 }));
  assert.equal(channelInstanceAlive(h), false);
});


test("liveChannelInstanceForCwd joins uniquely by cwd and rejects ambiguity", () => {
  const h = home();
  fs.mkdirSync(channelPresenceDir(h), { recursive: true });
  const write = (pid, cwd, at = Date.now()) =>
    fs.writeFileSync(path.join(channelPresenceDir(h), `${pid}.json`), JSON.stringify({ pid, cwd, heartbeatAt: at }));
  write(1, "/Users/u/projects/alpha");
  write(2, "/Users/u/projects/beta");
  assert.equal(liveChannelInstanceForCwd(h, "/Users/u/projects/alpha").pid, 1);
  assert.equal(liveChannelInstanceForCwd(h, "/Users/u/projects/alpha/").pid, 1, "trailing slash tolerated");
  assert.equal(liveChannelInstanceForCwd(h, "/Users/u/projects/gamma"), null);
  assert.equal(liveChannelInstanceForCwd(h, ""), null);
  write(3, "/Users/u/projects/alpha"); // second live instance in the same cwd
  assert.equal(liveChannelInstanceForCwd(h, "/Users/u/projects/alpha"), null, "ambiguous cwd -> no wake");
  write(9, "/Users/u/projects/stale", Date.now() - 10 * 60 * 1000);
  assert.equal(liveChannelInstanceForCwd(h, "/Users/u/projects/stale"), null, "stale heartbeat ignored");
});

// ---- per-chat addressing: a wake must reach ONE chat --------------------
import { channelWakeAvailable, drainChannelEvents, writeChannelBeacon } from "../src/channel-server.js";

test("an addressed event is claimed only by the chat it names", () => {
  const h = home();
  enqueueChannelEvent(h, { content: "for A", targetCliPid: 111 });
  enqueueChannelEvent(h, { content: "for B", targetCliPid: 222 });
  enqueueChannelEvent(h, { content: "broadcast" });
  // B drains first: it takes its OWN event and the unaddressed broadcast (first
  // taker wins), but it must never be able to take A's — that private
  // addressing is what stops a wake surfacing in the wrong chat.
  const b = drainChannelEvents(h, { cliPid: 222 }).map((e) => e.content).sort();
  assert.deepEqual(b, ["broadcast", "for B"]);
  assert.deepEqual(drainChannelEvents(h, { cliPid: 111 }).map((e) => e.content), ["for A"]);
  assert.deepEqual(drainChannelEvents(h, { cliPid: 999 }), [], "an unrelated chat gets nothing");
});

test("the beacon says whether a chat can be woken right now", () => {
  const h = home();
  assert.equal(channelWakeAvailable(h, 4242), false, "no beacon -> no promise of a wake");
  writeChannelBeacon(h, 4242);
  assert.equal(channelWakeAvailable(h, 4242), true);
  // A stale beacon (server died) must not promise a wake either.
  writeChannelBeacon(h, 4242, { nowMs: Date.now() - 10 * 60 * 1000 });
  assert.equal(channelWakeAvailable(h, 4242), false);
  assert.equal(channelWakeAvailable(h, 0), false);
});
