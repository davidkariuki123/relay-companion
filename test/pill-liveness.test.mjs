import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const liveness = require("../src/pill-liveness.cjs");
const { write } = require("../bootstrap/recovery-launcher.cjs");

// Hermetic like client-transport.test.mjs: never discover the developer's real device.
const previousRelayConfig = process.env.RELAY_CONFIG;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-liveness-"));
process.env.RELAY_CONFIG = path.join(configDir, "config.json");
after(() => {
  if (previousRelayConfig === undefined) delete process.env.RELAY_CONFIG;
  else process.env.RELAY_CONFIG = previousRelayConfig;
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("the supervisor restarts a pill that is alive but silent, and nothing else", () => {
  const now = 10 * 60_000;
  const stale = { at: now - liveness.PILL_STALE_MS - 1, pid: 7 };
  assert.deepEqual(liveness.pillSupervisorDecision({ heartbeat: null, now }), { action: "none", reason: "no-heartbeat" });
  assert.equal(liveness.pillSupervisorDecision({ heartbeat: { at: now - 1000 }, now, alive: true }).reason, "fresh");
  assert.equal(liveness.pillSupervisorDecision({ heartbeat: { at: now + 5000 }, now, alive: true }).reason, "clock-ahead");
  assert.equal(liveness.pillSupervisorDecision({ heartbeat: stale, now, alive: false }).reason, "pill-not-running");
  assert.equal(liveness.pillSupervisorDecision({ heartbeat: stale, now, alive: true, lastRestartAt: now - 1000 }).reason, "cooldown");
  const restart = liveness.pillSupervisorDecision({ heartbeat: stale, now, alive: true, lastRestartAt: now - liveness.PILL_RESTART_COOLDOWN_MS });
  assert.equal(restart.action, "restart");
  assert.equal(restart.reason, "hung");
  assert.ok(restart.ageMs > liveness.PILL_STALE_MS);
});

test("the pill relaunches only when its own transport fails while the daemon keeps reaching Relay", () => {
  const now = 20 * 60_000;
  const failingSince = now - liveness.TRANSPORT_WEDGE_MS - 1;
  const wedged = { failingSince, lastSuccessAt: failingSince - 60_000, failureStreak: 40 };
  const daemonOk = { at: now - 5000, apiOkAt: now - 10_000 };
  const verdict = (transport, daemon) => liveness.shouldRelaunchForWedgedTransport({ transport, daemon, now });
  assert.equal(verdict(null, daemonOk).reason, "transport-ok");
  assert.equal(verdict({ failingSince: 0, lastSuccessAt: now }, daemonOk).reason, "transport-ok");
  assert.equal(verdict({ ...wedged, failingSince: now - 1000 }, daemonOk).reason, "failing-briefly");
  assert.equal(verdict(wedged, null).reason, "daemon-unverified");
  assert.equal(verdict(wedged, { at: now - 90_000, apiOkAt: now - 10_000 }).reason, "daemon-unverified");
  // The daemon's last success predates the pill's failures: Relay may simply be down.
  assert.equal(verdict(wedged, { at: now - 5000, apiOkAt: failingSince - 1 }).reason, "api-down-for-everyone");
  assert.equal(verdict(wedged, { at: now - 5000 }).reason, "api-down-for-everyone");
  assert.equal(verdict(wedged, daemonOk).relaunch, true);
});

test("the daemon-side supervisor reads the heartbeat file, restarts through the platform path once, and honours the cooldown", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pill-supervisor-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const { startPillSupervisor } = await import("../src/pill-supervisor.js");
  const logs = [];
  const restarts = [];
  const timers = [];
  let clock = 60 * 60_000;
  const { tick } = startPillSupervisor({
    homeDir,
    now: () => clock,
    log: (m) => logs.push(m),
    setIntervalImpl: (fn) => { timers.push(fn); return { unref() {} }; },
    restart: async () => { restarts.push(clock); return { pill: "restarted" }; },
    isAlive: (pid) => pid === 4242,
  });
  assert.equal(timers.length, 1);
  assert.equal((await tick()).reason, "no-heartbeat");
  write(liveness.pillHeartbeatPath(homeDir), { schema: 1, pid: 4242, at: clock - liveness.PILL_STALE_MS - 5000, worstStallMs: 134422 });
  assert.equal((await tick()).action, "restart");
  assert.deepEqual(restarts, [clock]);
  assert.match(logs[0], /has not reported for \d+s while still running \(worst stall 134422ms\)/);
  assert.match(logs[1], /restart restarted/);
  clock += 1000;
  assert.equal((await tick()).reason, "cooldown");
  write(liveness.pillHeartbeatPath(homeDir), { schema: 1, pid: 9999, at: clock - liveness.PILL_STALE_MS - 5000 });
  clock += liveness.PILL_RESTART_COOLDOWN_MS;
  assert.equal((await tick()).reason, "pill-not-running");
  assert.equal(restarts.length, 1);
});

test("the client records transport failures and successes so the pill and daemon can compare notes", async () => {
  const { RelayClient, relayTransportHealth, closeRelayConnections } = await import("../src/client.js");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const before = Date.now();
  await assert.rejects(new RelayClient({ url: `http://127.0.0.1:${closedPort}`, token: "t" }).me());
  const failing = relayTransportHealth();
  assert.ok(failing.failingSince >= before, "failure start recorded");
  assert.ok(failing.failureStreak >= 1);
  assert.equal(failing.lastSuccessAt, 0);
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // An HTTP error is still an answer from the API: the transport is healthy.
    await assert.rejects(new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, token: "t" }).me(), /unauthorized/i);
    const healthy = relayTransportHealth();
    assert.ok(healthy.lastSuccessAt >= failing.failingSince);
    assert.equal(healthy.failingSince, 0);
    assert.equal(healthy.failureStreak, 0);
  } finally {
    await closeRelayConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
