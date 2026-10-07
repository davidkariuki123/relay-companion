import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrokerStdioTransport } from "../src/mcp-broker-transport.js";
import { resolveAccountProductFeatures, retryAccountProductFeatures } from "../src/product-features.js";

const DEVELOPER = { id: "usr_dev", accountKind: "human", isDeveloper: true, developerAccount: true };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-feature-retry-"));
const saved = Object.fromEntries(["RELAY_CONFIG", "RELAY_CONFIG_DIR", "RELAY_HOME", "RELAY_ENV"].map((key) => [key, process.env[key]]));
process.env.RELAY_CONFIG = path.join(dir, "config.json");
process.env.RELAY_CONFIG_DIR = dir;
process.env.RELAY_HOME = dir;
process.env.RELAY_ENV = "dev";
fs.writeFileSync(process.env.RELAY_CONFIG, JSON.stringify({ apiUrl: "https://dev-api.sendrelays.com", token: "dev_test", user: DEVELOPER }));
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unheard profile check is unverified; any answer from the server is verified", async () => {
  const offline = await resolveAccountProductFeatures({
    client: { token: "dev_test", async me() { throw new Error("fetch failed"); } },
    config: { user: DEVELOPER },
    env: { RELAY_ENV: "dev" },
  });
  assert.equal(offline.verified, false);
  assert.equal(offline.features.topics, false, "an unheard check still never grants developer tools");

  const ordinary = await resolveAccountProductFeatures({
    client: { token: "dev_test", async me() { return { user: { ...DEVELOPER, isDeveloper: false, developerAccount: false } }; } },
    config: { user: DEVELOPER },
    env: { RELAY_ENV: "dev" },
  });
  assert.equal(ordinary.verified, true, "a heard 'not a developer' is the authority and is not retried");
  assert.equal(ordinary.features.topics, false);

  // The lookup's timeout timer is unref'd (it must never hold a CLI open), so a
  // check that never answers leaves nothing else alive in this test process.
  // Hold the loop open while the timeout runs; on the Linux release runner the
  // drained loop cancelled this test and every one after it.
  const keepAlive = setInterval(() => {}, 1_000);
  const slow = await resolveAccountProductFeatures({
    client: { token: "dev_test", me: () => new Promise(() => {}) },
    config: { user: DEVELOPER },
    env: { RELAY_ENV: "dev" },
    timeoutMs: 20,
  }).finally(() => clearInterval(keepAlive));
  assert.equal(slow.verified, false, "a timeout is unheard too");
});

test("the retrier backs off until the server answers, then reports once", async () => {
  const delays = [];
  const timers = [];
  const answers = [{ verified: false }, { verified: false }, { verified: true, features: { topics: true } }];
  const resolved = [];
  const retry = retryAccountProductFeatures({
    resolve: async () => answers.shift(),
    onResolved: (features) => resolved.push(features),
    delaysMs: [10, 20],
    setTimer: (run, ms) => { delays.push(ms); timers.push(run); return timers.length; },
    clearTimer: () => {},
  });
  while (timers.length) {
    await timers.shift()();
  }
  assert.deepEqual(delays, [10, 20, 20], "backs off to its last delay and stays there");
  assert.deepEqual(resolved, [{ topics: true }]);
  retry.stop();
});

test("a stopped retrier never reports", async () => {
  const timers = [];
  const resolved = [];
  const retry = retryAccountProductFeatures({
    resolve: async () => ({ verified: true, features: {} }),
    onResolved: (features) => resolved.push(features),
    setTimer: (run) => { timers.push(run); return 1; },
    clearTimer: () => {},
  });
  retry.stop();
  await timers.shift()();
  assert.deepEqual(resolved, []);
});

test("a session whose first profile check failed gains developer tools when the server answers, and tells the host", async (t) => {
  const { createRelayMcpSession } = await import("../src/mcp.js");
  let profileCalls = 0;
  const relay = {
    token: "dev_test",
    async me() {
      profileCalls += 1;
      if (profileCalls === 1) throw new Error("fetch failed");
      return { user: DEVELOPER };
    },
    accountDrift: () => ({ status: "same" }),
  };
  const requests = new PassThrough(), responses = new PassThrough();
  const session = await createRelayMcpSession({
    transport: new BrokerStdioTransport(requests, responses),
    clientFactory: () => relay,
    sessionDigestEnabled: false,
    profileRetryDelaysMs: [30],
  });
  const host = new Client({ name: "claude-code", version: "test" }, { capabilities: {} });
  let changed = 0;
  host.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1; });
  await host.connect(new BrokerStdioTransport(responses, requests));
  t.after(async () => { await host.close(); await session.close(); });

  const before = (await host.listTools()).tools.map((tool) => tool.name);
  assert.ok(before.includes("relay_send"), "ordinary tools are there from the start");
  assert.ok(!before.includes("relay_topic_post"), "developer tools wait for a heard profile");

  for (let i = 0; i < 100 && !changed; i++) await delay(10);
  assert.equal(changed, 1, "the host is told its tool list changed");
  const after = (await host.listTools()).tools.map((tool) => tool.name);
  assert.ok(after.includes("relay_topic_post"), "the session now offers Topics");
  assert.ok(after.includes("relay_send"));
  assert.equal(session.features.topics, true);
});

test("a session whose first check was heard does not keep asking", async (t) => {
  const { createRelayMcpSession } = await import("../src/mcp.js");
  let profileCalls = 0;
  const relay = {
    token: "dev_test",
    async me() { profileCalls += 1; return { user: DEVELOPER }; },
    accountDrift: () => ({ status: "same" }),
  };
  const requests = new PassThrough(), responses = new PassThrough();
  const session = await createRelayMcpSession({
    transport: new BrokerStdioTransport(requests, responses),
    clientFactory: () => relay,
    sessionDigestEnabled: false,
    profileRetryDelaysMs: [10],
  });
  t.after(async () => { await session.close(); });
  await delay(60);
  assert.equal(profileCalls, 1);
  assert.equal(session.features.topics, true);
});
