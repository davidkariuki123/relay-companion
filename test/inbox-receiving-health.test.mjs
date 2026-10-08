// A service that is alive but no longer RECEIVING must never pass for healthy
// (ao1, 2026-10-08): a stalled inbox worker left a fresh heartbeat for 18 hours,
// the pill trusted its stale local copy, and history people had read vanished
// until the worker caught up. Evidence, judgement and self-repair are pinned here.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { createInboxHealth, inboxHealthPath } from "../src/inbox-health.js";
import { startReceiverWorker } from "../src/inbox-receiver-worker.js";
import { secureRelayApiUrl } from "../src/client.js";
import { apiUrl } from "../src/config.js";

const require = createRequire(import.meta.url);
const liveness = require("../src/pill-liveness.cjs");

test("the worker's evidence file lives beside the daemon heartbeat", () => {
  assert.equal(inboxHealthPath("/h"), "/h/.relay/recovery/inbox.json");
  assert.equal(liveness.inboxHealthPath("/h"), inboxHealthPath("/h"));
});

test("health records receiving, failing and unbound, writing promptly on change and sparingly otherwise", () => {
  let t = 1000;
  const writes = [];
  const health = createInboxHealth({ homeDir: "/h", now: () => t, pid: 7, writeFile: (file, data) => writes.push([file, data]) });
  health.received();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].state, "receiving");
  assert.equal(writes[0][1].okAt, 1000);
  t += 1000; health.received();
  assert.equal(writes.length, 1, "an unchanged state is not rewritten every refresh");
  t += 5000; health.received();
  assert.equal(writes.length, 2);
  health.failed("fetch failed");
  assert.equal(writes.at(-1)[1].state, "failing");
  assert.equal(writes.at(-1)[1].failingSince, t);
  health.unbound("account-changed");
  assert.deepEqual([writes.at(-1)[1].state, writes.at(-1)[1].reason, writes.at(-1)[1].pid], ["unbound", "account-changed", 7]);
});

test("the pill calls a fresh service that has not received for two minutes not receiving", () => {
  const now = 10_000_000;
  const heartbeat = { pid: 5, at: now - 1000, awakeSince: now - 60 * 60_000 };
  const decide = (inbox, hb = heartbeat) => liveness.inboxReceiveDecision({ inbox, heartbeat: hb, now });
  assert.equal(decide({ schema: 1, pid: 5, state: "receiving", okAt: now - 5000 }).receiving, true);
  const stalled = decide({ schema: 1, pid: 5, state: "receiving", okAt: now - 18 * 60 * 60_000 });
  assert.equal(stalled.receiving, false);
  assert.equal(stalled.reason, "not-receiving");
  assert.equal(decide({ schema: 1, pid: 5, state: "unbound", reason: "account-changed", okAt: 0 }).reason, "unbound:account-changed");
  // No evidence is not a verdict: an older service writes no file, and a file
  // from a process that has since been replaced says nothing about this one.
  assert.deepEqual(decide(null), { receiving: true, reason: "unknown" });
  assert.equal(decide({ schema: 1, pid: 9, state: "failing", okAt: 0 }).receiving, true);
  // A service that just woke (sleep, restart) has not had time to receive yet.
  assert.equal(decide({ schema: 1, pid: 5, state: "starting", okAt: 0 }, { ...heartbeat, awakeSince: now - 30_000 }).reason, "waking");
});

test("the pill reads rooms from the server while the service is alive but not receiving", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.match(main, /const INBOX_HEALTH_PATH = pillLiveness\.inboxHealthPath\(os\.homedir\(\)\);/);
  assert.match(main, /else if \(inboxVerdict && !inboxVerdict\.receiving\) setServiceHealth\("checking", inboxVerdict\.reason\);\n\s+\/\/ Back on its own[^\n]*\n\s+else if \(decision\.reason === "fresh" && serviceHealth\.daemon !== "ok"\) setServiceHealth\("ok"\);/,
    "ok only once the inbox is receiving; checking is what the renderer's serviceDegraded() reads from the server for");
  const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  assert.match(html, /return daemon === "checking" \|\| daemon === "repairing" \|\| daemon === "stopped";/);
});

