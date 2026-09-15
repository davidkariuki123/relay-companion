import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { collectFleetTelemetryInBackground, createFleetTelemetryCache } from "../src/fleet-telemetry-background.js";
import { fleetTelemetryContext, resetCompanionFleetTelemetryCache } from "../src/fleet-telemetry.js";
import { RelayClient, closeRelayConnections } from "../src/client.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  let time = 1000;
  let revision = "one";
  const runs = [];
  const cache = createFleetTelemetryCache({
    now: () => time,
    context: scope => ({ key: `${scope}:${revision}` }),
    collect: (context, signal) => new Promise((resolve, reject) => runs.push({ context, signal, resolve, reject })),
    ...options,
  });
  t.after(() => { cache.reset(); for (const run of runs) run.reject(new Error("test cleanup")); });
  return { cache, runs, time: value => { time = value; }, revision: value => { revision = value; } };
}

test("pending scans never block requests; fresh results expire from scan start", async t => {
  const h = harness(t);
  assert.equal(h.cache.header(), "");
  await flush();
  for (let i = 0; i < 100; i++) assert.equal(h.cache.header(), "");
  assert.equal(h.runs.length, 1);
  h.time(20_000);
  h.runs[0].resolve("fresh");
  await flush();
  assert.equal(h.cache.header(), "fresh");
  h.time(31_000);
  assert.equal(h.cache.header(), "", "sample expiry is not extended by late completion");
  await flush();
  assert.equal(h.runs.length, 2);
});

test("failed scans back off and never poison normal requests", async t => {
  const h = harness(t);
  h.cache.header();
  await flush();
  h.runs[0].reject(new Error("scan failed"));
  await flush();
  for (let i = 0; i < 50; i++) assert.equal(h.cache.header(), "");
  await flush();
  assert.equal(h.runs.length, 1);
  h.time(31_000);
  h.cache.header();
  await flush();
  assert.equal(h.runs.length, 2);
});

test("timeout aborts work, waits for cleanup, and rejects even a late success", async t => {
  const h = harness(t, { timeoutMs: 20 });
  h.cache.header();
  await delay(40);
  assert.equal(h.runs[0].signal.aborted, true);
  h.time(90_000);
  assert.equal(h.cache.header(), "");
  await flush();
  assert.equal(h.runs.length, 1, "do not overlap with work still cleaning up");
  h.runs[0].resolve("late");
  await flush();
  assert.equal(h.cache.header(), "");
  assert.equal(h.runs.length, 1, "failed cleanup completion starts cooldown");
});

test("account and runtime changes invalidate pending and cached results", async t => {
  const h = harness(t);
  h.cache.header("account-a");
  await flush();
  assert.equal(h.cache.header("account-b"), "");
  assert.equal(h.runs[0].signal.aborted, true);
  h.runs[0].resolve("wrong-account");
  await flush();
  h.cache.header("account-b");
  await flush();
  h.revision("new-runtime");
  h.runs[1].resolve("old-runtime");
  await flush();
  assert.equal(h.cache.header("account-b"), "");
  await flush();
  h.runs[2].resolve("current");
  await flush();
  assert.equal(h.cache.header("account-b"), "current");
  h.revision("third-runtime");
  assert.equal(h.cache.header("account-b"), "");
});

test("clock rollback and synchronous setup failure never return stale health", async t => {
  const h = harness(t);
  h.cache.header();
  await flush();
  h.runs[0].resolve("cached");
  await flush();
  h.time(999);
  assert.equal(h.cache.header(), "");
  const bad = createFleetTelemetryCache({ context: () => ({ key: "x" }), collect: () => { throw Error("setup"); } });
  t.after(() => bad.reset());
  assert.equal(bad.header(), "");
  await flush();
  assert.equal(bad.header(), "");
});

function tempContext(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-telemetry-async-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { homeDir: root, configFile: path.join(root, "config.json"), updateStatePath: path.join(root, "update-state.json") };
}
const fixtureQuery = script => ({ command: process.execPath, args: ["-e", script] });

