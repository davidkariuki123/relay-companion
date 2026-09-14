import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { runReceiverLoop } from "../src/task-daemon.js";
import { createDaemonComponents } from "../src/daemon-components.js";
import { createDaemonProgress, recordDaemonCrash, repeatedStartupCrash } from "../bootstrap/daemon-progress.cjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function healthFixture() {
  let clock = 1000;
  const health = createDaemonProgress({ packageRoot: "/test", version: "1.0.0", now: () => clock, persist() {} });
  return { health, advance: ms => { clock += ms; } };
}
test("real receiver loop survives optional synchronous and asynchronous failures across iterations", async () => {
  const { health } = healthFixture();
  const client = { token: "test", url: "https://example.invalid", accountDrift: () => ({ status: "same" }) };
  let cycles = 0, deliveries = 0, sessions = 0;
  await runReceiverLoop({ client, me: { user: { id: "test" } }, health,
    getFeatures: () => ({ requests: true, topics: true, todo: true }),
    followAccount: async () => null, makeClient: () => client,
    sessionTick: () => { sessions++; throw new ReferenceError("removedIntegration is not defined"); },
    stewardTick: async () => { throw Error("provider unavailable"); },
    topicsPoll: async () => { throw Error("topics unavailable"); },
    attachments: async () => {}, completionWakes: async () => {},
    deliveryTick: async () => { deliveries++; return { ordinaryOnly: true, ordinaryRelays: [], inboxOk: true }; },
    stop: () => cycles === 4, sleep: async () => { cycles++; await flush(); },
  });
  assert.equal(deliveries, 4); assert.equal(sessions, 4);
  assert.equal(health.snapshot().sequence, 4); assert.equal(health.ready(), true);
  assert.equal(health.snapshot().components["agent-sessions"], "failed");
  assert.equal(health.snapshot().components.todo, "failed");
});

test("a stuck optional component never overlaps and reports degraded health, then recovers", async () => {
  const { health, advance } = healthFixture();
  const runner = createDaemonComponents({ health, now: () => health.snapshot().at, stalledMs: 10 });
  let finish, calls = 0;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = runner.run("agent-sessions", operation);
  await flush(); advance(20); health.advance();
  assert.equal(runner.run("agent-sessions", operation), pending);
  assert.equal(calls, 1); assert.equal(health.snapshot().components["agent-sessions"], "stalled");
  finish(); await pending;
  assert.equal(health.snapshot().components["agent-sessions"], "ok");
});

test("hung task and agent operations cannot stop the real receiver scheduler or duplicate work", async () => {
  const { health } = healthFixture();
  const client = { token: "test", url: "https://example.invalid", accountDrift: () => ({ status: "same" }) };
  let cycles = 0, tasks = 0, sessions = 0;
  await runReceiverLoop({ client, me: { user: { id: "test" } }, health,
    getFeatures: () => ({ topics: true }), followAccount: async () => null, makeClient: () => client,
    sessionTick: () => { sessions++; return new Promise(() => {}); },
    deliveryTick: () => { tasks++; return new Promise(() => {}); },
    topicsPoll: async () => {}, attachments: async () => {}, completionWakes: async () => {},
    stop: () => cycles === 4, sleep: async () => { cycles++; await flush(); },
  });
  assert.equal(health.snapshot().sequence, 4); assert.equal(tasks, 1); assert.equal(sessions, 1);
});

test("account switches close the old connection before rebinding and keep the new user on later ticks", async () => {
  const { health } = healthFixture();
  let cycles = 0, switching = false;
  const client = { token: "test", url: "https://example.invalid", accountDrift: () => ({ status: switching ? "changed" : "same" }) };
  const events = [], users = [];
  await runReceiverLoop({ client, me: { user: { id: "old" } }, health,
    getFeatures: () => ({ topics: true, todo: true }), makeClient: () => ({ ...client }),
    closeLocalAgentConnection: async () => { events.push("closed"); },
    followAccount: async () => { if (!switching) return null; assert.equal(events.at(-1), "closed"); switching = false; return { user: { id: "new" } }; },
    bindLocalAgentConnection: async () => { events.push("bound"); },
    sessionTick: async () => {}, deliveryTick: async () => ({ ordinaryOnly: true, ordinaryRelays: [], inboxOk: true }),
    stewardTick: async ({ user }) => { users.push(user.id); },
    topicsPoll: async () => {}, attachments: async () => {}, completionWakes: async () => {},
    stop: () => cycles === 3, sleep: async () => { cycles++; if (cycles === 1) switching = true; await flush(); },
  });
  assert.deepEqual(events, ["closed", "bound"]); assert.deepEqual(users, ["old", "new", "new"]);
});

test("local readiness needs work progress; offline and sign-out are healthy waits, stale progress is not", () => {
  const { health, advance } = healthFixture();
  assert.equal(health.ready(), false);
  health.advance("offline"); assert.equal(health.ready(), true);
  advance(61_000); assert.equal(health.ready(), false);
  health.advance("signed-out"); assert.equal(health.ready(), true);
});

test("repeated startup crash fingerprint is exact-runtime scoped and counts distinct processes", t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-crash-test-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const target = { homeDir, packageRoot: "/release", version: "1.0.0", now: () => 1000 };
  const error = new ReferenceError("removedRuntime is not defined");
  recordDaemonCrash(error, { ...target, pid: 10 });
  recordDaemonCrash(error, { ...target, pid: 10 });
  assert.equal(repeatedStartupCrash(target, { homeDir, now: 1000 }), null);
  recordDaemonCrash(error, { ...target, pid: 11 });
  assert.equal(repeatedStartupCrash(target, { homeDir, now: 1000 }).count, 2);
  assert.equal(repeatedStartupCrash({ ...target, packageRoot: "/different" }, { homeDir, now: 1000 }), null);
  assert.equal(repeatedStartupCrash(target, { homeDir, now: 31 * 60_000 }), null);
  assert.equal(fs.readFileSync(path.join(homeDir, ".relay", "recovery", "daemon-crash.json"), "utf8").includes("removedRuntime"), false);
});

test("release lint rejects an undefined runtime hidden inside an uncalled function", async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const eslint = new ESLint({ cwd });
  const [result] = await eslint.lintText("export function daemonLoop() { void removedRuntime.tick(); }", { filePath: "src/regression.js" });
  assert.equal(result.errorCount, 1); assert.equal(result.messages[0].ruleId, "no-undef");
});