function fakeWorld({ token = "tok", drift = "same", url = "" } = {}) {
  let t = 0;
  const intervals = [];
  const state = { clients: 0, receivers: [], polls: 0 };
  const health = createInboxHealth({ now: () => t, writeFile: () => {} });
  const worker = startReceiverWorker({
    now: () => t,
    health,
    makeClient: () => { state.clients += 1; return { token, url, accountDrift: () => ({ status: drift }) }; },
    setIntervalImpl: (fn) => { intervals.push(fn); return 1; },
    clearIntervalImpl: () => {},
    startReceiver: (options) => { const r = { options, stopped: false, stop() { this.stopped = true; } }; state.receivers.push(r); return r; },
    poll: async () => { state.polls += 1; return { inboxOk: true }; },
  });
  return { state, health, worker, tick: (ms) => { t += ms; for (const fn of intervals) fn(); } };
}

test("a signed-out or drifted service says so instead of retrying in silence", async () => {
  // url "" never equals secureRelayApiUrl(apiUrl()), so this client is not current.
  const world = fakeWorld();
  assert.equal(world.health.snapshot().state, "unbound");
  assert.match(world.health.snapshot().reason, /^account-/);
  const signedOut = fakeWorld({ token: "" });
  assert.deepEqual([signedOut.health.snapshot().state, signedOut.health.snapshot().reason], ["unbound", "signed-out"]);
  assert.equal(signedOut.state.receivers.length, 0);
});

test("a bound receiver that receives nothing for three minutes is rebuilt, and receiving resets the clock", async () => {
  const world = fakeWorld({ url: secureRelayApiUrl(apiUrl()) });
  assert.equal(world.state.receivers.length, 1);
  const refresh = (n) => world.state.receivers[n].options.refresh({ isCurrent: () => true });
  await refresh(0);
  assert.equal(world.health.snapshot().state, "receiving");
  world.tick(2 * 60_000);
  assert.equal(world.state.receivers.length, 1, "inside the window nothing is touched");
  await refresh(0);
  world.tick(2 * 60_000);
  assert.equal(world.state.receivers.length, 1, "a refresh that lands resets the clock");
  world.tick(2 * 60_000);
  assert.equal(world.state.receivers.length, 2, "silence past three minutes rebuilds the receiver");
  assert.equal(world.state.receivers[0].stopped, true);
  world.tick(60_000);
  assert.equal(world.state.receivers.length, 2, "the rebuilt receiver gets its own full window");
});

test("a state read that fails for a moment keeps showing the last inbox, never an empty one", async () => {
  const vm = await import("node:vm");
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const start = main.indexOf("let lastDisplayedStore = null;");
  const source = main.slice(start, main.indexOf("function writeStateAtomic(store)"));
  let next = { text: JSON.stringify({ packets: { relay_1: { title: "hello" } } }) };
  const context = vm.createContext({
    STATE_PATH: "/state.json",
    fs: { readFileSync: () => { if (next.error) throw next.error; return next.text; } },
    readConfigFile: () => ({}),
    JSON,
  });
  vm.runInContext(`${source}\nthis.readStore = readStore;`, context);
  assert.deepEqual(Object.keys(context.readStore({ forDisplay: true }).packets), ["relay_1"]);
  next = { error: Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }) };
  assert.deepEqual(Object.keys(context.readStore({ forDisplay: true }).packets), ["relay_1"], "display keeps the last inbox");
  assert.deepEqual(JSON.parse(JSON.stringify(context.readStore())), {}, "a read-modify-write caller never writes a stale copy back");
  next = { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
  assert.deepEqual(JSON.parse(JSON.stringify(context.readStore({ forDisplay: true }))), {}, "a missing file is real emptiness");
});