test("a slow real subprocess leaves timers responsive and collection preserves report shape", async t => {
  const context = tempContext(t);
  fs.writeFileSync(context.configFile, JSON.stringify({ updateChannel: "staging" }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  t.after(() => clearInterval(ticker));
  const result = await collectFleetTelemetryInBackground(context, controller.signal, {
    query: fixtureQuery("setTimeout(() => process.stdout.write(''), 300)"),
  });
  assert.ok(ticks >= 5, `timer continued during process scan (${ticks} ticks)`);
  const report = JSON.parse(Buffer.from(result, "base64url"));
  assert.equal(report.schema, 1);
  assert.equal(report.runtimeState, "legacy");
  assert.equal(report.installation.os, process.platform);
  assert.equal(JSON.stringify(report).includes(context.homeDir), false);
});

test("cancelling a hung scan reaps its subprocess before settling", async t => {
  const context = tempContext(t);
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const pidFile = path.join(context.homeDir, "pid");
  const controller = new AbortController();
  const result = collectFleetTelemetryInBackground(context, controller.signal, {
    query: fixtureQuery(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`),
  });
  const rejected = assert.rejects(result);
  t.after(() => controller.abort());
  for (let attempt = 0; !fs.existsSync(pidFile) && attempt < 200; attempt++) await delay(20);
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("worker crash and hung worker are contained and cleaned up", async t => {
  const context = tempContext(t);
  // Keep this test alive while production's unreferenced workers run.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const controller = new AbortController();
  await assert.rejects(collectFleetTelemetryInBackground(context, controller.signal, {
    query: fixtureQuery(""), workerUrl: new URL('data:text/javascript,throw new Error("fixture crash")'),
  }), /fixture crash/);
  const hung = new AbortController();
  const result = collectFleetTelemetryInBackground(context, hung.signal, {
    query: fixtureQuery(""), workerUrl: new URL('data:text/javascript,setInterval(()=>{},1000)'),
  });
  const rejected = assert.rejects(result);
  await delay(500);
  hung.abort();
  await rejected;
});

test("a short-lived caller exits promptly and kills its unfinished scan", async t => {
  const context = tempContext(t);
  const pidFile = path.join(context.homeDir, "child.pid");
  const moduleUrl = new URL("../src/fleet-telemetry-background.js", import.meta.url).href;
  const query = fixtureQuery(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`);
  const script = `import fs from 'node:fs';
    import { collectFleetTelemetryInBackground } from ${JSON.stringify(moduleUrl)};
    void collectFleetTelemetryInBackground(${JSON.stringify(context)}, new AbortController().signal,
      { query: ${JSON.stringify(query)} }).catch(()=>{});
    const ready = setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)}))clearInterval(ready)},20);`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000, windowsHide: true });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let attempt = 0; alive && attempt < 50; attempt++) {
    try { process.kill(pid, 0); await delay(20); } catch { alive = false; }
  }
  assert.equal(alive, false, "exiting caller must not leave its query process behind");
});

test("config generation changes invalidate context without credential reads", t => {
  const context = tempContext(t);
  const before = process.env.RELAY_CONFIG;
  process.env.RELAY_CONFIG = context.configFile;
  t.after(() => { if (before === undefined) delete process.env.RELAY_CONFIG; else process.env.RELAY_CONFIG = before; });
  const first = fleetTelemetryContext("account-a");
  fs.writeFileSync(context.configFile, '{"user":{"id":"new-account"}}');
  assert.notEqual(fleetTelemetryContext("account-a").key, first.key);
  assert.notEqual(fleetTelemetryContext("account-b").key, fleetTelemetryContext("account-a").key);
});

test("device requests send immediately without telemetry and preserve auth and payload", async t => {
  const context = tempContext(t);
  const previousConfig = process.env.RELAY_CONFIG;
  process.env.RELAY_CONFIG = context.configFile;
  resetCompanionFleetTelemetryCache();
  t.after(() => {
    resetCompanionFleetTelemetryCache();
    if (previousConfig === undefined) delete process.env.RELAY_CONFIG;
    else process.env.RELAY_CONFIG = previousConfig;
  });
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await closeRelayConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, token: "dev_test_only" });
  const reply = await client.me();
  assert.equal(reply.ok, true);
  assert.equal(received[0].headers.authorization, "Bearer dev_test_only");
  assert.equal(received[0].headers["x-relay-companion-telemetry"], undefined, "cold telemetry is optional and not awaited");
  assert.equal(received[0].body, "");
});
